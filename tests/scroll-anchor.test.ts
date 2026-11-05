// @vitest-environment jsdom
// 跨形态位置锚 + 缩略图导航回归锁（2026-10-30 滚动整改）。
// 修前：切形态/切标签按像素 scrollTop 还原（三种形态行高不同，像素无对应关系）；
// 缩略图点击走 goToLine（移动光标 + 横向回到第 0 列），视口框按像素比例、条纹按行比例，两者错位。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cmCaptureAnchor, cmRestoreAnchor, cmRestoreEffect, notifyCmRestoreLayout } from '../src/common/scroll-anchor';
import { markUserScroll } from '../src/common/user-scroll';
import { previewScrollToLine, previewTopLine, previewVisibleLines } from '../src/markdown-view/preview';
import { ReadingSurface } from '../src/markdown-view/reading-surface';
import type { MarkdownBlock } from '../src/markdown-view/document-model';
import { Minimap, type MinimapAdapter } from '../src/text-view/minimap';

afterEach(() => document.body.replaceChildren());

describe('cmRestoreEffect：同形态用快照，跨形态按源码行', () => {
  const view = (): EditorView => new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') }),
  });

  it('同 surface 原样交回 CM6 快照（含横向位置的精确还原）', () => {
    const v = view();
    const anchor = cmCaptureAnchor(v, 'source')!;
    expect(anchor.snapshot).toBeDefined();
    expect(cmRestoreEffect(v, anchor, 'source')).toBe(anchor.snapshot);
    v.destroy();
  });

  it('跨 surface 不用像素快照，改为把锚行滚到视口顶', () => {
    const v = view();
    const snapshot = v.scrollSnapshot();
    const effect = cmRestoreEffect(v, { line: 20.6, surface: 'ir', snapshot }, 'source');
    expect(effect).not.toBe(snapshot);
    // 目标是第 20 行行首（小数部分=块内比例，向下取整到所在行）
    const target = (effect.value as { range: { head: number } }).range.head;
    expect(target).toBe(v.state.doc.line(20).from);
    v.destroy();
  });

  it('锚行越界时夹到文档范围内', () => {
    const v = view();
    const effect = cmRestoreEffect(v, { line: 999, surface: 'preview' }, 'ir');
    expect((effect.value as { range: { head: number } }).range.head).toBe(v.state.doc.line(50).from);
    v.destroy();
  });
});

describe('跨形态恢复多行块的源码位置', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  function setup() {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, cb); return id; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const scroller = document.createElement('div'); document.body.append(scroller);
    Object.defineProperty(scroller, 'clientHeight', { value: 200 });
    scroller.scrollLeft = 42;
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 10 } as DOMRect);
    const state = EditorState.create({ doc: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') });
    let measure: { read: (view: EditorView) => number | null; write: (top: number | null, view: EditorView) => void } | undefined;
    const view = { dom: scroller, scrollDOM: scroller, state, get documentTop() { return 10 - scroller.scrollTop; }, dispatch: vi.fn(),
      lineBlockAt: () => ({ from: state.doc.line(4).from, to: state.doc.line(7).to, top: 100, height: 80 }),
      requestMeasure: (request: typeof measure) => { measure = request; } } as unknown as EditorView;
    const next = () => { const batch = [...frames]; frames.clear(); for (const [, callback] of batch) callback(0); };
    return { view, scroller, next, frames, deliver: () => { const request = measure!; request.write(request.read(view), view); } };
  }

  it('目标位于多行表格时按块内比例恢复且不移动光标或横向位置', () => {
    const { view, scroller, next, deliver } = setup();
    const selection = view.state.selection;
    cmRestoreAnchor(view, { line: 6, surface: 'source' }, 'ir');
    next(); next(); deliver();
    expect(scroller.scrollTop).toBeCloseTo(140);
    expect(scroller.scrollLeft).toBe(42);
    expect(view.state.selection).toBe(selection);
  });

  it('同形态没有像素快照时仍按块内比例恢复', () => {
    const { view, scroller, next, deliver } = setup();
    cmRestoreAnchor(view, { line: 6, surface: 'ir' }, 'ir');
    next(); next(); deliver();
    expect(scroller.scrollTop).toBeCloseTo(140);
  });

  it('等待块装饰和连续布局更新结束后只恢复一次', () => {
    vi.useFakeTimers();
    const { view, scroller, next, frames, deliver } = setup();
    let ready = false;
    cmRestoreAnchor(view, { line: 6, surface: 'source' }, 'ir', { ready: () => ready });
    vi.advanceTimersByTime(250); next(); next(); deliver();
    expect(scroller.scrollTop).toBe(0); // 目标仍是尚未替换的源码行
    ready = true; notifyCmRestoreLayout(view);
    vi.advanceTimersByTime(200); notifyCmRestoreLayout(view);
    vi.advanceTimersByTime(249);
    expect(frames.size).toBe(0); // 新布局推迟旧测量
    vi.advanceTimersByTime(1); next(); next(); deliver();
    expect(scroller.scrollTop).toBeCloseTo(140);
    notifyCmRestoreLayout(view);
    vi.advanceTimersByTime(250);
    expect(frames.size).toBe(0);
  });

  it('等待布局时新用户输入取消旧恢复', () => {
    vi.useFakeTimers();
    const { view, scroller, frames } = setup();
    cmRestoreAnchor(view, { line: 6, surface: 'source' }, 'ir', { ready: () => true });
    vi.advanceTimersByTime(200);
    scroller.dispatchEvent(new WheelEvent('wheel'));
    notifyCmRestoreLayout(view); vi.advanceTimersByTime(1000);
    expect(frames.size).toBe(0);
    expect(scroller.scrollTop).toBe(0);
  });

  it('读取之后出现新布局时不得提交过期测量', () => {
    vi.useFakeTimers();
    const { view, scroller, next, deliver } = setup();
    cmRestoreAnchor(view, { line: 6, surface: 'source' }, 'ir', { ready: () => true });
    vi.advanceTimersByTime(250); next(); next();
    notifyCmRestoreLayout(view); deliver();
    expect(scroller.scrollTop).toBe(0);
    vi.advanceTimersByTime(250); next(); next(); deliver();
    expect(scroller.scrollTop).toBeCloseTo(140);
  });

  it('用户滚动或地图导航后取消等待中的旧恢复', () => {
    const first = setup();
    cmRestoreAnchor(first.view, { line: 6, surface: 'source' }, 'ir');
    first.scroller.dispatchEvent(new WheelEvent('wheel'));
    expect(first.frames.size).toBe(0);
    expect(first.scroller.scrollTop).toBe(0);

    const second = setup();
    cmRestoreAnchor(second.view, { line: 6, surface: 'source' }, 'ir');
    second.next(); second.next();
    markUserScroll(second.scroller);
    second.deliver();
    expect(second.scroller.scrollTop).toBe(0);
  });
});

