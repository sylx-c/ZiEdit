// 004 US2（T011）：标题视觉契约回归测试（Typora parity P1）。
// 契约（data-model §3 Heading Visual State.decorations/.surface/.interaction）：
// 阅读态标题前不得有常驻灰块/竖线/阴影（Typora 对齐）；IR 编辑辅助（井号）只在明确
// 交互态出现且不改变正文几何；大纲闪示为临时动画且终态透明。
// jsdom 不加载外部 CSS，装饰断言按仓库既有口径落在 styles.css 规则文本与 DOM 类名上。
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { staticMarkdownParser, renderStaticHtml } from '../src/markdown-view/static-html';
import { extractMarkdownMetadata } from '../src/markdown-view/headings';
import { loadMarkdownIt } from '../src/markdown-view/md';
import { HEADING_CASES } from '../src/markdown-view/typora-baseline';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

beforeAll(async () => {
  // 标题含链接案例走 markdown-it 链接工具（主线程共享单例预取，见 md.ts）
  await import('../src/markdown-view/md-link').then(() => loadMarkdownIt());
});

function renderHeadings(doc: string): string {
  const tree = staticMarkdownParser.parse(doc);
  const metadata = extractMarkdownMetadata(doc, tree);
  return renderStaticHtml(doc, tree, metadata);
}

describe('静态预览标题无错误装饰（004 FR-005/FR-006）', () => {
  it.each(HEADING_CASES)('$name：标题序列化不含前置装饰伪元素', ({ doc }) => {
    const html = renderHeadings(doc);
    // 序列化面只有语义 h1..h6（装饰由 CSS 承载；下条断言 CSS 规则）
    expect(html).toMatch(/<h[1-6]>/);
  });

  it('styles.css：.md-preview 标题不再定义 ::before 常驻灰块/竖线', () => {
    // 修复后该规则组应整体退场（padding-left 留白同步移除，正文与 Typora 同起点）
    expect(css).not.toMatch(/\.md-preview \.md-col h[1-6]::before\s*\{/);
    expect(css).not.toMatch(/\.md-preview \.md-col h[1-6]\{[^}]*padding-left:calc\(var\(--mdir-head-gutter/);
  });

  it('styles.css：IR 标题与正文同一左缘（无留白栏缩进），井号仅编辑态 inline 显示（004 修订 2026-11-22）', () => {
    // 标题行不得携带留白栏 padding（Typora 对齐：标题正文左对齐）
    expect(css).not.toMatch(/\.md-ir \.cm-line:is\(\.mdir-h1[^)]*\)\{[^}]*padding-left:calc\(var\(--mdir-head-gutter/);
    // 默认（阅读态）无任何 ::before 内容
    const irBefore = css.match(/\.md-ir \.cm-line:is\(\.mdir-h1[^)]*\)::before\{[^}]*\}/g)?.join('\n') ?? '';
    expect(irBefore).toContain('content:none');
    // 编辑态井号：行首 inline 显示（正文右移，Typora 行为），小号 muted
    expect(css).toMatch(/mdir-marks-on::before\{[^}]*content:attr\(data-marks\)/);
  });

  it('styles.css：marks-on 编辑态井号样式可辨（muted 色小号）', () => {
    expect(css).toMatch(/mdir-marks-on::before\{[^}]*color:var\(--muted\)/);
  });

  it('styles.css：大纲闪示动画存在且终态透明（临时态不残留）', () => {
    expect(css).toMatch(/@keyframes mdir-flash-kf\{[\s\S]*?100%\{background:transparent\}/);
  });
});

describe('IR 标题类名契约（projector 装饰不改语义）', () => {
  it('headings 元数据与基准期望一致（大纲定位输入不变）', () => {
    for (const { doc, expected } of HEADING_CASES) {
      const heads = extractMarkdownMetadata(doc).headings;
      expect(heads.map(h => ({ level: h.level, text: h.text }))).toEqual(expected);
    }
  });
});
