// 推理服务监控运行时：按配置定时抓 /health、/v1/models、/metrics，维护一份最新快照。
//
// 为什么独立定时器：GPU 采集是 1 秒一拍，推理服务 15 秒抓一次就够。
// 放进采集循环会把 HTTP 超时直接转嫁到页面的实时性上。
import fs from 'node:fs';
import path from 'node:path';

import { loadInferenceConfig } from './config.js';
import { counterDelta, extractVllmMetrics } from './metrics.js';
import { mockInferenceServices } from './mock.js';

// /version 基本不变，低频刷新即可
const VERSION_TTL_MS = 300000;

function authHeaders(service, env) {
  const headers = { ...(service.headers || {}) };
  let authMissing = false;
  if (service.apiKeyEnv) {
    const key = env?.[service.apiKeyEnv];
    if (key) headers.Authorization = `Bearer ${key}`;
    else authMissing = true;
  }
  return { headers, authMissing };
}

/**
 * 带超时的 fetch。错误统一成可读字符串，不把 AbortError 原样丢给页面。
 * 返回 { ok, status, body, ms, error }。
 */
async function fetchText(fetchImpl, url, { timeoutMs, headers, now }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body, ms: now() - started, error: null };
  } catch (error) {
    const aborted = controller.signal.aborted || error?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      body: '',
      ms: now() - started,
      error: aborted ? `超时（>${timeoutMs}ms）` : (error?.cause?.code || error?.message || String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseModels(body) {
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.data)) return { ok: false, ids: [], error: '模型列表缺少 data 数组' };
    return { ok: true, ids: parsed.data.map((item) => item?.id).filter(Boolean), error: null };
  } catch {
    return { ok: false, ids: [], error: '模型列表不是合法 JSON' };
  }
}

function probeHeaders(service, env) {
  const { headers, authMissing } = authHeaders(service, env);
  return {
    headers: { ...headers, 'Content-Type': 'application/json' },
    authMissing,
  };
}

function probePayload(service, cold) {
  const probe = service.probe;
  if (service.kind === 'chat') {
    return {
      model: service.model,
      messages: [{ role: 'user', content: probe.prompt }],
      max_tokens: probe.maxTokens,
      temperature: 0,
      stream: Boolean(probe.stream),
      ...(probe.stream ? { stream_options: { include_usage: true } } : {}),
    };
  }
  if (service.kind === 'completions') {
    return {
      model: service.model,
      prompt: probe.prompt,
      max_tokens: probe.maxTokens,
      temperature: 0,
      stream: Boolean(probe.stream),
      ...(probe.stream ? { stream_options: { include_usage: true } } : {}),
    };
  }
  if (service.kind === 'embeddings') {
    return { model: service.model, input: probe.input };
  }
  return {
    model: service.model,
    query: probe.query,
    documents: probe.documents,
  };
}

function probePath(service) {
  if (service.kind === 'embeddings') return '/v1/embeddings';
  if (service.kind === 'rerank') return '/v1/rerank';
  if (service.kind === 'completions') return '/v1/completions';
  return '/v1/chat/completions';
}

/**
 * 流式探针：只有解析 SSE 才能拿到真正的首 token 时间。
 * 同时读出 usage.completion_tokens，避免把 reasoning token 当成"没输出"。
 */
