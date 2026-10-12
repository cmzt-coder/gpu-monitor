#!/usr/bin/env node
// 假的 nvidia-smi：只在测试里用来验证 CSV 解析路径（真机不需要它）
const args = process.argv.slice(2);
const query = args.find((arg) => arg.startsWith('--query-')) || '';
// 设了 FAKE_SMI_CRLF=1 时输出 Windows 风格的 CRLF，用来验证解析对换行符不敏感
const EOL = process.env.FAKE_SMI_CRLF === '1' ? '\r\n' : '\n';
const out = (lines) => process.stdout.write(lines.join(EOL) + EOL);

if (args.includes('-L')) {
  out([
    'GPU 0: NVIDIA GeForce RTX 4090 (UUID: GPU-abc-0)',
    'GPU 1: NVIDIA A100-SXM4-80GB (UUID: GPU-abc-1)',
    'GPU 2: NVIDIA L40S (UUID: GPU-abc-2)',
  ]);
} else if (query.startsWith('--query-gpu=')) {
  out([
    '0, GPU-abc-0, NVIDIA GeForce RTX 4090, 550.90.07, 24564, 18920, 5644, 87, 61, 62, 310.42, 450.00',
    '1, GPU-abc-1, NVIDIA A100-SXM4-80GB, 550.90.07, 81920, 5120, 76800, 12, 8, 38, 74.10, 400.00',
    // 故意带逗号的名称 + 不支持的字段，验证解析健壮性
    '2, GPU-abc-2, NVIDIA L40S, 550.90.07, 46068, 46000, 68, 99, 95, 71, [Not Supported], [Not Supported]',
  ]);
} else if (query.startsWith('--query-compute-apps=')) {
  out([
    'GPU-abc-0, 20481, /usr/bin/python3 -m vllm.entrypoints.api_server, 16200',
    'GPU-abc-2, 31117, /usr/bin/python3 train.py --config cfg/a.yaml, 44100',
  ]);
} else {
  process.stderr.write('unsupported invocation\n');
  process.exit(2);
}
