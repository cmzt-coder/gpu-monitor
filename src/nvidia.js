// 通过 nvidia-smi 读取 GPU 快照与占用进程。
// 字段表驱动：列的顺序、解析类型、是否属于"扩展指标"都由下面的表描述，
// 想加一个指标只需要加一行——查询构造、CSV 解析、老驱动探测都会自动跟上。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CSV_FORMAT = '--format=csv,noheader,nounits';
// name 列的位置：GPU 名称里偶尔带逗号，解析时需要把多出来的片段并回这一列
const NAME_INDEX = 2;

/** 基础字段：只要机器上能跑 nvidia-smi，这些字段就查得到 */
export const BASE_FIELDS = [
  { key: 'index', field: 'index', type: 'int' },
  { key: 'uuid', field: 'uuid', type: 'string' },
  { key: 'name', field: 'name', type: 'string' },
  { key: 'driverVersion', field: 'driver_version', type: 'string' },
  { key: 'memTotalMiB', field: 'memory.total', type: 'int' },
  { key: 'memUsedMiB', field: 'memory.used', type: 'int' },
  { key: 'memFreeMiB', field: 'memory.free', type: 'int' },
  { key: 'utilGpuPct', field: 'utilization.gpu', type: 'int' },
  { key: 'utilMemPct', field: 'utilization.memory', type: 'int' },
  { key: 'tempC', field: 'temperature.gpu', type: 'int' },
  { key: 'powerW', field: 'power.draw', type: 'float' },
  { key: 'powerLimitW', field: 'power.limit', type: 'float' },
];

/** 节流原因：显示用的短名 → nvidia-smi 字段名（值是 "Active" / "Not Active"） */
export const THROTTLE_REASONS = [
  { key: 'swPowerCap', field: 'clocks_throttle_reasons.sw_power_cap' },
  { key: 'hwSlowdown', field: 'clocks_throttle_reasons.hw_slowdown' },
  { key: 'hwThermal', field: 'clocks_throttle_reasons.hw_thermal_slowdown' },
  { key: 'hwPowerBrake', field: 'clocks_throttle_reasons.hw_power_brake_slowdown' },
  { key: 'swThermal', field: 'clocks_throttle_reasons.sw_thermal_slowdown' },
  { key: 'gpuIdle', field: 'clocks_throttle_reasons.gpu_idle' },
];

/** 扩展字段：老驱动可能没有这些字段，启动时逐项探测，不支持的直接剔除 */
export const EXTENDED_FIELDS = [
  { key: 'clockSmMHz', field: 'clocks.current.sm', type: 'int' },
  { key: 'clockMemMHz', field: 'clocks.current.memory', type: 'int' },
  { key: 'pstate', field: 'pstate', type: 'string' },
  { key: 'fanPct', field: 'fan.speed', type: 'int' },
  { key: 'pcieGen', field: 'pcie.link.gen.current', type: 'int' },
  { key: 'pcieWidth', field: 'pcie.link.width.current', type: 'int' },
  { key: 'encUtilPct', field: 'utilization.encoder', type: 'int' },
  { key: 'decUtilPct', field: 'utilization.decoder', type: 'int' },
  ...THROTTLE_REASONS.map(({ key, field }) => ({
    key: `throttle_${key}`,
    field,
    type: 'flag',
    throttle: key,
  })),
];

const PROCESS_FIELDS = ['gpu_uuid', 'pid', 'process_name', 'used_memory'];

export function defaultGpuFields() {
  return [...BASE_FIELDS, ...EXTENDED_FIELDS];
}

/* ---------- 取值转换 ---------- */

const EMPTY_VALUES = new Set(['', 'N/A', '[N/A]']);

function isUnavailable(text) {
  return EMPTY_VALUES.has(text) || text.startsWith('[Not Supported') || text.startsWith('[Unknown');
}

function toNumber(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (isUnavailable(text)) return null;
  const num = Number.parseFloat(text);
  return Number.isFinite(num) ? num : null;
}

function toText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return isUnavailable(text) ? null : text;
}

function toFlag(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'active') return true;
  if (text === 'not active') return false;
  return null;
}

function convert(value, type) {
  if (type === 'flag') return toFlag(value);
  if (type === 'string') return toText(value);
  return toNumber(value);
}

/* ---------- 解析 ---------- */

/**
 * 按逗号切一行，并把"多出来的片段"并回 name 列。
 * GPU 名称里带逗号时列数会超出预期，多出来的部分一定属于 name 列。
 */
export function splitRow(line, fieldCount) {
  const parts = String(line).split(',').map((part) => part.trim());
  if (parts.length === fieldCount) return parts;
  if (parts.length < fieldCount) {
    return [...parts, ...new Array(fieldCount - parts.length).fill('')];
  }
  const tailCount = fieldCount - NAME_INDEX - 1;
  return [
    ...parts.slice(0, NAME_INDEX),
    parts.slice(NAME_INDEX, parts.length - tailCount).join(', '),
    ...parts.slice(parts.length - tailCount),
  ];
}

