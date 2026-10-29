import { resampleToGrid } from './resample.js';
import { utilKpiView } from './kpi-util.js';
import { throttleParts, healthParts, gpuFootItems } from './gpu-card-parts.js';
import { hoverIndexFromX, hoverRows } from './chart-hover.js';
import { statusView } from './status-pill.js';
import { getLang, hasKey, initI18n, onLangChange, setLang, t, tn } from './i18n/index.js';
import { applyStaticI18n } from './i18n/dom.js';
import { enhanceDropdown } from './dropdown.js';
import { backendText } from './backend-text.js';
import { createInferenceConfigController } from './inference-config.js';

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
  alertsLive: $('alerts-live'),
  alertsRules: $('alerts-rules'),
  alertsRulesSummary: $('alerts-rules-summary'),
  alertsRuleList: $('alerts-rule-list'),
  btnRetry: $('btn-retry'),
  btnExport: $('btn-export'),
  viewSwitch: $('view-switch'),
  langSwitch: $('lang-switch'),
  viewNav: $('view-nav'),
  viewTopbar: $('topbar'),
  appEl: document.querySelector('.app'),
  work: $('work'),
  exportDialog: $('export-dialog'),
  exportClose: $('export-close'),
  exportCancel: $('export-cancel'),
  exportConfirm: $('export-confirm'),
  exportContent: $('export-content'),
  exportLayoutGroup: $('export-layout-group'),
  exportLayout: $('export-layout'),
  exportLayoutHint: $('export-layout-hint'),
  exportRangeGroup: $('export-range-group'),
  exportRange: $('export-range'),
  exportRangeHint: $('export-range-hint'),
  exportFullGroup: $('export-full-group'),
  exportFull: $('export-full'),
  exportFullHint: $('export-full-hint'),
  exportTimeHint: $('export-time-hint'),
  exportSummary: $('export-summary'),
  chartTip: $('chart-tip'),
  metricTip: $('metric-tip'),
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
  svcSub: $('svc-sub'),
  svcLegend: $('svc-legend'),
  svcChartWrap: $('svc-chart-wrap'),
  svcCanvas: $('svc-canvas'),
  svcEmpty: $('svc-empty'),
  svcEmptyTitle: $('svc-empty-title'),
  svcEmptyText: $('svc-empty-text'),
  rangePicker: $('range-picker'),
  rangeLive: $('range-live'),
  rangeHours: $('range-hours'),
  rangeDays: $('range-days'),
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
  procHistMin: $('proc-hist-min'),
  procHistWrap: $('proc-hist-wrap'),
  procHistBody: $('proc-hist-body'),
  procHistMore: $('proc-hist-more'),
  procHistMoreBtn: $('proc-hist-more-btn'),
  procHistMoreHint: $('proc-hist-more-hint'),
  procHistEmpty: $('proc-hist-empty'),
  procHistEmptyTitle: $('proc-hist-empty-title'),
  procHistEmptyText: $('proc-hist-empty-text'),
  gpuCards: $('gpu-cards'),
  inferCard: $('infer-card'),
  inferSub: $('infer-sub'),
  inferSummary: $('infer-summary'),
  inferList: $('infer-list'),
  inferEmpty: $('infer-empty'),
  inferEmptyText: $('infer-empty-text'),
  inferHistSub: $('infer-hist-sub'),
  btnInferConfig: $('btn-infer-config'),
  inferHistRange: $('infer-hist-range'),
  inferHistService: $('infer-hist-service'),
  inferServiceCards: $('infer-service-cards'),
  inferProbeSub: $('infer-probe-sub'),
  inferHistEmpty: $('infer-hist-empty'),
  inferHistEmptyTitle: $('infer-hist-empty-title'),
  inferHistEmptyText: $('infer-hist-empty-text'),
  inferProbeWrap: $('infer-probe-wrap'),
  inferProbeBody: $('infer-probe-body'),
  inferProbeResult: $('infer-probe-result'),
  inferProbeSize: $('infer-probe-size'),
  inferProbePager: $('infer-probe-pager'),
  inferProbePrev: $('infer-probe-prev'),
  inferProbeNext: $('infer-probe-next'),
  inferProbePageInfo: $('infer-probe-pageinfo'),
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
  // 每一帧的原始服务汇总：服务的增删很频繁，边采边维护固定的曲线列表容易错位，
  // 所以原样留着，渲染时再挑"这段时间占用最高的几个"
  serviceRows: [],
  chartNodes: new Map(),
  chartSignature: '',
  cardNodes: new Map(),
  cardSignature: '',
  inferSignature: '',
  // 每张推理卡片独立选择指标分组（load/latency/throughput/quality）
  inferCardGroups: {},
  // 推理历史：与实时卡片的抓取节奏解耦，前端按需拉取
  inferHistory: {
    range: '24h',
    service: null,
    result: 'all',
    page: 0,
    pageSize: 20,
    total: 0,
    probes: [],
    supported: null,
    loading: false,
    notice: null,
    fetchedAt: 0,
    signature: '',
    cardSignature: '',
  },
  lastSampleAt: null,
  fetchedAt: null,
  consecutiveErrors: 0,
  pushActive: false,
  // 进程表 / 告警规则清单的"内容签名"与可复用节点：
  // 签名没变就只更新变化的格子，不整表重建（见 renderProcTable / renderAlerts）
  procSignature: null,
  procNodes: [],
  ruleSignature: null,
  firingSignature: null,
  // 上一次看到的进程身份签名：变了就说明库里有新事件，进程历史该刷新了
  processSignature: null,
  // 展示模式：single = 所有卡片一页铺开；nav = 分页签看，每页一到两张卡
  view: 'single',
  page: 'overview',
  // 导航模式下页头 / 告警 / KPI 走紧凑排版的标记（样式在 styles.css 的 [data-dense="1"]）
  dense: false,
  // 曲线时间范围：live = 实时窗口，其它值是历史区间（也直接决定导出的范围）
  range: 'live',
  historyPoints: null,
  historyStep: null,
  historyTruncated: false,
  historyNotice: null,
  historyLoading: false,
  historyCache: new Map(),
  // 进程占用历史：与曲线的时间范围互相独立（曲线可能停在实时，这里仍想看一天）
  processHistory: {
    range: '24h',
    rows: [],
    total: 0,
    // 每次取回多少条（"加载更多"就把它加一页），以及只看多大的进程
    limit: 0,
    minMiB: null,
    loading: false,
    notice: null,
  },
  stopped: false,
};

let inferConfigController = null;

// label 用 getter 而不是普通字段：这些表是模块加载时建的，
// 写成固定字符串会把"模块加载那一刻的语言"冻住，切语言后按钮文字就不动了。
const HOUR_RANGES = [1, 3, 8, 12].map((hours) => ({
  value: `${hours}h`,
  get label() { return tn('range.hours', hours); },
}));
const DAY_RANGES = [1, 3, 5, 7].map((days) => ({
  value: `${days}d`,
  get label() { return tn('range.days', days); },
}));
const RANGES = [
  { value: 'live', get label() { return t('range.live'); } },
  ...HOUR_RANGES,
  ...DAY_RANGES,
];

// 推理历史只看最近一段时间：1 小时排查抖动，24 小时看日常，30/45 天看趋势
const INFER_RANGES = [
  { value: '1h', get label() { return tn('range.hours', 1); } },
  { value: '24h', get label() { return tn('range.hours', 24); } },
  { value: '7d', get label() { return tn('range.days', 7); } },
  { value: '30d', get label() { return tn('range.days', 30); } },
  { value: '45d', get label() { return tn('range.days', 45); } },
];

const PROC_HIST_RANGES = [
  { value: '1h', get label() { return tn('range.hours', 1); } },
  { value: '24h', get label() { return tn('range.hours', 24); } },
  { value: '7d', get label() { return tn('range.days', 7); } },
  { value: '30d', get label() { return tn('range.days', 30); } },
];
const PROC_HIST_LIMIT = 200;
// 进程历史一次画多少条：卡片高度直接跟这个数走，50 条大约一屏半。
// 「加载更多」一页一页加，而不是一次取 200 条堆上去
const PROC_HIST_PAGE = 50;
const PROC_HIST_MAX = 2000;
// 占用下限的快捷选项：小进程（几十 MiB 到几百 MiB）在历史里基本是噪声
const PROC_HIST_MIN_PRESETS = [
  { value: 0, get label() { return t('range.all'); } },
  { value: 512, label: '≥ 512 MiB' },
  { value: 1024, label: '≥ 1 GiB' },
  { value: 4096, label: '≥ 4 GiB' },
];

let eventSource = null;
let pollTimer = null;
let historyFetchController = null;
let pushRetryTimer = null;
// 进程历史的重载防抖计时器（见 scheduleProcessHistoryReload）
let processHistoryTimer = null;
let pushFailures = 0;

const HIGH_THRESHOLD = 90;
const TEMP_WARN = 75;
const TEMP_DANGER = 85;

const SYSTEM_FIELD_LABELS = {
  cpu: 'CPU',
  get mem() { return t('sys.field.mem'); },
  get swap() { return t('sys.field.swap'); },
  get load() { return t('sys.field.load'); },
  get disk() { return t('sys.field.disk'); },
  get net() { return t('sys.field.net'); },
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

// 曲线可能跨天，悬停时必须带完整日期；坐标轴和状态信息仍用短时间，避免挤占空间。
function fmtTooltipDateTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtRelative(ts) {
  if (!ts) return '--';
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 2) return t('time.justNow');
  if (seconds < 60) return tn('time.secondsAgo', seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return tn('time.minutesAgo', minutes);
  return tn('time.hoursAgo', Math.floor(minutes / 60));
}

function fmtDuration(seconds) {
  if (seconds == null) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return t('time.duration.hoursMinutes', { h, m });
  if (m > 0) return t('time.duration.minutesSeconds', { m, s });
  return t('time.duration.seconds', { s });
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
  // 上限必须和 chartSlots() 用同一个数：横轴是按它铺开的，曲线却按实时窗口（300 点）裁的话，
  // 长区间会被截成最后 300 点并挤到画布最右边——1501 个点的区间实测就是这样，
  // 时间轴左端会显示"现在"而不是区间起点。
  const overflow = list.t.length - chartSlots();
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
  // 服务汇总按帧原样留着，渲染时再挑"这段时间占用最高的几个"——
  // 服务的增删很频繁，边采边维护一份固定的曲线列表反而容易错位
  state.serviceRows.push({ t: sample.t, services: sample.services || [] });
  if (state.serviceRows.length > chartSlots()) {
    state.serviceRows.splice(0, state.serviceRows.length - chartSlots());
  }
}

async function fetchJson(url, { signal } = {}) {
  const response = await fetch(url, { cache: 'no-store', signal });
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
  noteProcessIdentity();
  if (state.gpus.length > 0 || data.system) {
    // services 一定要带上：服务显存曲线与图例都从它来。漏了这个字段，
    // 那条号称"实时窗口"的曲线只会显示开页那一刻回填的数据，之后一直定格。
    appendSample({
      t: data.ts || Date.now(),
      gpus: state.gpus,
      system: data.system,
      services: data.services,
    });
  }
  render();
}

/**
 * 进程历史那张表不跟实时帧更新（它的数据源是独立的接口）。
 * 与其按固定间隔盲刷，不如**盯着进程身份有没有变**：变了说明库里刚写进一条新事件，
 * 那时再刷一次。没变化就一个查询都不发——比"每 5 分钟刷一次"既更及时也更省。
 */
function noteProcessIdentity() {
  const signature = state.processes
    .map((proc) => `${proc.gpuIndex ?? '-'}:${proc.pid ?? '-'}:${proc.name ?? '-'}`)
    .sort()
    .join('|');
  if (signature === state.processSignature) return;
  state.processSignature = signature;
  scheduleProcessHistoryReload();
}

/**
 * 进程churn 起来时（容器反复重启）可能几秒内变好几次，攒一下再刷。
 * 留 8 秒是因为库里最多每 5 秒落一行，刷太早会查不到那条。
 */
function scheduleProcessHistoryReload() {
  if (processHistoryTimer) window.clearTimeout(processHistoryTimer);
  processHistoryTimer = window.setTimeout(() => {
    processHistoryTimer = null;
    if (!document.hidden && !state.processHistory.loading) loadProcessHistory();
  }, 8000);
}

async function poll() {
  try {
    applyState(await fetchJson('/api/state'));
  } catch (error) {
    state.consecutiveErrors += 1;
    state.status = 'unreachable';
    // 这条是前端自己拼的（后端的 error 字段另有来源），所以要在源头就翻好；
    // 渲染时那层 backendText() 只认后端的原文，认不出的会原样返回，不会再动它
    state.meta = {
      ...(state.meta || {}),
      error: t('app.error.unreachable', { message: error.message }),
    };
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
    // 这个浏览器压根没有 EventSource：推送这条路是断的，计数上要体现出来
    pushFailures += 1;
    schedulePolling();
    return;
  }
  try {
    eventSource = new EventSource('/api/stream');
  } catch {
    eventSource = null;
    pushFailures += 1;
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
  // 判定逻辑在 status-pill.js（纯函数，冒烟测试覆盖了陈旧 / 降级 / 空闲降频的边界与优先级）
  const view = statusView({
    status: state.status,
    lastSampleAt: state.lastSampleAt,
    intervalMs: state.intervalMs,
    storeIntervalMs: state.meta?.storage?.storeIntervalMs || 0,
    idle: state.meta?.idle || null,
    pushActive: state.pushActive,
    pushEnabled: state.meta?.push?.enabled !== false,
    pushDownCount: pushFailures,
    relative: fmtRelative,
  });
  refs.statusPill.dataset.state = view.tone;
  refs.statusText.textContent = view.text;
  // 正常实时采集时收起这枚胶囊（顶栏不必常驻"实时采集中"）；
  // 其余状态——连接中断、采集失败、数据陈旧、退回轮询、未检测到 GPU、空闲降频——照旧显示
  refs.statusPill.hidden = view.quiet;
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
      title: t('notice.unreachable.title'),
      text: t('notice.unreachable.text'),
      hint: 'curl -s http://localhost:' + (location.port || '8080') + '/api/state | head',
    });
    return;
  }
  if (state.status === 'error') {
    const platform = meta?.platform || {};
    const unsupported = platform.supported === false;
    showNotice({
      title: unsupported
        ? t('notice.unsupported.title', { label: platform.label || t('common.unknownSystem') })
        : t('notice.error.title'),
      // error / hint 是后端拼好的中文句子，过一层对照翻译（认不出就原样显示）
      text: [backendText(meta?.error), backendText(meta?.hint)]
        .filter(Boolean)
        .join(t('common.dotSeparator')) || t('common.unknownError'),
      hint: unsupported ? null : 'nvidia-smi -L',
    });
    return;
  }
  if (noGpu) {
    showNotice({
      title: t('notice.noGpu.title'),
      text: t('notice.noGpu.text'),
      hint: 'nvidia-smi -L',
    });
    return;
  }
  refs.notice.hidden = true;
}

/** platform.note 是后端下发的整句中文，认得出就翻（映射表见 backend-text.js） */
function platformNote(platform) {
  return backendText(platform?.note || '');
}

/* ---------- 渲染：告警 ---------- */
// 同样用 getter：级别名是渲染时读的，不能冻在模块加载那一刻的语言上
const ALERT_LEVEL_LABELS = {
  get critical() { return t('alerts.level.critical'); },
  get warning() { return t('alerts.level.warning'); },
};

// 判定时长：秒级写秒、分钟级写分钟，避免出现"240 秒"这种要心算的写法
function fmtForMs(ms) {
  if (!(ms > 0)) return '';
  if (ms < 60000) return t('time.plainSeconds', { n: Math.round(ms / 1000) });
  const minutes = ms / 60000;
  if (minutes < 60) return t('time.plainMinutes', { n: Math.round(minutes * 10) / 10 });
  return t('time.plainHours', { n: Math.round((minutes / 60) * 10) / 10 });
}

// 阈值按单位渲染：显存类走 GiB/MiB，布尔量走"是/否"
function fmtThreshold(rule) {
  if (rule.isBoolean) return rule.threshold ? t('common.yes') : t('common.no');
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
  // 指标名走 metricDisplayName：自定义 label 的用户也可能在看英文界面
  const subject = hasCustomLabel(rule) ? `${metricDisplayName(rule)} ` : '';
  parts.push(`${subject}${rule.op} ${fmtThreshold(rule)}`);
  if (rule.service) parts.push(t('alerts.rule.onlyService', { service: rule.service }));
  parts.push(rule.effectiveForMs > 0
    ? t('alerts.rule.forDuration', { duration: fmtForMs(rule.effectiveForMs) })
    : t('alerts.rule.instant'));
  if (rule.clamped) parts.push(t('alerts.rule.clamped', { duration: fmtForMs(rule.forMs) }));
  return parts.join(t('common.listSeparator'));
}

/** 用户有没有给这条规则写自己的 label（没写时后端会填内置指标名） */
function hasCustomLabel(rule) {
  return Boolean(rule.label) && rule.label !== rule.metricLabel;
}

