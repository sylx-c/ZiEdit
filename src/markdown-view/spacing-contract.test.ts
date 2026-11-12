// 间距契约回归：预览 .md-block 为 flow-root（styles.css:929），相邻块边距不塌陷，
// 块间隙 = 前块 after + 后块 before（求和）；普通块 after=0（styles.css:935 单边间距），
// hr 双边 rule-gap（styles.css:952），首块首子 margin-top:0（styles.css:953）。
// 期望值按预览契约手工推导，独立于 IR 实现——修前 max() 塌陷模型在此先红。
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { blockLayout } from './layout';
import { DEFAULT_BASE_PX, TOKEN_MULT } from './spacing';
import css from '../styles.css?raw';

const FIXTURE = '# H1\n\n## H2\n\nParagraph one.\n\n> quote\n\n---\n\nFinal.\n';

// 顶层块序：ATXHeading1, ATXHeading2, Paragraph, Blockquote, HorizontalRule, Paragraph
// 间隙（含尾部预留）按预览求和契约：
const EXPECTED_GAPS = [
  'calc(var(--md-h1-after) + var(--md-h2-before))', // h1→h2
  'calc(var(--md-h2-after) + var(--md-block-gap))', // h2→p
  'var(--md-block-gap)',                            // p→quote（p after=0）
  'var(--md-rule-gap)',                             // quote→hr（quote after=0）
  'calc(var(--md-rule-gap) + var(--md-block-gap))', // hr→p（hr after=rule-gap）
  'var(--md-block-gap)',                            // 尾部预留（p after=0 + 新段 before）
];

function gapExpressions(doc: string): string[] {
  let state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  expect(ensureSyntaxTree(state, doc.length, 5000)).not.toBeNull();
  state = state.update({}).state;
  const out: string[] = [];
  for (let c = blockLayout(state, 0, doc.length).iter(); c.value; c.next()) {
    const style = c.value.spec.attributes?.style as string | undefined;
    const m = style ? /--mdir-gap-height:(.+)$/.exec(style) : null;
    if (m && m[1] !== '0px') out.push(m[1]!);
    const widget = c.value.spec.widget as { height?: string } | undefined;
    if (widget?.height && widget.height !== '0px') out.push(widget.height);
  }
  return out;
}

describe('预览/IR 间距契约（求和模型）', () => {
  it('块间隙等于前块 after + 后块 before，普通块 after=0', () => {
    expect(gapExpressions(FIXTURE)).toEqual(EXPECTED_GAPS);
  });

  it('无空行相邻块用同值间距件（不塌陷）', () => {
    const gaps = gapExpressions('# H1\n## H2\n');
    expect(gaps).toContain('calc(var(--md-h1-after) + var(--md-h2-before))');
  });
});

// 契约绑定：spacing.ts 的倍数表/边距模型必须与 styles.css 原文一致，改 CSS 不同步即红。
describe('spacing.ts ↔ styles.css 原文绑定', () => {
  it('令牌系数表与 .md-preview,.md-ir 令牌规则逐项相等（不缺不多）', () => {
    const rule = /\.md-preview,\.md-ir\{--md-block-gap:[^}]+\}/.exec(css);
    expect(rule, 'styles.css 间距令牌规则缺失（:925）').not.toBeNull();
    const cssTokens: Record<string, number> = {};
    for (const m of rule![0].matchAll(/--md-([\w-]+):calc\(var\(--md-fs-base\)\s*\*\s*([\d.]+)\)/g))
      cssTokens['--md-' + m[1]] = Number(m[2]);
    expect(Object.keys(cssTokens).sort()).toEqual(Object.keys(TOKEN_MULT).sort());
    for (const [token, mult] of Object.entries(TOKEN_MULT))
      expect(cssTokens[token], token).toBe(mult);
  });

  it('估计基准等于 --md-fs-base 的出厂默认字号', () => {
    const m = /--md-fs-base:var\(--md-fs-user,([\d.]+)px\)/.exec(css);
    expect(m, 'styles.css --md-fs-base 默认值缺失（:1496）').not.toBeNull();
    expect(DEFAULT_BASE_PX).toBe(Number(m![1]));
  });

  it('预览边距规则锁定求和模型的四个前提', () => {
    // flow-root：相邻块边距不塌陷（求和而非 max）。
    expect(css).toContain('.md-preview .md-col .md-block{display:flow-root}');
    // 普通块单边间距：before=block-gap、after=0。
    expect(css).toContain(':is(p,ul,ol,blockquote,pre,table,dl):not(.md-block){margin-block:var(--md-block-gap) 0}');
    // 标题双边间距：before/after 各取令牌。
    for (let n = 1; n <= 6; n++)
      expect(css, `h${n}`).toContain(`margin-block:var(--md-h${n}-before) var(--md-h${n}-after)`);
    // hr 双边 rule-gap。
    expect(css).toContain('hr:not(.md-block){height:1px;border:none;border-top:1px solid var(--border);background:none;margin-block:var(--md-rule-gap)}');
    // 首块首子 margin-top:0（IR 首块前导 '0px' 的依据）。
    expect(css).toMatch(/\.md-preview \.md-col>:first-child:not\(\.md-block\),[^{]*\{margin-top:0\}/);
  });
});