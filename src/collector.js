// 采集调度：把"找 nvidia-smi → 探测可用字段 → 采样 GPU + 宿主 → 写环形缓冲"
// 这一整套从 HTTP 层拆出来。这样既能单测，也方便以后换成别的数据源
// （比如把采集换成 Python 后端、把环形缓冲换成 SQL 存档）。
import os from 'node:os';

import { History } from './history.js';
import { detectPlatform, resolveNvidiaSmi } from './platform.js';
import { BASE_FIELDS, defaultGpuFields, readGpuSnapshot, resolveGpuFields } from './nvidia.js';
import { createSystemCollector } from './system.js';

// 探测失败后每隔这么久再试一次，这样后装驱动/挂载显卡后不用重启服务
const SMI_RETRY_MS = 30000;

// 环形缓冲里只留曲线需要的字段，扩展指标（时钟/节流等）只保留最新一份
function toCurveGpu(gpu) {
  return {
    index: gpu.index,
    uuid: gpu.uuid,
    name: gpu.name,
    memTotalMiB: gpu.memTotalMiB,
    memUsedMiB: gpu.memUsedMiB,
    memUsedPct: gpu.memUsedPct,
    utilGpuPct: gpu.utilGpuPct,
    utilMemPct: gpu.utilMemPct,
    tempC: gpu.tempC,
    powerW: gpu.powerW,
  };
}

/**
 * 决定下一次采集的间隔。
 * 没人在看的时候是"降频"而不是"停采"：窗口保持连续，用户回来时曲线不会出现空洞。
 * lastClientAt 为 0 表示还没有过任何请求，此时按正常频率采集，先把数据准备好。
 */
export function resolveCadence({ lastClientAt, now, intervalMs, idleAfterMs, idleIntervalMs }) {
  const idle = idleAfterMs > 0 && lastClientAt > 0 && now - lastClientAt >= idleAfterMs;
  return { idle, delayMs: idle ? Math.max(intervalMs, idleIntervalMs) : intervalMs };
}

