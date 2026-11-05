import { beforeEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ getDocument: vi.fn(), options: { workerSrc: '' } }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument: fake.getDocument, GlobalWorkerOptions: fake.options }));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({ default: '/worker.mjs' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { destroyOnce, loadPdfBytes, openDocument } from '../src/pdf-view/engine';

beforeEach(() => { vi.clearAllMocks(); });
it('设置配对 legacy worker 并保留内置降级所有权', async () => {
  const doc = { destroy: vi.fn() };
  fake.getDocument.mockReturnValue({ promise: Promise.resolve(doc), destroy: vi.fn() });
  expect((await openDocument(new ArrayBuffer(0), new AbortController().signal)).doc).toBe(doc);
  expect(fake.options.workerSrc).toBe('/worker.mjs');
  expect(fake.getDocument).toHaveBeenCalledWith(expect.objectContaining({ useWasm: false, wasmUrl: '/pdfjs-assets/wasm/' }));
});
it('等待期 abort 立即销毁且重复清理幂等', async () => {
  const task = { promise: new Promise(() => {}), destroy: vi.fn() };
  fake.getDocument.mockReturnValue(task);
  const ctrl = new AbortController();
  const result = openDocument(new ArrayBuffer(0), ctrl.signal);
  await vi.waitFor(() => expect(fake.getDocument).toHaveBeenCalled());
  ctrl.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await destroyOnce(task);
  expect(task.destroy).toHaveBeenCalledTimes(1);
});
it('最终异步失败清理 loadingTask，不自行创建 worker', async () => {
  const task = { promise: Promise.reject(new Error('fake worker failed')), destroy: vi.fn() };
  fake.getDocument.mockReturnValue(task);
  await expect(openDocument(new ArrayBuffer(0), new AbortController().signal)).rejects.toThrow('fake worker failed');
  expect(task.destroy).toHaveBeenCalledTimes(1);
  expect(fake.options.workerSrc).toBe('/worker.mjs');
});
it('同步失败向上传播并保留 workerSrc', async () => {
  fake.getDocument.mockImplementation(() => { throw new Error('sync'); });
  await expect(openDocument(new ArrayBuffer(0), new AbortController().signal)).rejects.toThrow('sync');
  expect(fake.options.workerSrc).toBe('/worker.mjs');
});
it('fetch 接收 abort signal', async () => {
  const ctrl = new AbortController();
  const fetcher = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
  vi.stubGlobal('fetch', fetcher);
  await expect(loadPdfBytes('/a.pdf', ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher).toHaveBeenCalledWith('http://zasset.localhost/%2Fa.pdf', { signal: ctrl.signal });
  vi.unstubAllGlobals();
});
