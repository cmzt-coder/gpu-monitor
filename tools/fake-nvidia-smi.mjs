#!/usr/bin/env node
// 假的 nvidia-smi：只在测试里用来验证 CSV 解析路径（真机不需要它）
const args = process.argv.slice(2);
const query = args.find((arg) => arg.startsWith('--query-')) || '';

if (query.startsWith('--query-gpu=')) {
  process.stdout.write([
    '0, GPU-abc-0, NVIDIA GeForce RTX 4090, 550.90.07, 24564, 18920, 5644, 87, 61, 62, 310.42, 450.00',
    '1, GPU-abc-1, NVIDIA A100-SXM4-80GB, 550.90.07, 81920, 5120, 76800, 12, 8, 38, 74.10, 400.00',
    // 故意带逗号的名称 + 不支持的字段，验证解析健壮性
    '2, GPU-abc-2, NVIDIA L40S, 550.90.07, 46068, 46000, 68, 99, 95, 71, [Not Supported], [Not Supported]',
  ].join('\n') + '\n');
} else if (query.startsWith('--query-compute-apps=')) {
  process.stdout.write([
    'GPU-abc-0, 20481, /usr/bin/python3 -m vllm.entrypoints.api_server, 16200',
    'GPU-abc-2, 31117, /usr/bin/python3 train.py --config cfg/a.yaml, 44100',
  ].join('\n') + '\n');
} else {
  process.stderr.write('unsupported invocation\n');
  process.exit(2);
}
