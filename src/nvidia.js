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
  // 显存纠错（ECC）：单比特错误硬件会自动纠正，双比特纠不回来。
  // 单个计数不说明问题，要看的是"有没有在涨"——所以四个计数都留着，
  // volatile 是本次驱动加载以来、aggregate 是终身累计。
  { key: 'eccMode', field: 'ecc.mode.current', type: 'string' },
  { key: 'eccCorrectedVolatile', field: 'ecc.errors.corrected.volatile.total', type: 'int' },
  { key: 'eccUncorrectedVolatile', field: 'ecc.errors.uncorrected.volatile.total', type: 'int' },
  { key: 'eccCorrectedAggregate', field: 'ecc.errors.corrected.aggregate.total', type: 'int' },
  { key: 'eccUncorrectedAggregate', field: 'ecc.errors.uncorrected.aggregate.total', type: 'int' },
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

function toYesNo(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'yes') return true;
  if (text === 'no') return false;
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

/* ---------- 行重映射（Row Remapper） ---------- */

/**
 * 解析 `nvidia-smi -q -d ROW_REMAPPER` 的输出。
 *
 * 这几个值没有对应的 --query-gpu 字段，只能从 -q 的结构化文本里抠。
 * 返回 Map<PCI 总线号, { correctable, uncorrectable, pending, failure, banksMax }>——
 * 用总线号而不是顺序来对应，是因为 -q 的输出顺序没有承诺。
 */
export function parseRowRemapper(stdout) {
  const byBusId = new Map();
  let current = null;
  let inHistogram = false;

  for (const raw of String(stdout).split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const gpu = /^GPU ([0-9a-fA-F:.]{4,})$/.exec(line);
    if (gpu) {
      current = { correctable: null, uncorrectable: null, pending: null, failure: null, banksMax: null };
      byBusId.set(gpu[1].toLowerCase(), current);
      inHistogram = false;
      continue;
    }
    if (!current) continue;

    // 直方图里的 Max / High / … 是"还有多少 bank 的备用行没动过"
    if (line.startsWith('Bank Remap Availability Histogram')) {
      inHistogram = true;
      continue;
    }
    const kv = /^([^:]+?)\s*:\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();

    if (inHistogram) {
      if (key === 'Max') current.banksMax = toNumber(value);
      continue;
    }
    // 注意 Exact match：'Inactive Correctable Error' 不能被当成 'Correctable Error'
    if (key === 'Correctable Error') current.correctable = toNumber(value);
    else if (key === 'Uncorrectable Error') current.uncorrectable = toNumber(value);
    else if (key === 'Pending') current.pending = toYesNo(value);
    else if (key === 'Remapping Failure Occurred') current.failure = toYesNo(value);
  }
  return byBusId;
}

/**
 * 把各种写法归一成 "bus:device"。
 * XID 行里是 `PCI:0000:3b:00`（四位域、没有功能号），
 * nvidia-smi 的 pci.bus_id 是 `00000000:3B:00.0`（八位域、带功能号）——
 * 只比较"总线:设备"这一段，两边才对得上。
 */
export function normalizeBusId(text) {
  const trimmed = String(text || '').trim().toLowerCase().replace(/^pci:?/, '');
  const withoutFunction = trimmed.split('.')[0];
  const parts = withoutFunction.split(':').filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(-2).join(':');
}

/**
 * 查一次"序号 → PCI 总线号（已归一成 bus:device）"。
 * 内核日志里的 XID 只带总线号，要落到具体的卡上就得先有这张对照表。
 * 总线号不会变，所以调用方拿一次记住就行。
 */
export async function readGpuBusIds({ bin = 'nvidia-smi', timeout = 5000 } = {}) {
  const pairs = await runSmi(bin, 'gpu', ['index', 'pci.bus_id'], timeout);
  const byIndex = new Map();
  for (const line of String(pairs).split('\n')) {
    if (!line.trim()) continue;
    const cells = splitRow(line, 2);
    const index = toNumber(cells[0]);
    const busId = normalizeBusId(cells[1]);
    if (index != null && busId) byIndex.set(index, busId);
  }
  return byIndex;
}

/**
 * 读一次行重映射状态，按 GPU 序号给出来。
 * 需要两次调用：重映射字段只在 -q 里，-q 里又只有总线号，所以另一边查一次
 * index + pci.bus_id 把两者接起来。低频调用（默认 5 分钟一次），开销可忽略。
 */
export async function readRowRemapper({ bin = 'nvidia-smi', timeout = 8000 } = {}) {
  const [pairs, detail] = await Promise.all([
    runSmi(bin, 'gpu', ['index', 'pci.bus_id'], timeout),
    run(bin, ['-q', '-d', 'ROW_REMAPPER'], { timeout, maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout),
  ]);

  const byBusId = parseRowRemapper(detail);
  const byIndex = new Map();
  for (const line of String(pairs).split('\n')) {
    if (!line.trim()) continue;
    const cells = splitRow(line, 2);
    const index = toNumber(cells[0]);
    if (index == null) continue;
    const entry = byBusId.get(String(cells[1] || '').trim().toLowerCase()) || null;
    if (entry) byIndex.set(index, entry);
  }
  // 一条都没解析出来通常意味着这块卡/这个驱动根本不提供重映射信息，
  // 调用方据此把界面那一行整块隐藏，而不是显示一排 0（那会被读成"很健康"）
  return { byIndex, unsupported: byBusId.size === 0 };
}

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
