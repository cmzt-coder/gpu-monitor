#!/usr/bin/env node
// 冒烟测试：不依赖网络与真实 GPU，验证 nvidia-smi 解析、字段探测、宿主指标、
// 空闲调度、环形缓冲与 CSV 导出。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readGpuSnapshot, resolveGpuFields, parseGpuCsv, splitRow, defaultGpuFields } from '../src/nvidia.js';
import { History } from '../src/history.js';
import {
  GPU_CSV_HEADER,
  GPU_CSV_HEADER_FULL,
  SYSTEM_CSV_HEADER,
  gpuRowToCsv,
  samplesToCsv,
  samplesToSystemCsv,
  systemRowToCsv,
} from '../src/export.js';
import { createMockSource, createMockSystem } from '../src/mock.js';
import { detectPlatform, nvidiaSmiCandidates, resolveNvidiaSmi } from '../src/platform.js';
import { createSystemCollector, parseMeminfo, parseNetDev, cpuUsagePct } from '../src/system.js';
import { createCollector, resolveCadence } from '../src/collector.js';
import { createSqliteStore } from '../src/store/sqlite-store.js';
import { createMemoryStore, createStore, describeStorageError } from '../src/store/store.js';
import { gpuFromRow, packThrottle, processesSignature, systemFromRow, unpackThrottle } from '../src/store/rows.js';
import { compare, normalizeRules, parseDuration } from '../src/alerts/rules.js';
import { createAlertEngine } from '../src/alerts/engine.js';
import { createAlertsRuntime } from '../src/alerts/runtime.js';
import {
  createProcessInfoReader,
  parseCgroup,
  parseCmdline,
  parsePasswd,
  parseUidStatus,
  serviceLabel,
} from '../src/procinfo.js';
import { expandEnv, loadAlertsConfig } from '../src/alerts/config.js';
import { buildMessage, encodeHeader, sendMail } from '../src/notify/smtp.js';
import { createNotifier } from '../src/notify/notifier.js';
import { runPreflight } from './preflight.mjs';
import { evaluateHealth } from '../src/health.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SMI = path.join(HERE, 'fake-nvidia-smi.mjs');
const FAKE_SMI_CRLF = path.join(HERE, 'fake-nvidia-smi-crlf.mjs');

/**
 * 假的 SMTP 会话：按客户端写进来的命令给出对应回复。
 * 这样 EHLO / AUTH LOGIN / DATA 这套协议流程在没有网络、没有真实邮件服务器的环境里也能被测到。
 */
function createFakeSmtpSession({ failAt = null, code = '550 5.7.1 Rejected' } = {}) {
  const writes = [];
  let dataHandler = null;
  let authStep = 0;

  function replyFor(command, raw) {
    if (/^EHLO/.test(command)) return '250-fake greets you\r\n250 AUTH LOGIN PLAIN\r\n';
    if (/^AUTH LOGIN/.test(command)) {
      authStep = 1;
      return '334 VXNlcm5hbWU6\r\n';
    }
    if (authStep === 1) {
      authStep = 2;
      return '334 UGFzc3dvcmQ6\r\n';
    }
    if (authStep === 2) {
      authStep = 0;
      return '235 2.7.0 Accepted\r\n';
    }
    if (/^MAIL FROM/.test(command)) return failAt === 'MAIL FROM' ? `${code}\r\n` : '250 2.1.0 Sender OK\r\n';
    if (/^RCPT TO/.test(command)) return '250 2.1.5 Recipient OK\r\n';
    if (/^DATA/.test(command)) return '354 End data with <CR><LF>.<CR><LF>\r\n';
    if (raw.includes('\r\n.\r\n')) return '250 2.0.0 Queued\r\n';
    if (/^QUIT/.test(command)) return '221 Bye\r\n';
    return '500 5.5.1 Unknown command\r\n';
  }

  const socket = {
    setEncoding() {},
    on(event, handler) {
      if (event === 'data') dataHandler = handler;
    },
    write(text) {
      writes.push(text);
      const command = text.split('\r\n')[0] || '';
      queueMicrotask(() => dataHandler?.(replyFor(command, text)));
    },
    end() {},
    removeAllListeners() {},
  };

  queueMicrotask(() => dataHandler?.('220 fake ESMTP ready\r\n'));
  return { writes, connect: () => socket };
}

/* ---------- GPU 解析：基础 + 扩展字段 ---------- */
const snapshot = await readGpuSnapshot({ bin: FAKE_SMI });

assert.equal(snapshot.gpus.length, 3, '应解析出 3 张卡');
assert.equal(snapshot.gpus[0].index, 0);
assert.equal(snapshot.gpus[0].name, 'NVIDIA GeForce RTX 4090');
assert.equal(snapshot.gpus[0].memTotalMiB, 24564);
assert.equal(snapshot.gpus[0].memUsedMiB, 18920);
assert.equal(snapshot.gpus[0].utilGpuPct, 87);
assert.equal(snapshot.gpus[0].tempC, 62);
assert.ok(Math.abs(snapshot.gpus[0].memUsedPct - (18920 / 24564) * 100) < 1e-6, '显存占用率应为已用/总量');
assert.equal(snapshot.gpus[2].powerW, null, '[Not Supported] 应解析为 null');
assert.equal(snapshot.processes.length, 2, '应解析出 2 个进程');
assert.equal(snapshot.processes[0].gpuIndex, 2, '进程应按 uuid 关联到 GPU 序号');
assert.equal(snapshot.processes[0].usedMemMiB, 44100);
assert.equal(snapshot.processes[1].pid, 20481);

// 扩展指标：时钟 / P-State / 风扇 / PCIe / 编解码
assert.equal(snapshot.gpus[0].clockSmMHz, 2520);
assert.equal(snapshot.gpus[0].clockMemMHz, 10501);
assert.equal(snapshot.gpus[0].pstate, 'P2');
assert.equal(snapshot.gpus[0].fanPct, 42);
assert.equal(snapshot.gpus[0].pcieGen, 4);
assert.equal(snapshot.gpus[0].pcieWidth, 16);
assert.equal(snapshot.gpus[2].encUtilPct, 3);
assert.equal(snapshot.gpus[1].fanPct, null, '不支持的风扇读数应为 null');

// 节流原因：Active → true，Not Active → false
assert.equal(snapshot.gpus[0].throttle.swPowerCap, false);
assert.equal(snapshot.gpus[0].throttle.gpuIdle, true);
assert.equal(snapshot.gpus[1].throttle.hwThermal, true);
assert.equal(snapshot.gpus[2].throttle.swPowerCap, true);

// 名称里带逗号时，多出来的片段要并回 name 列
assert.equal(snapshot.gpus[1].name, 'NVIDIA A100-SXM4-80GB, Rev A');
assert.deepEqual(splitRow('a, b, c, d', 4), ['a', 'b', 'c', 'd']);
// 多出 1 列：把多出来的那段并回 name（下标 2）
assert.deepEqual(splitRow('0, x, A, B, 1', 4), ['0', 'x', 'A, B', '1']);
// 列数少于字段数：补空串，保证下标对齐
assert.deepEqual(splitRow('0, x', 4), ['0', 'x', '', '']);

// 只查基础字段时不应出现 throttle 结构
const baseOnly = parseGpuCsv('0, GPU-x, RTX 4090, 550.90.07, 24564, 18920, 5644, 87, 61, 62, 310.42, 450.00');
assert.equal(baseOnly[0].throttle, undefined);
assert.equal(baseOnly[0].memUsedMiB, 18920);
assert.equal(defaultGpuFields().length > 12, true, '默认字段表应包含扩展指标');

/* ---------- 老驱动字段探测：不支持的字段自动剔除 ---------- */
process.env.FAKE_SMI_UNSUPPORTED = 'clocks.current.memory,clocks_throttle_reasons.hw_slowdown';
const probed = await resolveGpuFields({ bin: FAKE_SMI });
delete process.env.FAKE_SMI_UNSUPPORTED;

assert.equal(probed.extended, false, '有字段被剔除时应标记为"非全量扩展"');
assert.deepEqual(
  probed.unsupported,
  ['clocks.current.memory', 'clocks_throttle_reasons.hw_slowdown'],
  '应逐个记录不支持的字段',
);
assert.equal(probed.fields.some((spec) => spec.field === 'clocks.current.memory'), false);
assert.equal(probed.fields.some((spec) => spec.field === 'clocks.current.sm'), true, '其它扩展字段应保留');

const prunedSnapshot = await readGpuSnapshot({ bin: FAKE_SMI, fields: probed.fields });
assert.equal(prunedSnapshot.gpus[0].clockSmMHz, 2520);
assert.equal(prunedSnapshot.gpus[0].clockMemMHz, undefined, '被剔除的字段不再出现在结果里');

// 关闭扩展指标：直接退回基础字段
const noExtended = await resolveGpuFields({ bin: FAKE_SMI, extended: false });
assert.equal(noExtended.fields.length, 12);
assert.equal(noExtended.extended, false);

/* ---------- 环形缓冲 ---------- */
const history = new History(3);
for (let i = 0; i < 5; i += 1) {
  history.push({ t: i, gpus: [{ index: 0, name: 'x', memUsedMiB: i, memTotalMiB: 10, memUsedPct: i * 10, utilGpuPct: i, utilMemPct: i, tempC: i, powerW: i }] });
}
assert.equal(history.size, 3, '环形缓冲应只保留 3 个采样点');
assert.deepEqual(history.snapshot(3).map((s) => s.t), [2, 3, 4]);

/* ---------- CSV 导出 ---------- */
const csv = samplesToCsv([
  { t: Date.UTC(2026, 8, 30, 1, 2, 3), gpus: [{ index: 0, name: 'A, B', memUsedMiB: 1, memTotalMiB: 2, memUsedPct: 50, utilGpuPct: 10, utilMemPct: 20, tempC: 30, powerW: 40 }] },
]);
const lines = csv.trim().split('\n');
assert.equal(lines.length, 2);
assert.ok(lines[0].startsWith('timestamp_iso,gpu_index'), 'CSV 表头应固定');
assert.ok(lines[1].includes('"A, B"'), '含逗号的名称应被引号包裹');

