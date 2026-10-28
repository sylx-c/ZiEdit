// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { LivePreviewView } from '../src/markdown-view/livepreview';
import { EditView } from '../src/text-view/edit';
import { PreviewFind } from '../src/markdown-view/preview-find';
import type { EditorBuffer } from '../src/common/editor-buffer';

const saved = vi.fn(async () => ({ len: 12, modifiedMs: 1 }));
vi.mock('../src/common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textSave: (...args: unknown[]) => saved(...args as []), textReadAll: async () => '' }));
vi.mock('../src/markdown-view/preview', async original => ({ ...await original<object>(), loadUnicodeEmojis: async () => ({ smile: '😄' }) }));
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const mounted: Array<{ destroy(): void }> = [];
afterEach(() => { for (const v of mounted.splice(0)) v.destroy(); document.body.replaceChildren(); saved.mockClear(); });
async function until(test: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(test()).toBe(true), { timeout: 2500, interval: 15 });
}
async function mount(initialDoc: string, readOnly = false, buffer?: EditorBuffer) {
  const host = document.createElement('div'); document.body.append(host);
  const v = new LivePreviewView(host, { path: 'E:/test.md', encoding: 'UTF-8', initialDoc, readOnly, buffer,
    onStatus: () => {}, onSaved: () => {} });
  mounted.push(v); await until(() => !!v.view);
  return { v, host };
}

