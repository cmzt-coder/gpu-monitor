// 推理服务的模拟数据：--mock 下没有 vLLM 也要能演示页面。
//
// 刻意使用通用名称而不是真机模型名——模拟数据经常被拿来截图，
// 真机模型名和地址不该跟着截图一起流出去。
export function mockInferenceServices(now = Date.now()) {
  const t = now / 1000;
  const wave = (period, min, max) => {
    const ratio = (Math.sin(t / period) + 1) / 2;
    return min + ratio * (max - min);
  };
  const base = {
    up: true,
    modelsOk: true,
    metricsOk: true,
    healthMs: Number(wave(17, 1.2, 4.8).toFixed(1)),
    updatedAt: now,
    error: null,
  };
  const services = [
    {
      ...base,
      id: 'chat-large',
      name: '对话模型',
      kind: 'chat',
      model: 'chat-large-demo',
      state: 'up',
      running: Math.round(wave(23, 0, 6)),
      waiting: Math.round(wave(61, 0, 2)),
      kvCachePct: Number(wave(41, 8, 62).toFixed(1)),
      ttftAvgMs: Math.round(wave(13, 180, 420)),
      tokensPerSec: Number(wave(7, 42, 96).toFixed(1)),
      requestsDelta: Math.round(wave(11, 3, 18)),
      errorDelta: 0,
      preemptionsTotal: 0,
      probe: {
        at: now, ok: true, skipped: false, cold: false,
        ttftMs: Math.round(wave(13, 180, 420)), e2eMs: Math.round(wave(13, 420, 900)),
        coldTtftMs: Math.round(wave(31, 2800, 5600)), warmTtftMs: Math.round(wave(13, 180, 420)),
        tokensPerSec: Number(wave(7, 42, 96).toFixed(1)), error: null,
      },
    },
    {
      ...base,
      id: 'vision-small',
      name: '多模态模型',
      kind: 'chat',
      model: 'vision-small-demo',
      state: 'up',
      running: Math.round(wave(31, 0, 2)),
      waiting: 0,
      kvCachePct: Number(wave(37, 2, 18).toFixed(1)),
      ttftAvgMs: Math.round(wave(19, 90, 260)),
      tokensPerSec: Number(wave(9, 28, 70).toFixed(1)),
      requestsDelta: Math.round(wave(29, 0, 4)),
      errorDelta: 0,
      preemptionsTotal: 0,
      probe: {
        at: now, ok: true, skipped: false, cold: false,
        ttftMs: Math.round(wave(19, 90, 260)), e2eMs: Math.round(wave(19, 220, 520)),
        coldTtftMs: Math.round(wave(41, 600, 1800)), warmTtftMs: Math.round(wave(19, 90, 260)),
        tokensPerSec: Number(wave(9, 28, 70).toFixed(1)), error: null,
      },
    },
    {
      ...base,
      id: 'embedding',
      name: '向量化服务',
      kind: 'embeddings',
      model: 'embedding-demo',
      state: 'up',
      running: Math.round(wave(11, 0, 4)),
      waiting: 0,
      kvCachePct: Number(wave(53, 0, 6).toFixed(1)),
      ttftAvgMs: null,
      tokensPerSec: null,
      requestsDelta: Math.round(wave(5, 20, 90)),
      errorDelta: 0,
      preemptionsTotal: 0,
      probe: {
        at: now, ok: true, skipped: false, cold: false,
        ttftMs: null, e2eMs: Math.round(wave(6, 18, 45)), coldTtftMs: null, warmTtftMs: null,
        tokensPerSec: null, error: null,
      },
    },
    {
      ...base,
      id: 'rerank',
      name: '重排服务',
      kind: 'rerank',
      model: 'rerank-demo',
      state: 'up',
      running: Math.round(wave(15, 0, 2)),
      waiting: 0,
      kvCachePct: Number(wave(47, 0, 4).toFixed(1)),
      ttftAvgMs: null,
      tokensPerSec: null,
      requestsDelta: Math.round(wave(7, 8, 40)),
      errorDelta: 0,
      preemptionsTotal: 0,
      probe: {
        at: now, ok: true, skipped: false, cold: false,
        ttftMs: null, e2eMs: Math.round(wave(8, 8, 22)), coldTtftMs: null, warmTtftMs: null,
        tokensPerSec: null, error: null,
      },
    },
  ];

  return services.map((service, index) => {
    const chat = service.kind === 'chat';
    const maxConcurrency = chat ? 16 : null;
    return {
      ...service,
      waitingCapacity: service.waiting ?? 0,
      waitingDeferred: 0,
      preemptionsPerMin: Number(wave(37 + index, 0, 0.4).toFixed(2)),
      maxConcurrency,
      concurrencyPct: maxConcurrency
        ? Number((((service.running ?? 0) / maxConcurrency) * 100).toFixed(1))
        : null,
      ttftP95Ms: service.ttftAvgMs == null ? null : Math.round(service.ttftAvgMs * 1.35),
      e2eP95Ms: service.probe?.e2eMs == null ? null : Math.round(service.probe.e2eMs * 1.3),
      itlP95Ms: chat ? Number(wave(9 + index, 8, 24).toFixed(1)) : null,
      queueP95Ms: chat ? Number(wave(7 + index, 1, 18).toFixed(1)) : null,
      prefillP95Ms: chat ? Number(wave(5 + index, 40, 180).toFixed(1)) : null,
      decodeP95Ms: chat ? Number(wave(6 + index, 120, 420).toFixed(1)) : null,
      promptTokensPerSec: Number(wave(8 + index, 80, 420).toFixed(1)),
      generationTokensPerSec: service.tokensPerSec,
      requestsPerMin: Number(wave(11 + index, 3, 40).toFixed(1)),
      stepTokensAvg: chat ? Number(wave(12 + index, 8, 64).toFixed(1)) : null,
      errorRatePct: Number(wave(13 + index, 0, 2).toFixed(1)),
      abortRatePct: Number(wave(14 + index, 0, 1).toFixed(1)),
      cacheHitPct: chat ? Number(wave(15 + index, 0, 70).toFixed(1)) : null,
      probeStats: {
        samples: 20,
        successPct: 98,
        coldWarmRatio: service.probe?.coldTtftMs != null && service.probe?.warmTtftMs
          ? Number((service.probe.coldTtftMs / service.probe.warmTtftMs).toFixed(1))
          : null,
      },
    };
  });
}
