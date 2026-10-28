// @vitest-environment jsdom
// AC（007 v0.11 R1）：渲染区链接守卫——外链/锚点/相对 .md/无承载引用的路由决策与 DOM 拦截；
// 本地相对路径图片 asset 协议解析；未随包块（mermaid/math）源码降级。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { allowAssetFile } from '../src/common/ipc';
vi.mock('../src/common/ipc', () => ({ allowAssetFile: vi.fn(async () => {}), textOpen: async () => ({ newline: 'lf' }) }));
vi.mock('../src/markdown-view/preview', async original => ({ ...await original<object>(), loadUnicodeEmojis: async () => ({}) }));
import { LivePreviewView } from '../src/markdown-view/livepreview';
import type { CtxMenuItem } from '../src/shell/chrome';
import { t } from '../src/common/i18n';
import {
  installLinkGuard,
  joinRelPath,
  externalHrefAt,
  resolveLocalImages,
  degradeUnsupportedBlocks,
} from '../src/markdown-view/preview';
import { renderStaticHtml, staticMarkdownParser } from '../src/markdown-view/static-html';
import { extractMarkdownMetadata } from '../src/markdown-view/headings';

// convertFileSrc 走 __TAURI_INTERNALS__（纯字符串变换，无 IPC）：测试内给出确定实现
beforeEach(() => {
  vi.mocked(allowAssetFile).mockReset().mockResolvedValue(undefined);
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    convertFileSrc: (p: string) => 'asset://localhost/' + encodeURIComponent(p),
  };
});

describe('AC-29 本地图片授权归属', () => {
  it.each(['reference', 'lifecycle'])('%s 变化后迟到授权不能覆盖图片', async kind => {
    let finish!: () => void;
    vi.mocked(allowAssetFile).mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const root = document.createElement('div');
    root.innerHTML = '<img src="old.png">';
    const img = root.querySelector('img')!;
    let current = true;
    resolveLocalImages(root, '/docs', () => current);
    if (kind === 'reference') img.src = 'new.png';
    else current = false;
    finish();
    await Promise.resolve();
    expect(img.getAttribute('src')).toBe(kind === 'reference' ? 'new.png' : 'old.png');
  });
});

function setup(rootHtml: string): { root: HTMLElement; clicks: string[]; opened: string[]; mds: string[]; hints: string[] } {
  const root = document.createElement('div');
  root.innerHTML = rootHtml;
  document.body.appendChild(root);
  const opened: string[] = [];
  const mds: string[] = [];
  const hints: string[] = [];
  const detach = installLinkGuard(root, {
    baseDir: () => '/docs/dir',
    openMarkdown: p => mds.push(p),
    openExternal: u => opened.push(u),
    hint: m => hints.push(m),
    interactive: false,
  });
  void detach;
  const clicks: string[] = [];
  root.addEventListener('click', e => {
    // 守卫 preventDefault 后默认导航不应发生：监听器只记录派发
    clicks.push((e.target as HTMLElement).tagName);
    void e;
  });
  return { root, clicks, opened, mds, hints };
}

function click(el: Element, opts: { ctrlKey?: boolean } = {}): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: opts.ctrlKey ?? false }));
}

describe('AC joinRelPath（相对引用解析基点）', () => {
  it('./ 前缀与反斜杠基点', () => {
    expect(joinRelPath('/a/b/', './c/d.md')).toBe('/a/b/c/d.md');
    expect(joinRelPath('C:\\docs', 'img.png')).toBe('C:/docs/img.png');
  });
});