export function createCollector({
  options,
  platform = detectPlatform(),
  mockSource = null,
  systemCollector,
  store = null,
  // 注入时钟：单测里要确定性地验证"空闲降频"与"订阅者会不会把它唤醒"
  now = Date.now,
  // 让上层往状态里补字段（比如告警）。统一走这里，/api/state 与 SSE 推送才不会各补一份、慢慢跑偏
  extraState = null,
}) {
  const history = new History(options.windowSamples);
  const system = systemCollector === undefined
    ? (options.system === false ? null : createSystemCollector({ platform: platform.id, diskTargets: options.diskTargets }))
    : systemCollector;

  const runtime = {
    startedAt: now(),
    hostname: os.hostname(),
    status: 'starting',
    lastError: null,
    lastErrorHint: null,
    lastSampleAt: null,
    processWarning: null,
    systemWarning: null,
    storeWarning: null,
    collectMs: null,
    driverVersion: null,
    latest: null,
    // nvidia-smi 的探测结果，见 src/platform.js
    smi: null,
    smiResolvedAt: 0,
    // 扩展字段的探测结果，见 src/nvidia.js 的 resolveGpuFields。
    // 模拟数据源不需要（也没法）探测驱动，直接标成 mock，避免界面一直显示"探测中"。
    fieldProbe: options.extended === false
      ? { fields: BASE_FIELDS, unsupported: [], extended: false }
      : (mockSource ? { fields: defaultGpuFields(), unsupported: [], extended: true, mock: true } : null),
  };

  let smiPromise = null;
  let fieldPromise = null;
  let collecting = false;
  let stopped = false;
  let timer = null;
  let lastClientAt = 0;
  let lastDelayMs = options.intervalMs;
  // 订阅者：采集完一帧就推给他们。带 countsAsViewer 的（SSE 连接）算"有人在看"，
  // 告警引擎这类内部订阅者不算——否则只要进程活着就永远不会进入空闲降频。
  const subscribers = new Set();

  function notify() {
    if (subscribers.size === 0) return;
    const state = getState();
    for (const entry of [...subscribers]) {
      try {
        entry.listener(state);
      } catch {
        // 单个订阅者出错不能影响采集循环
      }
    }
  }

  function viewerCount() {
    let count = 0;
    for (const entry of subscribers) if (entry.countsAsViewer) count += 1;
    return count;
  }

  async function ensureSmi({ force = false } = {}) {
    if (runtime.smi?.ok && !force) return runtime.smi;
    const currentTime = now();
    if (!force && runtime.smiResolvedAt && currentTime - runtime.smiResolvedAt < SMI_RETRY_MS) {
      return runtime.smi;
    }
    if (smiPromise) return smiPromise;

    runtime.smiResolvedAt = currentTime;
    smiPromise = resolveNvidiaSmi({ explicit: options.smiBin })
      .then((result) => {
        runtime.smi = result;
        return result;
      })
      .finally(() => {
        smiPromise = null;
      });
    return smiPromise;
  }

  async function ensureFields(smi) {
    if (runtime.fieldProbe) return runtime.fieldProbe;
    if (fieldPromise) return fieldPromise;
    fieldPromise = resolveGpuFields({
      bin: smi.bin,
      timeout: Math.max(3000, options.intervalMs * 4),
      extended: options.extended !== false,
    })
      .then((probe) => {
        runtime.fieldProbe = probe;
        return probe;
      })
      .catch((error) => {
        // 探测本身失败不该让整个服务停摆：退回基础字段，采集继续
        runtime.fieldProbe = { fields: BASE_FIELDS, unsupported: [], extended: false, error: error?.message || String(error) };
        return runtime.fieldProbe;
      })
      .finally(() => {
        fieldPromise = null;
      });
    return fieldPromise;
  }

  async function collectOnce() {
    if (collecting) return;
    collecting = true;
    const startedAt = Date.now();
    try {
      let snapshot;
      if (mockSource) {
        snapshot = await mockSource();
      } else {
        const smi = await ensureSmi();
        if (!smi.ok) {
          const error = new Error(smi.error);
          error.hint = smi.hint;
          throw error;
        }
        const probe = await ensureFields(smi);
        snapshot = await readGpuSnapshot({
          bin: smi.bin,
          timeout: Math.max(3000, options.intervalMs * 4),
          fields: probe.fields,
        });
      }

      let systemSample = null;
      if (system) {
        try {
          systemSample = await system.sample();
          runtime.systemWarning = null;
        } catch (error) {
          runtime.systemWarning = `宿主指标采集失败：${error?.message || error}`;
        }
      }

      // 曲线样本只保留必要字段；最新的完整指标（含时钟/节流等）单独留在 runtime.latest
      history.push({ t: Date.now(), gpus: snapshot.gpus.map(toCurveGpu), system: systemSample });
      runtime.latest = {
        t: Date.now(),
        gpus: snapshot.gpus,
        processes: snapshot.processes,
        system: systemSample,
      };
      runtime.status = 'ok';
      runtime.lastError = null;
      runtime.lastErrorHint = null;
      runtime.lastSampleAt = runtime.latest.t;
      runtime.processWarning = snapshot.processWarning || null;
      runtime.driverVersion = snapshot.gpus[0]?.driverVersion || runtime.driverVersion;

      // 落库失败（磁盘满、文件被删等）不能影响实时采集，只记一条提示
      if (store) {
        try {
          store.appendSample({
            t: runtime.latest.t,
            gpus: snapshot.gpus,
            processes: snapshot.processes,
            system: systemSample,
          });
          runtime.storeWarning = null;
        } catch (error) {
          runtime.storeWarning = `写入历史库失败：${error?.message || error}`;
        }
      }
    } catch (error) {
      runtime.status = 'error';
      runtime.lastError = error?.message || String(error);
      runtime.lastErrorHint = error?.hint || null;
    } finally {
      runtime.collectMs = Date.now() - startedAt;
      collecting = false;
      notify();
    }
  }

  function cadence() {
    // 有 SSE 订阅者就说明确实有人在看屏幕，联网状态直接算作活跃
    const currentTime = now();
    const effectiveLastClientAt = viewerCount() > 0 ? currentTime : lastClientAt;
    return resolveCadence({
      lastClientAt: effectiveLastClientAt,
      now: currentTime,
      intervalMs: options.intervalMs,
      idleAfterMs: options.idleAfterMs,
      idleIntervalMs: options.idleIntervalMs,
    });
  }

  function schedule() {
    if (stopped) return;
    const { delayMs } = cadence();
    lastDelayMs = delayMs;
    timer = setTimeout(async () => {
      await collectOnce();
      schedule();
    }, delayMs);
    timer.unref?.();
  }

  function getState() {
    const latest = runtime.latest;
    const current = cadence();
    const probe = runtime.fieldProbe;
    return {
      ok: runtime.status === 'ok',
      status: runtime.status,
      ts: runtime.lastSampleAt || Date.now(),
      // 最近一次成功采样的时间戳（没有样本时为 null）。
      // 健康检查靠它判断"数据是不是不新鲜了"，不能用 ts——ts 在没有数据时会退化成当前时间
      lastSampleAt: runtime.lastSampleAt,
      serverTime: Date.now(),
      intervalMs: options.intervalMs,
      windowSamples: options.windowSamples,
      hostname: runtime.hostname,
      version: options.version,
      mock: Boolean(mockSource),
      // 运行平台：前端据此区分"平台不支持"和"驱动异常"
      platform: {
        id: platform.id,
        label: platform.label,
        arch: platform.arch,
        nodeVersion: platform.nodeVersion,
        supported: platform.supported,
        note: platform.note,
      },
      // 采集后端：当前只有 nvidia-smi 一种
      collector: {
        id: 'nvidia-smi',
        bin: runtime.smi?.ok ? runtime.smi.bin : null,
        source: runtime.smi?.source || null,
        deviceCount: runtime.smi?.ok ? runtime.smi.deviceCount : null,
        tried: runtime.smi?.tried || [],
      },
      // 扩展指标探测结果：哪些字段这台机器的驱动不支持
      fields: {
        extended: probe ? probe.extended : null,
        enabled: options.extended !== false,
        mock: Boolean(probe?.mock),
        count: probe ? probe.fields.length : null,
        unsupported: probe?.unsupported || [],
        error: probe?.error || null,
      },
      // 空闲降频：没人看的时候按 idleIntervalMs 采集
      idle: {
        active: current.idle,
        idleAfterMs: options.idleAfterMs,
        idleIntervalMs: options.idleIntervalMs,
        currentIntervalMs: lastDelayMs,
        lastClientAgoMs: lastClientAt ? now() - lastClientAt : null,
      },
      // 推送通道：enabled 由启动参数决定，subscribers 是当前挂着的 SSE 连接数
      push: {
        enabled: options.push !== false,
        subscribers: viewerCount(),
        listeners: subscribers.size,
      },
      systemEnabled: Boolean(system),
      systemWarning: runtime.systemWarning,
      storeWarning: runtime.storeWarning,
      storage: store
        ? store.stats()
        : { mode: 'disabled', supportsHistory: false, reason: '未启用历史库' },
      smiBin: runtime.smi?.ok ? runtime.smi.bin : (options.smiBin || 'nvidia-smi'),
      hint: runtime.lastErrorHint,
      driverVersion: runtime.driverVersion,
      uptimeSec: Math.round((now() - runtime.startedAt) / 1000),
      collectMs: runtime.collectMs,
      samples: history.size,
      error: runtime.lastError,
      processWarning: runtime.processWarning,
      gpus: latest ? latest.gpus : [],
      processes: latest ? latest.processes : [],
      system: latest ? latest.system : null,
      ...(extraState ? extraState() : {}),
    };
  }

  function getHistory(limit) {
    const capped = limit ? Math.min(options.windowSamples, limit) : options.windowSamples;
    return {
      intervalMs: options.intervalMs,
      windowSamples: options.windowSamples,
      samples: history.snapshot(capped),
    };
  }

  return {
    start() {
      const first = collectOnce();
      schedule();
      // 把第一次采集的 promise 交出去，调用方（比如启动横幅）可以等第一帧数据
      return first;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    // 每次 HTTP 请求都调用一次，用来判断"还有没有人在看"
    noteClient() {
      lastClientAt = now();
    },
    /**
     * 订阅每一帧的推送，返回取消订阅的函数。
     * countsAsViewer=false 的内部订阅者（比如告警引擎）不会被当成"有页面在看"。
     */
    subscribe(listener, { countsAsViewer = true } = {}) {
      const entry = { listener, countsAsViewer };
      subscribers.add(entry);
      return () => subscribers.delete(entry);
    },
    subscriberCount() {
      return viewerCount();
    },
    tick: collectOnce,
    cadence,
    getState,
    getHistory,
    getSamples(limit) {
      return getHistory(limit).samples;
    },
    probeInfo() {
      return runtime.fieldProbe;
    },
  };
}
