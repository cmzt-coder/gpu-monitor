// 告警判定引擎。
//
// 每采集一帧评估一次：条件在窗口内持续满足才算触发（对应规则里的 for），
// 触发后按 cooldown 抑制重复通知，恢复正常时补一条"已恢复"。
//
// 判定数据有两个来源：
//   for 不超过内存窗口（默认 5 分钟）→ 直接用内存里的采样点，零成本；
//   for 超过内存窗口 → 查历史库（可用时），按缓存周期刷新，一条 SQL 覆盖所有长周期规则。
// 没有历史库时，长周期规则的 for 会被夹到窗口长度，并在启动日志里提示。
import {
  METRICS, compare, findThresholdConflicts, normalizeRules, parseDuration,
  readGpuMetric, readHostMetric, readServiceMetric,
} from './rules.js';

function formatValue(value, rule) {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (value == null) return '--';
  // 显存类指标按 GiB 显示更直观（10240MiB 不如 10.00 GiB 好读）
  if (rule.unit === 'MiB') {
    return value >= 1024 ? `${(value / 1024).toFixed(2)} GiB` : `${Math.round(value)} MiB`;
  }
  return `${Math.round(value * 10) / 10}${rule.unit || ''}`;
}

function formatMinutes(ms) {
  if (!(ms > 0)) return '单个采样点';
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒`;
  const minutes = ms / 60000;
  return minutes >= 10 ? `${Math.round(minutes)} 分钟` : `${Math.round(minutes * 10) / 10} 分钟`;
}

export function createAlertEngine({
  config = {},
  getSamples,
  // 长周期判定的数据来源：{ from, to } → 采样点数组（与 /api/history 的 samples 结构一致）。
  // 不传或返回 null 时会退回"只用内存窗口"的老行为。
  history = null,
  notifier = null,
  now = Date.now,
  logger = console,
} = {}) {
  const { rules, problems } = normalizeRules(config);
  // 阈值顺序反了不算"规则有问题"（照常判定），但必须让人知道
  const warnings = findThresholdConflicts(rules);
  const cooldownMs = parseDuration(config.cooldown, 600000);
  const windowMs = parseDuration(config.window, 0);
  const intervalMs = Number(config.intervalMs) > 0 ? Number(config.intervalMs) : 1000;
  // 历史库查询的缓存周期：长周期规则没必要每秒都去查一次库
  const historyCacheMs = Math.max(1000, parseDuration(config.historyCache, 30000));
  const active = new Map();
  // 最近通知记录：即使告警已经恢复也留一段时间，
  // 否则"告警→恢复→再告警"会绕过冷却反复发信（抖动时最明显）
  const recentNotifiedAt = new Map();
  let lastCheckAt = null;
  let lastError = null;
  let notifiedCount = 0;
  const historyState = {
    cached: null, cachedAt: 0, cachedFrom: 0, queries: 0, lastError: null, step: 0, truncated: false,
  };

  // 需要多长的历史：取所有规则里最宽的那个 for，一次取够给所有规则共用
  const widestFor = rules.reduce((max, rule) => Math.max(max, rule.forMs), 0);
  const longRules = rules.filter((rule) => windowMs > 0 && rule.forMs > windowMs);
  // 长周期判定到底有没有历史库可用：页面要据此区分"规则按你写的时长在跑"和"被夹到窗口长度了"
  const historyEnabled = Boolean(history) && widestFor > 0;

  /**
   * 规则实际生效的判定时长。
   * 没有历史库时，for 超过内存窗口的部分等不到数据，实际只能按窗口长度判定——
   * 这个差异必须让页面看得见，否则用户会以为规则按自己写的时长在跑。
   */
  function effectiveForMs(rule) {
    if (!(windowMs > 0) || rule.forMs <= windowMs) return rule.forMs;
    return historyEnabled ? rule.forMs : windowMs;
  }

  for (const problem of problems) {
    logger.warn?.(`[gpu-monitor] 告警规则被跳过：${problem}`);
  }
  for (const item of warnings) {
    logger.warn?.(`[gpu-monitor] 告警阈值可疑：${item.message}`);
  }
  for (const rule of rules) {
    if (windowMs > 0 && rule.forMs > windowMs && !history) {
      logger.warn?.(`[gpu-monitor] 告警规则 ${rule.id} 的 for 超过采样窗口，且没有历史库可用，已按窗口长度判定（可调大 --window）`);
    }
  }

  /**
   * 取长周期判定需要的历史采样点。
   * 按"最宽的那条规则"一次取够，缓存 historyCacheMs，期间所有规则共用这一份数据；
   * 查询失败时沿用上一次的缓存（宁可判定用旧数据，也不要让采集循环被打断）。
   */
  function historyWindowSamples() {
    if (!history || widestFor <= 0) return null;
    const currentTime = now();
    const from = currentTime - widestFor;
    if (historyState.cached && currentTime - historyState.cachedAt < historyCacheMs && historyState.cachedFrom <= from) {
      return historyState.cached;
    }
    try {
      const result = history({ from, to: currentTime });
      const samples = result?.samples ?? result ?? [];
      historyState.cached = samples;
      historyState.cachedAt = currentTime;
      historyState.cachedFrom = from;
      // step > 0 说明这段区间在库里点数太多，查询层做了分桶平均；
      // 分桶会平滑掉短于桶宽的尖峰，页面上会提示这一点
      historyState.step = result?.step ?? 0;
      historyState.truncated = Boolean(result?.truncated);
      historyState.queries += 1;
      historyState.lastError = null;
      return historyState.cached;
    } catch (error) {
      historyState.lastError = error?.message || String(error);
      logger.warn?.(`[gpu-monitor] 长周期告警取历史数据失败：${historyState.lastError}`);
      return historyState.cached;
    }
  }

  /**
   * 判定用的采样点：把历史库与内存窗口合并。
   * 内存里的点是最新的（可能还没落库），历史里的点字段更全，同一个时间戳以历史版本为准；
   * 没有历史库时就是纯内存窗口，行为与之前一致。
   */
  function mergedSamples() {
    const memory = getSamples?.() || [];
    if (!history || widestFor <= 0) return memory;
    const historic = historyWindowSamples();
    if (!historic || historic.length === 0) return memory;
    const map = new Map();
    for (const sample of memory) map.set(sample.t, sample);
    for (const sample of historic) map.set(sample.t, sample);
    return [...map.values()].sort((a, b) => a.t - b.t);
  }

  /** 列出这条规则要评估的"目标"：每张卡、整机、或服务本身 */
  function enumerateTargets(rule, samples, state) {
    if (rule.scope === 'collector') {
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
    // 服务维度：按"占卡的服务"（容器 / systemd 单元 / 用户会话）分别判定
    if (rule.scope === 'service') {
      const filter = rule.service ? rule.service.toLowerCase() : null;
      const names = new Set();
      for (const sample of samples) {
        for (const entry of sample.services || []) {
          if (!entry?.service) continue;
          if (filter && !String(entry.service).toLowerCase().includes(filter)) continue;
          names.add(entry.service);
        }
      }
      const targets = [];
      for (const name of names) {
        // 服务中途消失（容器停了）时按 0 处理，这样"占用过高"的告警会自动恢复，
        // 而不是停在上一次的值上一直响
        const values = samples
          .map((sample) => {
            const value = readServiceMetric(sample, name, rule.metric);
            return value === undefined ? 0 : value;
          })
          .filter((value) => value !== null);
        if (values.length === 0) continue;
        targets.push({
          key: name,
          label: name,
          values,
          current: values[values.length - 1],
          firstTs: samples[0]?.t ?? now(),
        });
      }
      return targets;
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

  /**
   * 这条规则至少要看到几个采样点才算"持续满足"。
   * for 比采集间隔还短时（比如 for: 1s + 每秒采集一次），窗口里往往只有一个点，
   * 这时再强制"至少两个点"会让规则时灵时不灵。
   */
  function requiredSamplesFor(rule) {
    if (!(rule.forMs > 0)) return 1;
    const pointsInWindow = Math.floor(rule.forMs / intervalMs);
    return Math.max(1, Math.min(rule.minSamples, pointsInWindow));
  }

  function describe(entry) {
    const { rule, target } = entry;
    const value = formatValue(entry.value, rule);
    const threshold = rule.value !== undefined
      ? (rule.value ? '是' : '否')
      : formatValue(rule.threshold, rule);
    const coverage = entry.coverageShort
      ? `　·　仅覆盖 ${formatMinutes(entry.coverageMs)}，不足规则要求的 ${formatMinutes(rule.forMs)}`
      : '';
    return `${target.label} ${rule.label} = ${value}（阈值 ${rule.op} ${threshold}）${coverage}`;
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
    const samples = mergedSamples();
    const firingNow = new Map();

    for (const rule of rules) {
      // 需要看多久：有 for 就只看最近 for 这一段；
      // for=0 表示"当下满足就报"，那就只取最新一个点——否则会退化成"整个内存窗口都要满足"
      const source = rule.forMs > 0
        ? samples.filter((sample) => sample.t >= evaluatedAt - rule.forMs)
        : samples.slice(-1);
      const requiredSamples = requiredSamplesFor(rule);
      const spanMs = source.length > 1 ? source[source.length - 1].t - source[0].t : 0;
      // for 不能超过窗口能覆盖的时长，否则永远等不到
      const effectiveFor = Math.min(rule.forMs, spanMs);
      for (const target of enumerateTargets(rule, source, state)) {
        const id = `${rule.id}@${target.key}`;
        if (target.values.length < requiredSamples) continue;
        const satisfied = target.values.every((value) => compare(value, rule));
        if (!satisfied) continue;
        if (effectiveFor > 0 && spanMs < effectiveFor) continue;

        const previous = active.get(id);
        const lastNotifiedBefore = Math.max(previous?.lastNotifiedAt ?? 0, recentNotifiedAt.get(id) ?? 0);
        const entry = {
          rule,
          target,
          value: target.current,
          since: previous?.since ?? target.firstTs,
          lastNotifiedAt: lastNotifiedBefore,
          // 本轮告警到底发出去没有：只有发过"告警"才补"恢复"，
          // 否则抖动时会出现"没有告警却收到恢复"或"恢复重复发"的怪现象
          // （条目每次评估都会重建，所以这个标记要从上一轮继承）
          notified: previous?.notified ?? false,
          coverageMs: spanMs,
          // 数据不足以覆盖规则要求的时长时如实标出来：告警照发，但文案要说清"只覆盖了多久"
          coverageShort: rule.forMs > 0 && spanMs < rule.forMs,
        };
        // 冷却期内（含"刚恢复又马上触发"的情况）只更新状态，不重复通知
        if (evaluatedAt - lastNotifiedBefore >= cooldownMs) {
          entry.lastNotifiedAt = evaluatedAt;
          entry.notified = true;
          recentNotifiedAt.set(id, evaluatedAt);
          dispatch(entry, 'firing');
        }
        firingNow.set(id, entry);
      }
    }

    const resolvedEntries = [];
    for (const [id, entry] of active) {
      if (!firingNow.has(id)) {
        resolvedEntries.push(entry);
        if (entry.notified) dispatch({ ...entry, value: entry.value }, 'resolved');
        recentNotifiedAt.set(id, entry.lastNotifiedAt ?? 0);
      }
    }
    // 清掉早就过期的记录，避免长期运行下越攒越多
    for (const [id, notifiedAt] of recentNotifiedAt) {
      if (evaluatedAt - notifiedAt > cooldownMs * 2) recentNotifiedAt.delete(id);
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
        warnings,
        cooldownMs,
        windowMs,
        // 规则清单：零触发时页面也要能说清"在盯什么"。
        // 之前只给了 firing，没有触发就等于页面上看不到任何告警信息。
        rules: rules.map((rule) => {
          const entries = [...active.values()].filter((entry) => entry.rule.id === rule.id);
          const effective = effectiveForMs(rule);
          return {
            id: rule.id,
            label: rule.label,
            metric: rule.metric,
            metricLabel: METRICS[rule.metric]?.label ?? rule.metric,
            scope: rule.scope,
            level: rule.level,
            unit: rule.unit,
            op: rule.op,
            threshold: rule.threshold ?? rule.value ?? null,
            isBoolean: typeof (rule.threshold ?? rule.value) === 'boolean',
            service: rule.service,
            forMs: rule.forMs,
            effectiveForMs: effective,
            clamped: effective !== rule.forMs,
            firingCount: entries.length,
            targets: entries.map((entry) => entry.target.label),
          };
        }),
        // 长周期判定的数据来源与缓存状态：让页面/自检能看出"到底有没有在查库"
        history: {
          enabled: historyEnabled,
          widestForMs: widestFor,
          longRuleCount: longRules.length,
          cacheMs: historyCacheMs,
          queries: historyState.queries,
          cachedSamples: historyState.cached?.length ?? 0,
          cachedAt: historyState.cachedAt || null,
          step: historyState.step,
          truncated: historyState.truncated,
          lastError: historyState.lastError,
        },
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
          coverageMs: entry.coverageMs ?? null,
          coverageShort: Boolean(entry.coverageShort),
          detail: describe(entry),
        })),
      };
    },
  };
}