describe('AC 外链路由（R1）', () => {
  it('Ctrl+点击 http → openExternal（交系统浏览器）', () => {
    const s = setup('<a href="https://example.com/x">e</a>');
    click(s.root.querySelector('a')!, { ctrlKey: true });
    expect(s.opened).toEqual(['https://example.com/x']);
  });
  it('普通点击不导航不打开，状态栏提示', () => {
    const s = setup('<a href="https://example.com/">e</a>');
    const a = s.root.querySelector('a')!;
    click(a);
    expect(s.opened).toEqual([]);
    expect(s.hints.length).toBe(1);
  });
  it('mailto/tel 同通道', () => {
    const s = setup('<a href="mailto:a@b.c">m</a><a href="tel:123">t</a>');
    click(s.root.querySelectorAll('a')[0]!, { ctrlKey: true });
    click(s.root.querySelectorAll('a')[1]!, { ctrlKey: true });
    expect(s.opened).toEqual(['mailto:a@b.c', 'tel:123']);
  });
  it('点击默认行为被取消（WebView 永不离开应用）', () => {
    const s = setup('<a href="https://example.com/">e</a>');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    s.root.querySelector('a')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('AC 锚点与相对 .md（R1）', () => {
  it('#锚点：页内目标滚动（不外发）', () => {
    const s = setup('<a href="#sec">go</a><h2 id="sec">S</h2>');
    const scrollIntoView = vi.fn();
    s.root.querySelector('h2')!.scrollIntoView = scrollIntoView;
    click(s.root.querySelector('a')!);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(s.opened).toEqual([]);
  });
  it('相对 .md → 新标签打开（基点目录解析）', () => {
    const s = setup('<a href="./sub/page.md">p</a>');
    click(s.root.querySelector('a')!);
    expect(s.mds).toEqual(['/docs/dir/sub/page.md']);
  });
  it('其他相对引用：不导航，预览态提示', () => {
    const s = setup('<a href="./file.zip">z</a>');
    click(s.root.querySelector('a')!);
    expect(s.opened).toEqual([]);
    expect(s.mds).toEqual([]);
    expect(s.hints.length).toBe(1);
  });
});

describe('AC externalHrefAt（右键菜单判定）', () => {
  it('IR span 不再走静态预览 DOM 分支（旧渲染器选择器已退场）', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span data-type="a"><span class="md-legacy-marker--link">https://old.test</span></span><span class="mdir-link">https://new.test</span>';
    for (const span of root.querySelectorAll('span')) expect(externalHrefAt(span)).toBeNull();
  });
  it('命中外链返回 href；非链接/相对链接返回 null', () => {
    document.body.innerHTML = '<div><a href="https://a.b">x</a><a href="./y.md">y</a><span>s</span></div>';
    const [ext, rel, plain] = document.body.querySelectorAll('a, span');
    expect(externalHrefAt(ext)).toBe('https://a.b');
    expect(externalHrefAt(rel)).toBeNull();
    expect(externalHrefAt(plain)).toBeNull();
  });
});

describe('AC-21 IR 链接右键', () => {
  it.each([false, true])('链接含打开项并走外链出口，只读=%s', async readOnly => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    const host = document.createElement('div'); document.body.append(host);
    let items: CtxMenuItem[] = [];
    const openExternal = vi.fn();
    const live = new LivePreviewView(host, {
      path: '/docs/test.md', encoding: 'UTF-8', initialDoc: '[site](https://example.com)\n\nplain', readOnly,
      onStatus: () => {}, onSaved: () => {}, openExternal,
      showMenu: value => { items = value; },
    });
    try {
      await vi.waitFor(() => expect(host.querySelector('.mdir-link')).not.toBeNull());
      host.querySelector('.mdir-link')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const entry = items.find(item => item?.[0] === t('md.openExternal'));
      expect(entry).toBeDefined();
      entry![1]!();
      expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com');
      const hit = vi.spyOn(live.view, 'posAtCoords').mockReturnValue(3);
      live.view.contentDOM.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(items.some(item => item?.[0] === t('md.openExternal'))).toBe(true);
      hit.mockReturnValue(live.view.state.doc.length - 2);
      live.view.contentDOM.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(items.some(item => item?.[0] === t('md.openExternal'))).toBe(false);
    } finally { live.destroy(); host.remove(); }
  });
});

describe('AC 本地图片解析（R1）', () => {
  it('相对路径经精确授权后使用 asset 协议；远程/data 图不动', async () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<img src="./pic/a.png"><img src="https://cdn.x/y.png"><img src="data:image/png;base64,xx"><img src="b.jpg">';
    resolveLocalImages(root, '/docs/dir');
    await vi.waitFor(() => expect(root.querySelector('img')!.getAttribute('src')).toMatch(/^asset:/));
    const srcs = [...root.querySelectorAll('img')].map(i => i.getAttribute('src'));
    expect(srcs[0]!.startsWith('asset://localhost/')).toBe(true);
    expect(srcs[0]).toContain(encodeURIComponent('/docs/dir/pic/a.png'));
    expect(srcs[1]).toBe('https://cdn.x/y.png');
    expect(srcs[2]).toBe('data:image/png;base64,xx');
    expect(srcs[3]!.startsWith('asset://localhost/')).toBe(true);
  });
  it('解码中文、空格和百分号路径，上级目录按实际目标授权', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<img src="../%E5%9B%BE%20%E7%89%87/100%25.png">';
    resolveLocalImages(root, '/docs/dir');
    await vi.waitFor(() => expect(allowAssetFile).toHaveBeenCalledWith('/docs/图 片/100%.png'));
    expect(root.querySelector('img')!.getAttribute('src')).toContain(encodeURIComponent('/docs/图 片/100%.png'));
  });
  it('授权失败不设置 asset URL，并保留失败标识', async () => {
    vi.mocked(allowAssetFile).mockRejectedValue(new Error('not found'));
    const root = document.createElement('div');
    root.innerHTML = '<img src="missing.png">';
    resolveLocalImages(root, '/docs/dir');
    await vi.waitFor(() => expect(root.querySelector('img')!.dataset.mdBroken).toBe('1'));
    expect(root.querySelector('img')!.getAttribute('src')).not.toMatch(/^asset:/);
  });
  it('无基点目录（草稿等）不处理', () => {
    const root = document.createElement('div');
    root.innerHTML = '<img src="a.png">';
    resolveLocalImages(root, null);
    expect(root.querySelector('img')!.getAttribute('src')).toBe('a.png');
  });
});

