// T002-04 回归锁（审计 db528fd P1 3a）：查看态行缓存字节预算——修前 Map 只增不减且缩略图
// 预取按行采样整文件，1GB/22 万长行文件浏览即把全文搬进 JS 字符串（内存无界，红线邻域）。
// 002 规则 2（大文件查看内存有界）。LinesCache 为纯类，直测。
import { describe, expect, it } from 'vitest';
import { LinesCache } from '../src/text-view/view';

describe('T002-04 LinesCache 字节预算', () => {
  it('set 记账 / delete 扣账 / clear 归零', () => {
    const c = new LinesCache(1000);
    c.set(1, 'a'.repeat(100));
    expect(c.usedBytes).toBe(100);
    c.set(1, 'b'.repeat(50)); // 覆盖同键：先扣旧账
    expect(c.usedBytes).toBe(50);
    c.set(2, 'x'.repeat(30));
    c.delete(2);
    expect(c.usedBytes).toBe(50);
    c.clear();
    expect(c.usedBytes).toBe(0);
    expect(c.size).toBe(0);
  });

  it('超预算按离视口最远淘汰到 80%（视口行保留）', () => {
    const budget = 1000;
    const c = new LinesCache(budget);
    // 500 行 × 10B = 5000B，视口中心在 250
    for (let n = 1; n <= 500; n++) c.set(n, '0123456789');
    expect(c.usedBytes).toBe(5000);
    const evicted = c.trimToBudget(250);
    expect(evicted).toBe(true);
    expect(c.usedBytes).toBeLessThanOrEqual(budget * 0.8 + 10); // 逐键扣到 ≤80%
    expect(c.has(250)).toBe(true); // 视口行保留
    expect(c.has(251)).toBe(true);
    // 最远端被淘汰
    expect(c.has(1)).toBe(false);
    expect(c.has(500)).toBe(false);
  });

  it('预算内 trim 不动作；hasBudget 闸语义', () => {
    const c = new LinesCache(100);
    c.set(1, 'a'.repeat(10));
    expect(c.trimToBudget(1)).toBe(false);
    expect(c.hasBudget()).toBe(true);
    c.set(2, 'b'.repeat(200));
    expect(c.hasBudget()).toBe(false);
  });
});
