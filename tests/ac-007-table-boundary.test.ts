// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { LivePreviewView } from '../src/markdown-view/livepreview';
import { compositionChanged } from '../src/common/composition';

vi.mock('../src/common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textReadAll: async () => '', textSave: async () => ({ len: 0 }) }));
vi.mock('../src/markdown-view/preview', async original => ({ ...await original<object>(), loadUnicodeEmojis: async () => ({}) }));
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const mounted: LivePreviewView[] = [];
afterEach(() => { for (const view of mounted.splice(0)) view.destroy(); document.body.replaceChildren(); });
async function until(test: () => boolean) { await vi.waitFor(() => expect(test()).toBe(true), { timeout: 2000, interval: 15 }); }
async function mount(source: string) {
  const host = document.createElement('div'); document.body.append(host);
  const view = new LivePreviewView(host, { path: 'E:/boundary.md', encoding: 'UTF-8', initialDoc: source, onStatus: () => {}, onSaved: () => {} });
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

describe('007 表格边界：表外输入不被吸收', () => {
  it('表格下空行输入普通文字自动隔空行，文字留在表外且单步撤销', async () => {
    const source = '| A | B |\n|---|---|\n| a | b |\n';
    const { view, main, host } = await mount(source);
    await until(() => !!host.querySelector('table'));
    main.dispatch({ selection: { anchor: source.length } });
    type(main, '表后文字');
    expect(main.state.doc.toString()).toBe(source + '\n表后文字');
    await until(() => main.contentDOM.textContent?.includes('表后文字') ?? false);
    expect(host.querySelector('table')?.textContent).not.toContain('表后文字');
    view.cmUndo();
    expect(main.state.doc.toString()).toBe(source);
  });
  it('文末表格无尾换行时，表末输入落到表外新段落', async () => {
    const source = '| A |\n|---|\n| a |';
    const { main, host } = await mount(source);
    await until(() => !!host.querySelector('table'));
    main.dispatch({ selection: { anchor: source.length } });
    type(main, '新段');
    expect(main.state.doc.toString()).toBe(source + '\n\n新段');
  });
  it('键入竖线视为有意续表，不插入空行', async () => {
    const source = '| A | B |\n|---|---|\n| a | b |\n';
    const { main, host } = await mount(source);
    await until(() => !!host.querySelector('table'));
    main.dispatch({ selection: { anchor: source.length } });
    type(main, '| c | d |');
    expect(main.state.doc.toString()).toBe(source + '| c | d |');
  });
  it('组合输入在表后空行结束时分离，取消组合不分离', async () => {
    const source = '| A | B |\n|---|---|\n| a | b |\n';
    const { main, host } = await mount(source);
    await until(() => !!host.querySelector('table'));
    main.dispatch({ selection: { anchor: source.length } });
    main.dispatch({ effects: compositionChanged.of(true) });
    main.dispatch({ changes: { from: source.length, insert: '中文' }, selection: { anchor: source.length + 2 }, userEvent: 'input.type.compose.start' });
    expect(main.state.doc.toString()).toBe(source + '中文');
    main.dispatch({ effects: compositionChanged.of(false) });
    expect(main.state.doc.toString()).toBe(source + '\n中文');
    expect(main.state.selection.main.head).toBe(source.length + 3);
    main.dispatch({ selection: { anchor: source.length + 3 } });
    main.dispatch({ effects: compositionChanged.of(true) });
    main.dispatch({ effects: compositionChanged.of(false) });
    expect(main.state.doc.toString()).toBe(source + '\n中文');
  });
  it('引用表格下空行输入保留引用前缀', async () => {
    const source = '> | A |\n> |---|\n> | a |\n> ';
    const { main, host } = await mount(source);
    await until(() => !!host.querySelector('table'));
    main.dispatch({ selection: { anchor: source.length } });
    type(main, '字');
    expect(main.state.doc.toString()).toBe('> | A |\n> |---|\n> | a |\n> \n> 字');
  });
  it('普通段落后的空行输入不分离；表格上方的空行不受影响', async () => {
    const { main } = await mount('段落\n');
    main.dispatch({ selection: { anchor: 3 } });
    type(main, 'x');
    expect(main.state.doc.toString()).toBe('段落\nx');
    const source = '前\n\n| A |\n|---|\n| a |';
    const again = await mount(source);
    await until(() => !!again.host.querySelector('table'));
    again.main.dispatch({ selection: { anchor: 2 } });
    type(again.main, 'y');
    expect(again.main.state.doc.toString()).toBe('前\ny\n| A |\n|---|\n| a |');
  });
});
