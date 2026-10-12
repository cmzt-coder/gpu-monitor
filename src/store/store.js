// 历史库工厂：优先用 SQLite，不可用时退化成"只有内存窗口"的空实现。
//
// 退化的场景有两种，都很常见：Node 版本低于 22.5（没有 node:sqlite），
// 或者显式带了 --no-db。这时服务照常运行，只是 /api/history 只会返回内存窗口，
// 页面会明确提示"未启用历史库"，而不是假装有历史数据。
import { createSqliteStore } from './sqlite-store.js';

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

export async function createStore({ options, nodeId, logger = console }) {
  if (options.db === false) return createMemoryStore('未启用（--no-db）');
  try {
    return await createSqliteStore({
      file: options.dbPath,
      nodeId,
      storeIntervalMs: options.storeIntervalMs,
      retentionDays: options.retentionDays,
      storeProcesses: options.storeProcesses,
      reclaimOnStart: options.reclaimOnStart,
    });
  } catch (error) {
    const reason = error?.message || String(error);
    logger.warn?.(`[gpu-monitor] 历史库不可用（${reason}），本次运行只保留内存窗口`);
    return createMemoryStore(reason);
  }
}
