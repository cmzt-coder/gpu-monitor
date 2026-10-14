// 无 GPU 环境下的模拟数据源，用于本地开发与联调（node server.js --mock）
const MOCK_NAMES = [
  'NVIDIA GeForce RTX 4090',
  'NVIDIA A100-SXM4-80GB',
  'NVIDIA RTX 6000 Ada',
  'NVIDIA L40S',
];

// 进程也带上"服务归属"，让 --mock 下的表格和真机一致（容器 / systemd / 用户会话都要覆盖到）
const MOCK_PROCESSES = [
  {
    name: '/usr/bin/python3 -m vllm.entrypoints.api_server',
    service: '容器 vllm-server',
    serviceKind: 'container',
    containerId: 'f82ea7a094268cae1962222556278877e19ff221f3972aa7bfc89201615ba040',
    containerName: 'vllm-server',
    user: 'root',
    cmdline: 'python3 -m vllm.entrypoints.openai.api_server --model Qwen3-32B --tensor-parallel-size 2',
  },
  {
    name: '/usr/bin/python3 train.py --config cfg/a.yaml',
    service: 'train.service',
    serviceKind: 'systemd',
    user: 'ztlu',
    cmdline: '/usr/bin/python3 train.py --config cfg/a.yaml --epochs 30',
  },
  {
    name: '/usr/local/bin/ollama serve',
    service: '用户会话',
    serviceKind: 'session',
    user: 'jklei',
    cmdline: '/usr/local/bin/ollama serve',
  },
  {
    name: '/usr/bin/python3 -m torch.distributed.run',
    service: '容器 torchrun',
    serviceKind: 'container',
    containerName: 'torchrun',
    user: 'root',
    cmdline: 'torchrun --nproc_per_node=4 train.py --config cfg/b.yaml',
  },
  {
    name: '/opt/jupyter/bin/python3 -m ipykernel_launcher',
    // 手动启动、又没有容器身份的进程：这里就该留空，而不是编一个服务名
    service: null,
    serviceKind: null,
    user: 'ztlu',
    cmdline: '/opt/jupyter/bin/python3 -m ipykernel_launcher -f /tmp/kernel-8f2.json',
  },
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
      const tempC = highLoad && card.index === 0 ? 88 : Math.round(42 + usedRatio * 38);
      // 扩展指标也一起模拟，这样 --mock 下能看到时钟 / P-State / 风扇 / 节流这几行
      const smClock = Math.round(1200 + usedRatio * 1350);
      const fanPct = Math.round(Math.min(100, 25 + usedRatio * 65));
      const thermalThrottle = tempC >= 83;
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
        tempC,
        powerW: Math.round(90 + usedRatio * 260),
        powerLimitW: 450,
        memUsedPct: usedRatio * 100,
        clockSmMHz: smClock,
        clockMemMHz: 9000 + (card.index % 2) * 1500,
        pstate: usedRatio > 0.5 ? 'P2' : 'P8',
        fanPct,
        pcieGen: 4,
        pcieWidth: 16,
        encUtilPct: card.index % 2 === 0 ? Math.round(usedRatio * 6) : 0,
        decUtilPct: card.index === 2 ? Math.round(usedRatio * 4) : 0,
        // ECC 也模拟：2 号卡演示"累计过错误、本次又在涨"，3 号卡演示"驱动不提供该字段"
        ...(card.index === 3 ? {} : {
          eccMode: 'Enabled',
          eccCorrectedVolatile: card.index === 2 ? 3 : 0,
          eccUncorrectedVolatile: 0,
          eccCorrectedAggregate: card.index === 2 ? 4800 : card.index * 6,
          eccUncorrectedAggregate: card.index === 2 ? 1 : 0,
        }),
        // 行重映射：2 号卡演示"重映射失败"，1 号卡演示"有重映射待生效"，3 号卡不提供
        ...(card.index === 3 ? {} : {
          remap: {
            correctable: card.index === 2 ? 7 : 0,
            uncorrectable: card.index === 2 ? 3 : 0,
            pending: card.index === 1,
            failure: card.index === 2,
            banksMax: card.index === 2 ? 0 : 640 - card.index * 2,
          },
        }),
        // XID 来自内核日志，模拟数据源没有日志可读：1 号卡演示"读到且干净"，
        // 2 号卡演示"出现了致命编号"，3 号卡演示"没读到日志"（不显示任何结论）
        ...(card.index === 3 ? {} : {
          xid: {
            count: card.index === 2 ? 2 : 0,
            lastCode: card.index === 2 ? 48 : null,
            lastAt: card.index === 2 ? Date.now() - 600000 : null,
            recent: card.index === 2 ? 2 : 0,
          },
        }),
        throttle: {
          swPowerCap: usedRatio > 0.9,
          hwSlowdown: false,
          hwThermal: thermalThrottle,
          hwPowerBrake: false,
          swThermal: false,
          gpuIdle: usedRatio < 0.1,
        },
      };
    });

    const processes = gpus
      .map((gpu, i) => {
        if (gpu.memUsedPct < 12) return null;
        const mock = MOCK_PROCESSES[i % MOCK_PROCESSES.length];
        // 让 0 号卡的进程每 30 秒换一次 PID：真实机器上容器重启就是这样，
        // 有了这个轮换，进程历史的"身份变化留档"和页面的自动重载才跑得起来
        const rotated = i === 0 ? Math.floor(elapsed / 30) : 0;
        return {
          gpuUuid: gpu.uuid,
          gpuIndex: gpu.index,
          pid: 10000 + i * 137 + rotated,
          ...mock,
          usedMemMiB: Math.round(gpu.memUsedMiB * 0.82),
        };
      })
      .filter(Boolean);

    processes.sort((a, b) => b.usedMemMiB - a.usedMemMiB);
    return { gpus, processes, processWarning: null };
  };
}

