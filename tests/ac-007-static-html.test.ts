// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractMarkdownMetadata } from '../src/markdown-view/headings';
import { renderStaticHtml, staticMarkdownParser } from '../src/markdown-view/static-html';
import { applyDocumentMetadata } from '../src/markdown-view/preview';
import MarkdownIt from 'markdown-it';
import { metadataFingerprint } from '../src/markdown-view/metadata-fingerprint';

function render(source: string, post = false): HTMLElement {
  const tree = staticMarkdownParser.parse(source), metadata = extractMarkdownMetadata(source, tree);
  const root = document.createElement('div');
  root.innerHTML = renderStaticHtml(source, tree, metadata);
  if (post) applyDocumentMetadata(root, source, metadata);
  return root;
}

describe('AC-007 Lezer 静态序列化语义锁', () => {
  it('标题 ID 与迁移前 markdown-it 规则兼容（实体/转义/图片/跨行/重复消歧）', () => {
    const source = '# Hello **World**\n\n# A &amp; B\n\n# A\\_B\n\n# ![a _b_ &amp;](image.png)\n\none\ntwo\n===\n\n# Repeat\n\n# Repeat-1\n\n# Repeat';
    const old = new MarkdownIt({ html: false }), used = new Set<string>(), counters = new Map<string, number>();
    const tokens = old.parse(source, {}), ids: string[] = [];
    for (let i = 0; i < tokens.length; i++) if (tokens[i]!.type === 'heading_open') {
      const plain = old.parseInline(tokens[i + 1]!.content, {})[0]!.children!.filter(t => !t.type.endsWith('_open') && !t.type.endsWith('_close')).map(t => t.content).join('');
      const base = plain.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
      let count = counters.get(base) ?? 0, id = count ? base + '-' + count : base;
      while (used.has(id)) id = base + '-' + ++count;
      counters.set(base, count + 1); used.add(id); ids.push(id);
    }
    expect(extractMarkdownMetadata(source).headings.map(h => h.id)).toEqual(ids);
  });
  it('新增 metadata 字段进入语义指纹，纯位置平移不改变指纹', () => {
    const source = 'H~2~ ==亮==\n\n- [x] 完成\n\n|A|\n|:--:|\n|B|';
    const metadata = extractMarkdownMetadata(source), fingerprint = metadataFingerprint(metadata, source);
    expect(metadata.subscriptRanges).toHaveLength(1);
    expect(metadata.highlightRanges).toHaveLength(1);
    expect(metadataFingerprint(extractMarkdownMetadata('\n\n' + source), '\n\n' + source)).toBe(fingerprint);
    expect(metadataFingerprint({ ...metadata, taskRanges: metadata.taskRanges.map(t => ({ ...t, checked: false })) }, source)).not.toBe(fingerprint);
    expect(metadataFingerprint({ ...metadata, tableAligns: new Map([...metadata.tableAligns].map(([key]) => [key, ['right']])) }, source)).not.toBe(fingerprint);
  });
  it('六级标题、Setext 与稳定全文 ID', () => {
    const source = '# **Hello** `World` &amp; [link](x)\n\n## 重复\n\n## 重复\n\nSetext\n===\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六';
    const root = render(source, true);
    expect(root.querySelector('h1')?.id).toBe('hello-world-link');
    expect([...root.querySelectorAll('h2')].map(n => n.id)).toEqual(['重复', '重复-1']);
    for (let level = 1; level <= 6; level++) expect(root.querySelector('h' + level)).not.toBeNull();
  });
  it('块级 p/ul/ol/li/blockquote/hr 壳与有序起点', () => {
    const root = render('段落\n\n- 一\n  - 子\n\n3. 三\n4. 四\n\n> 引用\n\n---');
    for (const selector of ['p', 'ul li ul li', 'ol[start="3"] li', 'blockquote p', 'hr']) expect(root.querySelector(selector)).not.toBeNull();
  });
  it('围栏和缩进代码只输出安全代码文字', () => {
    const root = render('```text\n<script>bad</script>\n---\n```\n\n    缩进\n    第二行');
    expect(root.querySelectorAll('pre>code')).toHaveLength(2);
    expect(root.querySelector('code')?.className).toBe('hljs language-text');
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelectorAll('code')[1]?.textContent).toBe('缩进\n第二行\n');
  });
  it('强调、删除线 del、高亮与上下标', () => {
    const root = render('*斜* **粗** ~~删~~ ==亮== x^2^ H~2~O');
    for (const [tag, value] of [['em', '斜'], ['strong', '粗'], ['del', '删'], ['mark', '亮'], ['sup', '2'], ['sub', '2']]) expect(root.querySelector(tag)?.textContent).toBe(value);
    expect(root.querySelector('s')).toBeNull();
  });
  it('行内代码/转义/实体不产生活动 HTML', () => {
    const root = render('`==字面==` \\*文本\\* &lt;img src=x onerror=bad&gt;  \n换行');
    expect(root.querySelector('code')?.textContent).toBe('==字面==');
    expect(root.querySelector('img,mark,em')).toBeNull();
    expect(root.querySelector('br')).not.toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=bad>');
  });
  it('链接、引用链接、图片与自动 URL 安全归一', () => {
    const root = render('[标签][id] ![替代](./a.png "题") <a@b.com> www.example.com\n\n[id]: /target "标题"');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/target');
    expect(root.querySelector('a')?.title).toBe('标题');
    expect(root.querySelector('img')?.alt).toBe('替代');
    expect(root.querySelector('a[href="mailto:a@b.com"]')).not.toBeNull();
    expect(root.querySelector('a[href="http://www.example.com"]')).not.toBeNull();
    expect(render('[坏](javascript:alert(1)) <script>bad</script>').querySelector('script,a')).toBeNull();
  });
  it('Unicode Emoji 直接查随包别名表，不依赖旧引擎初始化', () => {
    expect(render(':smile: :doge:').textContent).toBe('😄 :doge:');
  });
  it('表头与数据格按 Table.from 对齐', () => {
    const root = render('| A | B | C | D |\n|:--|:--:|--:|--|\n|1|2|3|4|');
    for (const tag of ['th', 'td']) expect([...root.querySelectorAll(tag)].map(n => n.getAttribute('align'))).toEqual(['left', 'center', 'right', null]);
  });
  it('任务勾选与所在列表项范围、DOM 词汇', () => {
    const source = '- [ ] 未完成\n- [x] 完成';
    const metadata = extractMarkdownMetadata(source);
    expect(metadata.taskRanges.map(task => task.checked)).toEqual([false, true]);
    expect(metadata.taskRanges.every(task => task.itemFrom <= task.from && task.itemTo >= task.to)).toBe(true);
    const root = render(source);
    expect(root.querySelectorAll('li.md-task-item input[disabled][type="checkbox"]')).toHaveLength(2);
    expect(root.querySelector('li.md-task-item--done input')?.hasAttribute('checked')).toBe(true);
  });
  it('脚注同构且后处理依首次引用编号，重复引用同号', () => {
    const root = render('乙[^b] 甲[^a] 重复[^b]\n\n[^a]: 第一\n\n[^b]: 第二\n\n    续段', true);
    expect([...root.querySelectorAll('sup.footnotes-ref>a')].map(n => n.getAttribute('href'))).toEqual(['#footnotes-def-1', '#footnotes-def-2', '#footnotes-def-1']);
    expect(root.querySelector('ol.footnotes-defs-ol>li[id="footnotes-def-1"]')?.textContent).toContain('第二');
    expect(root.querySelectorAll('a.md-footnotes-goto')).toHaveLength(2);
  });
  it('列表懒连续换行显式 br，普通段落软换行不插 br', () => {
    expect(render('- 一\n  二\n懒连续').querySelectorAll('li br')).toHaveLength(2);
    expect(render('一\n二').querySelector('br')).toBeNull();
  });
  it('front matter 序列化跳过，后处理仍显示原文', () => {
    const source = '---\ntitle: metadata\n---\n\n# 正文';
    const root = render(source);
    expect(root.textContent).toBe('正文');
    expect(root.querySelector('hr,pre')).toBeNull();
    expect(render(source, true).querySelector('pre.md-frontmatter')?.textContent).toContain('title: metadata');
  });
  it('公式占位兼容 hydrateRenders，代码中公式保持原文', () => {
    const root = render('$x^2$\n\n$$\ny=2\n$$\n\n`$code$`');
    expect(root.querySelectorAll('[data-render-kind="math"]')).toHaveLength(2);
    expect([...root.querySelectorAll('code')].at(-1)?.textContent).toBe('$code$');
  });
  it('窗口与整篇输出等价且文中 --- 无 YAML 重解释', () => {
    const source = '段落\n\n---\n\n```text\n---\n```';
    const tree = staticMarkdownParser.parse(source), metadata = extractMarkdownMetadata(source, tree);
    let blocks = '';
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) blocks += renderStaticHtml(source, tree, metadata, node.from, node.to);
    expect(blocks).toBe(renderStaticHtml(source, tree, metadata));
    expect(render(source).querySelectorAll('hr')).toHaveLength(1);
  });
});
