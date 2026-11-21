// @vitest-environment jsdom
// REQ-014 P4（T022）：markdown-it 回退渲染路径删除——三面静态 HTML 统一由 renderStaticHtml 承载，
// 「静态 vs 回退」差分锁随之作废。本文件改为锁统一政策下的真实双路对照：
//   片段路（renderCellHtml：单元格文本独立成树）与整面路（整篇解析的表格单元格）产物一致；
//   组合语料经统一序列化不泄漏原始标记。
import { beforeAll, describe, expect, it } from 'vitest';
import { extractMarkdownMetadata } from '../src/markdown-view/headings';
import { loadMarkdownIt } from '../src/markdown-view/md';
import { renderStaticHtml, staticMarkdownParser, renderCellHtml } from '../src/markdown-view/static-html';
import { cellInlineText } from '../src/markdown-view/table-model';

beforeAll(async () => { await loadMarkdownIt(); });

const staticFace = (source: string): HTMLElement => {
  const tree = staticMarkdownParser.parse(source);
  const root = document.createElement('div');
  root.innerHTML = renderStaticHtml(source, tree, extractMarkdownMetadata(source, tree));
  return root;
};

/** 整面路的表格单元格内层 HTML（与片段路 renderCellHtml 的产出对照）。 */
const staticTableCell = (cell: string, header = false): string => {
  const root = staticFace('| A |\n| -- |\n| ' + cell + ' |');
  const node = root.querySelector(header ? 'th' : 'td');
  return node?.innerHTML ?? '';
};

describe('REQ-014 P4 统一渲染政策：片段路与整面路一致', () => {
  const strip = (html: string): string => html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  it.each([
    '**粗** *斜* ~~删~~ ==亮== x^2^ H~2~O',
    '`==字面==` \\*不斜\\* &amp; 实体',
    '[标签](/target "题") ![替代](./a.png)',
    ':smile: 未知 :not_an_alias:',
    '$x^2$ 行内公式占位',
  ])('行内文本一致：%s', snippet => {
    const whole = staticFace(snippet);
    expect(whole.querySelector('script,td')).toBeNull();
    expect(strip(renderCellHtml(snippet))).toBe(strip(whole.innerHTML));
  });
  it('定界符前置不丢嵌套内容（存量缺陷回归锁：a *b* ==c== 修前产出交叉标签）', () => {
    expect(renderCellHtml('a *b* ~~c~~ ==d== x^2^')).toBe('a <em>b</em> <del>c</del> <mark>d</mark> x<sup>2</sup>');
    expect(staticFace('a *b* ~~c~~ ==d== x^2^').querySelector('p')?.innerHTML)
      .toBe('a <em>b</em> <del>c</del> <mark>d</mark> x<sup>2</sup>');
  });
  it('MD-03 表格 code span 内转义竖线：片段路与整面路同口径还原字面竖线', () => {
    const cellCode = staticFace('| A |\n| -- |\n| `c\\|d` |').querySelector('td code');
    expect(cellCode?.textContent).toBe('c|d');
    // 表外是普通 code span：反斜杠转义不进代码跨度，字面保留。
    expect(staticFace('段落 `c\\|d` 结束').querySelector('p code')?.textContent).toBe('c\\|d');
    // 片段路（IR 单元格接缝）：cellInlineText 归一化后再走统一序列化。
    expect(cellInlineText('`c\\|d` a\\|b')).toBe('`c|d` a|b');
    expect(renderCellHtml(cellInlineText('`c\\|d`'))).toContain('<code>c|d</code>');
  });
  it('整面表格单元格与片段路结构一致（含公式占位）', () => {
    expect(renderCellHtml('$c^2$')).toBe(staticTableCell('$c^2$'));
    expect(renderCellHtml('**粗** 与 `码`')).toBe(staticTableCell('**粗** 与 `码`'));
  });
});

describe('REQ-014 P4 组合语料统一序列化不泄漏原始标记', () => {
  it('组合语料（风险表覆盖）', () => {
    const source = [
      '# 总标题', '', '引言 **粗** ~~删~~ ==亮== `码` x^2^ H~2~O :smile:', '', '---', '',
      '> 引用内 **粗**', '> 引用二', '', '- [x] 已完成', '- [ ] 未完成', '  懒续行', '', '3. 有序起点', '4. 第二项', '',
      '| 左 | 中 | 右 |', '|:--|:-:|--:|', '| a | b | c |', '', '```bash', 'echo hi', '```', '',
      '$行内$ 与', '', '$$', '块公式', '$$', '', '[链接](/x "题") ![图](./y.png) <https://e.test>', '', '尾注[^n]', '', '[^n]: 注体',
    ].join('\n');
    const root = staticFace(source);
    const text = root.textContent ?? '';
    for (const marker of ['**', '~~', '==', '[x]', '[ ]']) expect(text).not.toContain(marker);
    expect(root.querySelector('h1,table,pre,blockquote,ul,ol,sup')).not.toBeNull();
  });
});
