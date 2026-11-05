// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCompletion, acceptCompletion } from '@codemirror/autocomplete';
import { undo } from '@codemirror/commands';
import { LivePreviewView } from '../src/markdown-view/livepreview';
import { extractMarkdownMetadata } from '../src/markdown-view/headings';
import { renderStaticHtml, staticMarkdownParser } from '../src/markdown-view/static-html';
import { applyDocumentMetadata, renderMarkdown, renderMarkdownInline } from '../src/markdown-view/preview';
import { createBlockRenderer } from '../src/markdown-view/blockcache';

vi.mock('../src/common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textReadAll: async () => '', textSave: async () => {} }));
vi.mock('../src/markdown-view/preview', async original => ({ ...await original<object>(), loadUnicodeEmojis: async () => ({ smile: '\u{1f604}' }) }));
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
const mounted: LivePreviewView[] = [];
afterEach(() => { mounted.splice(0).forEach(view => view.destroy()); document.body.replaceChildren(); });
async function until(test: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(test()).toBe(true), { timeout: 2500, interval: 15 });
}
async function mount(source: string, openMarkdown?: (path: string) => void) {
  const host = document.createElement('div'); document.body.append(host);
  const editor = new LivePreviewView(host, { path: 'E:/semantics.md', encoding: 'UTF-8', initialDoc: source,
    onStatus: () => {}, onSaved: () => {}, openMarkdown });
  mounted.push(editor); await until(() => !!editor.view);
  editor.view.dispatch({ selection: { anchor: source.length } });
  return { host, editor };
}