const systemCsv = samplesToSystemCsv([
  { t: Date.UTC(2026, 8, 30, 1, 2, 3), system: null },
  {
    t: Date.UTC(2026, 8, 30, 1, 2, 4),
    system: {
      cpu: { usagePct: 12.34 },
      mem: { totalMiB: 1024, usedMiB: 512, usedPct: 50 },
      swap: null,
      load: { l1: 0.5, l5: 0.4, l15: 0.3 },
      disk: [{ path: '/', usedMiB: 100, totalMiB: 200, usedPct: 50 }],
      net: { rxBytesPerSec: 0, txBytesPerSec: 2048 },
    },
  },
]);
const systemLines = systemCsv.trim().split('\n');
assert.equal(systemLines[0].startsWith('timestamp_iso,cpu_usage_pct'), true);
assert.equal(systemLines.length, 2, '没有宿主指标的采样点不应产生空行');
assert.ok(systemLines[1].includes(',0,2048'), '速率为 0 也要如实导出');

/* ---------- 模拟数据源 ---------- */
const mock = await createMockSource({ gpuCount: 2 })();
assert.equal(mock.gpus.length, 2);
assert.ok(mock.gpus.every((gpu) => gpu.memUsedMiB <= gpu.memTotalMiB));

const mockSystem = await createMockSystem().sample();
assert.ok(mockSystem.mem.usedPct > 0 && mockSystem.mem.usedPct < 100);
assert.ok(mockSystem.cpu.usagePct > 0);
assert.deepEqual(mockSystem.unsupported, []);

/* ---------- 平台探测 ---------- */
const platform = detectPlatform();
assert.equal(platform.id, process.platform);
assert.equal(platform.arch, process.arch);
assert.equal(platform.supported, process.platform === 'linux' || process.platform === 'win32');
assert.ok(platform.label && platform.label.length > 0);
if (process.platform === 'darwin') {
  assert.ok(platform.note.includes('macOS'), 'macOS 上应给出平台不支持的说明');
}

// 候选列表第一个永远是 PATH 里的 nvidia-smi，且不会重复
const candidates = nvidiaSmiCandidates();
assert.equal(candidates[0].bin, 'nvidia-smi');
assert.equal(new Set(candidates.map((item) => item.bin)).size, candidates.length);

// 指定可用的 nvidia-smi：解析成功并报出卡数
const resolved = await resolveNvidiaSmi({ explicit: FAKE_SMI });
assert.equal(resolved.ok, true, '指定可用的 fake nvidia-smi 应解析成功');
assert.equal(resolved.bin, FAKE_SMI);
assert.equal(resolved.deviceCount, 3, '应能从 nvidia-smi -L 里数出 3 张卡');

// 指定不存在的路径：失败但要有可读的排查建议
const missing = await resolveNvidiaSmi({ explicit: '/nonexistent/nvidia-smi' });
assert.equal(missing.ok, false);
assert.ok(missing.error && missing.error.length > 0);
assert.ok(missing.hint && missing.hint.length > 0, '失败时应给出平台相关的排查建议');
assert.ok(missing.tried.some((item) => item.result === '文件不存在'), '应记录尝试过的位置');

// Windows 风格的 CRLF 输出也要能正确解析（trim 掉 \r）
const crlf = await readGpuSnapshot({ bin: FAKE_SMI_CRLF });
assert.equal(crlf.gpus.length, 3);
assert.equal(crlf.gpus[0].name, 'NVIDIA GeForce RTX 4090');
assert.equal(crlf.gpus[0].memUsedMiB, 18920);
assert.equal(crlf.gpus[0].clockSmMHz, 2520, 'CRLF 下扩展字段同样要解析出来');
assert.equal(crlf.processes.length, 2);

/* ---------- 宿主指标：纯解析函数 ---------- */
const meminfo = parseMeminfo([
  'MemTotal:       263849712 kB',
  'MemFree:         12345678 kB',
  'MemAvailable:   234567890 kB',
  'Buffers:          1234567 kB',
  'SwapTotal:        8388604 kB',
  'SwapFree:         7340032 kB',
].join('\n'));
assert.equal(meminfo.memTotalKiB, 263849712);
assert.equal(meminfo.memAvailableKiB, 234567890);
assert.equal(meminfo.swapTotalKiB, 8388604);
assert.equal(meminfo.swapFreeKiB, 7340032);
// 没有 MemAvailable 的老内核要退回 MemFree
assert.equal(parseMeminfo('MemTotal: 100 kB\nMemFree: 40 kB').memAvailableKiB, 40);

const netRows = parseNetDev([
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0',
  '  eth0: 6000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0',
  '  eth1: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0',
].join('\n'));
assert.equal(netRows.length, 3);
assert.deepEqual(netRows[1], { name: 'eth0', rxBytes: 6000, txBytes: 5000 });

assert.equal(cpuUsagePct(null, { idle: 10, total: 20 }), null, '第一次采样没有基准');
assert.equal(cpuUsagePct({ idle: 10, total: 20 }, { idle: 20, total: 40 }), 50);
assert.equal(cpuUsagePct({ idle: 10, total: 20 }, { idle: 10, total: 20 }), null, '计数没变时无法计算');

/* ---------- 宿主指标：采集器（注入 /proc 内容，Linux 路径） ---------- */
let fakeNow = 1_000_000;
const proc = {
  meminfo: [
    'MemTotal:        1048576 kB',
    'MemAvailable:    524288 kB',
    'SwapTotal:        262144 kB',
    'SwapFree:         131072 kB',
  ].join('\n'),
  netdev: [
    '    lo: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0',
    '  eth0: 6000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0',
    '  eth1: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0',
  ].join('\n'),
};
const linuxSystem = createSystemCollector({
  platform: 'linux',
  diskTargets: [],
  now: () => fakeNow,
  readFile: async (file) => (String(file).includes('meminfo') ? proc.meminfo : proc.netdev),
});

const first = await linuxSystem.sample();
assert.equal(first.mem.totalMiB, 1024);
assert.equal(first.mem.usedMiB, 512);
assert.equal(first.mem.usedPct, 50);
assert.equal(first.swap.totalMiB, 256);
assert.equal(first.swap.usedMiB, 128);
assert.equal(first.cpu.usagePct, null, '第一次采样没有 CPU 基准');
assert.equal(first.net.rxBytesPerSec, null, '第一次采样没有网络基准');
assert.equal(first.net.interfaces, 2, 'lo 不计入网卡统计');
assert.equal(first.unsupported.includes('net'), false, 'Linux 上网络应可用');
assert.ok(Array.isArray(first.disk));

fakeNow += 1000;
proc.netdev = [
  '    lo: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0',
  '  eth0: 16000 0 0 0 0 0 0 0 6000 0 0 0 0 0 0 0',
  '  eth1: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0',
].join('\n');
const second = await linuxSystem.sample();
assert.equal(second.net.rxBytesPerSec, 10000, '1 秒内接收 10000 字节');
assert.equal(second.net.txBytesPerSec, 1000, '1 秒内发送 1000 字节');
// 两次采样之间几乎没有时间流逝时，CPU 累计计数不变，这时算不出使用率是预期行为
assert.ok(
  second.cpu.usagePct === null
  || (typeof second.cpu.usagePct === 'number' && second.cpu.usagePct >= 0 && second.cpu.usagePct <= 100),
  'CPU 使用率要么是 null，要么落在 0-100',
);

// Windows：内存与磁盘可用，交换分区 / 负载 / 网络明确标注不支持
const winSystem = createSystemCollector({ platform: 'win32', diskTargets: [] });
const win = await winSystem.sample();
assert.ok(win.mem.totalMiB > 0, 'Windows 上用 os.totalmem 取内存');
assert.equal(win.swap, null);
assert.equal(win.load, null);
assert.equal(win.net, null);
assert.ok(win.unsupported.includes('swap') && win.unsupported.includes('load') && win.unsupported.includes('net'));
assert.ok(Array.isArray(win.disk));

/* ---------- 空闲降频调度 ---------- */
const cadenceArgs = { intervalMs: 1000, idleAfterMs: 30000, idleIntervalMs: 10000 };
assert.deepEqual(
  resolveCadence({ ...cadenceArgs, lastClientAt: 0, now: 10 ** 9 }),
  { idle: false, delayMs: 1000 },
  '还没有过请求时应按正常频率采集，先把数据准备好',
);
assert.equal(resolveCadence({ ...cadenceArgs, lastClientAt: 1000, now: 30999 }).idle, false);
assert.equal(resolveCadence({ ...cadenceArgs, lastClientAt: 1000, now: 31000 }).idle, true);
assert.equal(resolveCadence({ ...cadenceArgs, lastClientAt: 1000, now: 10 ** 9 }).delayMs, 10000);
assert.equal(
  resolveCadence({ ...cadenceArgs, lastClientAt: 1000, now: 10 ** 9, idleAfterMs: 0 }).idle,
  false,
  '--idle-after 0 表示不降频',
);

/* ---------- 采集器：端到端跑一拍 ---------- */
const baseOptions = {
  intervalMs: 1000,
  windowSamples: 300,
  smiBin: null,
  system: true,
  extended: true,
  idleAfterMs: 30000,
  idleIntervalMs: 10000,
  diskTargets: [],
  version: 'test',
};
const stubSystem = {
  sample: async () => ({
    at: 1,
    unsupported: [],
    cpu: { usagePct: 10, cores: 4, model: 'stub' },
    mem: { totalMiB: 1000, usedMiB: 400, availableMiB: 600, usedPct: 40 },
    swap: null,
    load: { l1: 0, l5: 0, l15: 0 },
    disk: [],
    net: null,
    uptimeSec: 1,
  }),
};
const collector = createCollector({
  options: { ...baseOptions, smiBin: FAKE_SMI },
  systemCollector: stubSystem,
});
await collector.tick();
const state = collector.getState();

assert.equal(state.status, 'ok', '采集应成功');
assert.equal(state.gpus.length, 3);
assert.equal(state.gpus[0].clockSmMHz, 2520, '/api/state 应带上扩展指标');
assert.equal(state.processes.length, 2);
assert.equal(state.fields.extended, true);
assert.equal(state.system.mem.usedPct, 40, '/api/state 应带上宿主指标');
assert.equal(state.idle.active, false);
assert.equal(state.idle.currentIntervalMs, 1000);

const historyOut = collector.getHistory();
assert.equal(historyOut.samples.length, 1);
assert.equal(historyOut.samples[0].gpus[0].name, 'NVIDIA GeForce RTX 4090');
assert.equal(historyOut.samples[0].system.mem.usedPct, 40);
assert.equal(
  'clockSmMHz' in historyOut.samples[0].gpus[0],
  false,
  '曲线样本只保留必要字段，扩展指标只留在最新状态里',
);

collector.noteClient();
assert.equal(collector.cadence().idle, false, '刚有请求时不应处于空闲');
collector.stop();

