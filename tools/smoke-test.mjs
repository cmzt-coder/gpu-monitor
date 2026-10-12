#!/usr/bin/env node
// 冒烟测试：不依赖网络与真实 GPU，验证 nvidia-smi 解析、环形缓冲与 CSV 导出
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readGpuSnapshot } from '../src/nvidia.js';
import { History } from '../src/history.js';
import { samplesToCsv } from '../src/export.js';
import { createMockSource } from '../src/mock.js';
import { detectPlatform, nvidiaSmiCandidates, resolveNvidiaSmi } from '../src/platform.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SMI = path.join(HERE, 'fake-nvidia-smi.mjs');
const FAKE_SMI_CRLF = path.join(HERE, 'fake-nvidia-smi-crlf.mjs');

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

// 环形缓冲只保留最近 N 个采样点
const history = new History(3);
for (let i = 0; i < 5; i += 1) {
  history.push({ t: i, gpus: [{ index: 0, name: 'x', memUsedMiB: i, memTotalMiB: 10, memUsedPct: i * 10, utilGpuPct: i, utilMemPct: i, tempC: i, powerW: i }] });
}
assert.equal(history.size, 3, '环形缓冲应只保留 3 个采样点');
assert.deepEqual(history.snapshot(3).map((s) => s.t), [2, 3, 4]);

// CSV 导出行数 = 采样点数 x 卡数 + 表头
const csv = samplesToCsv([
  { t: Date.UTC(2026, 8, 30, 1, 2, 3), gpus: [{ index: 0, name: 'A, B', memUsedMiB: 1, memTotalMiB: 2, memUsedPct: 50, utilGpuPct: 10, utilMemPct: 20, tempC: 30, powerW: 40 }] },
]);
const lines = csv.trim().split('\n');
assert.equal(lines.length, 2);
assert.ok(lines[0].startsWith('timestamp_iso,gpu_index'), 'CSV 表头应固定');
assert.ok(lines[1].includes('"A, B"'), '含逗号的名称应被引号包裹');

// 模拟数据源结构应与真实数据结构一致
const mock = await createMockSource({ gpuCount: 2 })();
assert.equal(mock.gpus.length, 2);
assert.ok(mock.gpus.every((gpu) => gpu.memUsedMiB <= gpu.memTotalMiB));

// 平台探测：结果必须和当前进程一致
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
assert.equal(crlf.processes.length, 2);

process.stdout.write('冒烟测试通过：解析 / 环形缓冲 / CSV 导出 / 模拟数据源 / 平台探测 / CRLF 解析\n');
