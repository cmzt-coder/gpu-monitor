/**
 * English messages.
 *
 * Key set must stay identical to zh-CN.js — `tools/smoke-test.mjs` asserts both
 * directions (missing keys and stray keys) and that placeholders match per key.
 *
 * Terminology (locked with the project owner):
 *   VRAM / GPU memory, service (container), throttling, idle downclocking,
 *   collect/sample, history database, persist, long/wide layout, snapshot,
 *   suppression, cooldown, rule list, row remapping.
 *
 * Deliberate choices:
 *   - `kpi.*.unit` are empty: Chinese has measure words (张 / 个), English does not.
 *     CSS hides an empty unit span so no stray space shows up.
 *   - Units (GB / MiB / % / °C / W) and the '.' decimal separator never change with
 *     the language, so numbers line up with exported CSV and nvidia-smi output.
 */
export const enUS = {
  /* ---------- page level ---------- */
  'app.title': 'GPU Memory Monitor',
  'app.skipToWork': 'Skip to content',

  /* ---------- header: status pill / export / display mode / language ---------- */
  'status.loading': 'Connecting',
  'export.open': 'Export',
  'nav.group.view': 'Display mode',
  'nav.view.single': 'Single page',
  'nav.view.nav': 'Navigation',
  'nav.group.language': 'Language',

  /* ---------- tabs ---------- */
  'nav.group.pages': 'Page navigation',
  'nav.tab.overview': 'Overview',
  'nav.tab.curve': 'Curves',
  'nav.tab.processes': 'Processes',
  'nav.tab.system': 'System',

  /* ---------- collection error notice ---------- */
  'notice.title': 'Collection error',
  'common.retry': 'Retry',

  /* ---------- alerts panel (frame only; entries and rule list are rendered) ---------- */
  'alerts.title': 'Alerts',

  /* ---------- KPI cards (labels and units only; values are rendered) ---------- */
  'kpi.group.machine': 'Machine overview',
  'kpi.count.label': 'GPUs',
  'kpi.count.unit': '',
  'kpi.mem.label': 'VRAM used / total',
  'kpi.mem.unit': '/',
  'kpi.util.label': 'Average GPU utilization',
  'kpi.temp.label': 'Peak temperature',
  'kpi.proc.label': 'Processes on GPU',
  'kpi.proc.unit': '',

  /* ---------- charts card ---------- */
  'chart.title': 'Curves',
  'chart.group.range': 'Select chart time range',
  'chart.legend.mem': 'VRAM used',
  'chart.legend.util': 'GPU utilization',
  'chart.legend.limit': '90% guard line',

  /* ---------- per-service VRAM chart ---------- */
  'svc.title': 'VRAM by service',
  'svc.canvas.label': 'VRAM usage grouped by service',

  /* ---------- system resources ---------- */
  'sys.title': 'System resources',
  'sys.legend.cpu': 'CPU usage',
  'sys.legend.mem': 'Memory usage',
  'sys.canvas.label': 'Host CPU and memory usage over time',

  /* ---------- processes on GPU ---------- */
  'proc.title': 'Processes using the GPU',
  'proc.group.filter': 'Filter processes by GPU',
  'proc.table.caption': 'Processes currently using GPU memory, filterable by GPU',
  'proc.table.th.gpu': 'GPU',
  'proc.table.th.pid': 'PID',
  'proc.table.th.process': 'Process',
  'proc.table.th.service': 'Service',
  'proc.table.th.mem': 'VRAM',
  'proc.table.th.share': 'Share of card',
  'proc.empty.title': 'No process is using GPU memory',

  /* ---------- process history ---------- */
  'procHist.title': 'Process history',
  'procHist.group.range': 'Select history time range',
  'procHist.group.min': 'Only show processes above',
  'procHist.table.caption': 'Process memory history, newest first',
  'procHist.table.th.time': 'Time',
  'procHist.table.th.mem': 'VRAM',
  'procHist.more': 'Load more',

  /* ---------- right column: per-GPU usage / collection info ---------- */
  'aside.group': 'Current usage and collection info',
  'cards.title': 'Usage per GPU',
  'meta.title': 'Collection info',

  /* ---------- export dialog (frame only; options and hints are rendered) ---------- */
  'export.title': 'Export data',
  'export.close': 'Close',
  'export.group.content': 'Content',
  'export.group.layout': 'Layout',
  'export.group.range': 'Time range',
  'export.layout.group': 'Select table layout',
  'export.range.group': 'Select time range',
  'export.full.label': 'Include extended metrics (clocks / P-State / fan / PCIe / encoder / throttling / ECC)',
  'export.cancel': 'Cancel',
  'export.confirm': 'Download',
};
