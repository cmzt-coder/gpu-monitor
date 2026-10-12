// 告警判定引擎。
//
// 每采集一帧评估一次：条件在窗口内持续满足才算触发（对应规则里的 for），
// 触发后按 cooldown 抑制重复通知，恢复正常时补一条"已恢复"。
//
// 判定用的是内存里的采样窗口（默认 5 分钟）。规则的 for 超过窗口长度时会被夹到窗口长度，
// 并在启动时给出提示——要更长的持续判定就把 --window 调大。
import { compare, normalizeRules, parseDuration, readGpuMetric, readHostMetric } from './rules.js';

function formatValue(value, rule) {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value == null) return '--';
  return `${Math.round(value * 10) / 10}${rule.unit || ''}`;
}

export function createAlertEngine({
  config = {},
  getSamples,
  notifier = null,
  now = Date.now,
  logger = console,
} = {}) {
  const { rules, problems } = normalizeRules(config);
  const cooldownMs = parseDuration(config.cooldown, 600000);
  const windowMs = parseDuration(config.window, 0);
  const active = new Map();
  let lastCheckAt = null;
  let lastError = null;
  let notifiedCount = 0;

  for (const problem of problems) {
    logger.warn?.(`[gpu-monitor] 告警规则被跳过：${problem}`);
  }
  for (const rule of rules) {
    if (windowMs > 0 && rule.forMs > windowMs) {
      logger.warn?.(`[gpu-monitor] 告警规则 ${rule.id} 的 for 超过采样窗口，已按窗口长度判定`);
    }
  }

  function samplesInWindow(samples) {
    if (!windowMs) return samples;
    const cutoff = now() - windowMs;
    return samples.filter((sample) => sample.t >= cutoff);
  }

  /** 列出这条规则要评估的"目标"：每张卡、整机、或服务本身 */
  function enumerateTargets(rule, samples, state) {
    if (rule.scope === 'service') {
      const ok = state?.status === 'ok';
      if (rule.value === false) {
        // 采集失败：用"多久没有新样本"衡量持续时间。内存窗口里没有失败样本可数，
        // 所以这里用"距离上一个样本的静默时长"判断，并留 30 秒地板避免一次抖动就发信
        if (ok) return [];
        const lastTs = state?.lastSampleAt ?? samples[samples.length - 1]?.t ?? null;
        const brokenForMs = lastTs ? now() - lastTs : Number.POSITIVE_INFINITY;
        if (brokenForMs < Math.max(rule.forMs, 30000)) return [];
        return [{
          key: 'service',
          label: '采集服务',
          values: [false, false, false],
          current: false,
          firstTs: Number.isFinite(brokenForMs) ? now() - brokenForMs : now(),
        }];
      }
      if (!ok) return [];
      return [{
        key: 'service',
        label: '采集服务',
        values: [true, true, true],
        current: true,
        firstTs: samples[0]?.t ?? now(),
      }];
    }
    if (rule.scope === 'host') {
      const values = samples.map((sample) => readHostMetric(sample, rule.metric)).filter((v) => v !== undefined);
      if (values.length === 0) return [];
      return [{
        key: 'host',
        label: '宿主',
        values,
        current: values[values.length - 1],
        firstTs: samples[samples.length - Math.min(samples.length, values.length)]?.t ?? now(),
      }];
    }
    // GPU：按卡分别评估，告警里带上卡号
    const keys = new Map();
    for (const sample of samples) {
      for (const gpu of sample.gpus || []) keys.set(gpu.uuid || `index-${gpu.index}`, gpu);
    }
    if (keys.size === 0 && state?.gpus) {
      for (const gpu of state.gpus) keys.set(gpu.uuid || `index-${gpu.index}`, gpu);
    }
    const targets = [];
    for (const [key, gpu] of keys) {
      const values = samples
        .map((sample) => readGpuMetric(sample, key, rule.metric))
        .filter((value) => value !== undefined && value !== null);
      if (values.length === 0) continue;
      targets.push({
        key,
        label: `GPU ${gpu.index ?? '?'}（${gpu.name || '未知型号'}）`,
        values,
        current: values[values.length - 1],
        firstTs: samples[Math.max(0, samples.length - values.length)]?.t ?? now(),
      });
    }
    return targets;
  }

  function describe(entry) {
    const { rule, target } = entry;
    const value = formatValue(entry.value, rule);
    const threshold = rule.value !== undefined
      ? (rule.value ? '是' : '否')
      : `${rule.threshold}${rule.unit}`;
    return `${target.label} ${rule.label} = ${value}（阈值 ${rule.op} ${threshold}）`;
  }

  function describeRecovered(entry) {
    return `${entry.target.label} ${entry.rule.label} 已恢复正常（触发时 ${formatValue(entry.value, entry.rule)}）`;
  }

  function dispatch(entry, kind) {
    notifiedCount += 1;
    if (!notifier) return;
    const payload = {
      kind,
      level: entry.rule.level,
      ruleId: entry.rule.id,
      title: `${kind === 'firing' ? '告警' : '恢复'}：${entry.rule.label}`,
      detail: kind === 'firing' ? describe(entry) : describeRecovered(entry),
      since: entry.since,
      at: now(),
    };
    // 通知是"尽力而为"：发不出去只记一条错误，绝不影响采集与判定
    Promise.resolve()
      .then(() => notifier.send(payload))
      .catch((error) => {
        lastError = `${kind === 'firing' ? '告警' : '恢复'}通知发送失败：${error?.message || error}`;
        logger.warn?.(`[gpu-monitor] ${lastError}`);
      });
  }

  function evaluate(state) {
    if (rules.length === 0) return { firing: [], resolved: [] };
    const evaluatedAt = now();
    lastCheckAt = evaluatedAt;
    const samples = samplesInWindow(getSamples?.() || []);
    const spanMs = samples.length > 1 ? samples[samples.length - 1].t - samples[0].t : 0;
    const firingNow = new Map();

    for (const rule of rules) {
      // for 不能超过窗口能覆盖的时长，否则永远等不到
      const effectiveFor = Math.min(rule.forMs, spanMs);
      for (const target of enumerateTargets(rule, samples, state)) {
        const id = `${rule.id}@${target.key}`;
        if (target.values.length < rule.minSamples) continue;
        const satisfied = target.values.every((value) => compare(value, rule));
        if (!satisfied) continue;
        if (effectiveFor > 0 && spanMs < effectiveFor) continue;

        const previous = active.get(id);
        const entry = {
          rule,
          target,
          value: target.current,
          since: previous?.since ?? target.firstTs,
          lastNotifiedAt: previous?.lastNotifiedAt ?? 0,
        };
        const fresh = !previous;
        const cooled = previous && evaluatedAt - previous.lastNotifiedAt >= cooldownMs;
        if (fresh || cooled) {
          entry.lastNotifiedAt = evaluatedAt;
          dispatch(entry, 'firing');
        }
        firingNow.set(id, entry);
      }
    }

    const resolvedEntries = [];
    for (const [id, entry] of active) {
      if (!firingNow.has(id)) {
        resolvedEntries.push(entry);
        dispatch({ ...entry, value: entry.value }, 'resolved');
      }
    }

    active.clear();
    for (const [id, entry] of firingNow) active.set(id, entry);

    return { firing: [...firingNow.values()], resolved: resolvedEntries };
  }

  return {
    rules,
    problems,
    cooldownMs,
    evaluate,
    snapshot() {
      return {
        enabled: rules.length > 0,
        ruleCount: rules.length,
        problems,
        cooldownMs,
        windowMs,
        notifiedCount,
        lastCheckAt,
        lastError,
        firing: [...active.entries()].map(([id, entry]) => ({
          id,
          ruleId: entry.rule.id,
          level: entry.rule.level,
          label: entry.rule.label,
          target: entry.target.label,
          value: entry.value,
          since: entry.since,
          detail: describe(entry),
        })),
      };
    },
  };
}
