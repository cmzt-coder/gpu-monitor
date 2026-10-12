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
  btnRetry: $('btn-retry'),
  btnRefresh: $('btn-refresh'),
  btnCsv: $('btn-csv'),
  btnJson: $('btn-json'),
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
  emptyTitle: $('empty-title'),
  emptyText: $('empty-text'),
  procSub: $('proc-sub'),
  procFilter: $('proc-filter'),
  procTableWrap: $('proc-table-wrap'),
  procBody: $('proc-body'),
  procEmpty: $('proc-empty'),
  procEmptyText: $('proc-empty-text'),
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
  chartNodes: new Map(),
  chartSignature: '',
  cardNodes: new Map(),
  cardSignature: '',
  lastSampleAt: null,
  fetchedAt: null,
  consecutiveErrors: 0,
  stopped: false,
};

const HIGH_THRESHOLD = 90;

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

/* ---------- 数据接入 ---------- */
function appendSample(sample) {
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
    const overflow = series.t.length - state.windowSamples;
    if (overflow > 0) {
      series.t.splice(0, overflow);
      series.mem.splice(0, overflow);
      series.util.splice(0, overflow);
    }
  }
  // 不再出现的卡（热插拔/掉卡）清掉，避免曲线残留
  for (const key of [...state.series.keys()]) {
    if (!seen.has(key)) state.series.delete(key);
  }
  state.lastSampleAt = sample.t;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function poll() {
  try {
    const data = await fetchJson('/api/state');
    state.fetchedAt = Date.now();
    state.consecutiveErrors = 0;
    state.status = data.status;
    state.intervalMs = data.intervalMs || state.intervalMs;
    state.windowSamples = data.windowSamples || state.windowSamples;
    state.gpus = data.gpus || [];
    state.processes = data.processes || [];
    state.meta = data;
    if (state.gpus.length > 0) {
      appendSample({ t: data.ts || Date.now(), gpus: state.gpus });
    }
    render();
  } catch (error) {
    state.consecutiveErrors += 1;
    state.status = 'unreachable';
    state.meta = { ...(state.meta || {}), error: `无法连接采集服务（${error.message}）` };
    render();
  }
}

function schedule() {
  if (state.stopped) return;
  window.setTimeout(async () => {
    if (!document.hidden) await poll();
    schedule();
  }, Math.max(400, state.intervalMs));
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
  const [tone, text] = map[state.status] || ['loading', '连接中'];
  const stale = state.status === 'error' || state.status === 'unreachable';
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
  refs.kpiTempFoot.dataset.tone = maxTemp != null && maxTemp >= 85 ? 'danger' : maxTemp != null && maxTemp >= 75 ? 'warning' : '';

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
    soft: cssVar('--jf-color-signal-soft', '#aaddfd'),
  };
}

function drawChart(canvas, series, windowSamples) {
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

  // 横向网格与右侧刻度
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

  const count = series.mem.length;
  const xAt = (i) => pad.left + plotW * (1 - (count - 1 - i) / (slots - 1));
  const yAt = (value) => pad.top + plotH * (1 - Math.min(100, Math.max(0, value)) / 100);

  if (count >= 2) {
    // 显存占用：面积 + 主线
    const area = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    area.addColorStop(0, 'rgba(0, 91, 172, 0.20)');
    area.addColorStop(1, 'rgba(0, 91, 172, 0.02)');
    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(series.mem[0]));
    for (let i = 1; i < count; i += 1) ctx.lineTo(xAt(i), yAt(series.mem[i]));
    ctx.lineTo(xAt(count - 1), pad.top + plotH);
    ctx.lineTo(xAt(0), pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = area;
    ctx.fill();

    ctx.beginPath();
    ctx.strokeStyle = colors.primary;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.moveTo(xAt(0), yAt(series.mem[0]));
    for (let i = 1; i < count; i += 1) ctx.lineTo(xAt(i), yAt(series.mem[i]));
    ctx.stroke();

    // GPU 利用率：细线
    ctx.beginPath();
    ctx.strokeStyle = colors.signal;
    ctx.lineWidth = 1.5;
    ctx.moveTo(xAt(0), yAt(series.util[0]));
    for (let i = 1; i < count; i += 1) ctx.lineTo(xAt(i), yAt(series.util[i]));
    ctx.stroke();

    // 最新值端点
    const lastX = xAt(count - 1);
    ctx.beginPath();
    ctx.arc(lastX, yAt(series.mem[count - 1]), 3, 0, Math.PI * 2);
    ctx.fillStyle = colors.primary;
    ctx.fill();
  }

  // 90% 警戒线
  const limitY = yAt(HIGH_THRESHOLD);
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = colors.danger;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, Math.round(limitY) + 0.5);
  ctx.lineTo(pad.left + plotW, Math.round(limitY) + 0.5);
  ctx.stroke();
  ctx.restore();

  // 时间轴两端
  ctx.fillStyle = colors.muted;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const firstTime = count > 0 ? fmtClock(series.t[0]) : '--:--:--';
  ctx.fillText(firstTime, pad.left, pad.top + plotH + 5);
  ctx.textAlign = 'right';
  ctx.fillText('现在', pad.left + plotW, pad.top + plotH + 5);
}

