#!/usr/bin/env node
// GPU 显存负载监控服务：零依赖（node:http + child_process 调用 nvidia-smi + node:sqlite 存历史）
// 用法：node server.js --port 8090 [--host 0.0.0.0] [--interval 1000] [--window 300] [--mock]
// 采集与调度在 src/collector.js，历史库在 src/store/，这里只做参数解析、路由与静态文件。
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { createCollector } from './src/collector.js';
import { createAlertsRuntime } from './src/alerts/runtime.js';
import { evaluateHealth } from './src/health.js';
import {
  GPU_CSV_HEADER,
  GPU_CSV_HEADER_FULL,
  PROCESS_CSV_HEADER,
  SYSTEM_CSV_HEADER,
  applyTimeZone,
  gpuRowToCsv,
  processRowToCsv,
  samplesToCsv,
  samplesToSystemCsv,
  samplesToWideCsv,
  shouldWarnUtcTimeZone,
  systemRowToCsv,
  wideGpuCsvHeader,
  wideGpuCsvRow,
} from './src/export.js';
import { createMockSource, createMockSystem } from './src/mock.js';
import { detectPlatform, resolveHostname } from './src/platform.js';
import { gpuFromRow, processFromRow, systemFromRow } from './src/store/rows.js';
import { createStore } from './src/store/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const VERSION = '1.2.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const HELP = `GPU 显存负载监控服务

用法：node server.js [选项]

  -p, --port <端口>       监听端口（默认 8080，启动脚本会自动传 8090，也可用环境变量 PORT）
      --host <地址>       监听地址（默认 0.0.0.0，局域网可访问）
      --interval <毫秒>   采集间隔（默认 1000）
      --window <采样点数> 内存中保留的采样点数，也就是页面曲线的窗口（默认 300）
      --nvidia-smi <路径> 手动指定 nvidia-smi，默认按平台自动探测
      --disk <路径>[=显示名]  额外监控的挂载点，可重复（默认 POSIX 为 /，Windows 为系统盘）
                          显示名只影响页面标签，例如容器里 --disk /hostfs=/ 会显示成 /
      --no-system         关掉宿主 CPU / 内存 / 磁盘 / 网络采集
      --no-extended       关掉扩展 GPU 指标（时钟 / P-State / 风扇 / PCIe / 编解码 / 节流原因）
      --idle-after <秒>   多久没有页面访问就转入空闲降频（默认 30，0 表示不限）
      --idle-interval <毫秒> 空闲期间的采集间隔（默认 10000）
      --no-push           关掉 SSE 推送（/api/stream），页面自动回到轮询

告警（规则与渠道都写在配置文件里）：
      --alerts <路径>     告警配置文件（默认 alerts.json，不存在则不启用）
      --no-alerts         不启用告警
      --alerts-dry-run    只打印"本来要发什么"，不真正发信
      --no-alerts-reload  关掉告警配置的热加载（默认改了 alerts.json 会自动重新加载）

历史库（SQLite，Node 22.13+ 内置）：
      --db <路径>         历史库文件（默认 data/gpu-monitor.db）
      --no-db             不落库，只保留内存窗口
      --store-interval <毫秒> 落库间隔，与页面刷新间隔解耦（默认 5000）
      --retention-days <天>   历史保留天数；默认 0 = 永久保留，填天数则按天自动清理
      --no-store-processes    不把占用进程写入历史库
      --proc-min <MiB>        占用不到这个值的进程不写进历史库；默认 0 = 全记
                              （只想看得清爽点用页面上的「占用下限」，那个不会丢数据）
      --reclaim           启动时把历史库做一次整库重写（开启增量回收，释放已删数据占用的空间）

时间：
      --tz <时区>         把本服务的时区固定成这个 IANA 名字（如 Asia/Shanghai）。
                              影响导出里的 time_local 列、CSV 文件名和日志时间。
                              只对这个进程生效，不改系统时区、不影响这台机器上的其他服务。
                              不填则跟随系统时区（云主机默认常是 UTC），也认 TZ 环境变量。

      --mock              使用模拟数据，便于无 GPU 环境本地开发
  -h, --help              显示帮助

示例：
  node server.js --port 8090
  node server.js --port 8090 --retention-days 30 --store-interval 1000
  node server.js --port 8090 --mock --no-db
`;