/** 指标名：按 metric 标识符查翻译，查不到退回后端给的原文 */
function metricDisplayName(rule) {
  const key = `alerts.metric.${rule.metric}`;
  return hasKey(key) ? t(key) : (rule.metricLabel || rule.metric || '--');
}

/**
 * 规则显示名。
 *
 * 后端下发的 `label` 有两种来源（见 src/alerts/rules.js）：用户自己在 alerts.json 里写的，
 * 或者内置指标的默认中文名。前者是**用户数据**，切语言时原样保留——把它翻掉等于改用户的东西；
 * 后者是界面文案，按 metric 标识符查翻译（标识符是稳定的英文键）。
 * 判据：label 与 metricLabel（后端给的内置名）一致 → 说明用户没写 label。
 */
function ruleDisplayName(rule) {
  return hasCustomLabel(rule) ? rule.label : metricDisplayName(rule);
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
    refs.alertsTitle.textContent = t('alerts.title');
    return;
  }
  refs.alerts.hidden = false;
  // 面板常驻，但只有真触发时才该整块泛黄；"没事"要看起来像没事
  refs.alerts.dataset.state = firing.length ? 'firing' : 'idle';
  refs.alertsTitle.textContent = firing.length
    ? t('alerts.title.firing', { n: firing.length })
    : t('alerts.title');

  // dry-run 必须一眼可见：只打印不发送时，页面看着"配好了"最容易误判
  const badges = [];
  if (alerts.dryRun) badges.push(t('alerts.badge.dryRun'));
  if (alerts.problems?.length) badges.push(t('alerts.badge.skipped', { n: alerts.problems.length }));
  if (alerts.warnings?.length) badges.push(t('alerts.badge.suspect', { n: alerts.warnings.length }));
  if (alerts.lastReloadError) badges.push(t('alerts.badge.reloadError'));
  refs.alertsBadge.textContent = badges.join(' · ');
  refs.alertsBadge.hidden = badges.length === 0;

  const summary = [t('alerts.summary.monitoring', { n: alerts.ruleCount })];
  if (alerts.cooldownMs) {
    summary.push(t('alerts.summary.cooldown', { minutes: Math.round(alerts.cooldownMs / 60000) }));
  }
  summary.push(alerts.autoReload ? t('alerts.summary.autoReload') : t('alerts.summary.manualReload'));
  if (alerts.lastCheckAt) summary.push(t('alerts.summary.checkedAt', { time: fmtClock(alerts.lastCheckAt) }));
  if (alerts.notifiedCount) summary.push(tn('alerts.summary.notified', alerts.notifiedCount));
  refs.alertsStatus.textContent = summary.join(' · ');

  refs.alertsEmpty.hidden = firing.length > 0;
  refs.alertsEmpty.textContent = t('alerts.empty', { n: rules.length || alerts.ruleCount });

  // 读屏播报：只在触发集合变化时改这一行（它挂了 aria-live，每秒刷就会被反复念）
  const liveSummary = firing.length === 0
    ? t('alerts.live.none')
    : `${t('alerts.live.firing', { n: firing.length })}${
      firing.some((alert) => alert.level === 'critical') ? t('alerts.live.criticalSuffix') : ''
    }`;
  if (refs.alertsLive.textContent !== liveSummary) refs.alertsLive.textContent = liveSummary;

  // 触发中的条目：身份（哪条规则、什么级别、什么文案）没变就只刷新"自 N 秒前"。
  // 真出事时正是有人盯着这块看的时刻，每秒重建会让悬停闪、正文也选不中。
  const firingSignature = firing.map((alert) => [
    alert.level, ALERT_LEVEL_LABELS[alert.level] || alert.level, alert.detail, alert.service || '',
  ].join('¦')).join('\u0001');
  if (firingSignature !== state.firingSignature) {
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
      since.textContent = alert.since ? t('alerts.since', { rel: fmtRelative(alert.since) }) : '';
      item.append(level, detail, since);
      refs.alertsList.appendChild(item);
    }
    state.firingSignature = firingSignature;
  } else {
    [...refs.alertsList.children].forEach((item, index) => {
      const since = item.querySelector('.alerts__since');
      if (!since) return;
      const sinceText = firing[index]?.since
        ? t('alerts.since', { rel: fmtRelative(firing[index].since) })
        : '';
      if (since.textContent !== sinceText) since.textContent = sinceText;
    });
  }

  // 规则清单：确认"到底在盯什么"。零触发时这是页面上唯一能看出告警正常工作的东西。
  refs.alertsRules.hidden = rules.length === 0;
  refs.alertsRulesSummary.textContent = t('alerts.rules.summary', { n: rules.length });
  const ruleNotes = new Map();
  for (const item of alerts.warnings || []) {
    if (!ruleNotes.has(item.ruleId)) ruleNotes.set(item.ruleId, []);
    ruleNotes.get(item.ruleId).push(item.message);
  }
  // 规则清单的内容几乎不变（规则集和触发状态都是慢变量），却每秒重算一遍。
  // 按内容签名决定要不要重建：重建会让展开着的清单滚动位置跳、也让鼠标悬停闪。
  const ruleSignature = rules.map((rule) => [
    rule.id, rule.level, rule.label, rule.op, rule.threshold, rule.value, rule.service,
    rule.firingCount, (rule.targets || []).join('、'), (ruleNotes.get(rule.id) || []).join('~'),
  ].join('¦')).join('\u0001');
  if (ruleSignature === state.ruleSignature) return;
  state.ruleSignature = ruleSignature;

  refs.alertsRuleList.replaceChildren();
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
    name.textContent = ruleDisplayName(rule);
    const condition = document.createElement('span');
    condition.className = 'alerts__rule-cond';
    // 规则名就是指标名时不加冒号：读起来就是"显存占用率 >= 85%，持续 4 分钟"一句完整的话
    condition.textContent = !hasCustomLabel(rule)
      ? ` ${describeRule(rule)}`
      : t('alerts.rule.condWithName', { condition: describeRule(rule) });
    text.append(name, condition);
    const state = document.createElement('span');
    state.className = 'alerts__rule-state';
    state.dataset.state = rule.firingCount > 0 ? 'firing' : 'normal';
    if (rule.firingCount > 0) {
      state.textContent = rule.targets?.length
        ? t('alerts.rule.firingTargets', { targets: rule.targets.join(t('common.enumSeparator')) })
        : t('alerts.rule.firingCount', { n: rule.firingCount });
    } else {
      state.textContent = t('alerts.rule.normal');
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
  // 导航模式的顶栏要横着排五个 KPI，脚注只能占几个字：这里出短文案，
  // 完整说法挂到 title 上（鼠标一停就能看到），单页模式照旧出全文
  const dense = !!state.dense;
  const totalMem = gpus.reduce((sum, gpu) => sum + (gpu.memTotalMiB || 0), 0);
  const usedMem = gpus.reduce((sum, gpu) => sum + (gpu.memUsedMiB || 0), 0);
  const usedPct = totalMem > 0 ? (usedMem / totalMem) * 100 : null;
  const utils = gpus.map((gpu) => gpu.utilGpuPct).filter((v) => v != null);
  const temps = gpus.map((gpu) => gpu.tempC).filter((v) => v != null);

  refs.kpiCount.innerHTML = gpus.length
    ? `${gpus.length}<span class="kpi__unit">${t('kpi.count.unit')}</span>`
    : '--';
  refs.kpiCountFoot.textContent = gpus.length
    ? t('kpi.count.foot.host', { host: state.meta?.hostname || '--' })
    : t('kpi.waiting');

  refs.kpiMem.innerHTML = gpus.length
    ? `${(toGiB(usedMem) || 0).toFixed(0)}<span class="kpi__unit">/ ${(toGiB(totalMem) || 0).toFixed(0)} GB</span>`
    : '--<span class="kpi__unit">/ --</span>';
  refs.kpiMemFill.style.width = usedPct == null ? '0%' : `${Math.min(100, usedPct).toFixed(1)}%`;
  refs.kpiMemFill.dataset.tone = toneFor(usedPct) || '';
  refs.kpiMemFoot.textContent = usedPct == null
    ? t('kpi.mem.foot.unknown')
    : (dense ? `${usedPct.toFixed(1)}%` : t('kpi.mem.foot.machine', { pct: usedPct.toFixed(1) }));
  refs.kpiMemFoot.title = dense && usedPct != null
    ? t('kpi.mem.foot.machine', { pct: usedPct.toFixed(1) })
    : '';
  refs.kpiMemFoot.dataset.tone = toneFor(usedPct) || '';

  // 「平均 GPU 利用率」是跨时间的：服务端把历史库里近 1 小时的采样点整体平均好给过来。
  // 没有历史库（Node 太旧 / --no-db）时才退回这一帧的跨卡平均，并把口径写在脚注里。
  const avgUtilNow = utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : null;
  const utilView = utilKpiView({
    avgUtilNow,
    crossTime: state.meta?.utilAverage || null,
    cardCount: utils.length,
    now: state.lastSampleAt || Date.now(),
    intervalMs: state.intervalMs || 1000,
  });
  refs.kpiUtil.innerHTML = utilView.value == null
    ? '--<span class="kpi__unit">%</span>'
    : `${utilView.value.toFixed(0)}<span class="kpi__unit">%</span>`;
  refs.kpiUtilFoot.textContent = dense ? utilView.footShort : utilView.foot;
  refs.kpiUtilFoot.title = utilView.title;

  const maxTemp = temps.length ? Math.max(...temps) : null;
  refs.kpiTemp.innerHTML = maxTemp == null
    ? '--<span class="kpi__unit">°C</span>'
    : `${Math.round(maxTemp)}<span class="kpi__unit">°C</span>`;
  const hotIndex = maxTemp == null ? null : (gpus.find((gpu) => gpu.tempC === maxTemp)?.index ?? '--');
  refs.kpiTempFoot.textContent = hotIndex == null
    ? t('kpi.waiting')
    : (dense ? `GPU ${hotIndex}` : t('kpi.temp.foot.fromGpu', { index: hotIndex }));
  refs.kpiTempFoot.title = dense && hotIndex != null
    ? t('kpi.temp.foot.fromGpu', { index: hotIndex })
    : '';
  refs.kpiTempFoot.dataset.tone = tempTone(maxTemp) || '';

  const procCount = state.processes.length;
  refs.kpiProc.innerHTML = state.meta?.status === 'ok'
    ? `${procCount}<span class="kpi__unit">${t('kpi.proc.unit')}</span>`
    : `--<span class="kpi__unit">${t('kpi.proc.unit')}</span>`;
  const procMem = state.processes.reduce((sum, proc) => sum + (proc.usedMemMiB || 0), 0);
  refs.kpiProcFoot.textContent = state.meta?.status === 'ok'
    ? (dense ? fmtGiB(procMem) : t('kpi.proc.foot.total', { mem: fmtGiB(procMem) }))
    : t('kpi.waiting');
  refs.kpiProcFoot.title = dense && state.meta?.status === 'ok'
    ? t('kpi.proc.foot.total', { mem: fmtGiB(procMem) })
    : '';
}

/* ---------- 渲染：曲线 ---------- */
function rangeLabel() {
  if (state.range === 'live') return t('chart.range.liveWindow');
  if (state.range === 'all') return t('chart.range.allStored');
  const item = RANGES.find((entry) => entry.value === state.range);
  return t('chart.range.historyWithLabel', { label: item?.label || state.range });
}

function describeRange() {
  if (state.range === 'live') {
    return t('chart.window.live', { seconds: Math.round(state.windowSamples * state.intervalMs / 1000) });
  }
  const item = RANGES.find((entry) => entry.value === state.range);
  const label = item?.label || state.range;
  if (state.historyLoading) return t('chart.range.loading', { label });
  // 曲线切到历史区间时，顶部指标、右侧卡片和系统资源里的读数是"现在"的，
  // 不写清楚很容易把两种时间尺度混着看
  const liveNote = t('chart.note.liveCards');
  // historyNotice 存的是原文（reason / message），翻译放在这里做，切语言才会跟着变
  if (state.historyNotice?.error) {
    return t('chart.range.withNotice', {
      label,
      notice: t('chart.historyFailed', { message: state.historyNotice.error }),
    });
  }
  if (state.historyNotice) {
    return t('chart.range.withNotice', {
      label,
      notice: backendText(state.historyNotice.reason) || t('procHist.noStore'),
    });
  }
  if (!state.historyPoints) return t('chart.range.noData', { label });
  const stepText = state.historyStep > 0
    ? t('chart.step.every', { seconds: Math.round(state.historyStep / 1000) })
    : '';
  const truncated = state.historyTruncated ? t('chart.range.truncated') : '';
  // 「全部」是"库里现存的全部"，不是"历史上的全部"：默认保留期会把更早的行清掉。
  // 这个分支只保留给旧链接/API 的 range=all；新界面不再提供「全部」按钮
  if (state.range === 'all') {
    const retention = state.meta?.storage?.retentionDays;
    const bound = retention > 0
      ? t('chart.range.retained', { days: retention })
      : t('chart.range.noRetention');
    return t('chart.range.allDetail', {
      bound, points: state.historyPoints, step: stepText, truncated, note: liveNote,
    });
  }
  return t('chart.range.historyDetail', {
    label, points: state.historyPoints, step: stepText, truncated, note: liveNote,
  });
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
 * canvas 的 CSS 尺寸缓存。
 *
 * `drawLines` 每个采集周期都会跑一遍，而 `getBoundingClientRect()` 会强制同步重排——
 * 8 卡页面每秒就是 8 次。这个尺寸只在两种情况下会变：**窗口缩放**、以及**切页签 / 切模式**
 * （列宽从 12 格变 8 格），所以只在这两处让缓存失效（见 resize 处理器与 applyView）。
 * canvas 元素本身是重建的（卡片结构变化时），WeakMap 会随之自然淘汰旧条目。
 */
let canvasSizeCache = new WeakMap();

function canvasBox(canvas) {
  let box = canvasSizeCache.get(canvas);
  if (!box) {
    const rect = canvas.getBoundingClientRect();
    box = { width: Math.round(rect.width), height: Math.round(rect.height) };
    canvasSizeCache.set(canvas, box);
  }
  return box;
}

/* ---------- 曲线悬停：竖直参考线 + 跟随鼠标的浮窗 ---------- */
// 状态按 canvas 存：hoverState 记鼠标当前落在哪个采样点上，chartHoverData 记这张图上次画
// 的系列与时间轴。这样鼠标一动只重画这一张（8 卡时不会因为动鼠标把 8 张图全重绘），
// 而每秒的常规重绘也会照着同一个索引把高亮画回去——鼠标停着不动时高亮不会闪掉。
const hoverState = new Map();
const chartHoverData = new Map();

function chartHoverRedraw(canvas, index) {
  if (index == null) hoverState.delete(canvas);
  else hoverState.set(canvas, index);
  const data = chartHoverData.get(canvas);
  // 用同样的参数重画一次；此时 hoverState 已更新，画出来的就是新位置
  if (data) drawLines(canvas, data.seriesList, data.windowSamples, { limit: data.limit, times: data.times });
}

function attachChartHover(canvas) {
  const track = (event) => {
    const data = chartHoverData.get(canvas);
    if (!data) return;
    const rect = canvas.getBoundingClientRect();
    const count = data.seriesList[0]?.values.length || 0;
    const index = hoverIndexFromX({
      x: event.clientX - rect.left,
      width: rect.width,
      count,
      slots: data.windowSamples,
      padLeft: data.pad.left,
      padRight: data.pad.right,
    });
    if (index !== (hoverState.get(canvas) ?? null)) chartHoverRedraw(canvas, index);
    showChartTip(event, data, index);
  };
  const clear = () => {
    chartHoverRedraw(canvas, null);
    hideChartTip();
  };

  canvas.addEventListener('pointermove', track);
  // 触屏没有 hover：改成"按住看"（按下即显示，拖动还能扫着看）。
  // 松手才收起，且只对非鼠标生效——鼠标左键点一下不该把读数弄没。
  canvas.addEventListener('pointerdown', track);
  canvas.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'mouse') clear();
  });
  canvas.addEventListener('pointercancel', clear);
  canvas.addEventListener('pointerleave', clear);
}

function hideChartTip() {
  if (refs.chartTip) refs.chartTip.hidden = true;
}

