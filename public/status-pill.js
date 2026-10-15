// 顶部那枚状态胶囊要显示什么。
//
// 单独放一个模块是为了能直接单测——这里的判定全是可以出错的边界：
//   · 数据陈旧（采集没报错，但好几个周期没有新样本）要和"采集失败"分开
//   · 空闲降频是"故意放慢"，不能被当成陈旧
//   · 推送掉线退回轮询是降级，但"服务端本来就用 --no-push 关掉了推送"是正常模式

const TEXT = {
  live: '实时采集中',
  ok: '实时采集中',
  loading: '连接中',
  starting: '服务启动中',
  empty: '未检测到 GPU',
  error: '采集失败',
  unreachable: '连接中断',
};

/**
 * @param {object} input
 * @param {string} input.status              采集状态（/api/state 的 status）
 * @param {number|null} [input.lastSampleAt] 最近一次采到样本的时间戳
 * @param {number} [input.now]
 * @param {number} [input.intervalMs]        配置的采集间隔
 * @param {{active:boolean, currentIntervalMs:number}|null} [input.idle]
 * @param {boolean} [input.pushActive]       SSE 当前连着吗
 * @param {boolean} [input.pushEnabled]      服务端是否允许推送（--no-push 时为 false）
 * @param {number} [input.pushDownCount]     推送连续失败的次数（用于区分"刚打开还没连上"与"真的掉了"）
 * @param {(ts:number)=>string} [input.relative] 相对时间格式化（"3 分钟前"）
 * @returns {{ tone: string, text: string, stale: boolean, fellBack: boolean }}
 */
export function statusView({
  status,
  lastSampleAt = null,
  now = Date.now(),
  intervalMs = 1000,
  idle = null,
  // 默认当"推送正常"：调用方忘了传时不该凭空报一个降级提示
  pushActive = true,
  pushEnabled = true,
  pushDownCount = 0,
  relative = (ts) => String(ts),
} = {}) {
  const broken = status === 'error' || status === 'unreachable';
  const base = TEXT[status] || '连接中';
  const tone = (status === 'live' || status === 'ok') ? 'live'
    : (status === 'loading' || status === 'starting') ? 'loading'
      : status === 'empty' ? 'empty' : 'error';

  // 陈旧判定的阈值跟着**当前生效**的采集间隔走：空闲降频到 10 秒时，
  // 不能 3 秒没样本就说陈旧——那是故意放慢，不是卡住。
  const effectiveInterval = idle?.active ? (idle.currentIntervalMs || intervalMs) : intervalMs;
  const ageMs = lastSampleAt == null ? null : now - lastSampleAt;
  const stale = !broken && tone === 'live' && ageMs != null && ageMs > effectiveInterval * 3 + 2000;

  // 推送"该在却真的掉了"才算降级：
  //   · 服务端用 --no-push 关掉推送时，轮询本来就是正常模式；
  //   · 页面刚打开、SSE 还没握上手的那一刻也不算（pushDownCount 还是 0）。
  const fellBack = !broken && !stale && tone === 'live'
    && !pushActive && pushEnabled !== false && pushDownCount > 0;

  if (broken) {
    return {
      tone: 'error',
      text: lastSampleAt ? `${base} · 数据停留在 ${relative(lastSampleAt)}` : base,
      stale: false,
      fellBack: false,
    };
  }
  if (stale) {
    return { tone: 'stale', text: `${base} · 数据停留在 ${relative(lastSampleAt)}`, stale: true, fellBack: false };
  }
  if (fellBack) {
    return { tone: 'poll', text: '已退回轮询（推送未连接）', stale: false, fellBack: true };
  }
  if (tone === 'live' && idle?.active) {
    const seconds = Math.round((idle.currentIntervalMs || 0) / 1000);
    return { tone: 'live', text: `空闲降频中（每 ${seconds} 秒）`, stale: false, fellBack: false };
  }
  return { tone, text: base, stale: false, fellBack: false };
}