function parseArgs(argv) {
  const options = {
    port: Number(process.env.PORT || 8080),
    host: process.env.HOST || '0.0.0.0',
    intervalMs: 1000,
    windowSamples: 300,
    // null 表示"没显式指定"，交给 src/platform.js 按平台自动探测
    smiBin: process.env.NVIDIA_SMI_BIN || null,
    mock: process.env.GPU_MONITOR_MOCK === '1',
    system: true,
    extended: true,
    idleAfterMs: 30000,
    idleIntervalMs: 10000,
    push: true,
    alerts: true,
    alertsPath: process.env.GPU_MONITOR_ALERTS || 'alerts.json',
    alertsDryRun: false,
    alertsReload: true,
    diskTargets: [],
    db: true,
    dbPath: process.env.GPU_MONITOR_DB || path.join('data', 'gpu-monitor.db'),
    storeIntervalMs: 5000,
    // 默认永久保留：历史库的价值就在于"翻得回去"，而按天清理是静默的数据丢失。
    // 实测单卡 5 秒粒度约 7 MiB/天，一年 2.5 GiB，磁盘上通常不值得为此丢数据；
    // 真要限制就显式给 --retention-days <天>。
    retentionDays: 0,
    storeProcesses: true,
    // 显式时区（IANA 名）。null = 跟随系统时区，也认 TZ 环境变量
    timeZone: null,
    // 进程记录下限（MiB）：0 = 全记。只看大进程请用页面上的「占用下限」，
    // 那是查询侧过滤、历史照样完整；这里设了值就是真的不写进库
    procMinMiB: 0,
    // 行重映射状态基本不变，低频读一次就够（单位毫秒）
    remapIntervalMs: 300000,
    // 内核日志里的 XID 要读得快一点，但也不必每帧都读
    xidIntervalMs: 60000,
    reclaimOnStart: false,
    version: VERSION,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case '--port':
      case '-p':
        options.port = Number(next()) || options.port;
        break;
      case '--host':
        options.host = next() || options.host;
        break;
      case '--interval':
        options.intervalMs = Math.max(200, Number(next()) || 1000);
        break;
      case '--window':
        options.windowSamples = Math.max(30, Number(next()) || 300);
        break;
      case '--nvidia-smi':
        options.smiBin = next() || options.smiBin;
        break;
      case '--disk': {
        const target = next();
        if (target) options.diskTargets.push(target);
        break;
      }
      case '--no-system':
        options.system = false;
        break;
      case '--no-extended':
        options.extended = false;
        break;
      case '--idle-after':
        options.idleAfterMs = Math.max(0, Number(next()) || 0) * 1000;
        break;
      case '--idle-interval':
        options.idleIntervalMs = Math.max(1000, Number(next()) || 10000);
        break;
      case '--no-push':
        options.push = false;
        break;
      case '--alerts':
        options.alertsPath = next() || options.alertsPath;
        break;
      case '--no-alerts':
        options.alerts = false;
        break;
      case '--alerts-dry-run':
        options.alertsDryRun = true;
        break;
      case '--no-alerts-reload':
        options.alertsReload = false;
        break;
      case '--db':
        options.dbPath = next() || options.dbPath;
        break;
      case '--no-db':
        options.db = false;
        break;
      case '--store-interval':
        options.storeIntervalMs = Math.max(1000, Number(next()) || 5000);
        break;
      case '--retention-days':
        options.retentionDays = Math.max(0, Number(next()) || 0);
        break;
      case '--no-store-processes':
        options.storeProcesses = false;
        break;
      case '--proc-min':
        options.procMinMiB = Math.max(0, Number(next()) || 0);
        break;
      case '--reclaim':
        options.reclaimOnStart = true;
        break;
      case '--tz':
        options.timeZone = next() || options.timeZone;
        break;
      case '--mock':
        options.mock = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        break;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

// 时区固定：必须放在任何时间相关逻辑之前。
// 只改本进程的 process.env.TZ——Node 的 Date / Intl 会跟着走，
// 导出的 time_local、CSV 文件名、日志时间因此统一；系统时区一个字节都不动，
// 所以同一台机器上跑着的其他服务完全不受影响（云主机默认 UTC，改系统时区会波及它们）。
let activeTimeZone;
try {
  activeTimeZone = applyTimeZone(options.timeZone);
} catch (error) {
  process.stderr.write(`启动失败：${error.message}\n`);
  process.exit(1);
}
// 最终生效的时区（--tz > TZ 环境变量 > 系统时区），启动横幅与页面都用它
const timeZoneFixed = Boolean(options.timeZone || process.env.TZ);

const platform = detectPlatform();
// 主机名：--mock 下是 demo-host（模拟数据的截图不该带出本机名），真机就是本机名
const nodeId = resolveHostname({ mock: options.mock });
const store = await createStore({ options, nodeId });

// 近 1 小时的利用率均值：跨时间的那个"平均 GPU 利用率"。
//
// 和卡片上另外几个指标不同，这个数不是"这一帧"的量，而是把库里近一小时的所有
// 采样点（跨时间、跨卡）拉平的均值，所以必须走历史库。
//
// 一条 SQL 聚合就能拿到，但 getState() 每秒都会被调用一次（采集循环 + 每个页面），
// 没必要每秒查一次库，所以缓存 60 秒。库还没攒满一小时时，把实际覆盖的时间跨度
// 一起返回，页面上如实说明，而不是假装这一小时是满的。
const UTIL_WINDOW_MS = 3600000;
const UTIL_REFRESH_MS = 60000;
const UTIL_REFRESH_RETRY_MS = 5000;
const utilAverageCache = { at: 0, value: { avg: null, samples: 0, cards: 0, oldestTs: null, newestTs: null, windowMs: UTIL_WINDOW_MS } };

function refreshUtilAverage() {
  utilAverageCache.at = Date.now();
  if (!store.supportsHistory) return;
  try {
    const stats = store.averageGpuUtil({ from: utilAverageCache.at - UTIL_WINDOW_MS, to: utilAverageCache.at });
    utilAverageCache.value = { ...stats, windowMs: UTIL_WINDOW_MS };
  } catch (error) {
    process.stderr.write(`[gpu-monitor] 利用率均值计算失败：${error?.message || error}\n`);
  }
}

function utilAverageState() {
  // 库里一条都没有时说明服务刚起来，5 秒后再试，别让页面干等一分钟
  const ttl = utilAverageCache.value.samples > 0 ? UTIL_REFRESH_MS : UTIL_REFRESH_RETRY_MS;
  if (Date.now() - utilAverageCache.at >= ttl) refreshUtilAverage();
  return utilAverageCache.value;
}

// --mock 下连宿主指标也用模拟数据，这样在没有 GPU、也没有可读 /proc 的机器上也能看完整界面
const collector = createCollector({
  options,
  platform,
  mockSource: options.mock ? createMockSource() : null,
  // --no-system 优先级最高：显式关掉时连模拟数据也不提供
  systemCollector: options.system === false
    ? null
    : (options.mock ? createMockSystem() : undefined),
  store,
  // 告警状态由服务层持有，用这个钩子挂进状态里：
  // /api/state 与 SSE 推送共用同一份 getState()，不会出现"只有一条通道带告警"的情况
  extraState: () => ({
    alerts: alertsRuntime.snapshot(),
    // 近 1 小时的利用率均值（跨时间、跨卡）。放服务端算：一条 SQL 聚合就够，
    // 不必让每个打开的页面各自拉一小时的原始数据回来自己平均
    utilAverage: utilAverageState(),
    // 导出里的 time_local 用的是这个时区（--tz > TZ > 系统时区）。
    // 页面把它写进导出说明，并在这台机器和看页面的人不是同一个时区时直接提醒
    timeZone: activeTimeZone,
    timeZoneFixed,
  }),
});

/* ---------- 告警 ---------- */

// 告警的装配与热加载都在这个 runtime 里：改了 alerts.json 会自动重新加载，
// 配置写坏时沿用上一次可用的规则，不会静默失去告警
const alertsRuntime = createAlertsRuntime({
  options: { ...options, alertsReload: options.alertsReload },
  collector,
  store,
  watch: options.alertsReload,
});
await alertsRuntime.start();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendDownload(res, filename, contentType, body) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 大区间导出要流式写出：90 天 × 多张卡是几十万行，先拼成一整个字符串会吃掉大量内存
async function streamCsv(res, filename, header, lines) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.write(`\uFEFF${header}\n`);
  let batch = [];
  for await (const line of lines) {
    batch.push(line);
    if (batch.length >= 500) {
      if (!res.write(`${batch.join('\n')}\n`)) await once(res, 'drain');
      batch = [];
    }
  }
  if (batch.length) res.write(`${batch.join('\n')}\n`);
  res.end();
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/* ---------- 时间区间 ---------- */

const RANGE_PATTERN = /^(\d+)([mhd])$/;
const UNIT_MS = { m: 60000, h: 3600000, d: 86400000 };

function parseTimeParam(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * 解析区间请求，支持三种写法：
 *   ?from=2026-10-01&to=2026-10-08   绝对时间
 *   ?range=7d / 24h / 90m            相对时间
 *   ?range=all                       全部历史（到库里最早的一条）
 * 都没有就返回 null，走内存窗口的老路径。
 */
function resolveRange(url) {
  const to = parseTimeParam(url.searchParams.get('to')) ?? Date.now();
  let from = parseTimeParam(url.searchParams.get('from'));
  const range = (url.searchParams.get('range') || '').toLowerCase();

  if (from == null && range) {
    if (range === 'all') {
      from = store.supportsHistory ? store.stats().oldestTs : null;
    } else {
      const match = RANGE_PATTERN.exec(range);
      if (match) from = to - Number(match[1]) * UNIT_MS[match[2]];
    }
  }
  if (from == null) return null;
  const requestedStep = Number(url.searchParams.get('step')) || 0;
  return from > to ? { from: to, to: from, requestedStep } : { from, to, requestedStep };
}

function* gpuCsvLines({ from, to }, step, { full = false } = {}) {
  for (const row of store.gpuPages({ from, to, step })) {
    yield gpuRowToCsv(row.ts, gpuFromRow(row), { full });
  }
}

/**
 * 宽表的流式写法：把同一时刻的多张卡攒齐了再吐一行。
 *
 * `gpuPages` 是按 ts 升序给的，所以只需要攒"当前这一拍"——同一时刻的卡一定挨在一起，
 * 不需要把整个区间读进内存（90 天 × 8 卡是几十万行）。攒的行数最多等于卡数。
 */
function* wideGpuLines({ from, to }, step, indexes) {
  let currentTs = null;
  let bucket = [];
  for (const row of store.gpuPages({ from, to, step })) {
    if (currentTs !== null && row.ts !== currentTs) {
      yield wideGpuCsvRow(currentTs, bucket, indexes);
      bucket = [];
    }
    currentTs = row.ts;
    bucket.push(gpuFromRow(row));
  }
  if (currentTs !== null) yield wideGpuCsvRow(currentTs, bucket, indexes);
}

function* systemCsvLines({ from, to }, step) {
  for (const row of store.hostPages({ from, to, step })) {
    yield systemRowToCsv(row.ts, systemFromRow(row));
  }
}

function* processCsvLines({ from, to }) {
  for (const row of store.processPages({ from, to })) {
    yield processRowToCsv(row.ts, processFromRow(row));
  }
}

/* ---------- 静态文件 ---------- */

function resolveStaticPath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const absolute = path.resolve(PUBLIC_DIR, relative);
  if (absolute !== PUBLIC_DIR && !absolute.startsWith(PUBLIC_DIR + path.sep)) return null;
  return absolute;
}

async function serveStatic(req, res) {
  const absolute = resolveStaticPath(req.url || '/');
  if (!absolute) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(absolute);
    if (stat.isDirectory()) throw new Error('is a directory');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(absolute).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': stat.size,
    });
    fs.createReadStream(absolute).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/* ---------- 路由 ---------- */

function limitFrom(url) {
  const requested = Number(url.searchParams.get('limit')) || options.windowSamples;
  return Math.min(options.windowSamples, requested);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 页面请求都算"有人在看"，采集调度据此决定满速还是空闲降频。
  // /api/health 是探针在定时打，不能算：否则探活越勤，空闲降频越永远不会生效。
  if (pathname !== '/api/health') collector.noteClient();

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const range = resolveRange(url);
  const fromStore = Boolean(range && store.supportsHistory);

  if (pathname === '/api/state') {
    sendJson(res, 200, collector.getState());
    return;
  }

  // 健康检查：给外部探针 / systemd watchdog 用。200 = 健康或仅有提醒，503 = 有致命项。
  // 注意这里不调 noteClient()，否则每次探活都会把服务从空闲降频里"唤醒"。
  if (pathname === '/api/health') {
    const health = evaluateHealth({
      state: collector.getState(),
      storage: store.stats(),
      alerts: alertsRuntime.snapshot(),
      version: VERSION,
      probePath: options.db === false ? null : path.dirname(path.resolve(options.dbPath)),
    });
    sendJson(res, health.statusCode, health);
    return;
  }

  // SSE 推送：每采集一帧就发一条，页面不必再轮询。
  // 关掉推送时直接 404，前端收到 onerror 会自动退回轮询，不需要额外握手。
  if (pathname === '/api/stream') {
    if (options.push === false) {
      sendJson(res, 404, { error: 'push_disabled' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 让 nginx 之类的反代不要缓冲，否则推送会被攒成一批才吐出来
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const sendState = (payload) => {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        // 客户端已断开，close 事件里会清理订阅
      }
    };
    sendState(collector.getState());

    const unsubscribe = collector.subscribe(sendState);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // 同上
      }
    }, 15000);
    heartbeat.unref?.();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
    res.on('close', cleanup);
    return;
  }

  if (pathname === '/api/history') {
    if (fromStore) {
      const result = store.querySamples({
        from: range.from,
        to: range.to,
        stepMs: range.requestedStep,
      });
      sendJson(res, 200, {
        ...result,
        source: 'db',
        intervalMs: options.intervalMs,
        windowSamples: options.windowSamples,
      });
      return;
    }
    // 没有区间参数（或没有历史库）时，仍然用内存里的最近窗口
    sendJson(res, 200, {
      ...collector.getHistory(limitFrom(url)),
      source: 'memory',
      limited: Boolean(range),
      reason: range ? (store.reason || '未启用历史库') : null,
    });
    return;
  }

  if (pathname === '/api/processes') {
    // 支持和 /api/history 一样的区间写法（range=24h / from+to），默认看最近一小时
    const resolved = range ?? { from: Date.now() - 3600000, to: Date.now() };
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 200));
    // 占用下限：不带参数时用启动参数里的 --proc-min，页面上的「占用下限」会显式传
    const minParam = url.searchParams.get('min');
    const minMiB = minParam == null
      ? (options.procMinMiB || 0)
      : Math.max(0, Number(minParam) || 0);
    if (!store.supportsHistory) {
      sendJson(res, 200, {
        source: 'memory',
        from: resolved.from,
        to: resolved.to,
        limit,
        minMiB,
        count: 0,
        total: 0,
        processes: [],
        reason: store.reason || '未启用历史库',
      });
      return;
    }
    const processes = store.queryProcesses({ from: resolved.from, to: resolved.to, limit, minMiB });
    sendJson(res, 200, {
      source: 'db',
      from: resolved.from,
      to: resolved.to,
      limit,
      minMiB,
      count: processes.length,
      total: store.countProcesses({ from: resolved.from, to: resolved.to, minMiB }),
      processes,
    });
    return;
  }

  if (pathname === '/api/export.csv') {
    // fields=full 会带上时钟 / P-State / 风扇 / PCIe / 编解码 / 节流这些扩展列，
    // 它们只存在历史库里（内存窗口只留了画曲线要用的字段），所以没有库就直接说清楚
    const full = url.searchParams.get('fields') === 'full';
    // 宽表：一行一个采样点，每张卡各占一组列（Excel 里横向比卡更方便）。
    // 列数随卡数线性增长，所以只带基础指标——想连扩展字段一起导就用长表。
    const wide = url.searchParams.get('layout') === 'wide';
    if (wide && full) {
      sendJson(res, 400, {
        error: 'wide_layout_basic_only',
        message: '宽表只导出基础指标（列数随卡数增长）；要扩展字段请把布局切回长表',
      });
      return;
    }
    if (full && !store.supportsHistory) {
      sendJson(res, 400, {
        error: 'full_fields_unavailable',
        message: '扩展字段只存在历史库里：请启用历史库（去掉 --no-db，并确保 Node ≥ 22.13）后重试',
      });
      return;
    }
    // 要扩展字段但没有指定区间时，按当前内存窗口对应的那段时间去库里取
    const exportRange = range ?? (full
      ? {
        from: Date.now() - options.windowSamples * options.intervalMs,
        to: Date.now(),
        requestedStep: 0,
      }
      : null);
    const exportFromStore = Boolean(exportRange && store.supportsHistory);
    if (exportFromStore) {
      const step = store.resolveStep(exportRange.from, exportRange.to, exportRange.requestedStep);
      // 宽表的表头要在流式输出前定下来，所以卡号取自"当前还在的卡"（监控场景下卡是稳定的）
      const indexes = collector.getState().gpus.map((gpu) => gpu.index).sort((a, b) => a - b);
      await streamCsv(
        res,
        `gpu-monitor${wide ? '-wide' : full ? '-full' : ''}-${nodeId}-${stamp()}.csv`,
        wide ? wideGpuCsvHeader(indexes) : (full ? GPU_CSV_HEADER_FULL : GPU_CSV_HEADER),
        wide ? wideGpuLines(exportRange, step, indexes) : gpuCsvLines(exportRange, step, { full }),
      );
      return;
    }
    const memorySamples = collector.getSamples(limitFrom(url));
    sendDownload(
      res,
      `gpu-monitor${wide ? '-wide' : ''}-${nodeId}-${stamp()}.csv`,
      'text/csv; charset=utf-8',
      `\uFEFF${wide ? samplesToWideCsv(memorySamples) : samplesToCsv(memorySamples)}`,
    );
    return;
  }

  if (pathname === '/api/export.system.csv') {
    if (fromStore) {
      const step = store.resolveStep(range.from, range.to, range.requestedStep);
      await streamCsv(res, `gpu-monitor-system-${nodeId}-${stamp()}.csv`, SYSTEM_CSV_HEADER, systemCsvLines(range, step));
      return;
    }
    sendDownload(
      res,
      `gpu-monitor-system-${nodeId}-${stamp()}.csv`,
      'text/csv; charset=utf-8',
      `\uFEFF${samplesToSystemCsv(collector.getSamples(limitFrom(url)))}`,
    );
    return;
  }

  if (pathname === '/api/export.processes.csv') {
    // 进程事件导出：区间内的全部事件（不设 limit——导出的意义就是把这段拿全）
    if (!range) {
      sendJson(res, 400, {
        error: 'range_required',
        message: '进程占用历史导出需要指定时间范围：加 ?range=24h，或用 from/to',
      });
      return;
    }
    if (!store.supportsHistory) {
      sendJson(res, 400, {
        error: 'history_unavailable',
        message: '进程历史只存在库里：请启用历史库（去掉 --no-db，并确保 Node ≥ 22.13）后重试',
      });
      return;
    }
    await streamCsv(
      res,
      `gpu-monitor-processes-${nodeId}-${stamp()}.csv`,
      PROCESS_CSV_HEADER,
      processCsvLines(range),
    );
    return;
  }

  if (pathname === '/api/export.json') {
    const state = collector.getState();
    sendDownload(
      res,
      `gpu-monitor-${nodeId}-${stamp()}.json`,
      'application/json; charset=utf-8',
      JSON.stringify({ ...state, samples: collector.getSamples(state.windowSamples) }, null, 2),
    );
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  await serveStatic(req, res);
});

