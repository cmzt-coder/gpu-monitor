// 曲线图的鼠标悬停：把鼠标位置换算成采样点索引，再把那个点上的各系列值整理成
// 浮窗要显示的行。
//
// 单独放一个模块是为了能直接单测——它纯计算、不碰 DOM，而边界情况恰恰最容易出错：
// 鼠标在绘图区外、窗口还没攒满点（左边那段是空的）、某个系列在那个点没有数据（断档）。

/**
 * 鼠标位置 → 采样点索引。
 *
 * 曲线是等间隔的：第 i 个点画在 `padLeft + plotW * (1 - (count-1-i)/(slots-1))`，
 * 也就是最新的点贴在右边缘，越旧越靠左；窗口没攒满时数据只占右边一段。
 *
 * @param {object} input
 * @param {number} input.x        鼠标在 canvas 内的横坐标（CSS 像素）
 * @param {number} input.width    canvas 的 CSS 宽度
 * @param {number} input.count    这条曲线实际有多少个点
 * @param {number} input.slots    窗口槽位数（= 满窗时会有多少个点）
 * @param {number} [input.padLeft]  与绘制时的左侧留白一致
 * @param {number} [input.padRight] 与绘制时的右侧留白一致（刻度文字占的那段）
 * @returns {number|null} 落在数据范围内就返回索引，否则 null（绘图区外、或那一带还没数据）
 */
export function hoverIndexFromX({ x, width, count, slots, padLeft = 6, padRight = 44 }) {
  if (!Number.isFinite(x) || !Number.isFinite(width)) return null;
  if (!count || count < 1) return null;
  const plotW = Math.max(10, width - padLeft - padRight);
  if (x < padLeft || x > padLeft + plotW) return null;
  const span = Math.max(2, slots) - 1;
  const fromRight = (1 - (x - padLeft) / plotW) * span;
  const index = (count - 1) - Math.round(fromRight);
  if (index < 0 || index > count - 1) return null;
  return index;
}

/**
 * 浮窗内容：那一行时间 + 每个系列一行「名字 值」。
 *
 * 值取不到时给「无数据」而不是 0——历史区间里断档（服务重启、机器重启那段）
 * 就是这种形状，曲线本身在那里是断开的，浮窗也该如实说。
 *
 * @param {object} input
 * @param {Array<{label?: string, name?: string, color?: string, values: Array<number|null>}>} input.seriesList
 * @param {Array<number>} [input.times]        与各系列同长度的时间轴
 * @param {number|null} input.index
 * @param {(ts: number) => string} [input.timeLabel]
 * @param {(value: number|null) => string} [input.valueLabel] 兜底格式化；系列自己带 format 时优先用它
 * @returns {{ time: string, rows: Array<{ label: string, value: string, color: string }> } | null}
 */
export function hoverRows({
  seriesList = [],
  times = [],
  index = null,
  timeLabel = (ts) => new Date(ts).toLocaleTimeString(),
  valueLabel = (value) => (value == null ? '无数据' : String(value)),
} = {}) {
  if (index == null || index < 0) return null;
  const rows = seriesList.map((line) => {
    const value = line.values ? line.values[index] : null;
    // 取不到值就一律写「无数据」；每个系列可以带自己的格式化（显存用 %、服务用 GB…），没带就用兜底的
    const format = typeof line.format === 'function' ? line.format : valueLabel;
    return {
      label: line.label || line.name || '',
      color: line.color || 'currentColor',
      value: value == null ? '无数据' : format(value),
    };
  });
  const ts = times[index];
  return {
    time: ts == null ? '无数据' : timeLabel(ts),
    rows,
  };
}
