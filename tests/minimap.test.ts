// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Minimap } from '../src/text-view/minimap';

describe('minimap 极短文档', () => {
  it('画布覆盖真实轨道首尾，重采样与主题变化不增加正文布局节点', async () => {
    const ctx = { setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), roundRect: vi.fn(), fill: vi.fn(), fillRect: vi.fn(),
      globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '' };
    vi.stubGlobal('CanvasRenderingContext2D', class {});
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const parent = document.createElement('div'); document.body.append(parent);
    let version = 1;
    const map = new Minimap(parent, {
      surface: { element: parent, snapshot: () => ({ version, top: 200, height: 1000, viewport: 100 }),
        capture: () => ({ line: 1, surface: 'ir' }), restore: () => {}, scrollTo: () => {},
        overview: count => Array.from({ length: count }, () => ({ text: 'heading', kind: 'heading' })) },
      totalLines: () => 100, scrollTop: () => 0, scrollHeight: () => 1000, clientHeight: () => 100,
      scrollTo: () => {}, lineText: () => undefined,
    });
    Object.defineProperty(map.root, 'clientHeight', { value: 100 });
    Object.defineProperty(parent.querySelector('.mm-bars')!, 'clientWidth', { value: 80 });
    try {
      map.sync();
      const canvas = parent.querySelector('canvas')!;
      expect(canvas.height).toBe(61); expect(canvas.width).toBe(80);
      expect(ctx.roundRect.mock.calls[0]?.[1]).toBe(0);
      expect(ctx.roundRect.mock.calls.at(-1)?.[1]).toBe(59);
      expect(parent.querySelectorAll('.mm-bar')).toHaveLength(0);
      version++; map.sync(); expect(parent.querySelector('canvas')).toBe(canvas);
      const calls = ctx.clearRect.mock.calls.length;
      document.documentElement.style.setProperty('--accent', '#123456');
      await vi.waitFor(() => expect(ctx.clearRect.mock.calls.length).toBeGreaterThan(calls));
      expect(ctx.fillStyle).toBe('#123456');
      expect(ctx.globalAlpha).toBe(1); expect(ctx.globalCompositeOperation).toBe('source-over');
    } finally {
      map.remove(); parent.remove(); document.documentElement.style.removeProperty('--accent');
      getContext.mockRestore(); vi.unstubAllGlobals();
    }
  });

  it('排版采样变化只更新条纹绘制，封顶后不同长度仍复用相同外观', () => {
    const parent = document.createElement('div');
    let version = 1, length = 80;
    const minimap = new Minimap(parent, {
      surface: { element: parent, snapshot: () => ({ version, top: 0, height: 1000, viewport: 100 }),
        capture: () => ({ line: 1, surface: 'ir' }), restore: () => {}, scrollTo: () => {},
        overview: count => Array.from({ length: count }, () => ({ text: 'x'.repeat(length), kind: 'code' })) },
      totalLines: () => 100, scrollTop: () => 0, scrollHeight: () => 1000,
      clientHeight: () => 100, scrollTo: () => {}, lineText: () => undefined,
    });
    Object.defineProperty(minimap.root, 'clientHeight', { value: 100 });
    const observer = new MutationObserver(() => {});
    try {
      minimap.sync();
      const bar = parent.querySelector<HTMLElement>('.mm-bar')!;
      observer.observe(parent.querySelector('.mm-bars')!, { subtree: true, childList: true, attributes: true });
      length = 120; version++; minimap.sync();
      expect(parent.querySelector('.mm-bar')).toBe(bar);
      expect(bar.style.width).toBe('100%'); expect(bar.style.transform).toBe('scaleX(0.8)');
      expect(bar.classList.contains('mc')).toBe(true);
      expect(observer.takeRecords().filter(record => record.type === 'childList')).toHaveLength(0);
      length = 300; version++; minimap.sync(); observer.takeRecords();
      length = 400; version++; minimap.sync();
      expect(observer.takeRecords()).toHaveLength(0);
      expect(bar.style.transform).toBe('scaleX(1)');
    } finally { observer.disconnect(); minimap.remove(); }
  });

  it('初次建立和高度变化时，正文采样先于右轨样式与条纹写入', () => {
    const parent = document.createElement('div');
    let version = 1;
    const observer = new MutationObserver(() => {});
    const overview = vi.fn((count: number) => {
      expect(observer.takeRecords()).toHaveLength(0);
      return Array.from({ length: count }, () => ({ text: 'body', kind: 'text' }));
    });
    const minimap = new Minimap(parent, {
      surface: { element: parent, snapshot: () => ({ version, top: version * 100, height: version * 1000, viewport: 400 }),
        capture: () => ({ line: 1, surface: 'preview' }), restore: () => {}, scrollTo: () => {}, overview },
      totalLines: () => 100, scrollTop: () => 0, scrollHeight: () => 1000,
      clientHeight: () => 400, scrollTo: () => {}, lineText: () => undefined,
    });
    Object.defineProperty(minimap.root, 'clientHeight', { value: 600 });
    observer.observe(parent, { subtree: true, childList: true, attributes: true });
    try {
      minimap.sync(); observer.takeRecords();
      version++;
      minimap.sync();
      expect(overview).toHaveBeenCalledTimes(2);
    } finally { observer.disconnect(); minimap.remove(); }
  });

  it('条数收敛到实际行数（1 行 1 条），行数增长后按槽位采样，缩短后清除旧条目', () => {
    let total = 1;
    const lineText = vi.fn(() => 'plain text');
    const requestLines = vi.fn();
    const parent = document.createElement('div');
    const minimap = new Minimap(parent, {
      totalLines: () => total,
      scrollTop: () => 0,
      scrollHeight: () => 600,
      clientHeight: () => 600,
      scrollTo: () => {},
      lineText,
      requestLines,
      cacheVersion: () => 0,
    });
    Object.defineProperty(minimap.root, 'clientHeight', { value: 600 });
    try {
      // 先扣除尺子与底部留白，再按 3px 槽位采样。
      for (const [t, bars] of [[1, 1], [2, 2], [3, 3]] as Array<[number, number]>) {
        total = t;
        minimap.sync();
        expect(parent.querySelectorAll('.mm-bar')).toHaveLength(bars);
      }
      expect(lineText).toHaveBeenCalled(); // 短文档也真实采样（不再整体跳过）
      expect(requestLines).not.toHaveBeenCalled(); // 行文本已可取，无需预取

      total = 1000;
      minimap.sync();
      expect(parent.querySelectorAll('.mm-bar')).toHaveLength(Math.floor((600 - 29 - 10) / 3));

      total = 1;
      minimap.sync();
      expect(parent.querySelectorAll('.mm-bar')).toHaveLength(1); // 收敛回 1 条，旧条目被清除
    } finally {
      minimap.remove();
    }
  });
});
