// 007 空段稳定性回归（用户 2026-10-19 反馈 2：代码块后空行激活/首字输入时内容突然下移）。
// REQ-014 P6 定稿：空行保持全高（挂载区高度 == CM 卸载区行数估计——停稳/跨形态滚动
// 两门禁的失配根源修复），视觉间距总量不变，差额由 mdir-block-gap 挂件承载
// （max(0, after+before−空行高×行数)，calc 求和发生在 CSS）。
// 光标进出仍不得改变盒尺寸；jsdom 不做真实布局，纵向坐标由 gate-md-consistency 真机门锁定。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

const ruleOf = (selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(esc + '\\{([^}]*)\\}').exec(css);
  if (!m) throw new Error('缺少规则 ' + selector);
  return m[1];
};

describe('007 空段盒尺寸稳定（反馈 2）', () => {
  it('.mdir-gap 不折叠高度（挂载区 == CM 卸载区行数估计；差额走 mdir-block-gap 挂件）', () => {
    const rule = ruleOf('.md-ir .cm-line.mdir-gap');
    expect(rule).not.toContain('line-height:0');
    expect(rule).not.toContain('padding-top');
    const projector = readFileSync(resolve(__dirname, '../src/markdown-view/projector.ts'), 'utf8');
    expect(projector).toContain('max(0px, calc(');
    expect(projector).toContain('LINE_H'); // 差额 = 令牌间距 − 空行高×行数
  });
  it('.mdir-gap-active 不再改变盒尺寸（光标进出零位移）', () => {
    const rule = ruleOf('.md-ir .cm-line.mdir-gap-active');
    expect(rule).not.toContain('min-height');
    expect(rule).not.toContain('padding-top');
    expect(rule).not.toContain('height');
  });
});