// 模拟数据源下不该显示"探测中"：直接标记为 mock，界面据此给出准确文案
const mockCollector = createCollector({
  options: baseOptions,
  mockSource: createMockSource({ gpuCount: 2 }),
  systemCollector: stubSystem,
});
await mockCollector.tick();
const mockState = mockCollector.getState();
assert.equal(mockState.mock, true);
assert.equal(mockState.fields.mock, true, '模拟模式下要标明未做驱动探测');
assert.equal(mockState.gpus[0].clockSmMHz > 0, true, '模拟数据也要带扩展指标');
assert.equal(mockState.gpus[0].throttle != null, true);
mockCollector.stop();

// --no-system 的契约：systemCollector 传 null 时不该采集宿主指标
const noSystemCollector = createCollector({
  options: baseOptions,
  mockSource: createMockSource({ gpuCount: 1 }),
  systemCollector: null,
});
await noSystemCollector.tick();
const noSystemState = noSystemCollector.getState();
assert.equal(noSystemState.systemEnabled, false);
assert.equal(noSystemState.system, null);
assert.equal(noSystemState.gpus.length, 1, '关掉宿主指标不影响 GPU 采集');
noSystemCollector.stop();

/* ---------- 进程归属：cgroup / 用户 / 命令行的解析 ---------- */
// 用例取自真实服务器（一台跑着 vLLM 容器与 Schrödinger 作业的 A100 机器）
const dockerVllm = parseCgroup('0::/system.slice/docker-f82ea7a094268cae1962222556278877e19ff221f3972aa7bfc89201615ba040.scope');
assert.equal(dockerVllm.containerId, 'f82ea7a094268cae1962222556278877e19ff221f3972aa7bfc89201615ba040');
assert.equal(dockerVllm.unit, null, '容器的 .scope 不应被当成 systemd 服务');
assert.equal(dockerVllm.session, false);
assert.deepEqual(
  serviceLabel({ ...dockerVllm, containerName: 'vllm-server' }),
  { kind: 'container', label: '容器 vllm-server' },
);
assert.deepEqual(serviceLabel({ ...dockerVllm }), { kind: 'container', label: '容器 f82ea7a09426' }, '拿不到容器名时退回短 ID');

const userSession = parseCgroup('0::/user.slice/user-1004.slice/session-225.scope');
assert.equal(userSession.session, true);
assert.equal(userSession.containerId, null);
assert.deepEqual(serviceLabel(userSession), { kind: 'session', label: '用户会话' });

const systemService = parseCgroup('0::/system.slice/vllm.service');
assert.equal(systemService.unit, 'vllm.service');
assert.deepEqual(serviceLabel(systemService), { kind: 'systemd', label: 'vllm.service' });

// cgroup v1 的写法：层级:控制器:路径
const v1Docker = parseCgroup('11:pids:/docker/5901ee3472d59a8a04000546df4471d918987ff301b57d547c43dd7ec43c4178');
assert.equal(v1Docker.containerId, '5901ee3472d59a8a04000546df4471d918987ff301b57d547c43dd7ec43c4178');

// Kubernetes：既能认出容器，也能认出 Pod
const k8s = parseCgroup('0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod1a2b3c4d-1111-2222-3333-444455556666.slice/cri-containerd-1111222233334444555566667777888899990000111122223333444455556666.scope');
assert.equal(k8s.podId, '1a2b3c4d-1111-2222-3333-444455556666');
assert.equal(k8s.containerId, '1111222233334444555566667777888899990000111122223333444455556666');

// 既不是容器也不是服务：留空，不要编一个
assert.deepEqual(serviceLabel(parseCgroup('0::/')), { kind: null, label: null });
assert.equal(parseCgroup('').containerId, null);

assert.equal(parseUidStatus('Name:\tpython3\nUid:\t1004\t1004\t1004\t1004\nGid:\t1004\t1004\t1004\t1004\n'), 1004);
assert.equal(parseUidStatus('Name:\tx\n'), null);
assert.equal(parsePasswd('root:x:0:0:root:/root:/bin/bash\njklei:x:1004:1004::/home/jklei:/bin/bash\n').get(1004), 'jklei');
const mineruCmdline = Buffer.from(`${['/usr/bin/python3', '/usr/local/bin/mineru-api', '--port', '8000'].join('\0')}\0`);
assert.equal(parseCmdline(mineruCmdline), '/usr/bin/python3 /usr/local/bin/mineru-api --port 8000', 'NUL 分隔的命令行要拼回一行');
assert.equal(parseCmdline(Buffer.from('VLLM::EngineCore\0')), 'VLLM::EngineCore', '改写过标题的进程命令行只有这一个词');
assert.equal(parseCmdline(Buffer.from('\0')), null);
assert.ok(parseCmdline(Buffer.from('x'.repeat(400))).endsWith('…'), '过长的命令行要截断');

// 端到端（注入假文件）：读 /proc → 解析 cgroup → 解析容器名 → 取用户
const fakePid = 41381;
const fakeContainerId = 'f82ea7a094268cae1962222556278877e19ff221f3972aa7bfc89201615ba040';
const fakeFiles = {
  [`/proc/${fakePid}/cgroup`]: `0::/system.slice/docker-${fakeContainerId}.scope`,
  [`/proc/${fakePid}/status`]: 'Name:\tpython3\nUid:\t0\t0\t0\t0\n',
  [`/proc/${fakePid}/cmdline`]: Buffer.from('VLLM::EngineCore\0'),
  '/etc/passwd': 'root:x:0:0:root:/root:/bin/bash\njklei:x:1004:1004::/home/jklei:/bin/bash\n',
  [`/var/lib/docker/containers/${fakeContainerId}/config.v2.json`]: JSON.stringify({ Name: '/vllm-server' }),
};
let fakeReads = 0;
const infoReader = createProcessInfoReader({
  platform: 'linux',
  readFile: async (file) => {
    fakeReads += 1;
    if (file in fakeFiles) return fakeFiles[file];
    throw new Error(`ENOENT: ${file}`);
  },
  exec: async () => {
    throw new Error('docker 命令不可用（应该走元数据文件这条路）');
  },
  now: () => 1_000_000,
});
assert.equal(infoReader.supported, true);
const enrichedProcesses = await infoReader.enrich([{ pid: fakePid, name: 'VLLM::EngineCore', usedMemMiB: 8502 }]);
assert.equal(enrichedProcesses[0].service, '容器 vllm-server');
assert.equal(enrichedProcesses[0].serviceKind, 'container');
assert.equal(enrichedProcesses[0].user, 'root');
assert.equal(enrichedProcesses[0].containerName, 'vllm-server');
assert.equal(enrichedProcesses[0].cmdline, 'VLLM::EngineCore');
assert.equal(enrichedProcesses[0].name, 'VLLM::EngineCore', '原有字段不能被改动');
assert.equal(enrichedProcesses[0].usedMemMiB, 8502);

// 同一个 pid 在缓存期内不重复读 /proc
const readsAfterFirst = fakeReads;
await infoReader.enrich([{ pid: fakePid, name: 'VLLM::EngineCore' }]);
assert.equal(fakeReads, readsAfterFirst, '缓存期内不应重复读 /proc');

// 读不到 /proc（权限/不存在）时要原样返回，而不是把采集打断
const blindReader = createProcessInfoReader({
  platform: 'linux',
  readFile: async () => { throw new Error('EACCES'); },
  exec: async () => { throw new Error('docker 不可用'); },
  now: () => 1_000_000,
});
const blindResult = await blindReader.enrich([{ pid: 1, name: 'x' }]);
assert.equal(blindResult[0].service, null);
assert.equal(blindResult[0].user, null);
assert.equal(blindResult[0].name, 'x');

// 非 Linux 平台直接原样返回
const macReader = createProcessInfoReader({ platform: 'darwin' });
assert.equal(macReader.supported, false);
assert.deepEqual(await macReader.enrich([{ pid: 1, name: 'x' }]), [{ pid: 1, name: 'x' }]);

/* ---------- 历史库：行映射与节流位掩码 ---------- */
assert.equal(packThrottle(null), null, '驱动没报节流信息时应存 null');
assert.equal(packThrottle({ swPowerCap: false, hwThermal: false }), 0, '明确没有节流应存 0，与"未知"区分开');
const roundTrip = unpackThrottle(packThrottle({ swPowerCap: true, hwThermal: true, gpuIdle: false }));
assert.equal(roundTrip.swPowerCap, true);
assert.equal(roundTrip.hwThermal, true);
assert.equal(roundTrip.gpuIdle, false);

// 进程签名只看身份，不看显存数值，否则每个采样点都会写一遍
assert.equal(
  processesSignature([{ gpuIndex: 0, pid: 7, name: 'a', usedMemMiB: 1 }]),
  processesSignature([{ gpuIndex: 0, pid: 7, name: 'a', usedMemMiB: 999 }]),
);
assert.notEqual(
  processesSignature([{ gpuIndex: 0, pid: 7, name: 'a' }]),
  processesSignature([{ gpuIndex: 0, pid: 8, name: 'a' }]),
);

