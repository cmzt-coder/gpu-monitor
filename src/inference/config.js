// 推理服务监控配置：读 inference.json，把每条服务配置规范化成运行时能直接用的结构。
//
// 设计原则和 alerts/config.js 一致：
//   - 文件不存在不是错误，只是"没启用"，服务照常启动
//   - 单条配置写坏只跳过那一条，并记一条 warning，不影响其他服务和 GPU 监控
import fs from 'node:fs/promises';

import { expandEnv } from '../alerts/config.js';

export const INFERENCE_KINDS = ['chat', 'completions', 'embeddings', 'rerank', 'mineru'];

const DEFAULT_PATHS = {
  health: '/health',
  models: '/v1/models',
  metrics: '/metrics',
};

// MinerU 没有 OpenAI 接口和 Prometheus 指标：
//   - 服务状态、排队数、运行中任务数、成功/失败计数都在 /health 的 JSON 里
//   - 探针走同步解析接口 /file_parse（multipart 上传一个小 PDF）
// 所以 models / metrics 明确置空，避免去请求并不存在的 /v1/models 和 /metrics。
const MINERU_PATHS = {
  health: '/health',
  models: null,
  metrics: null,
  parse: '/file_parse',
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const DURATION_PATTERN = /^(\d+)\s*(ms|s|m|h)?$/i;
const DURATION_UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000 };

/** "15s" / "2m" / 15000 → 毫秒；无法解析时返回 fallback */
export function parseDurationMs(value, fallbackMs = 0) {
  if (value == null) return fallbackMs;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  const match = DURATION_PATTERN.exec(String(value).trim());
  if (!match) return fallbackMs;
  return Number(match[1]) * (DURATION_UNITS[(match[2] || 's').toLowerCase()] || 1000);
}

function normalizePath(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.startsWith('/') ? text : `/${text}`;
}

function normalizeHeaders(raw, warnings, id) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push({ index: null, id, message: 'headers 必须是对象' });
    return {};
  }
  const headers = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      warnings.push({ index: null, id, message: `headers.${name} 必须是字符串` });
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

/**
 * 主动探针参数。第一阶段不执行，但配置从第一阶段就原样保留；
 * 第二阶段在这里补默认值与范围限制，避免运行时再散落一堆 ?? 默认值。
 */
function normalizeProbe(raw, kind, warnings, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: false };
  }
  // MinerU 的探针要真的跑一次文档解析，成本比一次 chat 请求高得多：
  // 间隔默认 15 分钟、超时默认 180 秒，并且没有冷热双峰和流式概念。
  if (kind === 'mineru') {
    return {
      enabled: raw.enabled === true,
      intervalMs: Math.max(30000, parseDurationMs(raw.interval, 900000)),
      timeoutMs: Math.max(5000, Number(raw.timeoutMs) || 180000),
      idleOnly: raw.idleOnly !== false,
      startupGraceMs: Math.max(0, parseDurationMs(raw.startupGrace, 300000)),
      warmup: false,
      stream: false,
      maxTokens: 1,
      prompt: String(raw.prompt || 'ping'),
      input: String(raw.input || raw.prompt || 'ping'),
      query: String(raw.query || 'ping'),
      documents: ['pong'],
      // 解析后端：留空表示用服务端默认值（3.4.x 默认 hybrid-engine）
      backend: String(raw.backend || '').trim(),
      // 万一内置探针 PDF 被服务端拒绝，可以指定一个本机 PDF 文件兜底
      pdfPath: String(raw.pdfPath || '').trim(),
    };
  }
  const documents = Array.isArray(raw.documents) && raw.documents.length > 0
    ? raw.documents.map((item) => String(item))
    : ['pong'];
  return {
    enabled: raw.enabled === true,
    // 探针是重操作：最短 10 秒（低于这个值更容易干扰真实流量），默认 10 分钟
    intervalMs: Math.max(10000, parseDurationMs(raw.interval, 600000)),
    timeoutMs: Math.max(1000, Number(raw.timeoutMs) || 60000),
    idleOnly: raw.idleOnly !== false,
    startupGraceMs: Math.max(0, parseDurationMs(raw.startupGrace, 300000)),
    // 冷热双峰：默认先发一次预热，再测一次热态；只有 chat/completions 有意义
    warmup: raw.warmup !== false && (kind === 'chat' || kind === 'completions'),
    stream: raw.stream !== false,
    maxTokens: Math.min(256, Math.max(1, Number(raw.maxTokens) || 32)),
    prompt: String(raw.prompt || 'ping'),
    input: String(raw.input || raw.prompt || 'ping'),
    query: String(raw.query || 'ping'),
    documents,
  };
}

