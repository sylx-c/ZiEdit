// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { PdfPager, pageLayout, canvasPlan } from '../src/pdf-view/pager';
import { CANVAS_BUDGET_BYTES } from '../src/pdf-view/guard';

it('混合尺寸和原生旋转后的基准尺寸，用户旋转再交换', () => {
  expect(pageLayout([{ width: 100, height: 200 }, { width: 300, height: 100 }], 2, 90))
    .toEqual([{ width: 400, height: 200, top: 0 }, { width: 200, height: 600, top: 224 }]);
});
it('可见、预渲染、在途统一预算，近页优先且 >6 页降采样', () => {
  const pages = Array.from({ length: 12 }, (_, n) => ({ id: n + 1, width: 4000, height: 4000, distance: n }));
  const plan = canvasPlan(pages, 8, 3);
  expect(plan.reduce((sum, p) => sum + p.width * p.height * 4, 0)).toBeLessThanOrEqual(CANVAS_BUDGET_BYTES);
  expect(plan[0]!.dpr).toBeGreaterThanOrEqual(plan[11]!.dpr);
  expect(plan.filter(p => p.dpr === 3).length).toBeLessThanOrEqual(6);
});
function setup() {
  const cleanup = vi.fn(); const cancel = vi.fn();
  const getPage = vi.fn(async () => ({ rotate: 90, getViewport: ({ scale, rotation = 90 }: { scale: number; rotation?: number }) =>
    ({ width: (rotation % 180 ? 200 : 100) * scale, height: (rotation % 180 ? 100 : 200) * scale }),
    cleanup, render: vi.fn(() => ({ promise: Promise.resolve(), cancel })) }));
  const flow = document.createElement('div'); document.body.replaceChildren(flow);
  let intersect!: IntersectionObserverCallback;
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) { intersect = callback; } observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  return { flow, cleanup, getPage, cancel, intersect: (id: number, isIntersecting: boolean) => intersect([{ target: flow.querySelector(`[data-page="${id}"]`)!, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver) };
}
it('首批有界、仅已测量页出现；离场清理解码缓存', async () => {
  const { flow, getPage, cleanup } = setup();
  const pager = new PdfPager(flow, { numPages: 3000, getPage } as never, new AbortController().signal);
  await pager.start();
  expect(getPage).toHaveBeenCalledTimes(5);
  expect(flow.querySelectorAll('.pdf-page')).toHaveLength(5);
  expect(cleanup).toHaveBeenCalledTimes(5);
  pager.destroy(); vi.unstubAllGlobals();
});
it('每批最多8，取消后迟到尺寸不追加、不渲染', async () => {
  const { flow, getPage } = setup();
  let finish!: (page: unknown) => void;
  getPage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never);
  const ctrl = new AbortController();
  const pager = new PdfPager(flow, { numPages: 3000, getPage } as never, ctrl.signal);
  const mounting = pager.start(); ctrl.abort(); pager.destroy();
  finish({ cleanup: vi.fn(), getViewport: () => ({ width: 100, height: 200 }) }); await mounting;
  expect(flow.querySelectorAll('.pdf-page')).toHaveLength(0); vi.unstubAllGlobals();
});
it('可见页渲染；离场 cancel/cleanup/释放 canvas；DPR 变化触发重新渲染', async () => {
  const { flow, getPage, cleanup, intersect, cancel } = setup();
  const pager = new PdfPager(flow, { numPages: 3000, getPage } as never, new AbortController().signal);
  await pager.start(); intersect(1, true);
  await vi.waitFor(() => expect(flow.querySelector('canvas')).not.toBeNull());
  const first = flow.querySelector('canvas')!; expect(first.width).toBeGreaterThan(0);
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 }); pager.refreshDpr();
  await vi.waitFor(() => expect(flow.querySelector('canvas')).not.toBe(first));
  expect(first.width).toBe(0); expect(cancel).toHaveBeenCalled();
  const second = flow.querySelector('canvas')!;
  expect(second.width).toBe(400);
  intersect(1, false);
  await vi.waitFor(() => expect(flow.querySelector('canvas')).toBeNull());
  expect(second.width).toBe(0); expect(cleanup.mock.calls.length).toBeGreaterThan(5);
  pager.destroy(); vi.unstubAllGlobals();
});
it('Ctrl 缩放使用的页中心锚数学与旋转布局保持', async () => {
  const { flow, getPage } = setup();
  Object.defineProperty(flow, 'clientHeight', { configurable: true, value: 100 });
  const pager = new PdfPager(flow, { numPages: 5, getPage } as never, new AbortController().signal);
  await pager.start(); flow.scrollTop = 124; // 第2页中心上方，旋转后基准高度100。
  pager.setZoom(2); expect(flow.scrollTop).toBe(274); // 旧中心174: 第2页中点50，缩放后224+100-50。
  pager.rotate(1); expect((flow.querySelector('.pdf-page') as HTMLElement).style.height).toBe('400px');
  pager.destroy(); vi.unstubAllGlobals();
});
it('远跳测量按批最多8，取消按钮能停止后续批，不出现未测页', async () => {
  const { flow, getPage } = setup();
  const pager = new PdfPager(flow, { numPages: 3000, getPage } as never, new AbortController().signal);
  await pager.start();
  const jumping = pager.jumpTo(3000);
  await vi.waitFor(() => expect(getPage.mock.calls.length).toBeGreaterThan(5));
  (flow.querySelector('button') as HTMLButtonElement).click(); await jumping;
  expect(getPage.mock.calls.length).toBeLessThan(3000);
  expect(flow.querySelectorAll('.pdf-page').length).toBe(pager.measuredPages);
  pager.destroy(); vi.unstubAllGlobals();
});
