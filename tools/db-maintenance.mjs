#!/usr/bin/env node
// 历史库维护：看状态 / 按保留期清理 / 回收空间。
//
// 用法：
//   node tools/db-maintenance.mjs                          # 只看状态
//   node tools/db-maintenance.mjs --prune                  # 按保留期清理一次
//   node tools/db-maintenance.mjs --reclaim                # 整库重写，释放已删数据占用的空间
//   node tools/db-maintenance.mjs --prune --reclaim --retention-days 30
//
// 什么时候需要用：SQLite 删掉旧行之后不会自动把空间还给文件系统。
// 稳态运行（写入速率恒定 + 保留期固定）时，删掉的页会被新数据复用，文件大小会稳定下来；
// 但如果你调大了 --store-interval、调小了 --retention-days，或曾经用 --retention-days 0 跑过，
// 文件就会长期停在"高水位"，这时用 --reclaim 收一次即可。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createSqliteStore } from '../src/store/sqlite-store.js';

function gib(bytes) {
  if (bytes == null) return '--';
  // 小于 1 GiB 时用 MiB 显示，避免出现 "0.001 GB" 这种读不出来的数字
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MiB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function mib(bytes) {
  if (bytes == null) return '--';
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

export async function runMaintenance({ dbPath, prune = false, reclaim = false, retentionDays = 90, now = Date.now }) {
  const absolute = path.resolve(dbPath);
  if (!fs.existsSync(absolute)) {
    return { ok: false, reason: `历史库不存在：${absolute}（服务首次启动时会自动创建）` };
  }

  // node:sqlite 要 Node 22.5+：旧版本上给一句能看懂的话，而不是抛"模块不存在"的堆栈
  try {
    await import('node:sqlite');
  } catch {
    return { ok: false, reason: `历史库维护需要 Node ≥ 22.5（当前 ${process.version}），先升级 Node 再执行` };
  }

  const beforeBytes = fs.statSync(absolute).size;
  // 只带了 --prune 时才在库里启用保留期：否则不动数据
  const store = await createSqliteStore({
    file: absolute,
    nodeId: 'maintenance',
    retentionDays: prune ? retentionDays : 0,
    // 维护工具不做抽稀判断，也不会写新样本
    storeIntervalMs: 5000,
    now,
  });

  try {
    const statsBefore = store.stats();
    const result = store.maintain({ reclaim });
    const statsAfter = store.stats();
    return {
      ok: true,
      path: absolute,
      beforeBytes,
      afterBytes: fs.statSync(absolute).size,
      dropped: statsAfter.lastPruneDropped ?? 0,
      autoVacuumBefore: statsBefore.autoVacuum,
      autoVacuumAfter: statsAfter.autoVacuum,
      reclaimableBefore: statsBefore.freelistBytes,
      reclaimableAfter: statsAfter.freelistBytes,
      walBefore: statsBefore.walBytes,
      walAfter: statsAfter.walBytes,
      rows: statsAfter.written,
      oldestTs: statsAfter.oldestTs,
      newestTs: statsAfter.newestTs,
      result,
    };
  } finally {
    store.close();
  }
}

function print(report, { prune, reclaim, retentionDays }) {
  if (!report.ok) {
    process.stdout.write(`${report.reason}\n`);
    process.exit(1);
  }
  const lines = [];
  lines.push(`历史库：${report.path}`);
  if (report.oldestTs) {
    lines.push(`  数据范围：${new Date(report.oldestTs).toLocaleString('zh-CN')} ~ ${new Date(report.newestTs).toLocaleString('zh-CN')}`);
  } else {
    lines.push('  数据范围：（空库）');
  }
  lines.push(`  文件大小：${gib(report.beforeBytes)}${report.beforeBytes !== report.afterBytes ? ` → ${gib(report.afterBytes)}（回收 ${mib(report.beforeBytes - report.afterBytes)}）` : ''}`);
  lines.push(`  WAL 体积：${mib(report.walBefore)} → ${mib(report.walAfter)}${report.result.checkpointed ? '（已截断）' : ''}`);
  lines.push(`  可回收空间：${mib(report.reclaimableBefore)} → ${mib(report.reclaimableAfter)}`);
  lines.push(`  auto_vacuum：${report.autoVacuumBefore === 2 ? '增量回收（已开启）' : `未开启（${report.autoVacuumBefore}）`}${report.autoVacuumAfter === 2 && report.autoVacuumBefore !== 2 ? ' → 增量回收（已转换）' : ''}`);
  if (prune) lines.push(`  本次清理：删除 ${report.dropped} 行（保留 ${retentionDays} 天）`);
  if (report.result.incremental) lines.push('  增量回收：已执行');
  if (report.result.error) lines.push(`  维护出错：${report.result.error}`);
  lines.push('');
  if (!reclaim && report.reclaimableBefore > 16 * 1024 * 1024) {
    lines.push(`提示：有 ${mib(report.reclaimableBefore)} 空间可回收，跑一次 --reclaim 即可（会整库重写，大库需要一点时间和等量磁盘空间）。`);
  } else if (!prune && !reclaim) {
    lines.push('提示：加 --prune 按保留期清理，加 --reclaim 回收空间。');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const options = { dbPath: path.join('data', 'gpu-monitor.db'), prune: false, reclaim: false, retentionDays: 90 };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case '--db':
        options.dbPath = next() || options.dbPath;
        break;
      case '--retention-days':
        options.retentionDays = Math.max(0, Number(next()) || 0);
        break;
      case '--prune':
        options.prune = true;
        break;
      case '--reclaim':
        options.reclaim = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write('用法：node tools/db-maintenance.mjs [--db <路径>] [--prune] [--reclaim] [--retention-days <天>]\n');
        process.exit(0);
        break;
      default:
        break;
    }
  }
  const report = await runMaintenance(options);
  print(report, options);
}
