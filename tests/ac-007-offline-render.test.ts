// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractMarkdownMetadata, projectMarkdownSource } from '../src/markdown-view/headings';
import { renderMarkdown } from '../src/markdown-view/preview';
import { renderStaticHtml, staticMarkdownParser } from '../src/markdown-view/static-html';
import { cleanRenderHtml, createRenderContext, diagramSourceError } from '../src/markdown-view/render-service';

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe('007-AC-33 离线公式与图表', () => {
  it('索引只提取闭合公式与图表，代码、转义、Front Matter 不参与', () => {
    const source = '---\nvalue: $not$\n---\n\n$x^2$ ` $code$ ` \\$escaped$\n\n$$\n\\begin{matrix}1&2\\\\3&4\\end{matrix}\n$$\n\n~~~mermaid\ngraph LR; A-->B\n~~~\n\n~~~js\n$code$\n~~~\n\n$$\n$unfinished$';
    const blocks = extractMarkdownMetadata(source).renderBlocks;
    expect(blocks.map(block => [block.kind, block.display])).toEqual([['math', false], ['math', true], ['mermaid', true]]);
    expect(source.slice(blocks[0]!.from, blocks[0]!.to)).toBe('$x^2$');
    expect(blocks[2]!.source).toBe('graph LR; A-->B');
  });

  it('块公式中的 Markdown 不创建标题，嵌套容器移除标记而保留公式换行', () => {
    const metadata = extractMarkdownMetadata('> $$\n> a+b\n> $$\n\n$$\n# not heading\n$$\n\n# Heading');
    expect(metadata.renderBlocks.map(block => block.source)).toEqual(['a+b', '# not heading']);
    expect(metadata.headings.map(heading => heading.text)).toEqual(['Heading']);
  });

  it('静态投影保留代码、转义与未闭合源码，只对闭合索引生成渲染节点', () => {
    const source = '$x$ \\$literal$ `$code$`\n\n$$\nunclosed';
    const html = projectMarkdownSource(source, extractMarkdownMetadata(source));
    expect(html).toContain('data-render-kind="math"');
    expect(html).toContain('&#36;literal&#36;');
    expect(html).toContain('`$code$`');
    expect(html).toContain('<pre><code>$$\nunclosed</code></pre>');
  });

  it('主路径直接产出渲染占位，回退路径与表格使用相同占位结构', () => {
    // v0.42 改锁登记：offlinePreviewHtml（旧渲染器二次渲染前接管）作废——Lezer 序列化
    // 在产 HTML 时即出 md-render-target 占位，不存在「引擎自动加载前接管」的面。
    const source = '$x^2$\n\n```mermaid\ngraph LR; A-->B\n```';
    const tree = staticMarkdownParser.parse(source);
    const root = document.createElement('div');
    root.innerHTML = renderStaticHtml(source, tree, extractMarkdownMetadata(source, tree));
    expect(root.querySelectorAll('.language-math,.language-mermaid')).toHaveLength(0);
    expect([...root.querySelectorAll<HTMLElement>('.md-render-target')].map(el => el.dataset.renderKind)).toEqual(['math', 'mermaid']);
    root.innerHTML = renderMarkdown('Before $x^2$\n\n$$\na+b\n$$\n\n| A |\n|---|\n| $c^2$ |');
    expect(root.querySelectorAll('.md-render-target')).toHaveLength(3);
    expect(root.querySelector('td .md-render-target code')?.textContent).toBe('c^2');
  });

  it('SVG 保留本地 marker 与字形，移除事件、外部引用和可执行节点', () => {
    const root = document.createElement('div');
    root.innerHTML = cleanRenderHtml('<svg><script>alert(1)</script><foreignObject><img src="https://x"></foreignObject><image href="https://x"/><g onclick="go()" style="fill:url(https://x)"><use href="#glyph"/><use href="https://x"/><path marker-end="url(\'#arrow\')"/></g></svg>');
    expect(root.querySelector('script,foreignObject,image,[onclick],[style]')).toBeNull();
    expect(root.querySelector('use')?.getAttribute('href')).toBe('#glyph');
    expect(root.querySelectorAll('use')[1]!.hasAttribute('href')).toBe(false);
    expect(root.querySelector('path')?.getAttribute('marker-end')).toBe("url('#arrow')");
  });

  it('图表在进入库之前拒绝配置覆盖及图片/脚本资源入口', () => {
    for (const source of ['%%{init: {securityLevel:"loose"}}%%\ngraph LR; A-->B', 'graph LR\nA@{ img:"https://x" }',
      'graph LR\nA["<img src=x>"]', 'graph LR\nclick A callback', '---\nconfig:\n---\ngraph LR']) expect(diagramSourceError(source)).toBeTruthy();
    expect(diagramSourceError('flowchart LR\nA[Start] --> B{Save?}')).toBeNull();
  });

  it('异步结果只回填当前节点，相同公式请求合并，取消后不覆盖源码', async () => {
    vi.resetModules();
    let complete!: () => void;
    const typeset = vi.fn(async (elements: HTMLElement[]) => {
      await new Promise<void>(resolve => { complete = resolve; });
      for (const slot of elements[0]!.children) slot.innerHTML = '<svg><path d="M0 0L1 1"/></svg>';
    });
    const append = document.head.append.bind(document.head);
    vi.spyOn(document.head, 'append').mockImplementation((...nodes: (Node | string)[]) => {
      const script = nodes[0] as HTMLScriptElement;
      if (script.tagName !== 'SCRIPT') return append(...nodes);
      Object.assign(window, { MathJax: { startup: { promise: Promise.resolve() }, texReset: vi.fn(),
        tex2svgPromise: async () => document.createElement('span'), typesetPromise: typeset, typesetClear: vi.fn() } });
      queueMicrotask(() => script.onload?.(new Event('load')));
    });
    const { mountRender } = await import('../src/markdown-view/render-service');
    const block = { kind: 'math' as const, source: 'x^2', display: false, from: 0, to: 5 };
    const context = createRenderContext([block]);
    const first = document.createElement('span'), second = document.createElement('span');
    let current = true;
    mountRender(first, block, context, false, () => current);
    const cancel = mountRender(second, block, context, false);
    await vi.waitFor(() => expect(typeset).toHaveBeenCalledTimes(1));
    current = false; cancel(); complete();
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(first.textContent).toBe('x^2'); expect(second.textContent).toBe('x^2');
    const third = document.createElement('span'); mountRender(third, block, context, false);
    await vi.waitFor(() => expect(third.dataset.renderState).toBe('ready'));
    expect(typeset).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.md-render-stage')).toBeNull();
  });

  it('主题切换作废旧图结果，组合结束后再回填且销毁后不继续订阅', async () => {
    vi.resetModules();
    document.documentElement.dataset.tone = 'light';
    let theme = '', release!: () => void, held = true;
    const render = vi.fn(async () => {
      const selected = theme;
      if (render.mock.calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
      return { svg: '<svg><text>' + selected + '</text></svg>' };
    });
    const append = document.head.append.bind(document.head);
    vi.spyOn(document.head, 'append').mockImplementation((...nodes: (Node | string)[]) => {
      const script = nodes[0] as HTMLScriptElement;
      if (script.tagName !== 'SCRIPT' || script.type !== 'module') return append(...nodes);
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('ZiEdit-mermaid-loaded', { detail: {
        initialize: (config: { theme: string }) => { theme = config.theme; }, render,
      } })));
    });
    const { mountRender } = await import('../src/markdown-view/render-service');
    const target = document.createElement('div'); document.body.append(target);
    const block = { kind: 'mermaid' as const, source: 'flowchart LR\nA-->Theme', display: true, from: 0, to: 30 };
    const cancel = mountRender(target, block, createRenderContext([block]), false, () => true, undefined, () => held);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    document.documentElement.dataset.tone = 'dark';
    await new Promise(resolve => setTimeout(resolve, 5)); release();
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(target.textContent).toBe(block.source);
    held = false;
    await vi.waitFor(() => expect(target.dataset.renderState).toBe('ready'));
    expect(target.textContent).toBe('dark');
    cancel(); document.documentElement.dataset.tone = 'light';
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(render).toHaveBeenCalledTimes(2); expect(target.textContent).toBe('dark');
  });
});