function positionChartTip(event) {
  const tip = refs.chartTip;
  const rect = tip.getBoundingClientRect();
  const gap = 14;
  // 贴右边/下边时翻到另一侧，免得浮窗跑出窗口
  let left = event.clientX + gap;
  if (left + rect.width > window.innerWidth - 8) left = event.clientX - rect.width - gap;
  let top = event.clientY + gap;
  if (top + rect.height > window.innerHeight - 8) top = event.clientY - rect.height - gap;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function showChartTip(event, data, index) {
  const tip = refs.chartTip;
  if (!tip || index == null) {
    hideChartTip();
    return;
  }
  const view = hoverRows({
    seriesList: data.seriesList,
    times: data.times,
    index,
    timeLabel: fmtTooltipDateTime,
  });
  if (!view) {
    hideChartTip();
    return;
  }

  const time = document.createElement('p');
  time.className = 'chart-tip__time';
  time.textContent = view.time;
  const rows = view.rows.map((row) => {
    const line = document.createElement('p');
    line.className = 'chart-tip__row';
    const swatch = document.createElement('span');
    swatch.className = 'chart-tip__swatch';
    swatch.style.background = row.color;
    const label = document.createElement('span');
    label.className = 'chart-tip__label';
    label.textContent = row.label;
    const value = document.createElement('span');
    value.className = 'chart-tip__value';
    value.textContent = row.value;
    line.append(swatch, label, value);
    return line;
  });
  tip.replaceChildren(time, ...rows);
  tip.hidden = false;
  positionChartTip(event);
}

/** 切页签/换区间时 canvas 会重建或改尺寸，旧的悬停状态就作废了 */
function resetChartHover() {
  hoverState.clear();
  hideChartTip();
}

/**
 * 画一组 0-100% 的折线。
 * series 里每一项是 { values, color, width, fill }；values 里的 null 表示这一段没有数据，
 * 折线会断开、面积也不会跨越空洞——宿主指标在部分平台上取不到时就是这个样子。
 *
 * 悬停（鼠标停在图上）画的东西也在这里：一条竖直参考线 + 每个系列在这个点上的圆点。
 * 索引按 canvas 存在 hoverState 里，所以每次常规重绘都会照着同一个索引画回去，
 * 鼠标停着不动时高亮不会闪掉。浮窗本身是 DOM，见 showChartTip()。
 */
function drawLines(canvas, seriesList, windowSamples, { limit = null, times = [] } = {}) {
  const { width, height } = canvasBox(canvas);
  if (width < 40 || height < 40) return;
  // 数据侧留一份：鼠标一动只重画这一张图，浮窗要的系列/时间轴也从这儿取
  const hoverIndex = hoverState.get(canvas) ?? null;

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

  // 12px：1× 屏（外接显示器没有 dpr 加成）上 11px 明显偏细，而这张图是要"看台机器"的
  ctx.font = '12px ' + cssVar('--jf-font-body', 'sans-serif');
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

  chartHoverData.set(canvas, { seriesList, windowSamples, times, limit, pad });

  // 参考线画在折线下面，免得把曲线割断
  const hoverX = hoverIndex != null && hoverIndex >= 0 && hoverIndex < count ? xAt(hoverIndex) : null;
  if (hoverX != null) {
    ctx.save();
    ctx.strokeStyle = colors.muted;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(hoverX) + 0.5, pad.top);
    ctx.lineTo(Math.round(hoverX) + 0.5, pad.top + plotH);
    ctx.stroke();
    ctx.restore();
  }

  for (const line of seriesList) {
    const values = line.values;

    if (line.fill && count >= 2) {
      const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
      // 面积色走 token：改主题主色时曲线和界面一起变，不会留下"旧蓝"
      gradient.addColorStop(0, cssVar('--jf-chart-fill-from', 'rgba(0, 91, 172, 0.2)'));
      gradient.addColorStop(1, cssVar('--jf-chart-fill-to', 'rgba(0, 91, 172, 0.02)'));
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
  // 起点时间画在**第一个数据点**正下方，而不是固定贴左边：窗口没攒满时数据只占右边一段，
  // 贴左边的那行字看起来像在给一段空白标注时间（悬停那块区域也是按"无数据"处理的）
  ctx.fillText(count > 0 && times[0] ? fmtClock(times[0]) : '--:--:--', count > 0 ? xAt(0) : pad.left, pad.top + plotH + 5);
  ctx.textAlign = 'right';
  ctx.fillText(t('chart.axis.now'), pad.left + plotW, pad.top + plotH + 5);

  // 悬停点的圆点画在最后（压在折线之上），加白描边是为了在密集的曲线里也能看清
  if (hoverX != null) {
    for (const line of seriesList) {
      const value = line.values[hoverIndex];
      if (value == null || !Number.isFinite(value)) continue;
      ctx.beginPath();
      ctx.arc(hoverX, yAt(value), 3.2, 0, Math.PI * 2);
      ctx.fillStyle = line.color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = cssVar('--jf-color-surface', '#ffffff');
      ctx.stroke();
    }
  }
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
      refs.emptyTitle.textContent = t('state.empty.loading.title');
      refs.emptyText.textContent = t('state.empty.loading.text');
    } else if (state.meta?.status === 'ok') {
      refs.emptyTitle.textContent = t('state.empty.noGpu.title');
      refs.emptyText.textContent = t('state.empty.noGpu.text');
    } else if (state.meta?.platform?.supported === false) {
      refs.emptyTitle.textContent = t('state.empty.unsupported.title');
      refs.emptyText.textContent = platformNote(state.meta.platform) || t('state.empty.unsupported.text');
    } else {
      refs.emptyTitle.textContent = t('state.empty.error.title');
      refs.emptyText.textContent = t('state.empty.error.text');
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
          <span class="chart__stat" data-role="mem"><span>${t('chart.stat.mem')}</span><b></b></span>
          <span class="chart__stat" data-role="util"><span>${t('chart.stat.util')}</span><b></b></span>
          <span class="chart__stat" data-role="temp"><span>${t('chart.stat.temp')}</span><b></b></span>
        </div>`;
      head.querySelector('.chart__name').textContent = gpu.name;

      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'chart__canvas-wrap';
      const canvas = document.createElement('canvas');
      canvas.className = 'chart__canvas';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', t('chart.canvas.label', { index: gpu.index, range: rangeLabel() }));
      // 鼠标停在图上时给参考线与浮窗；canvas 是重建的，所以监听也在这里挂
      attachChartHover(canvas);
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
    memStat.querySelector('b').textContent = t('gpu.memValue', {
      used: fmtGiB(gpu.memUsedMiB),
      total: fmtGiB(gpu.memTotalMiB),
      pct: fmtPct(gpu.memUsedPct, 1),
    });
    memStat.dataset.tone = toneFor(gpu.memUsedPct) || '';
    utilStat.querySelector('b').textContent = fmtPct(gpu.utilGpuPct, 0);
    tempStat.querySelector('b').textContent = gpu.tempC == null ? '--' : `${Math.round(gpu.tempC)}°C`;
    tempStat.dataset.tone = tempTone(gpu.tempC) || '';
    if (series) {
      drawLines(
        node.canvas,
        [
          {
            values: series.mem, color: colors.primary, width: 2, fill: true,
            label: t('chart.legend.mem'), format: (value) => fmtPct(value, 1),
          },
          {
            values: series.util, color: colors.signal, width: 1.5,
            label: t('chart.series.util'), format: (value) => fmtPct(value, 0),
          },
        ],
        chartSlots(),
        { limit: HIGH_THRESHOLD, times: series.t },
      );
    }
  }
}

/* ---------- 渲染：服务显存曲线 ---------- */
// 图表分类色板也从 token 读（见 styles.css 的 --jf-chart-* ）：
// 这条曲线是青色、那条是橙色，与状态色是两回事——图形要鲜亮，正文要够深，取舍相反
const SERVICE_COLORS = [1, 2, 3, 4, 5].map((i) => cssVar(`--jf-chart-${i}`, '#005bac'))
  .concat(cssVar('--jf-chart-other', '#c87700'));
const SERVICE_TOP_N = 5;
// 后端把"拿不到服务身份"的进程固定叫「未识别」，曲线里合成的那条叫「其他」。
// 这两个名字是**身份**（用来比对、去重、当图例的 key），所以只翻显示、不改身份。
const SERVICE_LABEL_KEYS = { 未识别: 'svc.unknown', 其他: 'svc.other' };
const serviceDisplayName = (name) => {
  const key = SERVICE_LABEL_KEYS[name];
  return key ? t(key) : name;
};

/**
 * 从逐帧的服务汇总里挑出这段时间占用最高的几个，剩下的归入"其他"。
 * 排序用区间内的峰值而不是当前值：某个服务刚降下来、但整段时间都吃得很凶，
 * 按当前值排会被挤出去，反而看不出是谁在占。
 */
function buildServiceSeries(rows, topN = SERVICE_TOP_N) {
  const peaks = new Map();
  for (const row of rows) {
    for (const entry of row.services) {
      const share = entry.sharePct ?? 0;
      if (share > (peaks.get(entry.service) ?? 0)) peaks.set(entry.service, share);
    }
  }
  const names = [...peaks.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name]) => name);

  const lines = names.map((name, index) => ({
    name,
    color: SERVICE_COLORS[index % SERVICE_COLORS.length],
    values: [],
    // 曲线画的是"占整机显存的比例"（纵轴 0-100%），但人想看的往往是具体多少 GB，
    // 所以另存一份同一刻的 MiB：悬停浮窗用它，和右边图例的口径一致。
    hoverValues: [],
  }));
  const other = {
    name: '其他',
    // 悬停浮窗优先用 label（chart-hover 里就是 line.label || line.name），
    // 所以身份留中文、显示翻成当前语言，两边互不干扰
    label: t('svc.other'),
    color: SERVICE_COLORS[SERVICE_COLORS.length - 1],
    values: [],
    hoverValues: [],
  };
  const times = [];

  for (const row of rows) {
    times.push(row.t);
    const byName = new Map(row.services.map((entry) => [entry.service, entry]));
    let shown = 0;
    let shownMiB = 0;
    for (const line of lines) {
      const entry = byName.get(line.name);
      const share = entry ? (entry.sharePct ?? 0) : null;
      line.values.push(share);
      line.hoverValues.push(entry ? (entry.memMiB ?? null) : null);
      if (share != null) {
        shown += share;
        shownMiB += entry.memMiB ?? 0;
      }
    }
    // "其他"是"这一帧所有服务之和减去已画出来的部分"，这样它永远和总量对得上，
    // 不会因为某个服务中途消失而算错
    const total = row.services.reduce((sum, entry) => sum + (entry.sharePct ?? 0), 0);
    const totalMiB = row.services.reduce((sum, entry) => sum + (entry.memMiB ?? 0), 0);
    const rest = total - shown;
    other.values.push(rest > 0.05 ? rest : null);
    other.hoverValues.push(rest > 0.05 ? Math.max(0, totalMiB - shownMiB) : null);
  }
  if (other.values.some((value) => value != null)) lines.push(other);
  return { lines, times };
}

function renderServiceChart() {
  refs.svcSub.textContent = t('svc.sub', { range: rangeLabel(), n: SERVICE_TOP_N });
  const rows = state.serviceRows;
  const usable = rows.filter((row) => row.services.length > 0);

  if (usable.length === 0) {
    refs.svcChartWrap.hidden = true;
    refs.svcLegend.replaceChildren();
    refs.svcEmpty.hidden = false;
    refs.svcEmptyTitle.textContent = t('svc.empty.title');
    refs.svcEmptyText.textContent = rows.length === 0
      ? t('svc.empty.noSamples')
      : t('svc.empty.oldRows');
    return;
  }
  refs.svcChartWrap.hidden = false;
  refs.svcEmpty.hidden = true;

  const { lines, times } = buildServiceSeries(usable);
  // 浮窗里按 GB 显示：服务维度统计的就是"这个服务占了多少显存"
  drawLines(refs.svcCanvas, lines.map((line) => ({ ...line, format: fmtGiB })), chartSlots(), { times });

  // 图例带当前值：只给颜色分不清谁是谁。
  // 服务可能在区间末尾已经退出了，这时退到"最后一次见到的值"并标注出来，
  // 显示"--"等于把这条曲线整段的信息都丢了
  const lastRow = usable[usable.length - 1];
  const inLast = new Map(lastRow.services.map((entry) => [entry.service, entry]));
  const lastSeen = new Map();
  for (const row of usable) {
    for (const entry of row.services) lastSeen.set(entry.service, entry);
  }
  const drawnNames = lines.filter((line) => line.name !== '其他').map((line) => line.name);
  const shownMemInLast = drawnNames.reduce((sum, name) => sum + (inLast.get(name)?.memMiB || 0), 0);
  const totalMemInLast = lastRow.services.reduce((sum, entry) => sum + (entry.memMiB || 0), 0);

  // 图例文案（各服务当前 GB）每秒都在变，但条目本身是慢变量：
  // 按服务名复用条目、只改文字，省掉每次重绘都重建这几个节点
  const legendSpecs = [];
  for (const line of lines) {
    const isOther = line.name === '其他';
    const gone = !isOther && !inLast.has(line.name);
    const entry = isOther ? null : (inLast.get(line.name) || lastSeen.get(line.name));
    const mem = isOther ? Math.max(0, totalMemInLast - shownMemInLast) : (entry?.memMiB ?? null);
    legendSpecs.push({
      key: line.name,
      color: line.color,
      text: `${serviceDisplayName(line.name)} ${mem == null ? '--' : fmtGiB(mem)}`
        + (gone ? t('svc.legend.gone') : ''),
    });
  }
  syncLegendItems(refs.svcLegend, legendSpecs);
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

/**
 * 按「标签 + 值」复用行节点，只把变了的值写进去（采集信息、系统资源明细都用它）。
 *
 * 这几张卡片每秒都会重绘一次，而其中大多数行的内容是不变的（主机名、平台、驱动、磁盘总量…）。
 * 整棵 replaceChildren() 的代价不只是创建节点——它会让鼠标悬停闪一下、正文选不中、焦点丢失。
 * 所以改成：标签对得上就复用节点，值没变就一个字节都不碰（字符串比较很便宜）。
 *
 * @param {HTMLElement} container 行容器（子节点形如 div[class] > dt + dd）
 * @param {Array<[string, string]>} rows [标签, 值] 列表
 * @param {{ rowClass: string, labelClass?: string, valueClass?: string }} options
 */
function syncLabelValueRows(container, rows, { rowClass, labelClass, valueClass }) {
  const nodes = [...container.children];
  rows.forEach(([label, value], index) => {
    let row = nodes[index];
    // 标签对不上（行数增减、顺序变了、标签本身变了）就重建这一行
    if (!row || row.firstElementChild?.textContent !== label) {
      row = document.createElement('div');
      row.className = rowClass;
      const dt = document.createElement('dt');
      if (labelClass) dt.className = labelClass;
      dt.textContent = label;
      const dd = document.createElement('dd');
      if (valueClass) dd.className = valueClass;
      row.append(dt, dd);
      if (nodes[index] && nodes[index].parentNode === container) container.replaceChild(row, nodes[index]);
      else container.appendChild(row);
      nodes[index] = row;
    }
    const dd = row.lastElementChild;
    if (dd.textContent !== value) dd.textContent = value;
  });
  // 行数变少时删掉多出来的旧行
  for (let i = rows.length; i < nodes.length; i += 1) {
    if (nodes[i] && nodes[i].parentNode === container) nodes[i].remove();
  }
}

/**
 * 系统资源那三条进度条的同款处理：标签没变就复用节点，
 * 只更新数值 / 脚注 / 进度条宽度 / 配色（每一项都先比较再写）。
 */
function syncLegendItems(container, specs) {
  const nodes = [...container.children];
  specs.forEach((spec, index) => {
    let item = nodes[index];
    if (!item || item.dataset.key !== spec.key) {
      // 颜色只在建节点时写一次：它跟着服务身份走，条目的 key 没变颜色就不会变
      item = document.createElement('span');
      item.className = 'legend__item';
      item.dataset.key = spec.key;
      const swatch = document.createElement('span');
      swatch.className = 'legend__swatch';
      swatch.style.background = spec.color;
      item.append(swatch, document.createElement('span'));
      if (nodes[index] && nodes[index].parentNode === container) container.replaceChild(item, nodes[index]);
      else container.appendChild(item);
      nodes[index] = item;
    }
    const text = item.lastElementChild;
    if (text.textContent !== spec.text) text.textContent = spec.text;
  });
  for (let i = specs.length; i < nodes.length; i += 1) {
    if (nodes[i] && nodes[i].parentNode === container) nodes[i].remove();
  }
}

function syncSysMeters(container, specs) {
  const nodes = [...container.children];
  specs.forEach((spec, index) => {
    let node = nodes[index];
    if (!node || node.dataset.label !== spec.label) {
      node = sysMeter(spec);
      node.dataset.label = spec.label;
      if (nodes[index] && nodes[index].parentNode === container) container.replaceChild(node, nodes[index]);
      else container.appendChild(node);
      nodes[index] = node;
      return;
    }
    const value = node.querySelector('.sys-meter__value');
    if (value.textContent !== spec.value) value.textContent = spec.value;
    value.dataset.tone = spec.tone || '';
    const foot = node.querySelector('.sys-meter__foot');
    if (foot.textContent !== spec.foot) foot.textContent = spec.foot;
    node.dataset.available = spec.available === false ? 'false' : 'true';
    const fill = node.querySelector('.meter__fill');
    const width = spec.pct == null ? '0%' : `${Math.min(100, spec.pct).toFixed(1)}%`;
    if (fill.style.width !== width) fill.style.width = width;
    fill.dataset.tone = spec.tone || '';
  });
  for (let i = specs.length; i < nodes.length; i += 1) {
    if (nodes[i] && nodes[i].parentNode === container) nodes[i].remove();
  }
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
    refs.sysSub.textContent = t('sys.sub.closed');
    refs.sysEmptyTitle.textContent = t('sys.empty.closed.title');
    refs.sysEmptyText.textContent = t('sys.empty.closed.text');
    return;
  }

  if (!system) {
    refs.sysChartWrap.hidden = true;
    refs.sysEmpty.hidden = false;
    refs.sysSub.textContent = t('kpi.waiting');
    refs.sysEmptyTitle.textContent = meta.status === 'ok'
      ? t('sys.empty.noMetrics.title')
      : t('sys.empty.unavailable.title');
    refs.sysEmptyText.textContent = backendText(meta.systemWarning) || t('sys.empty.fallbackText');
    return;
  }

  refs.sysEmpty.hidden = true;
  refs.sysChartWrap.hidden = false;

  const cpu = system.cpu || null;
  const mem = system.mem || null;
  const unsupported = new Set(system.unsupported || []);
  const missing = [...unsupported].map((key) => SYSTEM_FIELD_LABELS[key] || key);
  // 曲线跟着所选区间走，读数是当前值：切到历史区间时标出来，免得两种时间尺度被混着看
  const liveMark = state.range === 'live' ? '' : t('sys.mark.current');

  refs.sysSub.textContent = [
    cpu?.cores ? t('sys.sub.cores', { n: cpu.cores }) : null,
    cpu?.model || null,
    missing.length ? t('sys.sub.unavailable', { fields: missing.join(' / ') }) : null,
    state.range === 'live' ? null : t('sys.sub.historyNote'),
  ].filter(Boolean).join(' · ') || t('sys.sub.overview');

  // 先攒成"想要的样子"，再交给 sync* 去和现有节点对账：标签没变就只改值，
  // 这样每秒的重绘不会重建节点（悬停不闪、正文能选中、焦点不丢）
  const meters = [
    {
      label: `${t('sys.legend.cpu')}${liveMark}`,
      value: cpu?.usagePct == null ? '--' : `${cpu.usagePct.toFixed(0)}%`,
      foot: cpu?.usagePct == null
        ? t('sys.meter.noSample')
        : t('sys.meter.cpuFoot', { n: cpu.cores }),
      pct: cpu?.usagePct ?? null,
      tone: toneFor(cpu?.usagePct ?? null),
    },
    {
      label: `${t('sys.legend.mem')}${liveMark}`,
      value: mem?.usedPct == null ? '--' : `${mem.usedPct.toFixed(0)}%`,
      foot: mem ? `${fmtGiB(mem.usedMiB)} / ${fmtGiB(mem.totalMiB)}` : t('sys.meter.memFoot.missing'),
      pct: mem?.usedPct ?? null,
      tone: toneFor(mem?.usedPct ?? null),
    },
  ];
  if (unsupported.has('swap')) {
    meters.push({
      label: `${t('sys.field.swap')}${liveMark}`,
      value: t('sys.meter.unsupported'),
      foot: t('sys.meter.swapUnsupportedFoot'),
      available: false,
    });
  } else if (system.swap) {
    meters.push({
      label: `${t('sys.field.swap')}${liveMark}`,
      value: system.swap.usedPct == null ? '--' : `${system.swap.usedPct.toFixed(0)}%`,
      foot: system.swap.totalMiB > 0
        ? `${fmtGiB(system.swap.usedMiB)} / ${fmtGiB(system.swap.totalMiB)}`
        : t('sys.meter.swapDisabled'),
      pct: system.swap.usedPct ?? 0,
    });
  }
  syncSysMeters(refs.sysMeters, meters);

  const details = [];
  if (system.load) {
    details.push([
      t('sys.field.load'),
      t('sys.detail.loadValue', {
        l1: system.load.l1.toFixed(2),
        l5: system.load.l5.toFixed(2),
        l15: system.load.l15.toFixed(2),
      }),
    ]);
  } else if (unsupported.has('load')) {
    details.push([t('sys.field.load'), t('sys.detail.unsupported')]);
  }
  for (const disk of system.disk || []) {
    details.push([
      // 显示名优先：容器里宿主的根分区挂成了 /hostfs，可以按实情写成 /
      t('sys.detail.disk', { name: disk.label || disk.path }),
      t('sys.detail.diskValue', {
        used: fmtGiB(disk.usedMiB),
        total: fmtGiB(disk.totalMiB),
        pct: fmtPct(disk.usedPct, 1),
      }),
    ]);
  }
  if (system.net) {
    details.push([
      t('sys.detail.netThroughput'),
      t('sys.detail.netValue', {
        rx: fmtRate(system.net.rxBytesPerSec),
        tx: fmtRate(system.net.txBytesPerSec),
        n: system.net.interfaces,
      }),
    ]);
  } else if (unsupported.has('net')) {
    details.push([t('sys.detail.netThroughput'), t('sys.detail.unsupported')]);
  }
  if (system.uptimeSec != null) details.push([t('sys.detail.uptime'), fmtDuration(system.uptimeSec)]);
  if (meta.systemWarning) details.push([t('sys.detail.collectHint'), backendText(meta.systemWarning)]);
  syncLabelValueRows(refs.sysDetail, details, {
    rowClass: 'sys-detail__row',
    labelClass: 'sys-detail__label',
    valueClass: 'sys-detail__value',
  });

  const series = state.systemSeries;
  if (series.t.length > 0) {
    drawLines(
      refs.sysCanvas,
      [
        {
          values: series.mem, color: themeColors().primary, width: 2, fill: true,
          label: t('sys.legend.mem'), format: (value) => fmtPct(value, 0),
        },
        {
          values: series.cpu, color: themeColors().signal, width: 1.5,
          label: t('sys.legend.cpu'), format: (value) => fmtPct(value, 0),
        },
      ],
      chartSlots(),
      { times: series.t },
    );
  }
}

/* ---------- 渲染：各卡当前占用 ---------- */
/**
 * 节流标签那一行：内容没变就不重建。
 * 8 卡页面每秒会把这一行重算 8 次，而它只在"有没有降频"变化时才真的需要动。
 */
function syncThrottleChips(node, gpu) {
  const parts = throttleParts(gpu);
  // 这里的两个中文只是**签名**（内部比较用），不显示给用户，所以不进文案表
  const signature = parts.known
    ? parts.reasons.map((reason) => `${reason.text}¦${reason.tone || ''}`).join('\u0001') || '无节流'
    : '未知';
  if (node.dataset.signature === signature) return;
  node.dataset.signature = signature;
  node.replaceChildren(renderThrottleChips(gpu));
}

function renderThrottleChips(gpu) {
  const wrap = document.createElement('div');
  wrap.className = 'gpu-card__chips';
  const { known, reasons } = throttleParts(gpu);
  if (!known) {
    wrap.appendChild(stateChip(t('gpu.throttle.unknown'), null));
    return wrap;
  }

  if (reasons.length === 0) {
    wrap.appendChild(stateChip(t('gpu.throttle.none'), null));
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

/* ---------- 渲染：推理服务 ---------- */
function fmtInferCount(value) {
  return value == null ? '--' : String(Math.round(value));
}

function fmtInferMs(value) {
  if (value == null) return '--';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)} ms`;
}

function renderInference() {
  const info = state.meta?.inference;
  // 没配置 inference.json 时整张卡不出现，页面和以前完全一样
  if (!info || !info.loaded) {
    refs.inferCard.hidden = true;
    return;
  }
  // 归「总览」页：导航模式下切到推理历史页时它要让位，否则整列会只剩这张卡
  refs.inferCard.hidden = state.view === 'nav' && state.page !== 'overview';

  const summary = info.summary || {};
  refs.inferSub.textContent = t('infer.sub', {
    total: summary.total ?? 0,
    up: summary.up ?? 0,
    interval: Math.max(1, Math.round((info.intervalMs || 15000) / 1000)),
  });
  refs.inferSummary.hidden = !summary.total;
  refs.inferSummary.textContent = summary.total
    ? t('infer.badge', { up: summary.up ?? 0, total: summary.total })
    : '';
  refs.inferSummary.dataset.state = summary.down > 0 ? 'down' : (summary.degraded > 0 ? 'warn' : 'up');

  const services = info.services || [];
  if (!services.length) {
    refs.inferList.replaceChildren();
    refs.inferEmpty.hidden = false;
    refs.inferEmptyText.textContent = backendText(info.lastReloadError)
      || info.warnings?.[0]?.message
      || t('infer.empty.text');
    state.inferSignature = '';
    return;
  }
  refs.inferEmpty.hidden = true;

  // 每秒都会被调用一次，内容没变就不重建 DOM
  const signature = `${getLang()}#${services.map((service) => [
    service.id, service.state, service.running, service.waiting,
    service.kvCachePct, service.ttftAvgMs, service.tokensPerSec, service.error,
    service.probe?.at, service.probe?.ok, service.probe?.skipped, service.probe?.ttftMs,
    service.queuedTasks, service.processingTasks, service.cumulativeSuccessPct, service.probe?.e2eMs,
  ].join('¦')).join('|')}`;
  if (signature === state.inferSignature) return;
  state.inferSignature = signature;

  refs.inferList.replaceChildren();
  for (const service of services) {
    const row = document.createElement('article');
    row.className = 'infer-row';
    row.dataset.state = service.state || 'unknown';

    const head = document.createElement('div');
    head.className = 'infer-row__head';
    const dot = document.createElement('span');
    dot.className = 'infer-row__dot';
    const name = document.createElement('span');
    name.className = 'infer-row__name';
    name.textContent = service.name || service.id;
    const kind = document.createElement('span');
    kind.className = 'infer-row__kind';
    kind.textContent = service.kind || '';
    head.append(dot, name, kind);

    const metrics = document.createElement('div');
    metrics.className = 'infer-row__metrics';
    const item = (label, value, title) => {
      const node = document.createElement('span');
      node.className = 'infer-metric';
      const labelNode = document.createElement('span');
      labelNode.className = 'infer-metric__label';
      labelNode.textContent = label;
      const valueNode = document.createElement('span');
      valueNode.className = 'infer-metric__value';
      valueNode.textContent = value;
      if (title) node.title = title;
      node.append(labelNode, valueNode);
      return node;
    };
    const probe = service.probe;
    let probeText = '--';
    const probeParts = [];
    if (probe) {
      probeText = probe.skipped
        ? t('infer.probe.skip')
        : (probe.ok ? t('infer.probe.ok') : t('infer.probe.fail'));
      if (probe.coldTtftMs != null) probeParts.push(`${t('inferHist.cold')} ${fmtInferMs(probe.coldTtftMs)}`);
      if (probe.warmTtftMs != null) probeParts.push(`${t('inferHist.warm')} ${fmtInferMs(probe.warmTtftMs)}`);
      if (probe.error) probeParts.push(backendText(probe.error));
    }
    if (service.kind === 'mineru') {
      metrics.append(
        item(t('infer.metric.queued'), fmtInferCount(service.queuedTasks)),
        item(t('infer.metric.processing'), fmtInferCount(service.processingTasks)),
        item(t('infer.metric.cumSuccess'), service.cumulativeSuccessPct == null ? '--' : fmtPct(service.cumulativeSuccessPct, 0)),
        item(t('infer.metric.parseMs'), fmtInferMs(service.probe?.e2eMs ?? null)),
        item(t('infer.metric.probe'), probeText, probeParts.join(' · ')),
      );
    } else {
      metrics.append(
        item(t('infer.metric.running'), fmtInferCount(service.running)),
        item(t('infer.metric.waiting'), fmtInferCount(service.waiting)),
        item(t('infer.metric.kv'), service.kvCachePct == null ? '--' : fmtPct(service.kvCachePct, 0)),
        item(t('infer.metric.ttft'), service.ttftAvgMs == null ? '--' : `${Math.round(service.ttftAvgMs)} ms`),
        item(t('infer.metric.tps'), service.tokensPerSec == null ? '--' : `${Math.round(service.tokensPerSec)} tok/s`),
        item(t('infer.metric.probe'), probeText, probeParts.join(' · ')),
      );
    }

    row.append(head, metrics);
    if (service.error) {
      const error = document.createElement('p');
      error.className = 'infer-row__error';
      error.textContent = backendText(service.error);
      row.appendChild(error);
    }
    refs.inferList.appendChild(row);
  }
}

/* ---------- 渲染：推理服务卡片与探针 ---------- */
function inferPageCard() {
  return refs.inferServiceCards?.closest('.card') || null;
}

function inferServiceStateText(value) {
  if (value === 'up') return t('infer.state.up');
  if (value === 'degraded') return t('infer.state.degraded');
  if (value === 'down') return t('infer.state.down');
  return t('infer.state.unknown');
}

function probeSummary(service) {
  const probe = service.probe;
  if (!probe) return { text: '--', detail: '' };
  const text = probe.skipped
    ? t('infer.probe.skip')
    : (probe.ok ? t('infer.probe.ok') : t('infer.probe.fail'));
  const parts = [];
  if (probe.coldTtftMs != null) parts.push(`${t('inferHist.cold')} ${fmtInferMs(probe.coldTtftMs)}`);
  if (probe.warmTtftMs != null) parts.push(`${t('inferHist.warm')} ${fmtInferMs(probe.warmTtftMs)}`);
  if (probe.error) parts.push(backendText(probe.error));
  return { text, detail: parts.join(' · ') };
}

function inferMetricTile(label, tipKey, value) {
  const item = document.createElement('div');
  item.className = 'infer-svc__metric';
  const term = document.createElement('dt');
  term.className = 'infer-svc__label';
  term.textContent = label;
  term.dataset.metricTip = tipKey;
  term.tabIndex = 0;
  const valueNode = document.createElement('dd');
  valueNode.className = 'infer-svc__value';
  valueNode.textContent = value;
  item.append(term, valueNode);
  return item;
}

const INFER_GROUPS = [
  { id: 'load', key: 'inferGroup.load' },
  { id: 'latency', key: 'inferGroup.latency' },
  { id: 'throughput', key: 'inferGroup.throughput' },
  { id: 'quality', key: 'inferGroup.quality' },
];

function fmtInferRate(value, unit = '') {
  if (value == null) return '--';
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${unit}`;
}

function inferGroupTiles(service, group) {
  // MinerU 是解析服务：没有 KV Cache / token 速率，指标换成队列与解析耗时
  if (service.kind === 'mineru') return mineruGroupTiles(service, group);
  if (group === 'latency') {
    return [
      [t('infer.metric.p95Ttft'), 'infer.tip.p95Ttft', fmtInferMs(service.ttftP95Ms)],
      [t('infer.metric.p95E2e'), 'infer.tip.p95E2e', fmtInferMs(service.e2eP95Ms)],
      [t('infer.metric.itl'), 'infer.tip.itl', fmtInferMs(service.itlP95Ms)],
      [t('infer.metric.queueP95'), 'infer.tip.queueP95', fmtInferMs(service.queueP95Ms)],
      [t('infer.metric.prefillP95'), 'infer.tip.prefillP95', fmtInferMs(service.prefillP95Ms)],
      [t('infer.metric.decodeP95'), 'infer.tip.decodeP95', fmtInferMs(service.decodeP95Ms)],
    ];
  }
  if (group === 'throughput') {
    return [
      [t('infer.metric.promptTps'), 'infer.tip.promptTps', fmtInferRate(service.promptTokensPerSec, ' tok/s')],
      [t('infer.metric.genTps'), 'infer.tip.genTps', fmtInferRate(service.generationTokensPerSec ?? service.tokensPerSec, ' tok/s')],
      [t('infer.metric.rpm'), 'infer.tip.rpm', fmtInferRate(service.requestsPerMin, ' req/min')],
      [t('infer.metric.stepTokens'), 'infer.tip.stepTokens', fmtInferRate(service.stepTokensAvg)],
    ];
  }
  if (group === 'quality') {
    const probe = service.probeStats;
    return [
      [t('infer.metric.errorRate'), 'infer.tip.errorRate', service.errorRatePct == null ? '--' : fmtPct(service.errorRatePct, 1)],
      [t('infer.metric.abortRate'), 'infer.tip.abortRate', service.abortRatePct == null ? '--' : fmtPct(service.abortRatePct, 1)],
      [t('infer.metric.cacheHit'), 'infer.tip.cacheHit', service.cacheHitPct == null ? '--' : fmtPct(service.cacheHitPct, 1)],
      [t('infer.metric.probeSuccess'), 'infer.tip.probeSuccess', probe?.successPct == null ? '--' : fmtPct(probe.successPct, 0)],
      [t('infer.metric.coldWarm'), 'infer.tip.coldWarm', probe?.coldWarmRatio == null ? '--' : `${probe.coldWarmRatio.toFixed(1)}×`],
      [t('infer.metric.lastProbe'), 'infer.tip.lastProbe', service.probe?.at ? fmtRelative(service.probe.at) : '--'],
    ];
  }
  return [
    [t('infer.metric.running'), 'infer.tip.running', fmtInferCount(service.running)],
    [t('infer.metric.waiting'), 'infer.tip.waiting', fmtInferCount(service.waiting)],
    [t('infer.metric.kv'), 'infer.tip.kv', service.kvCachePct == null ? '--' : fmtPct(service.kvCachePct, 1)],
    [t('infer.metric.waitCap'), 'infer.tip.waitCap', fmtInferCount(service.waitingCapacity)],
    [t('infer.metric.waitDef'), 'infer.tip.waitDef', fmtInferCount(service.waitingDeferred)],
    [t('infer.metric.preempt'), 'infer.tip.preempt', fmtInferRate(service.preemptionsPerMin, '/min')],
    [t('infer.metric.concurrency'), 'infer.tip.concurrency', service.concurrencyPct == null ? '--' : fmtPct(service.concurrencyPct, 0)],
    [t('infer.metric.probe'), 'infer.tip.probe', probeSummary(service).text],
  ];
}

function mineruGroupTiles(service, group) {
  const probe = service.probe;
  const stats = service.probeStats;
  if (group === 'latency') {
    return [
      [t('infer.metric.parseMs'), 'infer.tip.parseMs', fmtInferMs(probe?.e2eMs ?? null)],
      [t('infer.metric.parseAvg'), 'infer.tip.parseAvg', fmtInferMs(stats?.avgE2eMs ?? null)],
      [t('infer.metric.lastProbe'), 'infer.tip.lastProbe', stats?.lastAt ? fmtRelative(stats.lastAt) : '--'],
      [t('infer.metric.probe'), 'infer.tip.probe', probeSummary(service).text],
    ];
  }
  if (group === 'throughput') {
    return [
      [t('infer.metric.completedPerMin'), 'infer.tip.completedPerMin', fmtInferRate(service.completedPerMin, ' /min')],
      [t('infer.metric.failedPerMin'), 'infer.tip.failedPerMin', fmtInferRate(service.failedPerMin, ' /min')],
      [t('infer.metric.completed'), 'infer.tip.completed', fmtInferCount(service.completedTotal)],
      [t('infer.metric.failed'), 'infer.tip.failed', fmtInferCount(service.failedTotal)],
    ];
  }
  if (group === 'quality') {
    return [
      [t('infer.metric.windowSuccess'), 'infer.tip.windowSuccess', service.windowSuccessPct == null ? '--' : fmtPct(service.windowSuccessPct, 1)],
      [t('infer.metric.cumSuccess'), 'infer.tip.cumSuccess', service.cumulativeSuccessPct == null ? '--' : fmtPct(service.cumulativeSuccessPct, 1)],
      [t('infer.metric.probeSuccess'), 'infer.tip.probeSuccess', stats?.successPct == null ? '--' : fmtPct(stats.successPct, 0)],
    ];
  }
  return [
    [t('infer.metric.queued'), 'infer.tip.queued', fmtInferCount(service.queuedTasks)],
    [t('infer.metric.processing'), 'infer.tip.processing', fmtInferCount(service.processingTasks)],
    [t('infer.metric.maxConc'), 'infer.tip.maxConc', fmtInferCount(service.maxConcurrent)],
    [t('infer.metric.concurrency'), 'infer.tip.concurrency', service.concurrencyPct == null ? '--' : fmtPct(service.concurrencyPct, 0)],
    [t('infer.metric.procWindow'), 'infer.tip.procWindow', fmtInferCount(service.processingWindow)],
  ];
}

function renderInferServiceCards(info) {
  const history = state.inferHistory;
  const services = (info?.services || []).filter((service) => !history.service || service.id === history.service);
  const groups = services.map((service) => state.inferCardGroups[service.id] || 'load');
  const signature = `${getLang()}#${history.service ?? '*'}#${services.map((service, index) => `${groups[index]}¦${[
    service.id, service.state, service.model, service.version,
    service.running, service.waiting, service.waitingCapacity, service.waitingDeferred,
    service.kvCachePct, service.ttftAvgMs, service.tokensPerSec, service.promptTokensPerSec,
    service.generationTokensPerSec, service.requestsPerMin, service.stepTokensAvg,
    service.ttftP95Ms, service.e2eP95Ms, service.itlP95Ms, service.queueP95Ms,
    service.prefillP95Ms, service.decodeP95Ms, service.errorRatePct, service.abortRatePct,
    service.cacheHitPct, service.preemptionsPerMin, service.concurrencyPct, service.maxConcurrency,
    service.probe?.at, service.probe?.ok, service.probe?.skipped,
    service.probe?.coldTtftMs, service.probe?.warmTtftMs,
    service.probeStats?.successPct, service.probeStats?.coldWarmRatio,
    service.probe?.e2eMs, service.probeStats?.avgE2eMs, service.probeStats?.lastAt,
    service.queuedTasks, service.processingTasks, service.processingWindow,
    service.completedTotal, service.failedTotal, service.completedPerMin, service.failedPerMin,
    service.windowSuccessPct, service.cumulativeSuccessPct,
  ].join('¦')}`).join('|')}`;
  if (signature === history.cardSignature) return;
  history.cardSignature = signature;

  refs.inferServiceCards.replaceChildren();
  if (services.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'infer-service-empty';
    empty.textContent = t('inferConfig.noServices');
    refs.inferServiceCards.appendChild(empty);
    return;
  }

  services.forEach((service, index) => {
    const group = groups[index];
    const card = document.createElement('article');
    card.className = 'infer-svc';
    card.dataset.state = service.state || 'unknown';

    const head = document.createElement('div');
    head.className = 'infer-svc__head';
    const dot = document.createElement('span');
    dot.className = 'infer-svc__dot';
    const title = document.createElement('div');
    title.className = 'infer-svc__title';
    const name = document.createElement('span');
    name.className = 'infer-svc__name';
    name.textContent = service.name || service.id;
    const kind = document.createElement('span');
    kind.className = 'infer-svc__kind';
    kind.textContent = service.kind || '';
    title.append(name, kind);
    const stateNode = document.createElement('span');
    stateNode.className = 'infer-svc__state';
    stateNode.textContent = inferServiceStateText(service.state);
    head.append(dot, title, stateNode);

    const meta = document.createElement('p');
    meta.className = 'infer-svc__meta';
    const backendName = service.kind === 'mineru' ? 'MinerU' : 'vLLM';
    meta.textContent = [service.model, service.version ? `${backendName} ${service.version}` : '']
      .filter(Boolean)
      .join(' · ') || '--';

    const tabs = document.createElement('div');
    tabs.className = 'infer-svc__tabs';
    tabs.setAttribute('role', 'tablist');
    for (const item of INFER_GROUPS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'infer-svc__tab';
      button.textContent = t(item.key);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-pressed', item.id === group ? 'true' : 'false');
      button.addEventListener('click', () => {
        state.inferCardGroups[service.id] = item.id;
        history.cardSignature = '';
        render();
      });
      tabs.appendChild(button);
    }

    const metrics = document.createElement('dl');
    metrics.className = 'infer-svc__metrics';
    for (const [label, tip, value] of inferGroupTiles(service, group)) {
      metrics.appendChild(inferMetricTile(label, tip, value));
    }

    const probe = probeSummary(service);
    card.append(head, meta, tabs, metrics);
    if (probe.detail) {
      const note = document.createElement('p');
      note.className = 'infer-svc__note';
      note.textContent = probe.detail;
      card.appendChild(note);
    }
    if (service.error) {
      const error = document.createElement('p');
      error.className = 'infer-svc__error';
      error.textContent = backendText(service.error);
      card.appendChild(error);
    }
    refs.inferServiceCards.appendChild(card);
  });
}

