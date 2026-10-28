// @vitest-environment jsdom
// AC-29：保留真实 CM 文档/语法树，外部 I/O 才替身；验证操作不变量及异步失效。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { forceParsing } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';

vi.mock('../src/common/ipc', () => ({
  textOpen: async () => ({ encoding: 'UTF-8', newline: 'lf' }),
  textSave: async () => ({ len: 0, modifiedMs: 0 }),
  textReadAll: async () => '',
  allowAssetFile: async () => {},
}));

if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
const { LivePreviewView, buildLiveDeco } = await import('../src/markdown-view/livepreview');
const views: InstanceType<typeof LivePreviewView>[] = [];
afterEach(() => { for (const v of views.splice(0)) v.destroy(); });

async function until(check: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 3000, interval: 10 });
}
async function mount(text: string, remoteImages?: (url: string) => Promise<string | null>, onStatus = (_s: { chars: number; lines: number }) => {}) {
  const host = document.createElement('div');
  let ready = false;
  const v = new LivePreviewView(host, {
    path: 'E:/mock/doc.md', encoding: 'UTF-8', initialDoc: text, remoteImages,
    onSaved: () => {}, onStatus, onReady: () => { ready = true; },
  });
  views.push(v);
  await until(() => ready);
  return { v, host };
}

