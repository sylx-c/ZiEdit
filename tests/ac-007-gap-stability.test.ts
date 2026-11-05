// 007 空段稳定性回归（用户 2026-10-19 反馈 2：代码块后空行激活/首字输入时内容突然下移）。
// 2026-10-30 用户定稿：即时渲染块间距向渲染预览看齐，空行由块间距承载，不再各占完整源行高。
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
  it('.mdir-gap 压缩为预览块间距，不再保留完整源行高', () => {
    const rule = ruleOf('.md-ir .cm-line.mdir-gap');
    expect(rule).toContain('min-height:0');
    expect(rule).toContain('line-height:0');
    expect(rule).toContain('padding-top:var(--mdir-gap-height)');
    expect(rule).not.toContain('min-height:1.6em');
  });
  it('.mdir-gap-active 不再改变盒尺寸（光标进出零位移）', () => {
    const rule = ruleOf('.md-ir .cm-line.mdir-gap-active');
    expect(rule).not.toContain('min-height');
    expect(rule).not.toContain('padding-top');
    expect(rule).not.toContain('height');
  });
  it('layout.ts 仍为连续空行只在首行分配块间距（防亚像素累积口径不变）', () => {
    const layout = readFileSync(resolve(__dirname, '../src/markdown-view/layout.ts'), 'utf8');
    expect(layout).toContain("--mdir-gap-height:${n === start ? height : '0px'}");
  });
});