// 先把第一次采集发出去（页面一打开就有数据），再开始按间隔轮转
const firstCollection = collector.start();

server.listen(options.port, options.host, () => {
  const shown = options.host === '0.0.0.0' ? 'localhost' : options.host;
  const storageLine = options.db === false
    ? '已关闭（--no-db）'
    : (store.supportsHistory
      ? `${store.stats().path}（每 ${options.storeIntervalMs} ms 落一行，保留 ${options.retentionDays > 0 ? `${options.retentionDays} 天` : '全部'}）`
      : `不可用：${store.reason || '未知原因'}`);
  const alertsSnapshot = alertsRuntime.snapshot();
  const alertsLine = alertsSnapshot.loaded
    ? `${alertsSnapshot.configPath}（${alertsSnapshot.ruleCount} 条规则`
      + `${options.alertsDryRun ? '，dry-run 不实际发信' : ''}`
      + `${alertsSnapshot.problems?.length ? `，${alertsSnapshot.problems.length} 条被跳过` : ''}`
      + `${alertsSnapshot.autoReload ? '，改动后自动重载' : ''}）`
    : (alertsSnapshot.reason || '未启用');
  process.stdout.write(
    'GPU 显存负载监控已启动\n'
    + `  页面：   http://${shown}:${options.port}/\n`
    + `  平台：   ${platform.label} ${platform.arch}（node ${platform.nodeVersion}）\n`
    + `  数据源： ${options.mock ? '模拟数据（--mock）' : '自动探测 nvidia-smi'}\n`
    + `  采集：   每 ${options.intervalMs} ms，曲线窗口 ${options.windowSamples} 点`
    + `${options.idleAfterMs > 0 ? `，空闲 ${options.idleAfterMs / 1000} 秒后降频到 ${options.idleIntervalMs} ms` : '，不降频'}\n`
    + `  宿主指标：${options.system === false ? '已关闭' : (options.mock ? '模拟数据' : '开启')}`
    + `　扩展 GPU 指标：${options.extended ? '开启（自动探测驱动支持）' : '已关闭'}\n`
    + `  导出时区：${activeTimeZone}${timeZoneFixed ? '' : '（跟随系统时区）'}\n`
    + `  历史库： ${storageLine}\n`
    + `  告警：   ${alertsLine}\n`,
  );

  // 云主机的系统时区默认常是 UTC，而人都在东八区：这时导出的 time_local 会和
  // timestamp_iso 一模一样，看着像"改了没生效"。与其让人自己发现，不如启动就说。
  if (shouldWarnUtcTimeZone({ zone: activeTimeZone, fixed: timeZoneFixed })) {
    process.stdout.write(
      '  提示：   系统时区是 UTC，导出里的 time_local 会等于 UTC 那一列。\n'
      + '           要和本机墙上时钟一致就用 --tz Asia/Shanghai 启动（只影响本进程，不改系统时区）\n',
    );
  }

  // 探测结果异步补一行，探测失败也不阻塞服务启动（采集循环每 30s 会重试）
  if (!options.mock) {
    firstCollection.then(() => {
      const state = collector.getState();
      if (state.collector.bin) {
        process.stdout.write(`  显卡：   ${state.collector.bin}（${state.collector.source}），检测到 ${state.collector.deviceCount} 张卡\n`);
      } else if (state.error) {
        process.stdout.write(`  警告：   ${state.error}\n           ${state.hint || ''}\n`);
      }
      const probe = state.fields;
      if (probe?.enabled && probe.unsupported?.length) {
        process.stdout.write(`  提示：   ${probe.unsupported.length} 个扩展字段当前驱动不支持，已自动跳过：${probe.unsupported.join('、')}\n`);
      }
    });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(`端口 ${options.port} 已被占用，请换一个端口：node server.js --port ${options.port + 1}\n`);
  } else if (error.code === 'EACCES' || error.code === 'EPERM') {
    process.stderr.write(`没有权限监听 ${options.host}:${options.port}，请换端口（1024 以上）或检查防火墙/沙箱限制。\n`);
  } else {
    process.stderr.write(`服务启动失败：${error.message}\n`);
  }
  process.exit(1);
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    alertsRuntime.close();

    // 兜底：采集卡在 nvidia-smi 上时也要能退出，别把关闭流程吊在这儿
    const forceExit = setTimeout(() => process.exit(0), 3000);
    forceExit.unref?.();

    // 先等在途那一拍结束再关库。这一拍收尾时还要落盘、还要取一次状态推给订阅者，
    // 历史库要是先关了，它会打到已关闭的连接上，抛 ERR_INVALID_STATE 把进程带崩
    try {
      await collector.stop();
    } catch {
      // 采集层的异常不该挡住退出
    }

    // 关库放到最后：server.close() 之后仍可能有在途的 /api/state、/api/history 要读库。
    // 缓冲里的行是在 store.close() 里落盘的，所以顺序调换不会丢最后几秒的数据。
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(forceExit);
      try {
        // 退出前把缓冲里的行落盘，避免最后几秒的数据丢掉
        store.close();
      } catch {
        // 关库失败也只能继续退出
      }
      process.exit(0);
    };
    server.close(finish);
    setTimeout(finish, 800).unref?.();
  });
}
