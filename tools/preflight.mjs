#!/usr/bin/env node
// 部署前自检：一条命令把"这台机器能不能跑、能跑成什么样"体检一遍。
//
// 设计成只读为主：不会建库、不会写文件、不会占用端口超过一瞬间。
// 唯一会"改动"的动作是临时绑定一次端口来判断是否被占用，绑完立刻释放。
//
// 用法：
//   node tools/preflight.mjs
//   node tools/preflight.mjs --port 8090 --db /opt/gpu-monitor/data/gpu-monitor.db
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadAlertsConfig } from '../src/alerts/config.js';
import { normalizeRules } from '../src/alerts/rules.js';
import { readGpuSnapshot, resolveGpuFields } from '../src/nvidia.js';
import { detectPlatform, resolveNvidiaSmi } from '../src/platform.js';
import { createSystemCollector } from '../src/system.js';

export const ICONS = { ok: '✅', warn: '⚠️', bad: '❌', skip: '➖' };

// 一条 GPU 行（含索引）的经验占用，用来估算库体积；实际以数据库文件大小为准
const BYTES_PER_ROW = 110;
// 落库抽稀的默认粒度，与 server.js 的 --store-interval 保持一致
const DEFAULT_STORE_INTERVAL_MS = 5000;

function mib(bytes) {
  if (bytes == null) return '--';
  return `${(bytes / 1048576).toFixed(bytes >= 1073741824 ? 0 : 1)} MiB`;
}

