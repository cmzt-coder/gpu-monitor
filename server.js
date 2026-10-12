#!/usr/bin/env node
// GPU 显存负载监控服务：零依赖（node:http + child_process 调用 nvidia-smi）
// 用法：node server.js --port 8080 [--host 0.0.0.0] [--interval 1000] [--window 300] [--mock]
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { readGpuSnapshot } from './src/nvidia.js';
import { createMockSource } from './src/mock.js';
import { History } from './src/history.js';
import { samplesToCsv } from './src/export.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const VERSION = '1.0.0';

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

  -p, --port <端口>       监听端口（默认 8080，也可用环境变量 PORT）
      --host <地址>       监听地址（默认 0.0.0.0，局域网可访问）
      --interval <毫秒>   采集间隔（默认 1000）
      --window <采样点数> 内存中保留的采样点数，也就是页面曲线的窗口（默认 300）
      --nvidia-smi <路径> nvidia-smi 可执行文件路径（默认从 PATH 查找）
      --mock              使用模拟数据，便于无 GPU 环境本地开发
  -h, --help              显示帮助

示例：
  node server.js --port 8080
  node server.js --port 9090 --interval 2000
`;

function parseArgs(argv) {
  const options = {
    port: Number(process.env.PORT || 8080),
    host: process.env.HOST || '0.0.0.0',
    intervalMs: 1000,
    windowSamples: 300,
    smiBin: process.env.NVIDIA_SMI_BIN || 'nvidia-smi',
    mock: process.env.GPU_MONITOR_MOCK === '1',
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

const history = new History(options.windowSamples);
const readSnapshot = options.mock
  ? createMockSource()
  : (overrides = {}) => readGpuSnapshot({ bin: options.smiBin, ...overrides });

const runtime = {
  startedAt: Date.now(),
  hostname: os.hostname(),
  status: 'starting',
  lastError: null,
  lastSampleAt: null,
  processWarning: null,
  collectMs: null,
  driverVersion: null,
  latest: null,
};

let collecting = false;

async function collectOnce() {
  if (collecting) return;
  collecting = true;
  const startedAt = Date.now();
  try {
    const snapshot = await readSnapshot({ timeout: Math.max(3000, options.intervalMs * 4) });
    // 采样点只保留曲线需要的字段，进程列表单独保留最新一份，避免内存冗余
    const gpus = snapshot.gpus.map((gpu) => ({
      index: gpu.index,
      uuid: gpu.uuid,
      name: gpu.name,
      memTotalMiB: gpu.memTotalMiB,
      memUsedMiB: gpu.memUsedMiB,
      memUsedPct: gpu.memUsedPct,
      utilGpuPct: gpu.utilGpuPct,
      utilMemPct: gpu.utilMemPct,
      tempC: gpu.tempC,
      powerW: gpu.powerW,
    }));
    const sample = { t: Date.now(), gpus };
    history.push(sample);
    runtime.latest = { ...sample, processes: snapshot.processes };
    runtime.status = 'ok';
    runtime.lastError = null;
    runtime.lastSampleAt = sample.t;
    runtime.processWarning = snapshot.processWarning || null;
    runtime.driverVersion = snapshot.gpus[0]?.driverVersion || runtime.driverVersion;
  } catch (error) {
    runtime.status = 'error';
    runtime.lastError = error?.message || String(error);
  } finally {
    runtime.collectMs = Date.now() - startedAt;
    collecting = false;
  }
}

function buildState() {
  const latest = runtime.latest;
  return {
    ok: runtime.status === 'ok',
    status: runtime.status,
    ts: runtime.lastSampleAt || Date.now(),
    serverTime: Date.now(),
    intervalMs: options.intervalMs,
    windowSamples: options.windowSamples,
    hostname: runtime.hostname,
    version: VERSION,
    mock: options.mock,
    smiBin: options.smiBin,
    driverVersion: runtime.driverVersion,
    uptimeSec: Math.round((Date.now() - runtime.startedAt) / 1000),
    collectMs: runtime.collectMs,
    samples: history.size,
    error: runtime.lastError,
    processWarning: runtime.processWarning,
    gpus: latest ? latest.gpus : [],
    processes: latest ? latest.processes : [],
  };
}

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

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  if (pathname === '/api/state') {
    sendJson(res, 200, buildState());
    return;
  }

  if (pathname === '/api/history') {
    const limit = Math.min(options.windowSamples, Number(url.searchParams.get('limit')) || options.windowSamples);
    sendJson(res, 200, {
      intervalMs: options.intervalMs,
      windowSamples: options.windowSamples,
      samples: history.snapshot(limit),
    });
    return;
  }

  if (pathname === '/api/export.csv') {
    const limit = Math.min(options.windowSamples, Number(url.searchParams.get('limit')) || options.windowSamples);
    sendDownload(
      res,
      `gpu-monitor-${runtime.hostname}-${stamp()}.csv`,
      'text/csv; charset=utf-8',
      `\uFEFF${samplesToCsv(history.snapshot(limit))}`,
    );
    return;
  }

  if (pathname === '/api/export.json') {
    const state = buildState();
    sendDownload(
      res,
      `gpu-monitor-${runtime.hostname}-${stamp()}.json`,
      'application/json; charset=utf-8',
      JSON.stringify({ ...state, samples: history.snapshot(state.windowSamples) }, null, 2),
    );
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  await serveStatic(req, res);
});

collectOnce();
const timer = setInterval(collectOnce, options.intervalMs);
timer.unref?.();

server.listen(options.port, options.host, () => {
  const shown = options.host === '0.0.0.0' ? 'localhost' : options.host;
  process.stdout.write(
    'GPU 显存负载监控已启动\n'
    + `  页面：   http://${shown}:${options.port}/\n`
    + `  数据源： ${options.mock ? '模拟数据（--mock）' : options.smiBin}\n`
    + `  采集：   每 ${options.intervalMs} ms，曲线窗口 ${options.windowSamples} 点\n`,
  );
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

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
