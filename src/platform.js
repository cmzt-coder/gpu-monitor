// 平台探测：识别当前运行环境，并找到可用的 nvidia-smi。
// 当前只支持 NVIDIA（Linux / Windows）；macOS 上 NVIDIA 官方驱动已停止支持，
// 这里不做别的厂商后端，但探测结果是"能力声明"，前端据此给出准确提示。
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PLATFORM_LABELS = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
  freebsd: 'FreeBSD',
  sunos: 'SunOS',
  aix: 'AIX',
};

export function detectPlatform() {
  const id = process.platform;
  const label = PLATFORM_LABELS[id] || id;

  // 显存监控依赖 nvidia-smi，它由 NVIDIA 驱动提供
  const supported = id === 'linux' || id === 'win32';
  let note = null;
  if (id === 'darwin') {
    note = 'macOS 上 NVIDIA 官方驱动已停止支持，系统不提供 nvidia-smi，无法读取显存数据';
  } else if (!supported) {
    note = `${label} 上没有 NVIDIA 官方驱动，无法读取显存数据`;
  }

  return {
    id,
    label,
    arch: process.arch,
    nodeVersion: process.version,
    hostname: os.hostname(),
    supported,
    note,
  };
}

// nvidia-smi 的候选位置，按优先级排列；PATH 里的命令排最前
export function nvidiaSmiCandidates() {
  const candidates = [{ bin: 'nvidia-smi', source: 'PATH' }];

  if (process.platform === 'win32') {
    candidates.push(
      { bin: 'C:\\Windows\\System32\\nvidia-smi.exe', source: 'Windows 系统目录' },
      { bin: 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe', source: 'NVSMI 目录' },
    );
  } else {
    candidates.push(
      { bin: '/usr/bin/nvidia-smi', source: '/usr/bin' },
      { bin: '/usr/local/bin/nvidia-smi', source: '/usr/local/bin' },
      { bin: '/usr/lib/wsl/lib/nvidia-smi', source: 'WSL2 驱动挂载目录' },
      { bin: '/opt/nvidia/bin/nvidia-smi', source: '/opt/nvidia/bin' },
    );
  }

  return candidates;
}

// 试跑一次 nvidia-smi，顺手数一下能看到几张卡
async function probe(bin, timeout) {
  try {
    const { stdout } = await run(bin, ['-L'], { timeout, maxBuffer: 1024 * 1024 });
    const lines = String(stdout).split('\n').map((line) => line.trim()).filter(Boolean);
    const deviceCount = lines.filter((line) => /^GPU\s+\d+:/.test(line)).length;
    return { ok: true, deviceCount, detail: lines[0] || 'nvidia-smi 可用' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'not-found' };
    if (error?.killed || error?.signal) return { ok: false, reason: 'timeout' };
    const detail = String(error?.stderr || error?.message || '').trim().split('\n')[0];
    return { ok: false, reason: 'failed', detail };
  }
}

// 按平台给出"找不到 nvidia-smi"时的排查建议
function platformHint() {
  if (process.platform === 'darwin') {
    return '显存监控需要装在带 NVIDIA 显卡与驱动的机器上运行（Linux / Windows）';
  }
  if (process.platform === 'win32') {
    return '确认已安装 NVIDIA 显卡驱动；nvidia-smi.exe 通常位于 C:\\Windows\\System32 或 C:\\Program Files\\NVIDIA Corporation\\NVSMI，也可以用 --nvidia-smi 指定完整路径';
  }
  return '确认已安装 NVIDIA 驱动（nvidia-smi 随驱动一起安装），或用 --nvidia-smi /path/to/nvidia-smi 指定路径';
}

/**
 * 找到可用的 nvidia-smi。
 * 成功：{ ok:true, bin, source, deviceCount, tried }
 * 失败：{ ok:false, error, hint, tried }
 */
export async function resolveNvidiaSmi({ explicit = null, timeout = 5000 } = {}) {
  const candidates = explicit
    ? [{ bin: explicit, source: '启动参数指定' }]
    : nvidiaSmiCandidates();

  const tried = [];
  for (const candidate of candidates) {
    // 绝对路径先看文件是否存在，省掉一次启动子进程的开销
    if ((candidate.bin.includes('/') || candidate.bin.includes('\\')) && !fs.existsSync(candidate.bin)) {
      tried.push({ bin: candidate.bin, source: candidate.source, result: '文件不存在' });
      continue;
    }

    const result = await probe(candidate.bin, timeout);
    if (result.ok) {
      tried.push({ bin: candidate.bin, source: candidate.source, result: '可用' });
      return {
        ok: true,
        bin: candidate.bin,
        source: candidate.source,
        deviceCount: result.deviceCount,
        detail: result.detail,
        tried,
      };
    }

    const reason = result.reason === 'not-found'
      ? '未找到该命令'
      : result.reason === 'timeout'
        ? '执行超时'
        : `执行失败：${result.detail || '未知原因'}`;
    tried.push({ bin: candidate.bin, source: candidate.source, result: reason });
  }

  return {
    ok: false,
    error: process.platform === 'darwin'
      ? '当前系统是 macOS，没有 nvidia-smi，无法读取显存数据'
      : '没有找到可用的 nvidia-smi',
    hint: platformHint(),
    tried,
  };
}
