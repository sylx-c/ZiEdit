import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from './engine';
import { CANVAS_BUDGET_BYTES, clampScale } from './guard';
import { t } from '../common/i18n';

export interface PageSize { width: number; height: number }
export function pageLayout(pages: readonly PageSize[], scale: number, rotation: number): (PageSize & { top: number })[] {
  let top = 0;
  return pages.map(page => {
    const width = (rotation % 180 ? page.height : page.width) * scale;
    const height = (rotation % 180 ? page.width : page.height) * scale;
    const result = { width, height, top }; top += height + 24; return result;
  });
}
interface Candidate extends PageSize { id: number; distance: number }
/** (2026-10-29 ac-011) 在排队前一次性为可见/预渲染/在途画布分配预算；远页先降采样。 */
export function canvasPlan(pages: readonly Candidate[], scale: number, dpr: number, budget = CANVAS_BUDGET_BYTES) {
  const sorted = [...pages].sort((a, b) => a.distance - b.distance);
  const weights = sorted.map((_, i) => 1 / (1 + Math.floor(i / 6)));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  return sorted.map((page, i) => {
    const share = budget * weights[i]! / weightSum;
    const density = Math.min(dpr / (1 + Math.floor(i / 6)), Math.sqrt(share / (4 * page.width * page.height)) / scale);
    const renderScale = clampScale(page.width, page.height, scale, density) * density;
    return { id: page.id, width: Math.floor(page.width * renderScale), height: Math.floor(page.height * renderScale), dpr: renderScale / scale };
  });
}
interface Measured extends PageSize { rotation: number; element: HTMLDivElement }
interface Slot { canvas: HTMLCanvasElement; page: PDFPageProxy; task?: RenderTask; done: Promise<void>; key: string }

