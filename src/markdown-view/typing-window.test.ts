// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree, forceParsing, syntaxTreeAvailable } from '@codemirror/language';
import { paragraphTypingWindow } from './typing-window';
import { irPerfReset, irPerfSnapshot } from './ir-perf';

if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

vi.mock('../common/ipc', () => ({
  textOpen: async () => ({ newline: 'lf' }),
  textSave: async () => ({ len: 0, modifiedMs: 0 }),
}));

it('rejects syntax edits, paragraph boundaries and multiline changes', () => {
  const state = EditorState.create({ doc: 'paragraph\n\nnext', selection: { anchor: 3 }, extensions: [markdown({ base: markdownLanguage })] });
  for (const change of [{ from: 3, insert: '*' }, { from: 0, insert: 'x' }, { from: 3, insert: '\n' }]) {
    const tr = state.update({ changes: change });
    expect(paragraphTypingWindow(state, tr.state, tr.changes)).toBeNull();
  }
  const tr = state.update({ changes: { from: 3, insert: '字' } });
  expect(paragraphTypingWindow(state, tr.state, tr.changes)).toEqual({ from: 0, to: 10 });
});

it.each(['- item target', '```js\nconst target = 1;\n```', '| a |\n| --- |\n| target |'])('structure content does not use the paragraph fast path: %s', doc => {
  const at = doc.lastIndexOf('target') + 3;
  const before = EditorState.create({ doc, selection: { anchor: at }, extensions: [markdown({ base: markdownLanguage })] });
  const tr = before.update({ changes: { from: at, insert: 'x' }, selection: { anchor: at + 1 } });
  expect(paragraphTypingWindow(before, tr.state, tr.changes)).toBeNull();
});

it('single-character typing in 5000 blocks rebuilds only its paragraph and maps block layout', async () => {
  const { LivePreviewView } = await import('./livepreview');
  const global = globalThis as typeof globalThis & { __ZIEDIT_IR_PERF__?: boolean };
  const previous = global.__ZIEDIT_IR_PERF__;
  const host = document.createElement('div'); document.body.append(host);
  const preview = new LivePreviewView(host, { path: 'mock.md', encoding: 'UTF-8', initialDoc: 'paragraph text\n\n'.repeat(5000), onStatus: () => {}, onSaved: () => {} });
  try {
    await vi.waitFor(() => expect(preview.view).toBeDefined());
    const view = preview.view;
    Object.defineProperty(view, 'viewport', { configurable: true, get: () => ({ from: 0, to: 600 }) });
    forceParsing(view, view.state.doc.length, 2000);
    view.dispatch({ selection: { anchor: 3 } });
    // 前置确定性：整棵语法树解析到位后再键入——快路径在树未就绪时按设计回退宽窗口，
    // 固定时长等待在慢机器/高负载下会让回退路径被误测（曾于 CI 首跑暴露）。
    await vi.waitFor(() => {
      ensureSyntaxTree(view.state, view.state.doc.length, 1000);
      expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
    }, { timeout: 20_000, interval: 100 });
    global.__ZIEDIT_IR_PERF__ = true; irPerfReset();
    view.dispatch({ changes: { from: 3, insert: 'x' }, selection: { anchor: 4 }, userEvent: 'input.type' });
    const counters = irPerfSnapshot().counters;
    expect(counters.liveDeco.count).toBe(1);
    expect(counters.liveDeco.lastWindow!.to - counters.liveDeco.lastWindow!.from).toBeLessThanOrEqual(32);
    expect(counters.blockDecos.count).toBe(0);
    expect(counters.blockLayout.count).toBe(0);
    expect(view.state.doc.sliceString(0, 15)).toBe('parxagraph text');
  } finally { preview.destroy(); host.remove(); global.__ZIEDIT_IR_PERF__ = previous; irPerfReset(); }
});
