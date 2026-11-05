// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { BlockHeightCache, blockHeightCache, BlockHeightMeasurements } from '../src/markdown-view/block-height-cache';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { liveBlockField, liveViewport, liveGeometryChanged, blockSliceReady } from '../src/markdown-view/live-block-field';
import { referenceField, emojiField } from '../src/markdown-view/live-state';

it('实测内容在滚出及停稳期间保留，编辑身份不误命中', () => {
  const doc = 'intro\n\n| a |\n| --- |\n| b |\n';
  const cache = new BlockHeightCache();
  let state = EditorState.create({ doc, extensions: [blockHeightCache.of(cache), markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField] });
  state = state.update({ effects: liveViewport.of({ from: 0, to: doc.length }) }).state;
  const identity = cache.bound('Table', 0, 0, doc.indexOf('|'), doc.lastIndexOf('|') + 1)!;
  const content = document.createElement('div'), box = document.createElement('div'); content.append(box); document.body.append(content);
  content.getBoundingClientRect = () => ({ width: 800 } as DOMRect);
  box.getBoundingClientRect = () => ({ height: 137.25 } as DOMRect);
  let request: any;
  const scrollDOM = document.createElement('div');
  const view = { contentDOM: content, dom: content, state, scrollDOM, requestMeasure: (value: any) => { request = value; } } as unknown as EditorView;
  const measurements = new BlockHeightMeasurements(view, cache);
  try {
    measurements.register(box, identity); request.write(request.read());
    expect(cache.get(identity)).toBe(137.25);
    // (2026-10-30 H7 适配) 滚动不再把已缓存实表降级为占位——装饰仍是 TableWidget（estimatedHeight 用缓存高度提示），
    // 停稳后 geometry 变化同样保留实表；仅当缓存未命中时才走占位路径（另有测试覆盖）。
    measurements.unregister(box); box.remove();
    state = state.update({ effects: liveViewport.of({ from: 0, to: doc.length, scrolling: true }) }).state;
    state = state.update({ effects: blockSliceReady.of(state.field(liveBlockField).pending!.token) }).state;
    const widget = state.field(liveBlockField).set.iter().value!.spec.widget;
    expect(widget.estimatedHeight).toBe(137.25);
    state = state.update({ effects: liveGeometryChanged.of(null) }).state;
    expect(state.field(liveBlockField).set.iter().value!.spec.widget.estimatedHeight).toBe(137.25);
    state = state.update({ changes: { from: doc.indexOf('b |'), insert: 'changed' } }).state;
    expect(cache.get(identity)).toBeUndefined();
  } finally { measurements.destroy(); content.remove(); }
});

it('批量 DOM 实测不派事务，复用持续测量，销毁与布局迟到结果拒收', () => {
  const cache = new BlockHeightCache();
  const contentDOM = document.createElement('div'); document.body.append(contentDOM);
  contentDOM.getBoundingClientRect = () => ({ width: 800 } as DOMRect);
  const queue: { read: () => unknown; write: (value: any) => void }[] = [];
  const view = { contentDOM, dom: contentDOM, state: EditorState.create({ extensions: [blockHeightCache.of(cache)] }),
    requestMeasure: (request: any) => queue.push(request) } as unknown as EditorView;
  const measurements = new BlockHeightMeasurements(view, cache);
  const box = document.createElement('div'); contentDOM.append(box);
  box.getBoundingClientRect = () => ({ height: 137.25 } as DOMRect);
  const identity = cache.identity('Table', '|a|', 0, 0, 0, 3)!;
  const flush = () => { const request = queue.pop()!; queue.length = 0; request.write(request.read()); };
  measurements.register(box, identity); flush();
  expect(cache.get(identity)).toBe(137.25);
  const editor = document.createElement('div'); editor.className = 'cm-editor'; box.append(editor);
  box.getBoundingClientRect = () => ({ height: 190 } as DOMRect);
  measurements.measure(); flush(); expect(cache.get(identity)).toBe(137.25); editor.remove();
  const tools = document.createElement('div'); tools.className = 'mdir-tabletools'; tools.style.display = 'flex'; box.append(tools);
  measurements.measure(); flush(); expect(cache.get(identity)).toBe(137.25); tools.remove();
  measurements.register(box, identity); flush();
  expect(cache.get(identity)).toBe(190);
  measurements.measure(); const pending = queue.pop()!; const read = pending.read();
  cache.layout('new width'); pending.write(read);
  expect(cache.get(identity)).toBeUndefined();
  measurements.measure(); const late = queue.pop()!; const result = late.read();
  measurements.destroy(); late.write(result);
  expect(cache.get(identity)).toBeUndefined(); contentDOM.remove();
});
