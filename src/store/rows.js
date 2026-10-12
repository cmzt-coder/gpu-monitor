// 采样点 ↔ 数据库行 的映射。
// 放在单独一个模块里，是为了让"存什么"和"怎么存"分开：
// 换存储、换表结构时只改这里，采集与接口层不受影响。

// 节流原因打包成一个位掩码，省列数也省 IO。
// 顺序一旦发布就不能改，否则老库里的掩码会解读错。
export const THROTTLE_BITS = [
  'swPowerCap',
  'hwSlowdown',
  'hwThermal',
  'hwPowerBrake',
  'swThermal',
  'gpuIdle',
];

/** 返回 null 表示"驱动没报节流信息"，0 表示"明确没有节流" */
export function packThrottle(throttle) {
  if (!throttle) return null;
  let mask = 0;
  THROTTLE_BITS.forEach((key, index) => {
    if (throttle[key] === true) mask |= (1 << index);
  });
  return mask;
}

export function unpackThrottle(mask) {
  if (mask == null) return null;
  const throttle = {};
  THROTTLE_BITS.forEach((key, index) => {
    throttle[key] = (mask & (1 << index)) !== 0;
  });
  return throttle;
}

export function hasThrottle(throttle) {
  if (!throttle) return 0;
  return Object.values(throttle).some((value) => value === true) ? 1 : 0;
}

/** 一次采样里的一张卡 → 一行 gpu_sample */
export function gpuRow(nodeId, ts, gpu) {
  return {
    ts,
    node_id: nodeId,
    uuid: gpu.uuid ?? null,
    idx: gpu.index ?? null,
    name: gpu.name ?? null,
    mem_used_mib: gpu.memUsedMiB ?? null,
    mem_total_mib: gpu.memTotalMiB ?? null,
    util_gpu_pct: gpu.utilGpuPct ?? null,
    util_mem_pct: gpu.utilMemPct ?? null,
    temp_c: gpu.tempC ?? null,
    power_w: gpu.powerW ?? null,
    clock_sm_mhz: gpu.clockSmMHz ?? null,
    pstate: gpu.pstate ?? null,
    fan_pct: gpu.fanPct ?? null,
    throttle_mask: packThrottle(gpu.throttle),
    throttle_any: hasThrottle(gpu.throttle),
  };
}

/** 宿主指标快照 → 一行 host_sample（磁盘按 JSON 存，逐盘明细保留） */
export function hostRow(nodeId, ts, system) {
  if (!system) return null;
  return {
    ts,
    node_id: nodeId,
    cpu_pct: system.cpu?.usagePct ?? null,
    mem_used_mib: system.mem?.usedMiB ?? null,
    mem_total_mib: system.mem?.totalMiB ?? null,
    mem_used_pct: system.mem?.usedPct ?? null,
    swap_used_mib: system.swap?.usedMiB ?? null,
    swap_total_mib: system.swap?.totalMiB ?? null,
    load1: system.load?.l1 ?? null,
    load5: system.load?.l5 ?? null,
    load15: system.load?.l15 ?? null,
    disk_json: Array.isArray(system.disk) && system.disk.length ? JSON.stringify(system.disk) : null,
    net_rx_bps: system.net?.rxBytesPerSec ?? null,
    net_tx_bps: system.net?.txBytesPerSec ?? null,
    uptime_sec: system.uptimeSec ?? null,
  };
}

export function processRows(nodeId, ts, processes) {
  return (processes || []).map((proc) => ({
    ts,
    node_id: nodeId,
    uuid: proc.gpuUuid ?? null,
    gpu_index: proc.gpuIndex ?? null,
    pid: proc.pid ?? null,
    name: proc.name ?? null,
    used_mem_mib: proc.usedMemMiB ?? null,
  }));
}

/**
 * 进程列表的签名：只反映"身份"（哪张卡上是哪个进程），不含显存数值。
 * 显存数值每秒都在变，放进签名等于每个采样点都要写一遍，历史库里会被重复行淹没。
 */
export function processesSignature(processes) {
  if (!processes || processes.length === 0) return '';
  return processes
    .map((proc) => `${proc.gpuIndex ?? '-'}:${proc.pid ?? '-'}:${proc.name ?? '-'}`)
    .sort()
    .join('|');
}

/** 数据库行 → 接口里的 GPU 对象（字段名与实时接口保持一致） */
export function gpuFromRow(row) {
  const memUsedMiB = row.mem_used_mib ?? null;
  const memTotalMiB = row.mem_total_mib ?? null;
  return {
    index: row.idx ?? null,
    uuid: row.uuid ?? null,
    name: row.name ?? null,
    memUsedMiB,
    memTotalMiB,
    memUsedPct: memUsedMiB != null && memTotalMiB ? (memUsedMiB / memTotalMiB) * 100 : null,
    utilGpuPct: row.util_gpu_pct ?? null,
    utilMemPct: row.util_mem_pct ?? null,
    tempC: row.temp_c ?? null,
    powerW: row.power_w ?? null,
    clockSmMHz: row.clock_sm_mhz ?? null,
    pstate: row.pstate ?? null,
    fanPct: row.fan_pct ?? null,
    throttle: unpackThrottle(row.throttle_mask ?? null),
    throttled: row.throttle_any == null ? null : row.throttle_any === 1,
  };
}

/** 数据库行 → 接口里的宿主指标对象 */
export function systemFromRow(row) {
  if (!row) return null;
  let disk = [];
  if (row.disk_json) {
    try {
      disk = JSON.parse(row.disk_json);
    } catch {
      disk = [];
    }
  }
  const memTotalMiB = row.mem_total_mib ?? null;
  const memUsedMiB = row.mem_used_mib ?? null;
  const swapTotalMiB = row.swap_total_mib ?? null;
  const swapUsedMiB = row.swap_used_mib ?? null;
  return {
    cpu: { usagePct: row.cpu_pct ?? null, cores: null, model: null },
    mem: {
      totalMiB: memTotalMiB,
      usedMiB: memUsedMiB,
      availableMiB: memTotalMiB != null && memUsedMiB != null ? Math.max(0, memTotalMiB - memUsedMiB) : null,
      usedPct: row.mem_used_pct ?? null,
    },
    swap: swapTotalMiB == null ? null : {
      totalMiB: swapTotalMiB,
      usedMiB: swapUsedMiB,
      usedPct: swapTotalMiB > 0 && swapUsedMiB != null ? (swapUsedMiB / swapTotalMiB) * 100 : null,
    },
    load: row.load1 == null ? null : { l1: row.load1, l5: row.load5, l15: row.load15 },
    disk,
    net: row.net_rx_bps == null && row.net_tx_bps == null ? null : {
      interfaces: null,
      rxBytesPerSec: row.net_rx_bps ?? null,
      txBytesPerSec: row.net_tx_bps ?? null,
    },
    uptimeSec: row.uptime_sec ?? null,
    unsupported: [],
    fromHistory: true,
  };
}