// node:sqlite 要 Node 22.5+。旧版本上这之后的断言（历史库、维护、迁移）都没法跑，
// 这里给一句明确说明就收尾，而不是抛一个"模块不存在"的堆栈让人以为代码坏了。
const sqliteReady = await (async () => {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();
if (!sqliteReady) {
  process.stdout.write(
    '\n⚠️  当前 Node 没有 node:sqlite（需要 ≥ 22.5）：历史库相关断言跳过，'
    + '前面的解析 / 指标 / 调度 / 采集器断言已全部通过。\n'
    + '   服务本身不受影响——历史库会自动退回内存窗口，页面会明确标注。\n'
    + '   升级到 Node 22 LTS 或 24 后可以完整跑一遍。\n',
  );
  process.exit(0);
}

/* ---------- 历史库：写入 / 查询 / 分桶 / 保留 ---------- */
const dbNow = 1_700_000_000_000;
const sqliteStore = await createSqliteStore({
  file: ':memory:',
  nodeId: 'test-node',
  storeIntervalMs: 1000,
  retentionDays: 0,
  processRefreshMs: 3000,
  now: () => dbNow,
});

const gpuAt = (i) => ({
  index: 0,
  uuid: 'GPU-test',
  name: 'RTX 4090',
  memUsedMiB: 100 + i,
  memTotalMiB: 1000,
  utilGpuPct: 50 + i,
  utilMemPct: 10,
  tempC: 60 + i,
  powerW: 100 + i,
  clockSmMHz: 2000,
  pstate: 'P2',
  fanPct: 40,
  throttle: { swPowerCap: i === 2, hwThermal: false, gpuIdle: false },
});
const procAt = (pid) => [{
  gpuUuid: 'GPU-test', gpuIndex: 0, pid, name: 'train.py', usedMemMiB: 90,
  service: '容器 vllm-server', user: 'root',
}];
const hostAt = (i) => ({
  cpu: { usagePct: 10 + i },
  mem: { usedMiB: 500, totalMiB: 1000, usedPct: 50 },
  swap: { usedMiB: 10, totalMiB: 100 },
  load: { l1: 0.5, l5: 0.4, l15: 0.3 },
  disk: [{ path: '/', usedMiB: 1, totalMiB: 2, usedPct: 50 }],
  net: { rxBytesPerSec: 1024, txBytesPerSec: 512 },
  uptimeSec: 42,
});

for (let i = 0; i < 6; i += 1) {
  sqliteStore.appendSample({
    t: dbNow + 1000 * i,
    gpus: [gpuAt(i)],
    processes: procAt(i === 4 ? 9 : 7),
    system: hostAt(i),
  });
}
sqliteStore.flush();

const storedStats = sqliteStore.stats();
assert.equal(storedStats.mode, 'sqlite');
assert.equal(storedStats.supportsHistory, true);
assert.equal(storedStats.written.gpu, 6);
assert.equal(storedStats.written.host, 6);
assert.equal(storedStats.oldestTs, dbNow);
assert.equal(storedStats.newestTs, dbNow + 5000);

const rawQuery = sqliteStore.querySamples({ from: dbNow - 1, to: dbNow + 10000 });
assert.equal(rawQuery.points, 6, '原始粒度应返回 6 个采样点');
assert.equal(rawQuery.step, 0);
assert.equal(rawQuery.samples[0].gpus[0].memUsedMiB, 100);
assert.equal(rawQuery.samples[0].gpus[0].clockSmMHz, 2000, '扩展指标应能存下来并读回');
assert.equal(rawQuery.samples[0].gpus[0].throttle.swPowerCap, false, '节流位掩码应能往返');
assert.equal(rawQuery.samples[2].gpus[0].throttle.swPowerCap, true);
assert.equal(rawQuery.samples[0].gpus[0].throttled, false);
assert.equal(rawQuery.samples[2].gpus[0].throttled, true);
assert.equal(rawQuery.samples[0].system.cpu.usagePct, 10);
assert.equal(rawQuery.samples[0].system.mem.usedPct, 50);

const bucketed = sqliteStore.querySamples({ from: dbNow - 1, to: dbNow + 10000, stepMs: 2000 });
assert.equal(bucketed.step, 2000);
// 采样点落在 T、T+1s…T+5s，按 2 秒分桶后是 [T, T+2s, T+4s] 三个桶
assert.equal(bucketed.points, 3, '6 秒按 2 秒分桶应得到 3 个桶');
assert.equal(bucketed.samples[0].gpus[0].pstate, null, '分桶后 pstate 已无意义，应置空');
assert.equal(bucketed.samples[1].gpus[0].throttled, true, '桶内出现过节流就要标记出来');

const capped = sqliteStore.querySamples({ from: dbNow - 1, to: dbNow + 10000, pointLimit: 3 });
assert.equal(capped.truncated, true, '超过点数上限要如实标记截断');
assert.ok(capped.points <= 3);

// 行数不多时，即使区间很宽也要给原始粒度（不能按"配置间隔"高估行数，把区间压成一两个点）
const wideRange = { from: dbNow - 1, to: dbNow + 10 * 3600 * 1000 };
assert.equal(sqliteStore.querySamples(wideRange).step, 0, '只有 6 行数据时不该分桶');
assert.equal(sqliteStore.querySamples(wideRange).points, 6);

// 行数真的超过上限时才自动分桶
const tinyBucketStore = await createSqliteStore({
  file: ':memory:',
  nodeId: 'test-node',
  storeIntervalMs: 1000,
  retentionDays: 0,
  maxPoints: 3,
  now: () => dbNow,
});
for (let i = 0; i < 6; i += 1) {
  tinyBucketStore.appendSample({ t: dbNow + 1000 * i, gpus: [gpuAt(i)], processes: [], system: null });
}
tinyBucketStore.flush();
const autoStep = tinyBucketStore.querySamples({ from: dbNow - 1, to: dbNow + 10000 });
assert.ok(autoStep.step > 0, '行数超过点数上限时应自动分桶');
assert.ok(autoStep.points <= 3, '分桶后点数应落在上限内');
tinyBucketStore.close();

// 进程只留档"身份变化"和定时快照
const procEvents = sqliteStore.queryProcesses({ from: dbNow - 1, to: dbNow + 10000 });
// 6 个采样点里：首次(7) + 3 秒定时快照(7) + 切到 9 + 又切回 7
assert.equal(procEvents.length, 4, '只写首次、定时快照与身份变化，不再逐点刷重复行');
assert.equal(procEvents[0].pid, 7, '最新一条是切回来的进程');
assert.ok(procEvents.some((event) => event.pid === 9), '进程切换也要留档');
assert.equal(procEvents[0].service, '容器 vllm-server', '服务归属要跟着进程一起落库');
assert.equal(procEvents[0].user, 'root');
assert.equal(
  sqliteStore.countProcesses({ from: dbNow - 1, to: dbNow + 10000 }),
  procEvents.length,
  '总数统计应与查询结果一致（界面要显示"共 N 条 / 显示最近 M 条"）',
);
assert.equal(sqliteStore.countProcesses({ from: 0, to: dbNow - 1 }), 0, '区间外应统计为 0');

// 保留策略：超出保留期的行会被清掉
const retentionStore = await createSqliteStore({
  file: ':memory:',
  nodeId: 'test-node',
  storeIntervalMs: 1000,
  retentionDays: 1,
  now: () => dbNow,
});
const oldTs = dbNow - 3 * 86400000;
retentionStore.appendSample({ t: oldTs, gpus: [gpuAt(0)], processes: [], system: hostAt(0) });
retentionStore.appendSample({ t: dbNow, gpus: [gpuAt(1)], processes: [], system: hostAt(1) });
retentionStore.flush();
// 用贴近样本的窄区间查询：区间拉得太宽会触发自动分桶，两条就会被合到同一个桶里
const nearOld = { from: oldTs - 1000, to: oldTs + 1000 };
const nearNow = { from: dbNow - 1000, to: dbNow + 1000 };
assert.equal(retentionStore.querySamples(nearOld).points, 1, '清理前应能查到 3 天前那条');
const dropped = retentionStore.prune(dbNow);
assert.equal(dropped, 2, '超过 1 天的 gpu/host 行各删一条');
assert.equal(retentionStore.querySamples(nearOld).points, 0, '过期的那条应被清掉');
assert.equal(retentionStore.querySamples(nearNow).points, 1, '没过期的那条要保留');
retentionStore.close();

// 空实现：没有历史库时要明确说"不支持"，而不是假装返回空历史
const memoryStore = createMemoryStore('未启用（--no-db）');
assert.equal(memoryStore.supportsHistory, false);
assert.equal(memoryStore.querySamples({ from: 0, to: 1 }).unsupported, true);
assert.equal([...memoryStore.gpuPages()].length, 0);
assert.equal(memoryStore.stats().reason, '未启用（--no-db）');
assert.equal(memoryStore.countProcesses({ from: 0, to: 1 }), 0);

/* ---------- 导出：按行生成（流式导出的基础） ---------- */
assert.equal(GPU_CSV_HEADER.startsWith('timestamp_iso,gpu_index'), true);
assert.equal(SYSTEM_CSV_HEADER.startsWith('timestamp_iso,cpu_usage_pct'), true);
assert.equal(
  gpuRowToCsv('2026-01-01T00:00:00.000Z', gpuFromRow({
    ts: dbNow, idx: 1, uuid: 'u', name: 'A, B', mem_used_mib: 10, mem_total_mib: 20,
    util_gpu_pct: 30, util_mem_pct: 40, temp_c: 50, power_w: 60,
  })),
  '2026-01-01T00:00:00.000Z,1,"A, B",10,20,50,30,40,50,60',
  '含逗号的名称要加引号，显存占用率按已用/总量算',
);
assert.equal(systemRowToCsv('2026-01-01T00:00:00.000Z', systemFromRow({
  ts: dbNow, cpu_pct: 12.34, mem_used_mib: 500, mem_total_mib: 1000, mem_used_pct: 50,
  swap_used_mib: null, swap_total_mib: null, load1: 0.5, load5: 0.4, load15: 0.3,
  disk_json: JSON.stringify([{ path: '/', usedMiB: 1, totalMiB: 2, usedPct: 50 }]),
  net_rx_bps: 0, net_tx_bps: 2048, uptime_sec: 42,
})), '2026-01-01T00:00:00.000Z,12.3,500,1000,50,,,0.5,0.4,0.3,/,1,2,50,0,2048');

sqliteStore.close();

/* ---------- 历史库降级：错误信息要翻成人话 ---------- */
// 这条信息会出现在启动横幅、/api/state.storage.reason、页面上的历史库与进程历史卡片
// 好几个地方，不能把 Node 的英文原始报错直接抛给用户
const missingSqliteError = Object.assign(new Error('No such built-in module: node:sqlite'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
assert.equal(
  describeStorageError(missingSqliteError, { nodeVersion: 'v18.19.1' }),
  '当前 Node v18.19.1 没有 node:sqlite，需要升级到 22.5 或更高',
);
// 界面上会把它包在"不可用（…）"里，所以这句自身不能带括号，否则读起来是双层嵌套
assert.equal(describeStorageError(missingSqliteError).includes('（'), false);
assert.equal(
  describeStorageError(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })),
  '没有权限写入历史库：EACCES: permission denied',
);
assert.equal(describeStorageError(Object.assign(new Error('no space left'), { code: 'ENOSPC' })), '磁盘空间不足，无法创建历史库');
assert.equal(describeStorageError(new Error('别的错')), '别的错', '认不出来的错误原样保留，不要吞掉');

// 走一遍 createStore 的降级路径（注入一个必然失败的实现）
const storageWarnings = [];
const degradedStore = await createStore({
  options: { db: true, dbPath: ':memory:', storeIntervalMs: 5000, retentionDays: 90, storeProcesses: true },
  nodeId: 'test-node',
  logger: { warn: (line) => storageWarnings.push(line) },
  createSqlite: async () => {
    throw missingSqliteError;
  },
});
assert.equal(degradedStore.mode, 'memory');
assert.equal(degradedStore.supportsHistory, false);
assert.ok(degradedStore.reason.includes('需要升级到 22.5'), '降级原因要能直接看懂');
assert.equal(degradedStore.reason.includes('built-in module'), false, '不应把 Node 的英文原始报错漏到界面上');
assert.equal(storageWarnings.length, 1, '降级要留一条日志，不能静默');
assert.ok(storageWarnings[0].includes('需要升级到 22.5'));
// 降级后行为要正常：查询返回"不支持"、写入不报错
assert.equal(degradedStore.querySamples({ from: 0, to: 1 }).unsupported, true);
assert.equal(degradedStore.appendSample({ t: 1, gpus: [] }), 0);
assert.equal(degradedStore.stats().mode, 'memory');

/* ---------- 历史库维护：增量回收与整库重写 ---------- */
const tmpDb = path.join(os.tmpdir(), `gm-maint-${process.pid}.db`);
const legacyDb = path.join(os.tmpdir(), `gm-legacy-${process.pid}.db`);
const removeDb = (file) => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(file + suffix);
    } catch {
      // 文件不存在就不用删
    }
  }
};
removeDb(tmpDb);
removeDb(legacyDb);
const bulkGpu = { index: 0, uuid: 'g', name: 'X', memUsedMiB: 100, memTotalMiB: 1000, utilGpuPct: 50, tempC: 60 };
const fillStore = (target, rows) => {
  for (let i = 0; i < rows; i += 1) {
    target.appendSample({ t: dbNow - 3 * 86400000 + i * 1000, gpus: [bulkGpu], processes: [], system: null });
  }
  target.flush();
};

