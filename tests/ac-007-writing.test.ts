// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { startCompletion, currentCompletions, setSelectedCompletion } from '@codemirror/autocomplete';
import { LivePreviewView } from '../src/markdown-view/livepreview';
import { parseTablePaste, pasteTable, resizeTable, runTableOperation, tableModel } from '../src/markdown-view/table-model';
import { tableCellAt } from '../src/markdown-view/table-viewport';
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
const SOURCE = '前\n\n| A | B | C |\n|:---|---:|---|\n| a | b | c |\n| d | e | f |\n\n后';

describe('007 AC-30 连续写作', () => {
  it.each([['bold', '**'], ['italic', '*'], ['strike', '~~'], ['inlineCode', '`']] as const)('%s连续输入空格与下一词仍渲染，Enter结束当前格式', async (cmd, mark) => {
    const { view, main } = await mount(''); view.runFormat(cmd);
    type(main, 'first ');
    expect(view.getMarkdown()).toBe(mark + 'first' + mark + ' ');
    await until(() => !main.contentDOM.textContent?.includes(mark));
    type(main, 'second'); expect(view.getMarkdown()).toBe(mark + 'first second' + mark);
    key(main, 'Enter'); type(main, 'plain');
    expect(view.getMarkdown()).toBe(mark + 'first second' + mark + '\nplain');
  });
  it('待输入格式可取消，移动光标和切只读清除状态，空格不生成空标记', async () => {
    const { view, main } = await mount(''); view.runFormat('bold'); view.runFormat('bold');
    type(main, 'plain'); expect(view.getMarkdown()).toBe('plain');
    view.runFormat('bold'); main.dispatch({ selection: { anchor: 0 } }); type(main, 'x');
    expect(view.getMarkdown()).toBe('xplain');
    view.runFormat('bold'); view.setReadOnly(true); view.setReadOnly(false); type(main, 'y');
    expect(view.getMarkdown()).toBe('xyplain');
    main.dispatch({ selection: { anchor: main.state.doc.length } }); view.runFormat('bold');
    type(main, '  z'); expect(view.getMarkdown()).toBe('xyplain  **z**');
  });
  it('待输入加粗在组合结束才包裹，单次撤销清除整次组合', async () => {
    const { view, main } = await mount(''); view.runFormat('bold');
    main.dispatch({ effects: compositionChanged.of(true) });
    main.dispatch({ changes: { from: 0, insert: '中文' }, selection: { anchor: 2 }, userEvent: 'input.type.compose.start' });
    expect(view.getMarkdown()).toBe('中文');
    main.dispatch({ effects: compositionChanged.of(false) });
    expect(view.getMarkdown()).toBe('**中文**'); view.cmUndo(); expect(view.getMarkdown()).toBe('');
  });
  it.each([['bold', '**', 'mdir-strong'], ['italic', '*', 'mdir-em'], ['strike', '~~', 'mdir-strike'], ['inlineCode', '`', 'mdir-icode']] as const)('空%s不插模板，输入持续渲染且一次撤销', async (cmd, mark, cls) => {
    const { view, main } = await mount('');
    view.runFormat(cmd); expect(view.getMarkdown()).toBe('');
    type(main, 'word'); expect(view.getMarkdown()).toBe(mark + 'word' + mark);
    await until(() => !!main.contentDOM.querySelector('.' + cls));
    expect(main.contentDOM.textContent).toBe('word');
    view.runFormat(cmd); type(main, ' plain');
    expect(view.getMarkdown()).toBe(mark + 'word' + mark + ' plain');
  });
  it('选区加粗保持渲染，撤销恢复原文', async () => {
    const { view, main } = await mount('word');
    main.dispatch({ selection: { anchor: 0, head: 4 } }); view.runFormat('bold');
    await until(() => main.contentDOM.textContent === 'word');
    expect(view.getMarkdown()).toBe('**word**'); view.cmUndo(); expect(view.getMarkdown()).toBe('word');
  });
  it('首行标题不因默认光标显示井号', async () => {
    const { main } = await mount('# Heading');
    await until(() => main.contentDOM.textContent === 'Heading');
    expect(main.state.doc.toString()).toBe('# Heading');
  });
  it('输入井号成标题期间保持源码可见（v0.39 活动显隐）', async () => {
    const { view, main } = await mount('正文');
    await until(() => main.contentDOM.textContent === '正文');
    main.dispatch({ selection: { anchor: 0 }, userEvent: 'select.pointer' });
    type(main, '### ');
    await until(() => main.contentDOM.textContent?.includes('###'));
    expect(view.getMarkdown()).toBe('### 正文');
  });
  it('用户交互后光标进入标题行显井号，离开恢复渲染（v0.39）', async () => {
    const source = '# 标题\n\n正文';
    const { main } = await mount(source);
    await until(() => !main.contentDOM.textContent?.includes('#'));
    main.dispatch({ selection: { anchor: 3 }, userEvent: 'select.pointer' });
    await until(() => main.contentDOM.textContent?.includes('#'));
    main.dispatch({ selection: { anchor: source.indexOf('正') }, userEvent: 'select.pointer' });
    await until(() => !main.contentDOM.textContent?.includes('#'));
    expect(main.state.doc.toString()).toBe(source);
  });
  it('Setext 标题光标进入显下划线（v0.39）', async () => {
    const source = '标题\n===\n\n正文';
    const { main } = await mount(source);
    await until(() => !main.contentDOM.textContent?.includes('==='));
    main.dispatch({ selection: { anchor: 2 }, userEvent: 'select.pointer' });
    await until(() => !!main.contentDOM.textContent?.includes('==='));
    expect(main.state.doc.toString()).toBe(source);
  });
  it('空语言中选中bash再Enter，先写入候选再进正文，标签不回退text', async () => {
    const { main, host } = await mount('```\n\n```\n\n后');
    await until(() => !!host.querySelector('.mdir-codelabel'));
    host.querySelector<HTMLButtonElement>('.mdir-codelabel')!.click();
    startCompletion(main);
    await until(() => currentCompletions(main.state).some(c => c.label === 'bash'));
    main.dispatch({ effects: setSelectedCompletion(currentCompletions(main.state).findIndex(c => c.label === 'bash')) });
    // 模拟候选已稳定可交互的真实选择，不绕开acceptCompletion的交互延时。
    await new Promise(resolve => setTimeout(resolve, 90));
    key(main, 'Enter');
    expect(main.state.doc.toString()).toBe('```bash\n\n```\n\n后');
    expect(main.state.selection.main.head).toBe(8);
    await until(() => host.querySelector('.mdir-codelabel')?.textContent === 'bash');
  });
  it('下划线标题在光标进入后仍隐藏标记，跨块选择可达源码且不改原文', async () => {
    const source = '标题\n===\n\n正文';
    const { main, host } = await mount(source);
    main.dispatch({ selection: { anchor: source.length } });
    await until(() => !main.contentDOM.textContent?.includes('==='));
    expect(host.querySelectorAll('.mdir-h1')).toHaveLength(1);
    main.dispatch({ selection: { anchor: 1 } });
    expect(main.contentDOM.textContent).not.toContain('===');
    main.dispatch({ selection: { anchor: 1, head: source.length } });
    await until(() => !!main.contentDOM.textContent?.includes('==='));
    expect(main.state.doc.toString()).toBe(source);
  });
  it('段落分隔空行保持原文，进入可输入；不带显式选区的插入立即恢复正文并可撤销', async () => {
    const source = '# 标题\n\n\n正文\n';
    const { main, host } = await mount(source);
    main.dispatch({ selection: { anchor: source.indexOf('正文') } });
    await until(() => host.querySelectorAll('.mdir-gap').length === 3);
    expect(main.state.doc.toString()).toBe(source);
    main.dispatch({ selection: { anchor: 5 } });
    await until(() => !!host.querySelector('.mdir-gap-active'));
    main.dispatch({ changes: { from: 5, insert: '新段落' }, userEvent: 'input.type' });
    await until(() => [...host.querySelectorAll('.cm-line')].some(e => e.textContent === '新段落' && !e.classList.contains('mdir-gap')));
    expect(undo(main)).toBe(true);
    expect(main.state.doc.toString()).toBe(source);
  });
  it('代码内空行保持正文，紧邻标题和列表的块间距不插入源字符', async () => {
    const source = '# 标题\n正文\n- 一\n- 二\n\n> ```js\n> a();\n>\n> b();\n> ```\n\n尾';
    const { main, host } = await mount(source);
    main.dispatch({ selection: { anchor: source.length } });
    await until(() => host.querySelectorAll('.mdir-block-space').length >= 3);
    const codeEmpty = [...host.querySelectorAll('.mdir-code')].find(e => !e.textContent?.trim());
    expect(codeEmpty).toBeDefined(); expect(codeEmpty!.classList.contains('mdir-gap')).toBe(false);
    expect(main.state.doc.toString()).toBe(source);
  });
  it('在表格和图表之前新建bash块，语言输入保留源行，Enter就地闭合不吞后文', async () => {
    const tail = '\n\n| A | B |\n|---|---|\n| a | b |\n\n公式 $x^2$\n\n```mermaid\ngraph LR\n A-->B\n```\n\n末段';
    const { main, host } = await mount(tail);
    type(main, '```');
    await until(() => !!main.contentDOM.textContent?.includes('```'));
    type(main, 'bash'); key(main, 'Enter');
    expect(main.state.doc.toString()).toBe('```bash\n\n```' + tail);
    type(main, 'echo hi'); key(main, 'Enter', { ctrlKey: true });
    await until(() => !!host.querySelector('table'));
    expect(host.querySelector('.mdir-codelabel')?.textContent).toBe('bash');
    expect(main.state.doc.toString()).toBe('```bash\necho hi\n```' + tail);
  });
  it('修改已有语言后Enter进入原正文，不增空行且单步撤销语言修改', async () => {
    const source = '```js\nconst x = 1;\n```\n\n后';
    const { main, host } = await mount(source);
    await until(() => !!host.querySelector('.mdir-codelabel'));
    host.querySelector<HTMLButtonElement>('.mdir-codelabel')!.click();
    type(main, 'bash'); key(main, 'Enter');
    expect(main.state.doc.toString()).toBe(source.replace('```js', '```bash'));
    expect(main.state.selection.main.head).toBe(8);
    expect(undo(main)).toBe(true); expect(main.state.doc.toString()).toBe(source);
  });
  it.each([['Backspace', 8], ['Delete', 10], ['Backspace', 14], ['Backspace', 15]] as const)(
    '代码边界%s(%s)不能删一半围栏或拼接闭合行', async (name, position) => {
      const source = '```bash\nls\n```\n\n| A | B |\n|---|---|\n| a | b |\n\n后';
      const { main, host } = await mount(source);
      await until(() => !!host.querySelector('.mdir-codelabel'));
      main.dispatch({ selection: { anchor: position } }); key(main, name);
      expect(main.state.doc.toString()).toBe(source);
      expect(host.querySelector('table')).not.toBeNull();
    });
  it('文件末代码体向右不会把光标留在隐藏闭合行，继续输入不跳到首字符前', async () => {
    const source = '```bash\nls\n```';
    const { main, host } = await mount(source);
    await until(() => !!host.querySelector('.mdir-codelabel'));
    main.dispatch({ selection: { anchor: 10 } }); key(main, 'ArrowRight'); type(main, 'X');
    expect(main.state.doc.toString()).toBe('```bash\nlsX\n```');
  });
  it.each([
    ['未闭合围栏', '```bash\nx', ''],
    ['闭合围栏及后文', '```bash\nx\n```\n\n后', '\n\n后'],
  ])('代码内容删空后Backspace移除%s，后文保留且单步撤销恢复', async (_name, source, remaining) => {
    const { main, host } = await mount(source);
    const body = source.indexOf('x');
    main.dispatch({ selection: { anchor: body + 1 } }); key(main, 'Backspace');
    expect(main.state.doc.toString()).toBe(source.replace('x', ''));
    const emptyBody = main.state.doc.line(2);
    main.dispatch({ selection: { anchor: emptyBody.from } }); key(main, 'Backspace');
    expect(main.state.doc.toString()).toBe(remaining);
    expect(host.querySelector('.mdir-codelabel')).toBeNull();
    expect(undo(main)).toBe(true);
    expect(main.state.doc.toString()).toBe(source.replace('x', ''));
  });
  it('跨完整代码块的明确选择仍可删除并单步撤销', async () => {
    const source = '前\n\n```js\nx\n```\n\n后';
    const { main } = await mount(source);
    main.dispatch({ selection: { anchor: 3, head: source.indexOf('后') } }); key(main, 'Backspace');
    expect(main.state.doc.toString()).toBe('前\n\n后');
    undo(main); expect(main.state.doc.toString()).toBe(source);
  });
  it('只在表头末Enter建表，打开和普通编辑保留原始竖线文本，撤销恢复表头', async () => {
    const source = '| 标题 | 值 |';
    const { main, host } = await mount(source);
    expect(main.state.doc.toString()).toBe(source); expect(host.querySelector('table')).toBeNull();
    main.dispatch({ selection: { anchor: source.length } }); main.focus(); key(main, 'Enter');
    await until(() => !!host.querySelector('table'));
    expect(tableModel(main.state, 0)?.rows).toEqual([['标题', '值'], ['---', '---'], ['', '']]);
    expect(undo(main)).toBe(true); expect(main.state.doc.toString()).toBe(source);
  });
  it('代码中的竖线表头不会建表，普通段落仍正常换行', async () => {
    const { main } = await mount('```text\n| a | b |\n```');
    main.dispatch({ selection: { anchor: 18 } }); key(main, 'Enter');
    expect(main.state.doc.toString()).not.toContain('| --- |');
  });
  it('列表续写、第二空项Enter退出；Tab嵌套后Shift+Tab恢复', async () => {
    const { main } = await mount('- 一');
    main.dispatch({ selection: { anchor: 3 } }); key(main, 'Enter');
    expect(main.state.doc.toString()).toBe('- 一\n- ');
    key(main, 'Enter'); expect(main.state.doc.toString()).toBe('- 一\n\n');
    type(main, '- 二'); key(main, 'Tab'); expect(main.state.doc.toString()).toContain('    - 二');
    key(main, 'Tab', { shiftKey: true }); expect(main.state.doc.toString()).toBe('- 一\n\n- 二');
  });
  it('围栏Enter补闭合，已有闭围栏不重复；闭围栏末Enter退出', async () => {
    const { main } = await mount('```js');
    main.dispatch({ selection: { anchor: 5 } }); key(main, 'Enter');
    expect(main.state.doc.toString()).toBe('```js\n\n```');
    expect(main.state.selection.main.head).toBe(6);
    main.dispatch({ selection: { anchor: main.state.doc.length } }); key(main, 'Enter');
    expect(main.state.doc.toString()).toBe('```js\n\n```\n');
    main.dispatch({ selection: { anchor: 5 } }); key(main, 'Enter');
    expect(main.state.doc.toString().match(/```/g)).toHaveLength(2);
  });
  it('代码体及闭合行光标均不泄漏围栏；语言入口只展开起始行，退出后原文不变', async () => {
    const source = '```js\nconst x = 1;\n```\n\n后';
    const { main, host } = await mount(source);
    await until(() => !!host.querySelector('.mdir-codehead'));
    main.dispatch({ selection: { anchor: source.indexOf('```', 3) + 1 } });
    await until(() => !main.contentDOM.textContent?.includes('```'));
    host.querySelector<HTMLButtonElement>('.mdir-codelabel')!.click();
    await until(() => !!main.contentDOM.textContent?.includes('```js'));
    expect(main.state.doc.sliceString(main.state.selection.main.from, main.state.selection.main.to)).toBe('js');
    main.dispatch({ selection: { anchor: source.indexOf('const') + 2 } });
    key(main, 'Enter', { ctrlKey: true });
    expect(main.state.doc.toString()).toBe(source);
    expect(main.state.selection.main.head).toBe(source.indexOf('\n\n后') + 1);
    await until(() => !main.contentDOM.textContent?.includes('```'));
  });
  it('文末代码体Mod+Enter创建段落且可单步撤销，只读不创建', async () => {
    const source = '```\nls\n```';
    const { main, view } = await mount(source);
    main.dispatch({ selection: { anchor: 6 } }); key(main, 'Enter', { ctrlKey: true });
    expect(main.state.doc.toString()).toBe(source + '\n\n');
    expect(undo(main)).toBe(true); expect(main.state.doc.toString()).toBe(source);
    view.setReadOnly(true); key(main, 'Enter', { ctrlKey: true });
    expect(main.state.doc.toString()).toBe(source);
  });
  it('四字符围栏内的短围栏是正文；只读切换同步禁用语言入口，嵌套块保留缩进', async () => {
    const source = '> ````js\n> ```\n> const x = 1;\n> ````\n\n后';
    const { main, view, host } = await mount(source);
    await until(() => !!host.querySelector('.mdir-codehead'));
    expect(main.contentDOM.textContent?.match(/```/g)).toHaveLength(1);
    expect(host.querySelector<HTMLElement>('.mdir-codehead')!.style.getPropertyValue('--mdir-code-inset')).toBe('19px');
    view.setReadOnly(true);
    await until(() => host.querySelector<HTMLButtonElement>('.mdir-codelabel')!.disabled);
    view.setReadOnly(false);
    await until(() => !host.querySelector<HTMLButtonElement>('.mdir-codelabel')!.disabled);
    expect(main.state.doc.toString()).toBe(source);
  });
  it('已有空代码块折叠全部围栏，点空白体建立编辑行且单步撤销还原原文', async () => {
    const source = '```\n```\n\n后';
    const { main, host } = await mount(source);
    await until(() => !!host.querySelector('.mdir-codeempty'));
    expect(main.contentDOM.textContent).not.toContain('```');
    host.querySelector('.mdir-codeempty')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(main.state.doc.toString()).toBe('```\n\n```\n\n后');
    expect(undo(main)).toBe(true); expect(main.state.doc.toString()).toBe(source);
  });
  it('引用内空代码块建立编辑行保留引用前缀', async () => {
    const source = '> ```\n> ```\n\n后';
    const { main, host } = await mount(source);
    await until(() => !!host.querySelector('.mdir-codeempty'));
    host.querySelector('.mdir-codeempty')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(main.state.doc.toString()).toBe('> ```\n> \n> ```\n\n后');
    expect(undo(main)).toBe(true); expect(main.state.doc.toString()).toBe(source);
  });
  it('双标记自动补齐、闭合键越过补齐部分，空对可一次退格；三枚星号可输入分隔线', async () => {
    const { main } = await mount('');
    type(main, '**'); expect(main.state.doc.toString()).toBe('****'); expect(main.state.selection.main.head).toBe(2);
    key(main, 'Backspace'); expect(main.state.doc.toString()).toBe('');
    type(main, '**文字**'); expect(main.state.doc.toString()).toBe('**文字**'); expect(main.state.selection.main.head).toBe(6);
    type(main, '\n***'); expect(main.state.doc.toString()).toBe('**文字**\n***');
  });
});

describe('007 AC-31 表格主事务', () => {
  it('大表仅挂载行窗口，跨窗Tab保持逻辑行；离屏活动格保留DOM、主历史可撤销', async () => {
    const source = '| A | B |\n|---|---|\n' + Array.from({ length: 220 }, (_, i) => `| a${i} | b${i} |`).join('\n') + '\n\n后';
    const { main, host } = await mount(source);
    await until(() => !!host.querySelector('.mdir-table'));
    const box = host.querySelector<HTMLElement>('.mdir-tablebox')!;
    expect(host.querySelectorAll('tr[data-md-row]').length).toBeLessThan(80);
    const cell = tableCellAt(box, 180, 1)!;
    expect(cell.textContent).toBe('b179');
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const dom = cell.querySelector('.cm-editor')!;
    const editor = EditorView.findFromDOM(dom)!;
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: '改' }, userEvent: 'input.type' });
    tableCellAt(box, 210, 0);
    await until(() => main.state.doc.toString().includes('b179改'));
    expect(cell.querySelector('.cm-editor')).toBe(dom);
    key(editor, 'Tab');
    await until(() => !!box.querySelector('[data-md-row="181"] .cm-editor'));
    expect(box.querySelector('[data-md-row="181"] .cm-content')?.textContent).toBe('a180');
    expect(undo(main)).toBe(true);
    expect(main.state.doc.toString()).toBe(source);
  });
  it('列移动同时移动表头、对齐和数据，逐次单步撤销', async () => {
    const { main } = await mount(SOURCE); const pos = SOURCE.indexOf('|');
    runTableOperation(main, pos, 1, 0, 'colNext');
    expect(tableModel(main.state, pos)?.rows).toEqual([['B', 'A', 'C'], ['---:', ':---', '---'], ['b', 'a', 'c'], ['e', 'd', 'f']]);
    runTableOperation(main, pos, 1, 1, 'center');
    expect(tableModel(main.state, pos)?.rows[1]?.[1]).toBe(':---:');
    undo(main); expect(tableModel(main.state, pos)?.rows[1]?.[1]).toBe(':---');
    undo(main); expect(main.state.doc.toString()).toBe(SOURCE);
  });
  it('正文行移动不动表头，保留表格前后文字；尺寸缩小与扩展均可撤销', async () => {
    const { main } = await mount(SOURCE); const pos = SOURCE.indexOf('|');
    expect(runTableOperation(main, pos, 0, 0, 'rowDown')).toBeNull();
    runTableOperation(main, pos, 1, 1, 'rowDown');
    expect(tableModel(main.state, pos)?.rows[2]).toEqual(['d', 'e', 'f']);
    undo(main); expect(main.state.doc.toString()).toBe(SOURCE);
    resizeTable(main, pos, 3, 4); expect(tableModel(main.state, pos)?.rows).toHaveLength(5);
    expect(tableModel(main.state, pos)?.rows[1]).toEqual([':---', '---:', '---', '---']);
    resizeTable(main, pos, 1, 1); expect(tableModel(main.state, pos)?.rows).toEqual([['A'], [':---'], ['a']]);
    expect(main.state.doc.toString().startsWith('前\n\n')).toBe(true); expect(main.state.doc.toString().endsWith('\n\n后')).toBe(true);
    undo(main); undo(main); expect(main.state.doc.toString()).toBe(SOURCE);
  });
  it('矩形粘贴处理转义竖线、带引号换行、尾部空行；扩格不覆盖矩形外内容', async () => {
    const { main } = await mount(SOURCE); const pos = SOURCE.indexOf('|');
    const grid = parseTablePaste('x|y\t"a\nb"\t\r\n末\t值\t扩\r\n')!;
    expect(grid).toEqual([['x\\|y', 'a<br>b', ''], ['末', '值', '扩']]);
    pasteTable(main, pos, 2, 1, grid);
    expect(tableModel(main.state, pos)?.rows).toEqual([['A', 'B', 'C', ''], [':---', '---:', '---', '---'],
      ['a', 'b', 'c', ''], ['d', 'x\\|y', 'a<br>b', ''], ['', '末', '值', '扩']]);
    undo(main); expect(main.state.doc.toString()).toBe(SOURCE);
  });
  it('引用表格移动/粘贴保留前缀，缺省格右移不误删相邻内容', async () => {
    const source = '> | A | B | C |\n> |---|---|---|\n> | 保留 |\n';
    const { main } = await mount(source);
    runTableOperation(main, 2, 1, 1, 'colNext');
    expect(tableModel(main.state, 2)?.rows[2]).toEqual(['保留', '', '']);
    pasteTable(main, 2, 1, 1, [['甲', '乙']]);
    expect(main.state.doc.toString()).toContain('\n> | 保留 | 甲 | 乙 |');
    undo(main); undo(main); expect(main.state.doc.toString()).toBe(source);
  });
  it('Ctrl+Enter在当前格下插行并恢复同列，工具条对齐、尺寸和只读守卫可达', async () => {
    const { main, host, view } = await mount(SOURCE);
    const cell = host.querySelectorAll('tbody tr')[0]!.querySelectorAll('td')[1]!;
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    let editor = EditorView.findFromDOM(host.querySelector('td .cm-editor')!)!;
    key(editor, 'Enter', { ctrlKey: true });
    await until(() => host.querySelectorAll('tbody tr').length === 3 && !!host.querySelector('td .cm-editor'));
    editor = EditorView.findFromDOM(host.querySelector('td .cm-editor')!)!;
    expect(editor.contentDOM.getAttribute('aria-label')).toBe('表格第 3 行第 2 列');
    const select = host.querySelector<HTMLSelectElement>('.mdir-tabletools select')!;
    select.value = 'right'; select.dispatchEvent(new Event('change'));
    await until(() => !!host.querySelector('td .cm-editor'));
    expect(tableModel(main.state, SOURCE.indexOf('|'))?.rows[1]?.[1]).toBe('---:');
    view.setReadOnly(true);
    const before = main.state.doc.toString();
    expect(resizeTable(main, SOURCE.indexOf('|'), 5, 5)).toBe(false);
    expect(pasteTable(main, SOURCE.indexOf('|'), 1, 0, [['改']])).toBe(false);
    expect(main.state.doc.toString()).toBe(before);
  });
});

describe('007 围栏行首光标回退（IR 键入不落到块外）', () => {
  const FENCED = '前段\n\n```rust\nfn main() {\n}\n```\n\n后段';
  it('空选区落在闭合围栏行行首 → 回退到块内末行末尾', async () => {
    const { main } = await mount(FENCED);
    const close = main.state.doc.toString().indexOf('```', main.state.doc.toString().indexOf('fn main'));
    const closeFrom = main.state.doc.lineAt(close).from;
    main.dispatch({ selection: { anchor: closeFrom } });
    expect(main.state.selection.main.head).toBe(closeFrom - 1);
    expect(main.state.doc.lineAt(main.state.selection.main.head).text).toBe('}');
  });
  it('空选区落在开启围栏行行首 → 回退到块上一行末尾', async () => {
    const { main } = await mount(FENCED);
    const open = main.state.doc.toString().indexOf('```rust');
    const openFrom = main.state.doc.lineAt(open).from;
    main.dispatch({ selection: { anchor: openFrom } });
    expect(main.state.selection.main.head).toBe(openFrom - 1);
  });
  it('块内正文位置与块外位置不受影响', async () => {
    const { main } = await mount(FENCED);
    const body = main.state.doc.toString().indexOf('fn main');
    main.dispatch({ selection: { anchor: body + 2 } });
    expect(main.state.selection.main.head).toBe(body + 2);
    const tail = main.state.doc.length - 3;
    main.dispatch({ selection: { anchor: tail } });
    expect(main.state.selection.main.head).toBe(tail);
  });
  it('选区（非空）不干预；显式围栏编辑事务放行', async () => {
    const { main } = await mount(FENCED);
    const close = main.state.doc.toString().indexOf('```', main.state.doc.toString().indexOf('fn main'));
    const closeFrom = main.state.doc.lineAt(close).from;
    main.dispatch({ selection: { anchor: closeFrom - 2, head: closeFrom } });
    expect(main.state.selection.main.head).toBe(closeFrom);
    const open = main.state.doc.toString().indexOf('```rust');
    const openFrom = main.state.doc.lineAt(open).from;
    const { fenceSourceChanged } = await import('../src/markdown-view/writing');
    main.dispatch({ selection: { anchor: openFrom + 3 }, effects: fenceSourceChanged.of(openFrom) });
    expect(main.state.selection.main.head).toBe(openFrom + 3);
  });
});

describe('007 空列表项回车退出（通行编辑习惯）', () => {
  it('空项回车摘标记；后续仍有列表项时补空行，键入段落不被懒续行进上一项', async () => {
    const { view, main } = await mount('- 甲\n- \n- 乙');
    const line = main.state.doc.line(2);
    main.dispatch({ selection: { anchor: line.to } });
    key(main, 'Enter');
    expect(view.getMarkdown()).toBe('- 甲\n\n\n- 乙');
    type(main, '段');
    expect(view.getMarkdown()).toBe('- 甲\n\n段\n- 乙');
  });
  it('末项空项回车不补空行（文末无需分隔）', async () => {
    const { view, main } = await mount('- 甲\n- ');
    const line = main.state.doc.line(2);
    main.dispatch({ selection: { anchor: line.to } });
    key(main, 'Enter');
    expect(view.getMarkdown()).toBe('- 甲\n\n');
  });
  it('任务列表空项同口径退出', async () => {
    const { view, main } = await mount('- [ ] 甲\n- [ ] \n- [ ] 乙');
    const line = main.state.doc.line(2);
    main.dispatch({ selection: { anchor: line.to } });
    key(main, 'Enter');
    type(main, '段');
    expect(view.getMarkdown()).toBe('- [ ] 甲\n\n段\n- [ ] 乙');
  });
});

describe('007 列表项行首 Backspace 摘除标记（通行编辑习惯）', () => {
  it('顶层无序/有序/任务项：内容顶到行首，不留等宽空格', async () => {
    const { view, main } = await mount('- 甲\n- 乙');
    main.dispatch({ selection: { anchor: main.state.doc.toString().indexOf('乙') } });
    key(main, 'Backspace');
    expect(view.getMarkdown()).toBe('- 甲\n乙');
    const v2 = await mount('1. 甲\n2. 乙');
    v2.main.dispatch({ selection: { anchor: v2.main.state.doc.toString().indexOf('乙') } });
    key(v2.main, 'Backspace');
    expect(v2.view.getMarkdown()).toBe('1. 甲\n乙');
    const v3 = await mount('- [ ] 甲\n- [ ] 乙');
    v3.main.dispatch({ selection: { anchor: v3.main.state.doc.toString().indexOf('乙') } });
    key(v3.main, 'Backspace');
    expect(v3.view.getMarkdown()).toBe('- [ ] 甲\n乙');
  });
  it('嵌套项：摘标记保留基准缩进（成为父项段落内容）', async () => {
    const { view, main } = await mount('- 甲\n  - 乙');
    main.dispatch({ selection: { anchor: main.state.doc.toString().indexOf('乙') } });
    key(main, 'Backspace');
    expect(view.getMarkdown()).toBe('- 甲\n  乙');
  });
  it('项内其他位置与代码块内不干预', async () => {
    const { main } = await mount('- 甲乙');
    main.dispatch({ selection: { anchor: main.state.doc.toString().indexOf('乙') } });
    key(main, 'Backspace');
    expect(main.state.doc.toString()).toBe('- 乙');
    const v2 = await mount('```\n- 甲\n```');
    const p = v2.main.state.doc.toString().indexOf('甲');
    v2.main.dispatch({ selection: { anchor: p } });
    key(v2.main, 'Backspace');
    expect(v2.main.state.doc.toString()).toBe('```\n-甲\n```');
  });
});