/**
 * 模拟宿主指标（--mock 时使用）。
 * 和真实采集器接口一致：返回 { sample() }，两个值都带正弦波动，
 * 这样在没有 /proc 的机器上也能看到完整的系统资源卡片和曲线。
 */
export function createMockSystem({ cores = 16, totalMemMiB = 65536, diskTotalMiB = 1024000 } = {}) {
  const startedAt = Date.now();
  const targets = [{ path: '/', totalMiB: diskTotalMiB }];

  return {
    async sample() {
      const elapsed = (Date.now() - startedAt) / 1000;
      const wave = Math.sin(elapsed / 21) * 0.5 + 0.5;
      const cpuPct = Math.min(99, Math.max(3, 24 + wave * 46));
      const memPct = Math.min(96, Math.max(8, 41 + Math.sin(elapsed / 47) * 12));
      const diskPct = 63 + Math.sin(elapsed / 400) * 1.5;
      const rx = Math.round(1_200_000 + wave * 3_500_000);
      const tx = Math.round(600_000 + (1 - wave) * 1_800_000);
      return {
        at: Date.now(),
        unsupported: [],
        cpu: { usagePct: cpuPct, cores, model: 'Mock CPU (--mock)' },
        mem: {
          totalMiB: totalMemMiB,
          usedMiB: (totalMemMiB * memPct) / 100,
          availableMiB: totalMemMiB * (1 - memPct / 100),
          usedPct: memPct,
        },
        swap: { totalMiB: 8192, usedMiB: 512 + wave * 256, usedPct: ((512 + wave * 256) / 8192) * 100 },
        load: { l1: 1.2 + wave, l5: 1.1, l15: 0.9 },
        disk: targets.map((target) => ({
          path: target.path,
          totalMiB: target.totalMiB,
          usedMiB: (target.totalMiB * diskPct) / 100,
          freeMiB: target.totalMiB * (1 - diskPct / 100),
          usedPct: diskPct,
        })),
        net: {
          interfaces: 2,
          rxTotalBytes: rx * elapsed,
          txTotalBytes: tx * elapsed,
          rxBytesPerSec: rx,
          txBytesPerSec: tx,
        },
        uptimeSec: Math.round(elapsed + 86400 * 3),
      };
    },
  };
}
