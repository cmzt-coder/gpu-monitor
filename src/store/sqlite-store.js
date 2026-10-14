// SQLite 历史库（用 Node 22.13+ 默认提供的 node:sqlite，不引入第三方依赖）。
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

import { serviceSharePct } from '../services.js';
import { gpuFromRow, gpuRow, hostRow, processRows, processesSignature, serviceRows, systemFromRow } from './rows.js';

// 表结构写成数据结构而不是一整段 SQL：建表、补列迁移、以及"哪些列要写要读"都从这一份生成，
// 避免加了字段却忘了改另一个地方。新增字段只要在这里加一行。
const TABLES = [
  {
    name: 'gpu_sample',
    columns: [
      ['ts', 'INTEGER NOT NULL'],
      ['node_id', 'TEXT NOT NULL'],
      ['uuid', 'TEXT'],
      ['idx', 'INTEGER'],
      ['name', 'TEXT'],
      ['mem_used_mib', 'REAL'],
      ['mem_total_mib', 'REAL'],
      ['util_gpu_pct', 'REAL'],
      ['util_mem_pct', 'REAL'],
      ['temp_c', 'REAL'],
      ['power_w', 'REAL'],
      ['clock_sm_mhz', 'REAL'],
      ['clock_mem_mhz', 'REAL'],
      ['pstate', 'TEXT'],
      ['fan_pct', 'REAL'],
      ['pcie_gen', 'INTEGER'],
      ['pcie_width', 'INTEGER'],
      ['enc_util_pct', 'REAL'],
      ['dec_util_pct', 'REAL'],
      ['throttle_mask', 'INTEGER'],
      ['throttle_any', 'INTEGER'],
    ],
  },
  {
    name: 'host_sample',
    columns: [
      ['ts', 'INTEGER NOT NULL'],
      ['node_id', 'TEXT NOT NULL'],
      ['cpu_pct', 'REAL'],
      ['mem_used_mib', 'REAL'],
      ['mem_total_mib', 'REAL'],
      ['mem_used_pct', 'REAL'],
      ['swap_used_mib', 'REAL'],
      ['swap_total_mib', 'REAL'],
      ['load1', 'REAL'],
      ['load5', 'REAL'],
      ['load15', 'REAL'],
      ['disk_json', 'TEXT'],
      ['net_rx_bps', 'REAL'],
      ['net_tx_bps', 'REAL'],
      ['uptime_sec', 'INTEGER'],
    ],
  },
  {
    name: 'gpu_process',
    columns: [
      ['ts', 'INTEGER NOT NULL'],
      ['node_id', 'TEXT NOT NULL'],
      ['uuid', 'TEXT'],
      ['gpu_index', 'INTEGER'],
      ['pid', 'INTEGER'],
      ['name', 'TEXT'],
      ['used_mem_mib', 'REAL'],
      ['service', 'TEXT'],
      ['user_name', 'TEXT'],
    ],
  },
  {
    // 服务维度的汇总：一行 = 某个服务在某个采样点的合计占用
    name: 'service_sample',
    columns: [
      ['ts', 'INTEGER NOT NULL'],
      ['node_id', 'TEXT NOT NULL'],
      ['service', 'TEXT'],
      ['mem_mib', 'REAL'],
      ['processes', 'INTEGER'],
    ],
  },
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS gpu_sample_ts_idx ON gpu_sample (ts)',
  'CREATE INDEX IF NOT EXISTS gpu_sample_uuid_ts_idx ON gpu_sample (uuid, ts)',
  'CREATE INDEX IF NOT EXISTS host_sample_ts_idx ON host_sample (ts)',
  'CREATE INDEX IF NOT EXISTS gpu_process_ts_idx ON gpu_process (ts)',
  'CREATE INDEX IF NOT EXISTS service_sample_ts_idx ON service_sample (ts)',
];

const columnsOf = (table) => TABLES.find((item) => item.name === table).columns.map(([name]) => name);
const GPU_COLUMNS = columnsOf('gpu_sample');
const HOST_COLUMNS = columnsOf('host_sample');
const PROCESS_COLUMNS = columnsOf('gpu_process');
const SERVICE_COLUMNS = columnsOf('service_sample');

/**
 * 建表 + 补列迁移。
 * 老库缺哪些列就 ALTER TABLE 补上，已有数据不动——这样升级不用重建库。
 * 注意 SQLite 的 ADD COLUMN 不接受 NOT NULL（除非常量默认值），所以只补可空列。
 */
