// 「各卡当前占用」里两处"要不要单独占一行"的判定。
//
// 抽出来是为了能直接单测（纯计算，不碰 DOM）——这两个判定决定了卡片的高度，
// 而卡片高度又决定了 8 张卡要不要滚两三屏。
//
// 背景：硬件健康（ECC / 行重映射 / XID）与节流状态本来各占一行，单看很清爽；
// 但导航模式下 8 张卡平铺，就是 8 行「ECC 无错误」+ 8 行「无节流」，两整行
// 全在说"一切正常"。所以正常时把「无节流」并进健康行尾，只有真降频才单独成行。
//
// 文案走 i18n 的 t()（i18n/index.js 不碰 DOM，本模块依然是纯计算、可直接单测）。

import { t } from './i18n/index.js';

// 节流原因的文案 key 与告警级别（gpuIdle 只是"显卡空闲"，不是故障）
const THROTTLE_KEYS = {
  swPowerCap: { key: 'gpu.throttle.swPowerCap', tone: 'warning' },
  hwSlowdown: { key: 'gpu.throttle.hwSlowdown', tone: 'danger' },
  hwThermal: { key: 'gpu.throttle.hwThermal', tone: 'danger' },
  hwPowerBrake: { key: 'gpu.throttle.hwPowerBrake', tone: 'danger' },
  swThermal: { key: 'gpu.throttle.swThermal', tone: 'warning' },
  gpuIdle: { key: 'gpu.throttle.gpuIdle', tone: null },
};

// 看到这几个编号就该按"这张卡要处理了"来对待；其余编号也值得看见，但不必同等紧张
export const XID_FATAL = new Set([48, 64, 79, 95, 119, 120, 140]);

/**
 * 驱动的节流字段 → 「状态是否已知 + 真在降频的原因」。
 *
 * known=false 表示这组字段压根没读到（老驱动 / 消费卡），页面上要写"节流状态未知"；
 * known=true 且 reasons 为空才是"确实没在降频"。
 *
 * @returns {{ known: boolean, reasons: Array<{ text: string, tone: string|null }> }}
 */
export function throttleParts(gpu) {
  if (!gpu?.throttle) return { known: false, reasons: [] };
  const reasons = Object.entries(gpu.throttle)
    .filter(([, value]) => value === true)
    .map(([key]) => {
      const entry = THROTTLE_KEYS[key];
      // 驱动冒出新字段时，原文照显比藏起来强（老驱动 / 新卡都会遇到）
      return entry ? { text: t(entry.key), tone: entry.tone } : { text: key, tone: 'warning' };
    });
  return { known: true, reasons };
}

/**
 * 每张卡的「运行指标」那一行要写什么。
 *
 * 导航模式（紧凑版）下换成短标签：8 张卡平铺时这一行会折成两行，而"每张卡多一行"
 * 摊到 8 张卡就是多一屏。短标签把「GPU 利用率」缩成「利用率」这种写法，完整说法
 * 放进 title——鼠标一停还是看得到原文。单页模式保持全称不变。
 *
 * @param {object} gpu
 * @param {{ dense?: boolean, fmtPct?: (v: number|null, digits?: number) => string }} [options]
 * @returns {Array<{ key: string, text: string|null, title?: string }>} text 为 null 表示这项没有数据，调用方应整项隐藏
 */
export function gpuFootItems(gpu, { dense = false, fmtPct = (v, digits = 0) => (v == null ? '--' : `${v.toFixed(digits)}%`) } = {}) {
  const items = [];

  items.push(dense
    ? { key: 'util', text: t('gpu.foot.util.dense', { pct: fmtPct(gpu.utilGpuPct, 0) }), title: t('gpu.foot.util.title') }
    : { key: 'util', text: t('gpu.foot.util.full', { pct: fmtPct(gpu.utilGpuPct, 0) }) });

  items.push(dense
    ? { key: 'mem-util', text: t('gpu.foot.memUtil.dense', { pct: fmtPct(gpu.utilMemPct, 0) }), title: t('gpu.foot.memUtil.title') }
    : { key: 'mem-util', text: t('gpu.foot.memUtil.full', { pct: fmtPct(gpu.utilMemPct, 0) }) });

  items.push(gpu.tempC == null
    ? { key: 'temp', text: t('gpu.foot.temp.none') }
    : { key: 'temp', text: t('gpu.foot.temp.value', { temp: Math.round(gpu.tempC) }), title: dense ? t('gpu.foot.temp.title') : undefined });

  if (gpu.powerW == null) {
    items.push({ key: 'power', text: t('gpu.foot.power.none') });
  } else if (gpu.powerLimitW == null) {
    items.push({ key: 'power', text: t('gpu.foot.power.value', { watts: Math.round(gpu.powerW) }) });
  } else {
    // 紧凑版把两次单位合并成 `239/700 W`，省下的宽度正好够这一行不折行
    items.push(dense
      ? {
        key: 'power',
        text: t('gpu.foot.power.dense', { used: Math.round(gpu.powerW), limit: Math.round(gpu.powerLimitW) }),
        title: t('gpu.foot.power.title'),
      }
      : {
        key: 'power',
        text: t('gpu.foot.power.full', { used: Math.round(gpu.powerW), limit: Math.round(gpu.powerLimitW) }),
      });
  }

  items.push(gpu.clockSmMHz == null
    ? { key: 'clock', text: null }
    : {
      key: 'clock',
      // 紧凑版省掉 "SM"（这张卡只有 SM 时钟这一个时钟指标），保留单位
      text: dense
        ? t('gpu.foot.clock.dense', { mhz: Math.round(gpu.clockSmMHz) })
        : t('gpu.foot.clock.full', { mhz: Math.round(gpu.clockSmMHz) }),
      title: dense ? t('gpu.foot.clock.title') : undefined,
    });

  // P-State 是 NVIDIA 的固定叫法（P0/P2/P8），两种语言都原样写
  items.push({ key: 'pstate', text: gpu.pstate ? (dense ? gpu.pstate : `P-State ${gpu.pstate}`) : null, title: dense && gpu.pstate ? 'P-State' : undefined });

  items.push(gpu.fanPct == null
    ? { key: 'fan', text: null }
    : { key: 'fan', text: t('gpu.foot.fan', { pct: Math.round(gpu.fanPct) }) });

  const hasEncdec = gpu.encUtilPct != null || gpu.decUtilPct != null;
  const enc = fmtPct(gpu.encUtilPct, 0);
  const dec = fmtPct(gpu.decUtilPct, 0);
  items.push({
    key: 'encdec',
    text: hasEncdec
      ? (dense ? t('gpu.foot.encdec.dense', { enc, dec }) : t('gpu.foot.encdec.full', { enc, dec }))
      : null,
    title: hasEncdec && dense ? t('gpu.foot.encdec.title') : undefined,
  });

  return items;
}

