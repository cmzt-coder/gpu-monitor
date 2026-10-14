// GPU 显存负载监控前端：轮询 /api/state，自行维护内存中的实时窗口并画曲线
const $ = (id) => document.getElementById(id);

const refs = {
  orientSub: $('orient-sub'),
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  notice: $('notice'),
  noticeTitle: $('notice-title'),
  noticeText: $('notice-text'),
  noticeHint: $('notice-hint'),
  noticeCode: $('notice-code'),
  alerts: $('alerts'),
  alertsTitle: $('alerts-title'),
  alertsBadge: $('alerts-badge'),
  alertsStatus: $('alerts-status'),
  alertsList: $('alerts-list'),
  alertsEmpty: $('alerts-empty'),
  alertsRules: $('alerts-rules'),
  alertsRulesSummary: $('alerts-rules-summary'),
  alertsRuleList: $('alerts-rule-list'),
  btnRetry: $('btn-retry'),
  btnRefresh: $('btn-refresh'),
  btnCsv: $('btn-csv'),
  btnJson: $('btn-json'),
  btnSysCsv: $('btn-sys-csv'),
  btnCsvFull: $('btn-csv-full'),
  kpiCount: $('kpi-count'),
  kpiCountFoot: $('kpi-count-foot'),
  kpiMem: $('kpi-mem'),
  kpiMemFill: $('kpi-mem-fill'),
  kpiMemFoot: $('kpi-mem-foot'),
  kpiUtil: $('kpi-util'),
  kpiUtilFoot: $('kpi-util-foot'),
  kpiTemp: $('kpi-temp'),
  kpiTempFoot: $('kpi-temp-foot'),
  kpiProc: $('kpi-proc'),
  kpiProcFoot: $('kpi-proc-foot'),
  charts: $('charts'),
  chartsEmpty: $('charts-empty'),
  chartsSub: $('charts-sub'),
  rangePicker: $('range-picker'),
  emptyTitle: $('empty-title'),
  emptyText: $('empty-text'),
  sysSub: $('sys-sub'),
  sysMeters: $('sys-meters'),
  sysChartWrap: $('sys-chart-wrap'),
  sysCanvas: $('sys-canvas'),
  sysDetail: $('sys-detail'),
  sysEmpty: $('sys-empty'),
  sysEmptyTitle: $('sys-empty-title'),
  sysEmptyText: $('sys-empty-text'),
  procSub: $('proc-sub'),
  procFilter: $('proc-filter'),
  procTableWrap: $('proc-table-wrap'),
  procBody: $('proc-body'),
  procEmpty: $('proc-empty'),
  procEmptyText: $('proc-empty-text'),
  procHistSub: $('proc-hist-sub'),
  procHistRange: $('proc-hist-range'),
  procHistWrap: $('proc-hist-wrap'),
  procHistBody: $('proc-hist-body'),
  procHistEmpty: $('proc-hist-empty'),
  procHistEmptyTitle: $('proc-hist-empty-title'),
  procHistEmptyText: $('proc-hist-empty-text'),
  gpuCards: $('gpu-cards'),
  metaList: $('meta-list'),
  footerText: $('footer-text'),
};

const state = {
  intervalMs: 1000,
  windowSamples: 300,
  status: 'loading',
  gpus: [],
  processes: [],
  filter: 'all',
  series: new Map(),
  systemSeries: { t: [], cpu: [], mem: [] },
  chartNodes: new Map(),
  chartSignature: '',
  cardNodes: new Map(),
  cardSignature: '',
  lastSampleAt: null,
  fetchedAt: null,
  consecutiveErrors: 0,
  pushActive: false,
  // 曲线时间范围：live = 实时窗口，其它值是历史区间（也直接决定导出的范围）
  range: 'live',
  historyPoints: null,
  historyStep: null,
  historyTruncated: false,
  historyNotice: null,
  // 进程占用历史：与曲线的时间范围互相独立（曲线可能停在实时，这里仍想看一天）
  processHistory: {
    range: '24h',
    rows: [],
    total: 0,
    loading: false,
    notice: null,
  },
  stopped: false,
};

