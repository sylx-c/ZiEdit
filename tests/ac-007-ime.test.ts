// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import { LivePreviewView } from '../src/markdown-view/livepreview';
import { ActionRegistry } from '../src/shell/chrome';

vi.mock('../src/common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textSave: async () => ({ len: 0 }), textReadAll: async () => '' }));
vi.mock('../src/markdown-view/preview', async original => ({ ...await original<object>(), loadUnicodeEmojis: async () => ({}) }));
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const mounted: LivePreviewView[] = [];
afterEach(() => { for (const v of mounted.splice(0)) v.destroy(); document.body.replaceChildren(); });
async function until(test: () => boolean) { await vi.waitFor(() => expect(test()).toBe(true), { timeout: 2000, interval: 15 }); }
async function mount(source: string) {
  const host = document.createElement('div'); document.body.append(host);
  const v = new LivePreviewView(host, { path: 'E:/ime.md', encoding: 'UTF-8', initialDoc: source, onStatus: () => {}, onSaved: () => {} });
  mounted.push(v); await until(() => !!v.view);
  return { v, host };
}
function composition(view: EditorView, type: 'compositionstart' | 'compositionend') {
  view.contentDOM.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
}
function key(view: EditorView, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true });
  view.contentDOM.dispatchEvent(event);
  return event;
}
async function cellEditor(host: HTMLElement) {
  await until(() => !!host.querySelector('td'));
  host.querySelector('td')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  return EditorView.findFromDOM(host.querySelector('td .cm-editor')!)!;
}

