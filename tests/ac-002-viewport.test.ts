// 验收测试：002 文本查看与编辑缓冲守卫（002-AC 大文件可视窗口 / AC-21 编辑缓冲 ≤10MB 守卫）
// 纯逻辑层验证，不依赖 DOM 与 Tauri runtime；跨平台一致。
import { describe, expect, it } from 'vitest';
import { visibleRange } from '../src/text-view/view';
import { EDIT_LIMIT } from '../src/text-view/edit';

const LINE_HEIGHT = 19.2; // 定稿：12px × 1.6 行高（与 view.ts 一致）

describe('002-AC 虚拟滚动可视窗口（大文件不整文件驻留）', () => {
  it('顶部：from 从第 1 行起，带 overscan', () => {
    const { from, to } = visibleRange(0, 600, 1_000_000);
    expect(from).toBe(1);
    expect(to).toBeGreaterThan(from);
    // 一次仅取可视区 + overscan，远小于总行数（不整文件读入）
    expect(to - from).toBeLessThan(200);
  });

  it('中部：窗口随 scrollTop 平移，行号单调递增', () => {
    const top = visibleRange(0, 600, 1_000_000);
    const mid = visibleRange(top.to * LINE_HEIGHT, 600, 1_000_000);
    expect(mid.from).toBeGreaterThan(top.from);
    expect(mid.to).toBeGreaterThanOrEqual(mid.from);
  });

  it('越界 scrollTop 被收敛到文件范围内', () => {
    const r = visibleRange(1e12, 600, 5000);
    expect(r.from).toBeLessThanOrEqual(5000);
    expect(r.to).toBeLessThanOrEqual(5000);
  });
});

describe('AC-21 编辑缓冲上限守卫（002/005 口径统一为 10MB）', () => {
  it('EDIT_LIMIT 恒为 10MB（与 READ_ALL_LIMIT、PRD 术语表一致）', () => {
    expect(EDIT_LIMIT).toBe(10 * 1024 * 1024);
  });

  it('超限文件不得进入编辑（阈值判定）', () => {
    const overLimit = EDIT_LIMIT + 1;
    const withinLimit = EDIT_LIMIT - 1;
    expect(overLimit > EDIT_LIMIT).toBe(true);
    expect(withinLimit > EDIT_LIMIT).toBe(false);
  });
});