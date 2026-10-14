#!/usr/bin/env node
// 假的 nvidia-smi：只在测试里用来验证 CSV 解析路径（真机不需要它）。
// 它按 --query-gpu= 里请求的字段顺序生成输出，所以以后加指标不用改这个文件。
const args = process.argv.slice(2);
const query = args.find((arg) => arg.startsWith('--query-')) || '';
// 设了 FAKE_SMI_CRLF=1 时输出 Windows 风格的 CRLF，用来验证解析对换行符不敏感
const EOL = process.env.FAKE_SMI_CRLF === '1' ? '\r\n' : '\n';
// 逗号分隔的字段名：模拟"老驱动不认识这些字段"，报错信息与真实 nvidia-smi 一致
const unsupported = new Set((process.env.FAKE_SMI_UNSUPPORTED || '').split(',').filter(Boolean));
const out = (lines) => process.stdout.write(lines.join(EOL) + EOL);

// 1 号卡的名称故意带逗号，2 号卡故意缺功耗字段，用来覆盖解析的边角情况
const GPUS = [
  {
    index: '0',
    uuid: 'GPU-abc-0',
    name: 'NVIDIA GeForce RTX 4090',
    driver_version: '550.90.07',
    'memory.total': '24564',
    'memory.used': '18920',
    'memory.free': '5644',
    'utilization.gpu': '87',
    'utilization.memory': '61',
    'temperature.gpu': '62',
    'power.draw': '310.42',
    'power.limit': '450.00',
    'clocks.current.sm': '2520',
    'clocks.current.memory': '10501',
    pstate: 'P2',
    'fan.speed': '42',
    'pcie.link.gen.current': '4',
    'pcie.link.width.current': '16',
    'utilization.encoder': '0',
    'utilization.decoder': '0',
    'clocks_throttle_reasons.sw_power_cap': 'Not Active',
    'clocks_throttle_reasons.hw_slowdown': 'Not Active',
    'clocks_throttle_reasons.hw_thermal_slowdown': 'Not Active',
    'clocks_throttle_reasons.hw_power_brake_slowdown': 'Not Active',
    'clocks_throttle_reasons.sw_thermal_slowdown': 'Not Active',
    'clocks_throttle_reasons.gpu_idle': 'Active',
    // 一张干净但有历史的卡：本次运行没错，终身累计过 12 次可纠正错误
    'ecc.mode.current': 'Enabled',
    'ecc.errors.corrected.volatile.total': '0',
    'ecc.errors.uncorrected.volatile.total': '0',
    'ecc.errors.corrected.aggregate.total': '12',
    'ecc.errors.uncorrected.aggregate.total': '0',
  },
  {
    index: '1',
    uuid: 'GPU-abc-1',
    name: 'NVIDIA A100-SXM4-80GB, Rev A',
    driver_version: '550.90.07',
    'memory.total': '81920',
    'memory.used': '5120',
    'memory.free': '76800',
    'utilization.gpu': '12',
    'utilization.memory': '8',
    'temperature.gpu': '38',
    'power.draw': '74.10',
    'power.limit': '400.00',
    'clocks.current.sm': '1410',
    'clocks.current.memory': '1215',
    pstate: 'P0',
    'fan.speed': '[Not Supported]',
    'pcie.link.gen.current': '4',
    'pcie.link.width.current': '16',
    'utilization.encoder': '0',
    'utilization.decoder': '1',
    'clocks_throttle_reasons.sw_power_cap': 'Not Active',
    'clocks_throttle_reasons.hw_slowdown': 'Not Active',
    'clocks_throttle_reasons.hw_thermal_slowdown': 'Active',
    'clocks_throttle_reasons.hw_power_brake_slowdown': 'Not Active',
    'clocks_throttle_reasons.sw_thermal_slowdown': 'Not Active',
    'clocks_throttle_reasons.gpu_idle': 'Not Active',
    // 1 号卡故意不提供 ECC 字段：覆盖"驱动不支持时留空"这条路径
  },
  {
    index: '2',
    uuid: 'GPU-abc-2',
    name: 'NVIDIA L40S',
    driver_version: '550.90.07',
    'memory.total': '46068',
    'memory.used': '46000',
    'memory.free': '68',
    'utilization.gpu': '99',
    'utilization.memory': '95',
    'temperature.gpu': '71',
    'power.draw': '[Not Supported]',
    'power.limit': '[Not Supported]',
    'clocks.current.sm': '2520',
    'clocks.current.memory': '9001',
    pstate: 'P2',
    'fan.speed': '88',
    'pcie.link.gen.current': '4',
    'pcie.link.width.current': '16',
    'utilization.encoder': '3',
    'utilization.decoder': '0',
    'clocks_throttle_reasons.sw_power_cap': 'Active',
    'clocks_throttle_reasons.hw_slowdown': 'Not Active',
    'clocks_throttle_reasons.hw_thermal_slowdown': 'Not Active',
    'clocks_throttle_reasons.hw_power_brake_slowdown': 'Not Active',
    'clocks_throttle_reasons.sw_thermal_slowdown': 'Not Active',
    'clocks_throttle_reasons.gpu_idle': 'Not Active',
    // 一张在变坏的卡：本次运行已经有 3 次可纠正、1 次终身不可纠正
    'ecc.mode.current': 'Enabled',
    'ecc.errors.corrected.volatile.total': '3',
    'ecc.errors.uncorrected.volatile.total': '0',
    'ecc.errors.corrected.aggregate.total': '4800',
    'ecc.errors.uncorrected.aggregate.total': '1',
  },
];

if (args.includes('-L')) {
  out([
    'GPU 0: NVIDIA GeForce RTX 4090 (UUID: GPU-abc-0)',
    'GPU 1: NVIDIA A100-SXM4-80GB (UUID: GPU-abc-1)',
    'GPU 2: NVIDIA L40S (UUID: GPU-abc-2)',
  ]);
} else if (query.startsWith('--query-gpu=')) {
  const fields = query.slice('--query-gpu='.length).split(',').map((part) => part.trim()).filter(Boolean);
  const rejected = fields.find((field) => unsupported.has(field));
  if (rejected) {
    process.stderr.write(`Field "${rejected}" is not a valid field to query.\n`);
    process.exit(2);
  }
  out(GPUS.map((gpu) => fields.map((field) => (field in gpu ? gpu[field] : '[Not Supported]')).join(', ')));
} else if (query.startsWith('--query-compute-apps=')) {
  out([
    'GPU-abc-0, 20481, /usr/bin/python3 -m vllm.entrypoints.api_server, 16200',
    'GPU-abc-2, 31117, /usr/bin/python3 train.py --config cfg/a.yaml, 44100',
  ]);
} else {
  process.stderr.write('unsupported invocation\n');
  process.exit(2);
}
