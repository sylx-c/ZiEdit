// @vitest-environment jsdom
// AC-37 操作手感 / AC-38 显示效果对照矩阵补测（007 v0.37 B4）：
// 引用续写、markdownIndent 直测、围栏边界键位、链接占位覆盖、行内标记活动展开、
// 分割线命令、表格格内行内格式、Shift-Enter 硬换行。脚手架复用 ac-007-writing.test.ts。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { forceParsing, indentUnit } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { LivePreviewView } from '../src/markdown-view/livepreview';
import { markdownIndent } from '../src/markdown-view/writing';

vi.mock('../src/common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textReadAll: async () => '', textSave: async () => ({ len: 0 }) }));
vi.mock('../src/markdown-view/preview', async original => ({ ...await original<object>(), loadUnicodeEmojis: async () => ({}) }));
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const mounted: LivePreviewView[] = [];
const editors: EditorView[] = [];
afterEach(() => {
  for (const view of mounted.splice(0)) view.destroy();
  for (const view of editors.splice(0)) view.destroy();
  document.body.replaceChildren();
});
async function until(test: () => boolean) { await vi.waitFor(() => expect(test()).toBe(true), { timeout: 2000, interval: 15 }); }
async function mount(source: string) {
  const host = document.createElement('div'); document.body.append(host);
  const view = new LivePreviewView(host, { path: 'E:/writing.md', encoding: 'UTF-8', initialDoc: source, onStatus: () => {}, onSaved: () => {} });
  mounted.push(view); await until(() => !!view.view);
  return { view, host, main: view.view };
}
function key(view: EditorView, name: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options });
  view.contentDOM.dispatchEvent(event);
  return event;
}
function type(view: EditorView, text: string) {
  for (const char of text) {
    const range = view.state.selection.main;
    if (!view.state.facet(EditorView.inputHandler).some(handle => handle(view, range.from, range.to, char, () => view.state.update(view.state.replaceSelection(char)))))
      view.dispatch({ ...view.state.replaceSelection(char), userEvent: 'input.type' });
  }
}
/** markdownIndent 直测用独立视图：markdown 语言 + 与 IR 相同的四空格缩进单元。 */
function indentView(source: string, anchor: number): EditorView {
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: source, selection: { anchor }, extensions: [markdown(), indentUnit.of('    ')] }) });
  editors.push(view); forceParsing(view);
  return view;
}

describe('007 AC-37 引用 Enter 续写', () => {
  it('> 引用行末 Enter 续写 "> " 前缀', async () => {
    const { view, main } = await mount('> 引用');
    main.dispatch({ selection: { anchor: 4 } }); key(main, 'Enter');
    expect(view.getMarkdown()).toBe('> 引用\n> ');
    expect(main.state.doc.lineAt(main.state.selection.main.head).text).toBe('> ');
    type(main, '续');
    expect(view.getMarkdown()).toBe('> 引用\n> 续');
  });
  it('引用内列表行末 Enter 续写 "> - " 双重前缀', async () => {
    const { view, main } = await mount('> - 项');
    main.dispatch({ selection: { anchor: 5 } }); key(main, 'Enter');
    expect(view.getMarkdown()).toBe('> - 项\n> - ');
  });
  it('空引用行 Enter 钉死：首次续写、连续第二次空引用行退出（与通行实现首次即退出的差异登记台账）', async () => {
    const { view, main } = await mount('> 引用\n> ');
    main.dispatch({ selection: { anchor: 7 } }); key(main, 'Enter');
    expect(view.getMarkdown()).toBe('> 引用\n>\n> ');
    key(main, 'Enter');
    expect(view.getMarkdown()).toBe('> 引用\n\n');
  });
});

