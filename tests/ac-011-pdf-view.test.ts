// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ bytes: vi.fn(), open: vi.fn(), system: vi.fn(), stat: vi.fn() }));
vi.mock('../src/pdf-view/engine', () => ({ loadPdfBytes: fake.bytes, openDocument: fake.open,
  destroyOnce: (target: { destroy(): void }) => Promise.resolve(target.destroy()) }));
vi.mock('../src/common/ipc', () => ({ openWithDefault: fake.system, fileStat: fake.stat }));
import { PdfView } from '../src/pdf-view/view';
import { t } from '../src/common/i18n';
it('信息条缩放入口可用', () => {
  expect(PdfView.prototype.zoomBy).toBeTypeOf('function');
  expect(PdfView.prototype.rotate).toBeTypeOf('function');
});
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); host = document.createElement('div'); document.body.replaceChildren(host);
  fake.bytes.mockResolvedValue(new ArrayBuffer(0)); fake.stat.mockResolvedValue({ len: 100 });
  fake.system.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllGlobals());
async function successfulView() {
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const page = { rotate: 0, getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }), cleanup: vi.fn(), render };
  const destroy = vi.fn(); fake.open.mockResolvedValue({ doc: { numPages: 10, getPage: vi.fn(async () => page) }, loadingTask: { destroy } });
  const view = new PdfView(host, '/a.pdf'); await view.mount();
  return { view, scroll: host.querySelector('.pdf-scroll') as HTMLDivElement, render, destroy };
}
it('缩放 clamp、双击 fit/100 循环、Ctrl wheel 不阻断原生滚动，焦点保持', async () => {
  const { view, scroll } = await successfulView();
  const button = host.querySelector('[data-action=zoom-in]') as HTMLButtonElement; button.focus();
  view.zoomBy(1000); expect(host.querySelector('[data-action=fit]')!.textContent).toBe('800%');
  view.zoomBy(0.00001); expect(host.querySelector('[data-action=fit]')!.textContent).toBe('10%');
  const regular = new WheelEvent('wheel', { deltaY: 1, cancelable: true }); scroll.dispatchEvent(regular); expect(regular.defaultPrevented).toBe(false);
  const ctrl = new WheelEvent('wheel', { ctrlKey: true, deltaY: -1, cancelable: true }); scroll.dispatchEvent(ctrl); expect(ctrl.defaultPrevented).toBe(true);
  scroll.dispatchEvent(new MouseEvent('dblclick')); expect(view.displayMode).toBe('fit');
  scroll.dispatchEvent(new MouseEvent('dblclick')); expect(view.displayMode).toBe('100');
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
  window.dispatchEvent(new Event('resize')); expect(document.activeElement).toBe(button);
  view.destroy(); view.destroy();
  const after = new WheelEvent('wheel', { ctrlKey: true, cancelable: true }); scroll.dispatchEvent(after); expect(after.defaultPrevented).toBe(false);
});
it('页码跳转、键盘原生滚动辅助与销毁资源幂等', async () => {
  const { view, scroll, destroy } = await successfulView();
  const input = host.querySelector('input')!; input.value = '8';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  await vi.waitFor(() => expect(host.querySelectorAll('.pdf-page').length).toBeGreaterThanOrEqual(8));
  await vi.waitFor(() => expect(scroll.scrollTop).toBe(7 * 224));
  scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); expect(scroll.scrollTop).toBe(7 * 224 + 40);
  scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' })); expect(scroll.scrollTop).toBe(0);
  view.destroy(); view.destroy(); expect(destroy).toHaveBeenCalledTimes(1);
});
it('加载态后解析失败给三出口及如实的文本限制', async () => {
  fake.open.mockRejectedValue(new Error('broken'));
  const fallback = vi.fn(); const view = new PdfView(host, '/a.pdf', fallback);
  const mounting = view.mount();
  expect(host.querySelector('[role=status]')).not.toBeNull();
  await mounting;
  expect(host.querySelector('[role=alert]')).not.toBeNull();
  expect(host.textContent).toContain(t('pdf.fallbackNote'));
  expect(host.textContent).not.toContain(t('pdf.encryptedNote'));
  (host.querySelector('[data-action=fallback]') as HTMLButtonElement).click();
  expect(fallback).toHaveBeenCalledWith('/a.pdf');
  (host.querySelector('[data-action=system]') as HTMLButtonElement).click();
  expect(fake.system).toHaveBeenCalledWith('/a.pdf'); view.destroy();
});
it('密码错误与解析失败区分，重试可重新加载', async () => {
  fake.open.mockRejectedValue(Object.assign(new Error('password'), { name: 'PasswordException' }));
  const view = new PdfView(host, '/a.pdf'); await view.mount();
  expect(host.textContent).toMatch(/加密|encrypted/i);
  expect(host.textContent).toContain(t('pdf.encryptedNote'));
  expect(host.textContent).not.toContain(t('pdf.fallbackNote'));
  (host.querySelector('[data-action=retry]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(fake.open).toHaveBeenCalledTimes(2)); view.destroy();
});
it('加载中销毁中止 fetch；迟到回调不写 DOM、不产生未处理拒绝', async () => {
  let finish!: (v: ArrayBuffer) => void;
  fake.bytes.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const unhandled = vi.fn(); window.addEventListener('unhandledrejection', unhandled);
  const view = new PdfView(host, '/a.pdf'); const mounting = view.mount();
  await vi.waitFor(() => expect(fake.bytes).toHaveBeenCalled());
  const signal = fake.bytes.mock.calls[0]![1] as AbortSignal;
  view.destroy(); view.destroy(); finish(new ArrayBuffer(0)); await mounting;
  expect(signal.aborted).toBe(true); expect(host.childNodes.length).toBe(0);
  expect(fake.open).not.toHaveBeenCalled(); expect(unhandled).not.toHaveBeenCalled();
  window.removeEventListener('unhandledrejection', unhandled);
});
