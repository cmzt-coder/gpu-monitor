// 「各卡当前占用」里两处"要不要单独占一行"的判定。
//
// 抽出来是为了能直接单测（纯计算，不碰 DOM）——这两个判定决定了卡片的高度，
// 而卡片高度又决定了 8 张卡要不要滚两三屏。
//
// 背景：硬件健康（ECC / 行重映射 / XID）与节流状态本来各占一行，单看很清爽；
// 但导航模式下 8 张卡平铺，就是 8 行「ECC 无错误」+ 8 行「无节流」，两整行
// 全在说"一切正常"。所以正常时把「无节流」并进健康行尾，只有真降频才单独成行。

// 节流原因的中文名与告警级别（gpuIdle 只是"显卡空闲"，不是故障）
export const THROTTLE_LABELS = {
  swPowerCap: { text: '功耗墙', tone: 'warning' },
  hwSlowdown: { text: '硬件降速', tone: 'danger' },
  hwThermal: { text: '温度墙', tone: 'danger' },
  hwPowerBrake: { text: '功耗刹车', tone: 'danger' },
  swThermal: { text: '软件温度墙', tone: 'warning' },
  gpuIdle: { text: '空闲', tone: null },
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
    .map(([key]) => THROTTLE_LABELS[key] || { text: key, tone: 'warning' });
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
    ? { key: 'util', text: `利用率 ${fmtPct(gpu.utilGpuPct, 0)}`, title: 'GPU 利用率' }
    : { key: 'util', text: `GPU 利用率 ${fmtPct(gpu.utilGpuPct, 0)}` });

  items.push(dense
    ? { key: 'mem-util', text: `带宽 ${fmtPct(gpu.utilMemPct, 0)}`, title: '显存带宽占用' }
    : { key: 'mem-util', text: `显存带宽占用 ${fmtPct(gpu.utilMemPct, 0)}` });

  items.push(gpu.tempC == null
    ? { key: 'temp', text: '温度 --' }
    : { key: 'temp', text: `温度 ${Math.round(gpu.tempC)}°C`, title: dense ? 'GPU 温度' : undefined });

  if (gpu.powerW == null) {
    items.push({ key: 'power', text: '功耗 --' });
  } else if (gpu.powerLimitW == null) {
    items.push({ key: 'power', text: `功耗 ${Math.round(gpu.powerW)} W` });
  } else {
    // 紧凑版把两次单位合并成 `239/700 W`，省下的宽度正好够这一行不折行
    items.push(dense
      ? { key: 'power', text: `功耗 ${Math.round(gpu.powerW)}/${Math.round(gpu.powerLimitW)} W`, title: '功耗（当前 / 上限）' }
      : { key: 'power', text: `功耗 ${Math.round(gpu.powerW)} W / ${Math.round(gpu.powerLimitW)} W` });
  }

  items.push(gpu.clockSmMHz == null
    ? { key: 'clock', text: null }
    : {
      key: 'clock',
      // 紧凑版省掉 "SM"（这张卡只有 SM 时钟这一个时钟指标），保留单位
      text: `${dense ? '时钟' : 'SM 时钟'} ${Math.round(gpu.clockSmMHz)} MHz`,
      title: dense ? 'SM 时钟（MHz）' : undefined,
    });

  items.push({ key: 'pstate', text: gpu.pstate ? (dense ? gpu.pstate : `P-State ${gpu.pstate}`) : null, title: dense && gpu.pstate ? 'P-State' : undefined });

  items.push(gpu.fanPct == null
    ? { key: 'fan', text: null }
    : { key: 'fan', text: `风扇 ${Math.round(gpu.fanPct)}%` });

  const hasEncdec = gpu.encUtilPct != null || gpu.decUtilPct != null;
  const enc = fmtPct(gpu.encUtilPct, 0);
  const dec = fmtPct(gpu.decUtilPct, 0);
  items.push({
    key: 'encdec',
    text: hasEncdec ? (dense ? `编解码 ${enc}/${dec}` : `编解码 ${enc} / ${dec}`) : null,
    title: hasEncdec && dense ? '编码 / 解码占用' : undefined,
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
export function healthParts(gpu, { relativeText = () => '刚刚' } = {}) {
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
    volatileValue > 0 && volatileValue !== total ? `（本次 ${volatileValue}）` : ''
  );
  const parts = [];
  let tone = '';

  if (eccKnown) {
    if (gpu.eccMode && gpu.eccMode !== 'Enabled') {
      parts.push(`ECC 已关闭（${gpu.eccMode}）`);
    } else if (!(ce > 0) && !(ue > 0)) {
      // 全 0 本身就是有用的信息：以后任何一个非 0 都是"从干净状态开始的变化"
      parts.push('ECC 无错误');
    } else {
      const ecc = [];
      if (ue > 0) {
        ecc.push(`不可纠正 ${ue}${since(ueV, ue)}`);
        tone = 'danger';
      }
      if (ce > 0) {
        ecc.push(`可纠正 ${ce}${since(ceV, ce)}`);
        if (!tone) tone = 'warning';
      }
      parts.push(`ECC ${ecc.join(' · ')}`);
    }
  }

  if (remapKnown) {
    const remapped = (remap.correctable ?? 0) + (remap.uncorrectable ?? 0);
    if (remap.failure === true) {
      // 备用行都不够用了，这是换卡依据
      parts.push('行重映射失败');
      tone = 'danger';
    } else if (remap.pending === true) {
      parts.push('有行重映射待生效（下次 GPU 复位时应用）');
      if (tone !== 'danger') tone = 'warning';
    } else if (remapped > 0) {
      parts.push(`已重映射 ${remapped} 行`);
      if (!tone) tone = 'warning';
    }
  }

  if (xidKnown) {
    const when = gpu.xid.lastAt ? `，最近 ${relativeText(gpu.xid.lastAt)}` : '';
    const code = gpu.xid.lastCode == null ? '未知编号' : `XID ${gpu.xid.lastCode}`;
    parts.push(`${code}（累计 ${gpu.xid.count} 次${when}）`);
    if (XID_FATAL.has(gpu.xid.lastCode)) tone = 'danger';
    else if (tone !== 'danger') tone = 'warning';
  }

  return { visible: true, parts, tone };
}
