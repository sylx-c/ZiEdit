import { userScrolledRecently } from '../common/user-scroll';
import type { EditorView } from '@codemirror/view';
import { blockHeightCache, type HeightIdentity, type RowHeightSnapshot } from './block-height-cache';
import { TABLE_ROW_ESTIMATE_PX } from './layout';

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
  private measured: boolean[] = [];
  private width = 0;
  private generation = 0;
  snapshot(): RowHeightSnapshot { return { cols: this.cols, width: this.width, heights: this.heights.slice(), measured: this.measured.slice() }; }
  private offsets: number[] = [];
  private rows = 0;
  private cols = 0;
  private first = 1;
  private last = 1;
  private dead = false;
  private render: RowRenderer;
  private observer?: ResizeObserver;
  private scrolling = false;
  private lastScrollTop = 0;
  /** 近期 scroll 时间戳:区分「连续滚动流间隙」与「孤立程序跳转」,决定停稳是否锚点纠偏 */
  constructor(private readonly view: EditorView, private readonly box: HTMLElement, private readonly table: HTMLTableElement,
    rows: number, cols: number, render: RowRenderer, private readonly activeRow: () => HTMLTableRowElement | null,
     private readonly changed: () => void, private identity?: HeightIdentity,
     private estimateRow: (row: number) => number = () => TABLE_ROW_ESTIMATE_PX) {
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
  update(rows: number, cols: number, render: RowRenderer, identity = this.identity, estimateRow = this.estimateRow, unchangedRows = 0): void {
    this.estimateRow = estimateRow;
    this.identity = identity;
    const shapeChanged = this.rows !== rows || this.cols !== cols;
    const columnsChanged = this.cols !== cols;
    const cache = this.view.state?.facet(blockHeightCache);
    const width = this.view.contentDOM?.getBoundingClientRect().width ?? 0, generation = cache?.generation ?? 0;
    const retained = !columnsChanged && width === this.width && generation === this.generation
      ? Math.min(unchangedRows, this.rows, rows) : 0;
    const oldHeights = this.heights, oldMeasured = this.measured;
    this.width = width;
    this.generation = generation;
    const restored = this.rows === 0 && this.width > 0 ? cache?.rows(this.identity, cols, this.width) : undefined;
    this.rows = rows; this.cols = cols; this.render = render;
    this.box.dataset.mdTableRows = String(rows); this.box.dataset.mdTableCols = String(cols);
    this.table.setAttribute('aria-rowcount', String(rows));
    this.table.classList.toggle('mdir-table-windowed', rows > WINDOW_THRESHOLD);
    this.table.style.minWidth = rows > WINDOW_THRESHOLD ? cols * 96 + 'px' : '';
    if (shapeChanged) {
      // 后台解析可能继续扩展同一张表。行数增长不能清空正在阅读的行；
      // 列结构未变时由 draw 增删窗口，保留既有单元格及阅读锚。
      if (columnsChanged) {
        this.observer?.disconnect();
        this.head.replaceChildren(); this.body.replaceChildren(); this.mounted.clear();
        this.observer?.observe(this.table);
      }
      this.first = Math.min(this.first, Math.max(1, rows - 1));
      this.last = Math.min(rows, Math.max(this.last, this.first + 32));
    }
    // 内容更新必须丢弃旧行高，但同形状更新不能移除活动编辑器的祖先 DOM：
    // DOM 重建会打断 IME 会话，使组合提交与后续输入的撤销边界丢失。
    this.heights = restored?.heights.length === rows ? restored.heights.slice()
      : Array.from({ length: rows }, (_, row) => row < retained ? oldHeights[row]! : this.estimateRow(row));
    this.measured = restored?.heights.length === rows ? restored.measured.slice()
      : Array.from({ length: rows }, (_, row) => row < retained && oldMeasured[row]!);
    this.reindex();
    for (const [row, dom] of this.mounted) if (row < rows) this.render(row, dom);
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
        let resized = false;
        for (const [row, height] of measurement.measured) if (height > 0) {
          this.measured[row] = true;
          if (Math.abs(this.heights[row]! - height) > .5) { this.heights[row] = height; resized = true; }
        }
        if (resized) this.reindex();
        if (this.identity) this.view.state?.facet(blockHeightCache)?.putRows(this.identity, this.snapshot(), this.generation);
        // 行高变化仅更新表格与 CM 测量，不再二次补偿整页 scrollTop。
        const first = Math.max(1, this.rowAt(measurement.top) - OVERSCAN);
        const last = Math.min(this.rows, this.rowAt(measurement.bottom) + OVERSCAN + 1);
        if (first !== this.first || last !== this.last || resized) {
          this.first = first; this.last = last; this.draw();
        }
      },
    });
  };
  private onScroll = (): void => {
    const top = this.view.scrollDOM.scrollTop;
    if (top === this.lastScrollTop) return;
    this.lastScrollTop = top;
    if (this.dead || this.rows <= WINDOW_THRESHOLD) return;
    this.scrolling = userScrolledRecently(this.view.scrollDOM);
    this.schedule();
  };
  private settled = (): void => {
    this.scrolling = false;
    this.lastScrollTop = this.view.scrollDOM.scrollTop;
    this.schedule();
  };
  private geometryChanged = (): void => {
    this.heights = this.heights.map((_, row) => this.estimateRow(row)); this.measured.fill(false); this.reindex();
    this.width = this.view.contentDOM?.getBoundingClientRect().width ?? 0;
    this.generation = this.view.state?.facet(blockHeightCache)?.generation ?? 0;
    this.scrolling = false;
    if (!this.dead) this.schedule();
  };
  destroy(): void {
    this.dead = true; this.observer?.disconnect();
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll); windows.delete(this.box);
    this.view.scrollDOM.removeEventListener('mdir-layout-refresh', this.geometryChanged);
    this.view.scrollDOM.removeEventListener('mdir-scroll-settle', this.settled);
  }
}
