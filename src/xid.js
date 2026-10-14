// XID：NVIDIA 驱动往内核日志里打的错误编号，形如
//   NVRM: Xid (PCI:0000:3b:00): 48, pid=41381, ...
// 它相当于 GPU 的"黑匣子"：编号含义跨度极大，从纯信息（63 只是记录了一次行重映射）
// 到硬件致命（79 = 掉出 PCIe 总线）。这里只负责"读到、解析、别重复计数"。
//
// 两个现实约束决定了实现方式：
//   1. 内核日志要权限（Ubuntu 默认 kernel.dmesg_restrict=1，非 root 读不了），
//      所以按 dmesg → journalctl 的顺序退让，都读不到就如实说明原因；
//   2. 环形缓冲会轮转、重启就清空，所以"出过几次"必须自己累计。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// 总线号的归一规则属于"两个 NVIDIA 输出格式之间的事"，放在 nvidia.js 里统一维护
import { normalizeBusId } from './nvidia.js';

const run = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;

/** 从一行日志里抠出 XID 事件；不是 XID 行就返回 null */
export function parseXidLine(line) {
  const match = /Xid\s*\(PCI:([0-9a-fA-F:.]+)\)\s*:?\s*(\d+)/.exec(line);
  if (!match) return null;
  const busId = normalizeBusId(match[1]);
  if (!busId) return null;
  const pid = /\bpid=(\d+)/.exec(line);
  return {
    busId,
    code: Number(match[2]),
    pid: pid ? Number(pid[1]) : null,
    raw: line.trim(),
  };
}

/** 解析整段日志，按出现顺序给出所有 XID 事件 */
export function parseXidLines(text) {
  const events = [];
  for (const line of String(text).split('\n')) {
    const event = parseXidLine(line);
    if (event) events.push(event);
  }
  return events;
}

/**
 * 累计器。
 *
 * 关键是"别重复计数，也别漏"：日志只追加，所以按事件签名统计"当前日志里出现过几次"，
 * 与上一次的值比较，只把增量算成新事件。日志轮转掉一部分时计数会变小，这时只更新基准、
 * 不再计数——宁可少算，也不要把同一批错误重复报成新错误。
 *
 * 不用日志自带的时间戳：dmesg 的原始格式没有时间戳，journal 有，两种都得支持。
 * "多久之前发生"用我们自己的观察时间算。
 */
export function createXidTracker({ recentMs = 30 * 60 * 1000 } = {}) {
  const seen = new Map();     // 签名 → 上次看到的条数
  // "最近窗口内的事件"必须按卡分开记：多卡机器上每张卡各出各的问题，
  // 用一个全局计数会让所有卡显示同一个数字
  const recent = new Map();   // busId → 新观察到事件的时间点（我们的时钟）
  const perGpu = new Map();   // busId → { count, lastCode, lastAt }
  let total = 0;
  let lastCode = null;
  let lastAt = null;

  const signatureOf = (event) => `${event.busId}|${event.code}|${event.pid ?? '-'}`;

  return {
    /** 把"当前日志里的全部 XID 事件"喂进来，返回本次新发现了多少条 */
    observe(events, at = Date.now()) {
      const counts = new Map();
      for (const event of events) {
        const key = signatureOf(event);
        counts.set(key, (counts.get(key) || 0) + 1);
      }

      let fresh = 0;
      for (const [key, count] of counts) {
        const previous = seen.get(key) || 0;
        seen.set(key, count);
        if (count <= previous) continue;   // 没涨（或日志轮转变小）→ 不算新事件
        const added = count - previous;
        fresh += added;
        total += added;
        const sample = events.filter((event) => signatureOf(event) === key).pop();
        lastCode = sample.code;
        lastAt = at;
        const entry = perGpu.get(sample.busId) || { count: 0, lastCode: null, lastAt: null };
        entry.count += added;
        entry.lastCode = sample.code;
        entry.lastAt = at;
        perGpu.set(sample.busId, entry);
        if (!recent.has(sample.busId)) recent.set(sample.busId, []);
        const times = recent.get(sample.busId);
        for (let i = 0; i < added; i += 1) times.push(at);
      }

      // 只保留最近的窗口，避免长期运行时越攒越多
      const cutoff = at - recentMs;
      for (const times of recent.values()) {
        while (times.length && times[0] < cutoff) times.shift();
      }
      return fresh;
    },

    /** 某张卡的当前状态：累计次数、最近一次的编号与时间、最近窗口内的事件数 */
    forBusId(busId) {
      const entry = perGpu.get(busId);
      return {
        count: entry?.count ?? 0,
        lastCode: entry?.lastCode ?? null,
        lastAt: entry?.lastAt ?? null,
        recent: recent.get(busId)?.length ?? 0,
      };
    },

    summary() {
      let recentTotal = 0;
      for (const times of recent.values()) recentTotal += times.length;
      return { total, lastCode, lastAt, recent: recentTotal };
    },
  };
}

