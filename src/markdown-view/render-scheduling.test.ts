// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const queue = vi.hoisted(() => ({ jobs: new Map<number, () => void>(), serial: 0 }));
vi.mock('../common/render-queue', () => ({
  requestIrFrame: (run: () => void) => { const id = ++queue.serial; queue.jobs.set(id, run); return id; },
  cancelIrFrame: (id: number) => { queue.jobs.delete(id); },
}));

beforeEach(() => { vi.resetModules(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); queue.jobs.clear(); document.body.replaceChildren(); });

function library() {
  const typeset = vi.fn(async (elements: HTMLElement[]) => {
    for (const stage of elements) for (const slot of stage.children) slot.innerHTML = '<svg><path d="M0 0L1 1"/></svg>';
  });
  vi.spyOn(document.head, 'append').mockImplementation((...nodes: (Node | string)[]) => {
    const script = nodes[0] as HTMLScriptElement;
    Object.assign(window, { MathJax: { startup: { promise: Promise.resolve() }, texReset: vi.fn(),
      tex2svgPromise: async () => document.createElement('span'), typesetPromise: typeset, typesetClear: vi.fn() } });
    queueMicrotask(() => script.dispatchEvent(new Event('load')));
  });
  return typeset;
}
async function releaseFrame() {
  const batch = [...queue.jobs]; queue.jobs.clear();
  for (const [, run] of batch) run();
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

it('yields after cold library initialization before starting the first formula', async () => {
  const typeset = library();
  const { requestRender, createRenderContext } = await import('./render-service');
  const block = { kind: 'math' as const, source: 'x+1', display: false, from: 0, to: 3 };
  const result = requestRender(block, createRenderContext([block]), false);
  await vi.waitFor(() => expect(queue.jobs.size).toBeGreaterThan(0));
  expect(typeset).not.toHaveBeenCalled();
  await releaseFrame();
  expect((await result).html).toContain('<svg>');
});

it('delivers asynchronous results on the render queue and cancels a destroyed target before delivery', async () => {
  const typeset = library();
  const { mountRender, createRenderContext } = await import('./render-service');
  const block = { kind: 'math' as const, source: 'x+2', display: false, from: 0, to: 3 };
  const context = createRenderContext([block]), first = document.createElement('span'), second = document.createElement('span');
  document.body.append(first, second);
  const stopFirst = mountRender(first, block, context, false);
  const stopSecond = mountRender(second, block, context, false);
  await vi.advanceTimersByTimeAsync(80);
  await releaseFrame();
  await vi.waitFor(() => expect(typeset).toHaveBeenCalledTimes(1));
  for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(first.dataset.renderState).toBe('loading');
  expect(second.dataset.renderState).toBe('loading');
  stopSecond();
  await releaseFrame();
  expect(first.dataset.renderState).toBe('ready');
  expect(first.querySelector('svg')).not.toBeNull();
  expect(second.querySelector('svg')).toBeNull();
  expect(second.textContent).toBe(block.source);
  stopFirst();
});

it('returns held results to the render queue when scrolling ends instead of committing in a timer', async () => {
  library();
  const { mountRender, createRenderContext } = await import('./render-service');
  const block = { kind: 'math' as const, source: 'x+3', display: false, from: 0, to: 3 };
  const target = document.createElement('span'); document.body.append(target);
  let held = true;
  const stop = mountRender(target, block, createRenderContext([block]), false, () => true, undefined, () => held);
  try {
    await vi.advanceTimersByTimeAsync(80);
    await releaseFrame();
    await releaseFrame();
    expect(target.dataset.renderState).toBe('loading');
    held = false;
    await vi.advanceTimersByTimeAsync(30);
    expect(target.dataset.renderState).toBe('loading');
    expect(queue.jobs.size).toBe(1);
    await releaseFrame();
    expect(target.dataset.renderState).toBe('ready');
  } finally { stop(); }
});