// 新建库必须把增量回收写进文件头：只在连接里设一下是不够的，那样回收会静默失效
const maintStore = await createSqliteStore({
  file: tmpDb, nodeId: 'test-node', retentionDays: 1, storeIntervalMs: 1, now: () => dbNow,
});
assert.equal(maintStore.stats().autoVacuum, 2, '新建库应开启增量回收');
fillStore(maintStore, 5000);
maintStore.maintain();
const sizeBeforePrune = fs.statSync(tmpDb).size;
const prunedRows = maintStore.prune(dbNow);
const sizeAfterPrune = fs.statSync(tmpDb).size;
assert.equal(prunedRows, 5000);
assert.ok(sizeAfterPrune < sizeBeforePrune, `清理过期数据后文件应缩小（${sizeBeforePrune} → ${sizeAfterPrune}）`);
assert.equal(maintStore.stats().freelistBytes, 0, '增量回收后不应残留空闲页');
assert.equal(maintStore.stats().lastMaintain.incremental, true);
maintStore.close();

// 老库（建库时没开增量回收）：prune 不会还空间，需要 --reclaim 整库重写一次
const legacyStore = await createSqliteStore({
  file: legacyDb, nodeId: 'test-node', retentionDays: 1, storeIntervalMs: 1, incrementalVacuum: false, now: () => dbNow,
});
assert.equal(legacyStore.stats().autoVacuum, 0, '模拟的老库不应是增量回收模式');
fillStore(legacyStore, 5000);
legacyStore.maintain();
const legacySizeBefore = fs.statSync(legacyDb).size;
legacyStore.prune(dbNow);
assert.ok(legacyStore.stats().freelistBytes > 0, '老库删完数据会留下空闲页（不会自动还空间）');
const legacyResult = legacyStore.maintain({ reclaim: true });
assert.equal(legacyResult.reclaimed, true, '整库重写应被执行');
assert.equal(legacyStore.stats().autoVacuum, 2, '重写后应转成增量回收模式');
assert.ok(fs.statSync(legacyDb).size < legacySizeBefore, '整库重写后文件应缩小');
legacyStore.close();
removeDb(tmpDb);
removeDb(legacyDb);

/* ---------- 历史库：老库补列迁移 ---------- */
const legacySchemaFile = path.join(os.tmpdir(), `gm-legacy-schema-${process.pid}.db`);
removeDb(legacySchemaFile);
{
  // 手工造一个"旧版表结构"：没有 pcie / 编解码 / 显存时钟这些后加的列
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(legacySchemaFile);
  legacy.exec(`CREATE TABLE gpu_sample (
    ts INTEGER NOT NULL, node_id TEXT NOT NULL, uuid TEXT, idx INTEGER, name TEXT,
    mem_used_mib REAL, mem_total_mib REAL, util_gpu_pct REAL, util_mem_pct REAL,
    temp_c REAL, power_w REAL, clock_sm_mhz REAL, pstate TEXT, fan_pct REAL,
    throttle_mask INTEGER, throttle_any INTEGER)`);
  legacy.prepare('INSERT INTO gpu_sample (ts, node_id, uuid, idx, name, mem_used_mib, mem_total_mib) VALUES (?,?,?,?,?,?,?)')
    .run(dbNow, 'n', 'g-old', 0, 'Old GPU', 1234, 2000);
  legacy.close();
}
const migratedStore = await createSqliteStore({
  file: legacySchemaFile, nodeId: 'test-node', storeIntervalMs: 1000, retentionDays: 0, now: () => dbNow,
});
// 查询语句本身引用了新列：如果迁移没生效，这里会直接抛 "no such column"
const migratedSamples = migratedStore.querySamples({ from: dbNow - 1, to: dbNow + 1 });
assert.equal(migratedSamples.samples[0].gpus[0].memUsedMiB, 1234, '升级后老数据必须还在');
assert.equal(migratedSamples.samples[0].gpus[0].pcieGen, null, '补上的新列对老数据应为空');
assert.equal(migratedSamples.samples[0].gpus[0].decUtilPct, null);
assert.equal(migratedSamples.samples[0].gpus[0].clockMemMHz, null);

// 新写入的扩展字段要能存下来、读回来
migratedStore.appendSample({
  t: dbNow + 1000,
  gpus: [{
    index: 1, uuid: 'g-new', name: 'New GPU', memUsedMiB: 1, memTotalMiB: 2, memUsedPct: 50,
    pcieGen: 4, pcieWidth: 16, encUtilPct: 3, decUtilPct: 1, clockMemMHz: 9001, fanPct: 41,
    pstate: 'P2', throttle: { swPowerCap: true },
  }],
  processes: [],
  system: null,
});
migratedStore.flush();
const extendedSample = migratedStore.querySamples({ from: dbNow + 500, to: dbNow + 2000 }).samples[0].gpus[0];
assert.equal(extendedSample.pcieGen, 4);
assert.equal(extendedSample.pcieWidth, 16);
assert.equal(extendedSample.encUtilPct, 3);
assert.equal(extendedSample.decUtilPct, 1);
assert.equal(extendedSample.clockMemMHz, 9001);
assert.equal(extendedSample.throttle.swPowerCap, true);
migratedStore.close();
removeDb(legacySchemaFile);

/* ---------- 导出：扩展字段 ---------- */
assert.ok(GPU_CSV_HEADER_FULL.startsWith(GPU_CSV_HEADER), '扩展表头要在基础表头之后追加');
for (const column of ['pcie_gen', 'enc_util_pct', 'clock_mem_mhz', 'throttled']) {
  assert.ok(GPU_CSV_HEADER_FULL.includes(column), `扩展表头缺少 ${column}`);
}
assert.equal(GPU_CSV_HEADER.includes('pcie_gen'), false, '默认表头不应被改动');
const fullCsv = samplesToCsv([{
  t: Date.UTC(2026, 0, 1),
  gpus: [{
    index: 0, name: 'A, B', memUsedMiB: 10, memTotalMiB: 20, memUsedPct: 50, utilGpuPct: 30,
    utilMemPct: 40, tempC: 50, powerW: 60, clockSmMHz: 2500, clockMemMHz: 9001, pstate: 'P2',
    fanPct: 41, pcieGen: 4, pcieWidth: 16, encUtilPct: 3, decUtilPct: 1, throttled: true,
  }],
}], { full: true });
const fullLines = fullCsv.trim().split('\n');
assert.equal(fullLines[0], GPU_CSV_HEADER_FULL);
assert.ok(fullLines[1].endsWith(',2500,9001,P2,41,4,16,3,1,1'), `扩展列内容不对：${fullLines[1]}`);
// 没拿到节流信息时留空，不要写成 0（那是"明确没有节流"的意思）
assert.ok(
  gpuRowToCsv('2026-01-01T00:00:00.000Z', { index: 0, name: 'X', throttled: null }, { full: true }).endsWith(','),
  '节流信息未知时应留空',
);

/* ---------- 部署前自检 ---------- */
const preflight = await runPreflight({
  gpuBin: FAKE_SMI,
  dbPath: path.join(os.tmpdir(), `gm-preflight-${process.pid}.db`),
  alertsPath: '/nonexistent/alerts.json',
  skipPortCheck: true,
  systemDelayMs: 30,
});
assert.equal(preflight.blockers.length, 0, `自检不应有阻塞项：${preflight.blockers.join('；')}`);
assert.equal(preflight.facts.gpuCount, 3, '自检应能读到 fake nvidia-smi 的 3 张卡');
const gpuSection = preflight.sections.find((section) => section.title === 'GPU');
assert.ok(gpuSection, '自检报告里应有 GPU 小节');
assert.ok(gpuSection.lines.some(([, text]) => text.includes('3 张显卡')));
for (const title of ['运行环境', 'GPU', '宿主指标', '历史库', '告警', '端口']) {
  assert.ok(preflight.sections.some((section) => section.title === title), `自检报告缺 ${title} 小节`);
}

// 找不到 nvidia-smi 时必须如实报阻塞，而不是给出"可以启动"
const badPreflight = await runPreflight({
  gpuBin: '/nonexistent/nvidia-smi',
  dbPath: path.join(os.tmpdir(), 'gm-preflight-missing.db'),
  alertsPath: '/nonexistent/alerts.json',
  skipPortCheck: true,
  systemDelayMs: 30,
});
assert.ok(badPreflight.blockers.length > 0, '读不到显卡时应报阻塞');

/* ---------- 健康检查 ---------- */
const healthBase = {
  status: 'ok',
  intervalMs: 1000,
  lastSampleAt: 1_000_000,
  gpus: [{ index: 0 }, { index: 1 }],
  processes: [{ pid: 1 }],
  uptimeSec: 3600,
  hostname: 'host-a',
};
const healthStorage = {
  mode: 'sqlite', path: '/data/gpu-monitor.db', sizeBytes: 1024 ** 3,
  buffered: 0, lastFlushAt: 999_000,
};
const bigDisk = () => 10 * 1024 ** 3;

const healthy = evaluateHealth({
  state: healthBase, storage: healthStorage, alerts: { enabled: true, ruleCount: 3, firing: [] },
  version: 'test', probePath: '/data', now: () => 1_000_500, freeSpace: bigDisk,
});
assert.equal(healthy.status, 'healthy');
assert.equal(healthy.statusCode, 200);
assert.equal(healthy.checks.length, 4, '检查项应为 采集 / 历史库 / 磁盘 / 告警');

