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
}) {
  const history = new History(options.windowSamples);
  const system = systemCollector === undefined
    ? (options.system === false ? null : createSystemCollector({ platform: platform.id, diskTargets: options.diskTargets }))
    : systemCollector;

  const runtime = {
    startedAt: Date.now(),
    hostname: os.hostname(),
    status: 'starting',
    lastError: null,
    lastErrorHint: null,
    lastSampleAt: null,
    processWarning: null,
    systemWarning: null,
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

  async function ensureSmi({ force = false } = {}) {
    if (runtime.smi?.ok && !force) return runtime.smi;
    const now = Date.now();
    if (!force && runtime.smiResolvedAt && now - runtime.smiResolvedAt < SMI_RETRY_MS) {
      return runtime.smi;
    }
    if (smiPromise) return smiPromise;

    runtime.smiResolvedAt = now;
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
    } catch (error) {
      runtime.status = 'error';
      runtime.lastError = error?.message || String(error);
      runtime.lastErrorHint = error?.hint || null;
    } finally {
      runtime.collectMs = Date.now() - startedAt;
      collecting = false;
    }
  }

  function cadence() {
    return resolveCadence({
      lastClientAt,
      now: Date.now(),
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
        lastClientAgoMs: lastClientAt ? Date.now() - lastClientAt : null,
      },
      systemEnabled: Boolean(system),
      systemWarning: runtime.systemWarning,
      smiBin: runtime.smi?.ok ? runtime.smi.bin : (options.smiBin || 'nvidia-smi'),
      hint: runtime.lastErrorHint,
      driverVersion: runtime.driverVersion,
      uptimeSec: Math.round((Date.now() - runtime.startedAt) / 1000),
      collectMs: runtime.collectMs,
      samples: history.size,
      error: runtime.lastError,
      processWarning: runtime.processWarning,
      gpus: latest ? latest.gpus : [],
      processes: latest ? latest.processes : [],
      system: latest ? latest.system : null,
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
      lastClientAt = Date.now();
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
