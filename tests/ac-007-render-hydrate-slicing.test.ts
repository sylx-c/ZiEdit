// @vitest-environment jsdom
// D-T2-04 回归锁：hydrateRenders 分片派发（万级公式不再同拍入队）+ 同容器重入代际去重。
// 结构特征锁（不依赖真实计时，参照 ac-007-split-slicing 手法门住让出点）：
// 1) 每宏任务水合目标数有界（= HYDRATE_SLICE_TARGETS）：门住时首轮只派发一片；
// 2) 同容器重入：新一轮派发即接管，旧队列在首个片边界自弃（不再派发后续目标）；
// 3) 容器失效（current=false）：派发在片边界退出。
// jsdom 不加载 MathJax 资产：mountRender 的 80ms 回调停留在 pending，无副作用；
// 派发可观察位 = mountRender 同步写入的 data-render-state="loading"。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ pending: [] as Array<() => void> }));
vi.mock('../src/common/yield', () => ({
  yieldToBrowser: (): Promise<void> => new Promise(resolve => { gate.pending.push(resolve); }),
}));

import { hydrateRenders, HYDRATE_SLICE_TARGETS } from '../src/markdown-view/render-service';
import { renderPlaceholder, type RenderBlock } from '../src/markdown-view/render-model';

/** 冻结时钟：时间预算永不触顶，分片只按目标数上限推进（真实运行两条边界都在） */
beforeEach(() => { vi.spyOn(performance, 'now').mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); gate.pending.length = 0; });

const mountedCount = (root: HTMLElement): number => root.querySelectorAll('[data-render-state="loading"]').length;

function scene(count: number): { root: HTMLElement; blocks: RenderBlock[] } {
  const blocks = Array.from({ length: count }, (_, i): RenderBlock => ({ kind: 'math', source: `x_{${i}}`, display: false, from: i, to: i + 1 }));
  const root = document.createElement('div');
  const template = document.createElement('template');
  for (const block of blocks) {
    template.innerHTML = renderPlaceholder(block);
    root.append(template.content.firstElementChild!);
  }
  return { root, blocks };
}

/** 释放当前已注册的让出点，并等宏任务让分片循环推进到下一个让出点 */
async function tick(): Promise<void> {
  for (const resolve of gate.pending.splice(0)) resolve();
  await new Promise(done => setTimeout(done, 0));
}

describe('D-T2-04 水合分片派发（结构锁）', () => {
  it('每宏任务目标数有界：门住时首轮只派发一片，后续片逐让出点推进', async () => {
    const { root, blocks } = scene(HYDRATE_SLICE_TARGETS * 2 + 4);
    hydrateRenders(root, blocks, false, () => true);
    expect(mountedCount(root)).toBe(HYDRATE_SLICE_TARGETS); // 首片同步派发，停在第一个让出点
    await tick();
    expect(mountedCount(root)).toBe(HYDRATE_SLICE_TARGETS * 2);
    await tick();
    expect(mountedCount(root)).toBe(HYDRATE_SLICE_TARGETS * 2 + 4); // 末片不足上限，无新让出点
  });

  it('同容器重入：新一轮派发即接管，旧队列首个片边界自弃', async () => {
    const { root, blocks } = scene(HYDRATE_SLICE_TARGETS * 3);
    hydrateRenders(root, blocks, false, () => true);
    expect(mountedCount(root)).toBe(HYDRATE_SLICE_TARGETS);
    hydrateRenders(root, [], false, () => true); // 重入（新一轮）：目标集为空，仅接管代际
    for (let i = 0; i < 4; i++) await tick();
    expect(mountedCount(root)).toBe(HYDRATE_SLICE_TARGETS); // 旧队列未再派发任何目标
  });

  it('容器失效（current=false）：派发在片边界退出，旧容器不再被触碰', async () => {
    const { root, blocks } = scene(HYDRATE_SLICE_TARGETS * 3);
    let alive = true;
    hydrateRenders(root, blocks, false, () => alive);
    expect(mountedCount(root)).toBe(HYDRATE_SLICE_TARGETS);
    alive = false; // 视图销毁/代际作废
    for (let i = 0; i < 4; i++) await tick();
    expect(mountedCount(root)).toBe(HYDRATE_SLICE_TARGETS);
  });
});
