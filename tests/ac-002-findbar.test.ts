// @vitest-environment jsdom
// 002 统一查找栏验收（H-6 走查补盲）：「第 N / 共 M 处」计数显示逻辑此前零单测——
// 查看态计数走 text_find 的 {hit, total, before} 形状，harness 假件曾回错形状（{line,col}），
// 使「共 N 处」在 harness 里永远空着还被误当成应用缺陷；本组直接锁死 FindBar 消费形状。
import { describe, expect, it, vi } from 'vitest';
import { FindBar, type FindRunResult } from '../src/text-view/findbar';

function makeBar(run: FindBar['cfg']['run']): FindBar {
  return new FindBar({ run });
}

function shown(bar: FindBar): string {
  return (bar.el.querySelector('.fb-count') as HTMLElement).textContent ?? '';
}

describe('AC-9 统一查找栏计数（FindBar.display 消费 {hit,total,before}）', () => {
  it('输入防抖：count=true jump=false → 显示「共 N 处」', async () => {
    const run = vi.fn().mockResolvedValue({ hit: { line: 2, col: 1 }, counts: { total: 3, before: 1 } });
    const bar = makeBar(run);
    bar.show();
    const input = bar.el.querySelector('.tv-bar-input') as HTMLInputElement;
    input.value = 'abc';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 420)); // 防抖 300ms
    expect(run).toHaveBeenCalledWith('abc', expect.anything(), 1, true, false);
    expect(shown(bar)).toBe('共 3 处');
  });

  it('Enter 命中：hit + before → 「第 N / 共 M 处」', async () => {
    const run = vi.fn().mockResolvedValue({ hit: { line: 5, col: 3 }, counts: { total: 7, before: 2 } });
    const bar = makeBar(run);
    bar.show('abc');
    const input = bar.el.querySelector('.tv-bar-input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    expect(run).toHaveBeenCalledWith('abc', expect.anything(), 1, true, true);
    expect(shown(bar)).toBe('第 3 / 7 处');
  });

  it('零命中但已计数（total=0）→ 「共 0 处」；未计数且无命中 → 「未找到」', async () => {
    const zero: FindRunResult = { hit: null, counts: { total: 0, before: null } };
    const bar = makeBar(vi.fn().mockResolvedValue(zero));
    bar.show('zz');
    const input = bar.el.querySelector('.tv-bar-input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    expect(shown(bar)).toBe('共 0 处');

    const unknown: FindRunResult = { hit: null, counts: { total: null, before: null } };
    const bar2 = makeBar(vi.fn().mockResolvedValue(unknown));
    bar2.show('zz');
    const input2 = bar2.el.querySelector('.tv-bar-input') as HTMLInputElement;
    input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    expect(shown(bar2)).toBe('未找到');
  });

  it('total=null（宿主无法计数）→ 计数格留空，不误显「共 0 处」', async () => {
    const run = vi.fn().mockResolvedValue({ hit: { line: 1, col: 1 }, counts: { total: null, before: null } });
    const bar = makeBar(run);
    bar.show('k');
    const input = bar.el.querySelector('.tv-bar-input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    expect(shown(bar)).toBe('');
  });
});