/**
 * 硬件健康那一行要写什么（显存纠错 ECC + 行重映射 + XID）。
 *
 * 关键不是"有没有错"，而是"有没有在涨"：aggregate 是终身累计、volatile 是本次驱动
 * 加载以来，所以两个都写出来，并单独标出本次的新增。不可纠正错误意味着已经在丢数据，
 * 用最重的配色。
 *
 * 行重映射只在"有情况"时补上去（待生效 / 已重映射过 / 重映射失败），
 * 健康时不留字，免得这一行变成没人看的长句。
 *
 * @param {object} gpu
 * @param {{ relativeText?: (ts: number) => string }} [options] XID 要写"最近 N 分钟前"
 * @returns {{ visible: boolean, parts: string[], tone: string }}
 */
export function healthParts(gpu, { relativeText = () => t('time.justNow') } = {}) {
  const ce = gpu.eccCorrectedAggregate;
  const ue = gpu.eccUncorrectedAggregate;
  const eccKnown = !(gpu.eccMode == null && ce == null && ue == null);
  const remap = gpu.remap || null;
  const remapKnown = Boolean(remap && (remap.correctable != null || remap.uncorrectable != null
    || remap.pending != null || remap.failure != null || remap.banksMax != null));
  const xidKnown = Boolean(gpu.xid && gpu.xid.count > 0);
  // 三样都拿不到（老驱动 / 消费卡）时整行隐藏，不显示一排 "--"。
  // XID 也算数：万一 ECC 那几个字段没读到但内核日志里有错，那是必须看见的
  if (!eccKnown && !remapKnown && !xidKnown) return { visible: false, parts: [], tone: '' };

  const ceV = gpu.eccCorrectedVolatile;
  const ueV = gpu.eccUncorrectedVolatile;
  const since = (volatileValue, total) => (
    volatileValue > 0 && volatileValue !== total ? t('gpu.ecc.sinceLoad', { count: volatileValue }) : ''
  );
  const parts = [];
  let tone = '';

  if (eccKnown) {
    if (gpu.eccMode && gpu.eccMode !== 'Enabled') {
      parts.push(t('gpu.ecc.disabled', { mode: gpu.eccMode }));
    } else if (!(ce > 0) && !(ue > 0)) {
      // 全 0 本身就是有用的信息：以后任何一个非 0 都是"从干净状态开始的变化"
      parts.push(t('gpu.ecc.clean'));
    } else {
      const ecc = [];
      if (ue > 0) {
        ecc.push(t('gpu.ecc.uncorrected', { count: ue, since: since(ueV, ue) }));
        tone = 'danger';
      }
      if (ce > 0) {
        ecc.push(t('gpu.ecc.corrected', { count: ce, since: since(ceV, ce) }));
        if (!tone) tone = 'warning';
      }
      // ECC 是两种语言里都一样的缩写，不占一条文案
      parts.push(`ECC ${ecc.join(' · ')}`);
    }
  }

  if (remapKnown) {
    const remapped = (remap.correctable ?? 0) + (remap.uncorrectable ?? 0);
    if (remap.failure === true) {
      // 备用行都不够用了，这是换卡依据
      parts.push(t('gpu.remap.failed'));
      tone = 'danger';
    } else if (remap.pending === true) {
      parts.push(t('gpu.remap.pending'));
      if (tone !== 'danger') tone = 'warning';
    } else if (remapped > 0) {
      parts.push(t('gpu.remap.done', { rows: remapped }));
      if (!tone) tone = 'warning';
    }
  }

  if (xidKnown) {
    const when = gpu.xid.lastAt ? t('gpu.xid.when', { rel: relativeText(gpu.xid.lastAt) }) : '';
    const code = gpu.xid.lastCode == null ? t('gpu.xid.unknownCode') : `XID ${gpu.xid.lastCode}`;
    parts.push(t('gpu.xid.summary', { code, count: gpu.xid.count, when }));
    if (XID_FATAL.has(gpu.xid.lastCode)) tone = 'danger';
    else if (tone !== 'danger') tone = 'warning';
  }

  return { visible: true, parts, tone };
}
