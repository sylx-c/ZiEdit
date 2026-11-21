// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { forceParsing } from '@codemirror/language';
import { undo } from '@codemirror/commands';
import { LivePreviewView } from './livepreview';
import { liveViewport } from './md-view-plugin';
import { cellRange } from './table-widget';
import { safeCell } from './table-model';
import { referenceField, referencesReady } from './live-state';

vi.mock('../common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textSave: async () => ({ len: 0, modifiedMs: 0 }) }));
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
      view.dispatch({ ...view.state.replaceSelection(ch), userEvent: 'input.type' });
      written += ch;
      // 派生装饰允许排队；文字与光标必须在当前输入事务内同步完成。
      expect(view.state.selection.main.head).toBe(at + written.length);
      expect(preview.getMarkdown()).toBe(doc.slice(0, at) + written + doc.slice(at));
    }
    expect(preview.getMarkdown()).toBe(doc.slice(0, at) + input + doc.slice(at));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(preview.getMarkdown()).toBe(doc.slice(0, at) + input + doc.slice(at));
  } finally { preview.destroy(); host.remove(); }
});

// REQ-014 P5：单元格为 contenteditable 直接编辑，blur/切格时单事务写回。
// 键序保持改为「写入期间文档不被污染 + 提交后精确写回 + 单步撤销恢复原表」。
it.each([false, true])('100 cell-edit characters commit exactly once on leave (metadata effect=%s)', async interleave => {
  const { host, preview } = await mount('| head | b |\n| --- | --- |\n| target | other |\n\n', 600);
  try {
    await vi.waitFor(() => expect(host.querySelector('.mdir-table tbody td')).not.toBeNull(), { timeout: 3000 });
    const cell = host.querySelector<HTMLTableCellElement>('.mdir-table tbody td')!;
    const initial = preview.getMarkdown(), range = cellRange(preview.view, cell.closest<HTMLElement>('.mdir-tablebox')!, 1, 0)!;
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(cell.getAttribute('contenteditable')).toBe('true'));
    let typed = '';
    for (const ch of input) {
      cell.textContent += ch; // contenteditable 键入（jsdom 等价）
      typed += ch;
      // 编辑期间主文档保持原文（无逐笔事务——P5 blur 提交口径）。
      expect(preview.getMarkdown()).toBe(initial);
      if (interleave && typed.length === 50) preview.view.dispatch({ effects: referencesReady.of(preview.view.state.field(referenceField)) });
    }
    // 提交（点表外另一格触发 blur 路径）。
    const other = host.querySelector<HTMLTableCellElement>('.mdir-table tbody td:nth-child(2)')!;
    other.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(preview.getMarkdown()).toBe(initial.slice(0, range.from) + safeCell('target' + input) + initial.slice(range.to)), { timeout: 3000 });
    // 单步撤销恢复原表（REQ-014.8）。
    preview.view.focus();
    undo(preview.view);
    expect(preview.getMarkdown()).toBe(initial);
  } finally { preview.destroy(); host.remove(); }
});
