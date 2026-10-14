// 告警规则：支持哪些指标、怎么比较、配置文件怎么规范化。
// 规则的判定与通知在 engine.js，这里只做"能算什么"和"怎么算"。

/** 可用的指标。scope 决定这条规则作用在单张卡、整机还是服务本身 */
export const METRICS = {
  memUsedPct: { scope: 'gpu', label: '显存占用率', unit: '%' },
  memUsedMiB: { scope: 'gpu', label: '显存占用', unit: 'MiB' },
  utilGpuPct: { scope: 'gpu', label: 'GPU 利用率', unit: '%' },
  utilMemPct: { scope: 'gpu', label: '显存带宽占用', unit: '%' },
  tempC: { scope: 'gpu', label: '温度', unit: '°C' },
  powerW: { scope: 'gpu', label: '功耗', unit: 'W' },
  throttled: { scope: 'gpu', label: '节流', unit: '' },
  hostCpuPct: { scope: 'host', label: '宿主 CPU 使用率', unit: '%' },
  hostMemUsedPct: { scope: 'host', label: '宿主内存使用率', unit: '%' },
  hostSwapUsedPct: { scope: 'host', label: '交换分区使用率', unit: '%' },
  hostDiskUsedPct: { scope: 'host', label: '磁盘使用率', unit: '%' },
  // 服务维度：一张卡被多个服务共享时，只看"整卡用了多少"没有意义
  serviceMemMiB: { scope: 'service', label: '服务显存', unit: 'MiB' },
  serviceSharePct: { scope: 'service', label: '服务显存占比', unit: '%' },
  // 注意：这里的 "collector" 指的是监控服务自身，和上面按"占卡服务"聚合的 service 作用域不是一回事
  collectOk: { scope: 'collector', label: '采集状态', unit: '' },
};

const OPERATORS = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

const DURATION_PATTERN = /^(\d+)\s*(ms|s|m|h|d)?$/;
const DURATION_UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };

/** "90" / "30s" / "5m" / "2h" / "1d" → 毫秒；纯数字按秒算 */
export function parseDuration(value, fallbackMs = 0) {
  if (value == null) return fallbackMs;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = DURATION_PATTERN.exec(String(value).trim());
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  return amount * (DURATION_UNITS[match[2] || 's'] || 1000);
}

