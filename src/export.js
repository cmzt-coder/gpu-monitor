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
