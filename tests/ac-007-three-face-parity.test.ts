// @vitest-environment jsdom
// D-T2-05（v0.42 规则 16）：三面等价锁——静态面（renderStaticHtml，独立预览/分屏共用）与
// markdown-it 回退（renderMarkdown）对同一语料的块级序列归一化后一致；IR 行内语义
// （renderMarkdownInline，livepreview 表格/行内展开用）与静态面行内产物对照。
// 已知白名单差异（语义等价，逐条登记）：删除线 s↔del；任务复选框回退面为字面 [x]；
// 脚注结构不同（静态=定义区+上标引用，回退=引用链接文本 ^a + 定义被引用系统吞掉）；
// 未闭合 $$ 静态面降级 pre、回退面留在段落（同为源码可见）。
import { describe, expect, it } from 'vitest';
import { extractMarkdownMetadata } from '../src/markdown-view/headings';
import { renderStaticHtml, staticMarkdownParser } from '../src/markdown-view/static-html';
import { renderMarkdown, renderMarkdownInline } from '../src/markdown-view/preview';

const staticFace = (source: string): HTMLElement => {
  const tree = staticMarkdownParser.parse(source);
  const root = document.createElement('div');
  root.innerHTML = renderStaticHtml(source, tree, extractMarkdownMetadata(source, tree));
  return root;
};
const fallbackFace = (source: string): HTMLElement => {
  const root = document.createElement('div');
  root.innerHTML = renderMarkdown(source);
  return root;
};

/** 块级序列归一化：tag 白名单映射（s→del、回退面未闭合 $$ 段落→pre）；文本空白折叠；
 *  列表展开为逐 li 行；表格展开为逐格行；静态面摘脚注定义区/引用上标，回退面摘 ^x 引用链接。 */
function blockSequence(root: HTMLElement, face: 'static' | 'fallback'): string[] {
  const clone = root.cloneNode(true) as HTMLElement;
  if (face === 'static') {
    clone.querySelectorAll('.footnotes-defs-ol, sup.footnotes-ref').forEach(el => el.remove());
  } else {
    [...clone.querySelectorAll('a')].filter(a => /^\^/.test(a.textContent ?? '')).forEach(a => a.remove());
  }
  const text = (el: Element): string => (el.textContent ?? '').replace(/\[[ xX]\] ?/g, '').replace(/\s+/g, ' ').trim();
  const cell = (el: Element): string => `${el.tagName}:${text(el)}`;
  const entry = (el: Element): string => {
    const tag = el.tagName === 'S' ? 'DEL' : el.tagName;
    return `${tag}:${text(el)}`.replace(/^P:(\$\$)/, 'PRE:$1');
  };
  const out: string[] = [];
  for (const el of clone.children) {
    if (el.tagName === 'UL' || el.tagName === 'OL') {
      for (const item of el.children) out.push(`LI:${text(item)}`);
    } else if (el.tagName === 'TABLE') {
      for (const c of el.querySelectorAll('th,td')) out.push(cell(c));
    } else out.push(entry(el));
  }
  return out;
}

describe('D-T2-05 三面块级序列等价（静态 vs 回退）', () => {
  it.each([
    ['标题与行内格式', '# 一\n\n## 二\n\n**粗** *斜* ~~删~~ ==亮== `码` x^2^ H~2~O :smile:'],
    ['段落、引用与懒连续', '第一段。\n\n> 引用一\n> 引用二\n\n一\n二'],
    ['三类列表与任务勾选', '- 甲\n  乙\n- [ ] 未完成\n- [x] 完成\n\n1. 一\n2. 二\n\n3. 起点\n4. 次'],
    ['表格对齐', '| A | B | C |\n|:--|:-:|--:|\n| a | b | c |'],
    ['围栏与缩进代码', '```js\nconst x = 1;\n```\n\n    缩进\n    第二行'],
    ['链接、图片与自动地址', '[标签](/target "题") ![替代](./a.png) <https://x.test/a> www.example.com'],
    ['公式与未闭合', '$x^2$ 与 $$\ny=2\n$$\n\n$$\n未闭合'],
    ['脚注（结构差异摘除后正文一致）', '正文甲[^a] 正文乙[^b] 再次[^a]\n\n[^a]: 第一条\n\n[^b]: 第二条'],
    ['分割线与转义', '---\n\n\\*不斜\\* \\$100'],
  ])('%s', (_name, source) => {
    expect(blockSequence(staticFace(source), 'static')).toEqual(blockSequence(fallbackFace(source), 'fallback'));
  });

  it('组合语料整篇块级序列一致（风险表覆盖）', () => {
    const source = [
      '# 总标题', '', '引言 **粗** ~~删~~ ==亮== `码` x^2^ H~2~O :smile:', '', '---', '',
      '> 引用内 **粗**', '> 引用二', '', '- [x] 已完成', '- [ ] 未完成', '  懒续行', '', '3. 有序起点', '4. 第二项', '',
      '| 左 | 中 | 右 |', '|:--|:-:|--:|', '| a | b | c |', '', '```bash', 'echo hi', '```', '',
      '$行内$ 与', '', '$$', '块公式', '$$', '', '[链接](/x "题") ![图](./y.png) <https://e.test>', '', '尾注[^n]', '', '[^n]: 注体',
    ].join('\n');
    expect(blockSequence(staticFace(source), 'static')).toEqual(blockSequence(fallbackFace(source), 'fallback'));
  });
});

describe('D-T2-05 IR 行内语义对照（renderMarkdownInline vs 静态行内产物）', () => {
  const strip = (html: string): string => html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  it.each([
    '**粗** *斜* ~~删~~ ==亮== x^2^ H~2~O',
    '`==字面==` \\*不斜\\* &amp; 实体',
    '[标签](/target "题") ![替代](./a.png)',
    ':smile: 未知 :not_an_alias:',
  ])('行内文本一致：%s', snippet => {
    const staticRoot = staticFace(snippet);
    expect(staticRoot.querySelector('script,td')).toBeNull();
    expect(strip(renderMarkdownInline(snippet))).toBe(strip(staticRoot.innerHTML));
  });
  it('定界符前置不丢嵌套内容（存量缺陷回归锁：a *b* ==c== 修前产出交叉标签）', () => {
    expect(renderMarkdownInline('a *b* ~~c~~ ==d== x^2^')).toBe('a <em>b</em> <s>c</s> <mark>d</mark> x<sup>2</sup>');
    expect(staticFace('a *b* ~~c~~ ==d== x^2^').querySelector('p')?.innerHTML)
      .toBe('a <em>b</em> <del>c</del> <mark>d</mark> x<sup>2</sup>');
  });
  it('语义族对照：同一格式在两面产出同名标签', () => {
    const families: Array<[string, string, string]> = [
      ['strong', 'strong', '**粗**'], ['em', 'em', '*斜*'], ['mark', 'mark', '==亮=='],
      ['sup', 'sup', 'x^2^'], ['sub', 'sub', 'H~2~O'], ['code', 'code', '`==字面==`'],
      ['a', 'a', '[标签](/target "题")'],
    ];
    for (const [irTag, staticSelector, source] of families) {
      const irCount = (renderMarkdownInline(source).match(new RegExp('<' + irTag + '[\\s>]')) ?? []).length;
      expect(irCount, source).toBe(staticFace(source).querySelectorAll(staticSelector).length);
    }
  });
});
