// 采集调度：把"找 nvidia-smi → 探测可用字段 → 采样 GPU + 宿主 → 写环形缓冲"
// 这一整套从 HTTP 层拆出来。这样既能单测，也方便以后换成别的数据源
// （比如把采集换成 Python 后端、把环形缓冲换成 SQL 存档）。
import os from 'node:os';

import { History } from './history.js';
import { detectPlatform, resolveHostname, resolveNvidiaSmi } from './platform.js';
import {
  BASE_FIELDS, defaultGpuFields, readGpuBusIds, readGpuSnapshot, readRowRemapper, resolveGpuFields,
} from './nvidia.js';
import { createXidTracker, parseXidLines, readKernelLog } from './xid.js';
import { createProcessInfoReader } from './procinfo.js';
import { summarizeServices } from './services.js';
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
    // 告警里有个 throttled 指标，曲线样本也得带上它。
    // 之前只留了画曲线要用的字段，导致这个指标在内存窗口里永远是 undefined，
    // 规则一次都不会触发（长周期走历史库才碰巧没受影响）。
    throttled: gpu.throttle ? Object.values(gpu.throttle).some((value) => value === true) : null,
    // ECC 计数同理：告警要判"有没有在涨"，必须进内存窗口和历史样本
    eccMode: gpu.eccMode ?? null,
    eccCorrectedVolatile: gpu.eccCorrectedVolatile ?? null,
    eccUncorrectedVolatile: gpu.eccUncorrectedVolatile ?? null,
    eccCorrectedAggregate: gpu.eccCorrectedAggregate ?? null,
    eccUncorrectedAggregate: gpu.eccUncorrectedAggregate ?? null,
    // 行重映射：同样是"卡有没有在变坏"的证据，告警要用到，必须进样本
    remap: gpu.remap ? { ...gpu.remap } : null,
    // XID：读不到日志时这里是 undefined，与"读到且为 0 次"区分开
    xid: gpu.xid ? { ...gpu.xid } : null,
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
  // 进程信息补全（服务归属 / 运行用户 / 完整命令行），Linux 上从 /proc 读
  processInfo = createProcessInfoReader({ platform: platform.id }),
}) {
  const history = new History(options.windowSamples);
  const system = systemCollector === undefined
    ? (options.system === false ? null : createSystemCollector({ platform: platform.id, diskTargets: options.diskTargets }))
    : systemCollector;

  const runtime = {
    startedAt: now(),
    // --mock 下是 demo-host（免得模拟数据的截图把本机名带出去），真机就是本机名
    hostname: resolveHostname({ mock: options.mock }),
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
  // 正在跑的那一拍（关历史库前要先等它结束，见 collectOnce / stop）
  let inFlight = null;
  // 行重映射状态：这些值基本不变，低频读一次就行，读到的结果贴在每一帧的卡上
  const remap = { at: 0, loading: false, byIndex: new Map(), error: null, unsupported: false };
  // XID：内核日志里的 GPU 错误事件。同样低频读，累计器负责去重与跨轮转计数
  const xid = {
    at: 0,
    loading: false,
    source: null,
    error: null,
    tried: [],
    tracker: createXidTracker(),
    // 序号 → 总线号，用来把日志里的 XID 落到具体的卡上（读一次就够，总线号不会变）
    indexToBusId: new Map(),
  };
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

  async function runCollect() {
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

      // 补上"这个进程属于哪个服务/容器/用户"：失败时原样返回，不影响采集
      if (processInfo?.supported && snapshot.processes?.length) {
        try {
          snapshot.processes = await processInfo.enrich(snapshot.processes);
        } catch {
          // 读 /proc 失败不是致命问题，页面上这几列留空即可
        }
      }

      // 行重映射：低频后台读，读不到就沿用上一次的结果，
      // 绝不能让这一拍因为多问一次 nvidia-smi 而变慢或失败
      if (!mockSource && runtime.smi?.ok) refreshRemap(runtime.smi.bin);
      applyRemap(snapshot.gpus);
      if (!mockSource && runtime.smi?.ok) refreshXid(runtime.smi.bin);
      applyXid(snapshot.gpus);

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
      // 服务维度的汇总跟着每个采样点走：短窗口的持续判定用内存里的这份，长窗口查历史库
      const services = summarizeServices(snapshot.processes, snapshot.gpus);
      history.push({
        t: Date.now(),
        gpus: snapshot.gpus.map(toCurveGpu),
        system: systemSample,
        services,
      });
      runtime.latest = {
        t: Date.now(),
        gpus: snapshot.gpus,
        processes: snapshot.processes,
        system: systemSample,
        services,
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
            // 服务汇总必须跟着进库：库里的 service_sample 表就是靠这个字段写的。
            // 漏传过一次，症状是表里一行没有、长周期服务规则查历史库时读不到数据而静默不触发——
            // 实时判定用的是内存里那份，所以在 for 不超过窗口时完全看不出问题。
            services,
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

  /**
   * 跑一拍采集。
   * 用一层薄包装把"正在跑的那一拍"记下来：关闭流程要先等它结束再关历史库，
   * 因为这一拍收尾时还要落盘、还要取一次状态并推给订阅者——库要是先关了，
   * 它就会打到已关闭的连接上，抛出 ERR_INVALID_STATE 把进程带崩（线上真实发生过）。
   */
  function collectOnce() {
    if (collecting) return inFlight ?? Promise.resolve();
    collecting = true;
    inFlight = runCollect();
    const done = () => {
      inFlight = null;
    };
    inFlight.then(done, done);
    return inFlight;
  }

  /**
   * 低频刷新行重映射状态。
   * 刻意不 await：它要再起两次 nvidia-smi，让采集循环等它会拖慢每一帧。
   * 成功失败都记时间戳，失败时也要等到下一个周期再试，避免每拍都去撞墙。
   */
  function refreshRemap(bin) {
    if (remap.loading || stopped) return;
    if (remap.at && now() - remap.at < options.remapIntervalMs) return;
    remap.loading = true;
    readRowRemapper({ bin, timeout: Math.max(4000, options.intervalMs * 4) })
      .then((result) => {
        remap.byIndex = result.byIndex;
        remap.unsupported = result.unsupported;
        remap.error = null;
        // 立刻补到当前这一帧上：否则要等下一次采集才生效，
        // 采集间隔较长（空闲降频 10 秒）时页面会白等好几秒
        applyRemap(runtime.latest?.gpus);
      })
      .catch((error) => {
        // 老驱动没有 ROW_REMAPPER 段时整条命令会失败，这不算故障
        remap.error = error?.message || String(error);
      })
      .finally(() => {
        remap.loading = false;
        remap.at = now();
      });
  }

  /** 把最近一次读到的重映射状态贴到这一帧的卡上；没有数据的卡保持原样 */
  function applyRemap(gpus) {
    for (const gpu of gpus || []) {
      const found = remap.byIndex.get(gpu.index);
      if (found) gpu.remap = found;
    }
  }

  /**
   * 低频读内核日志，累计 XID 事件。
   * 刻意不 await，理由同行重映射；读不到日志（权限）时只记原因，
   * 绝不把 gpu.xid 写成 0——"读不到"和"没有错误"是两回事。
   */
  function refreshXid(bin) {
    if (xid.loading || stopped) return;
    if (xid.at && now() - xid.at < options.xidIntervalMs) return;
    xid.loading = true;
    // 内核日志可能很大，journalctl 冷缓存时几秒到十几秒都正常；
    // 这是低频后台读，给宽一点，别让超时把一次正常的读取变成"读不到"
    const timeout = Math.max(15000, options.intervalMs * 10);

    (async () => {
      if (xid.indexToBusId.size === 0) {
        xid.indexToBusId = await readGpuBusIds({ bin, timeout });
      }
      const log = await readKernelLog({ timeout });
      xid.source = log.source;
      xid.error = log.error;
      xid.tried = log.tried;
      if (log.text) {
        xid.tracker.observe(parseXidLines(log.text), now());
        applyXid(runtime.latest?.gpus);
      }
    })()
      .catch((error) => {
        xid.error = error?.message || String(error);
      })
      .finally(() => {
        xid.loading = false;
        xid.at = now();
      });
  }

  /**
   * 把 XID 状态贴到卡上。
   * 只有成功读到过日志才贴——否则界面会显示"XID 0 次"，
   * 那会被读成"这块卡没问题"，而实际情况是"我们根本看不到"。
   */
  function applyXid(gpus) {
    if (!xid.source) return;
    for (const gpu of gpus || []) {
      const busId = xid.indexToBusId.get(gpu.index);
      if (busId) gpu.xid = xid.tracker.forBusId(busId);
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
      // 行重映射的采集状态：读不到时说清原因，而不是让那一行凭空消失
      remapStatus: {
        supported: remap.byIndex.size > 0,
        updatedAt: remap.at || null,
        error: remap.error,
      },
      // XID 的读取状态：读不到时页面要能说清是权限问题，而不是装作没有错误
      xidStatus: {
        available: Boolean(xid.source),
        source: xid.source,
        updatedAt: xid.at || null,
        error: xid.error,
        tried: xid.tried,
        total: xid.tracker.summary().total,
      },
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
      // 服务维度的汇总（哪个服务占了多少显存），告警与页面都可以直接用
      services: latest?.services || [],
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
      // 把在途那一拍交还给调用方：先等它跑完再关历史库
      return inFlight ?? Promise.resolve();
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