async function probeStream(fetchImpl, url, payload, { headers, timeoutMs, now }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        status: response.status,
        ttftMs: null,
        e2eMs: now() - started,
        outputTokens: null,
        tokensPerSec: null,
        error: `HTTP ${response.status}${text ? `：${text.slice(0, 160)}` : ''}`,
      };
    }
    if (!response.body) {
      return { ok: false, status: response.status, ttftMs: null, e2eMs: now() - started, outputTokens: null, tokensPerSec: null, error: '响应没有 body' };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let ttftMs = null;
    let chunks = 0;
    let usage = null;
    let finishReason = null;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        if (delta.content || delta.reasoning) {
          chunks += 1;
          if (ttftMs == null) ttftMs = now() - started;
        }
      }
    }

    const e2eMs = now() - started;
    const outputTokens = usage?.completion_tokens ?? (chunks > 0 ? chunks : null);
    const ok = ttftMs != null && (outputTokens == null || outputTokens > 0);
    return {
      ok,
      status: response.status,
      ttftMs,
      e2eMs,
      outputTokens,
      tokensPerSec: outputTokens != null && e2eMs > 0
        ? outputTokens / Math.max(0.001, (e2eMs - (ttftMs ?? 0)) / 1000)
        : null,
      finishReason,
      error: ok ? null : '流式响应里没有解析到 token',
    };
  } catch (error) {
    const aborted = controller.signal.aborted || error?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      ttftMs: null,
      e2eMs: now() - started,
      outputTokens: null,
      tokensPerSec: null,
      error: aborted ? `超时（>${timeoutMs}ms）` : (error?.cause?.code || error?.message || String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeJson(fetchImpl, url, payload, { headers, timeoutMs, now }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    const e2eMs = now() - started;
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // 非 JSON 响应在下面统一按失败处理
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      body: text,
      e2eMs,
      error: response.ok ? null : `HTTP ${response.status}${text ? `：${text.slice(0, 160)}` : ''}`,
    };
  } catch (error) {
    const aborted = controller.signal.aborted || error?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      data: null,
      body: '',
      e2eMs: now() - started,
      error: aborted ? `超时（>${timeoutMs}ms）` : (error?.cause?.code || error?.message || String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

function probeRow(service, result, cold, now) {
  return {
    ts: now(),
    serviceId: service.id,
    kind: service.kind,
    ok: Boolean(result.ok),
    skipped: false,
    status: result.status ?? null,
    cold,
    ttftMs: result.ttftMs ?? null,
    e2eMs: result.e2eMs ?? null,
    outputTokens: result.outputTokens ?? null,
    tokensPerSec: result.tokensPerSec ?? null,
    error: result.error ?? null,
  };
}

/**
 * 执行一轮探针。chat/completions 默认"冷一次 + 热一次"，
 * embeddings/rerank 只发一次（它们没有生成过程，冷热差异通常不明显）。
 * 返回要落库的探针行数组。
 */
export async function runProbe(service, { fetchImpl = globalThis.fetch, env = process.env, now = Date.now } = {}) {
  const probe = service.probe;
  const { headers, authMissing } = probeHeaders(service, env);
  if (authMissing) {
    const row = probeRow(service, {
      ok: false,
      status: 0,
      e2eMs: null,
      error: `缺少环境变量 ${service.apiKeyEnv}`,
    }, true, now);
    return [row];
  }

  const url = `${service.baseUrl}${probePath(service)}`;
  const once = async (cold) => {
    const payload = probePayload(service, cold);
    if (service.kind === 'chat' || service.kind === 'completions') {
      const result = probe.stream
        ? await probeStream(fetchImpl, url, payload, { headers, timeoutMs: probe.timeoutMs, now })
        : await probeJson(fetchImpl, url, payload, { headers, timeoutMs: probe.timeoutMs, now });
      if (!probe.stream && result.ok) {
        const usage = result.data?.usage;
        const choice = result.data?.choices?.[0];
        result.ok = Boolean(choice) && (usage?.completion_tokens ?? 0) > 0;
        result.ttftMs = null;
        result.outputTokens = usage?.completion_tokens ?? null;
        result.tokensPerSec = result.outputTokens != null && result.e2eMs > 0
          ? result.outputTokens / (result.e2eMs / 1000)
          : null;
        if (!result.ok) result.error = '响应里没有 completion_tokens';
      }
      return probeRow(service, result, cold, now);
    }

    const result = await probeJson(fetchImpl, url, payload, { headers, timeoutMs: probe.timeoutMs, now });
    if (result.ok) {
      if (service.kind === 'embeddings') {
        result.ok = Array.isArray(result.data?.data) && result.data.data.length > 0;
      } else {
        result.ok = Array.isArray(result.data?.results) && result.data.results.length > 0;
      }
      if (!result.ok) result.error = '响应结构不符合预期';
    }
    return probeRow(service, {
      ...result,
      ttftMs: null,
      outputTokens: null,
      tokensPerSec: null,
    }, cold, now);
  };

  const rows = [];
  const cold = await once(true);
  rows.push(cold);
  if (probe.warmup && cold.ok) {
    rows.push(await once(false));
  }
  return rows;
}
function averageFrom(count, sum) {
  if (count == null || sum == null || count <= 0) return null;
  return (sum / count) * 1000;
}

function round2(value) {
  return value == null || !Number.isFinite(value) ? value : Math.round(value * 100) / 100;
}

export async function scrapeService(service, previous, { fetchImpl, timeoutMs, env, now }) {
  const { headers, authMissing } = authHeaders(service, env);
  const urlOf = (key) => `${service.baseUrl}${service.paths[key]}`;
  const [health, metrics, models] = await Promise.all([
    fetchText(fetchImpl, urlOf('health'), { timeoutMs, headers, now }),
    fetchText(fetchImpl, urlOf('metrics'), { timeoutMs, headers, now }),
    fetchText(fetchImpl, urlOf('models'), { timeoutMs, headers, now }),
  ]);

  // 健康检查的耗时单独记：它突增通常意味着事件循环被占满了
  const up = health.status === 200;
  let error = null;
  if (!up) {
    error = health.error ? `健康检查失败：${health.error}` : `健康检查返回 HTTP ${health.status || '-'}`;
  }

  let modelsOk = null;
  let modelsError = null;
  if (models.status === 200) {
    const parsed = parseModels(models.body);
    if (!parsed.ok) {
      modelsError = parsed.error;
      error = error || modelsError;
    } else {
      modelsOk = parsed.ids.includes(service.model);
      if (!modelsOk && !error) {
        modelsError = `模型列表里没有 ${service.model}（实际：${parsed.ids.slice(0, 3).join('、') || '空'}）`;
        error = modelsError;
      }
    }
  } else if (models.status === 401 || models.status === 403) {
    modelsOk = null;
    modelsError = authMissing
      ? `缺少环境变量 ${service.apiKeyEnv}，无法读取模型列表`
      : `模型列表鉴权失败（HTTP ${models.status}），检查 ${service.apiKeyEnv || 'API Key'}`;
    error = error || modelsError;
  } else {
    modelsError = `模型列表请求失败（HTTP ${models.status || '-'}）`;
    error = error || modelsError;
  }

  let metricsOk = metrics.status === 200;
  let metricsData = null;
  if (metricsOk) {
    metricsData = extractVllmMetrics(metrics.body, { model: service.model });
    // 一条 vllm 指标都解析不出来，说明抓到的不是 vLLM 的 /metrics
    if (metricsData.sampleCount === 0) {
      metricsOk = false;
      error = error || '/metrics 里没有解析到 vllm 指标';
    }
  } else {
    error = error || `指标请求失败（HTTP ${metrics.status || '-'}）`;
  }

  // /version 变化很慢，低频取一次；失败不影响主流程
  let version = previous?.version ?? null;
  let versionFetchedAt = previous?.versionFetchedAt ?? 0;
  if (up && (!versionFetchedAt || now() - versionFetchedAt > VERSION_TTL_MS)) {
    const result = await fetchText(fetchImpl, `${service.baseUrl}/version`, { timeoutMs, headers, now });
    versionFetchedAt = now();
    if (result.status === 200) {
      try {
        version = JSON.parse(result.body).version || version;
      } catch {
        // 不是 JSON 就保留上一次的值
      }
    }
  }

  const elapsedSec = previous?.updatedAt ? (now() - previous.updatedAt) / 1000 : null;
  const generationDelta = counterDelta(metricsData?.generationTokensTotal, previous?.metrics?.generationTokensTotal);
  const requestDelta = counterDelta(metricsData?.requestSuccessTotal, previous?.metrics?.requestSuccessTotal);
  const errorDelta = counterDelta(metricsData?.requestErrorTotal, previous?.metrics?.requestErrorTotal);
  const preemptionsDelta = counterDelta(metricsData?.preemptionsTotal, previous?.metrics?.preemptionsTotal);
  const errorRatePct = requestDelta > 0 && errorDelta != null ? (errorDelta / requestDelta) * 100 : null;

  // 优先用"两次抓取之间"的增量，首帧没有增量时退回累计均值
  const ttftCountDelta = counterDelta(metricsData?.ttftCount, previous?.metrics?.ttftCount);
  const ttftSumDelta = counterDelta(metricsData?.ttftSum, previous?.metrics?.ttftSum);
  // 首帧没有上一份快照时才用累计均值兜底；之后本轮没有新请求就返回 null。
  // 否则空闲时会把"历史累计平均"当成"当前延迟"，TTFT 告警会在没流量时误报。
  const hasPreviousTtft = previous?.metrics?.ttftCount != null;
  const ttftAvgMs = hasPreviousTtft
    ? (ttftCountDelta > 0 && ttftSumDelta != null ? (ttftSumDelta / ttftCountDelta) * 1000 : null)
    : averageFrom(metricsData?.ttftCount, metricsData?.ttftSum);
  const e2eCountDelta = counterDelta(metricsData?.e2eCount, previous?.metrics?.e2eCount);
  const e2eSumDelta = counterDelta(metricsData?.e2eSum, previous?.metrics?.e2eSum);
  const hasPreviousE2e = previous?.metrics?.e2eCount != null;
  const e2eAvgMs = hasPreviousE2e
    ? (e2eCountDelta > 0 && e2eSumDelta != null ? (e2eSumDelta / e2eCountDelta) * 1000 : null)
    : averageFrom(metricsData?.e2eCount, metricsData?.e2eSum);

  let state = 'unknown';
  if (health.status > 0 || health.error) {
    state = up ? ((modelsOk === false || modelsError || !metricsOk) ? 'degraded' : 'up') : 'down';
  }

  return {
    snapshot: {
      id: service.id,
      name: service.name,
      kind: service.kind,
      model: service.model,
      baseUrl: service.baseUrl,
      state,
      up: up ? true : (health.status === 0 && !health.error ? null : false),
      modelsOk,
      modelsError,
      metricsOk,
      statusCode: health.status || null,
      healthMs: health.ms,
      version,
      running: metricsData?.running ?? null,
      waiting: metricsData?.waiting ?? null,
      kvCachePct: round2(metricsData?.kvCachePct ?? null),
      preemptionsTotal: metricsData?.preemptionsTotal ?? null,
      promptTokensTotal: metricsData?.promptTokensTotal ?? null,
      generationTokensTotal: metricsData?.generationTokensTotal ?? null,
      requestSuccessTotal: metricsData?.requestSuccessTotal ?? null,
      requestErrorTotal: metricsData?.requestErrorTotal ?? null,
      requestsDelta: requestDelta,
      errorDelta,
      preemptionsDelta,
      errorRatePct: round2(errorRatePct),
      tokensPerSec: round2(generationDelta != null && elapsedSec > 0 ? generationDelta / elapsedSec : null),
      ttftAvgMs: round2(ttftAvgMs),
      e2eAvgMs: round2(e2eAvgMs),
      updatedAt: now(),
      error,
      warning: metricsOk ? null : '该实例的 /metrics 不可用或格式不兼容',
    },
    cache: {
      updatedAt: now(),
      metrics: metricsData,
      version,
      versionFetchedAt,
    },
  };
}

function summarize(services) {
  const summary = { total: services.length, up: 0, down: 0, degraded: 0, unknown: 0 };
  for (const service of services) {
    if (service.state === 'up') summary.up += 1;
    else if (service.state === 'down') summary.down += 1;
    else if (service.state === 'degraded') summary.degraded += 1;
    else summary.unknown += 1;
  }
  return summary;
}

/** 配置刚加载、还没来得及抓第一帧时，先用占位项把服务清单显示出来 */
function placeholderService(service, now) {
  return {
    id: service.id,
    name: service.name,
    kind: service.kind,
    model: service.model,
    baseUrl: service.baseUrl,
    state: 'unknown',
    up: null,
    modelsOk: null,
    metricsOk: null,
    healthMs: null,
    running: null,
    waiting: null,
    kvCachePct: null,
    ttftAvgMs: null,
    e2eAvgMs: null,
    tokensPerSec: null,
    updatedAt: now(),
    error: null,
  };
}

export function createInferenceRuntime({
  options = {},
  store = null,
  logger = console,
  watch = true,
  mock = false,
  now = Date.now,
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  const runtime = {
    enabled: options.inference !== false,
    loaded: false,
    mock: Boolean(mock),
    config: null,
    configPath: options.inferencePath || 'inference.json',
    intervalMs: 15000,
    timeoutMs: 3000,
    services: [],
    warnings: [],
    reason: null,
    error: null,
    lastReloadError: null,
    reloadedAt: null,
    updatedAt: null,
    autoReload: false,
    timer: null,
    watcher: null,
    debounceTimer: null,
    scanning: false,
    stopped: false,
    lastByService: new Map(),
    // 告警引擎用的内存环形缓冲：每轮抓取一条，默认保留 600 条（15s 一轮约 2.5 小时）
    samples: [],
    probeStates: new Map(),
    probeTimer: null,
  };

  async function reload({ initial = false } = {}) {
    if (!runtime.enabled) return { reloaded: false, reason: runtime.reason };
    const loaded = await loadInferenceConfig(runtime.configPath);
    runtime.error = loaded.error || null;
    runtime.warnings = loaded.warnings || [];

    if (!loaded.config) {
      const reason = loaded.error
        || (loaded.disabled ? '配置里 enabled=false'
          : loaded.missing ? `未找到 ${runtime.configPath}` : '未启用');
      if (!initial && runtime.loaded) {
        // 已经跑起来的监控不因为一次改错而失效
        runtime.lastReloadError = reason;
        logger.warn?.(`[gpu-monitor] 推理监控配置重新加载失败（${reason}），继续沿用上一次的 ${runtime.services.length} 个服务`);
        return { reloaded: false, reason };
      }
      runtime.loaded = false;
      runtime.config = null;
      runtime.services = [];
      runtime.reason = reason;
      runtime.lastReloadError = loaded.error || null;
      return { reloaded: false, reason };
    }

    runtime.loaded = true;
    runtime.config = loaded.config;
    runtime.intervalMs = loaded.config.intervalMs;
    runtime.timeoutMs = loaded.config.timeoutMs;
    runtime.services = loaded.config.services.map((service) => placeholderService(service, now));
    runtime.reason = null;
    runtime.reloadedAt = now();
    runtime.lastReloadError = null;
    // 新配置立刻抓一次，不等下一个周期
    schedule(0);
    return { reloaded: true, count: loaded.config.services.length };
  }

  function probeStateFor(serviceId) {
    let state = runtime.probeStates.get(serviceId);
    if (!state) {
      state = { firstSeenAt: 0, lastAt: 0, inFlight: false, lastResult: null };
      runtime.probeStates.set(serviceId, state);
    }
    return state;
  }

  /** 把最近一次探针结果贴到服务快照上；页面每次取状态都能看到 */
  function attachProbeResults() {
    for (const service of runtime.services) {
      const state = runtime.probeStates.get(service.id);
      if (state?.lastResult) service.probe = state.lastResult;
    }
  }

  function pushSample() {
    if (!runtime.services.length) return;
    runtime.samples.push({ t: runtime.updatedAt || now(), services: runtime.services });
    const cap = Math.max(30, Number(options.inferenceWindowSamples) || 600);
    while (runtime.samples.length > cap) runtime.samples.shift();
  }

  function saveProbeRow(service, row) {
    try {
      store?.appendInferenceProbe?.(row);
    } catch (error) {
      logger.warn?.(`[gpu-monitor] 推理探针写入历史库失败：${error?.message || error}`);
    }
    const state = probeStateFor(service.id);
    const previous = state.lastResult || {};
    state.lastResult = {
      at: row.ts,
      ok: row.ok,
      skipped: row.skipped,
      cold: row.cold,
      ttftMs: row.ttftMs,
      e2eMs: row.e2eMs,
      tokensPerSec: row.tokensPerSec,
      // 冷热两次是两行，lastResult 只留最后一次；这里把另一边的值也带上，页面能同时显示
      coldTtftMs: row.cold ? row.ttftMs : (previous.coldTtftMs ?? null),
      warmTtftMs: row.cold ? (previous.warmTtftMs ?? null) : row.ttftMs,
      error: row.error,
    };
    attachProbeResults();
  }

  function skipProbe(service, reason) {
    saveProbeRow(service, {
      ts: now(),
      serviceId: service.id,
      kind: service.kind,
      ok: false,
      skipped: true,
      status: null,
      cold: null,
      ttftMs: null,
      e2eMs: null,
      outputTokens: null,
      tokensPerSec: null,
      error: reason,
    });
  }

  /**
   * 探针调度：每 5 秒检查一次"谁到点了"。
   * 真正执行是异步的，不阻塞抓取；同一服务同一时刻只跑一轮。
   */
  function maybeRunProbes() {
    if (!runtime.config || runtime.mock || runtime.stopped) return;
    const snapshots = new Map(runtime.services.map((service) => [service.id, service]));
    for (const service of runtime.config.services) {
      const probe = service.probe;
      if (!probe?.enabled) continue;
      const snapshot = snapshots.get(service.id);
      if (!snapshot || snapshot.state === 'unknown') continue;

      const state = probeStateFor(service.id);
      if (!state.firstSeenAt) state.firstSeenAt = now();
      if (state.inFlight) continue;
      if (state.lastAt && now() - state.lastAt < probe.intervalMs) continue;

      // 服务已经判死时不再发探针：等一个 60 秒超时没有任何收益
      if (snapshot.up === false) {
        state.lastAt = now();
        skipProbe(service, '服务不可用，跳过探针');
        continue;
      }

      // 启动宽限期：模型加载/换入权重期间探针失败不算故障。
      // 下一次到期时间要放到宽限期结束，而不是"跳过一次 + 再等一个完整 interval"——
      // 否则 grace 5m、interval 10m 时，第一次真实探针会拖到启动后 10 分钟才发生。
      const graceRemainingMs = probe.startupGraceMs - (now() - state.firstSeenAt);
      if (probe.startupGraceMs > 0 && graceRemainingMs > 0) {
        state.lastAt = now() - probe.intervalMs + graceRemainingMs;
        skipProbe(service, '启动宽限期内跳过');
        continue;
      }

      const running = snapshot.running ?? 0;
      const waiting = snapshot.waiting ?? 0;
      if (probe.idleOnly && running + waiting > 0) {
        state.lastAt = now();
        skipProbe(service, `服务忙碌（运行 ${running} / 等待 ${waiting}），按 idleOnly 跳过`);
        continue;
      }

      state.lastAt = now();
      state.inFlight = true;
      runProbe(service, { fetchImpl, env, now })
        .then((rows) => {
          for (const row of rows) saveProbeRow(service, row);
        })
        .catch((error) => {
          saveProbeRow(service, {
            ts: now(),
            serviceId: service.id,
            kind: service.kind,
            ok: false,
            skipped: false,
            status: null,
            cold: true,
            ttftMs: null,
            e2eMs: null,
            outputTokens: null,
            tokensPerSec: null,
            error: error?.message || String(error),
          });
        })
        .finally(() => {
          state.inFlight = false;
        });
    }
  }

  function startProbeTimer() {
    if (runtime.probeTimer || runtime.mock || runtime.stopped) return;
    runtime.probeTimer = setInterval(() => {
      try {
        maybeRunProbes();
      } catch (error) {
        logger.warn?.(`[gpu-monitor] 推理探针调度失败：${error?.message || error}`);
      }
    }, 5000);
    runtime.probeTimer.unref?.();
  }

  function schedule(delayMs = runtime.intervalMs) {
    if (runtime.stopped || runtime.mock) return;
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = setTimeout(async () => {
      runtime.timer = null;
      await scrapeAll();
      if (!runtime.stopped) schedule(runtime.intervalMs);
    }, Math.max(0, delayMs));
    runtime.timer.unref?.();
  }

  async function scrapeAll() {
    if (runtime.stopped || runtime.scanning || !runtime.config) return;
    runtime.scanning = true;
    try {
      const results = await Promise.all(runtime.config.services.map(async (service) => {
        try {
          return await scrapeService(service, runtime.lastByService.get(service.id), {
            fetchImpl, timeoutMs: runtime.timeoutMs, env, now,
          });
        } catch (error) {
          return {
            snapshot: {
              id: service.id,
              name: service.name,
              kind: service.kind,
              model: service.model,
              baseUrl: service.baseUrl,
              state: 'down',
              up: false,
              modelsOk: null,
              metricsOk: false,
              healthMs: null,
              running: null,
              waiting: null,
              kvCachePct: null,
              ttftAvgMs: null,
              e2eAvgMs: null,
              tokensPerSec: null,
              updatedAt: now(),
              error: error?.message || String(error),
            },
            cache: null,
          };
        }
      }));
      runtime.services = results.map((item) => item.snapshot);
      for (const item of results) {
        if (item.cache) runtime.lastByService.set(item.snapshot.id, item.cache);
      }
      runtime.updatedAt = now();
      attachProbeResults();
      pushSample();
      try {
        store?.appendInferenceSample?.({ t: runtime.updatedAt, services: runtime.services });
      } catch (error) {
        logger.warn?.(`[gpu-monitor] 推理采样写入历史库失败：${error?.message || error}`);
      }
      maybeRunProbes();
    } finally {
      runtime.scanning = false;
    }
  }

  function scheduleMock() {
    if (runtime.stopped) return;
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      runtime.services = mockInferenceServices(now());
      runtime.updatedAt = now();
      pushSample();
      scheduleMock();
    }, 5000);
    runtime.timer.unref?.();
  }

  function scheduleReload() {
    if (runtime.debounceTimer) clearTimeout(runtime.debounceTimer);
    runtime.debounceTimer = setTimeout(async () => {
      runtime.debounceTimer = null;
      const result = await reload();
      if (result.reloaded) {
        logger.info?.(`[gpu-monitor] 推理监控配置已重新加载：${result.count} 个服务`);
      }
    }, 500);
    runtime.debounceTimer.unref?.();
  }

  function startWatching() {
    if (!watch || runtime.watcher || !runtime.enabled || runtime.mock) return;
    const absolute = path.resolve(runtime.configPath);
    try {
      // 监听目录而不是文件：编辑器常用"写临时文件再改名"保存，watch 文件会失效
      runtime.watcher = fs.watch(path.dirname(absolute), { persistent: false }, (event, filename) => {
        if (filename && filename !== path.basename(absolute)) return;
        scheduleReload();
      });
      runtime.watcher.on('error', (error) => {
        logger.warn?.(`[gpu-monitor] 推理配置监听失败（${error.message}），改动后需重启服务`);
        runtime.watcher = null;
        runtime.autoReload = false;
      });
      runtime.autoReload = true;
    } catch (error) {
      logger.warn?.(`[gpu-monitor] 无法监听推理配置（${error.message}），改动后需重启服务`);
    }
  }

  return {
    async start() {
      if (!runtime.enabled) {
        runtime.reason = '启动时带了 --no-inference';
        return this.snapshot();
      }
      if (runtime.mock) {
        runtime.loaded = true;
        runtime.intervalMs = 5000;
        runtime.services = mockInferenceServices(now());
        runtime.updatedAt = now();
        pushSample();
        scheduleMock();
        return this.snapshot();
      }
      await reload({ initial: true });
      startWatching();
      startProbeTimer();
      return this.snapshot();
    },
    reload,
    scrapeAll,
    getSamples(limit) {
      return limit ? runtime.samples.slice(-limit) : runtime.samples.slice();
    },
    snapshot() {
      return {
        enabled: runtime.enabled,
        loaded: runtime.loaded,
        mock: runtime.mock,
        configPath: runtime.configPath,
        intervalMs: runtime.intervalMs,
        timeoutMs: runtime.timeoutMs,
        services: runtime.services,
        configured: runtime.mock ? runtime.services.length : (runtime.config?.services.length ?? 0),
        summary: summarize(runtime.services),
        warnings: runtime.warnings,
        reason: runtime.reason,
        error: runtime.error,
        lastReloadError: runtime.lastReloadError,
        reloadedAt: runtime.reloadedAt,
        updatedAt: runtime.updatedAt,
        autoReload: runtime.autoReload,
      };
    },
    close() {
      runtime.stopped = true;
      if (runtime.timer) clearTimeout(runtime.timer);
      if (runtime.probeTimer) clearInterval(runtime.probeTimer);
      if (runtime.debounceTimer) clearTimeout(runtime.debounceTimer);
      runtime.timer = null;
      runtime.probeTimer = null;
      runtime.debounceTimer = null;
      runtime.watcher?.close();
      runtime.watcher = null;
    },
  };
}