function showMetricTip(target, x, y) {
  const tip = refs.metricTip;
  const key = target?.dataset?.metricTip;
  if (!tip || !key) return;
  tip.textContent = t(key);
  tip.hidden = false;
  tip.style.left = '0px';
  tip.style.top = '0px';
  const rect = tip.getBoundingClientRect();
  let left = x + 14;
  let top = y + 14;
  if (left + rect.width > window.innerWidth - 10) left = x - rect.width - 14;
  if (top + rect.height > window.innerHeight - 10) top = y - rect.height - 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function hideMetricTip() {
  if (refs.metricTip) refs.metricTip.hidden = true;
}

function bindMetricTips() {
  document.addEventListener('pointerover', (event) => {
    const target = event.target?.closest?.('[data-metric-tip]');
    if (target) showMetricTip(target, event.clientX, event.clientY);
  });
  document.addEventListener('pointerout', (event) => {
    if (event.target?.closest?.('[data-metric-tip]')) hideMetricTip();
  });
  document.addEventListener('focusin', (event) => {
    const target = event.target?.closest?.('[data-metric-tip]');
    if (!target) return;
    const rect = target.getBoundingClientRect();
    showMetricTip(target, rect.left, rect.bottom);
  });
  document.addEventListener('focusout', (event) => {
    if (event.target?.closest?.('[data-metric-tip]')) hideMetricTip();
  });
  window.addEventListener('scroll', hideMetricTip, true);
}

function bindInferPager() {
  refs.inferProbePrev?.addEventListener('click', () => {
    const history = state.inferHistory;
    if (history.page <= 0) return;
    history.page -= 1;
    history.fetchedAt = 0;
    loadInferenceProbes();
    render();
  });
  refs.inferProbeNext?.addEventListener('click', () => {
    const history = state.inferHistory;
    const pages = Math.max(1, Math.ceil(history.total / history.pageSize));
    if (history.page + 1 >= pages) return;
    history.page += 1;
    history.fetchedAt = 0;
    loadInferenceProbes();
    render();
  });
}

function renderInferPageControls() {
  const current = state.inferHistory;
  const rangeSignature = `${getLang()}#${INFER_RANGES.map((item) => item.value).join('|')}#${current.range}`;
  if (refs.inferHistRange.dataset.signature !== rangeSignature) {
    refs.inferHistRange.replaceChildren();
    for (const item of INFER_RANGES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.textContent = item.label;
      button.setAttribute('aria-pressed', item.value === current.range ? 'true' : 'false');
      button.addEventListener('click', () => {
        if (state.inferHistory.range === item.value) return;
        state.inferHistory.range = item.value;
        state.inferHistory.page = 0;
        state.inferHistory.fetchedAt = 0;
        loadInferenceProbes();
        render();
      });
      refs.inferHistRange.appendChild(button);
    }
    refs.inferHistRange.dataset.signature = rangeSignature;
  }

  const options = [
    { id: null, name: t('inferHist.service.all') },
    ...(state.meta?.inference?.services || []).map((service) => ({ id: service.id, name: service.name || service.id })),
  ];
  const serviceSignature = `${getLang()}#${options.map((item) => item.id ?? '*').join('|')}#${current.service ?? ''}`;
  if (refs.inferHistService.dataset.signature !== serviceSignature) {
    refs.inferHistService.replaceChildren();
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.textContent = option.name;
      button.setAttribute('aria-pressed', option.id === current.service ? 'true' : 'false');
      button.addEventListener('click', () => {
        if (state.inferHistory.service === option.id) return;
        state.inferHistory.service = option.id;
        state.inferHistory.page = 0;
        state.inferHistory.fetchedAt = 0;
        state.inferHistory.cardSignature = '';
        loadInferenceProbes();
        render();
      });
      refs.inferHistService.appendChild(button);
    }
    refs.inferHistService.dataset.signature = serviceSignature;
  }

  const resultOptions = [
    { id: 'all', key: 'inferHist.result.all' },
    { id: 'ok', key: 'inferHist.result.ok' },
    { id: 'fail', key: 'inferHist.result.fail' },
    { id: 'skipped', key: 'inferHist.result.skipped' },
  ];
  const resultSignature = `${getLang()}#${resultOptions.map((item) => item.id).join('|')}#${current.result}`;
  if (refs.inferProbeResult.dataset.signature !== resultSignature) {
    refs.inferProbeResult.replaceChildren();
    for (const item of resultOptions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.textContent = t(item.key);
      button.setAttribute('aria-pressed', item.id === current.result ? 'true' : 'false');
      button.addEventListener('click', () => {
        if (state.inferHistory.result === item.id) return;
        state.inferHistory.result = item.id;
        state.inferHistory.page = 0;
        state.inferHistory.fetchedAt = 0;
        loadInferenceProbes();
        render();
      });
      refs.inferProbeResult.appendChild(button);
    }
    refs.inferProbeResult.dataset.signature = resultSignature;
  }

  const sizeOptions = [20, 50, 100];
  const sizeSignature = `${getLang()}#${current.pageSize}`;
  if (refs.inferProbeSize.dataset.signature !== sizeSignature) {
    refs.inferProbeSize.replaceChildren();
    for (const size of sizeOptions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.textContent = t('inferHist.size.option', { n: size });
      button.setAttribute('aria-pressed', size === current.pageSize ? 'true' : 'false');
      button.addEventListener('click', () => {
        if (state.inferHistory.pageSize === size) return;
        state.inferHistory.pageSize = size;
        state.inferHistory.page = 0;
        state.inferHistory.fetchedAt = 0;
        loadInferenceProbes();
        render();
      });
      refs.inferProbeSize.appendChild(button);
    }
    refs.inferProbeSize.dataset.signature = sizeSignature;
  }
}