describe('007-AC-32 文档扩展语义', () => {
  it('自动链接索引排除代码、转义和显式目标，静态投影安全且可按块切片', () => {
    const source = '<https://example.test/a> 、 https://example.test/b 、 <writer@example.test> 、 www.example.test\n\n`https://code.test` \\<not-a-link> [标签](https://target.test)\n\n```md\nhttps://fenced.test\n```';
    const metadata = extractMarkdownMetadata(source);
    expect(metadata.autoLinks.map(range => source.slice(range.from, range.to))).toEqual([
      '<https://example.test/a>', 'https://example.test/b', '<writer@example.test>', 'www.example.test',
    ]);
    const tree = staticMarkdownParser.parse(source);
    const projected = renderStaticHtml(source, tree, metadata);
    const links = document.createElement('div'); links.innerHTML = projected;
    expect([...links.querySelectorAll('a')].map(link => [link.getAttribute('href'), link.textContent])).toEqual([
      ['https://example.test/a', 'https://example.test/a'], ['https://example.test/b', 'https://example.test/b'],
      ['mailto:writer@example.test', 'writer@example.test'], ['http://www.example.test', 'www.example.test'],
      ['https://target.test', '标签'],
    ]);
    expect(links.querySelector('code')?.textContent).toBe('https://code.test');
    expect(links.querySelector('pre>code')?.textContent).toBe('https://fenced.test\n');
    links.innerHTML = renderStaticHtml(source, tree, metadata, 0, tree.topNode.firstChild!.to);
    expect(links.querySelectorAll('a')).toHaveLength(4);
    const hostile = '<https://example.test/?q="&x=1>';
    const safe = renderStaticHtml(hostile, staticMarkdownParser.parse(hostile), extractMarkdownMetadata(hostile));
    const host = document.createElement('div'); host.innerHTML = safe;
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.test/?q=%22&x=1');
    expect(host.querySelector('a')?.textContent).toBe('https://example.test/?q="&x=1');
    expect(host.querySelectorAll('a')).toHaveLength(1);
    const punctuation = '<https://example.test/$x$**bold**==hi==?q=&amp;>';
    const literal = renderStaticHtml(punctuation, staticMarkdownParser.parse(punctuation), extractMarkdownMetadata(punctuation));
    host.innerHTML = literal;
    expect(host.querySelector('a')?.textContent).toBe(punctuation.slice(1, -1));
    expect(host.querySelector('a strong,a mark,[data-render-kind]')).toBeNull();
  });

  it('重复标题编号跳过真实标题后缀占用，仍保持文档顺序', () => {
    const source = '# Repeat\n\n# Repeat-1\n\n# Repeat\n\n# Repeat-1\n\n# Repeat';
    expect(extractMarkdownMetadata(source).headings.map(heading => heading.id))
      .toEqual(['repeat', 'repeat-1', 'repeat-2', 'repeat-1-1', 'repeat-3']);
  });

  it('表外输入和相同索引刷新保留格内节点，脚注重新编号仍更新显示', async () => {
    const source = '| A |\n|---|\n| [^n] |\n\nTail\n\n[^n]: note';
    const { host, editor } = await mount(source);
    await until(() => !!host.querySelector('td a[data-md-note]'));
    const link = host.querySelector('td a[data-md-note]');
    editor.view.dispatch({ changes: { from: 0, insert: 'Before\n\n' } });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(host.querySelector('td a[data-md-note]')).toBe(link);
    editor.view.dispatch({ changes: [{ from: 0, insert: 'First[^m]\n\n' },
      { from: editor.view.state.doc.length, insert: '\n\n[^m]: first note' }] });
    await until(() => host.querySelector('td a[data-md-note]')?.textContent === '2');
    expect(editor.view.state.doc.toString()).toContain('| [^n] |');
  });

  it('公式引用Ctrl点击映射到当前源范围，包含前缀移动与只读选择', async () => {
    const source = 'Reference $\\eqref{energy}$\n\n$$\n\\begin{equation}E=mc^2\\label{energy}\\end{equation}\n$$\n\nEnd';
    const { host, editor } = await mount(source);
    editor.view.dispatch({ changes: { from: 0, insert: 'Prefix\n\n' } });
    const expected = editor.view.state.doc;
    const target = host.querySelector('.md-render-target')!;
    const link = document.createElementNS('http://www.w3.org/2000/svg', 'a');
    link.setAttribute('href', '#mjx-eqn%3Aenergy'); target.append(link);
    editor.setReadOnly(true);
    link.dispatchEvent(new MouseEvent('mousedown', { ctrlKey: true, bubbles: true, cancelable: true }));
    expect(editor.view.state.selection.main.head).toBe(expected.toString().indexOf('$$') + 1);
    expect(editor.view.state.doc).toBe(expected);
  });

  it('多段脚注保留源范围和首次引用编号，重复引用同号，代码及转义不进入索引', () => {
    const source = 'B[^b] A[^a] B[^b] \\[^literal] `[^code]`\n\n[^a]: first\n\n    second **bold**\n\n[^b]: other\n\n```md\n[^fake]: fake\n```\n\nAfter';
    const metadata = extractMarkdownMetadata(source);
    expect(metadata.footnotes.map(note => [note.label, note.number, note.references.length])).toEqual([['B', 1, 2], ['A', 2, 1]]);
    const note = metadata.footnotes[1]!;
    expect(note.body).toBe('first\n\nsecond **bold**');
    expect(source.slice(note.from, note.to)).toBe('[^a]: first\n\n    second **bold**');
    expect(metadata.references).toEqual({});
  });

  it('脚注与上标的静态投影只改语法节点，代码和转义保持原样', () => {
    const source = 'A[^n] x^2^ `x^3^` \\^4^\n\n[^n]: y^5^';
    const metadata = extractMarkdownMetadata(source);
    const root = document.createElement('div');
    root.innerHTML = renderStaticHtml(source, staticMarkdownParser.parse(source), metadata);
    expect([...root.querySelectorAll('sup:not(.footnotes-ref)')].map(node => node.textContent)).toEqual(['2', '5']);
    expect(root.querySelector('code')?.textContent).toBe('x^3^');
    expect(root.textContent).toContain('^4^');
  });

  it('静态脚注按首次引用重排编号与全部目标，缓存重复处理不互换编号', () => {
    const source = 'B[^b] A[^a] B[^b]\n\n[^a]: first\n\n[^b]: second';
    const root = document.createElement('div');
    root.innerHTML = '<p><sup class="footnotes-ref" id="footnotes-ref-2"><a href="#footnotes-def-2">2</a></sup><sup class="footnotes-ref" id="footnotes-ref-1"><a href="#footnotes-def-1">1</a></sup><sup class="footnotes-ref" id="footnotes-ref-2:2"><a href="#footnotes-def-2">2</a></sup></p><ol class="footnotes-defs-ol"><li id="footnotes-def-1">first<a href="#footnotes-ref-1">back</a></li><li id="footnotes-def-2">second<a href="#footnotes-ref-2:2">back2</a></li></ol>';
    for (let pass = 0; pass < 2; pass++) {
      applyDocumentMetadata(root, source, extractMarkdownMetadata(source));
      expect([...root.querySelectorAll('.footnotes-ref a')].map(a => a.textContent)).toEqual(['1', '2', '1']);
      expect([...root.querySelectorAll('.footnotes-ref')].map(a => a.id)).toEqual(['footnotes-ref-1', 'footnotes-ref-2', 'footnotes-ref-1:2']);
      expect(root.querySelector('.footnotes-defs-ol li')?.textContent).toBe('secondback2');
      expect(root.querySelector('.footnotes-defs-ol li a')?.getAttribute('href')).toBe('#footnotes-ref-1:2');
    }
  });

  it('重复标题、Front Matter、目录在全文与块缓存复用后仍一致', async () => {
    const source = '---\ntitle: metadata\n---\n\n[toc]\n\n# Repeat\n\n## Repeat\n\n尾';
    const metadata = extractMarkdownMetadata(source);
    expect(metadata.headings.map(heading => [heading.id, heading.line])).toEqual([['repeat', 6], ['repeat-1', 8]]);
    const { host, editor } = await mount(source);
    await until(() => host.querySelectorAll('.mdir-toc a').length === 2);
    const link = host.querySelectorAll<HTMLAnchorElement>('.mdir-toc a')[1]!;
    expect(link.getAttribute('href')).toBe('#repeat-1'); link.click();
    expect(editor.view.state.selection.main.head).toBe(source.indexOf('## Repeat'));
    expect(host.querySelector('.mdir-h2')?.id).toBe('repeat-1');
    expect(host.querySelector('.mdir-hr')).toBeNull();
    const renderer = createBlockRenderer();
    const preview = document.createElement('div');
    try {
      for (let pass = 0; pass < 2; pass++) {
        await renderer.render(preview, source, { dark: false });
        expect(preview.querySelectorAll('.md-frontmatter')).toHaveLength(1);
        expect([...preview.querySelectorAll('.md-toc a')].map(a => a.getAttribute('href'))).toEqual(['#repeat', '#repeat-1']);
        expect([...preview.querySelectorAll('h1,h2')].map(h => h.id)).toEqual(['repeat', 'repeat-1']);
      }
    } finally { renderer.destroy(); }
  });

  it('空Front Matter仍是元数据，未闭合YAML及代码中的目录保持原文', async () => {
    expect(extractMarkdownMetadata('---\n---\n\n# A').frontMatter).toEqual({ from: 0, to: 8 });
    expect(extractMarkdownMetadata('---\ntitle: open\n\n# A').frontMatter).toBeNull();
    const source = '```md\n[toc]\n---\ntitle: code\n---\n```\n\n尾';
    const { host, editor } = await mount(source);
    expect(host.querySelector('.mdir-toc')).toBeNull();
    expect(host.querySelector('.mdir-frontmatter')).toBeNull();
    expect(editor.getMarkdown()).toBe(source);
  });

  it('即时脚注续段不变成代码，可跳转定义和每个引用，普通段落不被吞掉', async () => {
    const source = 'A[^n] B[^n]\n\n[^n]: First **bold**\n\n    Second paragraph\n\nAfter';
    const { host, editor } = await mount(source);
    await until(() => host.querySelectorAll('.mdir-footnote-ref').length === 2);
    expect([...host.querySelectorAll('.mdir-footnote-ref')].map(el => el.textContent)).toEqual(['1', '1']);
    expect(host.querySelector('.mdir-code')).toBeNull();
    expect(host.querySelectorAll('.mdir-footnote-back')).toHaveLength(2);
    expect(host.querySelector('.mdir-footnote-ref')?.getAttribute('href')).toBe('#footnotes-def-1');
    expect(host.querySelectorAll('.mdir-footnote-back')[1]?.getAttribute('href')).toBe('#footnotes-ref-1:2');
    host.querySelector<HTMLAnchorElement>('.mdir-footnote-ref')!.click();
    expect(editor.view.state.selection.main.head).toBe(source.indexOf('[^n]:'));
    host.querySelectorAll<HTMLAnchorElement>('.mdir-footnote-back')[1]!.click();
    expect(editor.view.state.selection.main.head).toBe(source.indexOf('[^n]', 4));
    expect(host.textContent).toContain('After');
    expect(editor.getMarkdown()).toBe(source);
  });

  it('引用内空标记行和Tab续段可解析，容器外缩进代码不归入脚注', async () => {
    const source = '> A[^a]\n>\n> [^a]: first\n>\n>     second\n\n    outside code\n\nAfter';
    const metadata = extractMarkdownMetadata(source);
    expect(metadata.footnotes[0]?.body).toBe('first\n\nsecond');
    expect(source.slice(metadata.footnotes[0]!.to)).toContain('outside code');
    expect(extractMarkdownMetadata('A[^a]\n\n[^a]: first\n\n\tsecond\n\nAfter').footnotes[0]?.body).toBe('first\n\nsecond');
    const { host } = await mount(source);
    await until(() => !!host.querySelector('.mdir-footnote-ref'));
    expect([...host.querySelectorAll('.mdir-code')].map(el => el.textContent?.trim())).toEqual(['outside code']);
    expect(host.textContent).toContain('second');
  });

  it('表格脚注共享正文编号、引用ID与跳转，点击不打开格编辑器', async () => {
    const source = 'A[^n]\n\n| A |\n|---|\n| B[^n] |\n\n[^n]: Note\n\n尾';
    const { host, editor } = await mount(source);
    await until(() => !!host.querySelector('td .mdir-footnote-ref'));
    const link = host.querySelector<HTMLAnchorElement>('td .mdir-footnote-ref')!;
    expect(link.id).toBe('footnotes-ref-1:2');
    expect(link.textContent).toBe('1');
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); link.click();
    expect(host.querySelector('td .cm-editor')).toBeNull();
    expect(editor.view.state.selection.main.head).toBe(source.indexOf('[^n]:'));
    expect(editor.getMarkdown()).toBe(source);
  });

  it('编辑跨块引用定义后失效旧地址，后台索引更新及撤销恢复', async () => {
    const source = '[caption][target]\n\n[target]: /old.md "Title"\n\n尾';
    const open = vi.fn();
    const { host, editor } = await mount(source, open);
    await until(() => !!host.querySelector('.mdir-link'));
    host.querySelector('.mdir-link')!.dispatchEvent(new MouseEvent('mousedown', { ctrlKey: true, bubbles: true, cancelable: true }));
    expect(open.mock.calls).toEqual([['/old.md']]);
    const from = source.indexOf('/old.md');
    editor.view.dispatch({ changes: { from, to: from + 7, insert: '/new.md' }, userEvent: 'input.type' });
    await vi.waitFor(() => {
      open.mockClear();
      host.querySelector('.mdir-link')?.dispatchEvent(new MouseEvent('mousedown', { ctrlKey: true, bubbles: true, cancelable: true }));
      expect(open).toHaveBeenLastCalledWith('/new.md');
    }, { timeout: 2500, interval: 15 });
    expect(undo(editor.view)).toBe(true);
    expect(editor.getMarkdown()).toBe(source);
  });

  it('行内与格内扩展保持代码、转义和未闭合源码，高亮/上下标/表情可见', async () => {
    const inline = 'H~2~O x^2^ ==hi== :smile: `==literal==` \\==escaped== ==open';
    const html = renderMarkdownInline(inline, undefined, { smile: '\u{1f604}' });
    const root = document.createElement('div'); root.innerHTML = html;
    expect(root.querySelector('sub')?.textContent).toBe('2');
    expect(root.querySelector('sup')?.textContent).toBe('2');
    expect([...root.querySelectorAll('mark')].map(el => el.textContent)).toEqual(['hi']);
    expect(root.querySelector('code')?.textContent).toBe('==literal==');
    expect(root.textContent).toContain('==open');
    const { host, editor } = await mount('| A | B |\n|---|---|\n| ' + inline + ' | **bold** |\n\n尾');
    await until(() => host.querySelector('td')?.textContent?.includes('\u{1f604}') ?? false);
    expect(host.querySelector('td sub')?.textContent).toBe('2');
    expect(host.querySelector('td sup')?.textContent).toBe('2');
    expect(host.querySelectorAll('td mark')).toHaveLength(1);
    expect(editor.getMarkdown()).toContain(inline);
  });

  it('表情补全保留别名源码且闭合即渲染，代码内不提示', async () => {
    const { host, editor } = await mount(':smi');
    editor.view.focus(); startCompletion(editor.view);
    await until(() => host.querySelector('.cm-tooltip-autocomplete')?.textContent?.includes(':smile:') ?? false);
    await until(() => acceptCompletion(editor.view));
    expect(editor.getMarkdown()).toBe(':smile:');
    await until(() => host.querySelector('.mdir-emoji')?.textContent === '\u{1f604}');
    const code = await mount('`:smi`');
    code.editor.view.dispatch({ selection: { anchor: 5 } });
    code.editor.view.focus(); startCompletion(code.editor.view);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(code.host.querySelector('.cm-tooltip-autocomplete')).toBeNull();
  });
});
