// 宿主系统指标采集：CPU / 内存 / 交换分区 / 负载 / 磁盘 / 网络
// 原则是"能拿到就给，拿不到就在 unsupported 里明确标注"，不用 0 冒充数据。
// Linux 读 /proc 拿内存、交换分区与网卡字节；其它平台用 Node 内置能力，
// Windows 目前没有内置的网络与交换分区来源，会被标记为不支持。
import fs from 'node:fs/promises';
import os from 'node:os';

const KIB_PER_MIB = 1024;
const BYTES_PER_MIB = 1048576;
const PROC_MEMINFO = '/proc/meminfo';
const PROC_NET_DEV = '/proc/net/dev';

/* ---------- 纯解析函数（便于单测） ---------- */

/** 解析 /proc/meminfo，返回 KiB 数值；缺字段时给 null */
export function parseMeminfo(text) {
  const values = {};
  for (const line of String(text).split('\n')) {
    const match = /^([A-Za-z_()0-9]+):\s+(\d+)/.exec(line.trim());
    if (match) values[match[1]] = Number(match[2]);
  }
  return {
    memTotalKiB: values.MemTotal ?? null,
    memFreeKiB: values.MemFree ?? null,
    // 老内核没有 MemAvailable，退回 MemFree
    memAvailableKiB: values.MemAvailable ?? values.MemFree ?? null,
    swapTotalKiB: values.SwapTotal ?? null,
    swapFreeKiB: values.SwapFree ?? null,
  };
}

/** 解析 /proc/net/dev，返回 [{ name, rxBytes, txBytes }]（跳过两行表头） */
export function parseNetDev(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const cells = line.slice(separator + 1).trim().split(/\s+/).map(Number);
    // 接收字节在第 1 列，发送字节在第 9 列（0 基下标 0 和 8）
    if (cells.length < 9 || cells.some((value) => !Number.isFinite(value))) continue;
    rows.push({ name, rxBytes: cells[0], txBytes: cells[8] });
  }
  return rows;
}

/** 聚合 os.cpus() 的累计时间，得到 { idle, total } 两个单调递增的计数 */
export function cpuTimesFromHeap(cpus) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu?.times || {};
    idle += times.idle || 0;
    total += (times.user || 0) + (times.nice || 0) + (times.sys || 0) + (times.idle || 0) + (times.irq || 0);
  }
  return { idle, total };
}

/** 由两次累计值算 CPU 使用率（%）；样本不足或计数回绕时返回 null */
export function cpuUsagePct(prev, next) {
  if (!prev || !next) return null;
  const totalDelta = next.total - prev.total;
  const idleDelta = next.idle - prev.idle;
  if (!(totalDelta > 0)) return null;
  return Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100));
}

/* ---------- 采集器 ---------- */

function defaultDiskTargets(platform) {
  if (platform === 'win32') {
    const drive = process.env.SystemDrive || 'C:';
    return [`${drive}\\`];
  }
  return ['/'];
}

async function readDisk(target) {
  try {
    const stat = await fs.statfs(target);
    const totalBytes = stat.blocks * stat.bsize;
    const usedBytes = Math.max(0, (stat.blocks - stat.bfree) * stat.bsize);
    const freeBytes = stat.bavail * stat.bsize;
    return {
      path: target,
      totalMiB: totalBytes / BYTES_PER_MIB,
      usedMiB: usedBytes / BYTES_PER_MIB,
      freeMiB: freeBytes / BYTES_PER_MIB,
      usedPct: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : null,
    };
  } catch {
    return null;
  }
}

/**
 * 创建宿主指标采集器。
 * - platform：process.platform，测试时可注入
 * - diskTargets：要监控的挂载点，默认 POSIX 用 /，Windows 用系统盘
 * - readFile：注入点，测试时可以喂固定的 /proc 内容
 */
