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
  ttftCount: ['vllm:time_to_first_token_seconds_count'],
  ttftSum: ['vllm:time_to_first_token_seconds_sum'],
  e2eCount: ['vllm:e2e_request_latency_seconds_count'],
  e2eSum: ['vllm:e2e_request_latency_seconds_sum'],
};

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
    ttftCount,
    ttftSum,
    e2eCount,
    e2eSum,
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