describe('AC 离线渲染接管与未随包块降级', () => {
  // v0.42 改锁登记：offlinePreviewHtml 两例作废（旧渲染器二次渲染前接管/降级改写不存在了）；
  // 语义由序列化器直接承载——mermaid/math 围栏出渲染占位，其余未随包语言保留源码代码块。
  it('主路径公式/图表出渲染占位，未随包引擎语言保留源码', () => {
    const source = '```mermaid\ngraph A-->B\n```\n\n~~~math\nx < y\n~~~\n\n```mindmap\nroot\n```';
    const tree = staticMarkdownParser.parse(source);
    const root = document.createElement('div');
    root.innerHTML = renderStaticHtml(source, tree, extractMarkdownMetadata(source, tree));
    expect(root.querySelectorAll('.language-mermaid,.language-math')).toHaveLength(0);
    expect([...root.querySelectorAll<HTMLElement>('.md-render-target')].map(el => el.dataset.renderKind)).toEqual(['mermaid', 'math']);
    expect(root.querySelectorAll('pre')).toHaveLength(1); // mindmap 按普通代码块呈现源码
    expect(root.querySelector('.md-render-target code')!.textContent).toBe('graph A-->B');
    expect(root.querySelectorAll('.md-render-target')[1]!.querySelector('code')!.textContent).toBe('x < y');
    expect(root.querySelector('pre code')!.textContent).toBe('root\n');
  });
  it('未随包图表语言保持源码，普通代码和HTML转义不变', () => {
    for (const lang of ['smiles', 'markmap', 'echarts', 'abc', 'graphviz', 'wavedrom', 'flowchart', 'plantuml']) {
      const source = '```' + lang + '\n<script>alert(1)</script>\n```';
      const tree = staticMarkdownParser.parse(source);
      const root = document.createElement('div');
      root.innerHTML = renderStaticHtml(source, tree, extractMarkdownMetadata(source, tree));
      expect(root.querySelector('script')).toBeNull();
      expect(root.querySelector('code')?.textContent).toBe('<script>alert(1)</script>\n');
    }
    const source = '```js\nconst n = 1;\n```';
    const tree = staticMarkdownParser.parse(source);
    expect(renderStaticHtml(source, tree, extractMarkdownMetadata(source, tree))).toContain('language-js');
  });
  it('裸源文本 div 标记降级（CSS 按代码块呈现）；幂等', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="language-mermaid">graph TD; A--&gt;B;</div>';
    degradeUnsupportedBlocks(root);
    const el = root.children[0] as HTMLElement;
    expect(el.dataset.mdDegraded).toBe('1');
    expect(el.textContent).toBe('graph TD; A-->B;');
    degradeUnsupportedBlocks(root); // 幂等
    expect(el.dataset.mdDegraded).toBe('1');
  });
  it('空 div（引擎加载中途清空）：从同块源码 code 回填', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-type="code-block"><code class="language-mermaid">graph TD</code><div class="language-mermaid"></div></div>';
    degradeUnsupportedBlocks(root);
    const div = root.querySelector('div.language-mermaid') as HTMLElement;
    expect(div.textContent).toBe('graph TD');
    expect(div.dataset.mdDegraded).toBe('1');
  });
  it('空 div 且无源码可回填：不标记不崩溃', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="language-math"></div>';
    degradeUnsupportedBlocks(root);
    expect((root.children[0] as HTMLElement).dataset.mdDegraded).toBeUndefined();
  });
});
