// 历史库工厂：优先用 SQLite，不可用时退化成"只有内存窗口"的空实现。
//
// 退化的场景有两种，都很常见：Node 版本低于 22.5（没有 node:sqlite），
// 或者显式带了 --no-db。这时服务照常运行，只是 /api/history 只会返回内存窗口，
// 页面会明确提示"未启用历史库"，而不是假装有历史数据。
import { createSqliteStore } from './sqlite-store.js';

/**
 * 把"历史库打不开"翻译成人能看懂的一句话。
 * 这里的返回值会出现在启动横幅、/api/state.storage.reason、页面上的历史库与进程历史卡片
 * 等好几个地方，所以要在源头翻译一次，而不是让 Node 的原始英文报错漏到界面上。
 */
export function describeStorageError(error, { nodeVersion = process.version } = {}) {
  const message = error?.message || String(error);
  const code = error?.code || '';
  // 最常见的一种：Node 22.5 以下没有内置的 node:sqlite
  if (code === 'ERR_UNKNOWN_BUILTIN_MODULE' || message.includes('node:sqlite')) {
    return `当前 Node ${nodeVersion} 没有 node:sqlite（需要 ≥ 22.5）`;
  }
  // 下面几条把 Node 的原始描述放在冒号后面：界面上本来就是"不可用（…）"，
  // 再来一层括号会变成嵌套括号，很难读
  if (code === 'EACCES' || code === 'EPERM') return `没有权限写入历史库：${message}`;
  if (code === 'ENOSPC') return '磁盘空间不足，无法创建历史库';
  if (code === 'ENOTDIR' || code === 'ENOENT') return `历史库路径不可用：${message}`;
  return message;
}

function emptyPages() {
  return (function* () {})();
}

export function createMemoryStore(reason = null) {
  return {
    mode: 'memory',
    supportsHistory: false,
    reason,
    appendSample() {
      return 0;
    },
    flush() {
      return 0;
    },
    prune() {
      return 0;
    },
    maintain() {
      return { checkpointed: false, incremental: false, reclaimed: false, autoVacuum: null, error: null };
    },
    querySamples() {
      return { samples: [], points: 0, step: 0, truncated: false, unsupported: true };
    },
    queryProcesses() {
      return [];
    },
    countProcesses() {
      return 0;
    },
    gpuPages: emptyPages,
    hostPages: emptyPages,
    resolveStep() {
      return 0;
    },
    stats() {
      return {
        mode: 'memory',
        supportsHistory: false,
        reason,
        buffered: 0,
        written: { gpu: 0, host: 0, process: 0 },
        oldestTs: null,
        newestTs: null,
        freelistBytes: 0,
        walBytes: 0,
      };
    },
    close() {},
  };
}

export async function createStore({ options, nodeId, logger = console, createSqlite = createSqliteStore }) {
  if (options.db === false) return createMemoryStore('未启用（--no-db）');
  try {
    return await createSqlite({
      file: options.dbPath,
      nodeId,
      storeIntervalMs: options.storeIntervalMs,
      retentionDays: options.retentionDays,
      storeProcesses: options.storeProcesses,
      reclaimOnStart: options.reclaimOnStart,
    });
  } catch (error) {
    const reason = describeStorageError(error);
    logger.warn?.(`[gpu-monitor] 历史库不可用（${reason}），本次运行只保留内存窗口`);
    return createMemoryStore(reason);
  }
}
