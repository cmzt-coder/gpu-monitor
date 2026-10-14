// 把内存中的采样窗口导出为 CSV（每张卡每一刻的显存与利用率原始数据）
const GPU_HEADERS = [
  'timestamp_iso',
  'gpu_index',
  'gpu_name',
  'mem_used_mib',
  'mem_total_mib',
  'mem_used_pct',
  'util_gpu_pct',
  'util_mem_pct',
  'temp_c',
  'power_w',
];

export const GPU_CSV_HEADER = GPU_HEADERS.join(',');

// 导出扩展字段时追加的列：这些数据都在库里，但默认 CSV 里没有
const GPU_FULL_HEADERS = [
  'clock_sm_mhz',
  'clock_mem_mhz',
  'pstate',
  'fan_pct',
  'pcie_gen',
  'pcie_width',
  'enc_util_pct',
  'dec_util_pct',
  'throttled',
  'ecc_mode',
  'ecc_corrected_volatile',
  'ecc_uncorrected_volatile',
  'ecc_corrected_aggregate',
  'ecc_uncorrected_aggregate',
];
export const GPU_CSV_HEADER_FULL = `${GPU_CSV_HEADER},${GPU_FULL_HEADERS.join(',')}`;

function cell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function round(value, digits = 1) {
  if (value == null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function samplesToCsv(samples, { full = false } = {}) {
  const rows = [full ? GPU_CSV_HEADER_FULL : GPU_CSV_HEADER];
  for (const sample of samples) {
    const ts = new Date(sample.t).toISOString();
    for (const gpu of sample.gpus) {
      rows.push(gpuRowToCsv(ts, gpu, { full }));
    }
  }
  return `${rows.join('\n')}\n`;
}

/** 单独一行 GPU 记录，供"按时间区间流式导出"复用（不必先把整段数据读进内存） */
export function gpuRowToCsv(timestampIso, gpu, { full = false } = {}) {
  const base = [
    timestampIso,
    gpu.index,
    cell(gpu.name),
    gpu.memUsedMiB,
    gpu.memTotalMiB,
    round(gpu.memUsedPct, 2),
    round(gpu.utilGpuPct, 1),
    round(gpu.utilMemPct, 1),
    gpu.tempC,
    round(gpu.powerW, 1),
  ];
  if (!full) return base.join(',');
  return [
    ...base,
    round(gpu.clockSmMHz, 0),
    round(gpu.clockMemMHz, 0),
    cell(gpu.pstate),
    round(gpu.fanPct, 0),
    gpu.pcieGen ?? '',
    gpu.pcieWidth ?? '',
    round(gpu.encUtilPct, 1),
    round(gpu.decUtilPct, 1),
    // 节流导出成 0/1：空值表示这次采集没拿到节流信息，与"明确没有节流"区分开
    gpu.throttled == null ? '' : (gpu.throttled ? 1 : 0),
    cell(gpu.eccMode),
    gpu.eccCorrectedVolatile ?? '',
    gpu.eccUncorrectedVolatile ?? '',
    gpu.eccCorrectedAggregate ?? '',
    gpu.eccUncorrectedAggregate ?? '',
  ].join(',');
}

// 宿主指标的导出：一行 = 一个采样点。
// 磁盘只导出第一个挂载点（通常是 / 或系统盘），完整的逐盘明细在 JSON 导出里。
const SYSTEM_HEADERS = [
  'timestamp_iso',
  'cpu_usage_pct',
  'mem_used_mib',
  'mem_total_mib',
  'mem_used_pct',
  'swap_used_mib',
  'swap_total_mib',
  'load_1',
  'load_5',
  'load_15',
  'disk_path',
  'disk_used_mib',
  'disk_total_mib',
  'disk_used_pct',
  'net_rx_bytes_per_sec',
  'net_tx_bytes_per_sec',
];

export const SYSTEM_CSV_HEADER = SYSTEM_HEADERS.join(',');

// 进程事件导出：一行 = 一次"谁在什么时候占上了哪张卡"的留档
const PROCESS_HEADERS = [
  'timestamp_iso',
  'gpu_index',
  'gpu_uuid',
  'pid',
  'name',
  'used_mem_mib',
  'service',
  'user',
];
export const PROCESS_CSV_HEADER = PROCESS_HEADERS.join(',');

/** 单独一行进程事件，供流式导出复用 */
export function processRowToCsv(timestampIso, proc) {
  return [
    timestampIso,
    proc.gpuIndex ?? '',
    cell(proc.gpuUuid),
    proc.pid ?? '',
    cell(proc.name),
    round(proc.usedMemMiB, 1),
    cell(proc.service),
    cell(proc.user),
  ].join(',');
}

/** 单独一行宿主指标，供流式导出复用 */
export function systemRowToCsv(timestampIso, system) {
  // 速率为 0 也要如实导出，所以不能用 `value || ''`
  const rate = (value) => (value == null || !Number.isFinite(value) ? '' : Math.round(value));
  const disk = Array.isArray(system.disk) && system.disk.length ? system.disk[0] : null;
  return [
    timestampIso,
    round(system.cpu?.usagePct, 1),
    round(system.mem?.usedMiB, 1),
    round(system.mem?.totalMiB, 1),
    round(system.mem?.usedPct, 2),
    round(system.swap?.usedMiB, 1),
    round(system.swap?.totalMiB, 1),
    round(system.load?.l1, 2),
    round(system.load?.l5, 2),
    round(system.load?.l15, 2),
    cell(disk?.path),
    round(disk?.usedMiB, 1),
    round(disk?.totalMiB, 1),
    round(disk?.usedPct, 2),
    rate(system.net?.rxBytesPerSec),
    rate(system.net?.txBytesPerSec),
  ].join(',');
}

export function samplesToSystemCsv(samples) {
  const rows = [SYSTEM_CSV_HEADER];
  for (const sample of samples) {
    const system = sample.system;
    // 平台取不到宿主指标时不会有这一行，避免出现一整列空值
    if (!system) continue;
    rows.push(systemRowToCsv(new Date(sample.t).toISOString(), system));
  }
  return `${rows.join('\n')}\n`;
}