function renderInferencePage() {
  const card = inferPageCard();
  if (!card) return;
  const info = state.meta?.inference;
  card.hidden = state.view === 'nav' && state.page !== 'inference';
  if (!info?.loaded) {
    refs.inferHistSub.textContent = t('inferConfig.notLoaded');
    renderInferPageControls();
    renderInferServiceCards(null);
    refs.inferProbeSub.textContent = '';
    refs.inferProbeWrap.hidden = true;
    refs.inferHistEmpty.hidden = false;
    refs.inferHistEmptyTitle.textContent = t('inferConfig.notLoadedTitle');
    refs.inferHistEmptyText.textContent = t('inferConfig.notLoadedText');
    return;
  }

  const history = state.inferHistory;
  if (history.service && !(info.services || []).some((service) => service.id === history.service)) {
    history.service = null;
    history.page = 0;
    history.fetchedAt = 0;
    history.cardSignature = '';
  }
  renderInferPageControls();
  const total = info.summary?.total ?? (info.services || []).length;
  const up = info.summary?.up ?? 0;
  refs.inferHistSub.textContent = t('inferHist.sub', {
    total,
    up,
    interval: Math.max(1, Math.round((info.intervalMs || 15000) / 1000)),
  });
  renderInferServiceCards(info);

  const visible = state.view !== 'nav' || state.page === 'inference';
  if (visible && !history.loading && Date.now() - history.fetchedAt > 30000) loadInferenceProbes();

  const rangeLabelText = INFER_RANGES.find((item) => item.value === history.range)?.label || history.range;
  const serviceLabel = history.service
    ? ((info.services || []).find((service) => service.id === history.service)?.name || history.service)
    : t('inferHist.service.all');
  refs.inferProbeSub.textContent = t('inferHist.probeSub', {
    range: rangeLabelText,
    service: serviceLabel,
    count: history.total,
  });

  const signature = `${getLang()}#${history.range}#${history.service ?? ''}#${history.result}#${history.pageSize}#${history.page}#${history.total}#${history.probes.length}#${history.probes[0]?.ts ?? 0}#${history.supported}`;
  if (signature === history.signature) return;
  history.signature = signature;

  const probes = history.probes;
  refs.inferProbeWrap.hidden = probes.length === 0;
  refs.inferHistEmpty.hidden = probes.length > 0;
  refs.inferProbePager.hidden = history.total === 0;
  const pages = Math.max(1, Math.ceil(history.total / history.pageSize));
  refs.inferProbePageInfo.textContent = t('inferHist.pager.info', {
    page: Math.min(history.page + 1, pages),
    pages,
    total: history.total,
  });
  refs.inferProbePrev.disabled = history.page <= 0;
  refs.inferProbeNext.disabled = history.page + 1 >= pages;
  if (probes.length === 0) {
    refs.inferHistEmptyTitle.textContent = t('inferHist.empty.title');
    refs.inferHistEmptyText.textContent = backendText(history.notice) || t('inferHist.empty.text');
    refs.inferProbeBody.replaceChildren();
    return;
  }

  refs.inferProbeBody.replaceChildren();
  const nameOf = (id) => ((info.services || []).find((service) => service.id === id)?.name || id);
  for (const probe of probes) {
    const row = document.createElement('tr');
    const cells = [
      fmtRelative(probe.ts),
      nameOf(probe.service),
      probe.skipped
        ? t('inferHist.result.skipped')
        : `${probe.ok ? t('inferHist.result.ok') : t('inferHist.result.fail')}${probe.cold == null ? '' : ` · ${probe.cold ? t('inferHist.cold') : t('inferHist.warm')}`}`,
      probe.ttftMs == null ? '--' : `${Math.round(probe.ttftMs)} ms`,
      probe.e2eMs == null ? '--' : `${Math.round(probe.e2eMs)} ms`,
      probe.tokensPerSec == null ? '--' : `${Math.round(probe.tokensPerSec)} tok/s`,
    ];
    for (const [index, text] of cells.entries()) {
      const cell = document.createElement('td');
      if (index >= 3) cell.className = 'num';
      cell.textContent = text;
      row.appendChild(cell);
    }
    if (probe.error) row.title = backendText(probe.error);
    refs.inferProbeBody.appendChild(row);
  }
}