/** jsdom 无布局：按给定几何桩出预览块（data-line 为 0 起源码行） */
function previewWith(blocks: Array<{ line: number; top: number }>, end: number, viewport = 200): HTMLElement {
  const scroller = document.createElement('div');
  const col = document.createElement('div');
  scroller.append(col);
  const entries: Array<{ block: MarkdownBlock; element: HTMLElement }> = [];
  for (const [i, b] of blocks.entries()) {
    const el = document.createElement('p');
    el.setAttribute('data-line', String(b.line));
    Object.defineProperty(el, 'offsetTop', { value: b.top });
    col.append(el);
    Object.defineProperty(el, 'offsetHeight', { value: (blocks[i + 1]?.top ?? end) - b.top });
    entries.push({ element: el, block: { id: String(i), from: b.line, to: b.line + 1, startLine: b.line, endLine: blocks[i + 1]?.line ?? b.line + 1, kind: 'Paragraph', src: '', signature: '' } });
  }
  Object.defineProperty(col, 'offsetTop', { value: 0 });
  Object.defineProperty(col, 'offsetHeight', { value: end });
  Object.defineProperty(scroller, 'scrollHeight', { value: end });
  Object.defineProperty(scroller, 'clientHeight', { value: viewport });
  document.body.append(scroller);
  if (blocks.length) new ReadingSurface(scroller, col).update(entries, blocks.at(-1)!.line + 2);
  return scroller;
}

describe('渲染预览 源码行↔像素 分段线性映射', () => {
  // 第 1 行标题占 0..100px，第 3~12 行是一张 400px 高的表格（100..500），第 13 行段落 500..600
  const blocks = [{ line: 0, top: 0 }, { line: 2, top: 100 }, { line: 12, top: 500 }];

  it('视口顶行按块内像素比例插值', () => {
    const s = previewWith(blocks, 600);
    s.scrollTop = 300; // 表格正中
    expect(previewTopLine(s)).toBeCloseTo(3 + 0.5 * 10);
    s.scrollTop = 0;
    expect(previewTopLine(s)).toBe(1);
  });

  it('按行滚动是 previewTopLine 的逆映射', () => {
    const s = previewWith(blocks, 600);
    expect(previewScrollToLine(s, 8)).toBe(true);
    expect(s.scrollTop).toBeCloseTo(100 + (8 - 3) / 10 * 400);
    expect(previewTopLine(s)).toBeCloseTo(8);
  });

  it('视口行区间覆盖视口上下沿', () => {
    const s = previewWith(blocks, 600, 200);
    s.scrollTop = 100;
    const range = previewVisibleLines(s)!;
    expect(range.first).toBeCloseTo(3);
    expect(range.last).toBeCloseTo(3 + 200 / 400 * 10);
  });

  it('无可定位块时返回 null / false，不改滚动', () => {
    const s = previewWith([], 0);
    expect(previewTopLine(s)).toBeNull();
    expect(previewScrollToLine(s, 5)).toBe(false);
  });
});

