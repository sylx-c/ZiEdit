import type { EditorView } from '@codemirror/view';

type RowRenderer = (row: number, existing?: HTMLTableRowElement) => HTMLTableRowElement;
const windows = new WeakMap<HTMLElement, TableViewport>();
const WINDOW_THRESHOLD = 160;
const OVERSCAN = 12;

export function tableRowNumber(cell: HTMLTableCellElement): number {
  return Number((cell.parentElement as HTMLElement).dataset.mdRow ?? (cell.parentElement as HTMLTableRowElement).rowIndex);
}

export function tableCellAt(box: HTMLElement, row: number, col: number): HTMLTableCellElement | undefined {
  windows.get(box)?.ensureRow(row);
  return box.querySelector<HTMLTableRowElement>(`tr[data-md-row="${row}"]`)?.cells[col];
}

/** 表格行号独立于DOM序号；占位行始终不参与内容导航。 */
export class TableViewport {
  private readonly head: HTMLTableSectionElement;
  private readonly body: HTMLTableSectionElement;
  private readonly mounted = new Map<number, HTMLTableRowElement>();
  private heights: number[] = [];
  private offsets: number[] = [];
  private rows = 0;
  private cols = 0;
  private first = 1;
  private last = 1;
  private dead = false;
  private render: RowRenderer;
  private observer?: ResizeObserver;
  private scrolling = false;
  private ignoreScrollUntil = -Infinity;
  private correctionAvailable = true;
  private lastScrollTop = 0;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly view: EditorView, private readonly box: HTMLElement, private readonly table: HTMLTableElement,
    rows: number, cols: number, render: RowRenderer, private readonly activeRow: () => HTMLTableRowElement | null,
    private readonly changed: () => void) {
    this.head = table.createTHead(); this.body = table.createTBody(); this.render = render;
    windows.set(box, this);
    this.lastScrollTop = view.scrollDOM.scrollTop;
    this.update(rows, cols, render);
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    view.scrollDOM.addEventListener('mdir-layout-refresh', this.geometryChanged);
    view.scrollDOM.addEventListener('mdir-scroll-settle', this.settled);
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.schedule);
      this.observer.observe(table);
    }
    this.schedule();
  }
  update(rows: number, cols: number, render: RowRenderer): void {
    const shapeChanged = this.rows !== rows || this.cols !== cols;
    this.rows = rows; this.cols = cols; this.render = render;
    this.box.dataset.mdTableRows = String(rows); this.box.dataset.mdTableCols = String(cols);
    this.table.setAttribute('aria-rowcount', String(rows));
    this.table.classList.toggle('mdir-table-windowed', rows > WINDOW_THRESHOLD);
    this.table.style.minWidth = rows > WINDOW_THRESHOLD ? cols * 96 + 'px' : '';
    if (shapeChanged) {
      this.observer?.disconnect();
      this.head.replaceChildren(); this.body.replaceChildren(); this.mounted.clear();
      this.heights = Array(rows).fill(32); this.reindex();
      this.first = Math.min(this.first, Math.max(1, rows - 1));
      this.last = Math.min(rows, this.first + 32);
      this.observer?.observe(this.table);
    }
    for (const [row, dom] of this.mounted) this.render(row, dom);
    this.draw(); this.schedule();
  }
  private reindex(): void {
    this.offsets = [0];
    for (const height of this.heights) this.offsets.push(this.offsets[this.offsets.length - 1]! + height);
  }
  private rowAt(y: number): number {
    let lo = 1, hi = this.rows;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.offsets[mid + 1]! <= y) lo = mid + 1; else hi = mid;
    }
    return Math.min(this.rows - 1, lo);
  }
  ensureRow(row: number): void {
    if (row < 0 || row >= this.rows || this.mounted.has(row)) return;
    this.draw(row); this.schedule();
  }
  private draw(extra?: number): void {
    const wanted = new Set<number>([0]);
    const start = this.rows > WINDOW_THRESHOLD ? this.first : 1;
    const end = this.rows > WINDOW_THRESHOLD ? this.last : this.rows;
    for (let row = start; row < end; row++) wanted.add(row);
    const active = this.activeRow();
    if (active) wanted.add(Number(active.dataset.mdRow));
    if (extra !== undefined) wanted.add(extra);
    for (const [row, dom] of this.mounted) if (!wanted.has(row)) {
      this.observer?.unobserve(dom); dom.remove(); this.mounted.delete(row);
    }
    let changed = false;
    for (const spacer of this.body.querySelectorAll('.mdir-table-spacer')) { spacer.remove(); changed = true; }
    let cursor: ChildNode | null = this.body.firstChild, previous = 0;
    const spacer = (from: number, to: number): void => {
      if (from >= to) return;
      const tr = document.createElement('tr'); tr.className = 'mdir-table-spacer'; tr.setAttribute('aria-hidden', 'true');
      const td = tr.insertCell(); td.colSpan = this.cols; td.style.height = (this.offsets[to]! - this.offsets[from]!) + 'px';
      this.body.insertBefore(tr, cursor); changed = true;
    };
    for (const row of [...wanted].sort((a, b) => a - b)) {
      let dom = this.mounted.get(row);
      if (!dom) { dom = this.render(row); this.mounted.set(row, dom); this.observer?.observe(dom); changed = true; }
      if (row === 0) { if (dom.parentNode !== this.head) this.head.append(dom); continue; }
      spacer(previous + 1, row);
      // 保留行原本就有序：只在其前插入缺失节点，不搬动含活动编辑器的祖先。
      if (dom !== cursor) this.body.insertBefore(dom, cursor);
      cursor = dom.nextSibling; previous = row;
    }
    spacer(previous + 1, this.rows);
    if (changed) this.changed();
  }
  private schedule = (): void => {
    if (this.dead || this.rows <= WINDOW_THRESHOLD) return;
    this.view.requestMeasure({ key: this,
      read: () => {
        const bounds = this.table.getBoundingClientRect(), viewport = this.view.scrollDOM.getBoundingClientRect();
        // 滚动期只更新估算窗口；逐行测量与锚点纠偏推迟到停稳，避免布局/scrollTop 反馈环。
        const measured = this.scrolling ? [] : [...this.mounted].map(([row, dom]) => [row, dom.getBoundingClientRect().height] as const);
        const top = viewport.top - bounds.top;
        return { measured, top, bottom: top + viewport.height };
      },
      write: measurement => {
        if (this.dead || !this.box.isConnected) return;
        const anchor = this.rowAt(measurement.top), oldOffset = this.offsets[anchor]!;
        let resized = false;
        for (const [row, height] of measurement.measured) if (height > 0 && Math.abs(this.heights[row]! - height) > .5) {
          this.heights[row] = height; resized = true;
        }
        if (resized) this.reindex();
        const delta = this.offsets[anchor]! - oldOffset;
        // 一轮停稳只允许一次补偿；后续新挂载行的测量不得再次推动视口。
        const correction = this.correctionAvailable && measurement.top > 0 && Math.abs(delta) >= 1 ? delta : 0;
        if (correction) {
          this.correctionAvailable = false;
          this.ignoreScrollUntil = performance.now() + 100;
          this.view.scrollDOM.scrollTop += correction;
          this.lastScrollTop = this.view.scrollDOM.scrollTop;
        }
        const first = Math.max(1, this.rowAt(measurement.top + correction) - OVERSCAN);
        const last = Math.min(this.rows, this.rowAt(measurement.bottom + correction) + OVERSCAN + 1);
        if (first !== this.first || last !== this.last || resized) {
          this.first = first; this.last = last; this.draw();
        }
      },
    });
  };
  private onScroll = (): void => {
    const top = this.view.scrollDOM.scrollTop;
    if (top === this.lastScrollTop && !this.correctionAvailable) return;
    this.lastScrollTop = top;
    if (this.dead || this.rows <= WINDOW_THRESHOLD || performance.now() < this.ignoreScrollUntil) return;
    this.correctionAvailable = true;
    this.scrolling = true;
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      this.scrolling = false;
      if (!this.dead) this.schedule();
    }, 100);
    this.schedule();
  };
  private settled = (): void => {
    this.correctionAvailable = false;
    this.scrolling = false;
    clearTimeout(this.settleTimer);
    this.ignoreScrollUntil = performance.now() + 100;
    this.lastScrollTop = this.view.scrollDOM.scrollTop;
    this.schedule();
  };
  private geometryChanged = (): void => {
    this.scrolling = false;
    this.ignoreScrollUntil = performance.now() + 100;
    clearTimeout(this.settleTimer);
    if (!this.dead) this.schedule();
  };
  destroy(): void {
    this.dead = true; this.observer?.disconnect();
    clearTimeout(this.settleTimer);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll); windows.delete(this.box);
    this.view.scrollDOM.removeEventListener('mdir-layout-refresh', this.geometryChanged);
    this.view.scrollDOM.removeEventListener('mdir-scroll-settle', this.settled);
  }
}
