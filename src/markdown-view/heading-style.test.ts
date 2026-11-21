// 004 US2（T011）：标题视觉契约回归测试（Typora parity P1）。
// 契约（data-model §3 Heading Visual State.decorations/.surface/.interaction）：
// 阅读态标题前不得有常驻灰块/竖线/阴影（Typora 对齐）；IR 编辑辅助（井号）只在明确
// 交互态出现且不改变正文几何；大纲闪示为临时动画且终态透明。
// jsdom 不加载外部 CSS，装饰断言按仓库既有口径落在 styles.css 规则文本与 DOM 类名上。
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { staticMarkdownParser, renderStaticHtml } from './static-html';
import { extractMarkdownMetadata } from './headings';
import { loadMarkdownIt } from './md';
import { HEADING_CASES } from './typora-baseline';

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');

beforeAll(async () => {
  // 标题含链接案例走 markdown-it 链接工具（主线程共享单例预取，见 md.ts）
  await import('./md-link').then(() => loadMarkdownIt());
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

  it('styles.css：IR 标题留白栏保留几何但无常驻背景/边框（cursorWidthChange=0 不变量）', () => {
    // 留白栏宽度与 padding-left 必须保留（正文 x 不变）
    expect(css).toMatch(/\.md-ir \.cm-line:is\(\.mdir-h1[^)]*\)\{[^}]*padding-left:calc\(var\(--mdir-head-gutter/);
    // 常驻灰块（background + border-left 的组合）必须退场
    const irBefore = css.match(/\.md-ir \.cm-line:is\(\.mdir-h1[^)]*\)::before\{[^}]*\}/g)?.join('\n') ?? '';
    expect(irBefore).not.toMatch(/border-left:\s*3px/);
    expect(irBefore).not.toMatch(/background:\s*color-mix/);
    expect(irBefore).toMatch(/content:attr\(data-marks\)/); // 编辑态井号机制保留
  });

  it('styles.css：marks-on 编辑态仍可辨（无背景栏时的显式反馈）', () => {
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
