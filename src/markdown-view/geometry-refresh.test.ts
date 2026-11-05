// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { liveBlockField, liveAnchorReady, blockSliceReady } from './live-block-field';
import { BlockHeightCache, BlockHeightMeasurements } from './block-height-cache';
import type { EditorView } from '@codemirror/view';

it('oracle namespaces exact content width, theme, root font style and font loading, not viewport height', () => {
  const cache = new BlockHeightCache(), content = document.createElement('div');
  document.body.append(content);
  let width = 800, viewportHeight = 600;
  content.getBoundingClientRect = () => ({ width, height: viewportHeight } as DOMRect);
  let request: any;
  const view = { contentDOM: content, dom: content, requestMeasure: (value: any) => { request = value; } } as unknown as EditorView;
  const measurements = new BlockHeightMeasurements(view, cache);
  const measure = () => { measurements.measure(); request.write(request.read()); };
  const identity = cache.identity('Table', 'a', 0, 0, 0, 1)!;
  const root = document.documentElement, oldStyle = root.style.cssText, oldClass = root.className;
  try {
    measure(); cache.put(identity, 137.25);
    viewportHeight = 900; measure(); expect(cache.get(identity)).toBe(137.25);
    width = 800.25; measure(); expect(cache.get(identity)).toBeUndefined();
    cache.put(identity, 137.25); root.classList.add('th-oracle-test'); measure(); expect(cache.get(identity)).toBeUndefined();
    cache.put(identity, 137.25); root.style.setProperty('--md-fs-user', '22px'); measure(); expect(cache.get(identity)).toBeUndefined();
  } finally { measurements.destroy(); content.remove(); root.className = oldClass; root.style.cssText = oldStyle; }
});

vi.mock('../common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textSave: async () => ({ len: 0, modifiedMs: 0 }) }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

it('programmatic jumps render the target viewport completely; user scrolls defer, then settle through bounded slices', async () => {
  const { LivePreviewView } = await import('./livepreview');
  await (await import('./md')).loadMarkdownIt();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] });
  const host = document.createElement('div'); document.body.append(host);
  const initialDoc = 'intro\n\n' + Array.from({ length: 180 }, (_, i) =>
    `## Section ${i}\n\n| head | b |\n| --- | --- |\n| value ${i} | other |\n\n`).join('');
  const preview = new LivePreviewView(host, { path: 'mock.md', encoding: 'UTF-8', initialDoc, onStatus: () => {}, onSaved: () => {} });
  try {
    await vi.waitFor(() => expect(host.querySelector('.mdir-table')).not.toBeNull());
    await vi.advanceTimersByTimeAsync(120);
    const view = preview.view;
    const geometryRefresh = vi.fn();
    view.scrollDOM.addEventListener('mdir-layout-refresh', geometryRefresh);
    const tableLine = view.state.doc.lineAt(initialDoc.indexOf('| head |'));
    await vi.waitFor(() => expect(liveAnchorReady(view, tableLine.number)).toBe(true));
    const measured = view.lineBlockAt(tableLine.from);
    const staleMap = vi.spyOn(view, 'lineBlockAt').mockReturnValue({ ...measured, from: tableLine.from, to: tableLine.to } as typeof measured);
    expect(liveAnchorReady(view, tableLine.number)).toBe(false); // 装饰已交付，高度图仍是单行
    staleMap.mockRestore();
    expect(liveAnchorReady(view, tableLine.number)).toBe(true);
    // 可控帧/停稳定时器，避免实际线程负载跨过 100ms 短暂状态。
    await vi.waitFor(() => expect(view.state.field(liveBlockField).pending).toBeUndefined());
    // 程序跳转（大纲/查找/还原，或 CM6 滚动锚因高度变化改写 scrollTop）：不进滚动占位
    view.scrollDOM.scrollTop = 640; view.scrollDOM.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(view.state.field(liveBlockField).deferred).toBe(false);
    // 用户滚轮：进入滚动占位，停稳后一次性换回实件
    view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
    view.scrollDOM.scrollTop = 1280; view.scrollDOM.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(32);
    expect(view.state.field(liveBlockField).deferred).toBe(true);
    await vi.advanceTimersByTimeAsync(120);
    await vi.waitFor(() => expect(view.state.field(liveBlockField).deferred).toBe(false));
    await vi.waitFor(() => expect(view.state.field(liveBlockField).pending).toBeUndefined());
    expect(host.querySelector('.mdir-block-placeholder')).toBeNull();
    // 停滚只完成延迟块，不是字体/宽度变化，不能清掉表格的已测量行高。
    expect(geometryRefresh).not.toHaveBeenCalled();
    // 停稳换件引起的锚点补偿 scroll 不是用户滚动：不得重新进入占位（修前往复回弹的环）
    await vi.advanceTimersByTimeAsync(320);
    view.scrollDOM.scrollTop += 7; view.scrollDOM.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(40);
    expect(view.state.field(liveBlockField).deferred).toBe(false);
  } finally { preview.destroy(); host.remove(); vi.useRealTimers(); }
});

