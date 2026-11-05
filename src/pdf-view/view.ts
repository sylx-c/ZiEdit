import { t, tf } from '../common/i18n';
import { fileStat, openWithDefault } from '../common/ipc';
import { shouldGuardFile, shouldWarnPages } from './guard';
import { destroyOnce, loadPdfBytes, openDocument } from './engine';
import type { PDFDocumentLoadingTask } from './engine';
import { PdfPager } from './pager';

// (2026-10-29 ac-011) 子视图只拥有本地 DOM，不写全局状态栏。
export class PdfView {
  private wrap?: HTMLDivElement;
  private controller?: AbortController;
  private generation = 0;
  private destroyed = false;
  private loadingTask?: PDFDocumentLoadingTask;
  private pager?: PdfPager;
  private pageInput?: HTMLInputElement;
  private percentage?: HTMLButtonElement;
  private pageTotal?: HTMLSpanElement;
  private dprMedia?: MediaQueryList;
  private dprChanged = () => { this.pager?.refreshDpr(); this.watchDpr(); };
  constructor(private host: HTMLElement, private path: string, private onFallbackToText?: (path: string) => void) {}

  async mount(): Promise<void> {
    if (this.destroyed) return;
    this.release();
    const generation = ++this.generation;
    const controller = this.controller = new AbortController();
    const wrap = this.wrap = document.createElement('div');
    wrap.className = 'pdf-view';
    const status = document.createElement('div'); status.className = 'pdf-loading';
    status.setAttribute('role', 'status'); status.textContent = t('pdf.loading'); wrap.append(status);
    this.host.replaceChildren(wrap);
    try {
      const stat = await fileStat(this.path);
      if (!this.current(generation)) return;
      if (shouldGuardFile(stat.len)) { this.showGuard(stat.len); return; }
      const bytes = await loadPdfBytes(this.path, controller.signal);
      if (!this.current(generation)) return;
      const opened = await openDocument(bytes, controller.signal);
      if (!this.current(generation)) {
        void destroyOnce(opened.loadingTask).catch(() => {});
        return;
      }
      this.loadingTask = opened.loadingTask;
      const scroll = document.createElement('div'); scroll.className = 'pdf-scroll';
      scroll.tabIndex = 0; scroll.setAttribute('aria-label', t('pdf.canvasNote'));
      wrap.replaceChildren(scroll);
      this.pager = new PdfPager(scroll, opened.doc, controller.signal);
      this.pager.onError = () => { if (this.current(generation)) this.showError(t('pdf.loadFail')); };
      this.buildInfo(opened.doc.numPages);
      this.pager.onChange = () => this.updateInfo();
      scroll.addEventListener('wheel', event => {
        if (!event.ctrlKey) return;
        event.preventDefault(); this.zoomBy(event.deltaY < 0 ? 1.25 : 0.8);
      }, { passive: false, signal: controller.signal });
      scroll.addEventListener('dblclick', () => this.toggleFitMode(), { signal: controller.signal });
      scroll.addEventListener('keydown', event => {
        const delta: Record<string, number> = { ArrowDown: 40, ArrowUp: -40, PageDown: scroll.clientHeight, PageUp: -scroll.clientHeight };
        if (event.key in delta) { event.preventDefault(); scroll.scrollTop += delta[event.key]!; }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); scroll.scrollLeft += event.key === 'ArrowLeft' ? -40 : 40;
        }
        if (event.key === 'Home') { event.preventDefault(); scroll.scrollTop = 0; }
        if (event.key === 'End') { event.preventDefault(); void this.pager?.jumpTo(opened.doc.numPages).catch(() => {}); }
      }, { signal: controller.signal });
      window.addEventListener('resize', this.dprChanged, { signal: controller.signal });
      this.watchDpr();
      await this.pager.start();
    } catch (error) {
      if (!this.current(generation)) return;
      const encrypted = error instanceof Error && error.name === 'PasswordException';
      this.showError(encrypted ? t('pdf.encrypted') : t('pdf.loadFail'), encrypted);
    }
  }
  get displayMode() { return this.pager?.displayMode ?? 'fit'; }
  zoomBy(factor: number): void { if (this.pager) this.pager.setZoom(this.pager.displayScale * factor); }
  fitToWindow(): void { this.pager?.setZoom(1, 'fit'); }
  zoom100(): void { this.pager?.setZoom(1, '100'); }
  toggleFitMode(): void { if (this.displayMode === 'fit') this.zoom100(); else this.fitToWindow(); }
  rotate(delta: 1 | -1): void { this.pager?.rotate(delta); }
  private watchDpr(): void {
    this.dprMedia?.removeEventListener('change', this.dprChanged);
    if (typeof window.matchMedia !== 'function') return;
    this.dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprMedia.addEventListener('change', this.dprChanged);
  }
  private buildInfo(total: number): void {
    const generation = this.generation;
    const info = document.createElement('div'); info.className = 'pdf-info';
    this.percentage = this.button(t('pdf.fit'), 'fit', () => this.toggleFitMode());
    const input = this.pageInput = document.createElement('input'); input.type = 'number'; input.min = '1'; input.max = String(total); input.value = '1';
    input.title = t('pdf.pageJump'); input.setAttribute('aria-label', t('pdf.pageJump'));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') void this.pager?.jumpTo(Number(input.value)).catch(() => {
        if (this.current(generation)) this.showError(t('pdf.loadFail'));
      });
    }, { signal: this.controller!.signal });
    this.pageTotal = document.createElement('span'); this.pageTotal.textContent = `/ ${total}`;
    const note = document.createElement('span'); note.className = 'pdf-note'; note.textContent = t('pdf.canvasNote');
    const control = (label: string, symbol: string, action: string, callback: () => void) => {
      const button = this.button(label, action, callback); button.textContent = symbol; return button;
    };
    info.append(control(t('pdf.rotateL'), '⟲', 'rotate-left', () => this.rotate(-1)),
      control(t('pdf.zoomOut'), '−', 'zoom-out', () => this.zoomBy(0.8)), this.percentage,
      control(t('pdf.zoomIn'), '+', 'zoom-in', () => this.zoomBy(1.25)),
      control(t('pdf.rotateR'), '⟳', 'rotate-right', () => this.rotate(1)), input, this.pageTotal, note);
    if (shouldWarnPages(total)) {
      const warning = document.createElement('span'); warning.className = 'pdf-warning'; warning.textContent = t('pdf.manyPages'); info.append(warning);
    }
    this.wrap!.append(info); this.updateInfo();
  }
  private updateInfo(): void {
    if (!this.pager || !this.percentage || !this.pageInput) return;
    // 控件不重建，重排、缩放与 DPR 重绘都不移除焦点元素。
    this.percentage.textContent = this.displayMode === 'fit' ? t('pdf.fit') : `${Math.round(this.pager.displayScale * 100)}%`;
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(this.pager.pageNumber);
  }
  private current(generation: number): boolean { return !this.destroyed && this.generation === generation; }
  private button(text: string, action: string, callback: () => void): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
    button.title = text; button.setAttribute('aria-label', text); button.dataset.action = action;
    button.addEventListener('click', callback, { signal: this.controller!.signal }); return button;
  }
  private showError(reason: string, encrypted = false): void {
    const generation = this.generation;
    this.pager?.destroy(); this.pager = undefined;
    if (this.loadingTask) { void destroyOnce(this.loadingTask).catch(() => {}); this.loadingTask = undefined; }
    const box = document.createElement('div'); box.className = 'pdf-err'; box.setAttribute('role', 'alert');
    const title = document.createElement('p'); title.textContent = reason;
    const note = document.createElement('p'); note.textContent = t(encrypted ? 'pdf.encryptedNote' : 'pdf.fallbackNote');
    box.append(title, note,
      this.button(t('pdf.retry'), 'retry', () => { void this.mount(); }),
      this.button(t('pdf.fallbackText'), 'fallback', () => this.onFallbackToText?.(this.path)),
      this.button(t('pdf.openSystem'), 'system', () => {
        void openWithDefault(this.path).catch(() => { if (this.current(generation)) title.textContent = t('pdf.systemFail'); });
      }));
    this.wrap!.replaceChildren(box);
  }
  private showGuard(size: number): void {
    const generation = this.generation;
    // (2026-10-29 ac-011) 渲染型加载没有渐进安全档，不提供「仍要加载」。
    const box = document.createElement('div'); box.className = 'pdf-guard'; box.setAttribute('role', 'alert');
    const title = document.createElement('h3'); title.textContent = t('pdf.guardTitle');
    const description = document.createElement('p'); description.textContent = tf('pdf.guardDesc', (size / 1024 / 1024).toFixed(1));
    const fallback = this.button(t('pdf.fallbackText'), 'fallback', () => {}); fallback.disabled = true;
    const note = document.createElement('p'); note.textContent = t('pdf.tooLargeForText');
    fallback.title = t('pdf.tooLargeForText');
    box.append(title, description, fallback, note, this.button(t('pdf.openSystem'), 'system', () => {
      void openWithDefault(this.path).catch(() => { if (this.current(generation)) description.textContent = t('pdf.systemFail'); });
    })); this.wrap!.replaceChildren(box);
  }
  private release(): void {
    this.dprMedia?.removeEventListener('change', this.dprChanged); this.dprMedia = undefined;
    this.pager?.destroy(); this.pager = undefined;
    this.controller?.abort();
    if (this.loadingTask) { void destroyOnce(this.loadingTask).catch(() => {}); this.loadingTask = undefined; }
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; ++this.generation; this.release(); this.wrap?.remove();
  }
}
