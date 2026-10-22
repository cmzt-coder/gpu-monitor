// Prometheus 文本格式的最小解析器 + vLLM 指标提取。
//
// 为什么不引第三方库：
//   - /metrics 的格式很简单，按行解析足够用；
//   - 项目本身坚持零依赖，这里没有引入解析器的理由。
//
// 两个必须守住的点（vLLM 0.31 实测）：
//   1. `*_created` 是 Counter 的创建时间戳，不是计数，必须排除；
//   2. 指标名跨版本改过（kv_cache_usage_perc / gpu_cache_usage_perc），用别名表兼容。
const SAMPLE_PATTERN = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+\S+)?$/;
const LABEL_PATTERN = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;

function unescapeLabel(value) {
  return value.replace(/\\(["\\n])/g, (_, char) => (char === 'n' ? '\n' : char));
}

/** `engine="0",model_name="x"` → { engine: '0', model_name: 'x' } */
export function parseLabels(source) {
  const labels = {};
  if (!source) return labels;
  LABEL_PATTERN.lastIndex = 0;
  let match;
  while ((match = LABEL_PATTERN.exec(source)) !== null) {
    labels[match[1]] = unescapeLabel(match[2]);
  }
  return labels;
}

/**
 * 解析 Prometheus 文本。
 * 返回 [{ name, labels, value }]；注释、空行、无法识别的行直接跳过。
 * NaN / +Inf / -Inf 记作 null——"读不到"不能伪装成 0。
 */
export function parsePrometheus(text) {
  const samples = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = SAMPLE_PATTERN.exec(line);
    if (!match) continue;
    const numeric = Number(match[3]);
    samples.push({
      name: match[1],
      labels: parseLabels(match[2]),
      value: Number.isFinite(numeric) ? numeric : null,
    });
  }
  return samples;
}

/** 序列是否属于目标模型：没有 model_name 标签（全局指标）时一律保留 */
export function matchesModel(sample, model) {
  if (!model) return true;
  const label = sample?.labels?.model_name;
  return label == null || label === model;
}

function labelMatches(sample, wanted) {
  for (const [key, value] of Object.entries(wanted || {})) {
    if (sample?.labels?.[key] !== value) return false;
  }
  return true;
}

function scopedSamples(samples, { model = null, requireModel = false } = {}) {
  return samples.filter((sample) => {
    if (sample.name.endsWith('_created')) return false;
    if (!matchesModel(sample, model)) return false;
    if (requireModel && model && sample.labels?.model_name !== model && sample.labels?.model_name != null) return false;
    return true;
  });
}

function firstValue(samples, names) {
  for (const name of names) {
    const found = samples.find((sample) => sample.name === name && sample.value != null);
    if (found) return found.value;
  }
  return null;
}

function sumValues(samples, names, wantedLabels = {}) {
  const wanted = new Set(names);
  let sum = null;
  for (const sample of samples) {
    if (!wanted.has(sample.name) || sample.value == null) continue;
    if (!labelMatches(sample, wantedLabels)) continue;
    sum = (sum ?? 0) + sample.value;
  }
  return sum;
}

const NAMES = {
  running: ['vllm:num_requests_running'],
  waiting: ['vllm:num_requests_waiting'],
  kvCache: ['vllm:kv_cache_usage_perc', 'vllm:gpu_cache_usage_perc'],
  preemptions: ['vllm:num_preemptions_total', 'vllm:num_preemptions'],
  promptTokens: ['vllm:prompt_tokens_total', 'vllm:prompt_tokens'],
  generationTokens: ['vllm:generation_tokens_total', 'vllm:generation_tokens'],
  requestSuccess: ['vllm:request_success_total', 'vllm:request_success'],
  prefixCacheHits: ['vllm:prefix_cache_hits_total', 'vllm:prefix_cache_hits'],
  prefixCacheQueries: ['vllm:prefix_cache_queries_total', 'vllm:prefix_cache_queries'],
  ttftCount: ['vllm:time_to_first_token_seconds_count'],
  ttftSum: ['vllm:time_to_first_token_seconds_sum'],
  e2eCount: ['vllm:e2e_request_latency_seconds_count'],
  e2eSum: ['vllm:e2e_request_latency_seconds_sum'],
};

const HISTOGRAM_BASES = {
  ttft: 'vllm:time_to_first_token_seconds',
  e2e: 'vllm:e2e_request_latency_seconds',
  itl: 'vllm:inter_token_latency_seconds',
  queue: 'vllm:request_queue_time_seconds',
  prefill: 'vllm:request_prefill_time_seconds',
  decode: 'vllm:request_decode_time_seconds',
  iterationTokens: 'vllm:iteration_tokens_total',
};

function parseLe(value) {
  if (value === '+Inf' || value === 'Inf' || value === 'inf') return Number.POSITIVE_INFINITY;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** 读取一个直方图的所有 bucket / sum / count，并按 le 合并多 engine 的序列 */
function readHistogram(samples, base) {
  const byLe = new Map();
  let sum = null;
  let count = null;
  for (const sample of samples) {
    if (sample.name === `${base}_bucket` && sample.value != null) {
      const le = parseLe(sample.labels.le);
      if (le == null) continue;
      byLe.set(le, (byLe.get(le) ?? 0) + sample.value);
    } else if (sample.name === `${base}_sum` && sample.value != null) {
      sum = (sum ?? 0) + sample.value;
    } else if (sample.name === `${base}_count` && sample.value != null) {
      count = (count ?? 0) + sample.value;
    }
  }
  const buckets = [...byLe.entries()]
    .map(([le, value]) => ({ le, value }))
    .sort((a, b) => a.le - b.le);
  return buckets.length ? { buckets, sum, count } : null;
}

/** 用累计直方图计算分位数，结果统一成毫秒 */
export function histogramQuantile(q, histogram) {
  const buckets = (histogram?.buckets || []).filter((bucket) => bucket.value != null && bucket.value >= 0);
  if (buckets.length === 0) return null;
  const total = buckets[buckets.length - 1].value;
  // 如果没有 +Inf 桶，最后一带的累计值就是样本总数
  if (!(total > 0)) return null;
  const rank = q * total;
  let previousLe = 0;
  let previousCount = 0;
  for (const bucket of buckets) {
    if (bucket.value >= rank) {
      if (!Number.isFinite(bucket.le)) return previousLe * 1000;
      const span = bucket.value - previousCount;
      const ratio = span > 0 ? (rank - previousCount) / span : 1;
      return (previousLe + (bucket.le - previousLe) * ratio) * 1000;
    }
    previousLe = Number.isFinite(bucket.le) ? bucket.le : previousLe;
    previousCount = bucket.value;
  }
  return null;
}

/** 两次抓取之间的直方图差值；桶结构变化或计数器重置时返回 null */
export function subtractHistograms(current, previous) {
  if (!current || !previous) return null;
  const previousByLe = new Map(previous.buckets.map((bucket) => [String(bucket.le), bucket.value]));
  const buckets = [];
  for (const bucket of current.buckets) {
    const before = previousByLe.get(String(bucket.le));
    if (before == null || bucket.value < before) return null;
    buckets.push({ le: bucket.le, value: bucket.value - before });
  }
  return {
    buckets,
    sum: counterDelta(current.sum, previous.sum),
    count: counterDelta(current.count, previous.count),
  };
}

/**
 * 从一段 /metrics 文本里提取本项目的标准指标。
 * 缺失的一律返回 null，调用方据此显示"该版本未提供"，不要填 0。
 */
export function extractVllmMetrics(text, { model = null } = {}) {
  const all = parsePrometheus(text);
  const samples = scopedSamples(all, { model });

  const kvRaw = firstValue(samples, NAMES.kvCache);
  const ttftCount = sumValues(samples, NAMES.ttftCount);
  const ttftSum = sumValues(samples, NAMES.ttftSum);
  const e2eCount = sumValues(samples, NAMES.e2eCount);
  const e2eSum = sumValues(samples, NAMES.e2eSum);
  const histograms = {};
  for (const [key, base] of Object.entries(HISTOGRAM_BASES)) {
    histograms[key] = readHistogram(samples, base);
  }

  return {
    running: sumValues(samples, NAMES.running),
    waiting: sumValues(samples, NAMES.waiting),
    // vLLM 里 1 表示 100%，页面统一用百分数
    kvCachePct: kvRaw == null ? null : kvRaw * 100,
    preemptionsTotal: sumValues(samples, NAMES.preemptions),
    promptTokensTotal: sumValues(samples, NAMES.promptTokens),
    generationTokensTotal: sumValues(samples, NAMES.generationTokens),
    requestSuccessTotal: sumValues(samples, NAMES.requestSuccess),
    requestErrorTotal: sumValues(samples, NAMES.requestSuccess, { finished_reason: 'error' }),
    requestAbortTotal: sumValues(samples, NAMES.requestSuccess, { finished_reason: 'abort' }),
    prefixCacheHits: sumValues(samples, NAMES.prefixCacheHits),
    prefixCacheQueries: sumValues(samples, NAMES.prefixCacheQueries),
    waitingCapacity: sumValues(samples, ['vllm:num_requests_waiting_by_reason'], { reason: 'capacity' }),
    waitingDeferred: sumValues(samples, ['vllm:num_requests_waiting_by_reason'], { reason: 'deferred' }),
    ttftCount,
    ttftSum,
    e2eCount,
    e2eSum,
    histograms,
    // 原始序列数量：0 说明解析失败或该版本没暴露 vllm 指标
    sampleCount: samples.length,
    metricNames: [...new Set(samples.map((sample) => sample.name))].sort(),
  };
}

/** 两个累计计数器之间的一段时间差值；回绕或拿不到时返回 null */
export function counterDelta(current, previous) {
  if (current == null || previous == null) return null;
  const delta = current - previous;
  return delta >= 0 ? delta : null;
}