it('theme, resize and font refreshes preserve tables while bounded slices finish', async () => {
  const { LivePreviewView } = await import('./livepreview');
  await (await import('./md')).loadMarkdownIt();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] });
  const root = document.documentElement, previousClass = root.className, previousTone = root.getAttribute('data-tone');
  const fontDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts'), fonts = new EventTarget();
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  root.className = 'th-paper'; root.dataset.tone = 'light';
  const host = document.createElement('div'); document.body.append(host);
  const preview = new LivePreviewView(host, { path: 'mock.md', encoding: 'UTF-8', initialDoc: 'intro\n\n| head | b |\n| --- | --- |\n| value | other |\n\nafter\n', onStatus: () => {}, onSaved: () => {} });
  try {
    await vi.waitFor(() => expect(host.querySelector('.mdir-table')).not.toBeNull());
    const view = preview.view;
    const shape = () => [...host.querySelectorAll('.mdir-table *')].map(element => element.tagName).join(',');
    const initialShape = shape(), initialText = host.querySelector('.mdir-table')!.textContent;
    await vi.advanceTimersByTimeAsync(110);
    view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 })); // 用户滚动意图
    view.scrollDOM.scrollTop = 100;
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(32);
    expect(view.state.field(liveBlockField).deferred).toBe(true);
    const pending = view.state.field(liveBlockField).pending;
    if (pending) view.dispatch({ effects: blockSliceReady.of(pending.token) });
    expect(view.state.field(liveBlockField).deferred).toBe(true);
    // (2026-10-30 H7) 滚动中不再把实表降级为占位——实表保留，防闪烁/焦点丢失/重复水合
    expect(host.querySelector('.mdir-block-placeholder')).toBeNull();
    expect(host.querySelector('.mdir-table')).not.toBeNull();
    for (const theme of ['cool', 'graphite', 'black', 'paper', 'cool', 'black', 'paper']) {
      root.className = `th-${theme}`;
      root.dataset.tone = theme === 'graphite' || theme === 'black' ? 'dark' : 'light';
      // 几何变化经帧队列交付，仍须早于 100ms 停稳定时器完成。
      await vi.advanceTimersByTimeAsync(32);
      expect(view.state.field(liveBlockField).deferred).toBe(false);
      await vi.waitFor(() => expect(view.state.field(liveBlockField).pending).toBeUndefined());
      expect(host.querySelector('.mdir-block-placeholder')).toBeNull();
      expect(shape()).toBe(initialShape);
      expect(host.querySelector('.mdir-table')!.textContent).toBe(initialText);
      // CSS 几何变化所触发的滚动锚点校正不能重新进入占位模式。
      view.scrollDOM.scrollTop++;
      view.scrollDOM.dispatchEvent(new Event('scroll'));
      await Promise.resolve();
      expect(view.state.field(liveBlockField).deferred).toBe(false);
    }
    for (const signal of [() => window.dispatchEvent(new Event('resize')), () => fonts.dispatchEvent(new Event('loadingdone'))]) {
      signal(); await Promise.resolve();
      await vi.waitFor(() => expect(view.state.field(liveBlockField).pending).toBeUndefined());
      expect(host.querySelector('.mdir-block-placeholder')).toBeNull();
      expect(shape()).toBe(initialShape);
    }
  } finally {
    preview.destroy(); host.remove(); root.className = previousClass;
    if (previousTone === null) root.removeAttribute('data-tone'); else root.setAttribute('data-tone', previousTone);
    if (fontDescriptor) Object.defineProperty(document, 'fonts', fontDescriptor); else Reflect.deleteProperty(document, 'fonts');
    vi.useRealTimers();
  }
});
