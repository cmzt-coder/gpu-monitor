// 无 GPU 环境下的模拟数据源，用于本地开发与联调（node server.js --mock）
const MOCK_NAMES = [
  'NVIDIA GeForce RTX 4090',
  'NVIDIA A100-SXM4-80GB',
  'NVIDIA RTX 6000 Ada',
  'NVIDIA L40S',
];

const MOCK_PROCESS_NAMES = [
  '/usr/bin/python3 -m vllm.entrypoints.api_server',
  '/usr/bin/python3 train.py --config cfg/a.yaml',
  '/usr/local/bin/ollama serve',
  '/usr/bin/python3 -m torch.distributed.run',
  '/opt/jupyter/bin/python3 -m ipykernel_launcher',
];

export function createMockSource({
  gpuCount = Number(process.env.GPU_MONITOR_MOCK_GPUS || 4),
  highLoad = process.env.GPU_MONITOR_MOCK_HIGH === '1',
} = {}) {
  const startedAt = Date.now();
  const totalMiB = [24564, 81920, 49140, 46068];
  const cards = Array.from({ length: gpuCount }, (_, i) => ({
    index: i,
    uuid: `GPU-mock-${i}`,
    name: MOCK_NAMES[i % MOCK_NAMES.length],
    driverVersion: '550.90.07',
    memTotalMiB: totalMiB[i % totalMiB.length],
    base: 0.28 + (i % 3) * 0.16,
    phase: i * 1.3,
  }));

  return async function readMockSnapshot() {
    const elapsed = (Date.now() - startedAt) / 1000;
    const gpus = cards.map((card) => {
      const wave = Math.sin(elapsed / 18 + card.phase) * 0.18 + Math.sin(elapsed / 5 + card.phase) * 0.04;
      const normal = Math.min(0.97, Math.max(0.05, card.base + wave));
      // 演示高负载配色：GPU 0 稳定在 90% 以上
      const usedRatio = highLoad && card.index === 0
        ? Math.min(0.98, Math.max(0.9, 0.94 + wave * 0.25))
        : normal;
      const memUsedMiB = Math.round(card.memTotalMiB * usedRatio);
      const utilGpuPct = Math.round(Math.min(100, Math.max(0, usedRatio * 118 + Math.sin(elapsed / 3 + card.phase) * 6)));
      return {
        index: card.index,
        uuid: card.uuid,
        name: card.name,
        driverVersion: card.driverVersion,
        memTotalMiB: card.memTotalMiB,
        memUsedMiB,
        memFreeMiB: card.memTotalMiB - memUsedMiB,
        utilGpuPct,
        utilMemPct: Math.round(usedRatio * 100),
        tempC: highLoad && card.index === 0 ? 88 : Math.round(42 + usedRatio * 38),
        powerW: Math.round(90 + usedRatio * 260),
        powerLimitW: 450,
        memUsedPct: usedRatio * 100,
      };
    });

    const processes = gpus
      .map((gpu, i) => {
        if (gpu.memUsedPct < 12) return null;
        return {
          gpuUuid: gpu.uuid,
          gpuIndex: gpu.index,
          pid: 10000 + i * 137,
          name: MOCK_PROCESS_NAMES[i % MOCK_PROCESS_NAMES.length],
          usedMemMiB: Math.round(gpu.memUsedMiB * 0.82),
        };
      })
      .filter(Boolean);

    processes.sort((a, b) => b.usedMemMiB - a.usedMemMiB);
    return { gpus, processes, processWarning: null };
  };
}
