#!/usr/bin/env node
// 冒烟测试：不依赖网络与真实 GPU，验证 nvidia-smi 解析、字段探测、宿主指标、
// 空闲调度、环形缓冲与 CSV 导出。
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readGpuSnapshot, resolveGpuFields, parseGpuCsv, splitRow, defaultGpuFields } from '../src/nvidia.js';
import { History } from '../src/history.js';
import {
  GPU_CSV_HEADER,
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
import { createMemoryStore } from '../src/store/store.js';
import { gpuFromRow, packThrottle, processesSignature, systemFromRow, unpackThrottle } from '../src/store/rows.js';
import { compare, normalizeRules, parseDuration } from '../src/alerts/rules.js';
import { createAlertEngine } from '../src/alerts/engine.js';
import { expandEnv, loadAlertsConfig } from '../src/alerts/config.js';
import { buildMessage, encodeHeader, sendMail } from '../src/notify/smtp.js';
import { createNotifier } from '../src/notify/notifier.js';

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
const procAt = (pid) => [{ gpuUuid: 'GPU-test', gpuIndex: 0, pid, name: 'train.py', usedMemMiB: 90 }];
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
process.env.GM_TEST_SMTP_PASS = 'secret';
assert.equal(expandEnv('${GM_TEST_SMTP_PASS}'), 'secret');
assert.deepEqual(expandEnv({ a: ['${GM_TEST_SMTP_PASS}', 1] }), { a: ['secret', 1] });
delete process.env.GM_TEST_SMTP_PASS;
assert.equal((await loadAlertsConfig('/nonexistent/alerts.json')).missing, true, '没有配置文件不算错误');
assert.ok((await loadAlertsConfig(FAKE_SMI)).error, 'JSON 解析失败要给出原因');

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
  + '告警（规则规范化·持续判定·抑制·恢复·采集中断）/ SMTP 协议与通知分发\n',
);
