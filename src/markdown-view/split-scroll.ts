import type { ScrollSurfaceAdapter } from '../common/scroll-surface';

type Side = 'left' | 'right';
/** 分屏逐帧同步：真实输入接管方向，程序回声按目标位置识别，不使用时间锁。 */
export class SplitScrollCoordinator {
  private owner: Side = 'left';
  private frame = 0;
  private dead = false;
  private expected: Partial<Record<Side, number>> = {};
  constructor(private surfaceAt: (side: Side) => ScrollSurfaceAdapter | null) {}
  claim(side: Side): void { this.owner = side; delete this.expected[side]; }
  scrolled(side: Side): void {
    const surface = this.surfaceAt(side); if (!surface || this.dead) return;
    const expected = this.expected[side];
    if (expected !== undefined && Math.abs(surface.snapshot().top - expected) <= 1) return;
    if (side === this.owner) this.refresh();
  }
  refresh(): void {
    if (this.frame || this.dead) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const side = this.owner, other = side === 'left' ? 'right' : 'left';
      const source = this.surfaceAt(side), target = this.surfaceAt(other);
      if (!source || !target || this.dead) return;
      const layout = source.snapshot();
      if (layout.top <= 0) target.scrollTo(0);
      else if (layout.height > layout.viewport && layout.top >= layout.height - layout.viewport - 1) target.scrollTo(target.snapshot().height);
      else {
        const anchor = source.capture();
        target.restore({ line: anchor.line, surface: anchor.surface });
      }
      this.expected[other] = target.snapshot().top;
    });
  }
  destroy(): void { this.dead = true; cancelAnimationFrame(this.frame); }
}