describe('AC-29 所见即所得操作不变量', () => {
  it('删除线在非活动块隐藏定界符，进入活动块后恢复源码且内容不变', async () => {
    const doc = '首\n\n~~删除~~\n\n尾';
    const { v, host } = await mount(doc);
    await until(() => !!host.querySelector('.mdir-strike'));
    expect(host.querySelector('.mdir-strike')?.textContent).toBe('删除');
    v.view.dispatch({ selection: { anchor: doc.indexOf('删除') } });
    await until(() => !host.querySelector('.mdir-strike'));
    expect(host.textContent).toContain('~~删除~~');
    expect(v.getMarkdown()).toBe(doc);
  });
  it('增量字数在多区间编辑、中文/emoji、换行和撤销后与全文计数一致', async () => {
    const status = vi.fn();
    const { v } = await mount('甲乙\n空 格\t😀\n', undefined, status);
    const check = async () => {
      const doc = v.getMarkdown();
      await until(() => status.mock.lastCall?.[0].chars === doc.replace(/[ \t\n\r\v\f]/g, '').length);
      expect(status.mock.lastCall?.[0].lines).toBe(v.view.state.doc.lines);
    };
    await check();
    v.view.dispatch({ changes: [{ from: 0, to: 1, insert: '新\n字' }, { from: 4, to: 5, insert: '添加 😀' }], userEvent: 'input' });
    await check();
    v.cmUndo();
    await check();
    v.cmRedo();
    await check();
  });
  it('跨块选区展开中间强调、分隔线与表格；收起选区后恢复网格', async () => {
    const doc = '# 首\n\n**中间**\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n尾段';
    const { v, host } = await mount(doc);
    await until(() => !!host.querySelector('.mdir-table'));
    v.view.dispatch({ selection: { anchor: 1, head: doc.length - 1 } });
    await until(() => !host.querySelector('.mdir-table') && !!host.textContent?.includes('**中间**'));
    expect(host.querySelector('.mdir-hr')).toBeNull();
    expect(v.getMarkdown()).toBe(doc);
    v.view.dispatch({ selection: { anchor: doc.length } });
    await until(() => !!host.querySelector('.mdir-table'));
  });

  it('标题和引用内图床图片同样走取图钩子', async () => {
    const remote = vi.fn(async () => 'data:image/png;base64,AA==');
    const { v, host } = await mount('# ![标题](https://images.test/title.png)\n\n> ![引用](https://images.test/quote.png)\n\n尾', remote);
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length } });
    await until(() => host.querySelectorAll('img[src^="data:"]').length === 2);
    expect(remote.mock.calls.map(c => c[0])).toEqual(expect.arrayContaining(['https://images.test/title.png', 'https://images.test/quote.png']));
  });

  it('引用式图片解析首个定义，未定义引用保留源码而不生成空图片', async () => {
    const remote = vi.fn(async (_url: string) => 'data:image/png;base64,AA==');
    const doc = '首\n\n![图][I D]\n\n![missing][unknown]\n\n[i d]: https://images.test/ref.png\n[i d]: https://images.test/wrong.png\n\n尾';
    const { v, host } = await mount(doc, remote);
    v.view.dispatch({ selection: { anchor: doc.length } });
    await until(() => !!host.querySelector('img[src^="data:"]'));
    expect(remote).toHaveBeenCalledWith('https://images.test/ref.png');
    expect(remote).not.toHaveBeenCalledWith('https://images.test/wrong.png');
    expect(host.querySelectorAll('.mdir-imgbox')).toHaveLength(1);
    expect(host.textContent).toContain('![missing][unknown]');
    expect(v.getMarkdown()).toBe(doc);
  });

  it('表格中的引用式图片使用同一份全文定义', async () => {
    const remote = vi.fn(async (_url: string) => 'data:image/png;base64,AA==');
    const { v, host } = await mount('首\n\n| 图片 | 链接 |\n|---|---|\n| ![图][img] | [链接][doc] |\n\n[img]: https://images.test/table.png\n[doc]: /test.md "标题"\n\n尾', remote);
    v.view.dispatch({ selection: { anchor: 0 } });
    await until(() => !!host.querySelector('.mdir-table img[src^="data:"]'));
    expect(host.querySelector('.mdir-table a')?.getAttribute('title')).toBe('标题');
    expect(remote).toHaveBeenCalledWith('https://images.test/table.png');
  });

  it('批量建表保留行内格式和文本转义，不激活原始 HTML 或恶意链接', async () => {
    const doc = '首\n\n| A | B |\n|---|---|\n| <img src=x onerror=alert(1)> | [点](javascript:alert(1)) |\n| **粗体** & <标签> | `代码` |\n\n尾';
    const { v, host } = await mount(doc);
    await until(() => !!host.querySelector('.mdir-table'));
    const table = host.querySelector('.mdir-table')!;
    expect(table.querySelector('img,script,[onerror],a[href^="javascript:"]')).toBeNull();
    expect(table.querySelector('tbody td')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(table.querySelector('strong')?.textContent).toBe('粗体');
    expect(table.querySelector('code')?.textContent).toBe('代码');
    expect(table.textContent).toContain('粗体 & <标签>');
    expect(v.getMarkdown()).toBe(doc);
  });

  it('图片块转活动源码后销毁 Widget，迟到取图不能再改旧 DOM', async () => {
    let finish!: (value: string | null) => void;
    const remote = () => new Promise<string | null>(r => { finish = r; });
    const { v, host } = await mount('首\n\n![图](https://images.test/late.png)\n\n尾', remote);
    await until(() => !!host.querySelector('.mdir-imgbox'));
    const old = host.querySelector('.mdir-imgbox')!;
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length } });
    expect(host.querySelector('.mdir-imgbox')).toBe(old); // eq 复用 DOM 后由新 Widget 接管。
    v.view.dispatch({ selection: { anchor: 6 } });
    await until(() => !host.querySelector('.mdir-imgbox'));
    finish('data:image/png;base64,AA==');
    await Promise.resolve();
    expect(old.querySelector('img')?.getAttribute('src')).toBeNull();
  });

  it('表格 Widget 复用 DOM 后销毁，内部图片的迟到回填也失效', async () => {
    let finish!: (value: string | null) => void;
    const remote = () => new Promise<string | null>(r => { finish = r; });
    const doc = '首\n\n| A |\n|---|\n| ![图](https://images.test/table-late.png) |\n\n尾';
    const { v, host } = await mount(doc, remote);
    await until(() => !!host.querySelector('.mdir-table'));
    const table = host.querySelector('.mdir-table')!;
    v.view.dispatch({ selection: { anchor: doc.length } });
    expect(host.querySelector('.mdir-table')).toBe(table);
    const old = table.querySelector('img')!;
    v.view.dispatch({ selection: { anchor: 0, head: doc.length } });
    await until(() => !host.querySelector('.mdir-table'));
    finish('data:image/png;base64,AA==');
    await Promise.resolve();
    expect(old.getAttribute('src')).toBeNull();
  });

  it.each(['code', 'quote', 'list'])('长 %s 块只在视口附近构建装饰', kind => {
    const body = kind === 'code' ? '```\n' + 'let value = 1;\n'.repeat(5000) + '```'
      : kind === 'quote' ? '> **value**\n'.repeat(5000) : '- [ ] **value**\n'.repeat(5000);
    const doc = '首\n\n' + body + '\n\n尾';
    const editor = new EditorView({ state: EditorState.create({ doc, extensions: markdown({ base: markdownLanguage }) }) });
    expect(forceParsing(editor, doc.length, 5000)).toBe(true);
    const state = editor.state;
    const from = Math.floor(doc.length / 2);
    const to = from + 200;
    const set = buildLiveDeco({ state, viewport: { from, to } } as EditorView, null);
    let count = 0;
    set.between(0, doc.length, (a, _b, d) => {
      count++;
      if (d.spec.class) expect(a).toBeGreaterThanOrEqual(state.doc.lineAt(from - 300).from);
    });
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(800);
    editor.destroy();
  });
});