async function loadInferenceProbes() {
  const history = state.inferHistory;
  if (history.loading || !state.meta?.inference?.loaded) return;
  history.loading = true;
  try {
    const query = new URLSearchParams({
      range: history.range,
      result: history.result,
      limit: String(history.pageSize),
      offset: String(history.page * history.pageSize),
    });
    if (history.service) query.set('service', history.service);
    const data = await fetchJson(`/api/inference/probes?${query}`);
    history.probes = data.probes || [];
    history.total = data.total ?? history.probes.length;
    history.supported = data.supported !== false;
    history.notice = history.supported ? null : (data.reason || '');
    const pages = Math.max(1, Math.ceil(history.total / history.pageSize));
    if (history.total > 0 && history.page >= pages) {
      // 删到最后一页之外时，回退到有效的最后一页再取一次
      history.page = pages - 1;
      history.loading = false;
      await loadInferenceProbes();
      return;
    }
  } catch (error) {
    history.probes = [];
    history.total = 0;
    history.supported = false;
    history.notice = error.message;
  } finally {
    history.loading = false;
    history.fetchedAt = Date.now();
    history.signature = '';
    history.cardSignature = '';
    render();
  }
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
        <div class="gpu-card__health" data-role="health" hidden></div>
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

    // 运行指标那一行：写什么交给 gpuFootItems()（纯函数，单独测）。
    // 导航模式下它给的是短标签，好让这一行不折行——8 张卡各少一行就是少一屏。
    for (const item of gpuFootItems(gpu, { dense: state.dense, fmtPct })) {
      const node = card.querySelector(`[data-role="${item.key}"]`);
      // 驱动不支持这项时整项隐藏，而不是显示一排 "--"
      node.hidden = item.text == null;
      if (item.text == null) continue;
      node.textContent = item.text;
      // 短标签把完整说法放 title，鼠标一停还是看得到原文
      if (item.title) node.title = item.title;
      else node.removeAttribute('title');
    }
    card.querySelector('[data-role="temp"]').dataset.tone = tempTone(gpu.tempC) || '';

    // 导航模式（紧凑版）下，一切正常时把「无节流」并进硬件健康行尾，不再单开一行——
    // 8 张卡铺开就是 8 行"无节流"，那是整整一行在说"没出事"。真在降频、或驱动
    // 根本没给这组字段时，照旧单独成行带色，那种信号得一眼看见。
    const throttle = throttleParts(gpu);
    const mergeThrottle = state.dense && throttle.known && throttle.reasons.length === 0;
    const healthShown = renderHealthNode(
      card.querySelector('[data-role="health"]'),
      gpu,
      mergeThrottle ? [t('gpu.throttle.none')] : [],
    );
    const throttleNode = card.querySelector('[data-role="throttle"]');
    if (mergeThrottle && healthShown) {
      throttleNode.replaceChildren();
      throttleNode.dataset.signature = '';
    } else {
      syncThrottleChips(throttleNode, gpu);
    }
  }
}

/**
 * 硬件健康那一行：显存纠错（ECC）+ 行重映射 + XID。
 *
 * 写什么全部交给 healthParts()（纯计算，单独测），这里只管落到 DOM。
 * extraParts 是紧凑版并进来的「无节流」这类补充说明。
 *
 * @returns {boolean} 这一行最终是否可见——调用方要知道，否则会把"无节流"
 *   并进一行根本不显示的文本里，节流状态就丢了。
 */
function renderHealthNode(node, gpu, extraParts = []) {
  const view = healthParts(gpu, { relativeText: fmtRelative });
  const parts = extraParts.length > 0 ? view.parts.concat(extraParts) : view.parts;
  const visible = view.visible || parts.length > 0;
  node.hidden = !visible;
  if (!visible) return false;
  node.dataset.tone = view.tone;
  node.textContent = parts.join(' · ');
  return true;
}

/* ---------- 渲染：进程表与过滤 ---------- */
function renderProcFilter() {
  const options = [{ value: 'all', label: t('range.all') }].concat(
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

/** 进程行的身份：这几个字段任一变化才算"换了个进程"，值得重建那一行 */
function procRowKey(proc) {
  return [proc.gpuIndex, proc.pid, proc.user, proc.name, proc.service, proc.containerName, proc.cmdline]
    .join('|');
}

/**
 * 建一行进程表。返回两个"每秒会变"的格子，供复用那一支直接改 textContent。
 */
function buildProcRow(proc, gpu) {
  const ratio = gpu && gpu.memTotalMiB ? (proc.usedMemMiB / gpu.memTotalMiB) * 100 : null;
  const row = document.createElement('tr');

  const tdGpu = document.createElement('td');
  const tag = document.createElement('span');
  tag.className = 'gpu-tag';
  tag.textContent = proc.gpuIndex == null ? t('common.unknown') : `GPU ${proc.gpuIndex}`;
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

  row.append(tdGpu, tdPid, tdName, serviceCell(proc), tdMem, tdRatio);
  return { row, cells: { mem: tdMem, ratio: tdRatio } };
}

function renderProcTable() {
  const gpusByIndex = new Map(state.gpus.map((gpu) => [gpu.index, gpu]));
  const rows = state.processes.filter((proc) => state.filter === 'all' || String(proc.gpuIndex) === state.filter);

  // 行身份（哪张卡、哪个进程、属于谁）没变就只更新"显存占用 / 占该卡比例"两格。
  // 每秒整表重建的代价不只是创建节点：鼠标悬停会闪、正文选不中、焦点会掉——
  // 而进程来来去去其实很慢，大多数周期里只有数值在动。
  const signature = rows.map(procRowKey).join('\u0001');
  if (signature !== state.procSignature) {
    refs.procBody.replaceChildren();
    state.procNodes = [];
    for (const proc of rows) {
      const { row, cells } = buildProcRow(proc, gpusByIndex.get(proc.gpuIndex));
      refs.procBody.appendChild(row);
      state.procNodes.push(cells);
    }
    state.procSignature = signature;
  } else {
    rows.forEach((proc, index) => {
      const cells = state.procNodes[index];
      if (!cells) return;
      const gpu = gpusByIndex.get(proc.gpuIndex);
      const mem = fmtMiB(proc.usedMemMiB);
      if (cells.mem.textContent !== mem) cells.mem.textContent = mem;
      const ratio = gpu && gpu.memTotalMiB ? fmtPct((proc.usedMemMiB / gpu.memTotalMiB) * 100, 1) : '--';
      if (cells.ratio.textContent !== ratio) cells.ratio.textContent = ratio;
    });
  }

  const empty = rows.length === 0;
  refs.procEmpty.hidden = !empty;
  refs.procTableWrap.hidden = empty;

  if (empty) {
    if (state.meta?.processWarning) {
      refs.procEmptyText.textContent = backendText(state.meta.processWarning);
    } else if (state.filter !== 'all') {
      refs.procEmptyText.textContent = t('proc.empty.filtered', { index: state.filter });
    } else {
      refs.procEmptyText.textContent = t('proc.empty.text');
    }
  }

  const total = state.processes.length;
  refs.procSub.textContent = state.filter === 'all'
    ? t('proc.sub.all', { total })
    : t('proc.sub.filtered', { index: state.filter, shown: rows.length, total });
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
  tag.textContent = index == null ? t('common.unknown') : `GPU ${index}`;
  td.appendChild(tag);
  return td;
}

function procNameCell(name) {
  const td = document.createElement('td');
  const span = document.createElement('span');
  span.className = 'proc-name';
  span.textContent = name || t('proc.unknownProcess');
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
    proc.user ? t('proc.hint.user', { user: proc.user }) : null,
    proc.cmdline && proc.cmdline !== proc.name ? t('proc.hint.cmdline', { cmd: proc.cmdline }) : null,
    proc.containerId && !proc.containerName ? t('proc.hint.containerId', { id: proc.containerId }) : null,
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
      // 换区间就回到第一页：上一个区间的"已加载条数"对新区间没有意义
      state.processHistory.limit = PROC_HIST_PAGE;
      renderProcHistRange();
      loadProcessHistory();
    });
    refs.procHistRange.appendChild(button);
  }
  refs.procHistRange.dataset.signature = signature;
}

/**
 * 占用下限的快捷选项。
 * 这是查询侧过滤——库里一条都不少，只是页面上不看小的那些；真想少写库用 --proc-min。
 */
function renderProcHistMin() {
  const history = state.processHistory;
  // 服务端给了 --proc-min 时把它并进选项里，否则用户看不到自己实际设了多大的下限
  const serverMin = state.meta?.storage?.procMinMiB || 0;
  const options = [...PROC_HIST_MIN_PRESETS];
  if (serverMin > 0 && !options.some((item) => item.value === serverMin)) {
    options.push({ value: serverMin, label: `≥ ${fmtMiB(serverMin)}` });
    options.sort((a, b) => a.value - b.value);
  }
  if (history.minMiB == null) history.minMiB = serverMin;

  const signature = `${options.map((item) => item.value).join('|')}#${history.minMiB}`;
  if (refs.procHistMin.dataset.signature === signature) return;
  refs.procHistMin.replaceChildren();
  for (const item of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = item.label;
    button.dataset.value = String(item.value);
    button.setAttribute('aria-pressed', item.value === history.minMiB ? 'true' : 'false');
    button.addEventListener('click', () => {
      if (state.processHistory.minMiB === item.value) return;
      state.processHistory.minMiB = item.value;
      state.processHistory.limit = PROC_HIST_PAGE;
      renderProcHistMin();
      loadProcessHistory();
    });
    refs.procHistMin.appendChild(button);
  }
  refs.procHistMin.dataset.signature = signature;
}

async function loadProcessHistory() {
  const history = state.processHistory;
  if (!(history.limit > 0)) history.limit = PROC_HIST_PAGE;
  history.loading = true;
  history.error = null;
  renderProcHistory();
  try {
    const params = new URLSearchParams({ range: history.range, limit: String(history.limit) });
    if (history.minMiB > 0) params.set('min', String(history.minMiB));
    const data = await fetchJson(`/api/processes?${params.toString()}`);
    history.rows = data.processes || [];
    history.total = data.total ?? history.rows.length;
    // 服务端可能因为更小的 --proc-min 而过滤掉一些行，这里如实记下实际生效的下限
    history.effectiveMin = data.minMiB ?? 0;
    // 没启用历史库时后端会明确说原因，这里如实显示，而不是给个空表让人以为"这段时间没进程"。
    // 存**原文**、渲染时才翻译：翻译结果存进 state 的话，切语言后这一段会留在旧语言里。
    // '' 表示"确实是内存模式，但后端没给原因"，渲染时用默认说法兜底
    history.notice = data.source === 'memory' ? (data.reason || '') : null;
  } catch (error) {
    history.rows = [];
    history.total = 0;
    history.notice = null;
    history.error = error.message;
  } finally {
    history.loading = false;
  }
  renderProcHistory();
}

