// 采样点重采样：把粒度不均匀的历史数据铺成"等间隔网格"。
//
// 为什么需要它：实时曲线的横轴是按**索引**均分铺开的，前提是每个点的时间间隔相同。
// 而历史库是按落库间隔抽稀过的（可能 5-6 秒一行，还可能因为服务重启断档），
// 直接把它混进实时序列里，旧的那段横向会被压缩、看着像被挤扁。
//
// 单独放一个模块是为了能直接单测——它纯计算，不碰 DOM。

/**
 * 把 samples 重采样到 [from, to] 上、间隔为 intervalMs 的网格。
 *
 * - 每格取"该时刻之前最近的那个真实采样点"（前向填充），值原样带过来
 * - 断档超过 gapFactor 个间隔就**留空**：不拉一条假直线，
 *   让曲线如实断开——服务重启那 20 秒就该显示成断口，而不是假装一直有数据
 * - 网格右端不超过最后一个真实采样点，绝不凭空造数据
 */
export function resampleToGrid(samples, { from, to, intervalMs, gapFactor = 3 } = {}) {
  const sorted = [...(samples || [])]
    .filter((sample) => sample && Number.isFinite(sample.t))
    .sort((a, b) => a.t - b.t);
  if (sorted.length === 0 || !(intervalMs > 0) || !Number.isFinite(from) || !Number.isFinite(to)) {
    return [];
  }

  const end = Math.min(to, sorted[sorted.length - 1].t);
  const gapMs = intervalMs * gapFactor;
  const out = [];
  let cursor = 0;

  for (let t = from; t <= end; t += intervalMs) {
    // 游标只往前走：网格是递增的，没必要每格都从头找
    while (cursor + 1 < sorted.length && sorted[cursor + 1].t <= t) cursor += 1;
    const source = sorted[cursor];
    if (!source || source.t > t) continue;      // 这个时刻之前还没有数据
    if (t - source.t > gapMs) continue;         // 断档：留空
    out.push({ ...source, t });
  }
  return out;
}
