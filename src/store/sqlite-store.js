// SQLite 历史库（Node 22.5+ 内置的 node:sqlite，不引入第三方依赖）。
//
// 写入：采集线程只往内存缓冲里塞行，由定时器 / 缓冲上限 / 进程退出三种时机批量提交事务。
// 采集节奏与磁盘 IO 解耦，一次写库慢不会卡住采样。
//
// 粒度：库里按 --store-interval（默认 5 秒）抽稀，与页面刷新间隔解耦。
// 屏幕上看 1 秒粒度，库里按 5 秒留，体积差 5 倍而历史趋势几乎无损失。
//
// 读取：对外提供两个"分页迭代器"（gpu / host），导出 90 天这种大区间时靠它们流式写出，
// 不用把几十万行一次性读进内存；querySamples 则是在迭代器之上拼回接口需要的采样点结构。
import { statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { gpuFromRow, gpuRow, hostRow, processRows, processesSignature, systemFromRow } from './rows.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gpu_sample (
  ts            INTEGER NOT NULL,
  node_id       TEXT    NOT NULL,
  uuid          TEXT,
  idx           INTEGER,
  name          TEXT,
  mem_used_mib  REAL,
  mem_total_mib REAL,
  util_gpu_pct  REAL,
  util_mem_pct  REAL,
  temp_c        REAL,
  power_w       REAL,
  clock_sm_mhz  REAL,
  pstate        TEXT,
  fan_pct       REAL,
  throttle_mask INTEGER,
  throttle_any  INTEGER
);
CREATE INDEX IF NOT EXISTS gpu_sample_ts_idx ON gpu_sample (ts);
CREATE INDEX IF NOT EXISTS gpu_sample_uuid_ts_idx ON gpu_sample (uuid, ts);

CREATE TABLE IF NOT EXISTS host_sample (
  ts             INTEGER NOT NULL,
  node_id        TEXT    NOT NULL,
  cpu_pct        REAL,
  mem_used_mib   REAL,
  mem_total_mib  REAL,
  mem_used_pct   REAL,
  swap_used_mib  REAL,
  swap_total_mib REAL,
  load1          REAL,
  load5          REAL,
  load15         REAL,
  disk_json      TEXT,
  net_rx_bps     REAL,
  net_tx_bps     REAL,
  uptime_sec     INTEGER
);
CREATE INDEX IF NOT EXISTS host_sample_ts_idx ON host_sample (ts);