function renderProcHistory() {
  const history = state.processHistory;
  const label = PROC_HIST_RANGES.find((item) => item.value === history.range)?.label || history.range;
  const rows = history.rows || [];
  const noticeText = history.notice === null
    ? null
    : (backendText(history.notice) || t('procHist.noStore'));
  const errorText = history.error ? t('procHist.readFailed', { message: history.error }) : null;

  if (history.loading) refs.procHistSub.textContent = t('procHist.sub.loading', { label });
  else if (errorText) refs.procHistSub.textContent = errorText;
  else if (noticeText) refs.procHistSub.textContent = t('procHist.sub.notice', { label, notice: noticeText });
  else if (history.total === 0) refs.procHistSub.textContent = t('procHist.sub.empty', { label });
  else {
    const shown = history.total > rows.length ? t('procHist.sub.shown', { n: rows.length }) : '';
    const min = history.effectiveMin > 0 ? t('procHist.sub.min', { min: fmtMiB(history.effectiveMin) }) : '';
    refs.procHistSub.textContent = t('procHist.sub.total', {
      label, total: history.total, min, shown,
    });
  }

  refs.procHistBody.replaceChildren();
  const empty = rows.length === 0;
  refs.procHistWrap.hidden = empty;
  refs.procHistEmpty.hidden = !empty;
  // 「加载更多」只在还有没取回来的记录时出现
  const more = !empty && history.total > rows.length && rows.length < PROC_HIST_MAX;
  refs.procHistMore.hidden = !more;
  if (more) {
    refs.procHistMoreHint.textContent = t('procHist.moreHint', { shown: rows.length, total: history.total });
  }
  if (empty) {
    refs.procHistEmptyTitle.textContent = (errorText || noticeText)
      ? t('procHist.empty.unavailable')
      : t('procHist.empty.none');
    refs.procHistEmptyText.textContent = errorText
      || noticeText
      || (history.effectiveMin > 0
        ? t('procHist.empty.minHint', { min: fmtMiB(history.effectiveMin) })
        : t('procHist.empty.text'));
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
  if (!idle.idleAfterMs) return t('meta.cadence.fixed');
  const seconds = Math.round(idle.idleAfterMs / 1000);
  if (idle.active) return t('meta.cadence.idleNow', { ms: idle.currentIntervalMs });
  return t('meta.cadence.live', { seconds, ms: idle.idleIntervalMs });
}

function describeFields(meta) {
  const fields = meta.fields;
  if (!fields) return '--';
  if (!fields.enabled) return t('meta.fields.disabled');
  if (fields.mock) return t('meta.fields.mock', { n: fields.count });
  if (fields.extended == null) return t('meta.fields.probing');
  if (fields.extended) return t('meta.fields.all', { n: fields.count });
  return t('meta.fields.partial', { n: fields.count, skipped: fields.unsupported.length });
}

function describeChannel(meta) {
  if (meta.push && meta.push.enabled === false) return t('meta.channel.pollNoPush');
  if (state.pushActive) {
    const subscribers = meta.push?.subscribers;
    return t('meta.channel.sse', {
      subscribers: subscribers ? tn('meta.channel.sseSubscribers', subscribers) : '',
    });
  }
  return t('meta.channel.pollDisconnected');
}

function describeStorage(meta) {
  const storage = meta.storage;
  if (!storage) return '--';
  if (storage.mode === 'disabled') return t('meta.storage.disabled');
  if (storage.mode !== 'sqlite') {
    // reason 大多来自后端（见 backend-text.js），认不出就原样显示
    return t('meta.storage.unavailable', {
      reason: backendText(storage.reason) || t('meta.storage.unknownReason'),
    });
  }
  const parts = [];
  if (storage.path) parts.push(storage.path);
  if (storage.sizeBytes != null) parts.push(fmtBytes(storage.sizeBytes));
  if (storage.written) parts.push(tn('meta.storage.written', storage.written.gpu));
  if (storage.oldestTs) parts.push(t('meta.storage.oldest', { time: fmtDateTime(storage.oldestTs) }));
  parts.push(storage.retentionDays > 0
    ? t('meta.storage.retention', { days: storage.retentionDays })
    : t('meta.storage.forever'));
  if (storage.storeIntervalMs) {
    parts.push(t('meta.storage.storeInterval', { seconds: Math.round(storage.storeIntervalMs / 1000) }));
  }
  // 只有可回收空间足够大才提示：稳态运行时这个值很小，提示了反而是噪音
  if (storage.freelistBytes > 32 * 1024 * 1024) {
    parts.push(t('meta.storage.reclaim', { size: fmtBytes(storage.freelistBytes) }));
  }
  return parts.join(' · ');
}

/**
 * XID 的读取状态。
 * 这一行存在的意义是区分"没有错误"和"看不到错误"——读不到内核日志时，
 * 界面上必须说清楚是权限问题，否则会被理解成"这块卡很干净"。
 */
function describeXid(meta) {
  const xid = meta?.xidStatus;
  if (!xid) return '--';
  if (meta?.mock) return t('meta.xid.mock');
  if (!xid.available) return backendText(xid.error) || t('meta.xid.unreadable');
  const source = xid.source === 'journalctl' ? 'journalctl' : 'dmesg';
  const parts = [t('meta.xid.read', { source })];
  parts.push(t('meta.xid.total', { n: xid.total }));
  if (xid.updatedAt) parts.push(t('alerts.summary.checkedAt', { time: fmtClock(xid.updatedAt) }));
  return parts.join(' · ');
}

function describeAlerts(meta) {
  const alerts = meta.alerts;
  if (!alerts) return '--';
  if (!alerts.enabled) {
    if (alerts.problems?.length) {
      return t('meta.alerts.disabledWith', { detail: alerts.problems.join(t('common.listSeparator')) });
    }
    return t('meta.alerts.disabledWith', { detail: alerts.reason || t('meta.alerts.noRules') });
  }
  const parts = [t('meta.alerts.ruleCount', { n: alerts.ruleCount })];
  if (alerts.dryRun) parts.push(t('meta.alerts.dryRun'));
  if (alerts.autoReload) parts.push(t('alerts.summary.autoReload'));
  if (alerts.cooldownMs) {
    parts.push(t('alerts.summary.cooldown', { minutes: Math.round(alerts.cooldownMs / 60000) }));
  }
  parts.push(alerts.firing.length
    ? t('meta.alerts.firing', { n: alerts.firing.length })
    : t('alerts.live.none'));
  // 长周期（for 超过内存窗口）规则的判定数据来自哪里，值得写清楚
  const history = alerts.history;
  if (history?.enabled) {
    const granularity = history.step > 0
      ? t('meta.alerts.bucketed', { minutes: Math.round(history.step / 60000) })
      : t('meta.alerts.rawGranularity');
    parts.push(t('meta.alerts.longFromStore', { n: history.longRuleCount, granularity }));
    if (history.truncated) parts.push(t('meta.alerts.truncated'));
    if (history.lastError) parts.push(t('meta.alerts.historyFailed', { message: history.lastError }));
  } else if (history?.longRuleCount > 0) {
    parts.push(t('meta.alerts.longFromMemory', { n: history.longRuleCount }));
  }
  if (alerts.notifiedCount) parts.push(tn('alerts.summary.notified', alerts.notifiedCount));
  if (alerts.problems?.length) parts.push(t('alerts.badge.skipped', { n: alerts.problems.length }));
  if (alerts.lastError) parts.push(alerts.lastError);
  return parts.join(' · ');
}

function renderMeta() {
  const meta = state.meta || {};
  const rows = [
    [t('meta.row.hostname'), meta.hostname || '--'],
    [t('meta.row.platform'), meta.platform ? t('meta.row.platformValue', { label: meta.platform.label, arch: meta.platform.arch, node: meta.platform.nodeVersion || '--' }) : '--'],
    [t('meta.row.driver'), meta.driverVersion || '--'],
    [t('meta.row.interval'), meta.intervalMs ? `${meta.intervalMs} ms` : '--'],
    [t('meta.row.cadence'), describeCadence(meta)],
    [t('meta.row.channel'), describeChannel(meta)],
    [t('meta.row.window'), meta.windowSamples
      ? t('meta.row.windowValue', {
        points: meta.windowSamples,
        seconds: Math.round(meta.windowSamples * (meta.intervalMs || 1000) / 1000),
      })
      : '--'],
    [t('meta.row.cached'), meta.samples == null ? '--' : t('meta.row.points', { n: meta.samples })],
    [t('meta.row.collectCost'), meta.collectMs == null ? '--' : `${meta.collectMs} ms`],
    [t('meta.row.uptime'), fmtDuration(meta.uptimeSec)],
    [t('meta.row.extended'), describeFields(meta)],
    [t('meta.row.system'), meta.systemEnabled === false
      ? t('sys.sub.closed')
      : meta.system
        ? t('meta.row.systemOn', {
          detail: (meta.system.unsupported || []).length
            ? t('meta.row.systemOnPartial', {
              fields: meta.system.unsupported.map((key) => SYSTEM_FIELD_LABELS[key] || key).join(' / '),
            })
            : '',
        })
        : t('kpi.waiting')],
    [t('meta.row.storage'), describeStorage(meta)],
    [t('meta.row.xid'), describeXid(meta)],
    [t('meta.row.alerts'), describeAlerts(meta)],
    [t('meta.row.source'), meta.mock
      ? t('meta.row.sourceMock')
      : meta.collector?.bin
        ? t('meta.row.sourceBin', { bin: meta.collector.bin, source: meta.collector.source || t('meta.row.sourceCustom') })
        : t('meta.row.sourceMissing')],
    [t('meta.row.updated'), state.lastSampleAt
      ? t('meta.row.updatedValue', { time: fmtClock(state.lastSampleAt), rel: fmtRelative(state.lastSampleAt) })
      : '--'],
  ];
  if (!meta.mock && meta.collector?.tried?.length && !meta.collector?.bin) {
    rows.splice(rows.length - 1, 0, [
      t('meta.row.tried'),
      meta.collector.tried
        .map((item) => t('meta.row.triedItem', { bin: item.bin, result: item.result }))
        .join(t('common.listSeparator')),
    ]);
  }
  // 这 17 行里只有「最近更新」「服务运行时长」「已缓存采样点」这类每秒在变，
  // 其余（主机名、平台、驱动、采集间隔…）几乎不动——按标签复用节点，值没变就不碰 DOM
  syncLabelValueRows(refs.metaList, rows, { rowClass: 'meta__row' });
}

/* ---------- 主渲染 ---------- */
function render() {
  renderStatus();
  renderNotice(state.meta);
  renderAlerts(state.meta);
  renderKpis();
  renderCharts();
  renderServiceChart();
  renderSystemCard();
  renderInference();
  renderInferencePage();
  renderGpuCards();
  renderProcFilter();
  renderProcTable();
  renderMeta();
  // 放在这里而不是 boot：服务端的 --proc-min 要等第一帧 /api/state 才知道
  renderProcHistMin();

  const windowSeconds = Math.round(state.windowSamples * state.intervalMs / 1000);
  const windowText = t('time.duration.seconds', { s: windowSeconds });
  const idleNote = state.meta?.idle?.active
    ? t('app.orient.idleNote', { ms: state.meta.idle.currentIntervalMs })
    : '';
  if (state.gpus.length) {
    refs.orientSub.textContent = t('app.orient.summary', {
      host: state.meta?.hostname || '--',
      gpus: tn('app.orient.gpus', state.gpus.length),
      interval: state.intervalMs,
      window: windowText,
      idle: idleNote,
      time: fmtClock(state.lastSampleAt),
    });
  } else if (state.status === 'error' || state.status === 'unreachable') {
    const host = state.meta?.hostname ? `${state.meta.hostname} · ` : '';
    const tail = state.lastSampleAt
      ? t('app.orient.stalled', { rel: fmtRelative(state.lastSampleAt) })
      : t('app.orient.noDataYet');
    refs.orientSub.textContent = `${host}${
      state.status === 'unreachable' ? t('notice.unreachable.title') : t('notice.title')
    } · ${tail}`;
  } else {
    refs.orientSub.textContent = t('app.connecting');
  }

  const sources = [state.meta?.mock ? t('app.source.mock') : 'nvidia-smi'];
  if (state.meta?.systemEnabled !== false) sources.push(t('app.source.host'));
  if (state.meta?.inference?.loaded) sources.push('vLLM');
  const storage = state.meta?.storage;
  if (storage?.mode === 'sqlite') {
    const keep = storage.retentionDays > 0
      ? t('app.footer.pruned', { days: storage.retentionDays })
      : t('app.footer.keepForever');
    refs.footerText.textContent = t('app.footer.withStore', {
      sources: sources.join(' + '),
      points: state.windowSamples,
      window: windowText,
      interval: Math.round(storage.storeIntervalMs / 1000),
      path: storage.path || t('app.footer.storeName'),
      keep,
    });
  } else if (storage) {
    refs.footerText.textContent = t('app.footer.noStore', {
      sources: sources.join(' + '),
      points: state.windowSamples,
      window: windowText,
      reason: backendText(storage.reason) || '--no-db',
    });
  } else {
    refs.footerText.textContent = t('app.footer.memoryOnly', {
      sources: sources.join(' + '),
      points: state.windowSamples,
      window: windowText,
    });
  }

  // 放在最后：这时各卡的内容才都渲染完，量出来的高度才是准的
  syncEvidenceSticky();
}

/* ---------- 交互 ---------- */
function renderRangePicker() {
  const signature = `${getLang()}#${state.range}`;
  if (refs.rangePicker.dataset.signature === signature) return;
  refs.rangePicker.dataset.signature = signature;
  refs.rangeLive?.setAttribute('aria-pressed', state.range === 'live' ? 'true' : 'false');
  if (refs.rangeHours) refs.rangeHours.dataset.placeholder = t('range.group.hours');
  if (refs.rangeDays) refs.rangeDays.dataset.placeholder = t('range.group.days');

  const hourValue = HOUR_RANGES.some((item) => item.value === state.range) ? state.range : null;
  const dayValue = DAY_RANGES.some((item) => item.value === state.range) ? state.range : null;

  if (hoursRangeDropdown) {
    if (hourValue) hoursRangeDropdown.setValue(hourValue);
    else hoursRangeDropdown.clear();
    hoursRangeDropdown.refresh();
  }
  if (daysRangeDropdown) {
    if (dayValue) daysRangeDropdown.setValue(dayValue);
    else daysRangeDropdown.clear();
    daysRangeDropdown.refresh();
  }
}

function resetSeries() {
  state.series.clear();
  state.systemSeries = { t: [], cpu: [], mem: [] };
  state.serviceRows = [];
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
    const memory = history.samples || [];
    let grid = null;
    try {
      grid = await backfillLiveWindow(memory);
    } catch {
      // 补不出来就算了，内存窗口该有的部分照常显示
    }
    // 顺序很重要：先早的（库里补出来的），再新的（内存里的）。
    // 反过来的话曲线会按时间倒着排，看着完全乱掉
    for (const sample of grid || []) appendSample(sample, { force: true });
    for (const sample of memory) appendSample(sample, { force: true });
  } catch {
    // 回填失败不影响后续实时帧继续进来
  }
}

/**
 * 用历史库把实时窗口**前面的**那一段补出来。
 *
 * 服务一重启，内存窗口就是空的，实时曲线得干等一整个窗口才长出形状——
 * 但库里其实一直有数据（粒度粗一些）。所以这里补上重启后那段空白。
 *
 * 两条边界：只补"内存窗口之前"，不覆盖内存里已有的部分（内存里的粒度更细，
 * 用库里的粗粒度盖上去反而更差）；拿不到历史库就返回 null，交给调用方退回内存窗口。
 */
async function backfillLiveWindow(memory) {
  const windowMs = state.windowSamples * state.intervalMs;
  const newest = memory.length ? memory[memory.length - 1].t : (state.lastSampleAt || Date.now());
  const boundary = memory.length ? memory[0].t : newest;
  const from = newest - windowMs;
  // 内存窗口已经够满，没什么可补的
  if (boundary - from < state.intervalMs) return null;

  const data = await fetchJson(`/api/history?from=${from}&to=${boundary}`);
  if (data.source !== 'db') return null;
  return resampleToGrid(data.samples || [], { from, to: boundary, intervalMs: state.intervalMs });
}

const HISTORY_CLIENT_CACHE_MS = 5 * 60 * 1000;

function applyHistoryRange(data) {
  // 只有拿到完整的新数据后才替换旧曲线。请求期间保留上一次的范围，
  // 用户不会看到一条突然清空的图。
  resetSeries();
  state.historyPoints = data.points ?? 0;
  state.historyStep = data.step ?? null;
  state.historyTruncated = Boolean(data.truncated);
  // 没启用历史库时会走内存窗口，这里如实说明而不是画一条假的区间
  state.historyNotice = data.source === 'memory' ? { reason: data.reason || '' } : null;
  for (const sample of data.samples || []) appendSample(sample, { force: true });
  state.historyLoading = false;
  render();
}

async function loadHistoryRange(range) {
  historyFetchController?.abort();
  historyFetchController = null;
  const cached = state.historyCache.get(range);
  if (cached && Date.now() - cached.at < HISTORY_CLIENT_CACHE_MS) {
    applyHistoryRange(cached.data);
    return;
  }

  // 连续点多个时间按钮时，只保留最后一次请求；旧请求直接取消。
  const controller = new AbortController();
  historyFetchController = controller;
  state.historyLoading = true;
  renderRangePicker();
  render();

  try {
    // fields=basic 只取画图实际需要的字段，避免把 ECC/XID 等扩展字段塞进 6MB 响应。
    const data = await fetchJson(
      `/api/history?range=${encodeURIComponent(range)}&fields=basic`,
      { signal: controller.signal },
    );
    if (state.range !== range) return;
    state.historyCache.set(range, { at: Date.now(), data });
    applyHistoryRange(data);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    // 失败时保留旧图，只更新提示，避免“切换失败后整张图消失”。
    state.historyNotice = { error: error.message };
  } finally {
    if (historyFetchController === controller) {
      historyFetchController = null;
      state.historyLoading = false;
      render();
    }
  }
}

async function selectRange(value) {
  if (value === state.range) return;
  state.range = value;
  renderRangePicker();
  if (value === 'live') {
    historyFetchController?.abort();
    historyFetchController = null;
    state.historyLoading = false;
    await reloadLiveWindow();
    render();
    return;
  }
  await loadHistoryRange(value);
}

