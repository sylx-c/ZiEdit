// 批 6 追修（真机演示发现）：窗口标题栏对对比伪标签显示成整条 URL 编码串
// （"%3A%5CProject..."），用户看不出"哪两个文件在比"。根因：shell 标题栏自造 basename。
// 现口径收口于 src/common/tab-title.ts，标签栏 / 标题栏 / 入口共用一份实现；
// 对比标签与标签栏一致显示 "A ↔ B"。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { comparePair, tabDisplayName } from '../src/common/tab-title';
import { t, tf } from '../src/common/i18n';

const enc = encodeURIComponent;
const comparePath = (a: string, b: string): string => `compare://${enc(a)}|${enc(b)}`;

describe('008/001 AC：标签显示名（标题栏与标签栏同源）', () => {
  it('对比伪标签 → "A ↔ B"（不再是 URL 编码串）', () => {
    const p = comparePath('E:\\demo\\①预算表-旧版.xlsx', 'E:\\demo\\①预算表-新版.xlsx');
    expect(tabDisplayName({ path: p })).toBe('①预算表-旧版.xlsx ↔ ①预算表-新版.xlsx');
    expect(tabDisplayName({ path: p })).not.toContain('%');
  });

  it('comparePair：解出两个真实路径，非对比/结构损坏返回 null', () => {
    const p = comparePath('E:\\demo\\a.xlsx', 'E:\\demo\\b.xlsx');
    expect(comparePair(p)).toEqual(['E:\\demo\\a.xlsx', 'E:\\demo\\b.xlsx']);
    expect(comparePair('E:\\demo\\a.xlsx')).toBeNull();
    expect(comparePair('compare://only-one')).toBeNull();
    // 裸 '|' 只可能来自手改/旧格式会话：按第一个分隔符尽力拆分（不再整条判 null）
    expect(comparePair('compare://a|b|c')).toEqual(['a', 'b|c']);
  });

  it('正向/反向分隔符与坏编码都不抛错（会话文件可被外部改写）', () => {
    expect(tabDisplayName({ path: comparePath('E:/a/x.txt', 'E:\\a\\y.txt') })).toBe('x.txt ↔ y.txt');
    expect(tabDisplayName({ path: 'compare://E:%ZZ|a.txt' })).toBe('E:%ZZ ↔ a.txt');
  });

  it('真实文件取文件名；尾随台与草稿走各自文案', () => {
    expect(tabDisplayName({ path: 'E:\\work\\a.md' })).toBe('a.md');
    expect(tabDisplayName({ path: 'E:/work/sub/b.txt' })).toBe('b.txt');
    expect(tabDisplayName({ path: 'tail://' })).toBe(t('tab.tailboard'));
    expect(tabDisplayName({ path: 'draft://scratch-1' })).toBe(tf('tab.draft', 'scratch-1'));
  });

it('状态栏提示区不铺原始伪路径（与标题栏同源的乱码问题）', () => {
    const src = readFileSync(resolve(__dirname, '../src/shell/app.ts'), 'utf8');
    expect(src).toMatch(/setHintDefault\(tab \? hintOf\(tab\) : \$t\('status\.ready'\)\)/);
    expect(src).not.toMatch(/setHintDefault\(tab \? \(tab\.path\.startsWith\('draft:\/\/'\)/);
    expect(src).toMatch(/const hintOf = \(tab: TabState\): string =>[\s\S]{0,220}tabDisplayName\(tab\)/);
  });

  it('标签悬停提示不打印 compare:// 编码串（改用 A/B 两侧路径）', () => {
    const src = readFileSync(resolve(__dirname, '../src/shell/app.ts'), 'utf8');
    expect(src).toMatch(/const pair = comparePair\(tab\.path\);/);
    expect(src).toMatch(/A: \$\{pair\[0\]\}\\nB: \$\{pair\[1\]\}/);
  });

  it('app.ts 不再自带第二份显示名实现（防两套口径漂移）', () => {
    const src = readFileSync(resolve(__dirname, '../src/shell/app.ts'), 'utf8');
    expect(src).toMatch(/from '\.\.\/common\/tab-title'/);
    expect(src).not.toMatch(/function tabDisplayName\s*\(/);
    // activeName 必须复用同源实现，不得再手写 basename
    expect(src).toMatch(/return t \? tabDisplayName\(t\) : null;/);
  });
});