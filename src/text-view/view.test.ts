// text-view 纯逻辑单测：可视行区间计算（虚拟滚动核心）
// 公式：from = clamp(floor(scrollTop/LINE_HEIGHT) - 20 + 1)；visible = ceil(h/LINE_HEIGHT) + 40；to = min(total, from+visible-1)
// LINE_HEIGHT = 19.2（定稿 12px × 1.6）：h=600 → 可见 ceil(31.25)=32，含 overscan 共 72 行
import { describe, expect, it } from 'vitest';
import { LINE_HEIGHT, visibleRange } from './view';

describe('visibleRange', () => {
  it('顶部：from=1，to=可见行数+两侧 overscan', () => {
    expect(visibleRange(0, 600, 10000)).toEqual({ from: 1, to: 72 }); // 32 可见 + 40 overscan
  });

  it('中部：随滚动平移', () => {
    expect(visibleRange(LINE_HEIGHT * 100, 600, 10000)).toEqual({ from: 81, to: 152 });
  });

  it('尾部：to 钳制到总行数', () => {
    const r = visibleRange(LINE_HEIGHT * 99999, 600, 10000);
    expect(r.to).toBe(10000);
    expect(r.from).toBeLessThanOrEqual(r.to);
  });

  it('总行数很少时整段可见且不越界', () => {
    expect(visibleRange(0, 600, 5)).toEqual({ from: 1, to: 5 });
  });
});