describe('007 即时输入和只读实际状态回归', () => {
  it('独立预览在跨行内格式的正文中查找，跳转不改阅读 DOM', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<p><strong>甲</strong>乙</p><p>甲乙</p>';
    document.body.append(host);
    Element.prototype.scrollIntoView = vi.fn();
    const find = new PreviewFind(host); mounted.push(find);
    const original = host.innerHTML;
    find.show();
    const input = document.querySelector<HTMLInputElement>('.md-preview-find input')!;
    input.value = '甲乙'; input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => document.getSelection()?.toString() === '甲乙');
    expect(document.getSelection()?.anchorNode?.parentElement?.tagName).toBe('STRONG');
    find.step(1);
    await until(() => document.getSelection()?.anchorNode?.parentElement?.tagName === 'P');
    find.step(1);
    await until(() => document.getSelection()?.anchorNode?.parentElement?.tagName === 'STRONG');
    expect(host.innerHTML).toBe(original);
  });

  it('引用中的无外缘竖线表格格内输入不改引用前缀', async () => {
    const source = '> A | B\n> ---|---\n> 甲 | 乙\n\n尾';
    const { v, host } = await mount(source);
    await until(() => !!host.querySelector('td'));
    expect(host.querySelector('td')?.textContent).toBe('甲');
    host.querySelector('td')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const cell = EditorView.findFromDOM(host.querySelector('td .cm-editor')!)!;
    cell.dispatch({ ...cell.state.replaceSelection('新'), userEvent: 'input.type' });
    expect(v.getMarkdown()).toBe(source.replace('> 甲 |', '> 甲新 |'));
    expect(undo(v.view)).toBe(true);
    expect(v.getMarkdown()).toBe(source);
  });

  it('表格下方空行输入留在表外新段落，连续输入与撤销不并入表格', async () => {
    const source = '前文\n\n| A | B |\n|---|---|\n| a | b |\n';
    const { v, host } = await mount(source);
    await until(() => !!host.querySelector('td'));
    v.view.focus();
    v.view.dispatch({ changes: { from: source.length, insert: '中' }, selection: { anchor: source.length + 1 }, userEvent: 'input.type' });
    v.view.dispatch({ ...v.view.state.replaceSelection('文输入'), userEvent: 'input.type' });
    expect(v.getMarkdown()).toBe(source + '\n中文输入');
    expect(v.view.state.selection.main.head).toBe(source.length + 5);
    await until(() => v.view.contentDOM.textContent?.includes('中文输入') ?? false);
    expect(host.querySelector('table')?.textContent).not.toContain('中文输入');
    undo(v.view); undo(v.view); undo(v.view);
    expect(v.getMarkdown()).toBe(source);
  });

  it('闭合加粗后同段及换行续写仍渲染，移入仅展开该元素', async () => {
    const { v, host } = await mount('');
    const type = (text: string) => v.view.dispatch({ ...v.view.state.replaceSelection(text), userEvent: 'input.type' });
    type('**甲**'); type(' 后续'); type('\n同段第二行');
    await until(() => !!host.querySelector('.mdir-strong'));
    expect(host.textContent).not.toContain('**');
    v.view.dispatch({ selection: { anchor: 3 } });
    await until(() => host.textContent!.includes('**甲**'));
    expect(v.getMarkdown()).toBe('**甲** 后续\n同段第二行');
  });

  it('编辑代码体时持续保留背景和真实关键字 token', async () => {
    const { v, host } = await mount('```javascript\nconst value = 1;\n```\n');
    v.view.dispatch({ selection: { anchor: 22 } });
    await until(() => !!host.querySelector('.mdir-code .tok-keyword'));
    expect(host.querySelector('.mdir-code .tok-keyword')?.textContent).toBe('const');
  });

  it('脚注、表情、高亮、嵌套标题与引用代码保留原文', async () => {
    const source = '注[^a] :smile: ==亮==\n\n[^a]: 内容\n\n> [!NOTE]\n> ## 标题\n> ```js\n> const a = 1\n> ```\n\n尾';
    const { v, host } = await mount(source);
    v.view.dispatch({ selection: { anchor: source.length } });
    await until(() => !!host.querySelector('.mdir-emoji'));
    expect(host.querySelector('.mdir-footnote-ref')?.textContent).toBe('1');
    expect(host.querySelector('.mdir-emoji')?.textContent).toBe('😄');
    expect(host.querySelector('.mdir-highlight')?.textContent).toBe('亮');
    expect(host.querySelector('.mdir-h2')).not.toBeNull();
    expect(host.querySelector('.mdir-callout-title')).not.toBeNull();
    expect(v.getMarkdown()).toBe(source);
  });

  it('网格格内修改只更新目标范围、转义竖线，单步撤销，历史可跨形态搬运', async () => {
    const source = '| 甲 | 乙 |\n|---|---|\n| a | b |\n\n尾';
    const { v, host } = await mount(source);
    await until(() => !!host.querySelector('td'));
    host.querySelector('td')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const cell = EditorView.findFromDOM(host.querySelector('td .cm-editor')!)!;
    cell.dispatch({ ...cell.state.replaceSelection(' | 中文'), userEvent: 'input.type' });
    expect(v.getMarkdown()).toBe(source.replace('| a |', '| a \\| 中文 |'));
    expect(host.querySelectorAll('table').length).toBe(1);
    expect(undo(v.view)).toBe(true);
    expect(v.getMarkdown()).toBe(source);
    v.view.dispatch({ changes: { from: source.length, insert: '修改' }, userEvent: 'input' });
    const buffer = { state: v.view.state, dirty: true, scrollTop: 0 };
    const newHost = document.createElement('div'); document.body.append(newHost);
    const edit = new EditView(newHost, { path: 'E:/test.md', language: 'Markdown', encoding: 'UTF-8', buffer,
      onStatus: () => {}, onSaved: () => {}, onSaveAsNeeded: () => {} });
    mounted.push(edit); await until(() => !!edit.view);
    expect(edit.getContent()).toBe(source + '修改');
    expect(undo(edit.view)).toBe(true);
    expect(edit.getContent()).toBe(source);
  });

  it('格内保存/查找转交主编辑器，任务点击同步源文档', async () => {
    const { v, host } = await mount('| A |\n|---|\n| B |\n\n- [ ] 任务\n');
    await until(() => !!host.querySelector('td'));
    host.querySelector('td')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const cell = EditorView.findFromDOM(host.querySelector('td .cm-editor')!)!;
    cell.dispatch({ ...cell.state.replaceSelection('修改'), userEvent: 'input.type' });
    cell.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    await until(() => saved.mock.calls.length === 1);
    cell.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    await until(() => !!host.querySelector('input'));
    const task = host.querySelector<HTMLInputElement>('.mdir-task')!;
    task.click();
    await until(() => v.getMarkdown().includes('[x]'));
    expect(host.querySelector<HTMLInputElement>('.mdir-task')?.checked).toBe(true);
    v.setReadOnly(true);
    host.querySelector<HTMLInputElement>('.mdir-task')!.click();
    await Promise.resolve();
    expect(v.getMarkdown()).toContain('[x]');
    expect(host.querySelector<HTMLInputElement>('.mdir-task')?.checked).toBe(true);
  });

  it('只读阻断程序化事务、格式、任务、表格、保存，并保留原历史', async () => {
    const source = '- [ ] 任务\n\n| A |\n|---|\n| B |\n\n尾';
    const { v, host } = await mount(source);
    v.view.dispatch({ changes: { from: source.length, insert: '已有修改' }, userEvent: 'input' });
    const before = v.getMarkdown();
    v.setReadOnly(true);
    v.view.dispatch({ changes: { from: 0, insert: '禁止' } });
    v.runFormat('bold');
    host.querySelector('.mdir-task')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    host.querySelector('td')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await v.save();
    expect(saved).not.toHaveBeenCalled();
    expect(v.getMarkdown()).toBe(before);
    expect(host.querySelector('td .cm-editor')).toBeNull();
    expect(v.isDirty).toBe(true);
    v.setReadOnly(false);
    expect(undo(v.view)).toBe(true);
    expect(v.getMarkdown()).toBe(source);
    const another = await mount(source, true);
    another.v.view.dispatch({ changes: { from: 0, insert: '禁止' } });
    expect(another.v.getMarkdown()).toBe(source);
  });
});
