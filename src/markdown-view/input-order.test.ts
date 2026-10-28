// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { forceParsing } from '@codemirror/language';
import { LivePreviewView } from './livepreview';
import { liveViewport } from './live-block-field';
import { cellRange } from './table-editor';
import { safeCell } from './table-model';
import { referenceField, referencesReady } from './live-state';
import { requestIrFrame } from './frame-work';

vi.mock('../common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textSave: async () => ({ len: 0, modifiedMs: 0 }) }));
vi.mock('./frame-work', async original => {
  const actual = await original<typeof import('./frame-work')>();
  return { ...actual, requestIrFrame: vi.fn(actual.requestIrFrame) };
});
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

async function mount(tail: string, viewportChars = 5000) {
  const host = document.createElement('div'); document.body.append(host);
  const doc = ('plain context '.repeat(40) + '\n\n').repeat(800) + tail;
  const preview = new LivePreviewView(host, { path: 'mock.md', encoding: 'UTF-8', initialDoc: doc, onStatus: () => {}, onSaved: () => {} });
  await vi.waitFor(() => expect(preview.view).toBeDefined());
  const view = preview.view;
  Object.defineProperty(view, 'viewport', { configurable: true, get: () => ({ from: view.state.doc.length - viewportChars, to: view.state.doc.length }) });
  forceParsing(view, view.state.doc.length, 2000);
  view.dispatch({ selection: { anchor: doc.lastIndexOf('target') + 6 }, effects: liveViewport.of(view.viewport) });
  return { host, preview, doc };
}

const input = '*' + Array.from({ length: 25 }, (_, i) => `z${String(i).padStart(2, '0')}x`).join('').slice(0, 99);

it.each([
  ['list', '- item target\n\n'], ['fence', '```js\nconst target\n```\n\n'],
  ['table source', '| head | b |\n| --- | --- |\n| target | other |\n\n'],
])('100 immediate one-character transactions preserve exact order in %s', async (_kind, tail) => {
  const { host, preview, doc } = await mount(tail);
  try {
    const at = preview.view.state.selection.main.head;
    let written = '';
    for (const ch of input) {
      const view = preview.view;
      vi.mocked(requestIrFrame).mockClear();
      view.dispatch({ ...view.state.replaceSelection(ch), userEvent: 'input.type' });
      expect(requestIrFrame).not.toHaveBeenCalled();
      written += ch;
      expect(preview.getMarkdown()).toBe(doc.slice(0, at) + written + doc.slice(at));
    }
    expect(preview.getMarkdown()).toBe(doc.slice(0, at) + input + doc.slice(at));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(preview.getMarkdown()).toBe(doc.slice(0, at) + input + doc.slice(at));
  } finally { preview.destroy(); host.remove(); }
});

// A5 保留文档正确性，撤销 A4 专属的“超宽分片视口也必须始终保挂载”契约。
// 常规视口仍覆盖真实格编辑器；上面的 table source 用例覆盖大文档/宽视口源事务。
it.each([false, true])('100 cell-editor transactions preserve exact text in a normal viewport (metadata effect=%s)', async interleave => {
  const { host, preview } = await mount('| head | b |\n| --- | --- |\n| target | other |\n\n', 600);
  try {
    await vi.waitFor(() => expect(host.querySelector('.mdir-table tbody td')).not.toBeNull(), { timeout: 3000 });
    const cell = host.querySelector<HTMLTableCellElement>('.mdir-table tbody td')!;
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const editor = EditorView.findFromDOM(cell.querySelector<HTMLElement>('.cm-editor')!)!;
    const box = cell.closest<HTMLElement>('.mdir-tablebox')!;
    const initial = preview.getMarkdown(), range = cellRange(preview.view, box, 1, 0)!;
    // 单元格入口保留其既有选区；显式置尾后每字符一个事务，无 await。
    editor.dispatch({ selection: { anchor: editor.state.doc.length } });
    let count = 0;
    let written = '';
    for (const ch of input) {
      vi.mocked(requestIrFrame).mockClear();
      editor.dispatch({ ...editor.state.replaceSelection(ch), userEvent: 'input.type' });
      expect(requestIrFrame).not.toHaveBeenCalled();
      written += ch;
      expect(preview.getMarkdown()).toBe(initial.slice(0, range.from) + safeCell('target' + written) + initial.slice(range.to));
      if (interleave && ++count === 50) preview.view.dispatch({ effects: referencesReady.of(preview.view.state.field(referenceField)) });
    }
    const expected = initial.slice(0, range.from) + safeCell('target' + input) + initial.slice(range.to);
    expect(preview.getMarkdown()).toBe(expected);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(preview.getMarkdown()).toBe(expected);
    expect(editor.state.doc.toString()).toBe('target' + input);
  } finally { preview.destroy(); host.remove(); }
});