describe('缩略图导航', () => {
  function minimap(over: Partial<MinimapAdapter>): { mm: Minimap; root: HTMLElement; parent: HTMLElement } {
    const parent = document.createElement('div');
    document.body.append(parent);
    const mm = new Minimap(parent, {
      scrollTop: () => 0, scrollHeight: () => 4000, clientHeight: () => 400, scrollTo: () => {},
      totalLines: () => 100, lineText: () => 'text', cacheVersion: () => 0, ...over,
    });
    for (const el of [mm.root, parent.querySelector('.vscroll')!]) {
      Object.defineProperty(el, 'clientHeight', { value: 410, configurable: true });
    }
    mm.root.getBoundingClientRect = () => ({ top: 0, height: 400, bottom: 400, left: 0, right: 90, width: 90, x: 0, y: 0, toJSON() {} });
    return { mm, root: mm.root, parent };
  }

  it('点击地图只滚动：优先 scrollToLine，不走移动光标的 goToLine', () => {
    const scrollToLine = vi.fn(), goToLine = vi.fn();
    const { mm, root } = minimap({ scrollToLine, goToLine });
    root.dispatchEvent(new MouseEvent('mousedown', { clientY: 29 + (400 - 29 - 10) / 2, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(scrollToLine).toHaveBeenCalledWith(50);
    expect(goToLine).not.toHaveBeenCalled();
    mm.remove();
  });

  it('视口框按行坐标画（渲染类视图像素与行不成比例），滚动条滑块仍按像素', () => {
    // 像素上在顶部（scrollTop=0），但视口覆盖的是第 51~61 行（例如上方是大量折叠/块件）
    const { mm, parent } = minimap({ visibleLines: () => ({ first: 51, last: 61 }) });
    mm.sync();
    const box = parent.querySelector<HTMLElement>('.mm-viewport')!;
    const thumb = parent.querySelector<HTMLElement>('.vs-thumb')!;
    const inner = 410 - 29 - 10;
    expect(parseFloat(box.style.top)).toBeCloseTo(29 + 0.5 * inner);
    expect(parseFloat(box.style.height)).toBeCloseTo(Math.max(18, 0.1 * inner));
    expect(parseFloat(thumb.style.top)).toBeCloseTo(29); // 像素坐标：仍在顶端
    mm.remove();
  });

  it('滚动条拖动按实时总高换算（拖动途中内容高度纠正不再让滑块与鼠标脱节）', () => {
    let height = 4000;
    const scrollTo = vi.fn();
    const { mm, parent } = minimap({ scrollHeight: () => height, scrollTo });
    mm.sync();
    const thumb = parent.querySelector<HTMLElement>('.vs-thumb')!;
    Object.defineProperty(thumb, 'offsetTop', { value: 29, configurable: true });
    Object.defineProperty(thumb, 'offsetHeight', { value: 40, configurable: true });
    thumb.dispatchEvent(new MouseEvent('mousedown', { clientY: 50, bubbles: true }));
    height = 8000; // 拖动途中实测高度翻倍
    const range = 410 - 29 - 10 - 40;
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 50 + range / 2 }));
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(scrollTo).toHaveBeenLastCalledWith((8000 - 400) / 2);
    mm.remove();
  });

  it('滚轮按 deltaMode 换算（按行上报的设备不再一格只滚 3px）', () => {
    const scrollTo = vi.fn();
    const { mm, root } = minimap({ scrollTo });
    root.dispatchEvent(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, cancelable: true }));
    expect(scrollTo).toHaveBeenLastCalledWith(48);
    mm.remove();
  });

  it('轨道翻页用短时平滑，滚轮与拖动保持即时响应；卸载取消未完成的帧', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(frames.size + 1, fn); return frames.size; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    const scrollTo = vi.fn();
    const { mm, parent, root } = minimap({ scrollTo });
    const rail = parent.querySelector<HTMLElement>('.vscroll')!;
    rail.dispatchEvent(new MouseEvent('mousedown', { clientY: 350, bubbles: true }));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    for (const [id, fn] of [...frames]) { frames.delete(id); fn(16); }
    expect(scrollTo).toHaveBeenCalled();
    root.dispatchEvent(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, cancelable: true }));
    expect(scrollTo).toHaveBeenLastCalledWith(48);
    expect(frames.size).toBe(0);
    mm.remove();
    now.mockRestore();
    vi.unstubAllGlobals();
  });

  it('帧时间早于事件时间不产生反向跳动；外部滚动立即取消动画', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(108);
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(frames.size + 1, fn); return frames.size; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    let y = 1000;
    const { mm, parent } = minimap({ scrollTo: value => { y = value; }, scrollTop: () => y });
    const rail = parent.querySelector<HTMLElement>('.vscroll')!;
    rail.dispatchEvent(new MouseEvent('mousedown', { clientY: 350, bubbles: true }));
    for (const [id, fn] of [...frames]) { frames.delete(id); fn(100); }
    expect(y).toBe(1000);
    now.mockReturnValue(140);
    for (const [id, fn] of [...frames]) { frames.delete(id); fn(140); }
    expect(y).toBeGreaterThan(1000);
    y = 1100;
    for (const [id, fn] of [...frames]) { frames.delete(id); fn(156); }
    expect(y).toBe(1100);
    expect(frames.size).toBe(0);
    mm.remove();
    now.mockRestore();
    vi.unstubAllGlobals();
  });
});
