#!/usr/bin/env node
// 冒烟测试：不依赖网络与真实 GPU，验证 nvidia-smi 解析、字段探测、宿主指标、
// 空闲调度、环形缓冲与 CSV 导出。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  normalizeBusId,
  readGpuSnapshot, readRowRemapper, resolveGpuFields, parseGpuCsv, parseRowRemapper, splitRow, defaultGpuFields,
} from '../src/nvidia.js';
import { createXidTracker, parseXidLines, readKernelLog } from '../src/xid.js';
import { resampleToGrid } from '../public/resample.js';
import { utilKpiView, UTIL_WINDOW_MS } from '../public/kpi-util.js';
import { throttleParts, healthParts, gpuFootItems } from '../public/gpu-card-parts.js';
import { hoverIndexFromX, hoverRows } from '../public/chart-hover.js';
import { statusView } from '../public/status-pill.js';
import { History } from '../src/history.js';
import {
  GPU_CSV_HEADER,
  GPU_CSV_HEADER_FULL,
  PROCESS_CSV_HEADER,
  SYSTEM_CSV_HEADER,
  applyTimeZone,
  assertTimeZone,
  formatTimestamp,
  gpuRowToCsv,
  processRowToCsv,
  samplesToCsv,
  samplesToSystemCsv,
  samplesToWideCsv,
  serverTimeZone,
  shouldWarnUtcTimeZone,
  systemRowToCsv,
  gpuIndexesOf,
  wideGpuCsvHeader,
} from '../src/export.js';
import { createMockSource, createMockSystem } from '../src/mock.js';
import { detectPlatform, nvidiaSmiCandidates, resolveHostname, resolveNvidiaSmi } from '../src/platform.js';
import { createSystemCollector, parseDiskSpec, parseMeminfo, parseNetDev, cpuUsagePct } from '../src/system.js';
import { createCollector, resolveCadence } from '../src/collector.js';
import { createSqliteStore } from '../src/store/sqlite-store.js';
import { createMemoryStore, createStore, describeStorageError } from '../src/store/store.js';
import {
  gpuFromRow, packThrottle, processFromRow, processesSignature, systemFromRow, unpackThrottle,
} from '../src/store/rows.js';
import { compare, normalizeRules, parseDuration } from '../src/alerts/rules.js';
import { readServiceMetric } from '../src/alerts/rules.js';
import { serviceSharePct, summarizeServices } from '../src/services.js';
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
import { sendTestNotice } from './notify-test.mjs';
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
// 导出里的时间用两个固定时刻的常量，后面几处断言都复用
const CSV_T0 = Date.UTC(2026, 0, 1);          // 2026-01-01T00:00:00Z
const CSV_T0_STR = formatTimestamp(CSV_T0);

/* 时间列：Excel 打开不能比墙上时钟早 8 小时，同时不能丢掉时区信息 */
// 用明确的时区把断言钉死，这样在任何机器上跑结果都一样
const TS_DEMO = Date.UTC(2026, 9, 14, 6, 25, 3);
assert.equal(
  formatTimestamp(TS_DEMO, { timeZone: 'Asia/Shanghai' }).local,
  '2026-10-14 14:25:03',
  '东八区必须是 14:25，不能直接吐 UTC 的 06:25',
);
assert.equal(
  formatTimestamp(TS_DEMO, { timeZone: 'Asia/Shanghai' }).iso,
  '2026-10-14T06:25:03.000Z',
  'UTC 那一列要保持原样：机器读、跨时区对齐都靠它',
);
assert.equal(formatTimestamp(TS_DEMO, { timeZone: 'UTC' }).local, '2026-10-14 06:25:03');
assert.equal(
  Date.parse(`${formatTimestamp(TS_DEMO, { timeZone: 'Asia/Shanghai' }).local.replace(' ', 'T')}+08:00`),
  TS_DEMO,
  '本地时间加回偏移量必须还原成同一个瞬间，说明时区是真的套用上了',
);

// 午夜边界：部分 ICU 版本会把 0 点写成 24:00:00，Excel 认不出来
assert.equal(
  formatTimestamp(Date.UTC(2026, 9, 14, 16, 0, 0), { timeZone: 'Asia/Shanghai' }).local,
  '2026-10-15 00:00:00',
  '午夜必须是 00:00:00 而不是 24:00:00',
);
assert.equal(formatTimestamp(TS_DEMO).local.length, 19, '固定 YYYY-MM-DD HH:MM:SS，不带毫秒');

// 不传时区就走服务器时区；再和 Date 自己的本地取值对一遍（两套独立实现互相校验）
assert.equal(formatTimestamp(TS_DEMO).local, formatTimestamp(TS_DEMO, { timeZone: serverTimeZone() }).local);
const tsDate = new Date(TS_DEMO);
const pad2 = (n) => String(n).padStart(2, '0');
assert.equal(
  formatTimestamp(TS_DEMO).local,
  `${tsDate.getFullYear()}-${pad2(tsDate.getMonth() + 1)}-${pad2(tsDate.getDate())} `
    + `${pad2(tsDate.getHours())}:${pad2(tsDate.getMinutes())}:${pad2(tsDate.getSeconds())}`,
  'Intl 的输出要和 Date 的本地时间取值一致',
);

/* 时区名校验：填错要在启动阶段就报人话，别等导出到一半才发现 */
assert.equal(assertTimeZone('Asia/Shanghai'), 'Asia/Shanghai');
assert.equal(assertTimeZone('UTC'), 'UTC');
assert.equal(assertTimeZone(' asia/shanghai '), 'Asia/Shanghai', '多余空格与大小写要能容忍');
assert.throws(() => assertTimeZone('Asia/Shangai'), /IANA/, '拼错的时区要给出可照着改的提示');
assert.throws(() => assertTimeZone('+08:00'), /IANA/, '偏移量写法不算时区名');
assert.throws(() => assertTimeZone(''), /不能为空/);

// UTC 提醒只在"没人显式选过时区"时出现：系统默认是 UTC 时要提醒（云主机常态），
// 用户自己选了 UTC 就别去打扰
assert.equal(shouldWarnUtcTimeZone({ zone: 'UTC', fixed: false }), true);
assert.equal(shouldWarnUtcTimeZone({ zone: 'utc', fixed: false }), true, '大小写不敏感');
assert.equal(shouldWarnUtcTimeZone({ zone: 'UTC', fixed: true }), false, '主动选了 UTC 就不再唠叨');
assert.equal(shouldWarnUtcTimeZone({ zone: 'Asia/Shanghai', fixed: false }), false);
assert.equal(shouldWarnUtcTimeZone({}), false);