function ensureSchema(db) {
  for (const table of TABLES) {
    const definition = table.columns.map(([name, type]) => `${name} ${type}`).join(', ');
    db.exec(`CREATE TABLE IF NOT EXISTS ${table.name} (${definition})`);
  }
  for (const table of TABLES) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table.name})`).all().map((row) => row.name));
    for (const [name, type] of table.columns) {
      if (existing.has(name) || type.includes('NOT NULL')) continue;
      db.exec(`ALTER TABLE ${table.name} ADD COLUMN ${name} ${type}`);
    }
  }
  for (const sql of INDEXES) db.exec(sql);
}

function pragmaValue(db, name) {
  try {
    const row = db.prepare(`PRAGMA ${name}`).get();
    return row ? Number(Object.values(row)[0]) : null;
  } catch {
    return null;
  }
}

/**
 * 从文件头读 auto_vacuum 的真实值。
 * 当前连接里的 `PRAGMA auto_vacuum` 只是连接缓存，可能并没有落进文件头
 * （老库、或在 WAL 等语句之后才设置时就是这样），所以这里单开一个只读连接来确认。
 */
function readHeaderAutoVacuum(DatabaseSync, file) {
  if (file === ':memory:') return null;
  let probe = null;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
    return pragmaValue(probe, 'auto_vacuum');
  } catch {
    return null;
  } finally {
    try {
      probe?.close();
    } catch {
      // 探测连接关不掉也无所谓
    }
  }
}

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
  // 新建库时开启增量回收：删掉的历史数据会把空闲页还给文件系统，
  // 代价远低于整库 VACUUM（清理策略每小时都会删行，长期看差别很明显）
  incrementalVacuum = true,
  // 启动时做一次整库重写，把老库（auto_vacuum 未开启）转成增量回收模式
  reclaimOnStart = false,
  now = Date.now,
  maxPoints = 2000,
} = {}) {
  // 动态 import：Node 22.13 以下用不了 node:sqlite（22.5-22.12 还要加 --experimental-sqlite），
  // 这里失败由上层退回纯内存模式
  const { DatabaseSync } = await import('node:sqlite');

  const inMemory = file === ':memory:';
  if (!inMemory) {
    await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new DatabaseSync(file);

  // auto_vacuum 必须抢在其它任何语句之前设置。
  // journal_mode=WAL 之类会先分配头页，之后这个 pragma 就再也写不进文件头了
  // （SQLite 只允许在空库上改），于是 incremental_vacuum 会一直静默空转。
  if (incrementalVacuum) {
    try {
      db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    } catch {
      // 设置失败不影响正确性，只是以后要靠 --reclaim 手动回收
    }
  }
  if (!inMemory) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // WAL 不可用（比如放在某些网络盘上）不影响正确性，只是并发写会差一点
    }
  }
  db.exec('PRAGMA synchronous = NORMAL');
  ensureSchema(db);

  // 以文件头里的值为准，而不是当前连接缓存的值：连接里读到的可能是我们刚设的，
  // 但没真正落盘（老库就是这样），据此决定后面走增量回收还是整库重写
  let autoVacuumMode = readHeaderAutoVacuum(DatabaseSync, file) ?? pragmaValue(db, 'auto_vacuum') ?? 0;

  const insertGpu = db.prepare(insertSql('gpu_sample', GPU_COLUMNS));
  const insertHost = db.prepare(insertSql('host_sample', HOST_COLUMNS));
  const insertProcess = db.prepare(insertSql('gpu_process', PROCESS_COLUMNS));
  const insertService = db.prepare(insertSql('service_sample', SERVICE_COLUMNS));

  const buffer = { gpu: [], host: [], process: [], service: [] };
  const counters = { gpu: 0, host: 0, process: 0, service: 0 };
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
  let lastMaintainAt = null;
  let lastMaintain = null;
  let closed = false;

  function flush() {
    const count = buffer.gpu.length + buffer.host.length + buffer.process.length + buffer.service.length;
    if (count === 0) return 0;
    db.exec('BEGIN');
    try {
      for (const row of buffer.gpu) insertGpu.run(...rowValues(GPU_COLUMNS, row));
      for (const row of buffer.host) insertHost.run(...rowValues(HOST_COLUMNS, row));
      for (const row of buffer.process) insertProcess.run(...rowValues(PROCESS_COLUMNS, row));
      for (const row of buffer.service) insertService.run(...rowValues(SERVICE_COLUMNS, row));
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
    counters.service += buffer.service.length;
    buffer.gpu = [];
    buffer.host = [];
    buffer.process = [];
    buffer.service = [];
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
    // 服务维度的汇总每个采样点都写（一行一个服务），这样长窗口的持续判定能查到
    for (const row of serviceRows(nodeId, sample.t, sample.services)) buffer.service.push(row);

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

    if (buffer.gpu.length + buffer.host.length + buffer.process.length + buffer.service.length >= flushRows) return flush();
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
      for (const table of ['gpu_sample', 'host_sample', 'gpu_process', 'service_sample']) {
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
    if (dropped > 0) maintain();
    return dropped;
  }

  /**
   * 库维护：
   * 1) 截断 WAL —— 长期只写不 checkpoint 的话，-wal 文件会一直挂在那里；
   * 2) 增量回收空闲页 —— 删掉的历史不会自动把空间还给文件系统；
   * 3) reclaim=true 时把老库转成增量回收模式，这需要整库重写一次（VACUUM），
   *    代价大，所以只在显式要求时做。
   */
  function maintain({ reclaim = false } = {}) {
    const result = { checkpointed: false, incremental: false, reclaimed: false, autoVacuum: autoVacuumMode, error: null };
    try {
      if (autoVacuumMode === 2) {
        // 先回收再 checkpoint：反过来的话，文件真正缩小要等下一次 checkpoint 才发生
        db.exec('PRAGMA incremental_vacuum');
        result.incremental = true;
      } else if (reclaim && !inMemory) {
        db.exec('PRAGMA auto_vacuum = INCREMENTAL');
        db.exec('VACUUM');
        autoVacuumMode = 2;
        result.autoVacuum = 2;
        result.reclaimed = true;
      }
    } catch (error) {
      result.error = error?.message || String(error);
    }
    try {
      // 截断 WAL：长期只写不 checkpoint 的话，-wal 文件会一直挂在那里
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      result.checkpointed = true;
    } catch {
      // 内存库没有 WAL，这里失败是正常的
    }
    lastMaintainAt = now();
    lastMaintain = result;
    boundsCachedAt = 0;
    sizeCachedAt = 0;
    reclaimCachedAt = 0;
    return result;
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

  // 空闲页（可回收空间）+ WAL 体积，和 bounds 一起缓存 10 秒
  let reclaimCachedAt = 0;
  let reclaimCache = { freelistBytes: 0, walBytes: 0 };

  function reclaimInfo() {
    if (reclaimCachedAt && now() - reclaimCachedAt < 10000) return reclaimCache;
    const pageSizeBytes = pragmaValue(db, 'page_size') ?? 4096;
    const freelist = pragmaValue(db, 'freelist_count') ?? 0;
    let walBytes = 0;
    if (!inMemory) {
      try {
        walBytes = statSync(`${file}-wal`).size;
      } catch {
        walBytes = 0;
      }
    }
    reclaimCache = { freelistBytes: freelist * pageSizeBytes, walBytes };
    reclaimCachedAt = now();
    return reclaimCache;
  }

  /**
   * 有界行数探测：最多数 maxPoints + 1 行就够判断要不要分桶了，
   * 不在这里做全表 COUNT(*)，大库上会慢。
   */
  function probeRows(from, to, cap) {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT 1 FROM gpu_sample WHERE ts >= ? AND ts <= ? LIMIT ?
      )
    `).get(from, to, cap);
    return Number(row?.n ?? 0);
  }

  /**
   * 步长推导：既尊重调用方给的 step，也保证返回点数不至于失控。
   *
   * 关键在于按"真实行数"而不是"配置的落库间隔"来估：刚建库、服务只跑了几分钟、
   * 或者采集断断续续时，用配置间隔估算会把行数严重高估，7 天的区间会被压成一两个点。
   */
  function resolveStep(from, to, stepMs) {
    const span = Math.max(1, to - from);
    const cadence = Math.max(1, storeIntervalMs);
    let step = Number(stepMs) > 0 ? Math.ceil(Number(stepMs)) : 0;
    if (step > 0) return Math.max(step, Math.ceil(span / maxPoints));

    const rows = probeRows(from, to, maxPoints + 1);
    if (rows <= maxPoints) return 0; // 行数本来就不多，直接给原始粒度

    // 行数超了才分桶：让每个桶装 perBucket 行左右，把总点数压到 maxPoints 附近
    const perBucket = Math.ceil(rows / maxPoints);
    const idealBucketMs = (perBucket * span) / rows;
    return Math.max(cadence, Math.ceil(idealBucketMs / cadence) * cadence);
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
                   MAX(temp_c) AS temp_c, AVG(power_w) AS power_w,
                   AVG(clock_sm_mhz) AS clock_sm_mhz, AVG(clock_mem_mhz) AS clock_mem_mhz,
                   MAX(fan_pct) AS fan_pct,
                   MAX(pcie_gen) AS pcie_gen, MAX(pcie_width) AS pcie_width,
                   AVG(enc_util_pct) AS enc_util_pct, AVG(dec_util_pct) AS dec_util_pct,
                   MAX(throttle_any) AS throttle_any
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
                 util_gpu_pct, util_mem_pct, temp_c, power_w,
                 clock_sm_mhz, clock_mem_mhz, pstate, fan_pct,
                 pcie_gen, pcie_width, enc_util_pct, dec_util_pct,
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

  /** 服务维度的行：一个桶里取平均占用、进程数取峰值 */
  function queryServiceRows(from, to, step, limit) {
    if (step > 0) {
      return db.prepare(`
        SELECT CAST(ts / ? AS INTEGER) * ? AS bucket, service,
               AVG(mem_mib) AS mem_mib, MAX(processes) AS processes
        FROM service_sample
        WHERE ts >= ? AND ts <= ?
        GROUP BY bucket, service
        ORDER BY bucket ASC
        LIMIT ?
      `).all(step, step, from, to, limit).map((row) => ({ ...row, ts: row.bucket }));
    }
    return db.prepare(`
      SELECT ts, service, mem_mib, processes
      FROM service_sample
      WHERE ts >= ? AND ts <= ?
      ORDER BY ts ASC
      LIMIT ?
    `).all(from, to, limit);
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

    // 服务维度：占比要按"当时的整机显存总量"算，所以放在 gpus 归拢完之后再补
    const serviceRowsByTs = new Map();
    for (const row of queryServiceRows(from, to, step, cap * 16)) {
      if (!serviceRowsByTs.has(row.ts)) serviceRowsByTs.set(row.ts, []);
      serviceRowsByTs.get(row.ts).push(row);
    }
    for (const [ts, rows] of serviceRowsByTs) {
      if (!buckets.has(ts)) {
        if (buckets.size >= cap) continue;
        buckets.set(ts, { t: ts, gpus: [], system: null });
      }
      const sample = buckets.get(ts);
      sample.services = rows
        .map((row) => ({
          service: row.service,
          memMiB: row.mem_mib,
          sharePct: serviceSharePct(row.mem_mib, sample.gpus),
          processes: row.processes,
        }))
        .sort((a, b) => (b.memMiB || 0) - (a.memMiB || 0));
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
      SELECT ts, uuid, gpu_index, pid, name, used_mem_mib, service, user_name
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
      service: row.service,
      user: row.user_name,
    }));
  }

  /** 区间内的进程事件总数：表格只展示最近若干条，但要能告诉用户一共有多少 */
  function countProcesses({ from, to } = {}) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM gpu_process WHERE ts >= ? AND ts <= ?').get(from, to);
    return Number(row?.n ?? 0);
  }

  /** 不碰库的那部分状态字段：关库之后也照样给得出来 */
  function baseStats() {
    return {
      mode: 'sqlite',
      supportsHistory: true,
      path: inMemory ? null : path.resolve(file),
      autoVacuum: autoVacuumMode,
      lastMaintainAt,
      lastMaintain,
      storeIntervalMs,
      processRefreshMs,
      retentionDays,
      storeProcesses,
    };
  }

  function stats() {
    // 进程退出时仍可能有在途的请求或推送回调来取状态。关库之后再碰 db 会抛
    // ERR_INVALID_STATE，把一次正常重启变成崩溃退出（线上真实发生过），
    // 所以关库后一律用固定值回答，只保留关库前最后一次的计数与边界。
    if (closed) {
      return {
        ...baseStats(),
        sizeBytes: fileSize(),
        walBytes: 0,
        freelistBytes: 0,
        buffered: 0,
        written: { ...counters },
        oldestTs: boundsCache.oldestTs ?? null,
        newestTs: boundsCache.newestTs ?? null,
        lastFlushAt,
        lastPruneAt,
        lastPruneDropped,
        closed: true,
      };
    }
    const { oldestTs, newestTs } = bounds();
    const { freelistBytes, walBytes } = reclaimInfo();
    return {
      ...baseStats(),
      sizeBytes: fileSize(),
      walBytes,
      freelistBytes,
      // 服务行也算缓冲里的一份：漏掉它会让"还有多少行没落盘"少报
      buffered: buffer.gpu.length + buffer.host.length + buffer.process.length + buffer.service.length,
      written: { ...counters },
      oldestTs,
      newestTs,
      lastFlushAt,
      lastPruneAt,
      lastPruneDropped,
      closed: false,
    };
  }

  if (retentionDays > 0) prune();
  if (reclaimOnStart) maintain({ reclaim: true });
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
    maintain,
    querySamples,
    queryProcesses,
    countProcesses,
    gpuPages,
    hostPages,
    resolveStep,
    stats,
    close() {
      if (closed) return;
      clearInterval(flushTimer);
      clearInterval(pruneTimer);
      try {
        flush();
      } catch {
        // 收尾落盘失败也要继续关库：退出流程不能被它打断
      }
      // 先把计数与边界落下来，再置 closed——否则关库后取状态只剩固定值可用
      try {
        bounds();
      } catch {
        // 库已经读不动了就只能用旧缓存，不影响退出
      }
      closed = true;
      try {
        db.close();
      } catch {
        // 已经关掉了就算了
      }
    },
  };
}