function normalizeService(raw, index, warnings, seen) {
  const fallbackId = `service-${index + 1}`;
  const id = String(raw?.id || fallbackId).trim();
  if (!ID_PATTERN.test(id)) {
    warnings.push({ index, id, message: 'id 只能包含字母、数字、点、下划线和短横线' });
    return null;
  }
  if (seen.has(id.toLowerCase())) {
    warnings.push({ index, id, message: `id 重复（${id}），已跳过这一条` });
    return null;
  }

  const baseUrl = String(raw?.baseUrl || '').trim().replace(/\/+$/, '');
  let parsedUrl = null;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    parsedUrl = null;
  }
  if (!parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol)) {
    warnings.push({ index, id, message: 'baseUrl 必须是 http:// 或 https:// 开头的完整地址' });
    return null;
  }

  let kind = String(raw?.kind || 'chat').trim().toLowerCase();
  if (!INFERENCE_KINDS.includes(kind)) {
    warnings.push({ index, id, message: `kind=${kind} 不支持，已按 chat 处理` });
    kind = 'chat';
  }

  // MinerU 没有 /v1/models，model 只用于卡片标题，允许留空
  const model = String(raw?.model || '').trim();
  if (!model && kind !== 'mineru') {
    warnings.push({ index, id, message: '缺少 model（必须与 /v1/models 返回的 id 一致）' });
    return null;
  }

  let apiKeyEnv = null;
  if (raw?.apiKeyEnv != null && String(raw.apiKeyEnv).trim()) {
    apiKeyEnv = String(raw.apiKeyEnv).trim();
    if (!ENV_NAME.test(apiKeyEnv)) {
      warnings.push({ index, id, message: `apiKeyEnv=${apiKeyEnv} 不是合法的环境变量名` });
      apiKeyEnv = null;
    }
  }

  // 页面保存的直接密钥只存在于本机 inference.json；读取接口会统一脱敏。
  // 两种方式同时存在时直接密钥优先，避免同一个服务携带两套互相矛盾的凭据。
  const apiKey = raw?.apiKey != null && String(raw.apiKey).trim()
    ? String(raw.apiKey).trim()
    : null;
  if (apiKey && apiKeyEnv) {
    warnings.push({ index, id, message: 'apiKey 与 apiKeyEnv 同时配置，将优先使用 apiKey' });
  }

  seen.add(id.toLowerCase());
  return {
    id,
    name: String(raw?.name || id).trim() || id,
    baseUrl,
    model,
    kind,
    // 可选：vLLM 的 --max-num-seqs，用来显示并发余量；不填就只显示运行数
    maxConcurrency: Number(raw?.maxConcurrency) > 0 ? Math.floor(Number(raw.maxConcurrency)) : null,
    apiKeyEnv,
    apiKey,
    headers: normalizeHeaders(raw?.headers, warnings, id),
    paths: normalizePaths(raw?.paths, kind),
    probe: normalizeProbe(raw?.probe, kind, warnings, id),
  };
}

/**
 * 接口路径按 kind 取默认值。
 * MinerU 的 models / metrics 是 null：运行时据此直接跳过这两类请求。
 */
function normalizePaths(raw, kind) {
  const defaults = kind === 'mineru' ? MINERU_PATHS : DEFAULT_PATHS;
  const pathOf = (key) => (defaults[key] === null ? null : normalizePath(raw?.[key], defaults[key]));
  const paths = {
    health: pathOf('health'),
    models: pathOf('models'),
    metrics: pathOf('metrics'),
  };
  if (kind === 'mineru') paths.parse = pathOf('parse');
  return paths;
}

/**
 * 规范化一份已经解析好的配置对象。
 * 返回 { config, warnings, disabled }；config 为 null 表示明确关闭。
 */
export function normalizeInferenceConfig(parsed = {}) {
  const warnings = [];
  if (parsed.enabled === false) return { config: null, warnings, disabled: true };

  const intervalMs = Math.max(1000, parseDurationMs(parsed.interval, 15000));
  const timeoutMs = Math.max(200, Number(parsed.timeoutMs) || 3000);
  const rawServices = Array.isArray(parsed.services) ? parsed.services : [];
  if (!Array.isArray(parsed.services)) {
    warnings.push({ index: null, id: null, message: 'services 必须是数组' });
  }

  const seen = new Set();
  const services = [];
  rawServices.forEach((raw, index) => {
    const service = normalizeService(raw, index, warnings, seen);
    if (service) services.push(service);
  });

  return {
    config: {
      enabled: true,
      intervalMs,
      timeoutMs,
      services,
      warnings,
    },
    warnings,
    disabled: false,
  };
}

/**
 * 读取推理监控配置。
 * 文件不存在 → missing=true；JSON 坏了 → error 带上原因；两种情况都不影响服务启动。
 */
export async function loadInferenceConfig(file) {
  if (!file) {
    return { config: null, path: null, error: null, missing: false, disabled: false, warnings: [] };
  }
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = expandEnv(JSON.parse(text));
    const normalized = normalizeInferenceConfig(parsed);
    return {
      config: normalized.config,
      path: file,
      error: null,
      missing: false,
      disabled: normalized.disabled,
      warnings: normalized.warnings,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { config: null, path: file, error: null, missing: true, disabled: false, warnings: [] };
    }
    return {
      config: null,
      path: file,
      error: `解析 ${file} 失败：${error?.message || error}`,
      missing: false,
      disabled: false,
      warnings: [],
    };
  }
}
