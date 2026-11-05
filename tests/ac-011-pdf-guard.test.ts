// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
const wiring = vi.hoisted(() => ({ stat: vi.fn(), bytes: vi.fn(), open: vi.fn() }));
vi.mock('../src/common/ipc', () => ({ fileStat: wiring.stat, openWithDefault: vi.fn(async () => null) }));
vi.mock('../src/pdf-view/engine', () => ({ loadPdfBytes: wiring.bytes, openDocument: wiring.open, destroyOnce: vi.fn(async () => {}) }));
import { PdfView } from '../src/pdf-view/view';
import { remainingCanvasBytes, CANVAS_BUDGET_BYTES, clampScale, shouldGuardFile, shouldWarnPages, PDF_MAX_FILE_BYTES, PDF_MAX_PAGE_PIXELS, PDF_MAX_SIDE } from '../src/pdf-view/guard';

describe('ac-011 PDF 守护', () => {
  it('超过阈值不读字节、不解析，文本回退置灰且无强制加载出口', async () => {
    wiring.stat.mockResolvedValue({ len: PDF_MAX_FILE_BYTES + 1 });
    const host = document.createElement('div'); const view = new PdfView(host, '/large.pdf'); await view.mount();
    expect(host.querySelector('.pdf-guard')).not.toBeNull();
    expect((host.querySelector('[data-action=fallback]') as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('[data-action=retry]')).toBeNull();
    expect(wiring.bytes).not.toHaveBeenCalled(); expect(wiring.open).not.toHaveBeenCalled(); view.destroy();
  });
  it('恰好100MiB进入字节加载，不拿 pdf_open 做探针', async () => {
    wiring.stat.mockResolvedValue({ len: PDF_MAX_FILE_BYTES }); wiring.bytes.mockRejectedValueOnce(new Error('test stop'));
    const host = document.createElement('div'); const view = new PdfView(host, '/boundary.pdf'); await view.mount();
    expect(wiring.bytes).toHaveBeenCalledWith('/boundary.pdf', expect.any(AbortSignal));
    expect(host.querySelector('.pdf-guard')).toBeNull(); view.destroy();
  });
  it('总预算包含在途与预渲染的登记分配', () => {
    expect(remainingCanvasBytes([{ width: 100, height: 100 }, { width: 200, height: 200 }])).toBe(CANVAS_BUDGET_BYTES - 200000);
    expect(remainingCanvasBytes([{ width: 8192, height: 8192 }, { width: 1, height: 1 }])).toBe(0);
  });
  it('文件产品阈值为严格大于 100MiB', () => {
    expect(shouldGuardFile(PDF_MAX_FILE_BYTES)).toBe(false);
    expect(shouldGuardFile(PDF_MAX_FILE_BYTES + 1)).toBe(true);
    expect(shouldWarnPages(2000)).toBe(false);
    expect(shouldWarnPages(2001)).toBe(true);
  });
  it('DPR 后同时约束像素面积与单边', () => {
    for (const [w, h, dpr] of [[1000, 2000, 2], [20000, 100, 3]]) {
      const s = clampScale(w!, h!, 8, dpr!);
      expect(w! * h! * (s * dpr!) ** 2).toBeLessThanOrEqual(PDF_MAX_PAGE_PIXELS + 0.001);
      expect(Math.max(w!, h!) * s * dpr!).toBeLessThanOrEqual(PDF_MAX_SIDE + 0.001);
    }
  });
});