function triggerDownload(path, params = new URLSearchParams()) {
  const query = params.toString();
  const url = query ? `${path}?${query}` : path;
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/* ---------- 展示模式：单页 / 导航 ---------- */
// 单页是把 7 张卡一屏铺开（看趋势和状态方便对照），导航是按用途分页签、
// 每页一到两张卡（排查时不用滚六屏）。两种模式共存，用户自己选，选择记在
// URL 里（能分享、刷新保持）和 localStorage 里（下次打开还是上次那个）。
// 告警面板和整机概览 KPI 不参与分页——它们在任何一页都得看得见。
const VIEW_KEY = 'gpu-monitor-view';
const VIEW_PAGES = ['overview', 'curve', 'processes', 'system', 'inference'];

/** 当前模式从哪来：URL 优先（可分享），其次上次的选择，最后默认单页 */
function readViewChoice() {
  const params = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
  let saved = null;
  try {
    saved = JSON.parse(window.localStorage.getItem(VIEW_KEY) || 'null');
  } catch {
    // 无痕模式 / 存储被禁：只用 URL 和默认值
  }
  const view = params.get('view') || saved?.view || 'single';
  const page = params.get('page') || saved?.page || 'overview';
  return {
    view: view === 'nav' ? 'nav' : 'single',
    page: VIEW_PAGES.includes(page) ? page : 'overview',
  };
}

function setView(view, page) {
  const next = { view: view === 'nav' ? 'nav' : 'single', page: page || state.page };
  try {
    window.localStorage.setItem(VIEW_KEY, JSON.stringify(next));
  } catch {
    // 存不进去也不影响本次切换
  }
  // 用 replaceState 而不是直接改 hash：切页签不该在浏览历史里堆一堆记录
  const hash = next.view === 'nav' ? `#view=nav&page=${next.page}` : '';
  window.history.replaceState(null, '', hash || `${window.location.pathname}${window.location.search}`);
  applyView();
}

function applyView() {
  const choice = readViewChoice();
  state.view = choice.view;
  state.page = choice.page;
  // 导航模式套紧凑顶栏：页头并一行、告警没触发时压一条、KPI 五格并成一条。
  // 只是加个属性，具体怎么压全在 styles.css 的 [data-dense="1"] 里，
  // 单页模式不带这个属性，样式和以前一模一样。
  state.dense = choice.view === 'nav';
  refs.appEl.dataset.dense = state.dense ? '1' : '0';

  for (const card of document.querySelectorAll('.card[data-page]')) {
    card.hidden = choice.view === 'nav' && card.dataset.page !== choice.page;
  }
  refs.viewTopbar.hidden = !state.dense;
  for (const tab of refs.viewNav.querySelectorAll('.view-nav__tab')) {
    if (tab.dataset.page === choice.page) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  // 展示模式是原生下拉：把选中项对上即可（旧版是一组带 aria-pressed 的按钮）
  // 展示模式是自绘下拉：把选中项对齐（不触发它的 onChange，免得绕回来再调一次 setView）
  viewDropdown.setValue(choice.view);

  // 本页某列一张卡都没有时让它占满整行，否则会留一条空白栏
  const visibleIn = (selector) => [...document.querySelectorAll(`${selector} .card[data-page]`)]
    .some((card) => !card.hidden);
  const hasLeft = visibleIn('.work-col');
  const hasRight = visibleIn('.evidence-col');
  refs.work.dataset.cols = hasLeft && hasRight ? 'both' : (hasLeft ? 'left' : 'right');

  // 先作废尺寸缓存与推理历史的绘制签名，再 render：
  // 否则从别的页签切到「推理」时，页面渲染会因为签名没变直接返回，
  // canvas 拿到的是隐藏时的 0 尺寸，图会空白到下一个 15 秒采样点。
  canvasSizeCache = new WeakMap();
  state.inferHistory.signature = '';
  render();
  // 切页签会重建/改变 canvas，旧的悬停索引（和浮窗）作废
  resetChartHover();
  // 顶栏厚薄变了，右列"能不能粘"的判定也要跟着重算
  syncEvidenceSticky();
}

/**
 * 右列比视口还高时，sticky 只会把它的下半截永远裁在屏幕外
 * （实测「采集信息」滚到底也只能看到一半）——那种情况不如让它跟着页面正常滚。
 */
function syncEvidenceSticky() {
  const col = document.querySelector('.evidence-col');
  if (!col) return;
  // 导航模式下顶上还压着一条常驻页签栏，它能用的高度要把这条让出来
  const stickyBar = refs.viewTopbar && !refs.viewTopbar.hidden ? refs.viewTopbar.offsetHeight : 0;
  col.dataset.sticky = col.scrollHeight > window.innerHeight - 48 - stickyBar ? 'off' : 'on';
}

/* ---------- 导出面板 ---------- */
// 页面上只有这一个导出入口：内容 / 时间范围 / 选项都在弹窗里选，
// 免得同一份数据散在好几处按钮上、各自默认的时间范围还不一样。
const EXPORT_ITEMS = [
  {
    id: 'gpu',
    // label / desc 用 getter：这张表是模块级常量，写成固定字符串会把语言冻在加载那一刻
    get label() { return t('export.item.gpu.label'); },
    get desc() { return t('export.item.gpu.desc'); },
    path: '/api/export.csv',
    format: 'CSV',
    // 同一份数据可以按两种布局导出：长表（每行一卡）或宽表（每张卡各占一组列）
    layout: true,
    range: true,
    full: true,
  },
  {
    id: 'host',
    get label() { return t('export.item.host.label'); },
    get desc() { return t('export.item.host.desc'); },
    path: '/api/export.system.csv',
    format: 'CSV',
    range: true,
  },
  {
    id: 'processes',
    get label() { return t('export.item.processes.label'); },
    get desc() { return t('export.item.processes.desc'); },
    path: '/api/export.processes.csv',
    format: 'CSV',
    range: true,
    needsHistory: true,
  },
  {
    id: 'inference',
    get label() { return t('export.item.inference.label'); },
    get desc() { return t('export.item.inference.desc'); },
    path: '/api/export.inference.csv',
    format: 'CSV',
    range: true,
    needsHistory: true,
  },
  {
    id: 'inferenceProbes',
    get label() { return t('export.item.probes.label'); },
    get desc() { return t('export.item.probes.desc'); },
    path: '/api/export.inference-probes.csv',
    format: 'CSV',
    range: true,
    needsHistory: true,
  },
  {
    id: 'snapshot',
    get label() { return t('export.item.snapshot.label'); },
    get desc() { return t('export.item.snapshot.desc'); },
    path: '/api/export.json',
    format: 'JSON',
    // 快照的语义就是"此刻"，带时间范围会让人以为导的是那段时间的数据
    range: false,
  },
];

const EXPORT_RANGES = [
  { value: 'follow', get label() { return t('export.range.follow'); } },
  { value: '1h', get label() { return tn('range.hours', 1); } },
  { value: '24h', get label() { return tn('range.hours', 24); } },
  { value: '7d', get label() { return tn('range.days', 7); } },
  { value: '30d', get label() { return tn('range.days', 30); } },
  { value: '45d', get label() { return tn('range.days', 45); } },
];

const exportChoice = { content: 'gpu', layout: 'long', range: 'follow', full: false };

const EXPORT_LAYOUTS = [
  { value: 'long', get label() { return t('export.layout.long'); } },
  { value: 'wide', get label() { return t('export.layout.wide'); } },
];

function exportItem() {
  return EXPORT_ITEMS.find((item) => item.id === exportChoice.content) || EXPORT_ITEMS[0];
}

function historyAvailable() {
  return state.meta?.storage?.supportsHistory === true;
}

/** 把"跟随曲线"翻译成具体的区间参数；其余选项直接用 range 值 */
function exportRangeParams() {
  const params = new URLSearchParams();
  if (exportChoice.range === 'follow') {
    if (state.range === 'live') params.set('limit', String(state.windowSamples));
    else params.set('range', state.range);
  } else {
    params.set('range', exportChoice.range);
  }
  return params;
}

function rangeLabelOf(value) {
  if (value === 'follow') {
    if (state.range === 'live') {
      return t('export.range.followLive', {
        seconds: Math.round(state.windowSamples * state.intervalMs / 1000),
      });
    }
    const item = RANGES.find((entry) => entry.value === state.range);
    return t('export.range.followWith', { label: item?.label || state.range });
  }
  return EXPORT_RANGES.find((entry) => entry.value === value)?.label || value;
}

function renderExportContent() {
  refs.exportContent.replaceChildren();
  for (const item of EXPORT_ITEMS) {
    const blocked = item.needsHistory && !historyAvailable();
    const option = document.createElement('label');
    option.className = 'export__option';
    option.dataset.disabled = blocked ? 'true' : 'false';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'export-content';
    radio.value = item.id;
    radio.checked = exportChoice.content === item.id;
    radio.disabled = blocked;
    radio.addEventListener('change', () => {
      exportChoice.content = item.id;
      syncExportPanel();
    });
    const text = document.createElement('span');
    text.className = 'export__option-text';
    const title = document.createElement('b');
    title.textContent = item.label;
    const desc = document.createElement('span');
    desc.textContent = blocked
      ? t('export.item.needsHistory')
      : `${item.desc}${t('common.dotSeparator')}${item.format}${
        item.range ? '' : `${t('common.dotSeparator')}${t('export.item.noRange')}`
      }`;
    text.append(title, desc);
    option.append(radio, text);
    refs.exportContent.appendChild(option);
  }
}

function renderExportRange() {
  refs.exportRange.replaceChildren();
  for (const item of EXPORT_RANGES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = item.label;
    button.dataset.value = item.value;
    button.setAttribute('aria-pressed', item.value === exportChoice.range ? 'true' : 'false');
    button.addEventListener('click', () => {
      exportChoice.range = item.value;
      renderExportRange();
      syncExportPanel();
    });
    refs.exportRange.appendChild(button);
  }
}

function renderExportLayout() {
  refs.exportLayout.replaceChildren();
  for (const item of EXPORT_LAYOUTS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = item.label;
    button.dataset.value = item.value;
    button.setAttribute('aria-pressed', item.value === exportChoice.layout ? 'true' : 'false');
    button.addEventListener('click', () => {
      exportChoice.layout = item.value;
      renderExportLayout();
      syncExportPanel();
    });
    refs.exportLayout.appendChild(button);
  }
}

/** 浏览器（也就是看页面的人）所在的时区；取不到就返回空串 */
function ownTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/**
 * 导出弹窗里那行时间口径说明。
 *
 * 服务器的系统时区经常是 UTC（云主机默认如此），而用 Excel 打开文件的人在东八区——
 * 这时 time_local 会和 timestamp_iso 一模一样，看着像"修复没生效"。
 * 所以这里不仅写清时区名，发现两边不一致时直接把补救的启动参数给出来。
 */
function exportTimeHint() {
  const zone = state.meta?.timeZone;
  const fixed = state.meta?.timeZoneFixed === true;
  const own = ownTimeZone();
  const subject = fixed
    ? t('export.time.zoneFixed', { zone })
    : t('export.time.zoneServer', { zone: zone || t('common.unknown') });
  let text = t('export.time.intro', { subject });
  // 判断只看"两边对不对得上"：哪怕时区是显式固定的，只要和看文件的人不一致，
  // 他就一定会把 06:25 当成错误数据——这跟当初是不是有意选的没有关系
  if (zone && own && zone !== own) {
    text += t('export.time.mismatch', { own });
  }
  return text;
}

/** 面板里所有联动都在这里：谁可用、什么被置灰、底下那句话说什么 */
function syncExportPanel() {
  const item = exportItem();
  const canRange = item.range === true;
  const wide = item.layout === true && exportChoice.layout === 'wide';
  // 宽表会变成"每张卡各占一组列"，列数随卡数增长，所以它只带基础指标
  const canFull = item.full === true && historyAvailable() && !wide;

  refs.exportLayoutGroup.hidden = item.layout !== true;
  refs.exportLayoutHint.textContent = wide
    ? t('export.layout.hint.wide')
    : t('export.layout.hint.long');

  refs.exportRangeGroup.dataset.disabled = canRange ? 'false' : 'true';
  for (const button of refs.exportRange.querySelectorAll('.chip')) button.disabled = !canRange;
  refs.exportRangeHint.textContent = canRange
    ? `${t('export.range.hint')}${t('export.range.retention', { days: 45 })}`
    : t('export.range.hintSnapshot', { label: item.label });

  refs.exportFullGroup.dataset.disabled = canFull ? 'false' : 'true';
  refs.exportFull.disabled = !canFull;
  if (!canFull) exportChoice.full = false;
  refs.exportFullHint.textContent = !item.full
    ? t('export.full.hint.onlyGpu')
    : (wide
      ? t('export.full.hint.wide')
      : (historyAvailable()
        ? t('export.full.hint.streamed')
        : t('export.full.hint.noStore')));

  // 时间列有两列，说清楚各自是谁——否则用 Excel 打开看到的是 UTC，会以为数据错了
  refs.exportTimeHint.textContent = item.format === 'CSV' ? exportTimeHint() : '';

  const parts = [t('export.summary.item', { label: item.label, format: item.format })];
  if (wide) parts.push(t('export.layout.wide'));
  if (canFull && exportChoice.full) parts.push(t('export.summary.withExtended'));
  if (canRange) parts.push(rangeLabelOf(exportChoice.range));
  refs.exportSummary.textContent = t('export.summary.prefix', {
    parts: parts.join(' · '),
  });
  refs.exportConfirm.disabled = Boolean(item.needsHistory && !historyAvailable());
}

function openExportPanel() {
  exportChoice.content = 'gpu';
  exportChoice.layout = 'long';
  exportChoice.range = 'follow';
  exportChoice.full = false;
  renderExportContent();
  renderExportLayout();
  renderExportRange();
  syncExportPanel();
  if (typeof refs.exportDialog.showModal === 'function') refs.exportDialog.showModal();
  else refs.exportDialog.setAttribute('open', '');
  refs.exportConfirm.focus();
}

function closeExportPanel() {
  if (typeof refs.exportDialog.close === 'function') refs.exportDialog.close();
  else refs.exportDialog.removeAttribute('open');
}

refs.btnExport.addEventListener('click', openExportPanel);
inferConfigController = createInferenceConfigController({
  onSaved() {
    poll();
  },
});
refs.btnInferConfig?.addEventListener('click', () => inferConfigController.open());

/* 顶栏两个自绘下拉：展示模式与界面语言。
   组件只管开合、键盘、ARIA；选中之后做什么由这里决定。 */
const viewDropdown = enhanceDropdown(refs.viewSwitch, { onChange: (value) => setView(value) });
const langDropdown = enhanceDropdown(refs.langSwitch, { onChange: (value) => setLang(value) });

/* 曲线时间范围：实时按钮 + 小时/天两个下拉，互斥选择。 */
let hoursRangeDropdown = null;
let daysRangeDropdown = null;
hoursRangeDropdown = enhanceDropdown(refs.rangeHours, { onChange: (value) => selectRange(value) });
daysRangeDropdown = enhanceDropdown(refs.rangeDays, { onChange: (value) => selectRange(value) });
refs.rangeLive?.addEventListener('click', () => selectRange('live'));

/* ---------- 界面语言 ---------- */

/**
 * 切语言时，把所有"内容签名"清掉。
 *
 * 这些签名是"内容没变就别重建 DOM"的守卫（见 renderProcTable / renderCharts 等），
 * 而签名里记的是**上一种语言**生成的文本。只刷新静态文案、不清签名，就会出现
 * "卡片标题已经换成英文、表格和脚注还留着中文"的半截效果。
 *
 * 集中在这里清，而不是给 9 处签名各加一个语言前缀：改动只在一处，漏了谁一眼能看出来。
 */
function resetTextSignatures() {
  state.chartSignature = '';
  state.cardSignature = '';
  state.procSignature = null;
  state.ruleSignature = null;
  state.firingSignature = null;
  state.processSignature = null;
  state.inferSignature = '';
  state.inferHistory.signature = '';
  state.inferHistory.cardSignature = '';
  for (const node of [
    refs.rangePicker,
    refs.procFilter,
    refs.procHistRange,
    refs.procHistMin,
    refs.inferHistRange,
    refs.inferHistService,
  ]) {
    if (node?.dataset) node.dataset.signature = '';
  }
}

/** 语言变化的统一入口：静态文案 → 开关状态 → 作废签名 → 用内存里的状态整帧重渲染 */
function applyLanguage(lang) {
  applyStaticI18n(document);
  inferConfigController?.refresh();
  langDropdown.setValue(lang);
  // 展示模式那两个选项的文字也被翻译了，按钮上那行要跟着变（选项本身不重写）
  viewDropdown.refresh();
  resetTextSignatures();
  renderRangePicker();
  // 进程历史卡片不在 render() 的调用链里（它只在"进程身份变化"时单独刷新），
  // 所以切语言时要显式重放一次，否则那一块会留着上一种语言的文字
  renderProcHistRange();
  renderProcHistory();
  render();
}

onLangChange(applyLanguage);
bindMetricTips();
bindInferPager();

refs.viewNav.addEventListener('click', (event) => {
  const tab = event.target.closest('.view-nav__tab');
  if (tab) setView('nav', tab.dataset.page);
});
// 手动改 URL 里的 hash（或从别处点进来）也要跟着切
window.addEventListener('hashchange', () => applyView());
refs.exportClose.addEventListener('click', closeExportPanel);
refs.exportCancel.addEventListener('click', closeExportPanel);
refs.exportFull.addEventListener('change', () => {
  exportChoice.full = refs.exportFull.checked;
  syncExportPanel();
});
refs.exportConfirm.addEventListener('click', () => {
  const item = exportItem();
  const params = item.range ? exportRangeParams() : new URLSearchParams();
  if (item.layout === true && exportChoice.layout === 'wide') params.set('layout', 'wide');
  if (item.id === 'gpu' && exportChoice.full) params.set('fields', 'full');
  closeExportPanel();
  triggerDownload(item.path, params);
});
refs.btnRetry.addEventListener('click', () => poll());

// 服务曲线与系统曲线是常驻 canvas，挂一次就够（各卡曲线是动态建的，在 renderCharts 里挂）
attachChartHover(refs.svcCanvas);
attachChartHover(refs.sysCanvas);

// 加载更多：把取回条数加一页再拉一次。服务端每次都按"最近 N 条"返回，
// 所以这里不会出现重复行，也不需要前端拼接
refs.procHistMoreBtn.addEventListener('click', async () => {
  const history = state.processHistory;
  if (history.loading) return;
  refs.procHistMoreBtn.disabled = true;
  history.limit = Math.min(PROC_HIST_MAX, history.limit + PROC_HIST_PAGE);
  await loadProcessHistory();
  refs.procHistMoreBtn.disabled = false;
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    // canvas 的尺寸缓存跟着窗口失效（drawLines 靠它省掉每次的强制重排）
    canvasSizeCache = new WeakMap();
    renderCharts();
    renderServiceChart();
    renderSystemCard();
    // 窗口一变，右列能用的高度也变了（导航模式下还得减去常驻页签栏）
    syncEvidenceSticky();
  }, 180);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !state.pushActive) poll();
});

async function boot() {
  // 先把"还没有数据"的画面按当前语言渲染一遍。
  // HTML 里写死的默认文案是中文（"等待采集""占用率 --"……），这些节点又都由渲染函数
  // 每秒重写，所以不能挂 data-i18n——只能在这里主动渲染一次，否则英文界面在首帧数据
  // 到达前（正常不到 1 秒，服务异常时更久）会闪一段中文。
  render();
  // 进程历史那几张卡不在 render() 的调用链里（它的数据源是独立的 /api/processes，
  // 只在"进程身份变化"或手动刷新时重画），所以得单独铺一次——先标成"读取中"，
  // 等 loadProcessHistory() 真正发起请求时会自己重画
  state.processHistory.loading = true;
  renderProcHistory();
  renderRangePicker();
  renderProcHistRange();
  renderProcHistMin();
  // 与"切回实时"走同一条路：它内部会先从库里补出重启后那段空白
  await reloadLiveWindow();
  await poll();
  // 模式要在第一帧数据之后应用：applyView 会重绘 canvas，那时画布才有尺寸
  applyView();
  // 进程历史是独立的一次性拉取：开页拉一次，之后靠"进程身份变化"触发重载
  loadProcessHistory();
  // 兜底：页面开很久时"最近 24 小时"这个窗口会滑动，偶尔刷一次让边界跟上。
  // 这个间隔可以很宽松——新事件已经由 noteProcessIdentity() 负责了
  window.setInterval(() => {
    if (!document.hidden && !state.processHistory.loading) loadProcessHistory();
  }, 15 * 60 * 1000);
  // 先用轮询兜住，再尝试升级成 SSE 推送；推送连上后会自动停掉轮询
  schedulePolling();
  startPush();
}

// 语言必须在第一次渲染之前定下来：URL 显式指定 → 上次选择 → 浏览器偏好 → 中文。
// 静态文案先刷一遍，免得首帧之前页面停在 HTML 里写死的那种语言上。
initI18n({
  search: location.search,
  hash: location.hash,
  navigatorLang: navigator.language,
});
applyStaticI18n(document);
// 语言下拉先对齐到刚定下来的语言（选项文字此时已经是当前语言）
langDropdown.setValue(getLang());
// 展示模式按钮上那行"当前值"是从选项文字里读出来的，也要在首帧之前刷一次：
// HTML 里写死的默认值是中文，英文界面下不刷就会先闪一个"单页"（等 applyView 跑到才变）
viewDropdown.refresh();

boot();