// 采集过期 → 503
const staleHealth = evaluateHealth({
  state: healthBase, storage: healthStorage, now: () => 1_060_000, freeSpace: bigDisk,
});
assert.equal(staleHealth.status, 'unhealthy');
assert.equal(staleHealth.statusCode, 503);
assert.equal(staleHealth.checks.find((check) => check.name === 'collector').level, 'fail');

// 空闲降频期间采集本来就慢，阈值要跟着放宽，不能误报
const idleHealth = evaluateHealth({
  state: { ...healthBase, idle: { active: true, currentIntervalMs: 10000 } },
  storage: healthStorage, now: () => 1_020_000, freeSpace: bigDisk,
});
assert.equal(idleHealth.checks.find((check) => check.name === 'collector').level, 'ok', '空闲降频不应误报采集过期');

// 采集报错 → 503，并把原因带出来
const brokenHealth = evaluateHealth({
  state: { ...healthBase, status: 'error', error: '找不到 nvidia-smi' },
  storage: healthStorage, now: () => 1_000_500, freeSpace: bigDisk,
});
assert.equal(brokenHealth.statusCode, 503);
assert.ok(brokenHealth.checks.find((check) => check.name === 'collector').detail.includes('找不到 nvidia-smi'));

// 磁盘：紧张只是提醒（仍 200），见底才算致命
const diskWarnHealth = evaluateHealth({
  state: healthBase, storage: healthStorage, probePath: '/data', now: () => 1_000_500,
  freeSpace: () => 200 * 1024 ** 2,
});
assert.equal(diskWarnHealth.status, 'degraded');
assert.equal(diskWarnHealth.statusCode, 200);
assert.equal(diskWarnHealth.checks.find((check) => check.name === 'disk').level, 'warn');
const diskFailHealth = evaluateHealth({
  state: healthBase, storage: healthStorage, probePath: '/data', now: () => 1_000_500,
  freeSpace: () => 10 * 1024 ** 2,
});
assert.equal(diskFailHealth.statusCode, 503);

// 写库失败 → 503
const storeBrokenHealth = evaluateHealth({
  state: { ...healthBase, storeWarning: '写入历史库失败：disk I/O error' },
  storage: healthStorage, now: () => 1_000_500, freeSpace: bigDisk,
});
assert.equal(storeBrokenHealth.statusCode, 503);

// 没开历史库不算不健康；告警触发中属于"机器有事"，也不影响服务健康
const noDbHealth = evaluateHealth({
  state: healthBase, storage: { mode: 'memory', reason: '未启用（--no-db）' },
  alerts: { enabled: true, ruleCount: 2, firing: [{}, {}] }, now: () => 1_000_500,
});
assert.equal(noDbHealth.statusCode, 200);
assert.ok(noDbHealth.checks.find((check) => check.name === 'alerts').detail.includes('2 条触发中'));
assert.equal(noDbHealth.checks.some((check) => check.name === 'disk'), false, '没有落库时不需要盯磁盘');

/* ---------- systemd 单元模板 ---------- */
const unitPath = path.join(HERE, '..', 'deploy', 'gpu-monitor.service');
const unitText = fs.readFileSync(unitPath, 'utf8');
unitText.split('\n').forEach((line, index) => {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return;
  // systemd 不支持行尾注释：井号会被当成值的一部分（这个坑踩过一次）
  assert.equal(line.includes('#'), false, `单元文件第 ${index + 1} 行有行尾注释：${trimmed}`);
});
assert.ok(unitText.includes('[Service]') && unitText.includes('[Install]'));
for (const directive of ['Description=', 'WorkingDirectory=', 'ExecStart=', 'Restart=', 'KillSignal=', 'WantedBy=']) {
  assert.ok(unitText.includes(directive), `单元文件缺少 ${directive}`);
}
// ExecStart 里引用的脚本必须真实存在，避免改了文件名忘了改模板
const referencedScripts = [...unitText.matchAll(/(\S+\.js)\b/g)].map((match) => match[1]);
assert.ok(referencedScripts.length > 0, '单元文件里应引用到 server.js');
for (const reference of referencedScripts) {
  assert.ok(fs.existsSync(path.join(HERE, '..', path.basename(reference))), `模板引用的脚本不存在：${reference}`);
}

/* ---------- 推送订阅（SSE 底座） ---------- */
const pushCollector = createCollector({
  options: baseOptions,
  mockSource: createMockSource({ gpuCount: 1 }),
  systemCollector: stubSystem,
});
const received = [];
const unsubscribe = pushCollector.subscribe((payload) => received.push(payload));
assert.equal(pushCollector.subscriberCount(), 1);
await pushCollector.tick();
assert.equal(received.length, 1, '每采集一帧就推送一次');
assert.equal(received[0].gpus.length, 1, '推送内容与 /api/state 同构');
assert.equal(received[0].push.enabled, true);
unsubscribe();
await pushCollector.tick();
assert.equal(received.length, 1, '取消订阅后不再推送');
assert.equal(pushCollector.subscriberCount(), 0);
pushCollector.stop();

// 订阅者会把"没人访问"的空闲降频顶掉：页面开着推送时不该降频
let fakeTime = 1_000_000;
const idleCollector = createCollector({
  options: { ...baseOptions, idleAfterMs: 30000 },
  mockSource: createMockSource({ gpuCount: 1 }),
  systemCollector: stubSystem,
  now: () => fakeTime,
});
idleCollector.noteClient();
fakeTime += 60000;
assert.equal(idleCollector.cadence().idle, true, '60 秒没人访问应进入空闲降频');
const off = idleCollector.subscribe(() => {});
assert.equal(idleCollector.cadence().idle, false, '有 SSE 订阅者时不应降频');
off();
assert.equal(idleCollector.cadence().idle, true, '取消订阅后恢复空闲判定');
idleCollector.stop();

// extraState：上层挂进状态的字段（告警就是这么挂的）必须同时出现在 getState 与推送里
const extraCollector = createCollector({
  options: baseOptions,
  mockSource: createMockSource({ gpuCount: 1 }),
  systemCollector: null,
  extraState: () => ({ alerts: { enabled: true, firing: [{ id: 'demo' }] } }),
});
await extraCollector.tick();
assert.equal(extraCollector.getState().alerts.firing.length, 1);
const pushedStates = [];
const offExtra = extraCollector.subscribe((payload) => pushedStates.push(payload));
await extraCollector.tick();
assert.equal(pushedStates[0].alerts.firing.length, 1, '推送与 /api/state 用的必须是同一份状态');
offExtra();
extraCollector.stop();

/* ---------- 告警：时长解析与规则规范化 ---------- */
assert.equal(parseDuration('5m'), 300000);
assert.equal(parseDuration('2h'), 7200000);
assert.equal(parseDuration('30'), 30000, '纯数字按秒算');
assert.equal(parseDuration('500ms'), 500);
assert.equal(parseDuration(1500), 1500, '数字直接当毫秒');
assert.equal(parseDuration('看不懂', 42), 42, '无法解析时用兜底值');

const normalized = normalizeRules({
  rules: [
    { id: 'ok', metric: 'tempC', op: '>=', threshold: 85, for: '1m' },
    { id: 'bad-metric', metric: 'nope', op: '>', threshold: 1 },
    { id: 'bad-op', metric: 'tempC', op: '=~', threshold: 1 },
    { id: 'no-threshold', metric: 'tempC', op: '>=' },
    { id: 'turned-off', metric: 'tempC', op: '>=', threshold: 1, enabled: false },
    { id: 'bool', metric: 'throttled', op: '==', value: true },
  ],
});
assert.equal(normalized.rules.length, 2, '有问题和被显式关闭的规则都不进列表');
assert.equal(normalized.problems.length, 3, '问题要逐条报出来，而不是整份配置失效');
assert.equal(normalized.rules[0].forMs, 60000);
assert.equal(normalized.rules[0].scope, 'gpu');
assert.equal(normalized.rules[1].scope, 'gpu');
assert.equal(compare(90, { op: '>=', threshold: 90 }), true);
assert.equal(compare(89, { op: '>=', threshold: 90 }), false);
assert.equal(compare(true, { op: '==', value: true }), true);
assert.equal(compare(null, { op: '>=', threshold: 1 }), false, '取不到值时不应误判');

/* ---------- 告警：判定、抑制与恢复 ---------- */
let alertClock = 1_000_000;
let alertSamples = [];
const notifications = [];
const alertEngine = createAlertEngine({
  config: {
    cooldown: '10m',
    window: 300000,
    rules: [
      { id: 'vram', metric: 'memUsedPct', op: '>=', threshold: 90, for: '2s', level: 'warning' },
      { id: 'collect-down', metric: 'collectOk', op: '==', value: false, for: '30s', level: 'critical' },
    ],
  },
  getSamples: () => alertSamples,
  notifier: { send: async (payload) => notifications.push(payload) },
  now: () => alertClock,
  logger: { warn() {} },
});
const flushTasks = () => new Promise((resolve) => setImmediate(resolve));

const alertGpu = (memPct) => ({
  index: 0,
  uuid: 'g0',
  name: 'X',
  memUsedPct: memPct,
  tempC: 60,
  throttle: { swPowerCap: false },
});

// 只有 1 个采样点、跨度不足 for：不该触发
alertSamples = [{ t: alertClock, gpus: [alertGpu(95)], system: null }];
alertEngine.evaluate({ status: 'ok', lastSampleAt: alertClock, gpus: [] });
await flushTasks();
assert.equal(notifications.length, 0, '持续时间不足 for 时不应触发');

// 条件持续 3 秒：触发一次
alertSamples = [
  { t: alertClock - 3000, gpus: [alertGpu(95)], system: null },
  { t: alertClock - 1000, gpus: [alertGpu(96)], system: null },
  { t: alertClock, gpus: [alertGpu(97)], system: null },
];
let result = alertEngine.evaluate({ status: 'ok', lastSampleAt: alertClock, gpus: [] });
await flushTasks();
assert.equal(result.firing.length, 1);
assert.equal(notifications.length, 1, '触发时通知一次');
assert.equal(notifications[0].kind, 'firing');
assert.equal(notifications[0].ruleId, 'vram');
assert.ok(notifications[0].detail.includes('GPU 0'), '告警文案要带上是哪张卡');
assert.ok(notifications[0].detail.includes('仅覆盖'), '数据不足以覆盖 for 时要如实标注覆盖时长');

