// @vitest-environment jsdom
// 渲染正确性基线（跨引擎 + 跨行尾）：不是给单个语法打补丁，而是给“预览显示不能错”兜底。
// ① 常用 GFM 构造在预览主路径（Lezer 单源静态序列化）下的块/行内结构与 markdown-it 参考实现一致；
// ② 同一语料在 LF / CRLF / CR / 混合行尾下渲染结构一致。
// 修前（2026-11-11）：渲染预览首开读原样 CRLF 文本，Lezer 的 GFM 表格分隔行判定不接受行尾 \r，
// 表格退化成段落，与参考实现不一致——本用例会先红。以后换解析器、改序列化或新增输入路径，
// 只要常用语法与参考实现分叉，或某类行尾渲染走样，这里都会失败。
import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { createBlockRenderer } from './blockcache';

const ORACLE = new MarkdownIt({ html: false, linkify: true, typographer: false });

/** 结构签名只比对块/行内标签序列与叶子文本，忽略 class/data-line/对齐等属性差异。 */
const TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br', 'a', 'img', 'strong', 'em', 'del', 'sup', 'sub',
]);
const TAG_ALIAS: Readonly<Record<string, string>> = { s: 'del', b: 'strong', i: 'em' };

function signature(html: string): string {
  const host = document.createElement('div');
  host.innerHTML = html;
  const parts: string[] = [];
  const walk = (element: Element, parent?: Element): void => {
    const tag = TAG_ALIAS[element.tagName.toLowerCase()] ?? element.tagName.toLowerCase();
    // 紧凑列表的 <p> 包装随解析器而异，结构比对时视为透明。
    const transparent = tag === 'p' && parent?.tagName.toLowerCase() === 'li';
    if (!transparent && TAGS.has(tag)) parts.push(tag);
    if (element.childElementCount === 0) {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) parts.push('#' + text);
    }
    for (const child of element.children) walk(child, element);
  };
  for (const child of host.children) walk(child);
  return parts.join(' ');
}

/** 只收标准 GFM 构造：项目自定义语法（==高亮==、^上标^、$公式$、脚注、emoji、任务列表）不参与参考比对。 */
const CORPUS: ReadonlyArray<{ name: string; src: string }> = [
  { name: '标题与 Setext', src: '# H1\n\n## H2\n\nSetext\n===\n\n### H3\n' },
  { name: '段落与行内格式', src: '段落 **粗体** *斜体* `行内码` ~~删除~~ [链接](https://example.com)\n' },
  { name: '列表', src: '- 一\n- 二\n  - 二点一\n\n1. 甲\n2. 乙\n' },
  { name: '引用', src: '> 引用\n>\n> 续\n' },
  { name: '代码块', src: '```\ncode line 1\n  code line 2\n```\n\n    缩进代码\n' },
  { name: '表格与对齐', src: '| 对比项 | Docker 容器 | 虚拟机 |\n| :-- | :-: | --: |\n| 隔离方式 | Namespace、Cgroups 等 | Hypervisor |\n| 部署效率 | 高 | 相对较低 |\n' },
  { name: '分隔线与硬换行', src: '段一  \n段二\n\n---\n' },
  { name: '转义与实体', src: '\\*不是斜体\\* &amp; <https://example.com>\n' },
];

const EOL_VARIANTS: ReadonlyArray<{ name: string; text: (src: string) => string }> = [
  { name: 'LF', text: src => src },
  { name: 'CRLF', text: src => src.replace(/\n/g, '\r\n') },
  { name: 'CR', text: src => src.replace(/\n/g, '\r') },
  // 首个换行 CRLF、第二个 CR、其余 LF：真实文件被不同工具改写过时的混排形态。
  { name: '混合', text: src => src.replace('\n', '\r\n').replace('\n', '\r') },
];

describe('渲染正确性：常用 GFM 构造与参考引擎、各类行尾一致', () => {
  for (const corpus of CORPUS) {
    it(corpus.name, async () => {
      for (const variant of EOL_VARIANTS) {
        const source = variant.text(corpus.src);
        const host = document.createElement('div');
        const renderer = createBlockRenderer();
        const result = await renderer.render(host, source, { dark: false });
        renderer.destroy();
        // 必须走主路径：退化成 markdown-it 回退会让本条用例变成同义反复。
        expect(result.engine, `${corpus.name}/${variant.name}`).toBe('lezer');
        const actual = signature(host.innerHTML);
        const expected = signature(ORACLE.render(source));
        expect(actual, `${corpus.name}/${variant.name}`).toBe(expected);
      }
    });
  }
});