describe('007 中文组合输入生命周期（原生 IME 的自动回归补充）', () => {
  it('compositionstart 首次改字前就保护行内 DOM，结束后恢复渲染', async () => {
    const { v, host } = await mount('**粗体** 后续');
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length } });
    await until(() => !!host.querySelector('.mdir-strong'));
    const strong = host.querySelector('.mdir-strong');
    composition(v.view, 'compositionstart');
    v.view.dispatch({ selection: { anchor: 3 } });
    expect(host.querySelector('.mdir-strong')).toBe(strong);
    composition(v.view, 'compositionend');
    await until(() => host.querySelector('.mdir-strong') === null);
    expect(v.getMarkdown()).toBe('**粗体** 后续');
  });

  it('候选确认 Enter/Tab/Esc 不导航、不撤销并且不 preventDefault', async () => {
    const source = '| 甲 | 乙 |\n|---|---|\n| 内容 | 值 |\n\n尾';
    const { v, host } = await mount(source);
    const cell = await cellEditor(host);
    composition(cell, 'compositionstart');
    for (const name of ['Tab', 'Enter', 'Escape']) {
      expect(key(cell, name).defaultPrevented).toBe(false);
      expect(host.querySelector('td .cm-editor')).toBe(cell.dom);
    }
    composition(cell, 'compositionend');
    expect(v.getMarkdown()).toBe(source);
  });

  it('组合期间表格结构更新保留活动格，提交后才应用新网格', async () => {
    const source = '| 甲 | 乙 |\n|---|---|\n| 内容 | 值 |\n\n尾';
    const { v, host } = await mount(source);
    const cell = await cellEditor(host);
    composition(cell, 'compositionstart');
    const at = source.indexOf('\n\n');
    v.view.dispatch({ changes: { from: at, insert: '\n| 新 | 行 |' } });
    await new Promise(r => setTimeout(r, 70));
    expect(host.querySelector('td .cm-editor')).toBe(cell.dom);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    composition(cell, 'compositionend');
    await until(() => host.querySelectorAll('tbody tr').length === 2);
    expect(v.getMarkdown()).toContain('| 新 | 行 |');
  });

  it('长时间选词仍是一组撤销，不与前后普通输入合并', async () => {
    const source = '| 甲 | 乙 |\n|---|---|\n| 内容 | 值 |\n\n尾';
    const { v, host } = await mount(source);
    const cell = await cellEditor(host);
    cell.dispatch({ ...cell.state.replaceSelection('A'), userEvent: 'input.type' });
    composition(cell, 'compositionstart');
    const time = Date.now();
    cell.dispatch({ ...cell.state.replaceSelection('ni'), userEvent: 'input.type.compose', annotations: Transaction.time.of(time) });
    cell.dispatch({ changes: { from: 3, to: 5, insert: '你' }, userEvent: 'input.type.compose', annotations: Transaction.time.of(time + 1000) });
    composition(cell, 'compositionend');
    await new Promise(r => setTimeout(r, 30));
    cell.dispatch({ ...cell.state.replaceSelection('B'), userEvent: 'input.type' });
    expect(undo(v.view)).toBe(true);
    expect(v.getMarkdown()).toContain('| 内容A你 |');
    expect(undo(v.view)).toBe(true);
    expect(v.getMarkdown()).toContain('| 内容A |');
    expect(undo(v.view)).toBe(true);
    expect(v.getMarkdown()).toBe(source);
  });

  it('组合键不派发全局命令，兼容 keyCode 229', () => {
    const registry = new ActionRegistry(); const run = vi.fn();
    registry.add({ id: 'save', label: 'Save', group: 'file', shortcut: 'Ctrl+S', run });
    expect(registry.dispatch(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, isComposing: true }))).toBe(false);
    expect(registry.dispatch(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, keyCode: 229 }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('组合期间表格前的修改映射源位置，提交仍写在原格', async () => {
    const source = '前\n\n| 甲 | 乙 |\n|---|---|\n| 内容 | 值 |\n\n尾';
    const { v, host } = await mount(source);
    const cell = await cellEditor(host);
    composition(cell, 'compositionstart');
    v.view.dispatch({ changes: { from: 0, insert: '插入\n\n' } });
    cell.dispatch({ ...cell.state.replaceSelection('字'), userEvent: 'input.type.compose' });
    composition(cell, 'compositionend');
    await until(() => !cell.contentDOM.hasAttribute('data-ziedit-composing'));
    expect(v.getMarkdown()).toBe('插入\n\n' + source.replace('| 内容 |', '| 内容字 |'));
  });

  it('组合结束后重建表格恢复格内中间光标，不跳到格尾', async () => {
    const source = '| 甲 | 乙 |\n|---|---|\n| 内容甲乙 | 值 |\n\n尾';
    const { v, host } = await mount(source);
    const cell = await cellEditor(host);
    cell.dispatch({ selection: { anchor: 2 } });
    composition(cell, 'compositionstart');
    v.view.dispatch({ changes: { from: source.indexOf('\n\n'), insert: '\n| 新 | 行 |' } });
    composition(cell, 'compositionend');
    await until(() => host.querySelectorAll('tbody tr').length === 2 && !!host.querySelector('td .cm-editor'));
    const resumed = EditorView.findFromDOM(host.querySelector('td .cm-editor')!)!;
    expect(resumed.state.selection.main.head).toBe(2);
    expect(v.getMarkdown()).toContain('| 内容甲乙 |');
  });

  it('只读切换关闭组合会话且不产生迟到改写，销毁后释放保护状态', async () => {
    const source = '| 甲 | 乙 |\n|---|---|\n| 内容 | 值 |\n\n尾';
    const { v, host } = await mount(source);
    const cell = await cellEditor(host);
    composition(cell, 'compositionstart');
    v.setReadOnly(true);
    await until(() => !v.view.contentDOM.hasAttribute('data-ziedit-composing'));
    expect(host.querySelector('td .cm-editor')).toBeNull();
    expect(v.getMarkdown()).toBe(source);
    v.setReadOnly(false);
    const next = await cellEditor(host);
    composition(next, 'compositionstart'); composition(next, 'compositionend');
    v.destroy(); mounted.splice(mounted.indexOf(v), 1);
    await new Promise(r => setTimeout(r, 30));
    expect(document.querySelector('[data-ziedit-composing]')).toBeNull();
  });

  it('连续两次组合开始不会被前次结束计时器解除保护，撤销分组独立', async () => {
    const source = '| 甲 | 乙 |\n|---|---|\n| 内容 | 值 |\n\n尾';
    const { v, host } = await mount(source);
    const cell = await cellEditor(host);
    composition(cell, 'compositionstart');
    cell.dispatch({ ...cell.state.replaceSelection('你'), userEvent: 'input.type.compose' });
    composition(cell, 'compositionend');
    composition(cell, 'compositionstart');
    await new Promise(r => setTimeout(r, 30));
    expect(cell.contentDOM.hasAttribute('data-ziedit-composing')).toBe(true);
    cell.dispatch({ ...cell.state.replaceSelection('好'), userEvent: 'input.type.compose' });
    composition(cell, 'compositionend');
    await until(() => !cell.contentDOM.hasAttribute('data-ziedit-composing'));
    expect(undo(v.view)).toBe(true);
    expect(v.getMarkdown()).toContain('| 内容你 |');
    expect(undo(v.view)).toBe(true);
    expect(v.getMarkdown()).toBe(source);
  });
});
