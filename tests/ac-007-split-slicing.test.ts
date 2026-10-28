// @vitest-environment jsdom
// D-T2-01 第二层回归锁：分屏首渲分片让出（主线程不实心阻塞）+ 渐进挂载 + 片边界可中断。
// 结构特征锁（不依赖真实计时）：
// 1) 每宏任务块数有界（= SLICE_BLOCKS）：让出点被门住时，首轮只完成一片；
// 2) 渐进挂载：空列先上 DOM，片内块在片边界批量上屏（D-T2-03 A：DocumentFragment 逐片挂载，
// 不再每块一次 appendChild；冷渲染首片仍秒级可见，不等整批）；
// 3) 片间可中断：让出点上作废后不再渲染后续块，且已渲块已入缓存——补跑从缓存续渲不重已完部分；
// 4) 填充中 destroy（切形态路径 viewCleanup 的同步动作）：旧循环在首个片边界退出，
// 重挂新实例单列完成、无第二份并发填充叠加（D-T2-03 C）。
// 让出点经 vi.mock('../src/common/yield') 门住：resolve 权在测试手里，片边界完全可控。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ pending: [] as Array<() => void>, calls: 0 }));
vi.mock('../src/common/yield', () => ({
  yieldToBrowser: (): Promise<void> => new Promise(resolve => { gate.calls++; gate.pending.push(resolve); }),
}));

import { createBlockRenderer, SLICE_BLOCKS } from '../src/markdown-view/blockcache';

/** 冻结时钟：时间预算永不触顶，分片只按块数上限推进（结构锁确定性；真实运行两条边界都在） */
beforeEach(() => { vi.spyOn(performance, 'now').mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); gate.pending.length = 0; gate.calls = 0; });

/** N 个独立段落块（全未命中 → 渐进路径） */
const docOf = (n: number): string => Array.from({ length: n }, (_, i) => `段落${i}\n\n`).join('');

/** 释放当前已注册的让出点，并等一个宏任务让分片循环推进到下一个让出点 */
async function tick(): Promise<void> {
  for (const resolve of gate.pending.splice(0)) resolve();
  await new Promise(done => setTimeout(done, 0));
}

describe('D-T2-01 分屏首渲分片让出（结构锁）', () => {
  it('每宏任务块数有界：让出点门住时首轮只渲一片；渐进挂载空列先上 DOM', async () => {
    const calls: string[] = [];
    const r = createBlockRenderer(async s => { calls.push(s); return `<p>${s}</p>`; });
    const host = document.createElement('div');
    const pending = r.render(host, docOf(SLICE_BLOCKS + 16), { dark: false });
    await tick(); // 首片跑完，循环停在被门住的第一个让出点
    const col = host.firstElementChild as HTMLElement;
    expect(col?.className).toBe('md-col'); // 渐进挂载：列已上 DOM（空列即时可见）
    expect(col.children.length).toBe(SLICE_BLOCKS); // 片内块数 = 分片上限（不一口气跑完）
    expect(calls.length).toBe(SLICE_BLOCKS);
    await tick(); // 第二片（余 16 块，不足上限）→ 完成提交
    const res = await pending;
    expect(res.committed).toBe(true);
    expect(col.children.length).toBe(SLICE_BLOCKS + 16);
    expect(gate.calls).toBe(1); // 全程只有一个让出点（80 块 = 64+16）
  });

  it('片间可中断：让出点作废即止，已渲块入缓存——补跑续渲不重已完部分', async () => {
    const calls: string[] = [];
    const r = createBlockRenderer(async s => { calls.push(s); return `<p>${s}</p>`; });
    const host = document.createElement('div');
    const doc = docOf(SLICE_BLOCKS * 3 + 8); // 200 块
    const first = r.render(host, doc, { dark: false });
    await tick(); // 首片 64 块完成，门住在让出点
    expect(calls.length).toBe(SLICE_BLOCKS);
    r.invalidate(); // 编辑到达：作废在途渲染
    for (const resolve of gate.pending.splice(0)) resolve();
    expect((await first).committed).toBe(false);
    expect(calls.length).toBe(SLICE_BLOCKS); // 中断后未再渲染任何块
    // 补跑最新一次（防抖语义对应的新一轮）：前 64 块全部命中缓存，只渲剩余 136 块
    const second = r.render(host, doc, { dark: false });
    for (let i = 0; i < 8; i++) await tick(); // 逐片推进直至完成
    const res = await second;
    expect(res.committed).toBe(true);
    expect(calls.length).toBe(SLICE_BLOCKS * 3 + 8); // 64（首轮）+ 136（补跑）= 全量仅一次/块
    expect(host.children.length).toBe(1); // 新列交接撤净旧（部分）列
    expect((host.firstElementChild as HTMLElement).children.length).toBe(SLICE_BLOCKS * 3 + 8);
  });

  it('填充中 destroy（切形态）：旧循环首个片边界退出，重挂单列完成无并发第二份', async () => {
    const calls: string[] = [];
    const fake = async (s: string): Promise<string> => { calls.push(s); return `<p>${s}</p>`; };
    const host = document.createElement('div');
    const doc = docOf(SLICE_BLOCKS * 4); // 256 块
    const r1 = createBlockRenderer(fake);
    const first = r1.render(host, doc, { dark: false });
    await tick(); // 首片 64 块完成并已批量上屏，门住在让出点
    expect(calls.length).toBe(SLICE_BLOCKS);
    expect((host.firstElementChild as HTMLElement).children.length).toBe(SLICE_BLOCKS);
    r1.destroy(); // viewCleanup 的同步动作：destroyed + generation bump 必达在途循环
    host.firstElementChild?.remove(); // 对应 viewarea.innerHTML='' 的整列摘除
    for (const resolve of gate.pending.splice(0)) resolve();
    expect((await first).committed).toBe(false);
    const stopped = calls.length;
    await tick(); // 旧循环若未退出会在此推进下一片
    expect(calls.length).toBe(stopped); // 退出后未再渲染任何块
    // 重挂新实例（同文档重新进分屏）：单列完成、每块仍只渲一次（旧 64 + 新 256）
    const r2 = createBlockRenderer(fake);
    const second = r2.render(host, doc, { dark: false });
    for (let i = 0; i < 8; i++) await tick();
    const res = await second;
    expect(res.committed).toBe(true);
    expect(host.children.length).toBe(1);
    expect((host.firstElementChild as HTMLElement).children.length).toBe(SLICE_BLOCKS * 4);
    expect(calls.length).toBe(SLICE_BLOCKS + SLICE_BLOCKS * 4);
  });
});
