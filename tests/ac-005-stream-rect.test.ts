// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { TextView, LINE_HEIGHT } from '../src/text-view/view';

function fixture() {
  const view = new TextView(document.createElement('div'), 'large.log', {
    onStatus: () => {}, onScrollPersist: () => {}, onBookmarksChange: () => {}, restoreScroll: 0,
  });
  const inner = view as unknown as {
    scroller: HTMLDivElement; bar: HTMLDivElement; charW: number; totalLines: number; lines: Map<number, string>;
    render: () => void; onMouseDown: (e: MouseEvent) => void; onKey: (e: KeyboardEvent) => void;
  };
  inner.scroller = document.createElement('div');
  inner.bar = document.createElement('div');
  inner.charW = 10;
  inner.totalLines = 10000;
  inner.lines = new Map([[1, 'abcdef'], [2, 'xy'], [3, '123456']]);
  inner.render = vi.fn(); // jsdom 无布局：仅隔离绘制，指针/视觉列/复制仍走真实链路
  const mouse = (type: string, line: number, col: number, altKey = true) => new MouseEvent(type, {
    clientX: 62 + col * 10 + 2, clientY: (line - 1) * LINE_HEIGHT + 2, button: 0, altKey,
  });
  const drag = () => {
    inner.onMouseDown(mouse('mousedown', 1, 1));
    document.dispatchEvent(mouse('mousemove', 3, 5));
    document.dispatchEvent(mouse('mouseup', 3, 5));
  };
  return { view, inner, mouse, drag };
}

describe('AC-10 流式矩形链路', () => {
  it('AC-23 越视口 rAF 滚动续选，松开停止并上报尺寸', () => {
    const { view, inner, mouse } = fixture();
    vi.spyOn(inner.scroller, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 100, left: 0 } as DOMRect);
    let tick: FrameRequestCallback | undefined;
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(fn => { tick = fn; return 9; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    inner.onMouseDown(mouse('mousedown', 1, 1));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 130 }));
    const before = inner.scroller.scrollTop;
    expect(before).toBeGreaterThan(0);
    expect(request).toHaveBeenCalled();
    tick?.(0);
    expect(inner.scroller.scrollTop).toBeGreaterThan(before);
    expect(view.rectSize?.lines).toBeGreaterThan(1);
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(cancel).toHaveBeenCalledWith(9);
    request.mockRestore();
    cancel.mockRestore();
  });
  it('含右端点的五列复制补空格，虚拟滚动不改变行数', async () => {
    const { view, inner, drag } = fixture();
    drag();
    expect(view.hasRectSelection()).toBe(true);
    expect(await view.rectCopyText()).toBe('bcdef\ny    \n23456');
    inner.scroller.scrollTop = 900 * LINE_HEIGHT;
    expect((await view.rectCopyText())?.split('\n')).toHaveLength(3);
  });
  it('普通左键和 Escape 均清除，Alt 单击不留退化矩形', () => {
    const { view, inner, mouse, drag } = fixture();
    drag();
    inner.onMouseDown(mouse('mousedown', 1, 0, false));
    expect(view.hasRectSelection()).toBe(false);
    drag();
    inner.onKey(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(view.hasRectSelection()).toBe(false);
    inner.onMouseDown(mouse('mousedown', 1, 2));
    document.dispatchEvent(mouse('mouseup', 1, 2));
    expect(view.hasRectSelection()).toBe(false);
  });
});