CREATE TABLE IF NOT EXISTS gpu_process (
  ts           INTEGER NOT NULL,
  node_id      TEXT    NOT NULL,
  uuid         TEXT,
  gpu_index    INTEGER,
  pid          INTEGER,
  name         TEXT,
  used_mem_mib REAL
);
CREATE INDEX IF NOT EXISTS gpu_process_ts_idx ON gpu_process (ts);
`;

const GPU_COLUMNS = [
  'ts', 'node_id', 'uuid', 'idx', 'name', 'mem_used_mib', 'mem_total_mib',
  'util_gpu_pct', 'util_mem_pct', 'temp_c', 'power_w', 'clock_sm_mhz',
  'pstate', 'fan_pct', 'throttle_mask', 'throttle_any',
];
const HOST_COLUMNS = [
  'ts', 'node_id', 'cpu_pct', 'mem_used_mib', 'mem_total_mib', 'mem_used_pct',
  'swap_used_mib', 'swap_total_mib', 'load1', 'load5', 'load15', 'disk_json',
  'net_rx_bps', 'net_tx_bps', 'uptime_sec',
];
const PROCESS_COLUMNS = ['ts', 'node_id', 'uuid', 'gpu_index', 'pid', 'name', 'used_mem_mib'];

function insertSql(table, columns) {
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
}

function rowValues(columns, row) {
  return columns.map((column) => (row[column] === undefined ? null : row[column]));
}

export async function createSqliteStore({
  file,
  nodeId,
  storeIntervalMs = 5000,
  retentionDays = 90,
  storeProcesses = true,
  // 进程身份没变时也按这个间隔补一次快照，避免记录到的显存数值离现实太远
  processRefreshMs = 300000,
  flushRows = 400,
  flushMs = 2000,
  pageSize = 5000,
  now = Date.now,
  maxPoints = 2000,
} = {}) {
  // 动态 import：Node 22.5 以下没有 node:sqlite，这里失败由上层退回纯内存模式
  const { DatabaseSync } = await import('node:sqlite');

  const inMemory = file === ':memory:';
  if (!inMemory) {
    await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new DatabaseSync(file);
  if (!inMemory) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // WAL 不可用（比如放在某些网络盘上）不影响正确性，只是并发写会差一点
    }
  }
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);

  const insertGpu = db.prepare(insertSql('gpu_sample', GPU_COLUMNS));
  const insertHost = db.prepare(insertSql('host_sample', HOST_COLUMNS));
  const insertProcess = db.prepare(insertSql('gpu_process', PROCESS_COLUMNS));

  const buffer = { gpu: [], host: [], process: [] };
  const counters = { gpu: 0, host: 0, process: 0 };
  let lastStoreTs = 0;
  let lastProcessSignature = null;
  let lastProcessAt = 0;
  let lastFlushAt = null;
  let lastPruneAt = null;
  let lastPruneDropped = 0;
  let boundsCachedAt = 0;
  let boundsCache = { oldestTs: null, newestTs: null };
  let sizeCachedAt = 0;
  let sizeCache = null;
  let closed = false;

  function flush() {
    const count = buffer.gpu.length + buffer.host.length + buffer.process.length;
    if (count === 0) return 0;
    db.exec('BEGIN');
    try {
      for (const row of buffer.gpu) insertGpu.run(...rowValues(GPU_COLUMNS, row));
      for (const row of buffer.host) insertHost.run(...rowValues(HOST_COLUMNS, row));
      for (const row of buffer.process) insertProcess.run(...rowValues(PROCESS_COLUMNS, row));
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 回滚也失败就没别的办法了，交给上层记录
      }
      throw error;
    }
    counters.gpu += buffer.gpu.length;
    counters.host += buffer.host.length;
    counters.process += buffer.process.length;
    buffer.gpu = [];
    buffer.host = [];
    buffer.process = [];
    lastFlushAt = now();
    boundsCachedAt = 0;
    return count;
  }

  function appendSample(sample) {
    if (closed || !sample || !sample.t) return 0;
    // 按 storeIntervalMs 抽稀：页面 1 秒刷新，库里按 5 秒留
    if (lastStoreTs && sample.t - lastStoreTs < storeIntervalMs) return 0;
    lastStoreTs = sample.t;

    for (const gpu of sample.gpus || []) buffer.gpu.push(gpuRow(nodeId, sample.t, gpu));
    const host = hostRow(nodeId, sample.t, sample.system);
    if (host) buffer.host.push(host);

    if (storeProcesses) {
      // 进程列表：身份变化时写（相当于"谁在什么时候占上了卡"的事件记录），
      // 身份没变则每 processRefreshMs 补一次快照，兼顾体积与精度
      const signature = processesSignature(sample.processes);
      const changed = signature !== lastProcessSignature;
      const stale = lastProcessAt > 0 && sample.t - lastProcessAt >= processRefreshMs;
      if (changed || stale || lastProcessAt === 0) {
        lastProcessSignature = signature;
        lastProcessAt = sample.t;
        buffer.process.push(...processRows(nodeId, sample.t, sample.processes));
      }
    }

    if (buffer.gpu.length + buffer.host.length + buffer.process.length >= flushRows) return flush();
    return 0;
  }

  function prune(at = now()) {
    lastPruneAt = at;
    if (!(retentionDays > 0)) {
      lastPruneDropped = 0;
      return 0;
    }
    const cutoff = at - retentionDays * 86400000;
    let dropped = 0;
    db.exec('BEGIN');
    try {
      for (const table of ['gpu_sample', 'host_sample', 'gpu_process']) {
        const result = db.prepare(`DELETE FROM ${table} WHERE ts < ?`).run(cutoff);
        dropped += Number(result.changes ?? 0);
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 同上
      }
      throw error;
    }
    lastPruneDropped = dropped;
    boundsCachedAt = 0;
    return dropped;
  }

  function bounds() {
    if (boundsCachedAt && now() - boundsCachedAt < 10000) return boundsCache;
    const gpu = db.prepare('SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM gpu_sample').get();
    const host = db.prepare('SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM host_sample').get();
    const mins = [gpu?.min_ts, host?.min_ts].filter((value) => value != null);
    const maxes = [gpu?.max_ts, host?.max_ts].filter((value) => value != null);
    boundsCache = {
      oldestTs: mins.length ? Math.min(...mins) : null,
      newestTs: maxes.length ? Math.max(...maxes) : null,
    };
    boundsCachedAt = now();
    return boundsCache;
  }

  function fileSize() {
    if (inMemory) return null;
    if (sizeCachedAt && now() - sizeCachedAt < 10000) return sizeCache;
    try {
      sizeCache = statSync(file).size;
    } catch {
      sizeCache = null;
    }
    sizeCachedAt = now();
    return sizeCache;
  }

  /**
   * 步长推导：既尊重调用方给的 step，也保证返回点数不至于失控。
   * 每页查询都带 LIMIT，所以这里只管"时间轴分辨率"，不用管总量。
   */
  function resolveStep(from, to, stepMs) {
    const span = Math.max(1, to - from);
    const cadence = Math.max(1, storeIntervalMs);
    let step = Number(stepMs) > 0 ? Math.ceil(Number(stepMs)) : 0;
    const estimatedPoints = span / cadence;
    if (step <= 0 && estimatedPoints > maxPoints) step = Math.ceil(estimatedPoints / maxPoints) * cadence;
    if (step > 0) step = Math.max(step, Math.ceil(span / maxPoints));
    return step;
  }

  const bucketExpr = (alias) => `CAST(ts / ${alias} AS INTEGER) * ${alias}`;

  /**
   * 分页迭代 GPU 行。
   * 游标用 (ts|bucket, uuid) 行值比较：同一次采样里多张卡共享 ts，
   * 只按 ts 翻页会在页边界丢行；uuid 统一 COALESCE 成 '' 避免 NULL 让比较结果为 NULL。
   */
  function* gpuPages({ from, to, step = 0, limit = Infinity } = {}) {
    let emitted = 0;
    let cursorTs = from - 1;
    let cursorUuid = '';
    for (;;) {
      const remaining = limit === Infinity ? pageSize : Math.min(pageSize, limit - emitted);
      if (remaining <= 0) return;
      let rows;
      if (step > 0) {
        rows = db.prepare(`
          SELECT q.* FROM (
            SELECT ${bucketExpr('?')} AS bucket,
                   COALESCE(uuid, '') AS uuid_c,
                   uuid, MAX(idx) AS idx, MAX(name) AS name,
                   AVG(mem_used_mib) AS mem_used_mib, MAX(mem_total_mib) AS mem_total_mib,
                   AVG(util_gpu_pct) AS util_gpu_pct, AVG(util_mem_pct) AS util_mem_pct,
                   MAX(temp_c) AS temp_c, AVG(power_w) AS power_w, AVG(clock_sm_mhz) AS clock_sm_mhz,
                   MAX(fan_pct) AS fan_pct, MAX(throttle_any) AS throttle_any
            FROM gpu_sample
            WHERE ts >= ? AND ts <= ?
            GROUP BY bucket, uuid_c
          ) AS q
          WHERE (q.bucket, q.uuid_c) > (?, ?)
          ORDER BY q.bucket ASC, q.uuid_c ASC
          LIMIT ?
        `).all(step, step, from, to, cursorTs, cursorUuid, remaining);
      } else {
        rows = db.prepare(`
          SELECT ts, COALESCE(uuid, '') AS uuid_c, uuid, idx, name, mem_used_mib, mem_total_mib,
                 util_gpu_pct, util_mem_pct, temp_c, power_w, clock_sm_mhz, pstate, fan_pct,
                 throttle_mask, throttle_any
          FROM gpu_sample
          WHERE ts >= ? AND ts <= ? AND (ts, COALESCE(uuid, '')) > (?, ?)
          ORDER BY ts ASC, uuid_c ASC
          LIMIT ?
        `).all(from, to, cursorTs, cursorUuid, remaining);
      }
      if (rows.length === 0) return;
      for (const row of rows) {
        emitted += 1;
        // 分桶之后 pstate / 节流位掩码失去意义，置空而不是给个看着像样的错值
        yield step > 0
          ? { ...row, ts: row.bucket, pstate: null, throttle_mask: null }
          : row;
      }
      const last = rows[rows.length - 1];
      cursorTs = step > 0 ? last.bucket : last.ts;
      cursorUuid = last.uuid_c;
      if (rows.length < remaining) return;
    }
  }

  function* hostPages({ from, to, step = 0, limit = Infinity } = {}) {
    let emitted = 0;
    let cursorTs = from - 1;
    for (;;) {
      const remaining = limit === Infinity ? pageSize : Math.min(pageSize, limit - emitted);
      if (remaining <= 0) return;
      const rows = step > 0
        ? db.prepare(`
            SELECT q.* FROM (
              SELECT ${bucketExpr('?')} AS bucket,
                     AVG(cpu_pct) AS cpu_pct, AVG(mem_used_mib) AS mem_used_mib,
                     MAX(mem_total_mib) AS mem_total_mib, AVG(mem_used_pct) AS mem_used_pct,
                     AVG(swap_used_mib) AS swap_used_mib, MAX(swap_total_mib) AS swap_total_mib,
                     AVG(load1) AS load1, AVG(load5) AS load5, AVG(load15) AS load15,
                     MAX(disk_json) AS disk_json, AVG(net_rx_bps) AS net_rx_bps,
                     AVG(net_tx_bps) AS net_tx_bps, MAX(uptime_sec) AS uptime_sec
              FROM host_sample
              WHERE ts >= ? AND ts <= ?
              GROUP BY bucket
            ) AS q
            WHERE q.bucket > ?
            ORDER BY q.bucket ASC
            LIMIT ?
          `).all(step, step, from, to, cursorTs, remaining)
        : db.prepare(`
            SELECT ts, cpu_pct, mem_used_mib, mem_total_mib, mem_used_pct, swap_used_mib,
                   swap_total_mib, load1, load5, load15, disk_json, net_rx_bps, net_tx_bps, uptime_sec
            FROM host_sample
            WHERE ts >= ? AND ts <= ? AND ts > ?
            ORDER BY ts ASC
            LIMIT ?
          `).all(from, to, cursorTs, remaining);
      if (rows.length === 0) return;
      for (const row of rows) {
        emitted += 1;
        yield step > 0 ? { ...row, ts: row.bucket } : row;
      }
      cursorTs = step > 0 ? rows[rows.length - 1].bucket : rows[rows.length - 1].ts;
      if (rows.length < remaining) return;
    }
  }

  /**
   * 区间查询，返回与 /api/history 一致的采样点结构，
   * 这样前端切到历史模式时能复用同一套画图逻辑。
   */
  function querySamples({ from, to, stepMs = 0, pointLimit = maxPoints } = {}) {
    const step = resolveStep(from, to, stepMs);
    const cap = Math.max(1, Math.floor(pointLimit));
    const buckets = new Map();
    let truncated = false;

    for (const row of gpuPages({ from, to, step, limit: cap * 64 })) {
      if (!buckets.has(row.ts) && buckets.size >= cap) {
        truncated = true;
        break;
      }
      if (!buckets.has(row.ts)) buckets.set(row.ts, { t: row.ts, gpus: [], system: null });
      buckets.get(row.ts).gpus.push(gpuFromRow(row));
    }
    for (const row of hostPages({ from, to, step, limit: cap * 4 })) {
      if (!buckets.has(row.ts)) {
        if (buckets.size >= cap) break;
        buckets.set(row.ts, { t: row.ts, gpus: [], system: null });
      }
      buckets.get(row.ts).system = systemFromRow(row);
    }

    const samples = [...buckets.values()].sort((a, b) => a.t - b.t);
    for (const sample of samples) sample.gpus.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return {
      from,
      to,
      step,
      cadenceMs: storeIntervalMs,
      samples,
      points: samples.length,
      truncated,
    };
  }

  function queryProcesses({ from, to, limit = 5000 } = {}) {
    return db.prepare(`
      SELECT ts, uuid, gpu_index, pid, name, used_mem_mib
      FROM gpu_process
      WHERE ts >= ? AND ts <= ?
      ORDER BY ts DESC
      LIMIT ?
    `).all(from, to, limit).map((row) => ({
      t: row.ts,
      gpuUuid: row.uuid,
      gpuIndex: row.gpu_index,
      pid: row.pid,
      name: row.name,
      usedMemMiB: row.used_mem_mib,
    }));
  }

  function stats() {
    const { oldestTs, newestTs } = bounds();
    return {
      mode: 'sqlite',
      supportsHistory: true,
      path: inMemory ? null : path.resolve(file),
      sizeBytes: fileSize(),
      buffered: buffer.gpu.length + buffer.host.length + buffer.process.length,
      written: { ...counters },
      oldestTs,
      newestTs,
      lastFlushAt,
      lastPruneAt,
      lastPruneDropped,
      storeIntervalMs,
      processRefreshMs,
      retentionDays,
      storeProcesses,
    };
  }

  if (retentionDays > 0) prune();
  const flushTimer = setInterval(() => {
    try {
      flush();
    } catch {
      // 定时器里出错不该把进程带崩，下一次 flush 会再试
    }
  }, flushMs);
  flushTimer.unref?.();
  const pruneTimer = setInterval(() => {
    try {
      prune();
    } catch {
      // 同上
    }
  }, 3600_000);
  pruneTimer.unref?.();

  return {
    mode: 'sqlite',
    supportsHistory: true,
    nodeId,
    appendSample,
    flush,
    prune,
    querySamples,
    queryProcesses,
    gpuPages,
    hostPages,
    resolveStep,
    stats,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(flushTimer);
      clearInterval(pruneTimer);
      try {
        flush();
      } finally {
        db.close();
      }
    },
  };
}