// 仍在告警：冷却期内不再重复通知
alertClock += 1000;
alertSamples = alertSamples.map((sample) => ({ ...sample, t: sample.t + 1000 }));
alertEngine.evaluate({ status: 'ok', lastSampleAt: alertClock, gpus: [] });
await flushTasks();
assert.equal(notifications.length, 1, '冷却期内不重复通知');
assert.equal(alertEngine.snapshot().firing.length, 1);

// 恢复：补一条 resolved，并从触发列表移除
alertClock += 1000;
alertSamples = [
  { t: alertClock - 1000, gpus: [alertGpu(40)], system: null },
  { t: alertClock, gpus: [alertGpu(35)], system: null },
];
result = alertEngine.evaluate({ status: 'ok', lastSampleAt: alertClock, gpus: [] });
await flushTasks();
assert.equal(result.firing.length, 0);
assert.equal(result.resolved.length, 1);
assert.equal(notifications.length, 2);
assert.equal(notifications[1].kind, 'resolved');
assert.ok(notifications[1].detail.includes('已恢复正常'));
assert.equal(alertEngine.snapshot().firing.length, 0);

// 采集中断：状态不是 ok 且已经静默超过 for（地板 30 秒）
alertClock += 60000;
alertSamples = [{ t: alertClock - 60000, gpus: [alertGpu(10)], system: null }];
alertEngine.evaluate({ status: 'error', lastSampleAt: alertClock - 60000, gpus: [] });
await flushTasks();
assert.equal(notifications.length, 3);
assert.equal(notifications[2].ruleId, 'collect-down');
assert.equal(notifications[2].level, 'critical');

/* ---------- 告警：配置加载与环境变量展开 ---------- */
/* ---------- 告警：长周期判定改用历史库 ---------- */
let histClock = 2_000_000;
const MEMORY_WINDOW_MS = 5 * 60 * 1000;
const gpuSample = (t, tempC, extra = {}) => ({
  t,
  gpus: [{ index: 0, uuid: 'g0', name: 'X', tempC, memUsedPct: 50, throttle: { swPowerCap: false }, ...extra }],
  system: null,
});

let memorySamples = [];
let storedSamples = [];
let historyCalls = 0;
let historyFails = false;
const longRunNotifications = [];
const longEngine = createAlertEngine({
  config: {
    window: MEMORY_WINDOW_MS,
    cooldown: '10m',
    historyCache: '30s',
    rules: [{ id: 'hot-10m', metric: 'tempC', op: '>=', threshold: 80, for: '10m', level: 'warning' }],
  },
  getSamples: () => memorySamples,
  history: ({ from, to }) => {
    historyCalls += 1;
    if (historyFails) throw new Error('库打不开了');
    return { samples: storedSamples.filter((sample) => sample.t >= from && sample.t <= to), step: 0 };
  },
  notifier: { send: async (payload) => longRunNotifications.push(payload) },
  now: () => histClock,
  logger: { warn() {} },
});

// 内存窗口（最近 5 分钟）全都在阈值之上，但历史库里 10 分钟前有一段正常温度
memorySamples = [gpuSample(histClock - 240000, 85), gpuSample(histClock - 60000, 88), gpuSample(histClock, 86)];
storedSamples = [
  gpuSample(histClock - 570000, 60),
  gpuSample(histClock - 480000, 62),
  gpuSample(histClock - 300000, 85),
  gpuSample(histClock - 240000, 85),
  gpuSample(histClock - 60000, 88),
  gpuSample(histClock, 86),
];
let longResult = longEngine.evaluate({ status: 'ok', lastSampleAt: histClock, gpus: [{ index: 0, uuid: 'g0' }] });
await flushTasks();
assert.equal(longResult.firing.length, 0, '10 分钟里早期温度正常，长周期规则不该触发（只看内存窗口会误报）');
assert.equal(historyCalls, 1, '应该去查了历史库');

// 缓存周期内不重复查库
longEngine.evaluate({ status: 'ok', lastSampleAt: histClock, gpus: [{ index: 0, uuid: 'g0' }] });
await flushTasks();
assert.equal(historyCalls, 1, '缓存周期内不应重复查库');

// 过了缓存周期，历史库里整段都超阈值：触发
histClock += 40000;
memorySamples = memorySamples.map((sample) => ({ ...sample, t: sample.t + 40000 }));
storedSamples = Array.from({ length: 12 }, (_, i) => gpuSample(histClock - (11 - i) * 60000, 85));
longResult = longEngine.evaluate({ status: 'ok', lastSampleAt: histClock, gpus: [{ index: 0, uuid: 'g0' }] });
await flushTasks();
assert.equal(historyCalls, 2, '缓存过期后应重新查库');
assert.equal(longResult.firing.length, 1, '整段区间都满足条件时应触发');
assert.equal(longRunNotifications.length, 1);
const longSnapshot = longEngine.snapshot();
assert.equal(longSnapshot.history.enabled, true);
assert.equal(longSnapshot.history.longRuleCount, 1);
assert.equal(longSnapshot.history.queries, 2);

// 查库失败时不能把采集带崩：沿用旧缓存，并记录错误
historyFails = true;
histClock += 40000;
longEngine.evaluate({ status: 'ok', lastSampleAt: histClock, gpus: [{ index: 0, uuid: 'g0' }] });
await flushTasks();
assert.equal(historyCalls, 3, '失败也说明尝试过了');
assert.ok(longEngine.snapshot().history.lastError.includes('库打不开了'));
historyFails = false;

// 分桶查回来的历史样本没有逐项节流掩码，只有聚合后的 throttled
const throttleEngine = createAlertEngine({
  config: {
    window: MEMORY_WINDOW_MS,
    rules: [{ id: 'throttled-10m', metric: 'throttled', op: '==', value: true, for: '10m', level: 'warning' }],
  },
  getSamples: () => [],
  history: () => ({
    samples: [
      { t: histClock - 600000, gpus: [{ index: 0, uuid: 'g0', throttle: null, throttled: true }], system: null },
      { t: histClock - 300000, gpus: [{ index: 0, uuid: 'g0', throttle: null, throttled: true }], system: null },
      { t: histClock, gpus: [{ index: 0, uuid: 'g0', throttle: null, throttled: true }], system: null },
    ],
    step: 60000,
  }),
  notifier: { send: async () => {} },
  now: () => histClock,
  logger: { warn() {} },
});
assert.equal(throttleEngine.evaluate({ status: 'ok', lastSampleAt: histClock, gpus: [] }).firing.length, 1, '分桶后的节流聚合值也要能被识别');

// 内存窗口里的节流信息：曾经因为环形缓冲裁剪掉了 throttle 字段，throttled 规则永不触发
process.env.GPU_MONITOR_MOCK_HIGH = '1';
const curveCollector = createCollector({
  options: baseOptions,
  mockSource: createMockSource({ gpuCount: 1 }),
  systemCollector: null,
});
delete process.env.GPU_MONITOR_MOCK_HIGH;
await curveCollector.tick();
await curveCollector.tick();
const curveSamples = curveCollector.getSamples();
assert.equal('throttled' in curveSamples[0].gpus[0], true, '曲线样本要带上节流状态，否则 throttled 规则永远不会触发');
assert.equal(curveSamples[0].gpus[0].throttled, true, '高负载模拟数据应处于节流状态');
const throttledEngine = createAlertEngine({
  config: { window: 300000, rules: [{ id: 'thr', metric: 'throttled', op: '==', value: true, for: '1s' }] },
  getSamples: () => curveSamples,
  notifier: { send: async () => {} },
  logger: { warn() {} },
});
assert.ok(
  throttledEngine.evaluate({ status: 'ok', lastSampleAt: Date.now(), gpus: [] }).firing.length >= 1,
  '内存窗口路径下 throttled 规则应能触发',
);
curveCollector.stop();

// for=0 表示"当下满足就报"：不能被更早的正常样本挡住
const instantEngine = createAlertEngine({
  config: { window: 300000, rules: [{ id: 'hot-now', metric: 'tempC', op: '>=', threshold: 80, for: 0 }] },
  getSamples: () => [
    { t: 1000, gpus: [{ index: 0, uuid: 'g0', tempC: 20, throttle: { swPowerCap: false } }], system: null },
    { t: 2000, gpus: [{ index: 0, uuid: 'g0', tempC: 85, throttle: { swPowerCap: false } }], system: null },
  ],
  notifier: { send: async () => {} },
  logger: { warn() {} },
});
assert.equal(instantEngine.evaluate({ status: 'ok', gpus: [] }).firing.length, 1, 'for=0 应只看最新一个采样点');

// for 比采集间隔还短（for:1s + 每秒采集）时不该被"至少两个点"挡住
const shortForEngine = createAlertEngine({
  config: {
    window: 60000,
    intervalMs: 1000,
    rules: [{ id: 'brief', metric: 'tempC', op: '>=', threshold: 80, for: '1s' }],
  },
  getSamples: () => [
    { t: 1000, gpus: [{ index: 0, uuid: 'g0', tempC: 85, throttle: { swPowerCap: false } }], system: null },
    { t: 2000, gpus: [{ index: 0, uuid: 'g0', tempC: 86, throttle: { swPowerCap: false } }], system: null },
  ],
  notifier: { send: async () => {} },
  now: () => 2100,
  logger: { warn() {} },
});
assert.equal(
  shortForEngine.evaluate({ status: 'ok', gpus: [] }).firing.length,
  1,
  'for 与采集间隔相同时，窗口内只有一个点也应判定（并标注覆盖时长）',
);

// 抖动抑制：恢复之后马上又触发，冷却期内不该再发一封（否则状态横跳时会刷屏）
let flapClock = 5_000_000;
let flapSamples = [];
const flapNotifications = [];
const flapGpu = (tempC) => ({
  index: 0, uuid: 'g0', name: 'X', memUsedPct: 50, tempC, throttle: { swPowerCap: false },
});
const flapEngine = createAlertEngine({
  config: {
    window: 60000,
    cooldown: '10m',
    intervalMs: 1000,
    rules: [{ id: 'flap', metric: 'tempC', op: '>=', threshold: 80, for: '2s' }],
  },
  getSamples: () => flapSamples,
  notifier: { send: async (payload) => flapNotifications.push(payload) },
  now: () => flapClock,
  logger: { warn() {} },
});
const hotSamples = () => [
  { t: flapClock - 2000, gpus: [flapGpu(85)], system: null },
  { t: flapClock - 1000, gpus: [flapGpu(85)], system: null },
  { t: flapClock, gpus: [flapGpu(85)], system: null },
];
flapSamples = hotSamples();
flapEngine.evaluate({ status: 'ok', gpus: [] });
await flushTasks();
assert.equal(flapNotifications.length, 1, '首次触发通知一次');