const RANGES = [
  { value: 'live', label: '实时' },
  { value: '3d', label: '3 天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: '60d', label: '60 天' },
  { value: '90d', label: '90 天' },
  { value: 'all', label: '全部' },
];

const PROC_HIST_RANGES = [
  { value: '1h', label: '1 小时' },
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
];
const PROC_HIST_LIMIT = 200;

let eventSource = null;
let pollTimer = null;
let pushRetryTimer = null;
let pushFailures = 0;

const HIGH_THRESHOLD = 90;
const TEMP_WARN = 75;
const TEMP_DANGER = 85;

// 节流原因的中文名与告警级别（gpuIdle 只是"显卡空闲"，不是故障）
const THROTTLE_LABELS = {
  swPowerCap: { text: '功耗墙', tone: 'warning' },
  hwSlowdown: { text: '硬件降速', tone: 'danger' },
  hwThermal: { text: '温度墙', tone: 'danger' },
  hwPowerBrake: { text: '功耗刹车', tone: 'danger' },
  swThermal: { text: '软件温度墙', tone: 'warning' },
  gpuIdle: { text: '空闲', tone: null },
};

const SYSTEM_FIELD_LABELS = {
  cpu: 'CPU',
  mem: '内存',
  swap: '交换分区',
  load: '系统负载',
  disk: '磁盘',
  net: '网络',
};

/* ---------- 格式化 ---------- */
const toGiB = (mib) => (mib == null ? null : mib / 1024);

function fmtGiB(mib, digits = 1) {
  const value = toGiB(mib);
  return value == null ? '--' : `${value.toFixed(digits)} GB`;
}

function fmtMiB(mib) {
  if (mib == null) return '--';
  return mib >= 1024 ? `${(mib / 1024).toFixed(2)} GB` : `${Math.round(mib)} MiB`;
}

function fmtPct(value, digits = 0) {
  return value == null ? '--' : `${value.toFixed(digits)}%`;
}

function fmtRate(bytesPerSec) {
  if (bytesPerSec == null) return '--';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSec;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function fmtBytes(bytes) {
  if (bytes == null) return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function fmtDateTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 进程事件可能密集发生在同一分钟里，精确到秒才分得清先后
function fmtDateTimeFull(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtClock(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtRelative(ts) {
  if (!ts) return '--';
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 2) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}

function fmtDuration(seconds) {
  if (seconds == null) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

function gpuKey(gpu) {
  return gpu.uuid || `index-${gpu.index}`;
}

function toneFor(pct) {
  if (pct == null) return null;
  if (pct >= HIGH_THRESHOLD) return 'danger';
  if (pct >= 75) return 'warning';
  return null;
}

function tempTone(temp) {
  if (temp == null) return null;
  if (temp >= TEMP_DANGER) return 'danger';
  if (temp >= TEMP_WARN) return 'warning';
  return null;
}

/* ---------- 数据接入 ---------- */
function trimToWindow(list) {
  const overflow = list.t.length - state.windowSamples;
  if (overflow > 0) list.t.splice(0, overflow);
  return overflow;
}

function appendSample(sample, { force = false } = {}) {
  if (sample.t) state.lastSampleAt = sample.t;
  // 历史模式下曲线由区间数据决定，不再叠加实时采样点（否则两种时间尺度会混在一起）
  if (!force && state.range !== 'live') return;

  const seen = new Set();
  for (const gpu of sample.gpus || []) {
    const key = gpuKey(gpu);
    seen.add(key);
    let series = state.series.get(key);
    if (!series) {
      series = { t: [], mem: [], util: [] };
      state.series.set(key, series);
    }
    series.t.push(sample.t);
    series.mem.push(gpu.memUsedPct ?? 0);
    series.util.push(gpu.utilGpuPct ?? 0);
    const overflow = trimToWindow(series);
    if (overflow > 0) {
      series.mem.splice(0, overflow);
      series.util.splice(0, overflow);
    }
  }
  // 不再出现的卡（热插拔/掉卡）清掉，避免曲线残留
  for (const key of [...state.series.keys()]) {
    if (!seen.has(key)) state.series.delete(key);
  }
  // 宿主指标与 GPU 曲线共用同一条时间轴；取不到的行留 null，画图时断开
  if (sample.system) {
    const series = state.systemSeries;
    series.t.push(sample.t);
    series.cpu.push(sample.system.cpu?.usagePct ?? null);
    series.mem.push(sample.system.mem?.usedPct ?? null);
    const overflow = trimToWindow(series);
    if (overflow > 0) {
      series.cpu.splice(0, overflow);
      series.mem.splice(0, overflow);
    }
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** 轮询与 SSE 推送共用同一套状态落地逻辑，两条通道的数据结构完全一致 */
function applyState(data) {
  state.fetchedAt = Date.now();
  state.consecutiveErrors = 0;
  state.status = data.status;
  state.intervalMs = data.intervalMs || state.intervalMs;
  state.windowSamples = data.windowSamples || state.windowSamples;
  state.gpus = data.gpus || [];
  state.processes = data.processes || [];
  state.meta = data;
  if (state.gpus.length > 0 || data.system) {
    appendSample({ t: data.ts || Date.now(), gpus: state.gpus, system: data.system });
  }
  render();
}

async function poll() {
  try {
    applyState(await fetchJson('/api/state'));
  } catch (error) {
    state.consecutiveErrors += 1;
    state.status = 'unreachable';
    state.meta = { ...(state.meta || {}), error: `无法连接采集服务（${error.message}）` };
    render();
  }
}

/* ---------- 数据通道：优先 SSE 推送，不可用时自动退回轮询 ---------- */
function stopPolling() {
  if (pollTimer) window.clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePolling() {
  if (state.stopped || pollTimer || state.pushActive) return;
  const tick = async () => {
    pollTimer = null;
    if (!document.hidden) await poll();
    if (!state.stopped && !state.pushActive) {
      pollTimer = window.setTimeout(tick, Math.max(400, state.intervalMs));
    }
  };
  pollTimer = window.setTimeout(tick, Math.max(400, state.intervalMs));
}

function closePush() {
  try {
    eventSource?.close();
  } catch {
    // 已经断开就无所谓了
  }
  eventSource = null;
  state.pushActive = false;
}

function startPush() {
  if (state.stopped) return;
  if (typeof EventSource === 'undefined') {
    schedulePolling();
    return;
  }
  try {
    eventSource = new EventSource('/api/stream');
  } catch {
    eventSource = null;
    schedulePolling();
    return;
  }

  eventSource.onopen = () => {
    pushFailures = 0;
    state.pushActive = true;
    stopPolling();
    render();
  };
  eventSource.onmessage = (event) => {
    try {
      applyState(JSON.parse(event.data));
    } catch {
      // 坏帧直接跳过，等下一帧
    }
  };
  eventSource.onerror = () => {
    const wasActive = state.pushActive;
    state.pushActive = false;
    pushFailures += 1;
    // 推送断掉时先用轮询兜住，保证数据不断档；浏览器自身的重连不必干预
    schedulePolling();
    if (!wasActive && pushFailures >= 3) {
      // 从来没连上过（比如服务端 --no-push 或反代不支持），别再每 3 秒重试
      closePush();
      if (!pushRetryTimer) {
        pushRetryTimer = window.setTimeout(() => {
          pushRetryTimer = null;
          pushFailures = 0;
          startPush();
        }, 600000);
      }
    }
    render();
  };
}

/* ---------- 渲染：状态与提示 ---------- */
function renderStatus() {
  const map = {
    live: ['live', '实时采集中'],
    ok: ['live', '实时采集中'],
    loading: ['loading', '连接中'],
    starting: ['loading', '服务启动中'],
    empty: ['empty', '未检测到 GPU'],
    error: ['error', '采集失败'],
    unreachable: ['error', '连接中断'],
  };
  let [tone, text] = map[state.status] || ['loading', '连接中'];
  const stale = state.status === 'error' || state.status === 'unreachable';
  // 空闲降频时明确告诉用户"数据还是在采，只是慢了"，避免误以为服务卡住
  if (!stale && tone === 'live' && state.meta?.idle?.active) {
    text = `空闲降频中（每 ${Math.round((state.meta.idle.currentIntervalMs || 0) / 1000)} 秒）`;
  }
  refs.statusPill.dataset.state = tone;
  refs.statusText.textContent = stale && state.lastSampleAt
    ? `${text} · 数据停留在 ${fmtRelative(state.lastSampleAt)}`
    : text;
}

function showNotice({ title, text, hint }) {
  refs.noticeTitle.textContent = title;
  refs.noticeText.textContent = text;
  if (hint) {
    refs.noticeHint.hidden = false;
    refs.noticeCode.textContent = hint;
  } else {
    refs.noticeHint.hidden = true;
  }
  refs.notice.hidden = false;
}

function renderNotice(meta) {
  const noGpu = meta && meta.status === 'ok' && state.gpus.length === 0;
  if (state.status === 'unreachable') {
    showNotice({
      title: '无法连接采集服务',
      text: '页面会持续重试；如果长时间没有恢复，请确认采集进程是否还在运行。',
      hint: 'curl -s http://localhost:' + (location.port || '8080') + '/api/state | head',
    });
    return;
  }
  if (state.status === 'error') {
    const platform = meta?.platform || {};
    const unsupported = platform.supported === false;
    showNotice({
      title: unsupported ? `当前平台无法监控显存（${platform.label || '未知系统'}）` : '采集失败：读不到 nvidia-smi 数据',
      text: [meta?.error, meta?.hint].filter(Boolean).join('　·　') || '未知错误',
      hint: unsupported ? null : 'nvidia-smi -L',
    });
    return;
  }
  if (noGpu) {
    showNotice({
      title: '没有检测到 GPU',
      text: 'nvidia-smi 执行成功但没有返回显卡。请确认采集服务运行在有显卡的机器上。',
      hint: 'nvidia-smi -L',
    });
    return;
  }
  refs.notice.hidden = true;
}

/* ---------- 渲染：告警 ---------- */
const ALERT_LEVEL_LABELS = { critical: '严重', warning: '警告' };

// 判定时长：秒级写秒、分钟级写分钟，避免出现"240 秒"这种要心算的写法
function fmtForMs(ms) {
  if (!(ms > 0)) return '';
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒`;
  const minutes = ms / 60000;
  if (minutes < 60) return `${Math.round(minutes * 10) / 10} 分钟`;
  return `${Math.round((minutes / 60) * 10) / 10} 小时`;
}

// 阈值按单位渲染：显存类走 GiB/MiB，布尔量走"是/否"
function fmtThreshold(rule) {
  if (rule.isBoolean) return rule.threshold ? '是' : '否';
  if (rule.threshold == null) return '--';
  if (rule.unit === 'MiB') {
    return rule.threshold >= 1024
      ? `${(rule.threshold / 1024).toFixed(2)} GiB`
      : `${Math.round(rule.threshold)} MiB`;
  }
  return `${Math.round(rule.threshold * 10) / 10}${rule.unit || ''}`;
}

// "vllm-embed 显存过高：服务显存 >= 12.00 GiB，只看 vllm-embed，持续 4 分钟"
function describeRule(rule) {
  const parts = [];
  // 规则自己起了名字时，条件里要写出指标名，否则"显存过高"没说清盯的是哪个指标
  const subject = rule.label === rule.metricLabel ? '' : `${rule.metricLabel} `;
  parts.push(`${subject}${rule.op} ${fmtThreshold(rule)}`);
  if (rule.service) parts.push(`只看 ${rule.service}`);
  parts.push(rule.effectiveForMs > 0 ? `持续 ${fmtForMs(rule.effectiveForMs)}` : '单点即报');
  if (rule.clamped) parts.push(`原设定 ${fmtForMs(rule.forMs)}，无历史库改按窗口判定`);
  return parts.join('，');
}

function renderAlerts(meta) {
  const alerts = meta?.alerts;
  const firing = alerts?.firing || [];
  const rules = alerts?.rules || [];
  // 一条规则都没装上时保持安静；一旦配了规则就始终显示——
  // "0 条触发"不该等于"页面上完全看不到告警功能还在不在"
  if (!alerts || !alerts.enabled) {
    refs.alerts.hidden = true;
    refs.alertsList.replaceChildren();
    refs.alertsRuleList.replaceChildren();
    refs.alertsTitle.textContent = '告警';
    return;
  }
  refs.alerts.hidden = false;
  // 面板常驻，但只有真触发时才该整块泛黄；"没事"要看起来像没事
  refs.alerts.dataset.state = firing.length ? 'firing' : 'idle';
  refs.alertsTitle.textContent = firing.length ? `当前告警（${firing.length}）` : '告警';

  // dry-run 必须一眼可见：只打印不发送时，页面看着"配好了"最容易误判
  const badges = [];
  if (alerts.dryRun) badges.push('dry-run：只打印不发送');
  if (alerts.problems?.length) badges.push(`${alerts.problems.length} 条规则被跳过`);
  if (alerts.warnings?.length) badges.push(`${alerts.warnings.length} 条规则阈值可疑`);
  if (alerts.lastReloadError) badges.push('配置有误，仍在用上一次的规则');
  refs.alertsBadge.textContent = badges.join(' · ');
  refs.alertsBadge.hidden = badges.length === 0;

  const summary = [`${alerts.ruleCount} 条规则监控中`];
  if (alerts.cooldownMs) summary.push(`抑制 ${Math.round(alerts.cooldownMs / 60000)} 分钟`);
  summary.push(alerts.autoReload ? '改动自动生效' : '改动需重启');
  if (alerts.lastCheckAt) summary.push(`检查于 ${fmtClock(alerts.lastCheckAt)}`);
  if (alerts.notifiedCount) summary.push(`已通知 ${alerts.notifiedCount} 次`);
  refs.alertsStatus.textContent = summary.join(' · ');

  refs.alertsEmpty.hidden = firing.length > 0;
  refs.alertsEmpty.textContent = `当前无告警，${rules.length || alerts.ruleCount} 条规则未触发`;

  refs.alertsList.replaceChildren();
  for (const alert of firing) {
    const item = document.createElement('li');
    item.className = 'alerts__item';
    const level = document.createElement('span');
    level.className = 'alerts__level';
    level.dataset.level = alert.level;
    level.textContent = ALERT_LEVEL_LABELS[alert.level] || alert.level;
    const detail = document.createElement('span');
    detail.className = 'alerts__detail';
    detail.textContent = alert.detail;
    const since = document.createElement('span');
    since.className = 'alerts__since';
    since.textContent = alert.since ? `自 ${fmtRelative(alert.since)}` : '';
    item.append(level, detail, since);
    refs.alertsList.appendChild(item);
  }

  // 规则清单：确认"到底在盯什么"。零触发时这是页面上唯一能看出告警正常工作的东西。
  refs.alertsRules.hidden = rules.length === 0;
  refs.alertsRulesSummary.textContent = `规则清单（${rules.length}）`;
  refs.alertsRuleList.replaceChildren();
  const ruleNotes = new Map();
  for (const item of alerts.warnings || []) {
    if (!ruleNotes.has(item.ruleId)) ruleNotes.set(item.ruleId, []);
    ruleNotes.get(item.ruleId).push(item.message);
  }
  for (const rule of rules) {
    const item = document.createElement('li');
    item.className = 'alerts__rule';
    item.dataset.state = rule.firingCount > 0 ? 'firing' : 'normal';
    const level = document.createElement('span');
    level.className = 'alerts__level';
    level.dataset.level = rule.level;
    level.textContent = ALERT_LEVEL_LABELS[rule.level] || rule.level;
    const text = document.createElement('span');
    text.className = 'alerts__rule-text';
    const name = document.createElement('b');
    name.textContent = rule.label;
    const condition = document.createElement('span');
    condition.className = 'alerts__rule-cond';
    // 规则名就是指标名时不加冒号：读起来就是"显存占用率 >= 85%，持续 4 分钟"一句完整的话
    condition.textContent = rule.label === rule.metricLabel
      ? ` ${describeRule(rule)}`
      : `：${describeRule(rule)}`;
    text.append(name, condition);
    const state = document.createElement('span');
    state.className = 'alerts__rule-state';
    state.dataset.state = rule.firingCount > 0 ? 'firing' : 'normal';
    if (rule.firingCount > 0) {
      state.textContent = rule.targets?.length
        ? `触发中：${rule.targets.join('、')}`
        : `触发中（${rule.firingCount}）`;
    } else {
      state.textContent = '正常';
    }
    item.append(level, text, state);
    // 阈值顺序反了照常判定，但得让人看见，否则真出事时只会收到警告那条
    for (const note of ruleNotes.get(rule.id) || []) {
      const warn = document.createElement('span');
      warn.className = 'alerts__rule-note';
      warn.textContent = `⚠ ${note}`;
      item.append(warn);
    }
    refs.alertsRuleList.appendChild(item);
  }
}

/* ---------- 渲染：KPI ---------- */
function renderKpis() {
  const gpus = state.gpus;
  const totalMem = gpus.reduce((sum, gpu) => sum + (gpu.memTotalMiB || 0), 0);
  const usedMem = gpus.reduce((sum, gpu) => sum + (gpu.memUsedMiB || 0), 0);
  const usedPct = totalMem > 0 ? (usedMem / totalMem) * 100 : null;
  const utils = gpus.map((gpu) => gpu.utilGpuPct).filter((v) => v != null);
  const temps = gpus.map((gpu) => gpu.tempC).filter((v) => v != null);

  refs.kpiCount.innerHTML = gpus.length
    ? `${gpus.length}<span class="kpi__unit">张</span>`
    : '--';
  refs.kpiCountFoot.textContent = gpus.length ? `主机 ${state.meta?.hostname || '--'}` : '等待采集';

  refs.kpiMem.innerHTML = gpus.length
    ? `${(toGiB(usedMem) || 0).toFixed(0)}<span class="kpi__unit">/ ${(toGiB(totalMem) || 0).toFixed(0)} GB</span>`
    : '--<span class="kpi__unit">/ --</span>';
  refs.kpiMemFill.style.width = usedPct == null ? '0%' : `${Math.min(100, usedPct).toFixed(1)}%`;
  refs.kpiMemFill.dataset.tone = toneFor(usedPct) || '';
  refs.kpiMemFoot.textContent = usedPct == null ? '占用率 --' : `整机占用率 ${usedPct.toFixed(1)}%`;
  refs.kpiMemFoot.dataset.tone = toneFor(usedPct) || '';

  const avgUtil = utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : null;
  refs.kpiUtil.innerHTML = avgUtil == null
    ? '--<span class="kpi__unit">%</span>'
    : `${avgUtil.toFixed(0)}<span class="kpi__unit">%</span>`;
  refs.kpiUtilFoot.textContent = avgUtil == null ? '等待采集' : `按 ${utils.length} 张卡平均`;

  const maxTemp = temps.length ? Math.max(...temps) : null;
  refs.kpiTemp.innerHTML = maxTemp == null
    ? '--<span class="kpi__unit">°C</span>'
    : `${Math.round(maxTemp)}<span class="kpi__unit">°C</span>`;
  refs.kpiTempFoot.textContent = maxTemp == null
    ? '等待采集'
    : `最高温度来自 GPU ${gpus.find((gpu) => gpu.tempC === maxTemp)?.index ?? '--'}`;
  refs.kpiTempFoot.dataset.tone = tempTone(maxTemp) || '';

  const procCount = state.processes.length;
  refs.kpiProc.innerHTML = state.meta?.status === 'ok'
    ? `${procCount}<span class="kpi__unit">个</span>`
    : '--<span class="kpi__unit">个</span>';
  const procMem = state.processes.reduce((sum, proc) => sum + (proc.usedMemMiB || 0), 0);
  refs.kpiProcFoot.textContent = state.meta?.status === 'ok'
    ? `合计占用 ${fmtGiB(procMem)}`
    : '等待采集';
}

/* ---------- 渲染：曲线 ---------- */
function rangeLabel() {
  if (state.range === 'live') return '实时窗口';
  const item = RANGES.find((entry) => entry.value === state.range);
  return `历史区间 ${item?.label || state.range}`;
}

function describeRange() {
  if (state.range === 'live') {
    return `最近 ${Math.round(state.windowSamples * state.intervalMs / 1000)} 秒的实时窗口`;
  }
  const item = RANGES.find((entry) => entry.value === state.range);
  const label = item?.label || state.range;
  // 曲线切到历史区间时，顶部指标、右侧卡片和系统资源里的读数是"现在"的，
  // 不写清楚很容易把两种时间尺度混着看
  const liveNote = '　·　其余卡片与顶部指标仍是当前实时值';
  if (state.historyNotice) return `${label}：${state.historyNotice}`;
  if (!state.historyPoints) return `${label}：这段时间没有数据`;
  const stepText = state.historyStep > 0 ? `，每 ${Math.round(state.historyStep / 1000)} 秒一点` : '';
  return `历史区间：最近 ${label}，共 ${state.historyPoints} 个点${stepText}${state.historyTruncated ? '（已截断）' : ''}${liveNote}`;
}

function chartSlots() {
  if (state.range === 'live') return state.windowSamples;
  return Math.max(2, state.historyPoints || state.windowSamples);
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function themeColors() {
  return {
    primary: cssVar('--jf-color-primary', '#005bac'),
    signal: cssVar('--jf-color-signal', '#00a0e3'),
    danger: cssVar('--jf-color-danger', '#cd412d'),
    border: cssVar('--jf-color-border', '#d3d7d9'),
    muted: cssVar('--jf-color-ink-muted', '#546c7d'),
  };
}

/**
 * 画一组 0-100% 的折线。
 * series 里每一项是 { values, color, width, fill }；values 里的 null 表示这一段没有数据，
 * 折线会断开、面积也不会跨越空洞——宿主指标在部分平台上取不到时就是这个样子。
 */
function drawLines(canvas, seriesList, windowSamples, { limit = null, times = [] } = {}) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width < 40 || height < 40) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const colors = themeColors();
  const pad = { top: 10, right: 44, bottom: 18, left: 6 };
  const plotW = Math.max(10, width - pad.left - pad.right);
  const plotH = Math.max(10, height - pad.top - pad.bottom);
  const slots = Math.max(2, windowSamples);

  ctx.font = '11px ' + cssVar('--jf-font-body', 'sans-serif');
  ctx.lineWidth = 1;

  for (const value of [0, 25, 50, 75, 100]) {
    const y = pad.top + plotH * (1 - value / 100);
    ctx.strokeStyle = colors.border;
    ctx.beginPath();
    ctx.moveTo(pad.left, Math.round(y) + 0.5);
    ctx.lineTo(pad.left + plotW, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${value}%`, pad.left + plotW + 8, y);
  }

  const count = seriesList[0]?.values.length || 0;
  const xAt = (i) => pad.left + plotW * (1 - (count - 1 - i) / (slots - 1));
  const yAt = (value) => pad.top + plotH * (1 - Math.min(100, Math.max(0, value)) / 100);

  for (const line of seriesList) {
    const values = line.values;

    if (line.fill && count >= 2) {
      const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
      gradient.addColorStop(0, 'rgba(0, 91, 172, 0.20)');
      gradient.addColorStop(1, 'rgba(0, 91, 172, 0.02)');
      // 按连续的非空段分别填充，避免面积跨过没有数据的区间
      let start = -1;
      for (let i = 0; i <= count; i += 1) {
        const valid = i < count && values[i] != null;
        if (valid && start < 0) start = i;
        if (!valid && start >= 0) {
          const end = i - 1;
          if (end > start) {
            ctx.beginPath();
            ctx.moveTo(xAt(start), yAt(values[start]));
            for (let k = start + 1; k <= end; k += 1) ctx.lineTo(xAt(k), yAt(values[k]));
            ctx.lineTo(xAt(end), pad.top + plotH);
            ctx.lineTo(xAt(start), pad.top + plotH);
            ctx.closePath();
            ctx.fillStyle = gradient;
            ctx.fill();
          }
          start = -1;
        }
      }
    }

    if (count >= 2) {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.width || 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let drawing = false;
      for (let i = 0; i < count; i += 1) {
        const value = values[i];
        if (value == null) {
          drawing = false;
          continue;
        }
        if (drawing) ctx.lineTo(xAt(i), yAt(value));
        else {
          ctx.moveTo(xAt(i), yAt(value));
          drawing = true;
        }
      }
      ctx.stroke();

      for (let i = count - 1; i >= 0; i -= 1) {
        if (values[i] == null) continue;
        ctx.beginPath();
        ctx.arc(xAt(i), yAt(values[i]), 3, 0, Math.PI * 2);
        ctx.fillStyle = line.color;
        ctx.fill();
        break;
      }
    }
  }

  if (limit != null) {
    const limitY = yAt(limit);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = colors.danger;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, Math.round(limitY) + 0.5);
    ctx.lineTo(pad.left + plotW, Math.round(limitY) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  ctx.fillStyle = colors.muted;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(count > 0 && times[0] ? fmtClock(times[0]) : '--:--:--', pad.left, pad.top + plotH + 5);
  ctx.textAlign = 'right';
  ctx.fillText('现在', pad.left + plotW, pad.top + plotH + 5);
}

function renderCharts() {
  const gpus = state.gpus;
  refs.chartsSub.textContent = describeRange();
  refs.chartsEmpty.hidden = gpus.length > 0;
  if (gpus.length === 0) {
    if (state.chartNodes.size > 0) {
      refs.charts.replaceChildren();
      state.chartNodes.clear();
      state.chartSignature = '';
    }
    if (state.status === 'loading' || state.status === 'starting') {
      refs.emptyTitle.textContent = '正在读取 GPU 数据';
      refs.emptyText.textContent = '服务启动后第一帧数据通常在一两秒内出现。';
    } else if (state.meta?.status === 'ok') {
      refs.emptyTitle.textContent = '没有检测到 GPU';
      refs.emptyText.textContent = 'nvidia-smi 执行成功但返回为空，请确认采集服务运行在有显卡的机器上。';
    } else if (state.meta?.platform?.supported === false) {
      refs.emptyTitle.textContent = '当前平台没有可用的显存数据';
      refs.emptyText.textContent = state.meta.platform.note || '这个平台上没有 NVIDIA 驱动可供读取。';
    } else {
      refs.emptyTitle.textContent = '暂时读不到 GPU 数据';
      refs.emptyText.textContent = '处理完上面的采集异常后，曲线会自动出现。';
    }
    return;
  }

  const colors = themeColors();
  const signature = gpus.map(gpuKey).join('|');
  if (signature !== state.chartSignature) {
    refs.charts.replaceChildren();
    state.chartNodes.clear();
    for (const gpu of gpus) {
      const key = gpuKey(gpu);
      const wrap = document.createElement('article');
      wrap.className = 'chart';

      const head = document.createElement('div');
      head.className = 'chart__head';
      head.innerHTML = `
        <div class="chart__id">
          <span class="chart__badge">GPU ${gpu.index}</span>
          <span class="chart__name"></span>
        </div>
        <div class="chart__stats">
          <span class="chart__stat" data-role="mem"><span>显存</span><b></b></span>
          <span class="chart__stat" data-role="util"><span>利用率</span><b></b></span>
          <span class="chart__stat" data-role="temp"><span>温度</span><b></b></span>
        </div>`;
      head.querySelector('.chart__name').textContent = gpu.name;

      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'chart__canvas-wrap';
      const canvas = document.createElement('canvas');
      canvas.className = 'chart__canvas';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `GPU ${gpu.index} 的显存占用与利用率曲线（${rangeLabel()}）`);
      canvasWrap.appendChild(canvas);

      wrap.append(head, canvasWrap);
      refs.charts.appendChild(wrap);
      state.chartNodes.set(key, { head, canvas });
    }
    state.chartSignature = signature;
  }

  for (const gpu of gpus) {
    const node = state.chartNodes.get(gpuKey(gpu));
    if (!node) continue;
    const series = state.series.get(gpuKey(gpu));
    const memStat = node.head.querySelector('[data-role="mem"]');
    const utilStat = node.head.querySelector('[data-role="util"]');
    const tempStat = node.head.querySelector('[data-role="temp"]');
    memStat.querySelector('b').textContent = `${fmtGiB(gpu.memUsedMiB)} / ${fmtGiB(gpu.memTotalMiB)}（${fmtPct(gpu.memUsedPct, 1)}）`;
    memStat.dataset.tone = toneFor(gpu.memUsedPct) || '';
    utilStat.querySelector('b').textContent = fmtPct(gpu.utilGpuPct, 0);
    tempStat.querySelector('b').textContent = gpu.tempC == null ? '--' : `${Math.round(gpu.tempC)}°C`;
    tempStat.dataset.tone = tempTone(gpu.tempC) || '';
    if (series) {
      drawLines(
        node.canvas,
        [
          { values: series.mem, color: colors.primary, width: 2, fill: true },
          { values: series.util, color: colors.signal, width: 1.5 },
        ],
        chartSlots(),
        { limit: HIGH_THRESHOLD, times: series.t },
      );
    }
  }
}

/* ---------- 渲染：系统资源 ---------- */
function sysMeter({ label, value, foot, pct = null, tone = null, available = true }) {
  const wrap = document.createElement('div');
  wrap.className = 'sys-meter';
  wrap.dataset.available = available ? 'true' : 'false';

  const labelNode = document.createElement('p');
  labelNode.className = 'sys-meter__label';
  labelNode.textContent = label;

  const valueNode = document.createElement('p');
  valueNode.className = 'sys-meter__value';
  valueNode.textContent = value;
  if (tone) valueNode.dataset.tone = tone;

  const meter = document.createElement('div');
  meter.className = 'meter';
  const fill = document.createElement('span');
  fill.className = 'meter__fill';
  fill.style.width = pct == null ? '0%' : `${Math.min(100, pct).toFixed(1)}%`;
  if (tone) fill.dataset.tone = tone;
  meter.appendChild(fill);

  const footNode = document.createElement('p');
  footNode.className = 'sys-meter__foot';
  footNode.textContent = foot;

  wrap.append(labelNode, valueNode, meter, footNode);
  return wrap;
}

function sysDetailRow(label, value) {
  const row = document.createElement('div');
  row.className = 'sys-detail__row';
  const dt = document.createElement('dt');
  dt.className = 'sys-detail__label';
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.className = 'sys-detail__value';
  dd.textContent = value;
  row.append(dt, dd);
  return row;
}

function renderSystemCard() {
  const meta = state.meta || {};
  const enabled = meta.systemEnabled !== false;
  const system = meta.system || null;
  refs.sysMeters.replaceChildren();
  refs.sysDetail.replaceChildren();

  if (!enabled) {
    refs.sysChartWrap.hidden = true;
    refs.sysEmpty.hidden = false;
    refs.sysSub.textContent = '已关闭（--no-system）';
    refs.sysEmptyTitle.textContent = '宿主指标采集已关闭';
    refs.sysEmptyText.textContent = '启动参数带了 --no-system，服务只采集 GPU 指标。去掉该参数并重启即可恢复。';
    return;
  }

  if (!system) {
    refs.sysChartWrap.hidden = true;
    refs.sysEmpty.hidden = false;
    refs.sysSub.textContent = '等待采集';
    refs.sysEmptyTitle.textContent = meta.status === 'ok' ? '还没有宿主指标' : '宿主指标暂不可用';
    refs.sysEmptyText.textContent = meta.systemWarning || '采集服务还没有拿到宿主 CPU / 内存数据，稍后会自动重试。';
    return;
  }

  refs.sysEmpty.hidden = true;
  refs.sysChartWrap.hidden = false;

  const cpu = system.cpu || null;
  const mem = system.mem || null;
  const unsupported = new Set(system.unsupported || []);
  const missing = [...unsupported].map((key) => SYSTEM_FIELD_LABELS[key] || key);
  // 曲线跟着所选区间走，读数是当前值：切到历史区间时标出来，免得两种时间尺度被混着看
  const liveMark = state.range === 'live' ? '' : '（当前）';

  refs.sysSub.textContent = [
    cpu?.cores ? `${cpu.cores} 个逻辑核` : null,
    cpu?.model || null,
    missing.length ? `${missing.join(' / ')} 在当前平台不可用` : null,
    state.range === 'live' ? null : '上方曲线为所选历史区间，下面读数是当前值',
  ].filter(Boolean).join(' · ') || '宿主资源概览';

  refs.sysMeters.appendChild(sysMeter({
    label: `CPU 使用率${liveMark}`,
    value: cpu?.usagePct == null ? '--' : `${cpu.usagePct.toFixed(0)}%`,
    foot: cpu?.usagePct == null ? '首次采样后出现' : `整机平均，共 ${cpu.cores} 个逻辑核`,
    pct: cpu?.usagePct ?? null,
    tone: toneFor(cpu?.usagePct ?? null),
  }));

  refs.sysMeters.appendChild(sysMeter({
    label: `内存使用率${liveMark}`,
    value: mem?.usedPct == null ? '--' : `${mem.usedPct.toFixed(0)}%`,
    foot: mem ? `${fmtGiB(mem.usedMiB)} / ${fmtGiB(mem.totalMiB)}` : '取不到内存数据',
    pct: mem?.usedPct ?? null,
    tone: toneFor(mem?.usedPct ?? null),
  }));

  if (unsupported.has('swap')) {
    refs.sysMeters.appendChild(sysMeter({
      label: `交换分区${liveMark}`,
      value: '平台不支持',
      foot: '这个系统没有可读的交换分区数据源',
      available: false,
    }));
  } else if (system.swap) {
    refs.sysMeters.appendChild(sysMeter({
      label: `交换分区${liveMark}`,
      value: system.swap.usedPct == null ? '--' : `${system.swap.usedPct.toFixed(0)}%`,
      foot: system.swap.totalMiB > 0
        ? `${fmtGiB(system.swap.usedMiB)} / ${fmtGiB(system.swap.totalMiB)}`
        : '未启用交换分区',
      pct: system.swap.usedPct ?? 0,
    }));
  }

  if (system.load) {
    refs.sysDetail.appendChild(sysDetailRow(
      '系统负载',
      `${system.load.l1.toFixed(2)} / ${system.load.l5.toFixed(2)} / ${system.load.l15.toFixed(2)}（1 / 5 / 15 分钟）`,
    ));
  } else if (unsupported.has('load')) {
    refs.sysDetail.appendChild(sysDetailRow('系统负载', '当前平台不支持'));
  }

  for (const disk of system.disk || []) {
    refs.sysDetail.appendChild(sysDetailRow(
      `磁盘 ${disk.path}`,
      `${fmtGiB(disk.usedMiB)} / ${fmtGiB(disk.totalMiB)}（${fmtPct(disk.usedPct, 1)}）`,
    ));
  }

  if (system.net) {
    refs.sysDetail.appendChild(sysDetailRow(
      '网络吞吐',
      `↓ ${fmtRate(system.net.rxBytesPerSec)}　↑ ${fmtRate(system.net.txBytesPerSec)}（${system.net.interfaces} 个网卡）`,
    ));
  } else if (unsupported.has('net')) {
    refs.sysDetail.appendChild(sysDetailRow('网络吞吐', '当前平台不支持'));
  }

  if (system.uptimeSec != null) {
    refs.sysDetail.appendChild(sysDetailRow('系统运行时长', fmtDuration(system.uptimeSec)));
  }
  if (meta.systemWarning) {
    refs.sysDetail.appendChild(sysDetailRow('采集提示', meta.systemWarning));
  }

  const series = state.systemSeries;
  if (series.t.length > 0) {
    drawLines(
      refs.sysCanvas,
      [
        { values: series.mem, color: themeColors().primary, width: 2, fill: true },
        { values: series.cpu, color: themeColors().signal, width: 1.5 },
      ],
      chartSlots(),
      { times: series.t },
    );
  }
}

/* ---------- 渲染：各卡当前占用 ---------- */
function renderThrottleChips(gpu) {
  const wrap = document.createElement('div');
  wrap.className = 'gpu-card__chips';
  if (!gpu.throttle) {
    wrap.appendChild(stateChip('节流状态未知', null));
    return wrap;
  }
  const reasons = Object.entries(gpu.throttle)
    .filter(([, value]) => value === true)
    .map(([key]) => THROTTLE_LABELS[key] || { text: key, tone: 'warning' });

  if (reasons.length === 0) {
    wrap.appendChild(stateChip('无节流', null));
  } else {
    for (const reason of reasons) wrap.appendChild(stateChip(reason.text, reason.tone));
  }
  return wrap;
}

function stateChip(text, tone) {
  const chip = document.createElement('span');
  chip.className = 'state-chip';
  if (tone) chip.dataset.tone = tone;
  const dot = document.createElement('span');
  dot.className = 'state-chip__dot';
  chip.append(dot, document.createTextNode(text));
  return chip;
}

function renderGpuCards() {
  const gpus = state.gpus;
  const signature = gpus.map(gpuKey).join('|');
  if (signature !== state.cardSignature) {
    refs.gpuCards.replaceChildren();
    state.cardNodes.clear();
    for (const gpu of gpus) {
      const card = document.createElement('article');
      card.className = 'gpu-card';
      card.innerHTML = `
        <div class="gpu-card__head">
          <span class="gpu-card__name"></span>
          <span class="gpu-card__index"></span>
        </div>
        <div class="gpu-card__mem">
          <span><b data-role="used"></b> <span data-role="total"></span></span>
          <span class="gpu-card__pct" data-role="pct"></span>
        </div>
        <div class="meter"><span class="meter__fill" data-role="fill" style="width:0%"></span></div>
        <div class="gpu-card__foot">
          <span data-role="util"></span>
          <span data-role="mem-util"></span>
          <span data-role="temp"></span>
          <span data-role="power"></span>
          <span data-role="clock" hidden></span>
          <span data-role="pstate" hidden></span>
          <span data-role="fan" hidden></span>
          <span data-role="encdec" hidden></span>
        </div>
        <div data-role="throttle"></div>`;
      card.querySelector('.gpu-card__name').textContent = gpu.name;
      card.querySelector('.gpu-card__index').textContent = `GPU ${gpu.index}`;
      refs.gpuCards.appendChild(card);
      state.cardNodes.set(gpuKey(gpu), card);
    }
    state.cardSignature = signature;
  }

  for (const gpu of gpus) {
    const card = state.cardNodes.get(gpuKey(gpu));
    if (!card) continue;
    const pct = gpu.memUsedPct;
    card.querySelector('[data-role="used"]').textContent = fmtGiB(gpu.memUsedMiB);
    card.querySelector('[data-role="total"]').textContent = `/ ${fmtGiB(gpu.memTotalMiB)}`;
    const pctNode = card.querySelector('[data-role="pct"]');
    pctNode.textContent = fmtPct(pct, 1);
    pctNode.dataset.tone = toneFor(pct) || '';
    const fill = card.querySelector('[data-role="fill"]');
    fill.style.width = pct == null ? '0%' : `${Math.min(100, pct).toFixed(1)}%`;
    fill.dataset.tone = toneFor(pct) || '';

    card.querySelector('[data-role="util"]').textContent = `GPU 利用率 ${fmtPct(gpu.utilGpuPct, 0)}`;
    card.querySelector('[data-role="mem-util"]').textContent = `显存带宽占用 ${fmtPct(gpu.utilMemPct, 0)}`;
    const tempNode = card.querySelector('[data-role="temp"]');
    tempNode.textContent = gpu.tempC == null ? '温度 --' : `温度 ${Math.round(gpu.tempC)}°C`;
    tempNode.dataset.tone = tempTone(gpu.tempC) || '';
    card.querySelector('[data-role="power"]').textContent = gpu.powerW == null
      ? '功耗 --'
      : `功耗 ${Math.round(gpu.powerW)} W${gpu.powerLimitW == null ? '' : ` / ${Math.round(gpu.powerLimitW)} W`}`;

    // 扩展指标：驱动不支持时整行隐藏，而不是显示一排 "--"
    const clockNode = card.querySelector('[data-role="clock"]');
    const hasClock = gpu.clockSmMHz != null;
    clockNode.hidden = !hasClock;
    if (hasClock) clockNode.textContent = `SM 时钟 ${Math.round(gpu.clockSmMHz)} MHz`;

    const pstateNode = card.querySelector('[data-role="pstate"]');
    pstateNode.hidden = !gpu.pstate;
    if (gpu.pstate) pstateNode.textContent = `P-State ${gpu.pstate}`;

    const fanNode = card.querySelector('[data-role="fan"]');
    fanNode.hidden = gpu.fanPct == null;
    if (gpu.fanPct != null) fanNode.textContent = `风扇 ${Math.round(gpu.fanPct)}%`;

    const encdecNode = card.querySelector('[data-role="encdec"]');
    const hasEncdec = gpu.encUtilPct != null || gpu.decUtilPct != null;
    encdecNode.hidden = !hasEncdec;
    if (hasEncdec) encdecNode.textContent = `编解码 ${fmtPct(gpu.encUtilPct, 0)} / ${fmtPct(gpu.decUtilPct, 0)}`;

    card.querySelector('[data-role="throttle"]').replaceChildren(renderThrottleChips(gpu));
  }
}

/* ---------- 渲染：进程表与过滤 ---------- */
function renderProcFilter() {
  const options = [{ value: 'all', label: '全部' }].concat(
    state.gpus.map((gpu) => ({ value: String(gpu.index), label: `GPU ${gpu.index}` })),
  );
  if (refs.procFilter.dataset.signature !== options.map((o) => o.value).join('|')) {
    refs.procFilter.replaceChildren();
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.setAttribute('aria-pressed', 'false');
      button.textContent = option.label;
      button.dataset.value = option.value;
      button.addEventListener('click', () => {
        state.filter = option.value;
        renderProcFilter();
        renderProcTable();
      });
      refs.procFilter.appendChild(button);
    }
    refs.procFilter.dataset.signature = options.map((o) => o.value).join('|');
  }
  if (state.filter !== 'all' && !options.some((o) => o.value === state.filter)) {
    state.filter = 'all';
  }
  for (const button of refs.procFilter.children) {
    const active = button.dataset.value === state.filter;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  refs.procFilter.dataset.value = state.filter;
}

function renderProcTable() {
  const gpusByIndex = new Map(state.gpus.map((gpu) => [gpu.index, gpu]));
  const rows = state.processes.filter((proc) => state.filter === 'all' || String(proc.gpuIndex) === state.filter);
  refs.procBody.replaceChildren();

  for (const proc of rows) {
    const gpu = gpusByIndex.get(proc.gpuIndex);
    const ratio = gpu && gpu.memTotalMiB ? (proc.usedMemMiB / gpu.memTotalMiB) * 100 : null;
    const tr = document.createElement('tr');

    const tdGpu = document.createElement('td');
    const tag = document.createElement('span');
    tag.className = 'gpu-tag';
    tag.textContent = proc.gpuIndex == null ? '未知' : `GPU ${proc.gpuIndex}`;
    tdGpu.appendChild(tag);

    const tdPid = document.createElement('td');
    tdPid.textContent = proc.pid == null ? '--' : String(proc.pid);

    const tdName = document.createElement('td');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'proc-name';
    nameSpan.textContent = proc.name;
    tdName.appendChild(nameSpan);
    tdName.title = proc.name;

    const tdMem = document.createElement('td');
    tdMem.className = 'num mem-strong';
    tdMem.textContent = fmtMiB(proc.usedMemMiB);

    const tdRatio = document.createElement('td');
    tdRatio.className = 'num mem-sub';
    tdRatio.textContent = ratio == null ? '--' : fmtPct(ratio, 1);

    tr.append(tdGpu, tdPid, tdName, serviceCell(proc), tdMem, tdRatio);
    refs.procBody.appendChild(tr);
  }

  const empty = rows.length === 0;
  refs.procEmpty.hidden = !empty;
  refs.procTableWrap.hidden = empty;

  if (empty) {
    if (state.meta?.processWarning) {
      refs.procEmptyText.textContent = state.meta.processWarning;
    } else if (state.filter !== 'all') {
      refs.procEmptyText.textContent = `GPU ${state.filter} 上没有正在占用显存的进程。`;
    } else {
      refs.procEmptyText.textContent = '显卡当前空闲，或采集服务权限不足（需要与业务进程相同的用户）。';
    }
  }

  const total = state.processes.length;
  refs.procSub.textContent = state.filter === 'all'
    ? `按显存占用从高到低排列，共 ${total} 个进程`
    : `筛选 GPU ${state.filter}，显示 ${rows.length} / ${total} 个进程`;
}

/* ---------- 渲染：采集信息 ---------- */
/* ---------- 渲染：进程占用历史 ---------- */
function textCell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function gpuTagCell(index) {
  const td = document.createElement('td');
  const tag = document.createElement('span');
  tag.className = 'gpu-tag';
  tag.textContent = index == null ? '未知' : `GPU ${index}`;
  td.appendChild(tag);
  return td;
}

function procNameCell(name) {
  const td = document.createElement('td');
  const span = document.createElement('span');
  span.className = 'proc-name';
  span.textContent = name || '未知进程';
  td.appendChild(span);
  td.title = name || '';
  return td;
}

/**
 * 「服务」列：容器名 / systemd 单元 / 用户会话，都拿不到时留一个短横线。
 * 悬停给出运行用户与完整命令行——命令行往往最能说明这是哪个业务。
 */
function serviceCell(proc) {
  const td = document.createElement('td');
  const tag = document.createElement('span');
  tag.className = 'service-tag';
  tag.textContent = proc.service || '–';
  if (proc.serviceKind) tag.dataset.kind = proc.serviceKind;
  if (!proc.service) tag.dataset.kind = 'none';
  td.appendChild(tag);

  const hints = [
    proc.user ? `运行用户：${proc.user}` : null,
    proc.cmdline && proc.cmdline !== proc.name ? `命令行：${proc.cmdline}` : null,
    proc.containerId && !proc.containerName ? `容器 ID：${proc.containerId}` : null,
  ].filter(Boolean);
  if (hints.length) td.title = hints.join('\n');
  return td;
}

function renderProcHistRange() {
  const history = state.processHistory;
  const signature = `${PROC_HIST_RANGES.map((item) => item.value).join('|')}#${history.range}`;
  if (refs.procHistRange.dataset.signature === signature) return;
  refs.procHistRange.replaceChildren();
  for (const item of PROC_HIST_RANGES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = item.label;
    button.dataset.value = item.value;
    button.setAttribute('aria-pressed', item.value === history.range ? 'true' : 'false');
    button.addEventListener('click', () => {
      if (state.processHistory.range === item.value) return;
      state.processHistory.range = item.value;
      renderProcHistRange();
      loadProcessHistory();
    });
    refs.procHistRange.appendChild(button);
  }
  refs.procHistRange.dataset.signature = signature;
}

async function loadProcessHistory() {
  const history = state.processHistory;
  history.loading = true;
  history.error = null;
  renderProcHistory();
  try {
    const data = await fetchJson(`/api/processes?range=${encodeURIComponent(history.range)}&limit=${PROC_HIST_LIMIT}`);
    history.rows = data.processes || [];
    history.total = data.total ?? history.rows.length;
    // 没启用历史库时后端会明确说原因，这里如实显示，而不是给个空表让人以为"这段时间没进程"
    history.notice = data.source === 'memory' ? (data.reason || '未启用历史库') : null;
  } catch (error) {
    history.rows = [];
    history.total = 0;
    history.notice = null;
    history.error = `读取失败（${error.message}）`;
  } finally {
    history.loading = false;
  }
  renderProcHistory();
}

function renderProcHistory() {
  const history = state.processHistory;
  const label = PROC_HIST_RANGES.find((item) => item.value === history.range)?.label || history.range;
  const rows = history.rows || [];

  if (history.loading) refs.procHistSub.textContent = `最近 ${label}：读取中…`;
  else if (history.error) refs.procHistSub.textContent = history.error;
  else if (history.notice) refs.procHistSub.textContent = `最近 ${label}：${history.notice}`;
  else if (history.total === 0) refs.procHistSub.textContent = `最近 ${label}没有进程占用记录`;
  else {
    const shown = history.total > rows.length ? `，显示最近 ${rows.length} 条` : '';
    refs.procHistSub.textContent = `最近 ${label}共 ${history.total} 条记录${shown}`;
  }

  refs.procHistBody.replaceChildren();
  const empty = rows.length === 0;
  refs.procHistWrap.hidden = empty;
  refs.procHistEmpty.hidden = !empty;
  if (empty) {
    refs.procHistEmptyTitle.textContent = (history.error || history.notice) ? '进程历史不可用' : '这段时间没有进程记录';
    refs.procHistEmptyText.textContent = history.error
      || history.notice
      || '进程只在身份变化（或每 5 分钟补一次快照）时留档，这段时间没有新的占用出现。';
    return;
  }

  for (const event of rows) {
    const tr = document.createElement('tr');
    tr.append(
      textCell(fmtDateTimeFull(event.t)),
      gpuTagCell(event.gpuIndex),
      textCell(event.pid == null ? '--' : String(event.pid)),
      procNameCell(event.name),
      serviceCell(event),
      textCell(fmtMiB(event.usedMemMiB), 'num mem-strong'),
    );
    refs.procHistBody.appendChild(tr);
  }
}

function describeCadence(meta) {
  const idle = meta.idle;
  if (!idle) return '--';
  if (!idle.idleAfterMs) return '固定间隔（未启用空闲降频）';
  const seconds = Math.round(idle.idleAfterMs / 1000);
  if (idle.active) return `空闲降频中（每 ${idle.currentIntervalMs} ms）`;
  return `实时（无人访问 ${seconds} 秒后降频到 ${idle.idleIntervalMs} ms）`;
}

function describeFields(meta) {
  const fields = meta.fields;
  if (!fields) return '--';
  if (!fields.enabled) return '已关闭（--no-extended）';
  if (fields.mock) return `模拟数据源（${fields.count} 项，未做驱动探测）`;
  if (fields.extended == null) return '探测中…';
  if (fields.extended) return `全部可用（${fields.count} 项）`;
  return `可用 ${fields.count} 项，跳过 ${fields.unsupported.length} 项`;
}

function describeChannel(meta) {
  if (meta.push && meta.push.enabled === false) return 'HTTP 轮询（服务端已用 --no-push 关闭推送）';
  if (state.pushActive) {
    const subscribers = meta.push?.subscribers;
    return `SSE 推送${subscribers ? `（${subscribers} 个页面订阅中）` : ''}`;
  }
  return 'HTTP 轮询（推送未连接）';
}

function describeStorage(meta) {
  const storage = meta.storage;
  if (!storage) return '--';
  if (storage.mode === 'disabled') return '已关闭（--no-db）';
  if (storage.mode !== 'sqlite') return `不可用（${storage.reason || '未知原因'}）`;
  const parts = [];
  if (storage.path) parts.push(storage.path);
  if (storage.sizeBytes != null) parts.push(fmtBytes(storage.sizeBytes));
  if (storage.written) parts.push(`本次已写入 ${storage.written.gpu} 行`);
  if (storage.oldestTs) parts.push(`最早 ${fmtDateTime(storage.oldestTs)}`);
  parts.push(storage.retentionDays > 0 ? `保留 ${storage.retentionDays} 天` : '永久保留');
  if (storage.storeIntervalMs) parts.push(`每 ${Math.round(storage.storeIntervalMs / 1000)} 秒落一行`);
  // 只有可回收空间足够大才提示：稳态运行时这个值很小，提示了反而是噪音
  if (storage.freelistBytes > 32 * 1024 * 1024) {
    parts.push(`可回收 ${fmtBytes(storage.freelistBytes)}（node tools/db-maintenance.mjs --reclaim）`);
  }
  return parts.join(' · ');
}

function describeAlerts(meta) {
  const alerts = meta.alerts;
  if (!alerts) return '--';
  if (!alerts.enabled) {
    if (alerts.problems?.length) return `未启用（${alerts.problems.join('；')}）`;
    return `未启用（${alerts.reason || '没有配置规则'}）`;
  }
  const parts = [`${alerts.ruleCount} 条规则`];
  if (alerts.dryRun) parts.push('dry-run（只打印不发送）');
  if (alerts.autoReload) parts.push('改动自动生效');
  if (alerts.cooldownMs) parts.push(`抑制 ${Math.round(alerts.cooldownMs / 60000)} 分钟`);
  parts.push(alerts.firing.length ? `当前 ${alerts.firing.length} 条触发中` : '当前无告警');
  // 长周期（for 超过内存窗口）规则的判定数据来自哪里，值得写清楚
  const history = alerts.history;
  if (history?.enabled) {
    const granularity = history.step > 0 ? `按 ${Math.round(history.step / 60000)} 分钟分桶` : '原始粒度';
    parts.push(`${history.longRuleCount} 条长周期规则查历史库（${granularity}）`);
    if (history.truncated) parts.push('历史区间被截断');
    if (history.lastError) parts.push(`取历史失败：${history.lastError}`);
  } else if (history?.longRuleCount > 0) {
    parts.push(`${history.longRuleCount} 条长周期规则只能按内存窗口判定（未启用历史库）`);
  }
  if (alerts.notifiedCount) parts.push(`已通知 ${alerts.notifiedCount} 次`);
  if (alerts.problems?.length) parts.push(`${alerts.problems.length} 条规则被跳过`);
  if (alerts.lastError) parts.push(alerts.lastError);
  return parts.join(' · ');
}

function renderMeta() {
  const meta = state.meta || {};
  const rows = [
    ['主机名', meta.hostname || '--'],
    ['运行平台', meta.platform ? `${meta.platform.label} ${meta.platform.arch}（node ${meta.platform.nodeVersion || '--'}）` : '--'],
    ['驱动版本', meta.driverVersion || '--'],
    ['采集间隔', meta.intervalMs ? `${meta.intervalMs} ms` : '--'],
    ['采集模式', describeCadence(meta)],
    ['数据通道', describeChannel(meta)],
    ['曲线窗口', meta.windowSamples ? `${meta.windowSamples} 点 / 约 ${Math.round(meta.windowSamples * (meta.intervalMs || 1000) / 1000)} 秒` : '--'],
    ['已缓存采样点', meta.samples == null ? '--' : `${meta.samples} 点`],
    ['单次采集耗时', meta.collectMs == null ? '--' : `${meta.collectMs} ms`],
    ['服务运行时长', fmtDuration(meta.uptimeSec)],
    ['扩展 GPU 指标', describeFields(meta)],
    ['宿主指标', meta.systemEnabled === false
      ? '已关闭（--no-system）'
      : meta.system
        ? `开启${(meta.system.unsupported || []).length ? `（${meta.system.unsupported.map((key) => SYSTEM_FIELD_LABELS[key] || key).join(' / ')} 不可用）` : ''}`
        : '等待采集'],
    ['历史库', describeStorage(meta)],
    ['告警', describeAlerts(meta)],
    ['数据源', meta.mock
      ? '模拟数据（--mock）'
      : meta.collector?.bin
        ? `${meta.collector.bin}（${meta.collector.source || '自定义'}）`
        : '未找到 nvidia-smi'],
    ['最近更新', state.lastSampleAt ? `${fmtClock(state.lastSampleAt)}（${fmtRelative(state.lastSampleAt)}）` : '--'],
  ];
  if (!meta.mock && meta.collector?.tried?.length && !meta.collector?.bin) {
    rows.splice(rows.length - 1, 0, [
      '探测过的位置',
      meta.collector.tried.map((item) => `${item.bin}（${item.result}）`).join('；'),
    ]);
  }
  refs.metaList.replaceChildren();
  for (const [label, value] of rows) {
    const div = document.createElement('div');
    div.className = 'meta__row';
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    div.append(dt, dd);
    refs.metaList.appendChild(div);
  }
}

/* ---------- 主渲染 ---------- */
function render() {
  renderStatus();
  renderNotice(state.meta);
  renderAlerts(state.meta);
  // 扩展字段导出依赖历史库，没有库就置灰并说明原因
  const canFullExport = state.meta?.storage?.supportsHistory === true;
  refs.btnCsvFull.disabled = !canFullExport;
  refs.btnCsvFull.title = canFullExport
    ? '导出当前范围内的 CSV，并带上时钟 / P-State / 风扇 / PCIe / 编解码 / 节流等扩展列'
    : '扩展字段只存在历史库里，启用历史库后可用';
  renderKpis();
  renderCharts();
  renderSystemCard();
  renderGpuCards();
  renderProcFilter();
  renderProcTable();
  renderMeta();

  const windowText = `${Math.round(state.windowSamples * state.intervalMs / 1000)} 秒`;
  const idleNote = state.meta?.idle?.active ? ` · 空闲降频中（每 ${state.meta.idle.currentIntervalMs} ms）` : '';
  if (state.gpus.length) {
    refs.orientSub.textContent = `${state.meta?.hostname || '--'} · ${state.gpus.length} 张卡 · 每 ${state.intervalMs} ms 采集 · 窗口最近 ${windowText}${idleNote} · 更新于 ${fmtClock(state.lastSampleAt)}`;
  } else if (state.status === 'error' || state.status === 'unreachable') {
    const host = state.meta?.hostname ? `${state.meta.hostname} · ` : '';
    const tail = state.lastSampleAt ? `数据停留在 ${fmtRelative(state.lastSampleAt)}` : '还没有采到任何数据';
    refs.orientSub.textContent = `${host}${state.status === 'unreachable' ? '无法连接采集服务' : '采集异常'} · ${tail}`;
  } else {
    refs.orientSub.textContent = '正在连接采集服务…';
  }

  const sources = [state.meta?.mock ? '模拟数据源' : 'nvidia-smi'];
  if (state.meta?.systemEnabled !== false) sources.push('宿主 /proc 与系统接口');
  const storage = state.meta?.storage;
  if (storage?.mode === 'sqlite') {
    const keep = storage.retentionDays > 0 ? `超过 ${storage.retentionDays} 天的自动清理` : '不自动清理';
    refs.footerText.textContent = `数据来自 ${sources.join(' + ')}：实时窗口保留最近 ${state.windowSamples} 个采样点（约 ${windowText}），同时每 ${Math.round(storage.storeIntervalMs / 1000)} 秒向 ${storage.path || '历史库'} 落一行，${keep}。`;
  } else if (storage) {
    refs.footerText.textContent = `数据来自 ${sources.join(' + ')}，仅在内存中保留最近 ${state.windowSamples} 个采样点（约 ${windowText}）；未启用历史库（${storage.reason || '--no-db'}）。`;
  } else {
    refs.footerText.textContent = `数据来自 ${sources.join(' + ')}，仅在内存中保留最近 ${state.windowSamples} 个采样点（约 ${windowText}）。`;
  }
}

/* ---------- 交互 ---------- */
function renderRangePicker() {
  const signature = `${RANGES.map((item) => item.value).join('|')}#${state.range}`;
  if (refs.rangePicker.dataset.signature === signature) return;
  refs.rangePicker.replaceChildren();
  for (const item of RANGES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = item.label;
    button.dataset.value = item.value;
    button.setAttribute('aria-pressed', item.value === state.range ? 'true' : 'false');
    button.addEventListener('click', () => {
      selectRange(item.value);
    });
    refs.rangePicker.appendChild(button);
  }
  refs.rangePicker.dataset.signature = signature;
}

function resetSeries() {
  state.series.clear();
  state.systemSeries = { t: [], cpu: [], mem: [] };
  // 让曲线与卡片节点按新的数据重建，避免残留上一次的卡列表
  state.chartSignature = '';
  state.cardSignature = '';
}

async function reloadLiveWindow() {
  resetSeries();
  state.historyPoints = null;
  state.historyStep = null;
  state.historyTruncated = false;
  state.historyNotice = null;
  try {
    const history = await fetchJson('/api/history');
    state.intervalMs = history.intervalMs || state.intervalMs;
    state.windowSamples = history.windowSamples || state.windowSamples;
    for (const sample of history.samples || []) appendSample(sample, { force: true });
  } catch {
    // 回填失败不影响后续实时帧继续进来
  }
}

async function loadHistoryRange(range) {
  resetSeries();
  try {
    const data = await fetchJson(`/api/history?range=${encodeURIComponent(range)}`);
    state.historyPoints = data.points ?? 0;
    state.historyStep = data.step ?? null;
    state.historyTruncated = Boolean(data.truncated);
    // 没启用历史库时会走内存窗口，这里如实说明而不是画一条假的区间
    state.historyNotice = data.source === 'memory' ? (data.reason || '未启用历史库') : null;
    for (const sample of data.samples || []) appendSample(sample, { force: true });
  } catch (error) {
    state.historyPoints = 0;
    state.historyNotice = `读取历史失败（${error.message}）`;
  }
}

async function selectRange(value) {
  if (value === state.range) return;
  state.range = value;
  renderRangePicker();
  if (value === 'live') await reloadLiveWindow();
  else await loadHistoryRange(value);
  render();
}

function download(path, extra = {}) {
  // 导出范围跟随曲线选择：实时 → 内存窗口，历史区间 → 库里的对应区间
  const params = new URLSearchParams();
  if (state.range === 'live') params.set('limit', String(state.windowSamples));
  else params.set('range', state.range);
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  const url = `${path}?${params.toString()}`;
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

refs.btnCsv.addEventListener('click', () => download('/api/export.csv'));
// 扩展字段只存在历史库里，没有库时后端会返回 400，所以按钮直接置灰并给出原因
refs.btnCsvFull.addEventListener('click', () => download('/api/export.csv', { fields: 'full' }));
refs.btnSysCsv.addEventListener('click', () => download('/api/export.system.csv'));
refs.btnJson.addEventListener('click', () => download('/api/export.json'));
refs.btnRefresh.addEventListener('click', async () => {
  refs.btnRefresh.disabled = true;
  // 手动刷新时连历史数据一起刷：进程历史是独立拉取的，不随实时帧更新
  await Promise.all([poll(), loadProcessHistory()]);
  refs.btnRefresh.disabled = false;
});
refs.btnRetry.addEventListener('click', () => poll());

let resizeTimer = null;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    renderCharts();
    renderSystemCard();
  }, 180);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !state.pushActive) poll();
});

async function boot() {
  renderRangePicker();
  renderProcHistRange();
  try {
    const history = await fetchJson('/api/history');
    state.intervalMs = history.intervalMs || state.intervalMs;
    state.windowSamples = history.windowSamples || state.windowSamples;
    for (const sample of history.samples || []) appendSample(sample);
  } catch {
    // 首次回填失败不阻塞，直接进入轮询
  }
  await poll();
  // 进程历史是独立的一次性拉取，不参与每秒的实时更新
  loadProcessHistory();
  // 但页面开久了"最近 24 小时"这个窗口会滑动，所以每 5 分钟悄悄刷一次
  window.setInterval(() => {
    if (!document.hidden && !state.processHistory.loading) loadProcessHistory();
  }, 5 * 60 * 1000);
  // 先用轮询兜住，再尝试升级成 SSE 推送；推送连上后会自动停掉轮询
  schedulePolling();
  startPush();
}

boot();
