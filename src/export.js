// 把内存中的采样窗口导出为 CSV（每张卡每一刻的显存与利用率原始数据）
//
// 时间有两列，不是一个失误：
//   time_local     2026-10-14 14:25:03   服务器本地时间，Excel / pandas 直接认成日期时间
//   timestamp_iso  2026-10-14T06:25:03.000Z   UTC，机器读、跨时区对齐用
// 只给 UTC 的话，用 Excel 打开会看到比墙上时钟早 8 小时（东八区），像数据错了一样；
// 只给本地时间的话，又丢了时区信息，换台机器或改时区后老文件没法解释。

/** 服务器时区（IANA 名）。导出说"本地时间"时指的就是它 */
export function serverTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// 每行都要格式化时间，几百万行时反复 new Intl.DateTimeFormat 会明显拖慢导出，
// 所以按时区缓存住。同一个导出只会用到同一个时区，缓存命中率是 100%
const localFormatCache = new Map();

function localFormatter(timeZone) {
  let formatter = localFormatCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      // 用 h23 而不是 hour12:false：后者在部分 ICU 版本里会把午夜给成 24:00:00
      hourCycle: 'h23',
    });
    localFormatCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * 毫秒时间戳 → 导出用的两个时间字符串。
 *
 * sv-SE 的输出正好是 `YYYY-MM-DD HH:MM:SS`，这是 Excel 与 pandas 都直接认的写法；
 * ISO 8601 带 T 和 Z 的写法 Excel 只会当普通文本，还容易被误读成 UTC。
 */
export function formatTimestamp(ms, { timeZone } = {}) {
  const zone = timeZone || serverTimeZone();
  return {
    // 个别时区/ICU 组合会吐不换行空格，统一成普通空格，免得下游按空格切列时切不开
    local: localFormatter(zone).format(ms).replace(/\s+/g, ' '),
    iso: new Date(ms).toISOString(),
  };
}

const GPU_HEADERS = [
  'time_local',
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
    for (const gpu of sample.gpus) {
      rows.push(gpuRowToCsv(sample.t, gpu, { full }));
    }
  }
  return `${rows.join('\n')}\n`;
}

/** 单独一行 GPU 记录，供"按时间区间流式导出"复用（不必先把整段数据读进内存） */
export function gpuRowToCsv(ts, gpu, { full = false } = {}) {
  const { local, iso } = formatTimestamp(ts);
  const base = [
    local,
    iso,
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
  'time_local',
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
  'time_local',
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
export function processRowToCsv(ts, proc) {
  const { local, iso } = formatTimestamp(ts);
  return [
    local,
    iso,
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
export function systemRowToCsv(ts, system) {
  const { local, iso } = formatTimestamp(ts);
  // 速率为 0 也要如实导出，所以不能用 `value || ''`
  const rate = (value) => (value == null || !Number.isFinite(value) ? '' : Math.round(value));
  const disk = Array.isArray(system.disk) && system.disk.length ? system.disk[0] : null;
  return [
    local,
    iso,
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
    rows.push(systemRowToCsv(sample.t, system));
  }
  return `${rows.join('\n')}\n`;
}