describe('007 AC-37 markdownIndent 缩进命令', () => {
  it.each([
    ['有序顶层', '1. 甲\n2. 乙', '1. 甲\n    2. 乙'],
    ['无序顶层', '- 甲\n- 乙', '- 甲\n    - 乙'],
    ['无序嵌无序', '- 甲\n  - 乙\n- 丙', '- 甲\n      - 乙\n- 丙'],
    ['有序嵌有序', '1. 甲\n   1. 乙\n2. 丙', '1. 甲\n       1. 乙\n2. 丙'],
  ] as const)('%s：Tab 缩进四空格，Shift+Tab 复原', (_name, source, indented) => {
    const view = indentView(source, source.indexOf('乙'));
    expect(markdownIndent(view, 1)).toBe(true);
    expect(view.state.doc.toString()).toBe(indented);
    expect(markdownIndent(view, -1)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
  });
  it('非列表上下文不缩进', () => {
    const view = indentView('正文段落', 2);
    expect(markdownIndent(view, 1)).toBe(false);
    expect(view.state.doc.toString()).toBe('正文段落');
  });
  it('挂载 IR 有序列表 Tab 嵌套，Shift+Tab 复原', async () => {
    const { view, main } = await mount('1. 甲\n2. 乙');
    main.dispatch({ selection: { anchor: '1. 甲\n2. '.length } }); key(main, 'Tab');
    expect(view.getMarkdown()).toBe('1. 甲\n    2. 乙');
    key(main, 'Tab', { shiftKey: true });
    expect(view.getMarkdown()).toBe('1. 甲\n2. 乙');
  });
});

describe('007 AC-37 围栏边界删除/方向键先移光标', () => {
  const FENCE = '```js\ncode\n```\n\n后';
  it.each([
    ['Backspace', 'code'],
    ['ArrowLeft', 'code'],
    ['Delete', ''],
    ['ArrowRight', ''],
  ] as const)('%s 在隐藏闭合围栏行内先移光标，不删围栏', async (name, expectedLine) => {
    const { view, main } = await mount(FENCE);
    const close = main.state.doc.line(3); // '```'
    main.dispatch({ selection: { anchor: close.from + 2 } }); key(main, name);
    expect(view.getMarkdown()).toBe(FENCE);
    expect(main.state.doc.lineAt(main.state.selection.main.head).text).toBe(expectedLine);
  });
});

describe('007 AC-37/35 链接按文字/地址输入（IR editLink 对话框）', () => {
  it('runFormat(link) 打开对话框，逐字填入地址后落为链接源码且渲染态更新', async () => {
    const { view, main, host } = await mount('站名');
    main.dispatch({ selection: { anchor: 0, head: 2 } }); view.runFormat('link');
    const inputs = [...document.body.querySelectorAll('.ov-body input')];
    expect(inputs).toHaveLength(2);
    const [label, url] = inputs as [HTMLInputElement, HTMLInputElement];
    expect(label.value).toBe('站名'); // 锚文本预填自选区
    for (const char of 'https://a.dev') url.value += char;
    document.body.querySelector<HTMLButtonElement>('.ov-body .dlg-btn.primary')!.click();
    expect(view.getMarkdown()).toBe('[站名](<https://a.dev>)');
    await until(() => !!host.querySelector('.mdir-link'));
    expect(host.querySelector('.mdir-link')?.textContent).toBe('站名');
    expect(main.contentDOM.textContent).not.toContain('https://a.dev');
  });
});

describe('007 AC-38 行内标记活动展开', () => {
  it.each([
    ['bold', '**粗**', 'mdir-strong', '粗'],
    ['italic', '*斜*', 'mdir-em', '斜'],
    ['inlineCode', '`码`', 'mdir-icode', '码'],
  ] as const)('%s 非活动隐藏定界符，光标进入展开源码且内容不变', async (_cmd, marked, cls, word) => {
    const doc = `首\n\n${marked}\n\n尾`;
    const { view, main, host } = await mount(doc);
    await until(() => !!host.querySelector('.' + cls));
    expect(host.querySelector('.' + cls)?.textContent).toBe(word);
    main.dispatch({ selection: { anchor: doc.indexOf(word) } });
    await until(() => !host.querySelector('.' + cls));
    expect(main.contentDOM.textContent).toContain(marked);
    expect(view.getMarkdown()).toBe(doc);
  });
});

describe('007 AC-38 分割线插入命令', () => {
  it('hr 命令插入分割线，IR 渲染横线件且单步撤销', async () => {
    const { view, main, host } = await mount('前文');
    main.dispatch({ selection: { anchor: 2 } }); view.runFormat('hr');
    expect(view.getMarkdown()).toBe('前文\n\n---\n\n');
    await until(() => !!host.querySelector('.mdir-hr'));
    expect(undo(main)).toBe(true);
    expect(view.getMarkdown()).toBe('前文');
  });
});

describe('007 AC-38 表格活动格行内格式', () => {
  it('格内输入 **粗** 渲染为粗体，主文档保留行内源码', async () => {
    const { view, main, host } = await mount('| A | B |\n|---|---|\n|  |  |');
    await until(() => !!host.querySelector('table'));
    const cell = host.querySelectorAll('tbody tr')[0]!.querySelectorAll('td')[0]!;
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const editor = EditorView.findFromDOM(host.querySelector('td .cm-editor')!)!;
    type(editor, '**粗**');
    key(editor, 'Escape');
    expect(cell.querySelector('strong')?.textContent).toBe('粗');
    expect(view.getMarkdown()).toBe('| A | B |\n|---|---|\n|  **粗**|  |');
  });
});

describe('007 AC-37 Shift-Enter 硬换行（v0.37）', () => {
  it('段中 Shift-Enter 插入行尾两空格+换行，渲染折叠行尾标记，单步撤销', async () => {
    const { view, main } = await mount('第一段');
    main.dispatch({ selection: { anchor: 2 } });
    key(main, 'Enter', { shiftKey: true });
    expect(view.getMarkdown()).toBe('第一  \n段');
    await until(() => {
      const lines = [...main.contentDOM.querySelectorAll('.cm-line')].map(el => el.textContent);
      return lines.includes('第一') && lines.includes('段');
    });
    expect(undo(main)).toBe(true);
    expect(view.getMarkdown()).toBe('第一段');
  });
  it('列表项内容内 Shift-Enter 硬换行，续文仍属同一项', async () => {
    const { view, main } = await mount('- 项');
    main.dispatch({ selection: { anchor: 3 } });
    key(main, 'Enter', { shiftKey: true });
    type(main, '续');
    expect(view.getMarkdown()).toBe('- 项  \n续');
    await until(() => ![...main.contentDOM.querySelectorAll('.cm-line')].some(el => el.textContent?.includes('  ')));
  });
  it('只读与组合输入期禁用（组合期键位在捕获层被 compositionGuard 隔离）', async () => {
    const { view, main } = await mount('正文');
    view.setReadOnly(true);
    main.dispatch({ selection: { anchor: 2 } }); key(main, 'Enter', { shiftKey: true });
    expect(view.getMarkdown()).toBe('正文');
    view.setReadOnly(false);
    main.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    key(main, 'Enter', { shiftKey: true, isComposing: true });
    expect(view.getMarkdown()).toBe('正文');
    main.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  it('标题行内不拦截，不产生硬换行源码', async () => {
    const { view, main, host } = await mount('## 标题');
    await until(() => !!host.querySelector('.mdir-h2')); // 标题装饰出现 = 语法树已解析
    main.dispatch({ selection: { anchor: 5 } }); key(main, 'Enter', { shiftKey: true });
    expect(view.getMarkdown()).not.toContain('  \n');
  });
});