// 恢复正常 → 补一条"恢复"
flapClock += 1000;
flapSamples = [
  { t: flapClock - 1000, gpus: [flapGpu(30)], system: null },
  { t: flapClock, gpus: [flapGpu(30)], system: null },
];
flapEngine.evaluate({ status: 'ok', gpus: [] });
await flushTasks();
assert.equal(flapNotifications.length, 2);
assert.equal(flapNotifications[1].kind, 'resolved');

// 马上又触发：状态回到告警中，但冷却期内不再发信
flapClock += 1000;
flapSamples = hotSamples();
const flapResult = flapEngine.evaluate({ status: 'ok', gpus: [] });
await flushTasks();
assert.equal(flapResult.firing.length, 1, '状态仍应标记为告警中');
assert.equal(flapNotifications.length, 2, '冷却期内不重复发信，包括"刚恢复又触发"的抖动');

// 历史与内存合并：内存里的新点要算进来，同一时间戳以历史版本为准（字段更全）
let mergedClock = 3000;
const mergedEngine = createAlertEngine({
  config: { window: 60000, cooldown: '10m', rules: [{ id: 'hot', metric: 'tempC', op: '>=', threshold: 90, for: '10m' }] },
  getSamples: () => [
    { t: 2000, gpus: [{ index: 0, uuid: 'g0', tempC: 20, throttle: { swPowerCap: false } }], system: null },
    { t: 3000, gpus: [{ index: 0, uuid: 'g0', tempC: 95, throttle: { swPowerCap: false } }], system: null },
  ],
  history: () => ({
    samples: [
      { t: 1000, gpus: [{ index: 0, uuid: 'g0', tempC: 95, throttle: null, throttled: false }], system: null },
      { t: 2000, gpus: [{ index: 0, uuid: 'g0', tempC: 95, throttle: null, throttled: false }], system: null },
    ],
    step: 0,
  }),
  notifier: { send: async () => {} },
  now: () => mergedClock,
  logger: { warn() {} },
});
assert.equal(
  mergedEngine.evaluate({ status: 'ok', gpus: [] }).firing.length,
  1,
  '同一时间戳应保留历史版本（温度 95），内存里更新的点也要合并进来',
);

/* ---------- 告警：配置加载与环境变量展开 ---------- */
process.env.GM_TEST_SMTP_PASS = 'secret';
assert.equal(expandEnv('${GM_TEST_SMTP_PASS}'), 'secret');
assert.deepEqual(expandEnv({ a: ['${GM_TEST_SMTP_PASS}', 1] }), { a: ['secret', 1] });
delete process.env.GM_TEST_SMTP_PASS;
assert.equal((await loadAlertsConfig('/nonexistent/alerts.json')).missing, true, '没有配置文件不算错误');
assert.ok((await loadAlertsConfig(FAKE_SMI)).error, 'JSON 解析失败要给出原因');

/* ---------- 告警运行时：热加载与"改坏了不丢告警" ---------- */
const alertsFile = path.join(os.tmpdir(), `gm-alerts-${process.pid}.json`);
const writeAlerts = (rules) => fs.writeFileSync(alertsFile, JSON.stringify({ enabled: true, cooldown: '5m', rules }));
const runtimeBase = {
  options: {
    alerts: true,
    alertsPath: alertsFile,
    alertsDryRun: true,
    alertsReload: false,
    windowSamples: 300,
    intervalMs: 1000,
  },
  collector: { subscribe: () => () => {}, getSamples: () => [] },
  store: { supportsHistory: false },
  logger: { warn() {}, info() {} },
  watch: false,
};

writeAlerts([{ id: 'a', metric: 'tempC', op: '>=', threshold: 80, for: '1m' }]);
const alertsRuntime = createAlertsRuntime(runtimeBase);
await alertsRuntime.start();
assert.equal(alertsRuntime.snapshot().enabled, true);
assert.equal(alertsRuntime.snapshot().ruleCount, 1);
assert.equal(alertsRuntime.snapshot().loaded, true, '装上规则后 loaded 必须为 true（启动横幅靠它判断）');
assert.equal(alertsRuntime.snapshot().autoReload, false, '关掉监听时不应报告自动重载');

// 改文件后重新加载：规则数随之变化
writeAlerts([
  { id: 'a', metric: 'tempC', op: '>=', threshold: 80, for: '1m' },
  { id: 'b', metric: 'memUsedPct', op: '>=', threshold: 90, for: '2m' },
  { id: 'c', metric: 'throttled', op: '==', value: true, for: '1m' },
]);
const reloaded = await alertsRuntime.reload();
assert.equal(reloaded.reloaded, true);
assert.equal(reloaded.ruleCount, 3);
assert.equal(reloaded.previousRuleCount, 1);
assert.ok(alertsRuntime.snapshot().reloadedAt, '应记录最近一次重新加载的时间');

// 配置写坏：必须沿用上一次可用的规则，而不是静默变成"没有告警"
fs.writeFileSync(alertsFile, '{ 这不是合法 JSON');
const brokenReload = await alertsRuntime.reload();
assert.equal(brokenReload.reloaded, false);
assert.equal(alertsRuntime.snapshot().ruleCount, 3, '配置写坏时应沿用上一次的规则');
assert.ok(alertsRuntime.snapshot().lastReloadError, '应把失败原因记下来');

// 改回合法配置：恢复正常
writeAlerts([{ id: 'x', metric: 'tempC', op: '>=', threshold: 80, for: '1m' }]);
assert.equal((await alertsRuntime.reload()).reloaded, true);
assert.equal(alertsRuntime.snapshot().ruleCount, 1);
assert.equal(alertsRuntime.snapshot().lastReloadError, null);

// 文件被删掉：同样保留上一次的规则
fs.unlinkSync(alertsFile);
assert.equal((await alertsRuntime.reload()).reloaded, false);
assert.equal(alertsRuntime.snapshot().ruleCount, 1, '配置文件不存在时也应沿用上一次的规则');
alertsRuntime.close();

// --no-alerts 时要给出明确原因
const noAlertsRuntime = createAlertsRuntime({
  ...runtimeBase,
  options: { ...runtimeBase.options, alerts: false },
});
await noAlertsRuntime.start();
assert.equal(noAlertsRuntime.snapshot().enabled, false);
assert.ok(noAlertsRuntime.snapshot().reason.includes('--no-alerts'));
noAlertsRuntime.close();

/* ---------- 通知渠道：dry-run 不真的发信 ---------- */
const dryRunLogs = [];
const dryNotifier = createNotifier({
  config: { email: { host: 'smtp.example.com', from: 'a@b.c', to: ['d@e.f'] }, webhook: { url: 'http://127.0.0.1:1/hook' } },
  dryRun: true,
  logger: { info: (line) => dryRunLogs.push(line), warn: (line) => dryRunLogs.push(line), error: (line) => dryRunLogs.push(line) },
});
assert.deepEqual(dryNotifier.channels, ['email', 'webhook', 'console']);
await dryNotifier.send({ kind: 'firing', level: 'warning', ruleId: 'x', title: '测试', detail: '细节', at: Date.now() });
assert.equal(dryRunLogs.filter((line) => line.includes('dry-run')).length, 2, '两个远程渠道都应走 dry-run');

/* ---------- SMTP 客户端：用假 socket 验证协议流程 ---------- */
assert.equal(encodeHeader('ASCII subject'), 'ASCII subject');
assert.equal(encodeHeader('中文主题').startsWith('=?UTF-8?B?'), true, '非 ASCII 头要按 RFC 2047 编码');
const builtMessage = buildMessage({ from: 'a@b.c', to: ['d@e.f'], subject: '测试', text: '第一行\n第二行' });
assert.ok(builtMessage.includes('Content-Transfer-Encoding: base64'));
assert.equal(
  Buffer.from(builtMessage.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'),
  '第一行\n第二行',
  '正文用 base64 编码，解出来要和原文一致',
);

const smtpSession = createFakeSmtpSession();
const sent = await sendMail({
  host: 'smtp.example.com',
  port: 587,
  user: 'monitor@example.com',
  pass: 'pw',
  from: 'monitor@example.com',
  to: ['ops@example.com', 'oncall@example.com'],
  subject: '显存告警',
  text: 'GPU 0 显存占用 95%',
  connect: smtpSession.connect,
});
assert.equal(sent.ok, true);
assert.deepEqual(sent.recipients, ['ops@example.com', 'oncall@example.com']);
const commands = smtpSession.writes.map((line) => line.split('\r\n')[0]);
assert.equal(commands[0], `EHLO ${os.hostname()}`, '先打招呼');
assert.equal(commands[1], 'AUTH LOGIN');
assert.equal(Buffer.from(commands[2], 'base64').toString('utf8'), 'monitor@example.com');
assert.equal(Buffer.from(commands[3], 'base64').toString('utf8'), 'pw');
assert.equal(commands[4], 'MAIL FROM:<monitor@example.com>');
assert.equal(commands[5], 'RCPT TO:<ops@example.com>');
assert.equal(commands[6], 'RCPT TO:<oncall@example.com>');
assert.equal(commands[7], 'DATA');
assert.ok(smtpSession.writes[8].endsWith('\r\n.\r\n'), '正文要以单独的 . 行结束');
assert.ok(smtpSession.writes[8].includes('Subject: =?UTF-8?B?'), '中文主题要编码');
assert.equal(commands[9], 'QUIT');

// 服务器拒绝时要把错误抛出来，而不是静默成功
const rejectingSession = createFakeSmtpSession({ failAt: 'MAIL FROM', code: '550 5.7.1 Rejected' });
await assert.rejects(
  () => sendMail({
    host: 'smtp.example.com', from: 'a@b.c', to: ['d@e.f'], subject: 's', text: 't',
    connect: rejectingSession.connect,
  }),
  /MAIL FROM 失败/,
);

process.stdout.write(
  '冒烟测试通过：GPU 解析（基础/扩展/逗号名/CRLF）/ 字段探测与降级 / 宿主指标（Linux + Windows）/ '
  + '空闲调度 / 环形缓冲 / CSV 导出 / 模拟数据源 / 平台探测 / 采集器端到端 / '
  + '历史库（写入·分桶·保留·进程事件）/ 行映射与流式导出行 / 推送订阅 / '
  + '告警（规则规范化·持续判定·抑制·恢复·采集中断）/ SMTP 协议与通知分发 / '
  + '历史库维护（增量回收·整库重写）/ 部署前自检 / 健康检查 / systemd 模板校验 / '
  + '告警长周期查历史库·覆盖不足标注·抗抖动·短 for 自适应\n',
);
