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
import {
  GPU_CSV_HEADER,
  SYSTEM_CSV_HEADER,
  gpuRowToCsv,
  samplesToCsv,
  samplesToSystemCsv,
  systemRowToCsv,
} from './src/export.js';
import { createMockSource, createMockSystem } from './src/mock.js';
import { detectPlatform } from './src/platform.js';
import { gpuFromRow, systemFromRow } from './src/store/rows.js';
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
      --disk <路径>       额外监控的挂载点，可重复（默认 POSIX 为 /，Windows 为系统盘）
      --no-system         关掉宿主 CPU / 内存 / 磁盘 / 网络采集
      --no-extended       关掉扩展 GPU 指标（时钟 / P-State / 风扇 / PCIe / 编解码 / 节流原因）
      --idle-after <秒>   多久没有页面访问就转入空闲降频（默认 30，0 表示不限）
      --idle-interval <毫秒> 空闲期间的采集间隔（默认 10000）

历史库（SQLite，Node 22.5+ 内置）：
      --db <路径>         历史库文件（默认 data/gpu-monitor.db）
      --no-db             不落库，只保留内存窗口
      --store-interval <毫秒> 落库间隔，与页面刷新间隔解耦（默认 5000）
      --retention-days <天>   历史保留天数（默认 90，0 表示永久保留）
      --no-store-processes    不把占用进程写入历史库

      --mock              使用模拟数据，便于无 GPU 环境本地开发
  -h, --help              显示帮助

示例：
  node server.js --port 8090
  node server.js --port 8090 --retention-days 0 --store-interval 1000
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
    diskTargets: [],
    db: true,
    dbPath: process.env.GPU_MONITOR_DB || path.join('data', 'gpu-monitor.db'),
    storeIntervalMs: 5000,
    retentionDays: 90,
    storeProcesses: true,
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

const platform = detectPlatform();
const nodeId = os.hostname();
const store = await createStore({ options, nodeId });

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
});

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

function* gpuCsvLines({ from, to }, step) {
  for (const row of store.gpuPages({ from, to, step })) {
    yield gpuRowToCsv(new Date(row.ts).toISOString(), gpuFromRow(row));
  }
}

function* systemCsvLines({ from, to }, step) {
  for (const row of store.hostPages({ from, to, step })) {
    yield systemRowToCsv(new Date(row.ts).toISOString(), systemFromRow(row));
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
  // 任何请求都算"有人在看"，采集调度据此决定是满速还是空闲降频
  collector.noteClient();

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

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
    const to = parseTimeParam(url.searchParams.get('to')) ?? Date.now();
    const from = parseTimeParam(url.searchParams.get('from')) ?? (to - 3600000);
    if (!store.supportsHistory) {
      sendJson(res, 200, { source: 'memory', from, to, processes: [], reason: store.reason || '未启用历史库' });
      return;
    }
    sendJson(res, 200, {
      source: 'db',
      from,
      to,
      processes: store.queryProcesses({ from, to, limit: Number(url.searchParams.get('limit')) || 5000 }),
    });
    return;
  }

  if (pathname === '/api/export.csv') {
    if (fromStore) {
      const step = store.resolveStep(range.from, range.to, range.requestedStep);
      await streamCsv(res, `gpu-monitor-${nodeId}-${stamp()}.csv`, GPU_CSV_HEADER, gpuCsvLines(range, step));
      return;
    }
    sendDownload(
      res,
      `gpu-monitor-${nodeId}-${stamp()}.csv`,
      'text/csv; charset=utf-8',
      `\uFEFF${samplesToCsv(collector.getSamples(limitFrom(url)))}`,
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
  process.stdout.write(
    'GPU 显存负载监控已启动\n'
    + `  页面：   http://${shown}:${options.port}/\n`
    + `  平台：   ${platform.label} ${platform.arch}（node ${platform.nodeVersion}）\n`
    + `  数据源： ${options.mock ? '模拟数据（--mock）' : '自动探测 nvidia-smi'}\n`
    + `  采集：   每 ${options.intervalMs} ms，曲线窗口 ${options.windowSamples} 点`
    + `${options.idleAfterMs > 0 ? `，空闲 ${options.idleAfterMs / 1000} 秒后降频到 ${options.idleIntervalMs} ms` : '，不降频'}\n`
    + `  宿主指标：${options.system === false ? '已关闭' : (options.mock ? '模拟数据' : '开启')}`
    + `　扩展 GPU 指标：${options.extended ? '开启（自动探测驱动支持）' : '已关闭'}\n`
    + `  历史库： ${storageLine}\n`,
  );

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
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    collector.stop();
    try {
      // 退出前把缓冲里的行落盘，避免最后几秒的数据丢掉
      store.close();
    } catch {
      // 关库失败也只能继续退出
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800).unref();
  });
}