export function parseGpuCsv(stdout, fields = defaultGpuFields()) {
  const lines = String(stdout).split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const cells = splitRow(line, fields.length);
    const gpu = {};
    const throttle = {};
    let hasThrottleValue = false;
    fields.forEach((spec, index) => {
      const value = convert(cells[index], spec.type);
      if (spec.throttle) {
        throttle[spec.throttle] = value;
        // 驱动完全没报节流字段时（例如只有基础字段可用），不要留一个全 null 的结构
        if (value != null) hasThrottleValue = true;
      } else {
        gpu[spec.key] = value;
      }
    });
    if (hasThrottleValue) gpu.throttle = throttle;
    if (!gpu.name) gpu.name = 'Unknown GPU';
    gpu.memUsedPct = gpu.memTotalMiB && gpu.memUsedMiB != null
      ? (gpu.memUsedMiB / gpu.memTotalMiB) * 100
      : null;
    return gpu;
  });
}

export function parseProcessCsv(stdout) {
  const lines = String(stdout).split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const cells = splitRow(line, PROCESS_FIELDS.length);
    return {
      gpuUuid: cells[0] || null,
      pid: toNumber(cells[1]),
      name: toText(cells[2]) || '未知进程',
      usedMemMiB: toNumber(cells[3]),
    };
  });
}

/* ---------- 调用 nvidia-smi ---------- */

async function runSmi(bin, kind, fieldNames, timeout) {
  const { stdout } = await run(bin, [`--query-${kind}=${fieldNames.join(',')}`, CSV_FORMAT], {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** 把进程按 uuid 关联回 GPU 序号，并按显存占用从高到低排序 */
export function linkProcesses(gpus, processes) {
  const uuidToIndex = new Map(gpus.map((gpu) => [gpu.uuid, gpu.index]));
  for (const proc of processes) {
    proc.gpuIndex = proc.gpuUuid != null && uuidToIndex.has(proc.gpuUuid)
      ? uuidToIndex.get(proc.gpuUuid)
      : null;
  }
  processes.sort((a, b) => (b.usedMemMiB || 0) - (a.usedMemMiB || 0));
  return processes;
}

/**
 * 读取一次 GPU 快照。
 * 进程查询失败（例如权限不足）不会导致整体失败，只返回空进程列表和一条提示。
 */
export async function readGpuSnapshot({ bin = 'nvidia-smi', timeout = 5000, fields = defaultGpuFields() } = {}) {
  const [gpuResult, processResult] = await Promise.allSettled([
    runSmi(bin, 'gpu', fields.map((spec) => spec.field), timeout),
    runSmi(bin, 'compute-apps', PROCESS_FIELDS, timeout),
  ]);

  if (gpuResult.status === 'rejected') {
    const reason = gpuResult.reason;
    const detail = (reason && (reason.stderr || reason.message)) || String(reason);
    const brief = String(detail).trim().split('\n').slice(0, 3).join(' ');
    throw new Error(`调用 ${bin} 失败：${brief}`);
  }

  const gpus = parseGpuCsv(gpuResult.value, fields);
  let processes = [];
  let processWarning = null;
  if (processResult.status === 'fulfilled') {
    processes = linkProcesses(gpus, parseProcessCsv(processResult.value));
  } else {
    processWarning = '进程列表读取失败（常见原因是权限不足），建议用 root 或与业务进程相同的用户启动采集服务。';
  }

  return { gpus, processes, processWarning, fields };
}

/* ---------- 扩展字段探测 ---------- */

/**
 * 从 nvidia-smi 的报错里找出"不被支持的那个字段"。
 * 注意只能看 stderr：error.message 里带着完整命令行，会把所有字段名都匹配上，
 * 结果第一个基础字段就被误判成"不被支持"，探测逻辑直接失效。
 */
export function pickUnsupportedField(error, fields) {
  const stderr = String(error?.stderr || '');
  // 驱动通常这样报：Field "clocks.current.memory" is not a valid field to query.
  for (const quoted of stderr.match(/"([^"]+)"/g) || []) {
    const name = quoted.slice(1, -1);
    const hit = fields.find((spec) => spec.field === name);
    if (hit) return hit;
  }
  return fields.find((spec) => stderr.includes(spec.field)) || null;
}

/**
 * 探测这台机器的驱动支持哪些扩展字段。
 * 老驱动遇到不认识的字段会报错并让整条查询失败，所以这里用"失败就剔除该字段再试"的
 * 方式逐项确认，结果缓存下来后续复用。基础字段缺失才会真正抛错。
 */
export async function resolveGpuFields({ bin = 'nvidia-smi', timeout = 5000, extended = true } = {}) {
  if (!extended) return { fields: BASE_FIELDS, unsupported: [], extended: false };

  let fields = [...BASE_FIELDS, ...EXTENDED_FIELDS];
  const unsupported = [];

  for (let attempt = 0; attempt <= EXTENDED_FIELDS.length; attempt += 1) {
    try {
      await runSmi(bin, 'gpu', fields.map((spec) => spec.field), timeout);
      return { fields, unsupported, extended: unsupported.length === 0 };
    } catch (error) {
      const bad = pickUnsupportedField(error, fields);
      // 认不出来是谁的错，或者基础字段都不支持，就不是"降级"能解决的问题了
      if (!bad || BASE_FIELDS.includes(bad)) throw error;
      unsupported.push(bad.field);
      fields = fields.filter((spec) => spec !== bad);
    }
  }

  throw new Error('扩展字段探测失败：剔除所有扩展字段后仍然报错');
}
