// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { liveBlockField, blockSliceReady } from './live-block-field';

vi.mock('../common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textSave: async () => ({ len: 0, modifiedMs: 0 }) }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

it('programmatic jumps settle many table placeholders atomically without re-entering deferred rendering', async () => {
  const { LivePreviewView } = await import('./livepreview');
  const host = document.createElement('div'); document.body.append(host);
  const initialDoc = 'intro\n\n' + Array.from({ length: 180 }, (_, i) =>
    `## Section ${i}\n\n| head | b |\n| --- | --- |\n| value ${i} | other |\n\n`).join('');
  const preview = new LivePreviewView(host, { path: 'mock.md', encoding: 'UTF-8', initialDoc, onStatus: () => {}, onSaved: () => {} });
  try {
    await vi.waitFor(() => expect(host.querySelector('.mdir-table')).not.toBeNull());
    await new Promise(resolve => setTimeout(resolve, 120));
    const view = preview.view;
    view.scrollDOM.scrollTop = 640; view.scrollDOM.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(view.state.field(liveBlockField).deferred).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(view.state.field(liveBlockField).deferred).toBe(false);
    expect(view.state.field(liveBlockField).pending).toBeUndefined();
    expect(host.querySelector('.mdir-block-placeholder')).toBeNull();
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    expect(view.state.field(liveBlockField).deferred).toBe(false);
  } finally { preview.destroy(); host.remove(); }
});

it('theme, resize and font refreshes synchronously replace scrolling placeholders with complete isomorphic tables', async () => {
  const { LivePreviewView } = await import('./livepreview');
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
    await new Promise(resolve => setTimeout(resolve, 110));
    view.scrollDOM.scrollTop = 100;
    view.scrollDOM.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
    const pending = view.state.field(liveBlockField).pending;
    if (pending) view.dispatch({ effects: blockSliceReady.of(pending.token) });
    expect(view.state.field(liveBlockField).deferred).toBe(true);
    expect(host.querySelector('.mdir-block-placeholder')).not.toBeNull();
    for (const theme of ['cool', 'graphite', 'black', 'paper', 'cool', 'black', 'paper']) {
      root.className = `th-${theme}`;
      root.dataset.tone = theme === 'graphite' || theme === 'black' ? 'dark' : 'light';
      // MutationObserver + reporter 的微任务，不等待 100ms 停稳定时器。
      await Promise.resolve(); await Promise.resolve();
      expect(view.state.field(liveBlockField).deferred).toBe(false);
      expect(view.state.field(liveBlockField).pending).toBeUndefined();
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
      expect(view.state.field(liveBlockField).pending).toBeUndefined();
      expect(host.querySelector('.mdir-block-placeholder')).toBeNull();
      expect(shape()).toBe(initialShape);
    }
  } finally {
    preview.destroy(); host.remove(); root.className = previousClass;
    if (previousTone === null) root.removeAttribute('data-tone'); else root.setAttribute('data-tone', previousTone);
    if (fontDescriptor) Object.defineProperty(document, 'fonts', fontDescriptor); else Reflect.deleteProperty(document, 'fonts');
  }
});
