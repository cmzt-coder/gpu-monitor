// 顶部那枚状态胶囊要显示什么。
//
// 单独放一个模块是为了能直接单测——这里的判定全是可以出错的边界：
//   · 数据陈旧（采集没报错，但好几个周期没有新样本）要和"采集失败"分开
//   · 空闲降频是"故意放慢"，不能被当成陈旧
//   · 推送掉线退回轮询是降级，但"服务端本来就用 --no-push 关掉了推送"是正常模式
//
// 文案走 i18n 的 t()。i18n/index.js 本身不碰 DOM，所以这个模块依然是纯计算、
// 依然能被 Node 直接 import 单测；要验英文输出就在测试里 setLang('en-US')。

import { t } from './i18n/index.js';

const TEXT_KEYS = {
  live: 'status.live',
  ok: 'status.live',
  loading: 'status.loading',
  starting: 'status.starting',
  empty: 'status.empty',
  error: 'status.error',
  unreachable: 'status.unreachable',
};

/**
 * @param {object} input
 * @param {string} input.status              采集状态（/api/state 的 status）
 * @param {number|null} [input.lastSampleAt] 最近一次采到样本的时间戳
 * @param {number} [input.now]
 * @param {number} [input.intervalMs]        配置的采集间隔
 * @param {number} [input.storeIntervalMs]   历史库的落库间隔（0 = 没有历史库）
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
  storeIntervalMs = 0,
  idle = null,
  // 默认当"推送正常"：调用方忘了传时不该凭空报一个降级提示
  pushActive = true,
  pushEnabled = true,
  pushDownCount = 0,
  relative = (ts) => String(ts),
} = {}) {
  const broken = status === 'error' || status === 'unreachable';
  const base = t(TEXT_KEYS[status] || 'status.loading');
  const tone = (status === 'live' || status === 'ok') ? 'live'
    : (status === 'loading' || status === 'starting') ? 'loading'
      : status === 'empty' ? 'empty' : 'error';

  // 陈旧判定的阈值跟着**当前生效**的采集间隔走：空闲降频到 10 秒时，
  // 不能 3 秒没样本就说陈旧——那是故意放慢，不是卡住。
  //
  // 另外两条下限也别省：
  //   · 落库间隔 + 5 秒：页面刚打开时，手上的"最新样本"来自历史库回填，而库里每
  //     storeIntervalMs 才落一行，所以最新点天然就可能是几秒前的。没有这条，
  //     A 台（1 秒采集 / 5 秒落库）刚开页那两秒会显示"数据停留在 10 秒前"，纯属误伤。
  //   · 15 秒：给网络往返和时钟抖动留的余量，同时 15 秒没有新样本依然是个真信号。
  const effectiveInterval = idle?.active ? (idle.currentIntervalMs || intervalMs) : intervalMs;
  const staleThreshold = Math.max(
    3 * effectiveInterval + 2000,
    storeIntervalMs > 0 ? storeIntervalMs + 5000 : 0,
    15000,
  );
  const ageMs = lastSampleAt == null ? null : now - lastSampleAt;
  const stale = !broken && tone === 'live' && ageMs != null && ageMs > staleThreshold;

  // 推送"该在却真的掉了"才算降级：
  //   · 服务端用 --no-push 关掉推送时，轮询本来就是正常模式；
  //   · 页面刚打开、SSE 还没握上手的那一刻也不算（pushDownCount 还是 0）。
  const fellBack = !broken && !stale && tone === 'live'
    && !pushActive && pushEnabled !== false && pushDownCount > 0;

  if (broken) {
    return {
      tone: 'error',
      text: lastSampleAt ? t('status.staleSuffix', { base, rel: relative(lastSampleAt) }) : base,
      stale: false,
      fellBack: false,
    };
  }
  if (stale) {
    return {
      tone: 'stale',
      text: t('status.staleSuffix', { base, rel: relative(lastSampleAt) }),
      stale: true,
      fellBack: false,
    };
  }
  if (fellBack) {
    return { tone: 'poll', text: t('status.poll'), stale: false, fellBack: true };
  }
  if (tone === 'live' && idle?.active) {
    const seconds = Math.round((idle.currentIntervalMs || 0) / 1000);
    return { tone: 'live', text: t('status.idle', { seconds }), stale: false, fellBack: false };
  }
  return { tone, text: base, stale: false, fellBack: false };
}
