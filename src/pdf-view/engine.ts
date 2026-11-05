import { zassetUrl } from '../common/ipc';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, PDFPageProxy, RenderTask } from 'pdfjs-dist/types/src/display/api';

// (2026-10-29 ac-011) 已核对 pdfjs-dist 6.4.299 包内事实：
// legacy/build/pdf.mjs 与 legacy/build/pdf.worker.mjs 成对存在（不是 build/legacy）。
// types/src/display/api.d.ts: getDocument(src?: DocumentInitParameters): PDFDocumentLoadingTask;
// data?: ArrayBuffer | TypedArray；cMapUrl/standardFontDataUrl/wasmUrl?: string；useWasm?: boolean。
// PDFPageProxy.render({ canvas, viewport, ... }: RenderParameters): RenderTask;
// RenderParameters.canvas: HTMLCanvasElement | null（必填）；canvasContext?: CanvasRenderingContext2D。
// PDFDocumentLoadingTask.destroy(): Promise<void>；RenderTask.cancel(): void。
// 6.4 的 PDFDocumentProxy 没有 destroy()（api.d.ts:868-1214），只有 cleanup() 与
// loadingTask；文档/worker 统一用 loadingTask.destroy()，不能按旧 API 调 doc.destroy()。
// types/src/display/worker_options.d.ts: static set workerSrc(val: string)。
// 不传已移除的 isEvalSupported，不清空 workerSrc/workerPort，降级完全交给 pdf.js。
// tauri.conf.json 仅扩 connect-src 到可撤销授权 zasset 源；JSON 不支持注释，说明在此。
// 不增加 wasm-unsafe-eval；JS fallback 与同源 legacy worker 均沿用现有 script/default-src。
export type { PDFDocumentProxy, PDFDocumentLoadingTask, PDFPageProxy, RenderTask };
const destroyed = new WeakMap<object, Promise<void>>();
export function destroyOnce(target: { destroy(): Promise<void> | void }): Promise<void> {
  const existing = destroyed.get(target);
  if (existing) return existing;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  destroyed.set(target, result);
  // 先登记再立即调用，兼顾重入幂等与等待期 abort 的同步资源释放。
  try { Promise.resolve(target.destroy()).then(resolve, reject); } catch (error) { reject(error); }
  return result;
}
export async function loadPdfBytes(path: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(zassetUrl(path), { signal });
  if (!response.ok) throw new Error(`PDF HTTP ${response.status}`);
  return response.arrayBuffer();
}
export async function openDocument(bytes: ArrayBuffer, signal: AbortSignal): Promise<{ doc: PDFDocumentProxy; loadingTask: PDFDocumentLoadingTask }> {
  signal.throwIfAborted();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  signal.throwIfAborted();
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const loadingTask = pdfjs.getDocument({ data: bytes, cMapUrl: '/pdfjs-assets/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdfjs-assets/standard_fonts/', useWasm: false, wasmUrl: '/pdfjs-assets/wasm/' });
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => {
      void destroyOnce(loadingTask).catch(() => {});
      reject(new DOMException('PDF loading aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    if (signal.aborted) abort();
    const doc = await Promise.race([loadingTask.promise, cancelled]);
    return { doc, loadingTask };
  } catch (error) {
    void destroyOnce(loadingTask).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
