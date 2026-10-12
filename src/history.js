// 内存环形缓冲：保存最近 N 个采样点，用于页面初次打开时回填曲线（不是历史归档）
export class History {
  constructor(maxSamples) {
    this.maxSamples = Math.max(2, Math.floor(maxSamples));
    this.items = [];
    this.seq = 0;
  }

  push(sample) {
    this.seq += 1;
    this.items.push(sample);
    if (this.items.length > this.maxSamples) {
      this.items.splice(0, this.items.length - this.maxSamples);
    }
    return this.seq;
  }

  snapshot(limit) {
    if (!limit || limit >= this.items.length) return this.items.slice();
    return this.items.slice(this.items.length - limit);
  }

  get size() {
    return this.items.length;
  }
}