function renderCharts() {
  const gpus = state.gpus;
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
      canvas.setAttribute('aria-label', `GPU ${gpu.index} 最近 ${Math.round(state.windowSamples * state.intervalMs / 1000)} 秒的显存占用与利用率曲线`);
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
    tempStat.dataset.tone = gpu.tempC != null && gpu.tempC >= 85 ? 'danger' : '';
    if (series) drawChart(node.canvas, series, state.windowSamples);
  }
}

/* ---------- 渲染：各卡当前占用 ---------- */
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
        </div>`;
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
    card.querySelector('[data-role="temp"]').textContent = gpu.tempC == null ? '温度 --' : `温度 ${Math.round(gpu.tempC)}°C`;
    card.querySelector('[data-role="power"]').textContent = gpu.powerW == null ? '功耗 --' : `功耗 ${Math.round(gpu.powerW)} W`;
  }
}

/* ---------- 渲染：进程表与过滤 ---------- */
function renderProcFilter() {
  const options = [{ value: 'all', label: '全部' }].concat(
    state.gpus.map((gpu) => ({ value: String(gpu.index), label: `GPU ${gpu.index}` })),
  );
  const current = refs.procFilter.dataset.value || 'all';
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

    tr.append(tdGpu, tdPid, tdName, tdMem, tdRatio);
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
function renderMeta() {
  const meta = state.meta || {};
  const rows = [
    ['主机名', meta.hostname || '--'],
    ['运行平台', meta.platform ? `${meta.platform.label} ${meta.platform.arch}（node ${meta.platform.nodeVersion || '--'}）` : '--'],
    ['驱动版本', meta.driverVersion || '--'],
    ['采集间隔', meta.intervalMs ? `${meta.intervalMs} ms` : '--'],
    ['曲线窗口', meta.windowSamples ? `${meta.windowSamples} 点 / 约 ${Math.round(meta.windowSamples * (meta.intervalMs || 1000) / 1000)} 秒` : '--'],
    ['已缓存采样点', meta.samples == null ? '--' : `${meta.samples} 点`],
    ['单次采集耗时', meta.collectMs == null ? '--' : `${meta.collectMs} ms`],
    ['服务运行时长', fmtDuration(meta.uptimeSec)],
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
  renderKpis();
  renderCharts();
  renderGpuCards();
  renderProcFilter();
  renderProcTable();
  renderMeta();

  const windowText = `${Math.round(state.windowSamples * state.intervalMs / 1000)} 秒`;
  if (state.gpus.length) {
    refs.orientSub.textContent = `${state.meta?.hostname || '--'} · ${state.gpus.length} 张卡 · 每 ${state.intervalMs} ms 采集 · 窗口最近 ${windowText} · 更新于 ${fmtClock(state.lastSampleAt)}`;
  } else if (state.status === 'error' || state.status === 'unreachable') {
    const host = state.meta?.hostname ? `${state.meta.hostname} · ` : '';
    const tail = state.lastSampleAt ? `数据停留在 ${fmtRelative(state.lastSampleAt)}` : '还没有采到任何数据';
    refs.orientSub.textContent = `${host}${state.status === 'unreachable' ? '无法连接采集服务' : '采集异常'} · ${tail}`;
  } else {
    refs.orientSub.textContent = '正在连接采集服务…';
  }
  refs.footerText.textContent = `数据来自 ${state.meta?.mock ? '模拟数据源' : 'nvidia-smi'}，仅在内存中保留最近 ${state.windowSamples} 个采样点（约 ${windowText}），不落盘、不做历史归档。`;
}

/* ---------- 交互 ---------- */
function download(path) {
  const url = `${path}?limit=${state.windowSamples}`;
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

refs.btnCsv.addEventListener('click', () => download('/api/export.csv'));
refs.btnJson.addEventListener('click', () => download('/api/export.json'));
refs.btnRefresh.addEventListener('click', async () => {
  refs.btnRefresh.disabled = true;
  await poll();
  refs.btnRefresh.disabled = false;
});
refs.btnRetry.addEventListener('click', () => poll());

let resizeTimer = null;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(renderCharts, 180);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});

async function boot() {
  try {
    const history = await fetchJson('/api/history');
    state.intervalMs = history.intervalMs || state.intervalMs;
    state.windowSamples = history.windowSamples || state.windowSamples;
    for (const sample of history.samples || []) appendSample(sample);
  } catch {
    // 首次回填失败不阻塞，直接进入轮询
  }
  await poll();
  schedule();
}

boot();
