// @vitest-environment jsdom
// 组合格式待输入态：空选区连按 bold+italic 后输入应得到 ***文本***；
// 已生效格式内再按格式键改写定界符（***abc*** 内按 bold → *abc*），单步撤销可还原。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { LivePreviewView } from '../src/markdown-view/livepreview';

vi.mock('../src/common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textReadAll: async () => '', textSave: async () => ({ len: 0 }) }));
vi.mock('../src/markdown-view/preview', async original => ({ ...await original<object>(), loadUnicodeEmojis: async () => ({}) }));
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const mounted: LivePreviewView[] = [];
afterEach(() => { for (const view of mounted.splice(0)) view.destroy(); document.body.replaceChildren(); });
async function until(test: () => boolean) { await vi.waitFor(() => expect(test()).toBe(true), { timeout: 2000, interval: 15 }); }
async function mount(source: string) {
  const host = document.createElement('div'); document.body.append(host);
  const view = new LivePreviewView(host, { path: 'E:/combo.md', encoding: 'UTF-8', initialDoc: source, onStatus: () => {}, onSaved: () => {} });
  mounted.push(view); await until(() => !!view.view);
  return { view, host, main: view.view };
}
function type(view: EditorView, text: string) {
  for (const char of text) {
    const range = view.state.selection.main;
    if (!view.state.facet(EditorView.inputHandler).some(handle => handle(view, range.from, range.to, char, () => view.state.update(view.state.replaceSelection(char)))))
      view.dispatch({ ...view.state.replaceSelection(char), userEvent: 'input.type' });
  }
}

describe('007 组合格式：待输入态与已生效格式的叠加/取消', () => {
  it('空选区连按粗体+斜体后输入，得到粗斜体且无模板残留', async () => {
    const { view, main } = await mount('正文');
    main.dispatch({ selection: { anchor: 2 } });
    view.runFormat('bold');
    view.runFormat('italic');
    type(main, '粗斜');
    expect(main.state.doc.toString()).toBe('正文***粗斜***');
  });
  it('待输入态再按一次同一格式取消该格式，其余保留', async () => {
    const { view, main } = await mount('');
    view.runFormat('bold');
    view.runFormat('italic');
    view.runFormat('bold');
    type(main, 'x');
    expect(main.state.doc.toString()).toBe('*x*');
  });
  it('已生效粗体内按斜体叠加为粗斜体', async () => {
    const { view, main } = await mount('');
    view.runFormat('bold');
    type(main, 'abc');
    expect(main.state.doc.toString()).toBe('**abc**');
    view.runFormat('italic');
    expect(main.state.doc.toString()).toBe('***abc***');
  });
  it('粗斜体末尾按粗体退出粗体，后续输入仅斜体，内容不被解除', async () => {
    const { view, main } = await mount('');
    view.runFormat('bold');
    view.runFormat('italic');
    type(main, 'abc');
    expect(main.state.doc.toString()).toBe('***abc***');
    view.runFormat('bold');
    expect(main.state.doc.toString()).toBe('***abc***');
    type(main, 'd');
    expect(main.state.doc.toString()).toBe('***abc****d*');
    view.cmUndo();
    expect(main.state.doc.toString()).toBe('***abc***');
  });
  it('粗体+删除线组合嵌套定界符', async () => {
    const { view, main } = await mount('');
    view.runFormat('bold');
    view.runFormat('strike');
    type(main, 's');
    expect(main.state.doc.toString()).toBe('**~~s~~**');
  });
  it('待输入态全部取消后输入为纯文本', async () => {
    const { view, main } = await mount('');
    view.runFormat('bold');
    view.runFormat('italic');
    view.runFormat('italic');
    view.runFormat('bold');
    type(main, 'plain');
    expect(main.state.doc.toString()).toBe('plain');
  });
});