/** 内核日志的读取顺序：先 dmesg（最快），再 journalctl（需要 systemd-journal 组或 root） */
const LOG_SOURCES = [
  { source: 'dmesg', bin: 'dmesg', args: ['--time-format=iso'] },
  { source: 'dmesg', bin: 'dmesg', args: [] },
  { source: 'journalctl', bin: 'journalctl', args: ['-k', '--no-pager', '-o', 'short-iso', '-n', '20000'] },
];

/**
 * 读一次内核日志。
 * 全部失败时返回原因而不是抛错——读不到日志是"权限不够"，不是服务故障，
 * 上层会把它显示成一句中文说明，而不是让这一块凭空消失。
 */
export async function readKernelLog({ timeout = 8000, runner = run } = {}) {
  const tried = [];
  for (const candidate of LOG_SOURCES) {
    try {
      const { stdout, stderr } = await runner(candidate.bin, candidate.args, { timeout, maxBuffer: MAX_BUFFER });
      // journalctl 在没有权限时会**成功返回但只看得到一部分日志**（退出码 0，
      // 只在 stderr 上留一句 Hint）。这种"看起来成功"最危险：会把"看不到"
      // 当成"没有错误"，所以必须显式识别出来，当作读取失败处理。
      if (PARTIAL_VIEW_HINT.test(String(stderr || ''))) {
        tried.push({ bin: `${candidate.bin} ${candidate.args.join(' ')}`.trim(), result: '权限不足，只能看到部分日志' });
        continue;
      }
      return { text: stdout, source: candidate.source, tried, error: null };
    } catch (error) {
      tried.push({ bin: `${candidate.bin} ${candidate.args.join(' ')}`.trim(), result: describeFailure(error) });
    }
  }
  return { text: null, source: null, tried, error: explainFailure(tried) };
}

function describeFailure(error) {
  if (error?.code === 'ENOENT') return '命令不存在';
  const stderr = String(error?.stderr || '').trim();
  if (stderr) return stderr.split('\n')[0];
  // execFile 失败时 message 是 "Command failed: <命令>\n<stderr>"：只取第一行等于什么都没说，
  // 所以有第二行就用第二行（它才是真正的原因）
  const lines = String(error?.message || error).split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) return lines.slice(1).join(' ').slice(0, 200);
  // 剩下的情况只剩"命令名 + Command failed"，那不是原因，别当原因写出来
  return '命令执行失败（没有任何输出）';
}

// 权限不足的提示语要中英都认：系统语言是中文时 dmesg 回的是"不允许的操作"，
// journalctl 则是 "You are currently not seeing messages from other users and the system"
const PERMISSION_HINT = /operation not permitted|permission denied|不允许的操作|权限不足|not seeing messages/i;

// journalctl 权限不足时的原话（退出码仍是 0，只在 stderr 上提示）
const PARTIAL_VIEW_HINT = /not seeing messages|you are currently not seeing|Hint: You are currently/i;

/** 把若干个失败原因归成一句能看懂的话，并给出下一步 */
function explainFailure(tried) {
  const denied = tried.some((item) => PERMISSION_HINT.test(item.result));
  if (denied) {
    return '读不到内核日志（权限不足）：Ubuntu 默认 kernel.dmesg_restrict=1，'
      + '需要 root 运行，或把运行用户加进 systemd-journal 组';
  }
  return `读不到内核日志：${tried.map((item) => `${item.bin}（${item.result}）`).join('；')}`;
}