export function createSystemCollector({
  platform = process.platform,
  diskTargets = null,
  readFile = fs.readFile,
  now = Date.now,
} = {}) {
  const targets = diskTargets && diskTargets.length ? diskTargets : defaultDiskTargets(platform);
  const unsupported = [];
  if (platform !== 'linux') unsupported.push('net');
  if (platform !== 'linux') unsupported.push('swap');
  if (platform === 'win32') unsupported.push('load');
  if (typeof fs.statfs !== 'function') unsupported.push('disk');

  let prevCpu = null;
  let prevNet = null;
  let prevNetAt = 0;

  async function sample() {
    const result = { at: now(), unsupported: [...unsupported] };

    // CPU：os.cpus() 在所有平台都有，用累计时间的差值算，第一次样本没有基准
    try {
      const cpus = os.cpus();
      const times = cpuTimesFromHeap(cpus);
      result.cpu = {
        usagePct: cpuUsagePct(prevCpu, times),
        cores: cpus.length,
        model: cpus[0]?.model || null,
      };
      prevCpu = times;
    } catch {
      result.cpu = null;
    }

    // 内存与交换分区
    if (platform === 'linux') {
      try {
        const info = parseMeminfo(await readFile(PROC_MEMINFO, 'utf8'));
        if (info.memTotalKiB == null) {
          result.mem = null;
        } else {
          const totalMiB = info.memTotalKiB / KIB_PER_MIB;
          const availableMiB = (info.memAvailableKiB ?? 0) / KIB_PER_MIB;
          const usedMiB = Math.max(0, totalMiB - availableMiB);
          result.mem = {
            totalMiB,
            usedMiB,
            availableMiB,
            usedPct: totalMiB > 0 ? (usedMiB / totalMiB) * 100 : null,
          };
        }
        if (info.swapTotalKiB == null) {
          result.swap = null;
        } else {
          const swapUsedKiB = Math.max(0, info.swapTotalKiB - (info.swapFreeKiB ?? 0));
          result.swap = {
            totalMiB: info.swapTotalKiB / KIB_PER_MIB,
            usedMiB: swapUsedKiB / KIB_PER_MIB,
            usedPct: info.swapTotalKiB > 0 ? (swapUsedKiB / info.swapTotalKiB) * 100 : null,
          };
        }
      } catch {
        result.mem = null;
        result.swap = null;
      }
    } else {
      const total = os.totalmem();
      const free = os.freemem();
      const usedMiB = Math.max(0, (total - free) / BYTES_PER_MIB);
      result.mem = {
        totalMiB: total / BYTES_PER_MIB,
        usedMiB,
        availableMiB: free / BYTES_PER_MIB,
        usedPct: total > 0 ? (usedMiB / (total / BYTES_PER_MIB)) * 100 : null,
      };
      result.swap = null;
    }

    // 负载：Windows 上 os.loadavg() 恒为 0，直接标记不支持
    if (platform === 'win32') {
      result.load = null;
    } else {
      const [l1, l5, l15] = os.loadavg();
      result.load = { l1, l5, l15 };
    }

    // 磁盘：fs.statfs 在 Node 18.15+ 才有，跨平台可用
    if (typeof fs.statfs === 'function') {
      result.disk = (await Promise.all(targets.map(readDisk))).filter(Boolean);
    } else {
      result.disk = [];
    }

    // 网络：只有 Linux 有便宜的读数来源
    if (platform === 'linux') {
      try {
        const rows = parseNetDev(await readFile(PROC_NET_DEV, 'utf8')).filter((row) => row.name !== 'lo');
        const rxBytes = rows.reduce((sum, row) => sum + row.rxBytes, 0);
        const txBytes = rows.reduce((sum, row) => sum + row.txBytes, 0);
        const at = now();
        const elapsed = prevNetAt ? (at - prevNetAt) / 1000 : 0;
        result.net = {
          interfaces: rows.length,
          rxTotalBytes: rxBytes,
          txTotalBytes: txBytes,
          rxBytesPerSec: prevNet && elapsed > 0 ? Math.max(0, (rxBytes - prevNet.rx) / elapsed) : null,
          txBytesPerSec: prevNet && elapsed > 0 ? Math.max(0, (txBytes - prevNet.tx) / elapsed) : null,
        };
        prevNet = { rx: rxBytes, tx: txBytes };
        prevNetAt = at;
      } catch {
        result.net = null;
      }
    } else {
      result.net = null;
    }

    // os.uptime() 在部分受限环境（容器/沙箱）会直接抛 EPERM，不能让它带崩整次采样
    try {
      result.uptimeSec = Math.round(os.uptime());
    } catch {
      result.uptimeSec = null;
    }
    return result;
  }

  return { sample };
}
