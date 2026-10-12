// 把内存中的采样窗口导出为 CSV（每张卡每一刻的显存与利用率原始数据）
const HEADERS = [
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

export function samplesToCsv(samples) {
  const rows = [HEADERS.join(',')];
  for (const sample of samples) {
    const ts = new Date(sample.t).toISOString();
    for (const gpu of sample.gpus) {
      rows.push([
        ts,
        gpu.index,
        cell(gpu.name),
        gpu.memUsedMiB,
        gpu.memTotalMiB,
        round(gpu.memUsedPct, 2),
        round(gpu.utilGpuPct, 1),
        round(gpu.utilMemPct, 1),
        gpu.tempC,
        round(gpu.powerW, 1),
      ].join(','));
    }
  }
  return `${rows.join('\n')}\n`;
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

export function samplesToSystemCsv(samples) {
  const rows = [SYSTEM_HEADERS.join(',')];
  // 速率为 0 也要如实导出，所以不能用 `value || ''`
  const rate = (value) => (value == null || !Number.isFinite(value) ? '' : Math.round(value));
  for (const sample of samples) {
    const system = sample.system;
    // 平台取不到宿主指标时不会有这一行，避免出现一整列空值
    if (!system) continue;
    const disk = Array.isArray(system.disk) && system.disk.length ? system.disk[0] : null;
    rows.push([
      new Date(sample.t).toISOString(),
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
    ].join(','));
  }
  return `${rows.join('\n')}\n`;
}
