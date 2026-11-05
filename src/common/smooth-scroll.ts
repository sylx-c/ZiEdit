/** 自绘轨道翻页：只缓动明确的目标跳转，滚轮/拖动仍由调用方即时写入。 */
export class RailScrollAnimator {
  private frame = 0;
  private target = 0;
  private started = 0;
  private from = 0;
  private lastWritten = 0;

  constructor(
    private readonly scrollTo: (y: number) => void,
    private readonly readPosition?: () => number,
  ) {}

  page(delta: number, current: number): void {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { this.cancel(); this.scrollTo(current + delta); return; }
    // 滚轮/拖动等外部即时写入优先：不能把下一帧动画写到用户刚让出的旧位置上。
    if (this.frame && Math.abs(current - this.lastWritten) > 0.5) this.cancel();
    this.from = current;
    this.target = current + delta;
    this.started = performance.now();
    if (this.frame) return;
    const tick = (now: number): void => {
      if (this.readPosition && Math.abs(this.readPosition() - this.lastWritten) > 0.5) {
        this.frame = 0;
        return;
      }
      const t = Math.max(0, Math.min(1, (now - this.started) / 160));
      const eased = 1 - (1 - t) ** 3;
      const y = this.from + (this.target - this.from) * eased;
      this.lastWritten = y;
      this.scrollTo(y);
      this.frame = t < 1 ? requestAnimationFrame(tick) : 0;
    };
    this.frame = requestAnimationFrame(tick);
    // 首帧可能携带帧开始时刻（早于 mousedown）：先在事件时刻建立真实起点，外部写入才能被识别。
    this.lastWritten = current;
  }

  cancel(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}
