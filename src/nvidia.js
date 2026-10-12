// 通过 nvidia-smi 读取 GPU 快照与占用进程
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// 查询字段顺序与 parseGpuLines 的解析顺序一一对应
const GPU_QUERY = [
  'index',
  'uuid',
  'name',
  'driver_version',
  'memory.total',
  'memory.used',
  'memory.free',
  'utilization.gpu',
  'utilization.memory',
  'temperature.gpu',
  'power.draw',
  'power.limit',
];

const PROCESS_QUERY = ['gpu_uuid', 'pid', 'process_name', 'used_memory'];

const CSV_FORMAT = '--format=csv,noheader,nounits';

function toNumber(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === '' || text === 'N/A' || text === '[N/A]' || text.startsWith('[Not Supported')) return null;
  const num = Number.parseFloat(text);
  return Number.isFinite(num) ? num : null;
}

function splitCsv(line) {
  return line.split(',').map((part) => part.trim());
}

// GPU 名称里偶尔带逗号，字段数超出预期时把多出来的部分并回 name
function parseGpuLines(stdout) {
  const lines = String(stdout).split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const parts = splitCsv(line);
    const tailCount = GPU_QUERY.length - 3;
    const name = parts.length > GPU_QUERY.length
      ? parts.slice(2, parts.length - tailCount).join(', ')
      : parts[2];
    const tail = parts.slice(parts.length - tailCount);
    const [index, uuid] = parts;
    const [driverVersion, memTotal, memUsed, memFree, utilGpu, utilMem, tempC, powerW, powerLimit] = tail;
    const gpu = {
      index: toNumber(index),
      uuid: uuid || null,
      name: name || 'Unknown GPU',
      driverVersion: driverVersion && driverVersion !== 'N/A' ? driverVersion : null,
      memTotalMiB: toNumber(memTotal),
      memUsedMiB: toNumber(memUsed),
      memFreeMiB: toNumber(memFree),
      utilGpuPct: toNumber(utilGpu),
      utilMemPct: toNumber(utilMem),
      tempC: toNumber(tempC),
      powerW: toNumber(powerW),
      powerLimitW: toNumber(powerLimit),
    };
    gpu.memUsedPct = gpu.memTotalMiB && gpu.memUsedMiB != null
      ? (gpu.memUsedMiB / gpu.memTotalMiB) * 100
      : null;
    return gpu;
  });
}

function parseProcessLines(stdout) {
  const lines = String(stdout).split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const parts = splitCsv(line);
    const hasExtra = parts.length > PROCESS_QUERY.length;
    const usedMemory = hasExtra ? parts[parts.length - 1] : parts[3];
    const name = hasExtra ? parts.slice(2, parts.length - 1).join(', ') : parts[2];
    return {
      gpuUuid: parts[0] || null,
      pid: toNumber(parts[1]),
      name: name || '未知进程',
      usedMemMiB: toNumber(usedMemory),
    };
  });
}

async function runSmi(bin, kind, fields, timeout) {
  const args = [`--query-${kind}=${fields.join(',')}`, CSV_FORMAT];
  const { stdout } = await run(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/**
 * 读取一次 GPU 快照。
 * 进程查询失败（例如权限不足）不会导致整体失败，只返回空进程列表和一条提示。
 */
export async function readGpuSnapshot({ bin = 'nvidia-smi', timeout = 5000 } = {}) {
  const [gpuResult, processResult] = await Promise.allSettled([
    runSmi(bin, 'gpu', GPU_QUERY, timeout),
    runSmi(bin, 'compute-apps', PROCESS_QUERY, timeout),
  ]);

  if (gpuResult.status === 'rejected') {
    const reason = gpuResult.reason;
    const detail = (reason && (reason.stderr || reason.message)) || String(reason);
    const brief = String(detail).trim().split('\n').slice(0, 3).join(' ');
    throw new Error(`调用 ${bin} 失败：${brief}`);
  }

  const gpus = parseGpuLines(gpuResult.value);
  let processes = [];
  let processWarning = null;
  if (processResult.status === 'fulfilled') {
    processes = parseProcessLines(processResult.value);
  } else {
    processWarning = '进程列表读取失败（常见原因是权限不足），建议用 root 或与业务进程相同的用户启动采集服务。';
  }

  // 进程按 uuid 关联回 GPU 序号，便于前端按卡过滤
  const uuidToIndex = new Map(gpus.map((gpu) => [gpu.uuid, gpu.index]));
  for (const proc of processes) {
    proc.gpuIndex = proc.gpuUuid != null && uuidToIndex.has(proc.gpuUuid)
      ? uuidToIndex.get(proc.gpuUuid)
      : null;
  }
  processes.sort((a, b) => (b.usedMemMiB || 0) - (a.usedMemMiB || 0));

  return { gpus, processes, processWarning };
}