export class PdfPager {
  private pages: Measured[] = [];
  private slots = new Map<number, Slot>();
  private candidates = new Set<number>();
  private observer: IntersectionObserver;
  private resizeObserver: ResizeObserver;
  private flow: HTMLDivElement;
  private progress: HTMLDivElement;
  private cancelButton: HTMLButtonElement;
  private disposed = false;
  private measuring?: Promise<void>;
  private measureGeneration = 0;
  private renderGeneration = 0;
  private queue: Promise<void> = Promise.resolve();
  private rotation = 0;
  private scale = 1;
  private mode: 'fit' | '100' | 'zoom' = 'fit';
  private dpr = window.devicePixelRatio || 1;
  private viewportWidth = 0;
  private layout: ReturnType<typeof pageLayout> = [];
  private abort = () => this.destroy();
  onChange?: () => void;
  onError?: (error: unknown) => void;
  get measuredPages() { return this.pages.length; }
  get displayScale() { return this.scale; }
  get displayMode() { return this.mode; }
  get pageNumber() {
    return this.centerAnchor().id;
  }
  constructor(private scroll: HTMLElement, private doc: PDFDocumentProxy, private signal: AbortSignal) {
    this.flow = document.createElement('div'); this.flow.className = 'pdf-flow';
    this.progress = document.createElement('div'); this.progress.className = 'pdf-measuring'; this.progress.setAttribute('role', 'status');
    this.cancelButton = document.createElement('button'); this.cancelButton.type = 'button';
    this.cancelButton.textContent = t('pdf.cancelMeasure'); this.cancelButton.title = t('pdf.cancelMeasure');
    this.cancelButton.setAttribute('aria-label', t('pdf.cancelMeasure'));
    this.cancelButton.addEventListener('click', () => { ++this.measureGeneration; }, { signal });
    scroll.append(this.flow, this.progress, this.cancelButton);
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = Number((entry.target as HTMLElement).dataset.page);
        if (entry.isIntersecting) this.candidates.add(id); else this.candidates.delete(id);
      }
      this.schedule();
      // 首批页不足以填满高视口时也必须继续测量，不能等待不存在的滚动事件。
      if (this.candidates.has(this.pages.length)) void this.measureMore(8).catch(error => this.onError?.(error));
    }, { root: scroll, rootMargin: `${Math.max(scroll.clientHeight, 600)}px 0px` });
    this.resizeObserver = new ResizeObserver(entries => {
      this.viewportWidth = entries[0]?.contentRect.width ?? scroll.clientWidth;
      this.relayout();
    });
    this.resizeObserver.observe(scroll);
    scroll.addEventListener('scroll', () => {
      this.onChange?.(); this.schedule();
      if (scroll.scrollTop + scroll.clientHeight * 2 >= scroll.scrollHeight) {
        void this.measureMore(8).catch(error => this.onError?.(error));
      } else if (this.measuring) {
        // 用户离开页流尾部时放弃批内迟到测量；远跳也可通过滚动取消。
        ++this.measureGeneration;
      }
    }, { signal });
    signal.addEventListener('abort', this.abort, { once: true });
  }
  async start(): Promise<void> { await this.measureMore(5); }
  /** 每次最多 8 页，只有实测尺寸才追加；远跳按批推进并允许用户取消。 */
  async measureMore(count: number): Promise<void> {
    if (this.measuring) return this.measuring;
    if (this.disposed || this.pages.length >= this.doc.numPages) return;
    const generation = this.measureGeneration;
    const run = async () => {
      const end = Math.min(this.doc.numPages, this.pages.length + Math.min(8, count));
      this.cancelButton.hidden = false;
      while (!this.disposed && generation === this.measureGeneration && this.pages.length < end) {
        const id = this.pages.length + 1;
        const page = await this.doc.getPage(id);
        if (this.disposed || generation !== this.measureGeneration) { page.cleanup(); break; }
        const viewport = page.getViewport({ scale: 1 });
        const element = document.createElement('div'); element.className = 'pdf-page'; element.dataset.page = String(id);
        this.pages.push({ width: viewport.width, height: viewport.height, rotation: page.rotate, element });
        this.flow.append(element); this.observer.observe(element); page.cleanup();
        this.progress.textContent = `${t('pdf.measuring')} ${id}/${this.doc.numPages}`;
        this.relayout();
      }
      if (!this.disposed) {
        this.progress.hidden = this.pages.length >= this.doc.numPages;
        this.cancelButton.hidden = true;
      }
    };
    this.measuring = run();
    try { await this.measuring; } finally { this.measuring = undefined; }
  }
  async jumpTo(id: number): Promise<void> {
    id = Math.max(1, Math.min(this.doc.numPages, Math.trunc(id) || 1));
    const generation = this.measureGeneration;
    while (!this.disposed && generation === this.measureGeneration && this.pages.length < id) {
      await this.measureMore(Math.min(8, id - this.pages.length));
      // 批与批之间把控制权交还事件循环，使取消按钮始终可响应。
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    if (!this.disposed && generation === this.measureGeneration) this.scroll.scrollTop = this.layout[id - 1]!.top;
  }
  private centerAnchor() {
    const center = this.scroll.scrollTop + this.scroll.clientHeight / 2;
    const found = this.layout.findIndex(page => center < page.top + page.height + 24);
    const index = found < 0 ? Math.max(0, this.layout.length - 1) : found;
    const page = this.layout[index];
    return { id: index + 1, fraction: page ? (center - page.top) / page.height : 0 };
  }
  private relayout(keepAnchor = true): void {
    if (this.disposed) return;
    const anchor = this.centerAnchor();
    if (this.mode === 'fit' && this.pages.length) {
      const widest = this.pages.reduce((max, p) => Math.max(max, this.rotation % 180 ? p.height : p.width), 0);
      const width = this.viewportWidth || this.scroll.clientWidth;
      if (width > 48) this.scale = Math.min(1, (width - 48) / widest);
    }
    this.layout = pageLayout(this.pages, this.scale, this.rotation);
    this.layout.forEach((size, index) => {
      const element = this.pages[index]!.element;
      element.style.width = `${size.width}px`; element.style.height = `${size.height}px`;
    });
    if (keepAnchor && this.layout[anchor.id - 1]) {
      const page = this.layout[anchor.id - 1]!;
      this.scroll.scrollTop = Math.max(0, page.top + page.height * anchor.fraction - this.scroll.clientHeight / 2);
    }
    this.schedule(); this.onChange?.();
  }
  setZoom(scale: number, mode: 'fit' | '100' | 'zoom' = 'zoom'): void {
    this.mode = mode; this.scale = Math.max(0.1, Math.min(8, scale)); this.relayout();
  }
  rotate(delta: 1 | -1): void { this.rotation = (this.rotation + delta * 90 + 360) % 360; this.relayout(); }
  refreshDpr(): void {
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.dpr) { this.dpr = dpr; this.schedule(); }
  }
  private schedule(): void {
    if (this.disposed) return;
    const generation = ++this.renderGeneration;
    this.queue = this.queue.then(() => this.render(generation)).catch(error => {
      if (!this.disposed && generation === this.renderGeneration) this.onError?.(error);
    });
  }
  private async release(id: number): Promise<void> {
    const slot = this.slots.get(id); if (!slot) return;
    slot.task?.cancel(); await slot.done.catch(() => {});
    slot.canvas.width = 0; slot.canvas.height = 0; slot.canvas.remove(); slot.page.cleanup(); this.slots.delete(id);
  }
  private async render(generation: number): Promise<void> {
    if (this.disposed || generation !== this.renderGeneration) return;
    const center = this.scroll.scrollTop + this.scroll.clientHeight / 2;
    const plan = canvasPlan([...this.candidates].map(id => {
      const page = this.layout[id - 1]!;
      return { id, width: page.width / this.scale, height: page.height / this.scale, distance: Math.abs(page.top + page.height / 2 - center) };
    }), this.scale, this.dpr);
    const keys = new Map(plan.map(p => [p.id, `${p.width}:${p.height}:${this.rotation}`]));
    // Map 的插入顺序即最近渲染使用顺序；离开扩展视口立即回收，不保留离场解码缓存。
    for (const [id, slot] of this.slots) if (slot.key !== keys.get(id)) await this.release(id);
    for (const item of plan) {
      if (this.disposed || generation !== this.renderGeneration) return;
      if (this.slots.has(item.id) || item.width < 1 || item.height < 1) continue;
      const page = await this.doc.getPage(item.id);
      if (this.disposed || generation !== this.renderGeneration) { page.cleanup(); return; }
      const measured = this.pages[item.id - 1]!;
      const canvas = document.createElement('canvas'); canvas.width = item.width; canvas.height = item.height;
      const viewport = page.getViewport({ scale: this.scale * item.dpr, rotation: (measured.rotation + this.rotation) % 360 });
      const slot: Slot = { canvas, page, done: Promise.resolve(), key: keys.get(item.id)! };
      this.slots.set(item.id, slot); // 在启动 render 前登记，预算包含在途 canvas。
      measured.element.append(canvas);
      try {
        slot.task = page.render({ canvas, viewport, background: 'rgb(255,255,255)' });
        slot.done = slot.task.promise.then(() => undefined);
        // 立即绑定 rejection，取消不是未处理异常；其余错误经 onError 展示。
        void slot.done.catch(error => {
          if (!this.disposed && generation === this.renderGeneration && error?.name !== 'RenderingCancelledException') this.onError?.(error);
        });
      } catch (error) { await this.release(item.id); throw error; }
    }
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true; ++this.measureGeneration; ++this.renderGeneration;
    this.signal.removeEventListener('abort', this.abort);
    this.observer.disconnect(); this.resizeObserver.disconnect();
    for (const id of this.slots.keys()) void this.release(id);
    this.flow.remove(); this.progress.remove(); this.cancelButton.remove();
  }
}
