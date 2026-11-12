// 块间距契约单一来源：渲染预览（styles.css .md-preview 段）与即时渲染（layout.ts）共用同一模型。
// 预览 .md-block 为 flow-root（styles.css:929），相邻块边距不塌陷——块间隙 = 前块 after + 后块 before（求和，
// 非 max 塌陷）。普通块（p/列表/引用/pre/表格/dl）单边间距 before=block-gap、after=0（styles.css:935）；
// 标题按 --md-hN-before/after 双边；hr 双边 rule-gap（styles.css:952）；首块首子 margin-top:0（styles.css:953）。
// 令牌值以 styles.css:925 为权威；下方倍数表由 spacing-contract.test.ts 对 styles.css 原文校验，改 CSS 须同步。

export type BlockEdge = 'before' | 'after';

/** 与 styles.css:925 令牌系数一一对应（--md-fs-base 的倍数）。 */
export const TOKEN_MULT: Readonly<Record<string, number>> = {
  '--md-block-gap': 0.8, '--md-list-gap': 0.25, '--md-rule-gap': 1.4,
  '--md-h1-before': 2.475, '--md-h1-after': 1.2375,
  '--md-h2-before': 1.925, '--md-h2-after': 0.9625,
  '--md-h3-before': 1.65, '--md-h3-after': 0.825,
  '--md-h4-before': 0.8, '--md-h4-after': 0.55,
  '--md-h5-before': 0.8, '--md-h5-after': 0.55,
  '--md-h6-before': 0.8, '--md-h6-after': 0.55,
};

/** CM 高度估计基准（px）：与 SOURCE_LINE_HEIGHT_PX 同取默认字号 13.5；用户字号变化由 CM 实测校正。 */
export const DEFAULT_BASE_PX = 13.5;

function headingLevel(nodeName: string): string | undefined {
  return /^(?:ATX|Setext)Heading([1-6])$/.exec(nodeName)?.[1];
}

/** 块种类某侧边距的 CSS 令牌；普通块 after 为 '0px'（预览单边间距）。 */
export function marginToken(nodeName: string, edge: BlockEdge): string {
  const level = headingLevel(nodeName);
  if (level) return `--md-h${level}-${edge}`;
  if (nodeName === 'HorizontalRule') return '--md-rule-gap';
  return edge === 'before' ? '--md-block-gap' : '0px';
}

function term(token: string): string { return token === '0px' ? '0px' : `var(${token})`; }

/** 求和组合两侧边距；任一侧为 0 时退化为单令牌，避免冗余 calc。 */
function sum(afterToken: string, beforeToken: string): string {
  if (afterToken === '0px') return term(beforeToken);
  if (beforeToken === '0px') return term(afterToken);
  return `calc(${term(afterToken)} + ${term(beforeToken)})`;
}

/** 相邻兄弟块间隙 = 前块 after + 后块 before。 */
export function siblingGap(prevName: string, nextName: string): string {
  return sum(marginToken(prevName, 'after'), marginToken(nextName, 'before'));
}

/** 文档尾部预留：末块 after + 新段 before（block-gap），首字输入时不突然补出间距。 */
export function tailGap(lastName: string): string {
  return sum(marginToken(lastName, 'after'), '--md-block-gap');
}

/** 把间距表达式按默认基准估为 px（CM 高度图预估值，实测后校正）；未知令牌回退旧经验值 11。 */
export function estimateExprPx(expr: string): number {
  if (expr === '0px') return 0;
  const tokens = expr.match(/--md-[\w-]+/g) ?? [];
  let mult = 0;
  for (const t of tokens) {
    const m = TOKEN_MULT[t];
    if (m === undefined) return 11;
    mult += m;
  }
  return mult > 0 ? mult * DEFAULT_BASE_PX : 11;
}