// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { runScopeHandlers } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { LivePreviewView } from '../src/markdown-view/livepreview';

vi.mock('../src/common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textSave: async () => ({ len: 0, modifiedMs: 0 }) }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
const previews: LivePreviewView[] = [];
afterEach(() => { for (const preview of previews.splice(0)) preview.destroy(); document.body.replaceChildren(); });
async function editor(initialDoc: string) {
  const host = document.createElement('div'); document.body.append(host);
  const preview = new LivePreviewView(host, { path: 'mock.md', encoding: 'UTF-8', initialDoc, onStatus: () => {}, onSaved: () => {} });
  previews.push(preview);
  await vi.waitFor(() => expect(preview.view).toBeDefined());
  return preview.view;
}
function key(view: Awaited<ReturnType<typeof editor>>, key: string, ctrlKey = false, shiftKey = false) {
  return runScopeHandlers(view, new KeyboardEvent('keydown', { key, ctrlKey, shiftKey }), 'editor');
}
it('escapes down/up only at code content boundaries', async () => {
  const view = await editor('before\n```\none\ntwo\n```\nafter');
  view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
  key(view, 'ArrowDown'); expect(view.state.selection.main.head).toBe(view.state.doc.line(6).from);
  view.dispatch({ selection: { anchor: view.state.doc.line(3).from } });
  key(view, 'ArrowUp'); expect(view.state.selection.main.head).toBe(view.state.doc.line(1).to);
});
it.each([false, true])('Mod+Enter exits a code block (end of document: %s)', async end => {
  const view = await editor('```\ncode\n```' + (end ? '' : '\nafter'));
  view.dispatch({ selection: { anchor: 5 } }); key(view, 'Enter', true);
  expect(view.state.selection.main.head).toBe(view.state.doc.line(4).from);
  expect(view.state.doc.line(4).text).toBe(end ? '' : 'after');
});
it.each(['Backspace', 'Delete'])('content → whole block → document selection; %s deletes cleanly in one undo', async deletion => {
  const source = 'before\n```\none\ntwo\n```\nafter', view = await editor(source);
  view.dispatch({ selection: { anchor: source.indexOf('one') } });
  key(view, 'a', true); expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('one\ntwo');
  key(view, 'a', true); expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('```\none\ntwo\n```');
  const block = view.state.selection.main;
  key(view, 'a', true); expect(view.state.selection.main.to).toBe(source.length); expect(view.state.selection.main.from).toBe(0);
  view.dispatch({ selection: block }); key(view, deletion);
  expect(view.state.doc.toString()).toBe('before\n\nafter');
  expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe(source);
});
it('table cell Tab/Shift+Tab wraps, Mod+Enter inserts a row, toolbar deletes the entire table', async () => {
  const source = 'before\n\n| a | b |\n| --- | --- |\n| c | d |\n\nafter', view = await editor(source);
  await vi.waitFor(() => expect(document.querySelector('.mdir-table')).not.toBeNull());
  const { openCellEditor } = await import('../src/markdown-view/table-editor');
  const box = document.querySelector<HTMLElement>('.mdir-tablebox')!;
  const cells = box.querySelectorAll<HTMLTableCellElement>('th,td');
  openCellEditor(view, box, cells[1]!);
  const local = () => { const dom = box.querySelector('.cm-content')!; return (dom as HTMLElement); };
  local().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(box.dataset.mdTableRow).toBe('1'); expect(box.dataset.mdTableCol).toBe('0');
  local().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  expect(box.dataset.mdTableRow).toBe('0'); expect(box.dataset.mdTableCol).toBe('1');
  local().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  expect(view.state.doc.lines).toBe(8);
  await Promise.resolve();
  const remove = [...document.querySelectorAll<HTMLButtonElement>('.mdir-tabletools button')].find(button => button.title === '删除表格' || button.title === 'Delete table')!;
  expect(remove.getAttribute('aria-label')).toBe(remove.title); remove.click();
  expect(view.state.doc.toString()).toBe('before\n\n\n\nafter');
  expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toContain('| a | b |');
});