/* 真实回归：系统时区是 UTC 时，--tz 必须把导出掰回本地时间 */
// 这台服务器 /etc/localtime 指向 Etc/UTC，所以 time_local 一度和 UTC 列一模一样，
// 看着像"改了没生效"。用子进程把 TZ 钉成 UTC 复现那个环境，再验 --tz 的效果——
// 放子进程里是因为要改 process.env.TZ，不能在测试进程里留下痕迹。
const tzProbe = execFileSync(process.execPath, ['--input-type=module', '-e', `
  import { applyTimeZone, formatTimestamp, serverTimeZone } from ${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'src', 'export.js')).href)};
  const ms = Date.UTC(2026, 9, 14, 6, 25, 3);
  const out = [
    serverTimeZone(),
    formatTimestamp(ms).local,
    applyTimeZone('Asia/Shanghai'),
    serverTimeZone(),
    formatTimestamp(ms).local,
    formatTimestamp(ms).iso,
  ];
  console.log(out.join('|'));
`], { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' }).trim();
assert.equal(
  tzProbe,
  [
    'UTC',                      // 复现出的环境：系统时区是 UTC
    '2026-10-14 06:25:03',      // 不固定时 time_local 就是 UTC，和 UTC 列一样
    'Asia/Shanghai',            // --tz 生效
    'Asia/Shanghai',            // 进程时区真的被切过去了
    '2026-10-14 14:25:03',      // 导出变成本地时间
    '2026-10-14T06:25:03.000Z', // UTC 列原样不动
  ].join('|'),
  `--tz 没能把 UTC 环境掰成本地时间：${tzProbe}`,
);

const csv = samplesToCsv([
  { t: Date.UTC(2026, 8, 30, 1, 2, 3), gpus: [{ index: 0, name: 'A, B', memUsedMiB: 1, memTotalMiB: 2, memUsedPct: 50, utilGpuPct: 10, utilMemPct: 20, tempC: 30, powerW: 40 }] },
]);
const lines = csv.trim().split('\n');
assert.equal(lines.length, 2);
assert.ok(lines[0].startsWith('time_local,timestamp_iso,gpu_index'), 'CSV 表头应固定');
assert.ok(lines[1].includes('"A, B"'), '含逗号的名称应被引号包裹');
assert.ok(
  lines[1].startsWith(`${formatTimestamp(Date.UTC(2026, 8, 30, 1, 2, 3)).local},2026-09-30T01:02:03.000Z,`),
  `数据行前两列应是本地时间 + UTC：${lines[1]}`,
);

/* ---------- 导出：宽表布局（一行一个采样点，每张卡各占一组列） ---------- */
const wideSamples = [
  {
    t: Date.UTC(2026, 8, 30, 1, 2, 3),
    gpus: [
      { index: 0, memUsedMiB: 100, memUsedPct: 10, utilGpuPct: 20, utilMemPct: 30, tempC: 40, powerW: 50 },
      { index: 1, memUsedMiB: 200, memUsedPct: 20, utilGpuPct: 21, utilMemPct: 31, tempC: 41, powerW: 51 },
    ],
  },
  {
    t: Date.UTC(2026, 8, 30, 1, 2, 4),
    // 这一拍只有 0 号卡在（卡被拔掉 / 那一刻读不到都是这种形状）
    gpus: [{ index: 0, memUsedMiB: 101, memUsedPct: 11, utilGpuPct: 22, utilMemPct: 32, tempC: 42, powerW: 52 }],
  },
];
const perGpuColumns = 6;
assert.equal(
  wideGpuCsvHeader([0, 1]).split(',').length,
  2 + 2 * perGpuColumns,
  '宽表是一行一个采样点：两张卡就该有两组列',
);
assert.ok(
  wideGpuCsvHeader([0, 1]).startsWith('time_local,timestamp_iso,gpu0_mem_used_mib,gpu0_mem_used_pct,gpu0_util_gpu_pct'),
  '列名沿用长表的字段名，只加 gpu<序号>_ 前缀',
);
assert.ok(wideGpuCsvHeader([0, 1]).includes('gpu1_power_w'), '第二张卡也要有自己的列');

const wideCsv = samplesToWideCsv(wideSamples);
const wideLines = wideCsv.trim().split('\n');
assert.equal(wideLines.length, 3, '表头 + 两拍数据 = 三行（长表在这里会是四行）');
assert.equal(wideLines[1].split(',').length, 2 + 2 * perGpuColumns, '每个数据行的列数要和表头一致');
assert.equal(wideLines[1].split(',')[2], '100', '第一拍 0 号卡的显存占用');
assert.equal(wideLines[1].split(',')[8], '200', '第一拍 1 号卡的显存占用（紧跟在 0 号卡那组后面）');
assert.deepEqual(
  wideLines[2].split(',').slice(8),
  Array(perGpuColumns).fill(''),
  '这一拍没有 1 号卡的数据，该组留空而不是补 0',
);
assert.deepEqual(gpuIndexesOf(wideSamples), [0, 1], '卡号从采样点里自动收集并升序排列');
assert.equal(samplesToWideCsv([]).trim().split('\n').length, 1, '没有数据时只输出表头');

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
assert.equal(systemLines[0].startsWith('time_local,timestamp_iso,cpu_usage_pct'), true);
assert.equal(systemLines.length, 2, '没有宿主指标的采样点不应产生空行');
assert.ok(systemLines[1].includes(',0,2048'), '速率为 0 也要如实导出');

// 表头列数必须等于行里实际产出的列数。
// 加 time_local 时就漏过一次：数据行多了一列而表头没跟上，
// Excel 里所有列整体右移一格，光看数据根本发现不了。
const headerCols = (header) => header.split(',').length;
for (const [label, header, row] of [
  ['GPU 曲线', GPU_CSV_HEADER, gpuRowToCsv(CSV_T0, { index: 0, name: 'X' })],
  ['GPU 曲线（含扩展）', GPU_CSV_HEADER_FULL, gpuRowToCsv(CSV_T0, { index: 0, name: 'X' }, { full: true })],
  ['宿主指标', SYSTEM_CSV_HEADER, systemRowToCsv(CSV_T0, {})],
  ['进程历史', PROCESS_CSV_HEADER, processRowToCsv(CSV_T0, { pid: 1, name: 'x' })],
]) {
  assert.equal(row.split(',').length, headerCols(header), `${label}导出的列数与表头对不上`);
  assert.ok(
    header.startsWith('time_local,timestamp_iso,'),
    `${label}导出的表头前两列必须是 time_local + timestamp_iso，时间才对得上墙上时钟`,
  );
}

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

// 主机名：--mock 下必须换成假名字，否则用模拟数据截个图放进文档，就把本机名带出去了
assert.equal(resolveHostname({ mock: true }), 'demo-host', '--mock 下不该暴露本机主机名');
assert.equal(resolveHostname({ mock: false }), os.hostname(), '真机照常显示本机名');
process.env.GPU_MONITOR_HOSTNAME = 'demo-gpu-01';
assert.equal(resolveHostname({ mock: true }), 'demo-gpu-01', '显式指定要优先');
assert.equal(resolveHostname({ mock: false }), 'demo-gpu-01', '真机上也可以显式指定');
delete process.env.GPU_MONITOR_HOSTNAME;

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

/* ---------- 宿主磁盘：--disk 支持"路径=显示名" ---------- */
// 容器里宿主的根分区只能挂到某个路径下（比如 /hostfs），直接拿它当标签，
// 页面上就会出现「磁盘 /hostfs」——数字是对的，但看着像另一块盘。
assert.deepEqual(parseDiskSpec('/'), { path: '/', label: '/' }, '不写显示名时标签就是路径本身');
assert.deepEqual(parseDiskSpec('/hostfs=/'), { path: '/hostfs', label: '/' }, '容器场景：显示成宿主真实的 /');
assert.deepEqual(parseDiskSpec('  /data = 数据盘  '), { path: '/data', label: '数据盘' }, '两边的空白要去掉');
assert.equal(parseDiskSpec('/hostfs=').label, '/hostfs', '显示名留空就退回路径，不显示空标签');
assert.equal(parseDiskSpec(''), null);
assert.equal(parseDiskSpec('   '), null);

// 真走一遍采集：显示名要跟着出来，path 仍然是拿去做 statfs 的那个
const labeledSystem = createSystemCollector({
  platform: 'linux',
  diskTargets: ['/=宿主根分区'],
  readFile: async (file) => (String(file).includes('meminfo') ? proc.meminfo : proc.netdev),
});
const labeled = await labeledSystem.sample();
assert.equal(labeled.disk.length, 1);
assert.equal(labeled.disk[0].path, '/', 'path 是真正 statfs 的路径');
assert.equal(labeled.disk[0].label, '宿主根分区', '页面上显示的是显示名');
assert.ok(labeled.disk[0].totalMiB > 0, '根分区应该有容量');

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
assert.ok(Array.isArray(state.services) && state.services.length >= 1, '状态里应带服务维度汇总');
assert.ok(state.services[0].memMiB > 0, '服务汇总应包含占用显存');
assert.equal(typeof state.services[0].sharePct, 'number', '服务占比按整机显存算');
assert.ok(state.services.every((entry, index, list) => index === 0 || list[index - 1].memMiB >= entry.memMiB), '服务汇总按占用从大到小');
assert.equal(state.gpus[0].eccMode, 'Enabled', 'ECC 模式要能读到');
assert.equal(state.gpus[0].eccCorrectedAggregate, 12, '终身累计的可纠正错误数要能读到');
assert.equal(state.gpus[0].eccUncorrectedAggregate, 0);
assert.equal(state.gpus[1].eccMode, null, '驱动不提供 ECC 字段时应留空，而不是当成 0');
assert.equal(state.gpus[1].eccCorrectedAggregate, null);
assert.equal(state.gpus[2].eccCorrectedVolatile, 3, '本次驱动加载以来的计数要单独保留');

// 行重映射：不在 --query-gpu 里，只能解析 -q 的结构化文本，所以按总线号对回卡上
const remapRead = await readRowRemapper({ bin: FAKE_SMI });
assert.equal(remapRead.unsupported, false);
assert.equal(remapRead.byIndex.size, 3, '三张卡都要有重映射状态');
assert.equal(remapRead.byIndex.get(0).banksMax, 640, '备用行直方图里的 Max 要解析出来');
assert.equal(remapRead.byIndex.get(0).pending, false, 'No 要变成 false 而不是 null');
assert.equal(remapRead.byIndex.get(0).failure, false);
assert.equal(remapRead.byIndex.get(1).pending, true, 'Yes 要变成 true');
assert.equal(remapRead.byIndex.get(2).failure, true, '重映射失败是最重的信号');
assert.equal(remapRead.byIndex.get(2).correctable, 7);
assert.equal(remapRead.byIndex.get(2).uncorrectable, 3);

// 解析器要能区分 'Correctable Error' 与 'Inactive Correctable Error'——两者只差一个词，
// 误判会把"已经不用的行"当成活跃错误。N/A 要留 null，不能当成 false（那是"明确没有"）
const trickyRemap = parseRowRemapper([
  'GPU 00000000:01:00.0',
  '    Remapped Rows',
  '        Correctable Error                              : 5',
  '        Inactive Correctable Error                     : 99',
  '        Uncorrectable Error                            : 1',
  '        Pending                                        : N/A',
].join('\n'));
assert.equal(trickyRemap.get('00000000:01:00.0').correctable, 5, '不能把 Inactive 那行算进 Correctable');
assert.equal(trickyRemap.get('00000000:01:00.0').uncorrectable, 1);
assert.equal(trickyRemap.get('00000000:01:00.0').pending, null, 'N/A 要留 null，不能当成 false');
assert.equal(parseRowRemapper('一段没有 GPU 段的文本').size, 0, '没有 GPU 段时应返回空');

// 采集器把后台读到的重映射状态贴到卡上：它是异步的，所以给它一点时间
const remapDeadline = Date.now() + 3000;
let remapGpu = null;
while (Date.now() < remapDeadline && !remapGpu) {
  remapGpu = collector.getState().gpus.find((gpu) => gpu.remap);
  if (!remapGpu) await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.ok(remapGpu, '行重映射状态应被后台读进来并贴到卡上');
assert.equal(remapGpu.remap.banksMax, 640);
assert.equal(remapGpu.remap.failure, false);

// XID 的读取同样是后台异步的。这里不假设测试机读不读得到内核日志，
// 只断言那条安全性质：读不到时绝不能显示"0 次"——那会被读成"这块卡很干净"
const xidDeadline = Date.now() + 3000;
let xidState = collector.getState();
while (Date.now() < xidDeadline && !xidState.xidStatus.updatedAt) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  xidState = collector.getState();
}
assert.ok(xidState.xidStatus.updatedAt, 'XID 读取应该跑过至少一次');
assert.ok(
  xidState.xidStatus.available || xidState.xidStatus.error,
  '读不到内核日志时必须给出原因，不能静默',
);
if (!xidState.xidStatus.available) {
  assert.equal(
    xidState.gpus.some((gpu) => gpu.xid),
    false,
    '读不到内核日志时不能显示"XID 0 次"，那是假的"一切正常"',
  );
}

/* ---------- 前端：把历史数据重采样成等间隔网格（实时窗口回填用） ---------- */
// 库里的点是 6 秒一个、实时窗口要 3 秒一格：不重采样的话横轴会错位
const gridSource = [
  { t: 1000, gpus: [{ uuid: 'g0', memUsedMiB: 10 }] },
  { t: 7000, gpus: [{ uuid: 'g0', memUsedMiB: 20 }] },
  { t: 13000, gpus: [{ uuid: 'g0', memUsedMiB: 30 }] },
];
const resampled = resampleToGrid(gridSource, { from: 1000, to: 13000, intervalMs: 3000 });
assert.deepEqual(resampled.map((sample) => sample.t), [1000, 4000, 7000, 10000, 13000], '网格必须等间隔，右端不越界');
assert.deepEqual(resampled.map((sample) => sample.gpus[0].memUsedMiB), [10, 10, 20, 20, 30], '每格取"该时刻之前最近"的点');

// 断档（服务重启那几十秒）：只向前填充 3 个间隔，再往后就留空，
// 让曲线如实断开而不是拉一条横贯断口、假装一直有数据的假直线
const gappedGrid = resampleToGrid([{ t: 1000, gpus: [] }, { t: 31000, gpus: [] }], { from: 1000, to: 31000, intervalMs: 3000 });
assert.deepEqual(
  gappedGrid.map((sample) => sample.t),
  [1000, 4000, 7000, 10000, 31000],
  '1000 之后最多向前填 3 格（到 10000），再往后留空直到下一个真实点',
);

// 网格右端不超过最后一个真实点：绝不凭空造数据
const shortGrid = resampleToGrid([{ t: 1000, gpus: [] }, { t: 4000, gpus: [] }], { from: 1000, to: 20000, intervalMs: 3000 });
assert.deepEqual(shortGrid.map((sample) => sample.t), [1000, 4000], '没有数据的那段不补，交给后续的实时帧');

// 边界情况：空输入、非法间隔、乱序输入、网格起点早于第一个真实点
assert.deepEqual(resampleToGrid([], { from: 0, to: 1000, intervalMs: 100 }), []);
assert.deepEqual(resampleToGrid(gridSource, { from: 0, to: 1000, intervalMs: 0 }), [], '间隔非法时返回空而不是死循环');
assert.deepEqual(
  resampleToGrid([...gridSource].reverse(), { from: 1000, to: 3000, intervalMs: 1000 }).map((sample) => sample.t),
  [1000, 2000, 3000],
  '输入乱序也要能处理（库里查回来的顺序不保证）',
);
assert.deepEqual(
  resampleToGrid([{ t: 5000, gpus: [] }], { from: 1000, to: 6000, intervalMs: 1000 }).map((sample) => sample.t),
  [5000],
  '第一个真实点之前没有数据（那些格子留空），之后又没有数据（右端不超过最后一个点）',
);

/* ---------- 前端：平均利用率卡片的跨时间口径 ---------- */
const kpiNow = 1_700_000_000_000;

// 主口径：跨时间（服务端把近 1 小时的采样点整体平均过），且已攒满一小时
const utilFull = utilKpiView({
  avgUtilNow: 12,
  crossTime: { avg: 63.4, samples: 5760, cards: 8, oldestTs: kpiNow - UTIL_WINDOW_MS, newestTs: kpiNow, windowMs: UTIL_WINDOW_MS },
  cardCount: 8,
  now: kpiNow,
});
assert.equal(utilFull.value, 63.4, '有跨时间均值时要用它，而不是这一帧的 12');
assert.equal(utilFull.foot, '近 1 小时 · 8 张卡');
assert.equal(utilFull.footShort, '近 1 小时', '紧凑顶栏里只要几个字，卡数在别的 KPI 里已经有了');
assert.ok(utilFull.title.includes('5760'), '悬停说明里要交代样本量，方便核对口径');

// 服务刚部署：库里只有 20 分钟，数字照给，但脚注必须说清覆盖面
const utilPartial = utilKpiView({
  avgUtilNow: 12,
  crossTime: { avg: 40, samples: 240, cards: 8, oldestTs: kpiNow - 20 * 60000, newestTs: kpiNow, windowMs: UTIL_WINDOW_MS },
  cardCount: 8,
  now: kpiNow,
});
assert.equal(utilPartial.foot, '近 1 小时未满 · 实为最近 20 分钟', '覆盖不足要如实说，不能假装是一小时');
assert.equal(utilPartial.footShort, '实为最近 20 分钟', '紧凑模式可以省略前半句，"其实只覆盖了 20 分钟"这句不能省');
assert.equal(utilPartial.value, 40);

// 差一个采样间隙就算满：5 秒落库，少 1 分钟不该被当成"没覆盖满"
const utilNearlyFull = utilKpiView({
  crossTime: { avg: 40, samples: 700, cards: 8, oldestTs: kpiNow - UTIL_WINDOW_MS + 60000, newestTs: kpiNow, windowMs: UTIL_WINDOW_MS },
  now: kpiNow,
});
assert.equal(utilNearlyFull.foot, '近 1 小时 · 8 张卡', '差一个采样间隙仍算覆盖满，避免刚过一小时就报"未满"');

// 库里还没有采样点（服务刚起来）
const utilNoSamples = utilKpiView({
  crossTime: { avg: null, samples: 0, cards: 0, oldestTs: null, newestTs: null, windowMs: UTIL_WINDOW_MS },
  avgUtilNow: 15,
  cardCount: 8,
  now: kpiNow,
});
assert.equal(utilNoSamples.value, 15, '历史库还空着时先给这一帧的数，别让卡片空着');
assert.equal(utilNoSamples.foot, '近 1 小时暂无历史');
assert.equal(utilNoSamples.footShort, '暂无历史');

// 降级：整个服务都没有历史库（Node 太旧 / --no-db）
const utilNoHistory = utilKpiView({ avgUtilNow: 42, crossTime: null, cardCount: 8, now: kpiNow });
assert.equal(utilNoHistory.value, 42);
assert.equal(utilNoHistory.foot, '按 8 张卡平均（无历史库）', '降级口径必须显式标注，否则会被误读成跨时间均值');
assert.equal(utilNoHistory.footShort, '无历史库', '紧凑模式也得让人看出这是降级口径');

// 一点数据都没有
assert.equal(utilKpiView({ now: kpiNow }).value, null);
assert.equal(utilKpiView({ now: kpiNow }).foot, '等待采集');
assert.equal(utilKpiView({ now: kpiNow }).footShort, '等待采集');
assert.equal(utilKpiView({ avgUtilNow: 0, cardCount: 1, now: kpiNow }).value, 0, '0% 是有效值，不能当成"没数据"');

/* ---------- 各卡当前占用：节流状态与硬件健康 ---------- */
// 这两行决定单张卡的高度，单张卡的高度又决定 8 张卡要不要滚两三屏，
// 所以判定抽成了纯函数，在这里钉住"什么该单开一行、什么可以并进健康行"。

// 节流：字段没读到 ≠ 没在降频
assert.deepEqual(throttleParts({}), { known: false, reasons: [] }, '驱动没给这组字段时是"状态未知"，不能当成"没节流"');
assert.deepEqual(throttleParts({ throttle: {} }), { known: true, reasons: [] }, '全是 false 才是真的没在降频');
assert.deepEqual(
  throttleParts({ throttle: { swPowerCap: true, hwThermal: false } }).reasons,
  [{ text: '功耗墙', tone: 'warning' }],
);
assert.deepEqual(
  throttleParts({ throttle: { hwSlowdown: true } }).reasons,
  [{ text: '硬件降速', tone: 'danger' }],
);
assert.deepEqual(
  throttleParts({ throttle: { someFutureKey: true } }).reasons,
  [{ text: 'someFutureKey', tone: 'warning' }],
  '认不出来的原因也要显示出来，不能悄悄吞掉',
);

// 硬件健康：一切正常时也要出字——"ECC 无错误"本身就是有用的信息
assert.deepEqual(
  healthParts({ eccMode: 'Enabled', eccCorrectedAggregate: 0, eccUncorrectedAggregate: 0 }),
  { visible: true, parts: ['ECC 无错误'], tone: '' },
);
assert.equal(healthParts({}).visible, false, '消费卡 / 老驱动两样都拿不到时整行隐藏，不显示一排 "--"');
assert.equal(healthParts({ eccMode: 'Disabled' }).parts[0], 'ECC 已关闭（Disabled）');
assert.equal(
  healthParts({ eccMode: 'Enabled', eccUncorrectedAggregate: 1, eccUncorrectedVolatile: 1 }).tone,
  'danger',
  '不可纠正错误意味着已经在丢数据，得用最重的配色',
);
assert.equal(
  healthParts({ eccMode: 'Enabled', eccCorrectedAggregate: 4800, eccCorrectedVolatile: 3 }).parts[0],
  'ECC 可纠正 4800（本次 3）',
  '终身累计与本次新增要分开写：看的是"有没有在涨"',
);
assert.equal(
  healthParts({ eccMode: 'Enabled', eccCorrectedAggregate: 4800, eccCorrectedVolatile: 0 }).parts[0],
  'ECC 可纠正 4800',
);

// 行重映射只在"有情况"时才补字
const remapFail = healthParts({
  eccMode: 'Enabled', eccCorrectedAggregate: 0, eccUncorrectedAggregate: 0,
  remap: { failure: true, banksMax: 640 },
});
assert.ok(remapFail.parts.includes('行重映射失败'));
assert.equal(remapFail.tone, 'danger', '重映射失败是换卡依据');
assert.deepEqual(
  healthParts({ remap: { banksMax: 640, correctable: 0, uncorrectable: 0, pending: false } }).parts,
  [],
  '重映射一切正常时不占字，免得这一行变成没人看的长句',
);
assert.equal(healthParts({ remap: { pending: true } }).tone, 'warning');

// XID：48 / 64 / 79 这几个编号要按"这张卡要处理了"对待，其余也报但不必同等紧张
const xidFatal = healthParts(
  { xid: { count: 2, lastCode: 79, lastAt: kpiNow, recent: true } },
  { relativeText: () => '10 分钟前' },
);
assert.equal(xidFatal.tone, 'danger');
assert.ok(xidFatal.parts[0].includes('XID 79'), 'XID 编号要写出来，别只说"有错误"');
assert.ok(xidFatal.parts[0].includes('10 分钟前'), '要说清最近一次是什么时候，方便对着时间线看');
assert.equal(healthParts({ xid: { count: 1, lastCode: 12345 } }).tone, 'warning');

/* ---------- 各卡当前占用：指标行的标签（导航模式用短标签） ---------- */
// 8 张卡平铺时这一行会折成两行，每张卡多一行、整页就多一屏，所以导航模式换短标签。
// 这里钉住两件事：单页模式一个字符都不变；短标签必须留得住信息（单位、比值、全称提示）。
const footGpu = {
  utilGpuPct: 89, utilMemPct: 18, tempC: 36, powerW: 239, powerLimitW: 700,
  clockSmMHz: 1980, pstate: 'P0', fanPct: null, encUtilPct: 0, decUtilPct: 0,
};
assert.deepEqual(
  gpuFootItems(footGpu).map((item) => item.text),
  ['GPU 利用率 89%', '显存带宽占用 18%', '温度 36°C', '功耗 239 W / 700 W', 'SM 时钟 1980 MHz', 'P-State P0', null, '编解码 0% / 0%'],
  '单页模式保持全称不变',
);
const denseFoot = gpuFootItems(footGpu, { dense: true });
assert.deepEqual(
  denseFoot.map((item) => item.text),
  ['利用率 89%', '带宽 18%', '温度 36°C', '功耗 239/700 W', '时钟 1980 MHz', 'P0', null, '编解码 0%/0%'],
);
assert.equal(denseFoot[0].title, 'GPU 利用率', '短标签要把全称放在 title 里，鼠标一停能看原文');
assert.equal(denseFoot[1].title, '显存带宽占用');
assert.equal(denseFoot[4].title, 'SM 时钟（MHz）', '省掉 "SM" 要在提示里补回来');
assert.equal(denseFoot[5].title, 'P-State');
assert.ok(denseFoot[1].text.length < gpuFootItems(footGpu)[1].text.length, '紧凑版确实更短');

// 没数据的项返回 text: null，调用方整项隐藏，而不是显示一排 "--"
const bareFoot = gpuFootItems({}, { dense: true });
assert.deepEqual(
  bareFoot.filter((item) => item.text === null).map((item) => item.key),
  ['clock', 'pstate', 'fan', 'encdec'],
);
assert.equal(bareFoot.find((item) => item.key === 'temp').text, '温度 --');
// 功耗上限读不到时只写当前值；风扇有数据时照常写出来
assert.equal(gpuFootItems({ powerW: 100 }).find((item) => item.key === 'power').text, '功耗 100 W');
assert.equal(gpuFootItems({ powerW: 100 }, { dense: true }).find((item) => item.key === 'power').text, '功耗 100 W');
assert.equal(gpuFootItems({ fanPct: 51 }, { dense: true }).find((item) => item.key === 'fan').text, '风扇 51%');

/* ---------- 曲线悬停：鼠标位置 → 采样点索引、浮窗内容 ---------- */
const hoverBase = { width: 558, padLeft: 6, padRight: 44 };   // 与 drawLines 里的 pad 保持一致
const plotRight = hoverBase.width - hoverBase.padRight;

// 满窗：最右边缘是最后一个点、左边缘是第一个点
assert.equal(hoverIndexFromX({ ...hoverBase, x: plotRight, count: 300, slots: 300 }), 299, '右边缘 = 最新那个点');
assert.equal(hoverIndexFromX({ ...hoverBase, x: hoverBase.padLeft, count: 300, slots: 300 }), 0, '左边缘 = 最旧那个点');
assert.equal(
  hoverIndexFromX({ ...hoverBase, x: hoverBase.padLeft + (plotRight - hoverBase.padLeft) / 2, count: 300, slots: 300 }),
  149,
  '正中间落在中间那个点（半个槽位四舍五入，归哪边都行）',
);

// 绘图区之外：右侧那段是百分比刻度文字占的，不该响应
assert.equal(hoverIndexFromX({ ...hoverBase, x: plotRight + 10, count: 300, slots: 300 }), null);
assert.equal(hoverIndexFromX({ ...hoverBase, x: 2, count: 300, slots: 300 }), null);
assert.equal(hoverIndexFromX({ ...hoverBase, x: NaN, count: 300, slots: 300 }), null);
assert.equal(hoverIndexFromX({ ...hoverBase, x: 100, count: 0, slots: 300 }), null, '一个点都没有时不该给索引');

// 窗口还没攒满：数据只占右边一段，左边那段是空白（悬停在那儿什么都别显示）
assert.equal(hoverIndexFromX({ ...hoverBase, x: 10, count: 30, slots: 300 }), null, '没攒满时左边那段没有数据');
assert.equal(
  hoverIndexFromX({ ...hoverBase, x: hoverBase.padLeft + (plotRight - hoverBase.padLeft) * (1 - 29 / 299), count: 30, slots: 300 }),
  0,
  '没攒满时最旧的那个点（贴着数据段的左端）',
);
assert.equal(hoverIndexFromX({ ...hoverBase, x: plotRight, count: 30, slots: 300 }), 29, '没攒满时右边缘仍是最新那个点');

// 浮窗内容：时间 + 每个系列一行；断档处写"无数据"而不是 0
const hoverView = hoverRows({
  seriesList: [
    { label: '显存占用', color: '#005bac', values: [10, 20, null], format: (value) => `${value.toFixed(1)}%` },
    { label: '利用率', color: '#00a0e3', values: [30, null, 50], format: (value) => `${value.toFixed(0)}%` },
  ],
  times: [1000, 2000, 3000],
  index: 1,
  timeLabel: (ts) => `T${ts}`,
});
assert.deepEqual(hoverView, {
  time: 'T2000',
  rows: [
    { label: '显存占用', color: '#005bac', value: '20.0%' },
    { label: '利用率', color: '#00a0e3', value: '无数据' },
  ],
});
assert.equal(hoverRows({ seriesList: [], times: [], index: null }), null, '没有悬停点就没有浮窗');
assert.equal(hoverRows({ seriesList: [{ values: [1] }], times: [1000], index: 5 }).time, '无数据', '索引越界时时间也如实说');
assert.equal(
  hoverRows({ seriesList: [{ name: '容器 vllm', values: [7] }], times: [1000], index: 0 }).rows[0].label,
  '容器 vllm',
  '系列没给 label 时退回 name（服务曲线就是这样）',
);
// 服务曲线：曲线画的是占整机显存的比例，浮窗要给 GB（同刻对齐的另一份值）
const serviceHover = hoverRows({
  seriesList: [{
    name: '容器 glm-vllm',
    values: [81.6, null],
    hoverValues: [915000, null],
    format: (value) => `${Math.round(value / 1024)} GB`,
  }],
  times: [1000, 2000],
  index: 0,
});
assert.equal(serviceHover.rows[0].value, '894 GB', '有 hoverValues 时用它，而不是曲线上的百分比');
assert.equal(
  hoverRows({
    seriesList: [{
      name: '容器 glm-vllm', values: [81.6, null], hoverValues: [915000, null], format: (v) => `${Math.round(v / 1024)} GB`,
    }],
    times: [1000, 2000],
    index: 1,
  }).rows[0].value,
  '无数据',
  '那一刻这个服务没数据时如实说',
);

/* ---------- 顶部状态胶囊：陈旧 / 降级 / 空闲降频 ---------- */
// 这里的判定最容易错在三处：把"故意放慢"当成"卡住"、把"服务端本来就没开推送"当成"掉线"、
// 以及几件事同时成立时的优先级。冒烟测试把它们钉住。
const PILL_NOW = 1_700_000_000_000;
const pillRel = (ts) => `${Math.round((PILL_NOW - ts) / 60000)} 分钟前`;

assert.deepEqual(
  statusView({ status: 'ok', lastSampleAt: PILL_NOW - 1000, now: PILL_NOW, relative: pillRel }),
  { tone: 'live', text: '实时采集中', stale: false, fellBack: false },
  '正常采集就是绿点"实时采集中"',
);
// 阈值 = max(3×采集间隔+2 秒, 落库间隔+5 秒, 15 秒)。下面三条把三个分支各钉一次。
assert.equal(
  statusView({ status: 'ok', lastSampleAt: PILL_NOW - 30000, now: PILL_NOW, relative: pillRel }).tone,
  'stale',
  '30 秒没有新样本（间隔 1 秒）应当判为数据陈旧',
);
// 这条对应实测发现的问题：A 台 1 秒采集 / 5 秒落库，刚开页时最新点最多就可能是 10 秒前的
assert.equal(
  statusView({
    status: 'ok', lastSampleAt: PILL_NOW - 10000, now: PILL_NOW,
    intervalMs: 1000, storeIntervalMs: 5000, relative: pillRel,
  }).tone,
  'live',
  '开页瞬间最新点来自回填（5 秒落库）时，10 秒的空档不算陈旧',
);
assert.equal(
  statusView({
    status: 'ok', lastSampleAt: PILL_NOW - 20000, now: PILL_NOW,
    intervalMs: 1000, storeIntervalMs: 5000, relative: pillRel,
  }).tone,
  'stale',
  '但超过 15 秒下限之后，照旧要报陈旧',
);
assert.equal(
  statusView({
    status: 'ok', lastSampleAt: PILL_NOW - 30000, now: PILL_NOW,
    intervalMs: 1000, storeIntervalMs: 30000, relative: pillRel,
  }).tone,
  'live',
  '落库间隔调到 30 秒时，下限跟着涨到 35 秒，不能再用 15 秒判',
);
const pillIdle = statusView({
  status: 'ok', lastSampleAt: PILL_NOW - 30000, now: PILL_NOW, intervalMs: 10000,
  idle: { active: true, currentIntervalMs: 10000 }, relative: pillRel,
});
assert.equal(pillIdle.tone, 'live', '空闲降频到 10 秒时，30 秒没样本是故意放慢，不能判成陈旧');
assert.equal(
  statusView({
    status: 'ok', lastSampleAt: PILL_NOW, now: PILL_NOW,
    idle: { active: true, currentIntervalMs: 10000 },
  }).text,
  '空闲降频中（每 10 秒）',
);

// 退回轮询：服务端允许推送、但 SSE 真的掉过——数据还在走，只是慢了
const pillPoll = statusView({
  status: 'ok', lastSampleAt: PILL_NOW, now: PILL_NOW,
  pushActive: false, pushEnabled: true, pushDownCount: 1,
});
assert.equal(pillPoll.tone, 'poll');
assert.equal(pillPoll.fellBack, true);
assert.ok(pillPoll.text.includes('轮询'));
// 页面刚打开、SSE 还没握上手的那一刻（失败次数还是 0）不该提示降级
assert.equal(
  statusView({
    status: 'ok', lastSampleAt: PILL_NOW, now: PILL_NOW,
    pushActive: false, pushEnabled: true, pushDownCount: 0,
  }).tone,
  'live',
  '刚打开页面时 SSE 还在连接中，不能立刻报"已退回轮询"',
);
// 服务端用 --no-push 关了推送时，轮询本来就是正常模式，不该提示降级
assert.equal(
  statusView({ status: 'ok', lastSampleAt: PILL_NOW, now: PILL_NOW, pushActive: false, pushEnabled: false }).tone,
  'live',
  '--no-push 是配置选择，不是降级',
);

// 优先级：采集失败 > 数据陈旧 > 退回轮询
assert.equal(
  statusView({ status: 'error', lastSampleAt: PILL_NOW - 60000, now: PILL_NOW, pushActive: false, relative: pillRel }).tone,
  'error',
);
assert.equal(
  statusView({ status: 'error', lastSampleAt: PILL_NOW - 60000, now: PILL_NOW, relative: pillRel }).text,
  '采集失败 · 数据停留在 1 分钟前',
);
const pillBoth = statusView({
  status: 'ok', lastSampleAt: PILL_NOW - 60000, now: PILL_NOW,
  pushActive: false, pushEnabled: true, pushDownCount: 1, relative: pillRel,
});
assert.equal(pillBoth.tone, 'stale', '陈旧比降级更该先说');
assert.equal(pillBoth.fellBack, false);
// 刚启动还没有样本时不能判成陈旧
assert.equal(statusView({ status: 'loading', now: PILL_NOW }).tone, 'loading');

/* ---------- 前端：导航模式的紧凑顶栏（静态结构） ---------- */
// 顶栏瘦身靠"导航模式打 data-dense，CSS 认这个属性"来落地，这里守住几条一改就坏的约定：
// 页签栏待在网格里 sticky 粘不住、紧凑规则一旦漏出 [data-dense] 就会污染单页模式。
const indexHtml = fs.readFileSync(path.join(HERE, '..', 'public', 'index.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(HERE, '..', 'public', 'styles.css'), 'utf8');
const appJs = fs.readFileSync(path.join(HERE, '..', 'public', 'app.js'), 'utf8');

const topbarAt = indexHtml.indexOf('id="topbar"');
const navAt = indexHtml.indexOf('id="view-nav"');
const gridAt = indexHtml.indexOf('id="work"');
assert.ok(topbarAt > 0, '页签栏要装在一个独立的 #topbar 里');
assert.ok(navAt > topbarAt && navAt < topbarAt + 600, '页签栏要放在 #topbar 里面');
assert.ok(topbarAt < gridAt, '页签栏要在卡片网格之前：待在 .work-grid 里 sticky 粘不住（可粘范围只有自己那一行）');

assert.match(stylesCss, /\.topbar\s*\{[^}]*position:\s*sticky/, '页签栏要 sticky，否则滚到页面下面就得先滚回去才能切页');
// 紧凑规则一律挂在 .app[data-dense="1"] 下：导航模式才加这个属性，单页模式一个像素都不变
for (const match of stylesCss.matchAll(/\[data-dense/g)) {
  assert.equal(
    stylesCss.slice(match.index - 4, match.index),
    '.app',
    `紧凑规则没限定在 .app[data-dense="1"] 下，会污染单页模式：${stylesCss.slice(match.index - 30, match.index + 30)}`,
  );
}
assert.ok(stylesCss.includes('.app[data-dense="1"] .kpis'), 'KPI 行要有紧凑版式');
assert.ok(stylesCss.includes('.app[data-dense="1"] .alerts[data-state="idle"]'), '告警面板只在"没触发"时才压成一行');
assert.ok(appJs.includes('refs.appEl.dataset.dense'), 'app.js 要按展示模式打上 data-dense');
assert.ok(appJs.includes('utilView.footShort'), 'KPI 脚注在紧凑模式下要用短文案');
assert.ok(appJs.includes('syncEvidenceSticky'), '右列 sticky 的判定要跟着顶栏厚薄重算');
assert.ok(appJs.includes("from './gpu-card-parts.js'"), '各卡的两行判定要用抽出来的纯函数，别再各写一份');

/* ---------- 前端：导出弹窗的时间口径说明（静态结构） ---------- */
// 导出的时间列有两列（本地时间 + UTC），说明文字必须跟着列名走：
// 只改列名不改文案、或者把 <p> 删了忘了改 app.js，都会让人对着 UTC 里的 06:25 发懵
assert.ok(indexHtml.includes('id="export-time-hint"'), '导出弹窗要有时间口径的说明位');
assert.ok(appJs.includes('refs.exportTimeHint.textContent'), 'app.js 要往那行里写清楚两列时间分别是什么');
assert.ok(appJs.includes('time_local') && appJs.includes('timestamp_iso'), '说明文字里要点名列名，不能只说"有两列时间"');

/* ---------- 文档：相对链接都要落到真实文件 ---------- */
// README 拆成 README + docs/ 六篇之后，最容易坏的就是跨文件链接（路径写错、改了文件名、
// 搬运时忘了加 ../）。这里只查"指向仓库内文件"的相对链接，http(s) 与页内锚点跳过。
const repoRoot = path.join(HERE, '..');
const docFiles = [
  'README.md', 'README.en.md', 'LICENSE',
  'docs/features.md', 'docs/alerts.md', 'docs/deployment.md',
  'docs/configuration.md', 'docs/faq.md', 'docs/development.md',
];
for (const file of docFiles) {
  const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const relative = target.split('#')[0];
    if (!relative) continue;
    const resolved = path.resolve(path.dirname(path.join(repoRoot, file)), relative);
    assert.ok(fs.existsSync(resolved), `${file} 里的链接指向不存在的文件：${target}`);
  }
}

/* ---------- 硬件健康：XID（内核日志） ---------- */
// 两种来源的总线号写法必须归一到一起，否则日志里的 XID 落不到具体的卡上
assert.equal(normalizeBusId('00000000:3B:00.0'), '3b:00', 'nvidia-smi 的八位域 + 功能号');
assert.equal(normalizeBusId('0000:3b:00'), '3b:00', 'XID 行里的四位域、无功能号');
assert.equal(normalizeBusId('PCI:0000:3b:00'), '3b:00', '带 PCI: 前缀');
assert.equal(normalizeBusId('乱写'), null);

const xidLog = [
  '[12345.678] NVRM: Xid (PCI:0000:3b:00): 48, pid=41381, name=python3',
  '2026-10-14T12:37:51,123456+08:00 host kernel: NVRM: Xid (PCI:0000:3b:00): 48, pid=41381',
  'NVRM: Xid (PCI:0000:5c:00): 79, pid=0',
  '这一行和 XID 无关',
].join('\n');
const parsedXid = parseXidLines(xidLog);
assert.equal(parsedXid.length, 3, '只挑出 XID 行');
assert.equal(parsedXid[0].busId, '3b:00');
assert.equal(parsedXid[0].code, 48);
assert.equal(parsedXid[0].pid, 41381);
assert.equal(parsedXid[2].code, 79);

const xidTracker = createXidTracker();
assert.equal(xidTracker.observe(parsedXid, 1000), 3, '第一次应全部算作新事件');
assert.equal(xidTracker.observe(parsedXid, 2000), 0, '同一份日志再读一遍不能重复计数');
assert.equal(
  xidTracker.observe([...parsedXid, ...parseXidLines('NVRM: Xid (PCI:0000:3b:00): 48, pid=999')], 3000),
  1,
  '多出来的一条才算新事件',
);
assert.equal(xidTracker.forBusId('3b:00').count, 3, '累计次数按卡统计');
assert.equal(xidTracker.forBusId('3b:00').lastCode, 48);
assert.equal(xidTracker.forBusId('5c:00').count, 1, '另一张卡互不影响');
assert.equal(xidTracker.forBusId('aa:00').count, 0, '没出过事的卡是 0 次，不是 null');
// 日志轮转掉一部分时计数会变小：只更新基准，不把同一批错误重复报成新的
assert.equal(xidTracker.observe(parsedXid.slice(0, 1), 4000), 0, '日志变短时不应算作新事件');
assert.equal(xidTracker.forBusId('3b:00').count, 3, '累计次数不倒退');
// 最近窗口会把过期事件滑出去
const windowTracker = createXidTracker({ recentMs: 1000 });
windowTracker.observe(parsedXid, 10_000);
assert.equal(windowTracker.forBusId('3b:00').recent, 2);
windowTracker.observe(parsedXid, 20_000);
assert.equal(windowTracker.forBusId('3b:00').recent, 0, '超过窗口的事件要从"最近"里滑出去');
assert.equal(windowTracker.forBusId('3b:00').count, 2, '滑出去不影响累计');
// 多卡机器上每张卡各出各的问题，"最近"必须是按卡分开的
assert.equal(windowTracker.forBusId('5c:00').count, 1, '另一张卡的累计要分开算');

// 读内核日志：按 dmesg → journalctl 退让，全失败时给一句能看懂的话
const xidArgs = [];
const okLog = await readKernelLog({
  runner: async (bin, args) => { xidArgs.push(bin); return { stdout: xidLog }; },
});
assert.equal(okLog.source, 'dmesg');
assert.equal(okLog.error, null);
assert.equal(xidArgs[0], 'dmesg', '应该先试 dmesg');

const fallbackArgs = [];
const fallbackLog = await readKernelLog({
  runner: async (bin, args) => {
    fallbackArgs.push(bin);
    if (bin === 'dmesg') throw Object.assign(new Error('Operation not permitted'), { stderr: 'dmesg: Operation not permitted' });
    return { stdout: xidLog };
  },
});
assert.equal(fallbackLog.source, 'journalctl', 'dmesg 读不到要退到 journalctl');
assert.deepEqual(fallbackArgs, ['dmesg', 'dmesg', 'journalctl'], '两种 dmesg 参数都试过后才换 journalctl');

const deniedLog = await readKernelLog({
  runner: async () => { throw Object.assign(new Error('denied'), { stderr: 'dmesg: Operation not permitted' }); },
});
assert.equal(deniedLog.text, null);
assert.ok(deniedLog.error.includes('权限'), '权限不足要直说，并给出下一步');
assert.ok(deniedLog.error.includes('dmesg_restrict'));
// 真机上是中文系统，dmesg 回的是"不允许的操作"——只认英文就会漏掉这个最关键的判断
const deniedCn = await readKernelLog({
  runner: async () => { throw Object.assign(new Error('Command failed: dmesg'), { stderr: 'dmesg: 读取内核缓冲区失败: 不允许的操作' }); },
});
assert.ok(deniedCn.error.includes('权限'), '中文的"不允许的操作"也要认出是权限问题');
assert.equal(deniedCn.error.includes('不允许的操作）'), false, '不该把三条命令的原始报错都堆给用户看');
// execFile 只回 "Command failed: <命令>" 时，不能把命令名当成失败原因
const vagueLog = await readKernelLog({
  runner: async () => { throw new Error('Command failed: journalctl -k --no-pager -o short-iso -n 20000'); },
});
assert.equal(vagueLog.error.includes('Command failed'), false, '不能把命令名当作原因写给用户');

// journalctl 权限不足时会"成功返回但只看得到一部分"：必须当作失败，
// 否则会把"看不到"显示成"没有错误"，那是最危险的假阳性
const partialLog = await readKernelLog({
  runner: async (bin) => (bin === 'journalctl'
    ? {
      stdout: '部分日志……',
      stderr: 'Hint: You are currently not seeing messages from other users and the system.\n'
        + '      Users in groups \'adm\', \'systemd-journal\' can see all messages.',
    }
    : (() => { throw Object.assign(new Error('denied'), { stderr: 'dmesg: 读取内核缓冲区失败: 不允许的操作' }); })()),
});
assert.equal(partialLog.text, null, '只能看到部分日志时必须当作读不到，不能当成"累计 0 条"');
assert.ok(partialLog.error.includes('权限'), '并要说明是权限问题');

// 硬件健康能不能配成告警规则。关键性质：取不到值时"不触发"，
// 而不是当成 false/0 —— 把"读不到"当成"没问题"是监控里最危险的错误
let healthClock = 9_000_000;
let healthSamples = [];
const healthLogger = { warn() {}, info() {}, error() {} };
const healthEngine = createAlertEngine({
  config: {
    window: 60000,
    rules: [
      { id: 'remap-fail', metric: 'remapFailure', op: '==', value: true, level: 'critical' },
      { id: 'xid-any', metric: 'xidRecent', op: '>=', threshold: 1, level: 'warning' },
      { id: 'ecc-ue', metric: 'eccUncorrectedVolatile', op: '>=', threshold: 1, level: 'critical' },
      { id: 'ecc-agg', metric: 'eccCorrectedAggregate', op: '>=', threshold: 10, level: 'warning' },
    ],
  },
  getSamples: () => healthSamples,
  notifier: null,
  logger: healthLogger,
});

// 拿不到硬件健康信息（老驱动 / 读不到日志）时，四条规则都不该触发
healthSamples = [{ t: healthClock, gpus: [{ index: 0, uuid: 'g0', memUsedPct: 10 }] }];
assert.equal(healthEngine.evaluate({ status: 'ok', gpus: [] }).firing.length, 0, '读不到硬件健康信息时不该触发');

// 真的出现行重映射失败 / XID / 不可纠正错误 → 各自触发
healthClock += 1000;
healthSamples = [{
  t: healthClock,
  gpus: [{
    index: 0,
    uuid: 'g0',
    remap: { failure: true, pending: true },
    xid: { count: 2, recent: 1 },
    eccUncorrectedVolatile: 1,
    eccCorrectedAggregate: 4800,
  }],
}];
const healthResult = healthEngine.evaluate({ status: 'ok', gpus: [] });
assert.equal(healthResult.firing.length, 4, '四类硬件健康规则都应触发');
assert.equal(
  healthResult.firing.filter((item) => item.rule.level === 'critical').length,
  2,
  '行重映射失败与不可纠正错误都该是严重级',
);

// 只在"有情况"时才报：健康状态下四条都不触发
healthClock += 1000;
healthSamples = [{
  t: healthClock,
  gpus: [{ index: 0, uuid: 'g0', remap: { failure: false, pending: false }, xid: { count: 0, recent: 0 }, eccUncorrectedVolatile: 0, eccCorrectedAggregate: 0 }],
}];
assert.equal(healthEngine.evaluate({ status: 'ok', gpus: [] }).firing.length, 0, '健康状态不该触发');
assert.equal(healthResult.firing.length, 4, '上一轮的结果不该被后续求值改写');
assert.equal(state.fields.extended, true);
assert.equal(state.system.mem.usedPct, 40, '/api/state 应带上宿主指标');
assert.equal(state.idle.active, false);
assert.equal(state.idle.currentIntervalMs, 1000);

const historyOut = collector.getHistory();
assert.equal(historyOut.samples.length, 1);
assert.equal(historyOut.samples[0].gpus[0].name, 'NVIDIA GeForce RTX 4090');
assert.equal(historyOut.samples[0].system.mem.usedPct, 40);
assert.ok(Array.isArray(historyOut.samples[0].services), '曲线样本要带上服务汇总（短窗口的持续判定靠它）');
assert.equal(
  'clockSmMHz' in historyOut.samples[0].gpus[0],
  false,
  '曲线样本只保留必要字段，扩展指标只留在最新状态里',
);

collector.noteClient();
assert.equal(collector.cadence().idle, false, '刚有请求时不应处于空闲');
collector.stop();

// 交给历史库的样本必须带上服务汇总：service_sample 表全靠这个字段写。
// 只测"库能存服务行"是不够的——库里那份测试是手动传的 services，
// 采集侧漏传时照样全绿，于是 service_sample 一直是 0 行、长周期服务规则静默失效。
const collectorStoreRows = [];
const storingCollector = createCollector({
  options: { ...baseOptions, smiBin: FAKE_SMI },
  systemCollector: stubSystem,
  store: { appendSample: (sample) => { collectorStoreRows.push(sample); return 0; } },
});
await storingCollector.tick();
assert.equal(collectorStoreRows.length, 1, '采集一拍就应落一行');
assert.ok(
  Array.isArray(collectorStoreRows[0].services) && collectorStoreRows[0].services.length >= 1,
  '落库样本必须带上服务汇总，否则 service_sample 表永远是空的',
);
assert.deepEqual(
  collectorStoreRows[0].services,
  storingCollector.getHistory().samples[0].services,
  '落库的那份要和曲线样本里的是同一份',
);
storingCollector.stop();

// stop() 要把"在途那一拍"交出来：退出流程先等它结束再关历史库。
// 反过来做（先关库）的话，那一拍收尾时取状态会打到已关闭的连接上，直接崩进程。
const raceStore = { appends: 0, appendSample() { this.appends += 1; return 0; }, stats: () => ({ mode: 'sqlite', supportsHistory: true }) };
let releaseSystem = null;
const slowCollector = createCollector({
  options: { ...baseOptions, smiBin: FAKE_SMI },
  systemCollector: {
    sample: async () => {
      await new Promise((resolve) => { releaseSystem = resolve; });
      return stubSystem.sample();
    },
  },
  store: raceStore,
});
const racingTick = slowCollector.tick();
// 采集开头要先起一次 nvidia-smi 子进程，纯 setImmediate 空转跑得比它快，
// 所以这里按真实时间轮询，等它挂到系统采集那一步
const raceDeadline = Date.now() + 3000;
while (!releaseSystem && Date.now() < raceDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
assert.ok(releaseSystem, '在途那一拍应已挂起在系统采集上');

let stopResolved = false;
const stopping = slowCollector.stop();
stopping.then(() => { stopResolved = true; });
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(stopResolved, false, '在途那一拍没结束前 stop() 不该 resolve');

releaseSystem();
await stopping;
await racingTick;
assert.equal(stopResolved, true);
assert.equal(raceStore.appends, 1, '在途那一拍仍应完成落库，不能因为停止就把它丢掉');

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

/* ---------- 服务维度：把进程汇总成"哪个服务占了多少" ---------- */
const svcSummary = summarizeServices([
  { pid: 1, service: '容器 vllm-embed', usedMemMiB: 8502, user: 'root' },
  { pid: 2, service: '容器 vllm-embed', usedMemMiB: 1000, user: 'root' },
  { pid: 3, service: '用户会话', usedMemMiB: 568, user: 'jklei' },
  { pid: 4, service: null, usedMemMiB: 1666, user: 'root' },
], [{ memTotalMiB: 40960 }]);
assert.equal(svcSummary.length, 3);
assert.equal(svcSummary[0].service, '容器 vllm-embed', '按占用从大到小排序');
assert.equal(svcSummary[0].memMiB, 9502, '同一个服务的多个进程要合并');
assert.equal(svcSummary[0].processes, 2);
assert.deepEqual(svcSummary[0].users, ['root']);
assert.ok(Math.abs(svcSummary[0].sharePct - (9502 / 40960) * 100) < 1e-6, '占比按整机显存总量算');
assert.equal(svcSummary[1].service, '未识别', '服务身份拿不到的归到"未识别"，不丢掉');
assert.equal(svcSummary[2].service, '用户会话');
// 拿不到总量时占比是 null，而不是 0 或 NaN
assert.equal(summarizeServices([{ service: 'x', usedMemMiB: 1 }], []).find((entry) => entry.service === 'x').sharePct, null);
assert.equal(serviceSharePct(1024, [{ memTotalMiB: 4096 }]), 25);
assert.equal(serviceSharePct(1024, []), null);
assert.deepEqual(summarizeServices([], []), []);

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

// node:sqlite 要 Node 22.13+。旧版本上这之后的断言（历史库、维护、迁移）都没法跑，
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
    '\n⚠️  当前 Node 没有 node:sqlite（需要 ≥ 22.13）：历史库相关断言跳过，'
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
  // ECC 计数：跟着采样点走，历史里才能看出"有没有在涨"
  eccMode: 'Enabled',
  eccCorrectedVolatile: i,
  eccUncorrectedVolatile: 0,
  eccCorrectedAggregate: 100 + i,
  eccUncorrectedAggregate: 0,
  remap: { correctable: i, uncorrectable: 0, pending: i === 2, failure: false, banksMax: 640 - i },
  xid: { count: i, lastCode: i > 0 ? 48 : null, lastAt: i > 0 ? dbNow - 60000 : null, recent: i > 0 ? 1 : 0 },
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
assert.equal(rawQuery.samples[0].gpus[0].eccMode, 'Enabled', 'ECC 模式要能往返');
assert.equal(rawQuery.samples[0].gpus[0].eccCorrectedAggregate, 100, 'ECC 累计计数要能往返');
assert.equal(rawQuery.samples[2].gpus[0].eccCorrectedVolatile, 2, 'volatile 与 aggregate 要分开存');
assert.equal(rawQuery.samples[0].gpus[0].remap.banksMax, 640, '行重映射要能往返');
assert.equal(rawQuery.samples[2].gpus[0].remap.pending, true, 'Pending 是真假值，存回来也要是布尔');
assert.equal(rawQuery.samples[0].gpus[0].remap.failure, false);
assert.equal(rawQuery.samples[2].gpus[0].xid.count, 2, 'XID 累计要能往返');
assert.equal(rawQuery.samples[2].gpus[0].xid.lastCode, 48);
assert.equal(rawQuery.samples[0].gpus[0].xid.count, 0, '"读到且为 0 次"要能和"没读到"区分开');
assert.equal(rawQuery.samples[0].gpus[0].xid.lastCode, null);
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

/* ---------- 历史库：近 1 小时的利用率均值（跨时间、跨卡） ---------- */
// 卡片上"平均 GPU 利用率"跟别的指标不一样：它不是这一帧的量，而是把库里
// 一段时间内的所有采样点整体拉平，所以聚合必须正确，且读不到的卡不能算进去。
const utilStore = await createSqliteStore({
  file: ':memory:',
  nodeId: 'test-node',
  storeIntervalMs: 1000,
  retentionDays: 0,
  now: () => dbNow,
});
const utilCard = (index, uuid, utilPct) => ({
  index,
  uuid,
  name: 'RTX 4090',
  memUsedMiB: 100,
  memTotalMiB: 1000,
  utilGpuPct: utilPct,
  utilMemPct: 10,
  tempC: 60,
  powerW: 100,
});
// GPU-0 三拍都有数（20/40/60）；GPU-1 只在第一拍读到（80）；GPU-2 三拍都是 null（驱动没给利用率）
utilStore.appendSample({
  t: dbNow,
  gpus: [utilCard(0, 'GPU-0', 20), utilCard(1, 'GPU-1', 80), utilCard(2, 'GPU-2', null)],
  processes: [],
  system: null,
});
utilStore.appendSample({
  t: dbNow + 1000,
  gpus: [utilCard(0, 'GPU-0', 40), utilCard(1, 'GPU-1', null), utilCard(2, 'GPU-2', null)],
  processes: [],
  system: null,
});
utilStore.appendSample({ t: dbNow + 2000, gpus: [utilCard(0, 'GPU-0', 60)], processes: [], system: null });
utilStore.flush();

const utilAll = utilStore.averageGpuUtil({ from: dbNow, to: dbNow + 2000 });
assert.equal(utilAll.avg, 50, '均值应只统计读得到的点：(20+80+40+60)/4');
assert.equal(utilAll.samples, 4, 'util 为 null 的采样点不能算进样本数');
assert.equal(utilAll.cards, 2, '只有真的贡献过数据的卡才算贡献卡');
assert.equal(utilAll.oldestTs, dbNow, '要带回实际覆盖的时间跨度起点');
assert.equal(utilAll.newestTs, dbNow + 2000);

// 区间收窄就只算区间内的点，别把区间外的算进去
const utilNarrow = utilStore.averageGpuUtil({ from: dbNow + 1000, to: dbNow + 1000 });
assert.equal(utilNarrow.avg, 40);
assert.equal(utilNarrow.samples, 1);

// 没有任何数据时要给 null 而不是 0：0% 和"不知道"是两回事
const utilEmpty = utilStore.averageGpuUtil({ from: dbNow + 3600000, to: dbNow + 7200000 });
assert.equal(utilEmpty.avg, null, '空区间应返回 null，返回 0 会被页面画成"利用率 0%"');
assert.equal(utilEmpty.samples, 0);
assert.equal(utilEmpty.cards, 0);
assert.equal(utilEmpty.oldestTs, null, '没有数据就不能编造覆盖时长');
assert.equal(utilEmpty.newestTs, null);
utilStore.close();

// 没有历史库时同样给 null：页面据此退回"这一帧的跨卡平均"并标注无历史库
const utilMemoryStore = createMemoryStore('冒烟测试');
assert.equal(utilMemoryStore.averageGpuUtil().avg, null, '内存库不能假装有跨时间均值');
assert.equal(utilMemoryStore.averageGpuUtil().samples, 0);
assert.equal(utilMemoryStore.averageGpuUtil().cards, 0);

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

// 查询侧的占用下限：只看大进程时不改写入策略，历史照样完整留着
const procWindow = { from: dbNow - 1, to: dbNow + 10000 };
assert.equal(sqliteStore.queryProcesses({ ...procWindow, minMiB: 50 }).length, 4, '下限低于实际占用时不该滤掉任何行');
assert.equal(sqliteStore.queryProcesses({ ...procWindow, minMiB: 200 }).length, 0, '下限高于实际占用时应全部滤掉');
assert.equal(
  sqliteStore.countProcesses({ ...procWindow, minMiB: 200 }),
  0,
  '总数必须和查询用同一个下限，否则会出现"共 4 条却显示 0 条"这种对不上的数字',
);
assert.equal(sqliteStore.queryProcesses({ ...procWindow, minMiB: 200, limit: 50 }).length, 0, '下限与 limit 要能同时生效');

// 进程事件的流式遍历（导出用）：游标必须能跨页继续，且不能靠 limit 把数据截掉
const allProcessPages = [...sqliteStore.processPages({ from: dbNow - 1, to: dbNow + 10000 })];
assert.equal(allProcessPages.length, 4, '遍历要拿全区间内的事件，不受单页条数限制');
assert.equal(allProcessPages[0].ts <= allProcessPages[3].ts, true, '遍历应按时间正序');
const processOrdered = allProcessPages.every((row, index) => {
  if (index === 0) return true;
  const prev = allProcessPages[index - 1];
  // 游标是 (ts, pid)：同一时刻内也要有稳定次序，否则翻页会漏行
  return row.ts > prev.ts || (row.ts === prev.ts && (row.pid ?? -1) >= (prev.pid ?? -1));
});
assert.equal(processOrdered, true, '遍历必须按 (时间, pid) 正序，否则游标翻页会漏行');
assert.equal([...sqliteStore.processPages({ ...procWindow, minMiB: 200 })].length, 0, '遍历也要认占用下限');
assert.equal([...sqliteStore.processPages({ ...procWindow, limit: 2 })].length, 2, '可以只取前 N 条');
// 导出的一行：字段要齐，且不用查库就能拼出来
assert.equal(
  processRowToCsv(CSV_T0, processFromRow(allProcessPages[0])),
  `${CSV_T0_STR.local},${CSV_T0_STR.iso},0,GPU-test,7,train.py,90,容器 vllm-server,root`,
);

// 写入侧的占用下限（--proc-min）：只有显式设了值才丢数据，默认必须一条不落
const procFloorStore = await createSqliteStore({
  file: ':memory:', nodeId: 'test-node', storeIntervalMs: 1, retentionDays: 0, procMinMiB: 500, now: () => dbNow,
});
procFloorStore.appendSample({
  t: dbNow,
  gpus: [gpuAt(0)],
  processes: [
    { gpuUuid: 'GPU-test', gpuIndex: 0, pid: 1, name: 'big.py', usedMemMiB: 800, service: null, user: null },
    { gpuUuid: 'GPU-test', gpuIndex: 0, pid: 2, name: 'small.py', usedMemMiB: 100, service: null, user: null },
  ],
  system: null,
});
procFloorStore.flush();
const floorRows = procFloorStore.queryProcesses({ from: dbNow - 1, to: dbNow + 1 });
assert.equal(floorRows.length, 1, '设了写入下限时只有超过它的进程进库');
assert.equal(floorRows[0].pid, 1, '留下来的应该是占用大的那个');
assert.equal(procFloorStore.stats().procMinMiB, 500, '下限要在状态里露出来，页面才知道当前是多少');
procFloorStore.close();

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

// 默认必须是永久保留：漏传 retentionDays 时应该什么都不删，
// 而不是悄悄按某个时限把历史清掉——按天清理属于静默的数据丢失
const defaultRetentionStore = await createSqliteStore({
  file: ':memory:',
  nodeId: 'test-node',
  storeIntervalMs: 1000,
  now: () => dbNow,
});
assert.equal(defaultRetentionStore.stats().retentionDays, 0, '不传 retentionDays 时应为永久保留');
defaultRetentionStore.appendSample({ t: oldTs, gpus: [gpuAt(0)], processes: [], system: hostAt(0) });
defaultRetentionStore.flush();
assert.equal(defaultRetentionStore.prune(dbNow), 0, '永久保留时不应删除任何行');
assert.equal(defaultRetentionStore.querySamples({ from: oldTs - 1000, to: oldTs + 1000 }).points, 1, '三天前的数据要还在');
defaultRetentionStore.close();

// 空实现：没有历史库时要明确说"不支持"，而不是假装返回空历史
const memoryStore = createMemoryStore('启动时加了 --no-db');
assert.equal(memoryStore.supportsHistory, false);
assert.equal(memoryStore.querySamples({ from: 0, to: 1 }).unsupported, true);
assert.equal([...memoryStore.gpuPages()].length, 0);
assert.equal(memoryStore.stats().reason, '启动时加了 --no-db');
assert.equal(memoryStore.countProcesses({ from: 0, to: 1 }), 0);

/* ---------- 导出：按行生成（流式导出的基础） ---------- */
assert.equal(GPU_CSV_HEADER.startsWith('time_local,timestamp_iso,gpu_index'), true);
assert.equal(SYSTEM_CSV_HEADER.startsWith('time_local,timestamp_iso,cpu_usage_pct'), true);
assert.equal(
  gpuRowToCsv(CSV_T0, gpuFromRow({
    ts: dbNow, idx: 1, uuid: 'u', name: 'A, B', mem_used_mib: 10, mem_total_mib: 20,
    util_gpu_pct: 30, util_mem_pct: 40, temp_c: 50, power_w: 60,
  })),
  `${CSV_T0_STR.local},${CSV_T0_STR.iso},1,"A, B",10,20,50,30,40,50,60`,
  '含逗号的名称要加引号，显存占用率按已用/总量算',
);
assert.equal(systemRowToCsv(CSV_T0, systemFromRow({
  ts: dbNow, cpu_pct: 12.34, mem_used_mib: 500, mem_total_mib: 1000, mem_used_pct: 50,
  swap_used_mib: null, swap_total_mib: null, load1: 0.5, load5: 0.4, load15: 0.3,
  disk_json: JSON.stringify([{ path: '/', usedMiB: 1, totalMiB: 2, usedPct: 50 }]),
  net_rx_bps: 0, net_tx_bps: 2048, uptime_sec: 42,
})), `${CSV_T0_STR.local},${CSV_T0_STR.iso},12.3,500,1000,50,,,0.5,0.4,0.3,/,1,2,50,0,2048`);

// 服务维度的汇总要能落库、读回来（占比按当时的整机显存重算）
sqliteStore.appendSample({
  t: dbNow + 6000,
  gpus: [{ index: 0, uuid: 'GPU-test', name: 'X', memUsedMiB: 100, memTotalMiB: 40960 }],
  processes: [],
  system: null,
  services: [
    { service: '容器 vllm-embed', memMiB: 9502, processes: 3 },
    { service: '用户会话', memMiB: 568, processes: 2 },
  ],
});
sqliteStore.flush();
const storedServices = sqliteStore.querySamples({ from: dbNow + 5000, to: dbNow + 7000 })
  .samples.find((sample) => sample.t === dbNow + 6000);
assert.equal(storedServices.services.length, 2);
assert.equal(storedServices.services[0].service, '容器 vllm-embed', '按占用从大到小');
assert.equal(storedServices.services[0].memMiB, 9502);
assert.ok(Math.abs(storedServices.services[0].sharePct - (9502 / 40960) * 100) < 1e-6, '占比按当时的整机显存算');
assert.equal(storedServices.services[1].processes, 2);

sqliteStore.close();

// 关库之后仍可能被在途调用取状态（退出过程中的请求 / 推送回调）。
// 这时候去碰 db 会抛 ERR_INVALID_STATE，把一次正常重启变成崩溃退出——线上真实发生过。
const statsAfterClose = sqliteStore.stats();
assert.equal(statsAfterClose.closed, true, '关库后要能看出自己已经关了');
assert.equal(statsAfterClose.mode, 'sqlite');
assert.equal(statsAfterClose.written.gpu, 7, '关库后仍要能报出关库前的累计写入量');
assert.equal(statsAfterClose.oldestTs, dbNow, '关库前最后一次的边界要留住');
assert.equal(statsAfterClose.buffered, 0);
assert.equal(sqliteStore.stats().closed, true, '反复取也不能出事');

/* ---------- 历史库降级：错误信息要翻成人话 ---------- */
// 这条信息会出现在启动横幅、/api/state.storage.reason、页面上的历史库与进程历史卡片
// 好几个地方，不能把 Node 的英文原始报错直接抛给用户
const missingSqliteError = Object.assign(new Error('No such built-in module: node:sqlite'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
assert.equal(
  describeStorageError(missingSqliteError, { nodeVersion: 'v18.19.1' }),
  '当前 Node v18.19.1 用不了内置的 node:sqlite，需要升级到 22.13 或更高',
);
// 下限必须是 22.13 而不是 22.5：22.5-22.12 的 node:sqlite 还要 --experimental-sqlite，
// 提示成 22.5 会让人觉得"我已经装到 22.5 了怎么还不行"
assert.equal(describeStorageError(missingSqliteError, { nodeVersion: 'v22.5.0' }).includes('22.13'), true);
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
assert.ok(degradedStore.reason.includes('需要升级到 22.13'), '降级原因要能直接看懂');
assert.equal(degradedStore.reason.includes('built-in module'), false, '不应把 Node 的英文原始报错漏到界面上');
assert.equal(storageWarnings.length, 1, '降级要留一条日志，不能静默');
assert.ok(storageWarnings[0].includes('需要升级到 22.13'));
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
for (const column of ['ecc_mode', 'ecc_corrected_volatile', 'ecc_uncorrected_aggregate']) {
  assert.ok(GPU_CSV_HEADER_FULL.includes(column), `扩展表头缺少 ECC 列 ${column}`);
}
assert.equal(GPU_CSV_HEADER.includes('pcie_gen'), false, '默认表头不应被改动');
const fullCsv = samplesToCsv([{
  t: Date.UTC(2026, 0, 1),
  gpus: [{
    index: 0, name: 'A, B', memUsedMiB: 10, memTotalMiB: 20, memUsedPct: 50, utilGpuPct: 30,
    utilMemPct: 40, tempC: 50, powerW: 60, clockSmMHz: 2500, clockMemMHz: 9001, pstate: 'P2',
    fanPct: 41, pcieGen: 4, pcieWidth: 16, encUtilPct: 3, decUtilPct: 1, throttled: true,
    eccMode: 'Enabled', eccCorrectedVolatile: 0, eccUncorrectedVolatile: 0,
    eccCorrectedAggregate: 12, eccUncorrectedAggregate: 0,
  }],
}], { full: true });
const fullLines = fullCsv.trim().split('\n');
assert.equal(fullLines[0], GPU_CSV_HEADER_FULL);
assert.ok(
  fullLines[1].endsWith(',2500,9001,P2,41,4,16,3,1,1,Enabled,0,0,12,0'),
  `扩展列内容不对：${fullLines[1]}`,
);
// 没拿到节流信息时留空，不要写成 0（那是"明确没有节流"的意思）
assert.ok(
  gpuRowToCsv(CSV_T0, { index: 0, name: 'X', throttled: null }, { full: true }).endsWith(','),
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
  state: healthBase, storage: { mode: 'memory', reason: '启动时加了 --no-db' },
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

/* ---------- 本机部署配置（gpu-monitor.conf）：只补默认值，不盖显式给的环境变量 ---------- */
// 服务器系统时区是 UTC 时，靠这个文件把 TZ 固定下来，之后 ./start-bg.sh 不必每次带参数。
const commonSh = path.join(HERE, '..', '_common.sh');
const commonShText = fs.readFileSync(commonSh, 'utf8');
assert.ok(
  commonShText.indexOf('load_conf_file "$CONF_FILE"') < commonShText.indexOf('PORT="${PORT:-8090}"'),
  '配置文件必须在算内置默认值之前读：否则端口这类值已经被填上默认值，配置永远轮不到',
);

// 这三个脚本本身只在 Linux / macOS 上跑，Windows 上跳过（服务本体不受影响）
if (process.platform !== 'win32') {
  const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-conf-'));
  const confFile = path.join(confDir, 'gpu-monitor.conf');
  fs.writeFileSync(confFile, [
    '# 整行注释不该被当成配置',
    '',
    'TZ=Asia/Shanghai',
    "SMTP_PASS='带 空格 的密码'",
    '  PORT  =  8099  ',
    '这行没有等号，应被忽略',
  ].join('\n'));
  const confProbe = execFileSync('bash', ['-c', [
    'source ' + JSON.stringify(commonSh),
    'unset PORT',                                   // 默认值是 source 时填上的，这里只想看配置文件的解析结果
    'load_conf_file ' + JSON.stringify(confFile),
    'printf "%s|%s|%s|" "${TZ:-}" "${SMTP_PASS:-}" "${PORT:-}"',
    // 显式给过的环境变量应当压过配置文件，否则 TZ=UTC ./start-bg.sh 这种临时覆盖会失效
    // （要真 export 出去，不能写成 `TZ=UTC load_conf_file …`：那种临时赋值在函数返回就还原了）
    'TZ=UTC; export TZ',
    'load_conf_file ' + JSON.stringify(confFile),
    'printf "%s|" "${TZ:-}"',
    // 文件不存在时什么都不做，也不能报错
    'load_conf_file ' + JSON.stringify(path.join(confDir, '不存在.conf')),
    'printf "ok"',
  ].join('\n')], {
    encoding: 'utf8',
    // 只留最基本的变量：TZ 必须干净，否则测不到"配置文件补默认值"这条
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GPU_MONITOR_CONF: path.join(confDir, '不存在.conf') },
  });
  assert.equal(
    confProbe,
    'Asia/Shanghai|带 空格 的密码|8099|UTC|ok',
    `配置文件解析不对：${confProbe}`,
  );
  fs.rmSync(confDir, { recursive: true, force: true });
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

// 阈值顺序反了：规则照常判定，但必须在加载时说出来——否则真出事时只会收到警告那条，
// 配置看着还挺合理（把显存警告线从 85% 放宽到 95%，却忘了严重线还在 93%）
const quietLogger = { warn() {}, info() {}, error() {} };
const conflicting = createAlertEngine({
  config: {
    rules: [
      { id: 'vram-warn', metric: 'memUsedPct', op: '>=', threshold: 95, level: 'warning' },
      { id: 'vram-critical', metric: 'memUsedPct', op: '>=', threshold: 93, level: 'critical' },
    ],
  },
  getSamples: () => [],
  logger: quietLogger,
});
assert.equal(conflicting.snapshot().warnings.length, 1, '严重线比警告线更靠内要报出来');
assert.equal(conflicting.snapshot().warnings[0].ruleId, 'vram-critical', '提示要挂在真正不会先响的那条上');
assert.ok(conflicting.snapshot().warnings[0].message.includes('永远不会先响'));
assert.equal(conflicting.snapshot().ruleCount, 2, '顺序反了不算规则有问题，照常判定');
assert.equal(conflicting.snapshot().problems.length, 0);

const ordered = createAlertEngine({
  config: {
    rules: [
      { id: 'vram-warn', metric: 'memUsedPct', op: '>=', threshold: 95, level: 'warning' },
      { id: 'vram-critical', metric: 'memUsedPct', op: '>=', threshold: 98, level: 'critical' },
      // 阈值相等属于"两条一起响"，不算顺序反了
      { id: 'disk-warn', metric: 'hostDiskUsedPct', op: '>=', threshold: 92, level: 'warning' },
      { id: 'disk-critical', metric: 'hostDiskUsedPct', op: '>=', threshold: 92, level: 'critical' },
      // 不同服务范围之间不该互相比较
      { id: 'svc-warn', metric: 'serviceMemMiB', op: '>=', threshold: 20000, level: 'warning', service: 'vllm-embed' },
      { id: 'svc-critical', metric: 'serviceMemMiB', op: '>=', threshold: 18000, level: 'critical', service: 'mineru' },
      // 布尔量与 == 没有"更严重"的方向，跳过
      { id: 'throttled', metric: 'throttled', op: '==', value: true, level: 'critical' },
    ],
  },
  getSamples: () => [],
  logger: quietLogger,
});
assert.equal(ordered.snapshot().warnings.length, 0, '顺序正确、阈值相等、跨服务范围都不该报');

// 越小越严重的指标也要看方向
const lowerIsWorse = createAlertEngine({
  config: {
    rules: [
      { id: 'free-warn', metric: 'memUsedMiB', op: '<=', threshold: 1000, level: 'warning' },
      { id: 'free-critical', metric: 'memUsedMiB', op: '<=', threshold: 2000, level: 'critical' },
    ],
  },
  getSamples: () => [],
  logger: quietLogger,
});
assert.equal(lowerIsWorse.snapshot().warnings.length, 1, '<= 方向下严重线必须更小');
assert.equal(lowerIsWorse.snapshot().warnings[0].ruleId, 'free-critical');

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

// 规则清单：零触发时页面就靠它说明"在盯什么"，所以没触发的规则也必须齐全
const ruleSnapshot = alertEngine.snapshot().rules;
assert.equal(ruleSnapshot.length, 2, '规则清单要包含全部规则，不只是触发中的那些');
const vramRule = ruleSnapshot.find((rule) => rule.id === 'vram');
assert.equal(vramRule.metricLabel, '显存占用率', '指标要带上中文名，页面不该自己维护一份对照表');
assert.equal(vramRule.threshold, 90);
assert.equal(vramRule.unit, '%');
assert.equal(vramRule.isBoolean, false);
assert.equal(vramRule.forMs, 2000);
assert.equal(vramRule.effectiveForMs, 2000, 'for 没超过窗口时不该被夹短');
assert.equal(vramRule.clamped, false);
assert.equal(vramRule.firingCount, 0, '已恢复的规则不该继续标记为触发中');
const collectRule = ruleSnapshot.find((rule) => rule.id === 'collect-down');
assert.equal(collectRule.isBoolean, true, '布尔型指标的阈值要按布尔传下去');
assert.equal(collectRule.firingCount, 1);
assert.deepEqual(collectRule.targets, ['采集服务'], '触发中的规则要带上目标名，页面才能说清是哪一处');

// for 超过内存窗口：有历史库才能按原时长判定，没有就得如实标出"被夹短了"
const longRuleConfig = {
  window: 60000, rules: [{ id: 'long', metric: 'memUsedPct', op: '>=', threshold: 90, for: '10m' }],
};
const clampedEngine = createAlertEngine({
  config: longRuleConfig, getSamples: () => [], logger: { warn() {} },
});
assert.equal(clampedEngine.snapshot().rules[0].effectiveForMs, 60000);
assert.equal(clampedEngine.snapshot().rules[0].clamped, true, '无历史库时长周期 for 要标成已夹短');
const historyEngine = createAlertEngine({
  config: longRuleConfig,
  getSamples: () => [],
  history: () => ({ samples: [] }),
  logger: { warn() {} },
});
assert.equal(historyEngine.snapshot().rules[0].effectiveForMs, 600000, '有历史库时按规则原本的 for 判定');
assert.equal(historyEngine.snapshot().rules[0].clamped, false);

/* ---------- 告警：配置加载与环境变量展开 ---------- */
/* ---------- 告警：服务维度的指标 ---------- */
let svcClock = 6_000_000;
let svcSamples = [];
const svcNotifications = [];
const svcSample = (t, entries) => ({ t, gpus: [{ index: 0, uuid: 'g0', memTotalMiB: 40960 }], system: null, services: entries });
const serviceEngine = createAlertEngine({
  config: {
    window: 60000,
    intervalMs: 1000,
    cooldown: '10m',
    rules: [{ id: 'svc-vram', metric: 'serviceMemMiB', service: 'vllm-embed', op: '>=', threshold: 8192, for: '2s', level: 'critical' }],
  },
  getSamples: () => svcSamples,
  notifier: { send: async (payload) => svcNotifications.push(payload) },
  now: () => svcClock,
  logger: { warn() {} },
});
svcSamples = [
  svcSample(svcClock - 2000, [{ service: '容器 vllm-embed', memMiB: 9000, sharePct: 22, processes: 3 }]),
  svcSample(svcClock - 1000, [{ service: '容器 vllm-embed', memMiB: 9200, sharePct: 22.13, processes: 3 }]),
  svcSample(svcClock, [{ service: '容器 vllm-embed', memMiB: 9500, sharePct: 23.2, processes: 3 }]),
];
let svcResult = serviceEngine.evaluate({ status: 'ok', gpus: [] });
await flushTasks();
assert.equal(svcResult.firing.length, 1, '服务维度的规则应按服务分别判定');
assert.equal(svcResult.firing[0].target.label, '容器 vllm-embed');
assert.ok(svcNotifications[0].detail.includes('9.28 GiB'), `显存按 GiB 显示更直观：${svcNotifications[0].detail}`);
assert.ok(svcNotifications[0].detail.includes('8.00 GiB'), '阈值同样按 GiB 显示');

// service 过滤：没命中的服务不参与判定
const filteredEngine = createAlertEngine({
  config: { window: 60000, intervalMs: 1000, rules: [{ id: 'f', metric: 'serviceMemMiB', service: 'mineru', op: '>=', threshold: 100, for: '1s' }] },
  getSamples: () => svcSamples,
  notifier: { send: async () => {} },
  now: () => svcClock,
  logger: { warn() {} },
});
assert.equal(filteredEngine.evaluate({ status: 'ok', gpus: [] }).firing.length, 0, 'service 过滤没命中时不应触发');

// 不带过滤：每个服务各自判定
const allServicesEngine = createAlertEngine({
  config: { window: 60000, intervalMs: 1000, rules: [{ id: 'all', metric: 'serviceMemMiB', op: '>=', threshold: 100, for: '2s' }] },
  getSamples: () => [
    svcSample(svcClock - 2000, [{ service: '容器 vllm-embed', memMiB: 9000 }, { service: '容器 mineru-api', memMiB: 8000 }]),
    svcSample(svcClock - 1000, [{ service: '容器 vllm-embed', memMiB: 9100 }, { service: '容器 mineru-api', memMiB: 8100 }]),
    svcSample(svcClock, [{ service: '容器 vllm-embed', memMiB: 9200 }, { service: '容器 mineru-api', memMiB: 8200 }]),
  ],
  notifier: { send: async () => {} },
  now: () => svcClock,
  logger: { warn() {} },
});
assert.equal(allServicesEngine.evaluate({ status: 'ok', gpus: [] }).firing.length, 2, '不带过滤时每个服务各自一条告警');

// 服务消失（容器停了）要自动恢复，而不是停在上一次的值上一直响
svcClock += 3000;
svcSamples = [
  svcSample(svcClock - 2000, [{ service: '容器 vllm-embed', memMiB: 9000 }]),
  svcSample(svcClock - 1000, [{ service: '容器 vllm-embed', memMiB: 9200 }]),
  svcSample(svcClock, []),
];
svcResult = serviceEngine.evaluate({ status: 'ok', gpus: [] });
await flushTasks();
assert.equal(svcResult.firing.length, 0, '服务不在了就不该继续告警');
assert.equal(svcResult.resolved.length, 1);
assert.ok(svcNotifications.some((payload) => payload.kind === 'resolved'));
assert.equal(readServiceMetric(svcSamples[0], '容器 vllm-embed', 'serviceMemMiB'), 9000);
assert.equal(readServiceMetric(svcSamples[0], '不存在的服务', 'serviceMemMiB'), undefined);

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
// dry-run 与真发信在页面上必须能区分：否则会以为"告警配好了"，其实只打印不发送
assert.equal(alertsRuntime.snapshot().dryRun, true);
assert.equal(alertsRuntime.snapshot().rules.length, 1, '运行时快照要把规则清单透传给页面');

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
// 界面会把它包在"未启用（…）"里，自身带括号就会变成双层嵌套
assert.equal(noAlertsRuntime.snapshot().reason.includes('（'), false, '未启用的原因自身不该带括号');
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

/* ---------- 通知自检工具：--dry-run 时不联网也能把配置解析透 ---------- */
const noticeFile = path.join(os.tmpdir(), `gm-notify-${process.pid}.json`);
fs.writeFileSync(noticeFile, JSON.stringify({
  enabled: true,
  rules: [{ id: 'a', metric: 'tempC', op: '>=', threshold: 80 }],
  email: {
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    starttls: false,
    user: 'monitor@example.com',
    pass: '${SMTP_PASS}',
    from: 'monitor@example.com',
    to: ['ops@example.com', 'oncall@example.com'],
  },
  webhook: { url: 'http://127.0.0.1:1/hook' },
}));
const noticeLogs = [];
const noticeLogger = { info: (line) => noticeLogs.push(line), warn: (line) => noticeLogs.push(line), error: (line) => noticeLogs.push(line) };
process.env.SMTP_PASS = 'secret-value';
const noticeReport = await sendTestNotice({ alertsPath: noticeFile, dryRun: true, logger: noticeLogger });
assert.equal(noticeReport.ok, true, 'dry-run 下不应有渠道失败');
assert.deepEqual(noticeReport.info.channels, ['email', 'webhook', 'console']);
assert.deepEqual(noticeReport.info.email.to, ['ops@example.com', 'oncall@example.com'], '收件人要原样列出来，便于核对发给了谁');
assert.equal(noticeReport.info.email.tls, '隐式 TLS', '465 的呈现要说清是隐式 TLS 而不是 STARTTLS');
assert.equal(noticeReport.info.email.hasPassword, true, '${SMTP_PASS} 要能展开，否则发信必然失败');
assert.equal(noticeLogs.filter((line) => line.includes('dry-run')).length, 2);
const missingNotice = await sendTestNotice({ alertsPath: '/nonexistent/alerts.json', dryRun: true, logger: noticeLogger });
assert.equal(missingNotice.ok, false);
assert.ok(missingNotice.reason.includes('未找到'), '配置不存在要给能看懂的原因，而不是抛异常');
fs.unlinkSync(noticeFile);

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
  + '告警长周期查历史库·覆盖不足标注·抗抖动·短 for 自适应 / '
  + '平均利用率的跨时间口径与覆盖不足标注 / 各卡节流·健康·指标标签的行内判定 / 导出宽表布局 / '
  + '曲线悬停（位置→索引·浮窗内容·空数据区） / '
  + '文档相对链接 / '
  + '状态胶囊（陈旧·降级·空闲降频·优先级） / '
  + '导航模式紧凑顶栏（结构约定）/ '
  + '导出时间列（本地时间 + UTC 双列·时区偏移·午夜边界）/ '
  + '--tz 固定时区（系统时区是 UTC 时的回归）\n',
);
