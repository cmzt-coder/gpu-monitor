// 服务健康检查：给外部探针、systemd watchdog 或编排系统一个稳定的判断依据。
//
// 判定原则：只看"服务本身还能不能干活"——采集是否新鲜、历史库是否可写、磁盘是否够用。
// 业务层面的告警（显存高、温度高、某个进程占了卡）只作为信息回报，
// 不让整个服务因此变成不健康：那些是"机器有事"，不是"监控坏了"。
import { statfsSync } from 'node:fs';

function defaultFreeSpace(dir) {
  try {
    const stat = statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

function gib(bytes) {
  if (bytes == null) return '--';
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(0)} MiB`;
  return `${(bytes / 1073741824).toFixed(2)} GiB`;
}

export function evaluateHealth({
  state = {},
  storage = null,
  alerts = null,
  inference = null,
  version = null,
  probePath = null,
  now = Date.now,
  freeSpace = defaultFreeSpace,
  // 默认阈值：磁盘剩不到 1 GiB 提醒，剩不到 100 MiB 判为不健康
  diskWarnBytes = 1024 ** 3,
  diskFailBytes = 100 * 1024 ** 2,
} = {}) {
  const checks = [];

  /* ---------- 采集新鲜度 ---------- */
  const intervalMs = state.intervalMs || 1000;
  // 空闲降频期间采集本来就更慢，阈值要跟着放宽，否则每次空闲都会误报
  const effectiveIntervalMs = state.idle?.active ? (state.idle.currentIntervalMs || intervalMs) : intervalMs;
  const staleAfterMs = Math.max(effectiveIntervalMs * 3, 10000);
  const ageMs = state.lastSampleAt ? now() - state.lastSampleAt : null;

  if (state.status !== 'ok') {
    checks.push({
      name: 'collector',
      level: 'fail',
      detail: state.error ? `采集异常：${state.error}` : `采集状态为 ${state.status || '未知'}`,
      hint: state.hint || null,
    });
  } else if (ageMs == null) {
    checks.push({ name: 'collector', level: 'fail', detail: '还没有采集到任何数据' });
  } else if (ageMs > staleAfterMs) {
    checks.push({
      name: 'collector',
      level: 'fail',
      detail: `最近一次采集在 ${(ageMs / 1000).toFixed(0)} 秒前，超过 ${(staleAfterMs / 1000).toFixed(0)} 秒阈值`,
    });
  } else {
    checks.push({
      name: 'collector',
      level: 'ok',
      detail: `最近一次采集 ${(ageMs / 1000).toFixed(1)} 秒前，${state.gpus?.length ?? 0} 张卡，${state.processes?.length ?? 0} 个占用进程`,
    });
  }

  /* ---------- 历史库 ---------- */
  if (!storage || storage.mode === 'memory' || storage.mode === 'disabled') {
    checks.push({
      name: 'storage',
      level: 'ok',
      detail: storage?.reason ? `未启用历史库（${storage.reason}）` : '未启用历史库',
    });
  } else if (state.storeWarning) {
    checks.push({ name: 'storage', level: 'fail', detail: state.storeWarning });
  } else {
    const buffered = storage.buffered ?? 0;
    const lastFlushAge = storage.lastFlushAt ? now() - storage.lastFlushAt : null;
    const stuck = buffered > 0 && lastFlushAge != null && lastFlushAge > 30000;
    checks.push({
      name: 'storage',
      level: stuck ? 'warn' : 'ok',
      detail: [
        storage.path || '内存',
        `文件 ${gib(storage.sizeBytes)}`,
        lastFlushAge == null ? '尚未落盘' : `最近落盘 ${(lastFlushAge / 1000).toFixed(1)} 秒前`,
        buffered > 0 ? `缓冲区 ${buffered} 行` : null,
        stuck ? '（写入似乎卡住了）' : null,
      ].filter(Boolean).join(' · '),
    });
  }

  /* ---------- 磁盘 ---------- */
  // 没有落库的时候不需要盯磁盘：占用是内存里的
  if (probePath && storage && storage.mode !== 'memory' && storage.mode !== 'disabled') {
    const free = freeSpace(probePath);
    if (free == null) {
      checks.push({ name: 'disk', level: 'warn', detail: `无法读取 ${probePath} 的剩余空间` });
    } else if (free < diskFailBytes) {
      checks.push({ name: 'disk', level: 'fail', detail: `${probePath} 剩余空间仅 ${gib(free)}，历史库随时可能写失败` });
    } else if (free < diskWarnBytes) {
      checks.push({ name: 'disk', level: 'warn', detail: `${probePath} 剩余空间 ${gib(free)}，建议清理` });
    } else {
      checks.push({ name: 'disk', level: 'ok', detail: `${probePath} 剩余空间 ${gib(free)}` });
    }
  }

  /* ---------- 告警（只做信息回报） ---------- */
  if (!alerts || alerts.enabled === false) {
    checks.push({ name: 'alerts', level: 'ok', detail: '未启用告警' });
  } else {
    const firing = alerts.firing?.length ?? 0;
    checks.push({
      name: 'alerts',
      level: alerts.lastError ? 'warn' : 'ok',
      detail: [
        `${alerts.ruleCount} 条规则`,
        firing > 0 ? `当前 ${firing} 条触发中` : '当前无告警',
        alerts.notifiedCount ? `累计通知 ${alerts.notifiedCount} 次` : null,
        alerts.lastError || null,
      ].filter(Boolean).join(' · '),
    });
  }

  /* ---------- 推理服务 ---------- */
  // 这里只判"推理服务整体是不是全挂了"：
  // 单个实例抖动交给告警规则，不能因为它把监控服务本身判成不健康。
  // 没有配置推理监控时不追加这一项，健康检查的返回结构和以前保持一致
  if (inference && inference.enabled !== false && !inference.loaded && inference.error) {
    checks.push({
      name: 'inference',
      level: 'warn',
      detail: `推理监控配置有问题：${inference.error}`,
    });
  } else if (inference && inference.enabled !== false && inference.loaded) {
    const summary = inference.summary || { total: 0, up: 0, down: 0, degraded: 0, unknown: 0 };
    const parts = [
      `${summary.up}/${summary.total} 可用`,
      summary.degraded ? `${summary.degraded} 个降级` : null,
      summary.unknown ? `${summary.unknown} 个待采集` : null,
      inference.error || null,
    ].filter(Boolean);
    const level = summary.total > 0 && summary.down === summary.total
      ? 'fail'
      : (summary.down > 0 || summary.degraded > 0 || inference.error ? 'warn' : 'ok');
    checks.push({ name: 'inference', level, detail: parts.join(' · ') });
  }

  const failed = checks.filter((check) => check.level === 'fail');
  const warned = checks.filter((check) => check.level === 'warn');
  const status = failed.length > 0 ? 'unhealthy' : (warned.length > 0 ? 'degraded' : 'healthy');

  return {
    ok: failed.length === 0,
    status,
    statusCode: failed.length > 0 ? 503 : 200,
    checkedAt: now(),
    uptimeSec: state.uptimeSec ?? null,
    hostname: state.hostname ?? null,
    // 顺便告诉探针"现在是空闲降频还是真的在工作"，方便区分"采集中断"和"没人看"
    idle: state.idle
      ? { active: Boolean(state.idle.active), currentIntervalMs: state.idle.currentIntervalMs ?? null }
      : null,
    version,
    checks,
  };
}
