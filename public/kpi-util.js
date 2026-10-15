// 「平均 GPU 利用率」卡片的展示口径。
//
// 单独放一个模块是为了能直接单测——它纯计算，不碰 DOM。
//
// 两种口径：
//   · 跨时间（主口径）：服务端把历史库里近 1 小时的采样点整体平均好送过来，
//     所以这个数是"近 1 小时的平均"，不是"这一帧的平均"（8 卡 × 5 秒落库 ≈ 5760 个点）
//   · 跨卡瞬间（降级）：没有历史库时只能拿当前这一帧的卡求平均，此时必须在脚注里说明
//
// 服务刚部署、库里还没攒满一小时时，用的是真数据但覆盖面不足，
// 脚注要如实说"实为最近 N 分钟"，不能让人误以为是完整一小时。
//
// 文案走 i18n 的 t()（i18n/index.js 不碰 DOM，本模块依然是纯计算、可直接单测）。

import { t, tn } from './i18n/index.js';

/** 一小时，跨时间口径的固定窗口 */
export const UTIL_WINDOW_MS = 3600000;

/** 库里最早一条采样点距今不足一小时时，算出"实际只覆盖了 N 分钟" */
function describeCoverage({ oldestTs, windowMs, now, intervalMs }) {
  // 采样点之间本身有间隔，差一个间隔左右就算覆盖满窗口了，不必抠那几秒
  const slack = Math.max(120000, intervalMs * 3);
  const coveredMs = Math.max(0, now - oldestTs);
  if (coveredMs >= windowMs - slack) return null;
  return Math.max(1, Math.round(coveredMs / 60000));
}

/**
 * 算出平均利用率卡片要显示的数值、脚注与悬停说明。
 *
 * 脚注给两份：`foot` 是完整说法（单页模式、悬停提示用），`footShort` 是导航模式
 * 紧凑顶栏里那一行的短说法——顶栏要横着排五个 KPI，脚注只能占几个字，
 * 但"其实只覆盖了 20 分钟"这类口径说明不能省，短说也得说。
 *
 * @param {object} input
 * @param {number|null} input.avgUtilNow 这一帧的跨卡平均（降级口径）
 * @param {object|null} input.crossTime  服务端给的跨时间均值 `{ avg, samples, cards, oldestTs, newestTs, windowMs }`
 * @param {number} input.cardCount       这一帧有利用率的卡数
 * @param {number} input.now             当前时间（算覆盖时长用）
 * @param {number} input.intervalMs      采集间隔
 * @returns {{ value: number|null, foot: string, footShort: string, title: string }}
 */
export function utilKpiView({
  avgUtilNow = null,
  crossTime = null,
  cardCount = 0,
  now = Date.now(),
  intervalMs = 1000,
} = {}) {
  const crossAvg = Number.isFinite(crossTime?.avg) ? crossTime.avg : null;
  const value = crossAvg ?? (Number.isFinite(avgUtilNow) ? avgUtilNow : null);
  if (value == null) {
    const waiting = t('kpi.waiting');
    return { value: null, foot: waiting, footShort: waiting, title: '' };
  }

  // 降级：服务端没有历史库（Node 太旧 / --no-db），只能给这一帧的跨卡平均
  if (!crossTime) {
    if (!cardCount) {
      const waiting = t('kpi.waiting');
      return { value: null, foot: waiting, footShort: waiting, title: '' };
    }
    return {
      value,
      foot: t('kpi.util.foot.noStore', { cards: cardCount }),
      footShort: t('kpi.util.footShort.noStore'),
      title: t('kpi.util.title.noStore'),
    };
  }

  // 有历史库但近 1 小时一条都没落（刚启动）：数字先跟着这一帧走，口径如实标注
  if (!crossTime.samples) {
    return {
      value,
      foot: t('kpi.util.foot.noHistory'),
      footShort: t('kpi.util.footShort.noHistory'),
      title: t('kpi.util.title.noHistory'),
    };
  }

  const windowMs = crossTime.windowMs || UTIL_WINDOW_MS;
  const cards = crossTime.cards || cardCount;
  const shortMinutes = crossTime.oldestTs ? describeCoverage({
    oldestTs: crossTime.oldestTs, windowMs, now, intervalMs,
  }) : null;
  const title = t('kpi.util.title.avg', { samples: crossTime.samples });
  return {
    value,
    foot: shortMinutes
      ? t('kpi.util.foot.partial', { minutes: shortMinutes })
      : t('kpi.util.foot.full', { gpus: tn('common.gpuCount', cards) }),
    footShort: shortMinutes
      ? t('kpi.util.footShort.partial', { minutes: shortMinutes })
      : t('kpi.util.footShort.full'),
    title,
  };
}
