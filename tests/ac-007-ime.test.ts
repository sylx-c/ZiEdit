// @vitest-environment jsdom
// REQ-014 P5：单元格为 contenteditable 直接编辑——IME 语义按新口径锁定：
//   组合期间候选确认键（isComposing keydown）不拦截不导航；组合文本留在格内，离格一次性
//   单事务提交（一次撤销恢复整格）；主编辑器组合保护（装饰冻结）不变。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { undo } from '@codemirror/commands';
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
function composition(el: Element, type: 'compositionstart' | 'compositionend') {
  el.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
}
/** P5 单元格激活：mousedown → contenteditable 源文本态。 */
async function activeCell(host: HTMLElement): Promise<HTMLTableCellElement> {
  await until(() => !!host.querySelector('.mdir-table td'));
  const cell = host.querySelector<HTMLTableCellElement>('.mdir-table tbody td')!;
  cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await until(() => cell.getAttribute('contenteditable') === 'true');
  return cell;
}

describe('007 中文组合输入生命周期（P5 contenteditable 口径）', () => {
  it('compositionstart 首次改字前就保护行内 DOM，结束后恢复渲染', async () => {
    const { v, host } = await mount('**粗体** 后续');
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length } });
    await until(() => !!host.querySelector('.mdir-strong'));
    const strong = host.querySelector('.mdir-strong');
    composition(v.view.contentDOM, 'compositionstart');
    v.view.dispatch({ selection: { anchor: 3 } });
    expect(host.querySelector('.mdir-strong')).toBe(strong);
    composition(v.view.contentDOM, 'compositionend');
    await until(() => host.querySelector('.mdir-strong') === null);
    expect(v.getMarkdown()).toBe('**粗体** 后续');
  });

  it('候选确认 Enter/Tab/Esc 不导航、不撤销并且不 preventDefault', async () => {
    const source = '| 甲 | 乙 |\n|---|---|\n| 内容 | 值 |\n\n尾';
    const { v, host } = await mount(source);
    const cell = await activeCell(host);
    composition(cell, 'compositionstart');
    cell.textContent += '你';
    for (const name of ['Tab', 'Enter', 'Escape']) {
      const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, isComposing: true });
      cell.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(cell.getAttribute('contenteditable')).toBe('true'); // 未导航离开
    }
    composition(cell, 'compositionend');
    expect(v.getMarkdown()).toBe(source); // 未提交、未派生改写
    expect(cell.textContent).toBe('内容你'); // 组合文本留在格内
  });

  it('组合期间表格结构更新替换网格，离格提交写回正确格', async () => {
    const source = '| 甲 | 乙 |\n|---|---|\n| 内容 | 值 |\n\n尾';
    const { v, host } = await mount(source);
    const cell = await activeCell(host);
    composition(cell, 'compositionstart');
    cell.textContent += '字';
    v.view.dispatch({ changes: { from: source.indexOf('\n\n'), insert: '\n| 新 | 行 |' } });
    // 组合保护冻结装饰重建：结构变更在 compositionend 后的重建事务才上屏。
    composition(cell, 'compositionend');
    await until(() => host.querySelectorAll('tbody tr').length === 2);
    // 换件销毁前未提交的编辑已一次性写回（内容字），新网格含新增行。
    await until(() => v.getMarkdown() !== source);
    expect(v.getMarkdown()).toContain('| 内容字 |');
    expect(v.getMarkdown()).toContain('| 新 | 行 |');
  });

  it('长时间选词一次提交一组撤销，不与前后普通输入合并', async () => {
    const source = '| 甲 | 乙 |\n|---|---|\n| 内容 | 值 |\n\n尾';
    const { v, host } = await mount(source);
    const cell = await activeCell(host);
    cell.textContent = '内容A';
    composition(cell, 'compositionstart');
    cell.textContent = '内容A你';
    composition(cell, 'compositionend');
    await new Promise(r => setTimeout(r, 30));
    cell.textContent = '内容A你B';
    v.view.focus();
    cell.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await until(() => v.getMarkdown().includes('| 内容A你B |'));
    expect(undo(v.view)).toBe(true);
    expect(v.getMarkdown()).toBe(source); // P5：整格一次提交 → 一次撤销回原表
  });

  it('组合键不派发全局命令，兼容 keyCode 229', () => {
    const registry = new ActionRegistry(); const run = vi.fn();
    registry.add({ id: 'save', label: 'Save', group: 'file', shortcut: 'Ctrl+S', run });
    expect(registry.dispatch(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, isComposing: true }))).toBe(false);
    expect(registry.dispatch(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, keyCode: 229 }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('只读切换关闭格编辑且不产生迟到改写，销毁后无残留监听', async () => {
    const source = '| 甲 | 乙 |\n|---|---|\n| 内容 | 值 |\n\n尾';
    const { v, host } = await mount(source);
    const cell = await activeCell(host);
    composition(cell, 'compositionstart');
    cell.textContent += '你';
    v.setReadOnly(true);
    await until(() => cell.getAttribute('contenteditable') !== 'true');
    expect(v.getMarkdown()).toBe(source); // 只读守卫：组合中的文本不写回
    v.setReadOnly(false);
    v.destroy(); mounted.splice(mounted.indexOf(v), 1);
    await new Promise(r => setTimeout(r, 30));
    expect(document.querySelector('[data-ziedit-composing]')).toBeNull();
  });
});
