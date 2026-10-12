#!/usr/bin/env node
// 冒烟测试：不依赖网络与真实 GPU，验证 nvidia-smi 解析、字段探测、宿主指标、
// 空闲调度、环形缓冲与 CSV 导出。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readGpuSnapshot, resolveGpuFields, parseGpuCsv, splitRow, defaultGpuFields } from '../src/nvidia.js';
import { History } from '../src/history.js';
import { samplesToCsv, samplesToSystemCsv } from '../src/export.js';
import { createMockSource, createMockSystem } from '../src/mock.js';
import { detectPlatform, nvidiaSmiCandidates, resolveNvidiaSmi } from '../src/platform.js';
import { createSystemCollector, parseMeminfo, parseNetDev, cpuUsagePct } from '../src/system.js';
import { createCollector, resolveCadence } from '../src/collector.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SMI = path.join(HERE, 'fake-nvidia-smi.mjs');
const FAKE_SMI_CRLF = path.join(HERE, 'fake-nvidia-smi-crlf.mjs');

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

process.stdout.write(
  '冒烟测试通过：GPU 解析（基础/扩展/逗号名/CRLF）/ 字段探测与降级 / 宿主指标（Linux + Windows）/ '
  + '空闲调度 / 环形缓冲 / CSV 导出 / 模拟数据源 / 平台探测 / 采集器端到端\n',
);