/** 已经是 MiB 单位的数值（内存、磁盘容量），不要再除一次 */
function fmtMiB(value) {
  if (value == null) return '--';
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GiB` : `${Math.round(value)} MiB`;
}

function gib(bytes) {
  if (bytes == null) return '--';
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function pragmaValue(db, name) {
  try {
    const row = db.prepare(`PRAGMA ${name}`).get();
    return row ? Object.values(row)[0] : null;
  } catch {
    return null;
  }
}

/** 只读地看一眼现有历史库：不建库、不加表、不改配置 */
async function inspectDatabase(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const pageSize = pragmaValue(db, 'page_size') || 4096;
    const freelist = pragmaValue(db, 'freelist_count') || 0;
    const autoVacuum = pragmaValue(db, 'auto_vacuum');
    let bounds = null;
    let gpuRows = 0;
    try {
      bounds = db.prepare('SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM gpu_sample').get();
      // 有界计数：大库上不做全表 COUNT(*)
      gpuRows = db.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM gpu_sample LIMIT 1000001)').get()?.n ?? 0;
    } catch {
      // 表还没建起来（空文件或别的 SQLite 文件）
    }
    return {
      pageSize,
      autoVacuum,
      freelistBytes: freelist * pageSize,
      oldestTs: bounds?.min_ts ?? null,
      newestTs: bounds?.max_ts ?? null,
      gpuRows,
      rowCountCapped: gpuRows > 1000000,
    };
  } finally {
    db.close();
  }
}

/** 试着占一下端口：能绑上就说明空闲。绑完立刻释放，不留副作用 */
function checkPort(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const done = (result) => {
      server.removeAllListeners();
      try {
        server.close();
      } catch {
        // 还没监听就 close 会抛，忽略
      }
      resolve(result);
    };
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') return done({ status: 'busy' });
      // 沙箱/受限环境会直接禁止监听，这既不是"被占用"也不是"可启动"
      if (error.code === 'EACCES' || error.code === 'EPERM') return done({ status: 'restricted', code: error.code });
      return done({ status: 'error', message: error.message });
    });
    server.once('listening', () => done({ status: 'free' }));
    server.listen(port, host);
  });
}

function sleep(ms) {
  // 这里不能 unref：自检脚本没有别的句柄撑着事件循环，unref 掉会让进程在等待中直接退出
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPreflight({
  port = 8090,
  host = '0.0.0.0',
  dbPath = path.join('data', 'gpu-monitor.db'),
  alertsPath = 'alerts.json',
  gpuBin = null,
  storeIntervalMs = DEFAULT_STORE_INTERVAL_MS,
  // 用来判断告警的 for 有没有超出内存窗口：等价于 --window / --interval
  windowSamples = 300,
  intervalMs = 1000,
  skipPortCheck = false,
  systemDelayMs = 1200,
} = {}) {
  const platform = detectPlatform();
  const sections = [];
  const blockers = [];
  const warnings = [];
  const facts = { platform: platform.id, nodeVersion: process.version };

  /* ---------- 运行环境 ---------- */
  const envLines = [];
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  envLines.push([major >= 18 ? ICONS.ok : ICONS.bad, `Node ${process.version}${major >= 18 ? '' : '（本项目要求 ≥ 18）'}`]);
  if (major < 18) blockers.push('Node 版本低于 18，无法启动服务');

  // node:sqlite 是内置模块，但 Node 22.13+ 才默认可用（22.5-22.12 需要 --experimental-sqlite）
  let sqliteAvailable = false;
  try {
    await import('node:sqlite');
    sqliteAvailable = true;
  } catch {
    sqliteAvailable = false;
  }
  facts.sqliteAvailable = sqliteAvailable;
  const sqliteReady = sqliteAvailable || major > 22 || (major === 22 && minor >= 5);
  envLines.push([
    sqliteReady ? ICONS.ok : ICONS.warn,
    sqliteReady
      ? 'node:sqlite 可用（历史库功能正常）'
      : `node:sqlite 不可用（需要 Node ≥ 22.13）→ 历史库会退回纯内存，实时监控不受影响`,
  ]);
  if (!sqliteReady) warnings.push('历史库不可用：当前 Node 版本偏低，页面会显示"未启用历史库"');
  envLines.push([ICONS.ok, `平台 ${platform.label} ${platform.arch}`]);
  sections.push({ title: '运行环境', lines: envLines });

  /* ---------- GPU ---------- */
  const gpuLines = [];
  let gpuCount = 0;
  // 显式指定了 nvidia-smi 就按"用户确认有卡"处理，不受平台判断限制（也方便在无卡机器上验证脚本本身）
  const gpuCheckable = platform.supported || Boolean(gpuBin);
  if (!gpuCheckable) {
    gpuLines.push([ICONS.skip, `跳过：${platform.note || '当前平台没有 NVIDIA 驱动'}`]);
  } else {
    const smi = await resolveNvidiaSmi({ explicit: gpuBin }).catch((error) => ({ ok: false, error: error?.message || String(error), tried: [] }));
    if (!smi.ok) {
      gpuLines.push([ICONS.bad, smi.error]);
      if (smi.hint) gpuLines.push([ICONS.skip, smi.hint]);
      for (const item of smi.tried || []) gpuLines.push([ICONS.skip, `${item.bin}（${item.result}）`]);
      blockers.push('找不到可用的 nvidia-smi，服务启动后读不到显存数据');
    } else {
      gpuCount = smi.deviceCount || 0;
      gpuLines.push([ICONS.ok, `nvidia-smi：${smi.bin}（${smi.source}）`]);
      gpuLines.push([gpuCount > 0 ? ICONS.ok : ICONS.bad, `检测到 ${gpuCount} 张显卡`]);
      if (gpuCount === 0) blockers.push('nvidia-smi 能跑但没返回显卡');

      let probe = null;
      try {
        probe = await resolveGpuFields({ bin: smi.bin, extended: true });
        facts.extendedFields = probe.fields.length;
        facts.unsupportedFields = probe.unsupported;
        gpuLines.push([
          probe.unsupported.length === 0 ? ICONS.ok : ICONS.warn,
          probe.unsupported.length === 0
            ? `扩展指标全部可用（${probe.fields.length} 项：时钟 / P-State / 风扇 / PCIe / 编解码 / 节流原因）`
            : `扩展指标可用 ${probe.fields.length} 项，驱动不支持 ${probe.unsupported.length} 项`,
        ]);
        for (const field of probe.unsupported) gpuLines.push([ICONS.skip, `不支持的字段：${field}`]);
      } catch (error) {
        gpuLines.push([ICONS.warn, `扩展指标探测失败（会退回基础字段）：${error?.message || error}`]);
        warnings.push('扩展指标探测失败，服务将以基础字段运行');
      }

      try {
        const snapshot = await readGpuSnapshot({ bin: smi.bin, fields: probe?.fields });
        facts.gpuCount = snapshot.gpus.length;
        facts.processCount = snapshot.processes.length;
        for (const gpu of snapshot.gpus.slice(0, 8)) {
          gpuLines.push([ICONS.skip, `GPU ${gpu.index}　${gpu.name}　${gpu.memTotalMiB ?? '--'} MiB`]);
        }
        if (snapshot.gpus.length > 8) gpuLines.push([ICONS.skip, `…另有 ${snapshot.gpus.length - 8} 张卡`]);
        gpuLines.push([
          snapshot.processes.length > 0 ? ICONS.ok : ICONS.warn,
          snapshot.processes.length > 0
            ? `占用进程可读（当前 ${snapshot.processes.length} 个）`
            : '当前读不到占用进程（卡空闲，或权限不足）',
        ]);
        if (snapshot.processWarning) {
          gpuLines.push([ICONS.warn, snapshot.processWarning]);
          warnings.push('进程列表读不到，建议用 root 或与业务进程相同的用户启动');
        }
      } catch (error) {
        gpuLines.push([ICONS.bad, `读取一次显卡快照失败：${error?.message || error}`]);
        blockers.push('读取显卡快照失败');
      }
    }
  }
  sections.push({ title: 'GPU', lines: gpuLines });

  /* ---------- 宿主指标 ---------- */
  const hostLines = [];
  try {
    const collector = createSystemCollector({ platform: platform.id, diskTargets: [] });
    // 采两次：CPU 与网络速率需要两个采样点之间的差值
    await collector.sample();
    await sleep(systemDelayMs);
    const sample = await collector.sample();
    facts.hostUnsupported = sample.unsupported;
    hostLines.push([ICONS.ok, `CPU ${sample.cpu?.usagePct == null ? '--' : `${sample.cpu.usagePct.toFixed(0)}%`}（${sample.cpu?.cores ?? '--'} 核）`]);
    hostLines.push([sample.mem ? ICONS.ok : ICONS.warn, sample.mem
      ? `内存 ${fmtMiB(sample.mem.usedMiB)} / ${fmtMiB(sample.mem.totalMiB)}（${sample.mem.usedPct?.toFixed(0)}%）`
      : '内存读数不可用']);
    for (const disk of sample.disk || []) {
      hostLines.push([ICONS.ok, `磁盘 ${disk.path} ${fmtMiB(disk.usedMiB)} / ${fmtMiB(disk.totalMiB)}（${disk.usedPct?.toFixed(0)}%）`]);
    }
    if (sample.net) {
      hostLines.push([ICONS.ok, `网络 ↓ ${(sample.net.rxBytesPerSec / 1048576).toFixed(1)} MiB/s　↑ ${(sample.net.txBytesPerSec / 1048576).toFixed(1)} MiB/s`]);
    }
    for (const field of sample.unsupported || []) {
      hostLines.push([ICONS.skip, `${field}：当前平台不支持`]);
    }
  } catch (error) {
    hostLines.push([ICONS.bad, `宿主指标采集异常：${error?.message || error}`]);
    warnings.push('宿主指标采集异常');
  }
  sections.push({ title: '宿主指标', lines: hostLines });

  /* ---------- 历史库 ---------- */
  const dbLines = [];
  const absoluteDb = path.resolve(dbPath);
  if (!sqliteReady) {
    dbLines.push([ICONS.skip, '跳过：node:sqlite 不可用']);
  } else {
    const dir = path.dirname(absoluteDb);
    let dirWritable = false;
    // 自检不创建目录：目录还不存在时，看最近的已存在祖先是否可写就够了
    if (fs.existsSync(dir)) {
      try {
        fs.accessSync(dir, fs.constants.W_OK);
        dirWritable = true;
      } catch (error) {
        dbLines.push([ICONS.bad, `目录不可写：${dir}（${error.code || error.message}）`]);
        blockers.push(`历史库目录不可写：${dir}`);
      }
    } else {
      let probe = dir;
      while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
      try {
        fs.accessSync(probe, fs.constants.W_OK);
        dirWritable = true;
        dbLines.push([ICONS.skip, `目录尚不存在（首次启动会自动创建）：${dir}`]);
      } catch (error) {
        dbLines.push([ICONS.bad, `无法创建历史库目录：${dir}（${error.code || error.message}）`]);
        blockers.push(`无法创建历史库目录：${dir}`);
      }
    }
    if (dirWritable) dbLines.push([ICONS.ok, `目录可写：${dir}`]);

    if (fs.existsSync(absoluteDb)) {
      const stat = fs.statSync(absoluteDb);
      const walPath = `${absoluteDb}-wal`;
      const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
      dbLines.push([ICONS.ok, `库文件 ${gib(stat.size)}${walBytes ? `（WAL ${mib(walBytes)}）` : ''}`]);
      try {
        const info = await inspectDatabase(absoluteDb);
        facts.db = info;
        if (info.oldestTs) {
          dbLines.push([ICONS.skip, `已存数据：${new Date(info.oldestTs).toLocaleString('zh-CN')} 起，约 ${info.gpuRows}${info.rowCountCapped ? '+' : ''} 行 GPU 记录`]);
        } else {
          dbLines.push([ICONS.skip, '库里还没有数据']);
        }
        const reclaim = info.freelistBytes || 0;
        if (reclaim > 16 * 1024 * 1024) {
          dbLines.push([ICONS.warn, `有约 ${mib(reclaim)} 空间可回收（删掉的历史不会自动释放）→ 跑一次 node tools/db-maintenance.mjs --reclaim`]);
          warnings.push('历史库存在可回收空间，建议跑一次 db-maintenance --reclaim');
        } else {
          dbLines.push([ICONS.ok, `可回收空间 ${mib(reclaim)}，无需处理`]);
        }
        if (info.autoVacuum === 0) {
          dbLines.push([ICONS.skip, '未开启 auto_vacuum（老库的默认状态），需要回收时用 db-maintenance --reclaim']);
        }
      } catch (error) {
        dbLines.push([ICONS.warn, `库文件读取异常：${error?.message || error}`]);
        warnings.push('历史库文件无法正常读取，可能不是本项目的库');
      }
    } else {
      dbLines.push([ICONS.skip, `库文件尚未创建（首次启动会自动建库）：${absoluteDb}`]);
    }

    // 体积预估：按当前检测到的卡数 + 默认落库粒度。
    // 保留期默认是永久，所以这里给"一年"这个基准——磁盘够不够一年，基本就够用很多年了
    const cardsForEstimate = gpuCount > 0 ? gpuCount : 1;
    const perDay = cardsForEstimate * Math.round(86400000 / storeIntervalMs);
    const perYear = perDay * 365 * BYTES_PER_ROW;
    dbLines.push([ICONS.skip, `体积预估：${gpuCount > 0 ? `${gpuCount} 张卡` : '卡数未知（按 1 张卡估）'}、每 ${storeIntervalMs / 1000} 秒落一行 → 约 ${perDay.toLocaleString('en-US')} 行/天，永久保留一年约 ${gib(perYear)}`]);
    // 库目录可能还不存在，那就用最近的已存在祖先来看剩余空间
    let spaceProbe = dir;
    while (!fs.existsSync(spaceProbe) && path.dirname(spaceProbe) !== spaceProbe) spaceProbe = path.dirname(spaceProbe);
    try {
      const stat = fs.statfsSync(spaceProbe);
      const free = stat.bavail * stat.bsize;
      facts.diskFreeBytes = free;
      dbLines.push([free > perYear ? ICONS.ok : ICONS.warn, `${spaceProbe} 剩余空间 ${gib(free)}${free > perYear ? '' : '（不足一年的预估占用，建议调大 --store-interval，或给 --retention-days 设个天数）'}`]);
      if (free <= perYear) warnings.push('磁盘剩余空间小于一年历史的预估占用');
    } catch (error) {
      dbLines.push([ICONS.skip, `剩余空间读取失败（${spaceProbe}）：${error?.message || error}`]);
    }
  }
  sections.push({ title: '历史库', lines: dbLines });

  /* ---------- 告警 ---------- */
  const alertLines = [];
  const alertsLoad = await loadAlertsConfig(alertsPath);
  facts.alerts = { path: alertsPath, missing: alertsLoad.missing, error: alertsLoad.error || null };
  if (alertsLoad.error) {
    alertLines.push([ICONS.bad, `配置文件解析失败：${alertsLoad.error}`]);
    blockers.push('告警配置无法解析，服务启动时会报错提示但不影响采集');
  } else if (alertsLoad.missing) {
    alertLines.push([ICONS.skip, `未找到 ${alertsPath}（不启用告警；需要的话 cp alerts.example.json alerts.json）`]);
  } else if (alertsLoad.disabled) {
    alertLines.push([ICONS.skip, '配置里 enabled=false，告警未启用']);
  } else {
    const { rules, problems } = normalizeRules(alertsLoad.config);
    facts.alerts.ruleCount = rules.length;
    alertLines.push([rules.length > 0 ? ICONS.ok : ICONS.warn, `规则 ${rules.length} 条`]);
    for (const problem of problems) {
      alertLines.push([ICONS.warn, `被跳过的规则：${problem}`]);
      warnings.push(`告警规则有问题：${problem}`);
    }
    const email = alertsLoad.config.email;
    if (email?.host) {
      alertLines.push([ICONS.ok, `邮件渠道：${email.host}:${email.port ?? 587}${email.secure ? '（隐式 TLS）' : email.starttls === false ? '（明文）' : '（STARTTLS）'} → ${[].concat(email.to || []).join(', ') || '未填收件人'}`]);
      if (!email.to || [].concat(email.to).length === 0) {
        alertLines.push([ICONS.bad, '邮件渠道缺少收件人（to）']);
        blockers.push('告警邮件渠道没有配置收件人');
      }
      if (email.pass && !String(email.pass).startsWith('${')) {
        alertLines.push([ICONS.warn, '密码直接写在配置文件里了（建议改成 ${ENV_VAR} 占位 + 环境变量）']);
        warnings.push('告警配置里的密码是明文，建议改用环境变量');
      } else if (email.user && !email.pass) {
        // 常见情况：配置里写了 ${SMTP_PASS}，但启动环境里没这个变量（systemd 下最容易漏）
        alertLines.push([ICONS.warn, `配了账号 ${email.user} 但密码为空：确认环境变量已 export（systemd 里要写 Environment=）`]);
        warnings.push('告警邮件账号缺密码，检查环境变量是否已提供');
      }
    } else {
      alertLines.push([ICONS.skip, '未配置邮件渠道，通知只会打到控制台日志']);
    }
    if (alertsLoad.config.webhook?.url) alertLines.push([ICONS.ok, `Webhook 渠道：${alertsLoad.config.webhook.url}`]);

    // for 超过内存窗口的规则要靠历史库判定；没有库就只能夹到窗口长度
    const memoryWindowMs = windowSamples * intervalMs;
    const longRules = rules.filter((rule) => rule.forMs > memoryWindowMs);
    if (longRules.length > 0) {
      const list = longRules.map((rule) => `${rule.id}(${Math.round(rule.forMs / 60000)}m)`).join('、');
      if (sqliteReady) {
        alertLines.push([ICONS.ok, `${longRules.length} 条长周期规则的 for 超过内存窗口（${Math.round(memoryWindowMs / 60000)} 分钟），将查历史库判定：${list}`]);
      } else {
        alertLines.push([ICONS.warn, `${longRules.length} 条长周期规则的 for 超过内存窗口，但没有历史库可用，会被夹到 ${Math.round(memoryWindowMs / 60000)} 分钟：${list}`]);
        warnings.push('有告警规则的 for 超过内存窗口，但历史库不可用；升级 Node 到 22.13+ 或调大 --window');
      }
    }
  }
  sections.push({ title: '告警', lines: alertLines });

  /* ---------- 端口 ---------- */
  const portLines = [];
  if (skipPortCheck) {
    portLines.push([ICONS.skip, '已跳过端口检查']);
  } else {
    const result = await checkPort(port, host);
    facts.port = { port, status: result.status };
    if (result.status === 'free') portLines.push([ICONS.ok, `${host}:${port} 空闲`]);
    else if (result.status === 'busy') {
      portLines.push([ICONS.bad, `${host}:${port} 已被占用`]);
      blockers.push(`端口 ${port} 被占用，用 --port 换一个`);
    } else if (result.status === 'restricted') {
      portLines.push([ICONS.skip, `${host}:${port} 无法检测（当前环境禁止监听：${result.code}），在真实服务器上应显示为空闲`]);
    } else {
      portLines.push([ICONS.warn, `${host}:${port} 检测异常：${result.message}`]);
      warnings.push('端口检测异常');
    }
  }
  sections.push({ title: '端口', lines: portLines });

  return { sections, blockers, warnings, facts };
}

function print(report, options) {
  const out = [];
  out.push('GPU 显存负载监控 · 部署前自检');
  out.push(`时间 ${new Date().toLocaleString('zh-CN')}　主机 ${os.hostname()}`);
  out.push('');
  for (const section of report.sections) {
    out.push(`【${section.title}】`);
    for (const [icon, text] of section.lines) out.push(`  ${icon} ${text}`);
    out.push('');
  }
  if (report.blockers.length > 0) {
    out.push('结论：先解决以下阻塞项再启动');
    for (const item of report.blockers) out.push(`  ${ICONS.bad} ${item}`);
  } else {
    out.push('结论：可以启动');
    if (report.warnings.length > 0) {
      out.push(`（有 ${report.warnings.length} 条提醒，不阻塞启动）`);
      for (const item of report.warnings) out.push(`  ${ICONS.warn} ${item}`);
    }
    const { port, host, dbPath } = options;
    out.push('');
    out.push('建议的启动命令：');
    out.push(`  node server.js --port ${port} --db ${dbPath}`);
    out.push('  先验证指标、暂不落库：node server.js --port ' + port + ' --no-db --no-alerts');
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

// 直接执行时才打印；被 import 时只暴露 runPreflight，方便测试
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const options = {
    port: 8090,
    host: '0.0.0.0',
    dbPath: path.join('data', 'gpu-monitor.db'),
    alertsPath: 'alerts.json',
    gpuBin: null,
    skipPortCheck: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case '--port':
      case '-p':
        options.port = Number(next()) || options.port;
        break;
      case '--host':
        options.host = next() || options.host;
        break;
      case '--db':
        options.dbPath = next() || options.dbPath;
        break;
      case '--alerts':
        options.alertsPath = next() || options.alertsPath;
        break;
      case '--nvidia-smi':
        options.gpuBin = next() || options.gpuBin;
        break;
      case '--skip-port-check':
        options.skipPortCheck = true;
        break;
      case '--window':
        options.windowSamples = Math.max(30, Number(next()) || 300);
        break;
      case '--interval':
        options.intervalMs = Math.max(200, Number(next()) || 1000);
        break;
      default:
        break;
    }
  }
  const report = await runPreflight(options);
  print(report, options);
  process.exit(report.blockers.length > 0 ? 1 : 0);
}