export function compare(value, rule) {
  const operator = OPERATORS[rule.op];
  if (!operator) return false;
  // 布尔型指标（throttled / collectOk）用 == / != 比较，不做大小判断
  if (typeof value === 'boolean' || typeof rule.value === 'boolean') {
    return operator(value, rule.value);
  }
  const threshold = rule.threshold ?? rule.value;
  if (typeof value !== 'number' || typeof threshold !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  return operator(value, threshold);
}

/**
 * 规范化规则：补默认值、校验指标与操作符。
 * 返回 { rules, problems }——有问题的规则被跳过并记录原因，而不是让整份配置失效。
 */
export function normalizeRules(config = {}) {
  const list = Array.isArray(config.rules) ? config.rules : [];
  const rules = [];
  const problems = [];

  list.forEach((raw, index) => {
    const id = raw.id || `rule-${index + 1}`;
    const metric = raw.metric;
    const spec = METRICS[metric];
    if (!spec) {
      problems.push(`${id}：未知指标 ${metric}`);
      return;
    }
    const op = raw.op || '>=';
    if (!OPERATORS[op]) {
      problems.push(`${id}：未知操作符 ${op}`);
      return;
    }
    const isBoolean = typeof raw.value === 'boolean';
    if (!isBoolean && typeof raw.threshold !== 'number' && typeof raw.value !== 'number') {
      problems.push(`${id}：缺少 threshold`);
      return;
    }
    if (raw.enabled === false) return;

    rules.push({
      id,
      metric,
      scope: spec.scope,
      label: raw.label || spec.label,
      unit: spec.unit,
      op,
      value: isBoolean ? raw.value : undefined,
      threshold: raw.threshold ?? (typeof raw.value === 'number' ? raw.value : undefined),
      // for：条件需要持续多久才算触发
      forMs: parseDuration(raw.for, 0),
      level: raw.level === 'critical' ? 'critical' : 'warning',
      // 判定"持续满足"至少要看两个点；只看一个点的话"持续"无从谈起
      minSamples: Math.max(1, Number(raw.minSamples) || 2),
      // 可选：把规则限定到某个服务（子串匹配，"vllm-embed" 能匹配到"容器 vllm-embed"）
      service: raw.service ? String(raw.service) : null,
    });
  });

  return { rules, problems };
}

/** 取某个采样点上、某张卡的某个指标 */
export function readGpuMetric(sample, gpuKeyValue, metric) {
  const gpu = (sample.gpus || []).find((item) => (item.uuid || `index-${item.index}`) === gpuKeyValue);
  if (!gpu) return undefined;
  if (metric === 'throttled') {
    if (gpu.throttle) return Object.values(gpu.throttle).some((value) => value === true);
    // 从历史库分桶查回来的样本只有聚合值，没有逐项节流掩码
    if (typeof gpu.throttled === 'boolean') return gpu.throttled;
    return undefined;
  }
  return gpu[metric];
}

export function readHostMetric(sample, metric) {
  const system = sample.system;
  if (!system) return undefined;
  if (metric === 'hostCpuPct') return system.cpu?.usagePct ?? undefined;
  if (metric === 'hostMemUsedPct') return system.mem?.usedPct ?? undefined;
  if (metric === 'hostSwapUsedPct') return system.swap?.usedPct ?? undefined;
  if (metric === 'hostDiskUsedPct') {
    const disks = (system.disk || []).filter((disk) => disk.usedPct != null);
    if (disks.length === 0) return undefined;
    return Math.max(...disks.map((disk) => disk.usedPct));
  }
  return undefined;
}

/** 取某个服务在某次采样里的指标 */
export function readServiceMetric(sample, serviceName, metric) {
  const entry = (sample.services || []).find((item) => item.service === serviceName);
  if (!entry) return undefined;
  if (metric === 'serviceMemMiB') return entry.memMiB ?? null;
  if (metric === 'serviceSharePct') return entry.sharePct ?? null;
  return undefined;
}

/**
 * 找出"警告线比严重线还严格"的规则。
 *
 * 同一个指标、同一个服务范围、同一个比较方向下，严重那条的阈值必须比警告那条更靠外，
 * 否则严重告警永远不会先响——配置看着没问题，真出事时只收到警告，属于最典型的静默失效。
 * 这类问题不会让规则被跳过，所以只能在加载时说一句。
 */
export function findThresholdConflicts(rules = []) {
  const groups = new Map();
  for (const rule of rules) {
    // 布尔量（节流 / 采集状态）和 == / != 没有"更严重"的方向，不参与比较
    if (!['>', '>=', '<', '<='].includes(rule.op)) continue;
    if (typeof rule.threshold !== 'number') continue;
    const key = `${rule.metric}|${rule.scope}|${rule.service || ''}|${rule.op}`;
    if (!groups.has(key)) groups.set(key, { warning: [], critical: [] });
    groups.get(key)[rule.level].push(rule);
  }

  const conflicts = [];
  for (const { warning, critical } of groups.values()) {
    for (const warn of warning) {
      for (const crit of critical) {
        // 越大越严重的方向（> / >=）要求严重线更高；反过来要求严重线更低。
        // 阈值相等不算：那种情况两条会同时响，虽然冗余，但严重那条并没有被"藏起来"。
        const biggerIsWorse = warn.op.startsWith('>');
        const inverted = biggerIsWorse
          ? crit.threshold < warn.threshold
          : crit.threshold > warn.threshold;
        if (!inverted) continue;
        conflicts.push({
          ruleId: crit.id,
          message: `${crit.id} 是严重规则（${crit.op} ${crit.threshold}），`
            + `却比警告规则 ${warn.id}（${warn.op} ${warn.threshold}）更靠内，严重告警永远不会先响`,
        });
      }
    }
  }
  return conflicts;
}
