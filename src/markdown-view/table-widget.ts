// markdown-view/table-widget —— REQ-014 P5：表格直接 DOM 编辑挂件（TableEditWidget）。
// 设计（data-model.md §4 / contracts/rendering-seams.md §3）：
//   toDOM() 生成真 <table>，单元格 contenteditable + `TableEditWidget.data-row`/`data-col`；
//   非活动格显示 renderCellHtml 渲染态，按下即切源文本编辑；blur/Escape 读文本→safeCell→
//   与文档比对→单事务写回（撤销一次恢复单格）；Tab/Shift-Tab 格间导航（末格 Tab 追加行）、
//   Enter/方向键纵向移动、Mod-Enter 新建行、Escape 交回主编辑器、Mod-z 撤销主文档。
// 行窗口虚拟化（table-viewport）与逐格内嵌 CM（table-editor）不再使用：≤500 行全渲染，
// >500 行由投影器直接不给挂件（退化源码，Typora 行为）。
import { EditorView, WidgetType, runScopeHandlers } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { renderCellHtml } from './static-html';
import { cellInlineText, safeCell, tableModel, tableRowPrefix, runTableOperation, resizeTable, parseTablePaste, limitTablePaste, pasteTable, deleteTable, type TableOperation } from './table-model';
import { icon, flash } from '../shell/chrome';
import { t } from '../common/i18n';
import { localImagePath } from './preview';
import { zassetUrl } from '../common/ipc';
import { imageContext, referenceField as referenceFieldOf, currentPosition as currentPositionOf, type ReferenceIndex } from './live-state';
import { requestIrFrame } from './frame-work';

interface CellRange { from: number; to: number }

/** 单元格源码区间（自 table-editor 的 cellRange 演进：无会话态，按容器数据集定位行）。
 *  row=0 为表头；行号换算 = 起始行 + row +（row>0 时跨过分隔行）。 */
export function cellRange(main: EditorView, box: HTMLElement, row: number, col: number): CellRange | null {
  const start = Number(box.dataset.mdTableFrom);
  if (!Number.isInteger(start) || start < 0 || row < 0 || col < 0) return null;
  const lineNo = main.state.doc.lineAt(Math.min(start, main.state.doc.length)).number + row + (row > 0 ? 1 : 0);
  if (lineNo > main.state.doc.lines) return null;
  const line = main.state.doc.line(lineNo);
  const prefix = tableRowPrefix(line.text).length;
  const pipes: number[] = [];
  let slashes = 0;
  for (let i = prefix; i < line.length; i++) {
    const ch = line.text[i]!;
    if (ch === '|' && slashes % 2 === 0) pipes.push(line.from + i);
    slashes = ch === '\\' ? slashes + 1 : 0;
  }
  if (pipes[0] !== line.from + prefix) pipes.unshift(line.from + prefix - 1);
  if (pipes[pipes.length - 1] !== line.to - (line.text.match(/\s*$/)?.[0].length ?? 0) - 1) pipes.push(line.to);
  if (pipes[col] == null || pipes[col + 1] == null) return null;
  let from = pipes[col]! + 1, to = pipes[col + 1]!;
  while (from < to && /\s/.test(main.state.doc.sliceString(from, from + 1))) from++;
  while (to > from && /\s/.test(main.state.doc.sliceString(to - 1, to))) to--;
  return { from, to };
}

/** 表格行高初值（迁自 table-viewport，随其退役）：真机实测 48.7px/行（padding 13×2 + 行高 20
 *  + 行边框累积；3 行盒 146.1px 实测，stub 须精确否则停稳换实表跳变）。改表格 CSS 时同步此值。 */
export const TABLE_ROW_ESTIMATE_PX = 48.7;
const ROW_ESTIMATE_PX = TABLE_ROW_ESTIMATE_PX;

/** 实表实测高度记忆（按行数+首行单元格签名）：同签名表格的占位件用实测值，停稳换实表零位移。 */
const tableHeights = new Map<string, number>();
function tableSignature(header: string[], rows: string[][]): string {
  return header.join('\u0001') + '\u0002' + (rows[0]?.join('\u0001') ?? '') + '\u0003' + rows.length;
}
export function rememberedTableHeight(header: string[], rows: string[][]): number | undefined {
  return tableHeights.get(tableSignature(header, rows));
}
function rememberTableHeight(header: string[], rows: string[][], height: number): void {
  if (!(height > 0)) return;
  const key = tableSignature(header, rows);
  tableHeights.delete(key); tableHeights.set(key, height);
  if (tableHeights.size > 256) tableHeights.delete(tableHeights.keys().next().value!);
}

function applyOperation(main: EditorView, box: HTMLElement, operation: TableOperation): void {
  if (main.state.readOnly) return;
  const target = runTableOperation(main, Number(box.dataset.mdTableFrom), Number(box.dataset.mdTableRow ?? 0),
    Number(box.dataset.mdTableCol ?? 0), operation);
  if (target) queueMicrotask(() => {
    const cell = box.querySelector<HTMLTableCellElement>(`[data-md-row="${target.row}"][data-md-col="${target.col}"]`);
    cell?.focus();
  });
}

/** 局部工具条（自 table-editor 迁入；源坐标与目标格始终从当前容器读取）。 */
function createTableTools(main: EditorView): HTMLElement {
  const tools = document.createElement('div'); tools.className = 'mdir-tabletools';
  tools.setAttribute('role', 'toolbar'); tools.setAttribute('aria-label', t('ctx.table'));
  const operations: Array<[TableOperation, Parameters<typeof icon>[0]]> = [
    ['rowAbove', 'tableRow'], ['rowBelow', 'tableRow'], ['colLeft', 'tableColumn'], ['colRight', 'tableColumn'],
    ['delRow', 'cut'], ['delCol', 'cut'], ['rowUp', 'arrowUp'], ['rowDown', 'arrowDown'], ['colPrev', 'arrowLeft'], ['colNext', 'arrowRight'],
  ];
  for (const [op, glyph] of operations) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'tb';
    button.dataset.tableOp = op; button.title = t('tbl.' + op); button.setAttribute('aria-label', button.title);
    button.innerHTML = icon(glyph);
    button.addEventListener('mousedown', e => e.preventDefault());
    button.addEventListener('click', () => applyOperation(main, tools.closest<HTMLElement>('.mdir-tablebox')!, op));
    tools.append(button);
  }
  const align = document.createElement('select'); align.setAttribute('aria-label', t('tbl.align')); align.title = t('tbl.align');
  for (const value of ['left', 'center', 'right']) {
    const option = document.createElement('option'); option.value = value; option.textContent = t('tbl.' + value); align.append(option);
  }
  align.addEventListener('change', () => applyOperation(main, tools.closest<HTMLElement>('.mdir-tablebox')!, align.value as TableOperation));
  tools.append(align);
  for (const name of ['rows', 'cols']) {
    const label = document.createElement('label'); label.textContent = t('tbl.' + name);
    const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.max = name === 'rows' ? '1000' : '100';
    input.dataset.tableSize = name; input.title = t('tbl.' + name); input.setAttribute('aria-label', t('tbl.' + name)); label.append(input); tools.append(label);
  }
  const resize = document.createElement('button'); resize.type = 'button'; resize.className = 'tb';
  resize.title = t('tbl.resize'); resize.setAttribute('aria-label', resize.title); resize.innerHTML = icon('ruler');
  resize.addEventListener('click', () => {
    const box = tools.closest<HTMLElement>('.mdir-tablebox')!;
    const rows = tools.querySelector<HTMLInputElement>('[data-table-size=rows]')!;
    const cols = tools.querySelector<HTMLInputElement>('[data-table-size=cols]')!;
    if (!rows.reportValidity() || !cols.reportValidity()) return;
    if (main.state.readOnly) return;
    if (resizeTable(main, Number(box.dataset.mdTableFrom), rows.valueAsNumber, cols.valueAsNumber)) {
      queueMicrotask(() => box.querySelector<HTMLTableCellElement>('[data-md-row="1"][data-md-col="0"]')?.focus());
    }
  });
  tools.append(resize);
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'tb';
  remove.innerHTML = icon('tableRemove'); remove.title = t('tbl.deleteTable'); remove.setAttribute('aria-label', remove.title);
  remove.addEventListener('mousedown', e => e.preventDefault());
  remove.addEventListener('click', () => {
    if (main.state.readOnly) return;
    if (deleteTable(main, Number(tools.closest<HTMLElement>('.mdir-tablebox')!.dataset.mdTableFrom))) main.focus();
  });
  tools.append(remove);
  // 工具条是鼠标操作面：不参与键盘 Tab 导航（防围栏等上下文的浏览器默认焦点导航误触）。
  for (const control of tools.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')) control.tabIndex = -1;
  return tools;
}

/** 单元格脚注编号按文档级首次引用序与出现次序修正 id（旧 hydrateTableNotes 的 P5 移植）。 */
function hydrateCellNotes(box: HTMLElement, view: EditorView): void {
  const index = view.state.field(referenceFieldOf);
  for (const link of box.querySelectorAll<HTMLAnchorElement>('a[data-md-note]')) {
    const cell = link.closest('td,th') as HTMLTableCellElement | null;
    if (!cell) continue;
    const range = cellRange(view, box, Number(cell.dataset.mdRow), Number(cell.cellIndex));
    const note = index.footnotes.get(link.dataset.mdNote!);
    if (!range || !note) continue;
    const position = range.from + Number(link.dataset.mdOffset);
    const occurrence = note.references.findIndex(ref => currentPositionOf(index, ref.from) === position);
    link.id = `footnotes-ref-${note.number}${occurrence > 0 ? ':' + (occurrence + 1) : ''}`;
  }
}

/** 单元格图片水合：本地相对路径经 zasset；远程 http(s) 经取图钩子异步回填（离格/换件后失效）。 */
function hydrateCellImages(box: HTMLElement, view: EditorView, baseDir: string | null, remoteResolve?: (url: string) => Promise<string | null>): void {
  for (const img of box.querySelectorAll<HTMLImageElement>('img')) {
    const src = img.getAttribute('src');
    if (!src) continue;
    if (/^https?:/i.test(src)) {
      if (!remoteResolve) continue;
      img.removeAttribute('src'); // 解析前不加载
      img.dataset.mdRemoteSrc = src;
      // 远程图异步回填：按 data-md-remote-src 在当前视图查活节点（换件/迟到自然失效）；
      // 块件 DOM 插入可能晚于已决 promise（CM6 度量相位），带界重试等插入。
      void remoteResolve(src).then(url => {
        if (!url) return;
        let attempts = 0;
        const fill = (): void => {
          const live = view.dom.querySelector<HTMLImageElement>(`img[data-md-remote-src="${CSS.escape(src)}"]`);
          if (live) { live.src = url; return; }
          if (attempts++ < 20) setTimeout(fill, 0);
        };
        fill();
      }).catch(() => {});
      continue;
    }
    if (/^(data:|asset:|blob:|tauri:|\/\/)/i.test(src)) continue;
    const local = baseDir !== null ? localImagePath(src, baseDir) : null;
    if (local) img.src = zassetUrl(local);
  }
}

/** 宽度稳定占位文本：剥离常见行内标记（宽度≈渲染态；行高跨占位→渲染过渡不变）。
 *  完整语义渲染仍由惰性队列的 renderCellHtml 承载，此处只求几何稳定。 */
function placeholderText(source: string): string {
  return cellInlineText(source)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\[\^([^\]]+)\]/g, '$1')
    .replace(/(\*\*|__|\*|_|==|~~|`)/g, '');
}

/** 单元格静态 HTML 的 LRU 缓存（键 = 源文本 + 引用指纹；惰性交付与提交渲染共用）。 */
const cellHtmlCache = new Map<string, string>();
function cellHtmlCached(source: string, references: ReferenceIndex | null): string {
  const key = source + '\u0000' + (references?.inlineKey ?? '');
  const hit = cellHtmlCache.get(key);
  if (hit !== undefined) {
    cellHtmlCache.delete(key); cellHtmlCache.set(key, hit); // LRU 触碰
    return hit;
  }
  const html = renderCellHtml(source, references?.definitions, references?.footnotes);
  cellHtmlCache.set(key, html);
  if (cellHtmlCache.size > 512) cellHtmlCache.delete(cellHtmlCache.keys().next().value!);
  return html;
}

/** 单元格静态 HTML 的惰性交付队列（共享帧预算，≤4ms/帧）。
 *  交付时按（表位 × 行列）重查活格——排队后挂件可能被整体重建（CM6 度量相位 /
 *  装饰换代），旧闭包格已脱离文档，渲染须落到当前活格（与图片水合同口径）。 */
interface CellRenderJob { resolve: () => HTMLTableCellElement | null; source: string; references: ReferenceIndex | null; rendered?: (live: HTMLTableCellElement) => void; enqueued: number }
const cellRenderQueue: Array<CellRenderJob> = [];
let cellRenderFrame = 0;
function drainCellRender(): void {
  cellRenderFrame = 0;
  const deadline = performance.now() + 4;
  let requeued = 0;
  while (cellRenderQueue.length - requeued > 0 && performance.now() < deadline) {
    const job = cellRenderQueue.shift()!;
    const cell = job.resolve();
    // 判据是「能在编辑器 DOM 内查到」而非文档连接——测试宿主可不挂在 document 上。
    if (!cell) {
      if (performance.now() - job.enqueued < 500) { cellRenderQueue.push(job); requeued++; continue; }
      continue; // 500ms 仍未挂载：内容保持纯文本
    }
    cell.innerHTML = cellHtmlCached(job.source, job.references);
    job.rendered?.(cell);
    // 验证补刀：装饰换代可再换掉刚渲染的活格（eq 命中新盒），250ms 后若仍是纯文本则重渲染一次。
    const verify = (): void => {
      const live = job.resolve();
      if (live && live.isConnected && live.textContent === cellInlineText(job.source)) {
        live.innerHTML = cellHtmlCached(job.source, job.references);
        job.rendered?.(live);
      }
    };
    setTimeout(verify, 250);
  }
  if (cellRenderQueue.length) cellRenderFrame = requestIrFrame(drainCellRender);
}
function queueCellRender(resolve: () => HTMLTableCellElement | null, source: string, references: ReferenceIndex | null, rendered?: (live: HTMLTableCellElement) => void): void {
  if (!/[*_`~[\]$]/.test(source)) {
    const cell = resolve();
    if (cell) rendered?.(cell); // 无行内标记：纯文本即终态（仍触发水合）
    return;
  }
  cellRenderQueue.push({ resolve, source, references, rendered, enqueued: performance.now() });
  if (!cellRenderFrame) cellRenderFrame = requestIrFrame(drainCellRender);
}

/** 单元格惰性渲染是否已排空（测试与门禁的等待位）。 */
export function cellRenderSettled(): boolean { return cellRenderQueue.length === 0; }

export class TableEditWidget extends WidgetType {
  constructor(
    private header: string[],
    private align: ('left' | 'center' | 'right')[],
    private rows: string[][],
    /** 块位（点击进块的光标落点 = 首格；to 为界内钳制） */
    private from: number,
    private to: number,
    private references: ReferenceIndex | null,
    private inset: number,
    private quoted: number,
    private baseDir: string | null,
  ) { super(); }
  private sameContent(other: TableEditWidget): boolean {
    if (other.references?.inlineKey !== this.references?.inlineKey) return false;
    return other.header === this.header && other.rows === this.rows && other.align === this.align
      || other.header.length === this.header.length && other.header.every((c, i) => c === this.header[i])
        && other.rows.length === this.rows.length
        && other.rows.every((r, i) => r.length === this.rows[i]!.length && r.every((c, j) => c === this.rows[i]![j]))
        && other.align.join() === this.align.join();
  }
  eq(other: TableEditWidget): boolean {
    // 坐标参与等价（livepreview 的文档变更映射垫片会在装饰重建后二次映射 box 坐标，
    // 旧 TableWidget 经 updateDOM 自愈；P5 初版误删致脚注 id/写回坐标错位）。
    return other.from === this.from && other.to === this.to
      && other.inset === this.inset && other.quoted === this.quoted
      && other.baseDir === this.baseDir && this.sameContent(other);
  }
  /** 坐标漂移（前文插改）时只刷新数据集与容器样式；内容/引用指纹变化返回 false 交重建。 */
  updateDOM(dom: HTMLElement, _view: EditorView, previous: TableEditWidget): boolean {
    if (!this.sameContent(previous)) return false;
    dom.dataset.mdTableFrom = String(this.from);
    dom.dataset.mdTableTo = String(this.to);
    dom.style.paddingInlineStart = this.inset + 'px';
    dom.classList.toggle('mdir-quote-block', this.quoted > 0);
    dom.style.setProperty('--mdir-quote-depth', String(this.quoted));
    return true;
  }
  get estimatedHeight(): number {
    return (this.rows.length + 1) * ROW_ESTIMATE_PX;
  }
  /** 活动格提交：读文本→safeCell→与文档比对→单事务写回（无差异/只读不派发）；返回提交后的源文本。 */
  private commitCell(view: EditorView, box: HTMLElement, cell: HTMLTableCellElement): string {
    const row = Number(cell.dataset.mdRow), col = Number(cell.dataset.mdCol);
    const range = cellRange(view, box, row, col);
    const next = safeCell(cell.textContent ?? '');
    if (range && !view.state.readOnly && view.state.doc.sliceString(range.from, range.to) !== next) {
      view.dispatch({ changes: { ...range, insert: next }, userEvent: 'input.type' });
    }
    return next;
  }
  /** 指定格渲染为静态 HTML（源文本取自构建期数据或当前文档）。
   *  REQ-014 P6：滚动中同步挂载小表后，单元格 HTML（markdown-it 逐格渲染）成为滚轮响应
   *  热路径——按（源文本 × 引用指纹）LRU 缓存，重复内容表格近零成本挂载。 */
  private renderCell(cell: HTMLTableCellElement, row: number, col: number, onRendered?: (live: HTMLTableCellElement) => void, view?: EditorView): void {
    const source = row === 0 ? this.header[col] : this.rows[row - 1]?.[col] ?? '';
    if (row === 0) {
      // 表头同步渲染：table-layout:fixed 下列宽由首行决定——表头即渲染态锁列宽，
      // 表体惰性换装不再回流列宽（行高稳定；停稳窗 3px 推移的根治）。3 格成本可忽略。
      cell.innerHTML = cellHtmlCached(cellInlineText(source), this.references);
      onRendered?.(cell);
      return;
    }
    // REQ-014 P6：表体惰性交付——挂载先「宽度稳定」占位（剥离行内标记），静态 HTML 进
    // 共享帧队列；交付时按表位×行列重查活格（防装饰换代丢渲染）。列宽已由表头锁定。
    cell.textContent = placeholderText(source);
    const tableFrom = String(this.from);
    const plain = cell.textContent;
    queueCellRender(
      () => {
        if (!view) return null;
        const primary = view.dom.querySelector<HTMLTableCellElement>(`.mdir-tablebox[data-md-table-from="${tableFrom}"] [data-md-row="${row}"][data-md-col="${col}"]`);
        if (primary) return primary;
        for (const candidate of view.dom.querySelectorAll<HTMLTableCellElement>(`[data-md-row="${row}"][data-md-col="${col}"]`)) {
          if (candidate.closest('.mdir-tablebox') && candidate.textContent === plain) return candidate;
        }
        return null;
      },
      source, this.references,
      live => onRendered?.(live));
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div');
    box.className = 'mdir-tablebox';
    box.classList.toggle('mdir-quote-block', this.quoted > 0);
    box.style.setProperty('--mdir-quote-depth', String(this.quoted));
    box.style.paddingInlineStart = this.inset + 'px';
    box.dataset.mdTableFrom = String(this.from);
    box.dataset.mdTableTo = String(this.to);
    box.dataset.mdTableRows = String(this.rows.length + 1);
    box.dataset.mdTableCols = String(this.header.length);
    // REQ-014 P6：首帧高度钉扎（估计值）——实表首帧可比终态高 ~3px（次帧回落）+ 锚定
    // 不对称=3px 净位移；记忆签名含块序号（密集语料逐表唯一，命中率≈0），故用估计钉扎。
    // 行高随内容浮动（1 行 47.7/2 行 48.7）——稳定取值后自校正到真值（消除对预览的
    // 恒定偏移；consistency 门在 1.5s 后量取，届时已校正）。
    box.style.height = ((this.rows.length + 1) * TABLE_ROW_ESTIMATE_PX) + 'px';
    const table = document.createElement('table');
    table.className = 'mdir-table';
    table.setAttribute('aria-rowcount', String(this.rows.length + 1));
    const readOnly = () => view.state.readOnly;
    const rowOf = (row: number): HTMLTableRowElement => {
      const tr = document.createElement('tr');
      tr.dataset.mdRow = String(row);
      for (let col = 0; col < this.header.length; col++) {
        const cell = document.createElement(row === 0 ? 'th' : 'td');
        cell.dataset.mdRow = String(row); // TableEditWidget.data-row（data-model.md §4）
        cell.dataset.mdCol = String(col); // TableEditWidget.data-col
        // 阻断 cm-content 的可编辑继承：空闲格不可键入，激活格显式置 true。
        cell.setAttribute('contenteditable', 'false');
        if (this.align[col]) cell.style.textAlign = this.align[col]!;
        this.renderCell(cell, row, col, live => {
          const box = live.closest<HTMLElement>('.mdir-tablebox');
          if (!box) return;
          hydrateCellImages(box, view, this.baseDir, view.state.facet(imageContext).remoteResolve);
          hydrateCellNotes(box, view);
        }, view);
        tr.append(cell);
      }
      return tr;
    };
    const head = document.createElement('thead'); head.append(rowOf(0)); table.append(head);
    const body = document.createElement('tbody');
    for (let row = 1; row <= this.rows.length; row++) body.append(rowOf(row));
    table.append(body);
    const scroll = document.createElement('div'); scroll.className = 'mdir-tablescroll'; scroll.append(table);
    box.append(createTableTools(view), scroll);
    const listeners = new AbortController();
    // 活动格显式跟踪（不依赖 document.activeElement——合成事件无焦点迁移，且真实浏览器
    // 的 focusout 时序也不可靠）；格切换/离格时提交。
    let active: HTMLTableCellElement | null = null;
    const closeCell = (render = true): void => {
      const cell = active;
      if (!cell) return;
      active = null;
      const committed = this.commitCell(view, box, cell);
      cell.setAttribute('contenteditable', 'false');
      if (render) {
        cell.innerHTML = cellHtmlCached(cellInlineText(committed), this.references);
        hydrateCellImages(box, view, this.baseDir, view.state.facet(imageContext).remoteResolve);
      }
    };
    const openCell = (cell: HTMLTableCellElement): void => {
      if (cell === active) return;
      closeCell();
      const range = cellRange(view, box, Number(cell.dataset.mdRow), Number(cell.dataset.mdCol));
      cell.textContent = range ? cellInlineText(view.state.doc.sliceString(range.from, range.to)) : '';
      cell.setAttribute('contenteditable', 'true');
      box.dataset.mdTableRow = cell.dataset.mdRow!;
      box.dataset.mdTableCol = cell.dataset.mdCol!;
      active = cell;
      cell.focus();
    };
    // 按下即由渲染态切源文本编辑，并先开启 contentEditable——焦点与光标落点交浏览器默认行为。
    box.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || readOnly()) return;
      if ((e.target as HTMLElement).closest('a[data-md-note]')) { e.preventDefault(); return; } // 脚注链接：跳转，不开格
      const cell = (e.target as HTMLElement | null)?.closest('td,th') as HTMLTableCellElement | null;
      if (!cell || cell === active) return;
      e.preventDefault();
      openCell(cell);
    }, { signal: listeners.signal });
    // 表内脚注引用：点击跳到定义（与主文档行为同源）。
    box.addEventListener('click', event => {
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-md-note]');
      if (!link) return;
      event.preventDefault();
      const index = view.state.field(referenceFieldOf);
      const note = index.footnotes.get(link.dataset.mdNote!);
      if (note) { view.dispatch({ selection: { anchor: currentPositionOf(index, note.from) }, scrollIntoView: true }); view.focus(); }
    }, { signal: listeners.signal });
    // blur（真实焦点离格）：提交当前格并恢复渲染态（挂件重建前的兜底帧）。
    box.addEventListener('focusout', () => queueMicrotask(() => {
      if (active && !box.contains(document.activeElement)) closeCell();
    }), { signal: listeners.signal });
    // 键位契约（contracts/rendering-seams.md §3）。组合输入期间（IME 候选确认键）不拦截：
    // 不导航、不撤销、不 preventDefault；提交语义由 compositionend 后的常规路径承载。
    box.addEventListener('keydown', e => {
      if (e.isComposing) return;
      const cell = active;
      if (!cell) return;
      const rows = Number(box.dataset.mdTableRows), cols = Number(box.dataset.mdTableCols);
      const row = Number(cell.dataset.mdRow), col = Number(cell.dataset.mdCol);
      const cellAt = (r: number, c: number): HTMLTableCellElement | null =>
        box.querySelector<HTMLTableCellElement>(`[data-md-row="${r}"][data-md-col="${c}"]`);
      const go = (dir: 1 | -1): boolean => {
        const index = row * cols + col + dir;
        if (index >= 0 && index < rows * cols) {
          openCell(cellAt(Math.floor(index / cols), index % cols)!);
          return true;
        }
        if (dir < 0) return true;
        // 末格 Tab 追加一行（主文档历史记录一次）。
        closeCell();
        const at = Number(box.dataset.mdTableTo);
        const model = tableModel(view.state, Number(box.dataset.mdTableFrom));
        const prefix = model?.prefixes[1] ?? '';
        view.dispatch({ changes: { from: at, insert: '\n' + prefix + '|' + '  |'.repeat(cols) }, userEvent: 'input' });
        queueMicrotask(() => { const fresh = cellAt(rows, 0); if (fresh) openCell(fresh); });
        return true;
      };
      const vertical = (dir: 1 | -1): void => {
        const next = row + dir;
        if (next >= 0 && next < rows) {
          const target = cellAt(next, col);
          if (target) openCell(target);
        }
      };
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); go(e.shiftKey ? -1 : 1); return; }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeCell(); applyOperation(view, box, 'rowBelow'); return; }
      if (e.key === 'Enter') { e.preventDefault(); vertical(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); vertical(-1); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); vertical(1); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeCell(); view.focus(); return; }
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); undo(view); return; }
      if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo(view); return; }
      if (mod && /^[acvx]$/.test(key)) e.stopPropagation(); // 剪贴板交浏览器默认，其余全局命令不透传
      // 保存/查找/格式等全局命令转发主编辑器（CM6 忽略来自嵌套可编辑区的按键）。
      if (!e.defaultPrevented && mod && /^[sfhbik1-4]$/.test(key) && runScopeHandlers(view, e, 'editor')) {
        e.preventDefault();
      }
    }, { signal: listeners.signal });
    // 表格粘贴：TSV 网格走 table-model 的 pasteTable，纯文本走默认插入。
    box.addEventListener('paste', e => {
      const cell = active;
      if (!cell || readOnly()) return;
      const original = e.clipboardData?.getData('text/plain') ?? '';
      const text = limitTablePaste(original);
      if (text !== original) flash('表格粘贴内容已截断至 1 MB');
      const grid = parseTablePaste(text);
      if (!grid || !text.includes('\t')) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (pasteTable(view, Number(box.dataset.mdTableFrom), Number(cell.dataset.mdRow), Number(cell.dataset.mdCol), grid)) {
        queueMicrotask(() => box.querySelector<HTMLTableCellElement>(`[data-md-row="${cell.dataset.mdRow}"][data-md-col="${cell.dataset.mdCol}"]`)?.focus());
      }
    }, { capture: true, signal: listeners.signal });
    (box as HTMLElement & { __tableListeners?: AbortController }).__tableListeners = listeners;
    // box 级状态注册：销毁前提交活动格（组合中的结构变更不丢字）；liveBoxes 供全局钩子
    // （只读切换关格——CM6 WidgetType 无 updateDOM，由编排插件在 update 里驱动）。
    boxStates.set(box, {
      commitActive: () => { if (active) { const cell = active; queueMicrotask(() => this.commitCell(view, box, cell)); } },
      close: () => closeCell(),
    });
    liveBoxes.add(box);
    hydrateCellImages(box, view, this.baseDir, view.state.facet(imageContext).remoteResolve);
    hydrateCellNotes(box, view);
    // 实测高度记忆：同签名表格的首帧钉扎与滚动占位共用。量取时机=惰性渲染队列排空后
    // 连续两帧高度稳定（盲延 350ms 可能在队列排空前量取占位期高度——钉扎错值即停稳
    // 3px 回归；渲染后行高随标记/字体度量化）。
    const header = this.header, rows = this.rows;
    const capture = (attempt: number): void => {
      if (!box.isConnected) return;
      if (!cellRenderSettled() && attempt < 240) { setTimeout(() => capture(attempt + 1), 25); return; }
      // 自然高 = 揭钉同步量取（同任务复原，浏览器不渲染中间态）。
      const naturalOf = (): number => {
        const pin = box.style.height;
        box.style.height = '';
        const h = Math.round(box.getBoundingClientRect().height * 10) / 10;
        box.style.height = pin;
        return h;
      };
      let last = -1, stable = 0, frames = 0;
      const poll = (): void => {
        if (!box.isConnected || ++frames > 30) return; // 帧数上限：不拖长测试/离屏寿命
        const h = naturalOf();
        stable = Math.abs(h - last) < 0.05 ? stable + 1 : 0;
        last = h;
        if (stable >= 2) {
          rememberTableHeight(header, rows, h);
          // 自校正钉扎到自然真值（估计钉扎对 1 行行高表高 ~3px；校正后与预览零偏移）。
          box.style.height = h + 'px';
          return;
        }
        if (stable > -10) requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    };
    capture(0);
    return box;
  }
  destroy(dom: HTMLElement): void {
    const state = boxStates.get(dom);
    if (state) state.commitActive(); // 挂件被替换/移除前，未提交的编辑一次性写回
    (dom as HTMLElement & { __tableListeners?: AbortController }).__tableListeners?.abort();
    boxStates.delete(dom);
    liveBoxes.delete(dom);
  }
}

/** 滚动占位表格件（REQ-014 P6）：deferred 滚动期替代实表——高度优先取同签名实表实测记忆
 *  （首次遇表用行数估计），停稳补齐换实表近零位移；实表 DOM 构建移出滚轮热路径。 */
export class TableStubWidget extends WidgetType {
  constructor(private rows: number, private height: number) { super(); }
  eq(other: TableStubWidget): boolean { return other.rows === this.rows && other.height === this.height; }
  get estimatedHeight(): number { return this.height; }
  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mdir-tablestub';
    el.style.height = this.height + 'px'; // 挂载实测高度须与高度图估计一致（否则停稳换实表跳变）
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}

/** 轻量解析行内单元格（占位高度计算用；与 projector.splitTableRow 同口径的粗分）。 */
function stubCells(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
}

/** 由表格源行构造占位件：优先同签名实测高度，缺省 (行数+1)×行高初值。 */
export function tableStubFor(lines: string[]): TableStubWidget {
  const header = stubCells(lines[0]!);
  const rows = lines.slice(2).map(stubCells);
  const rows_ = rows.length;
  return new TableStubWidget(rows_, rememberedTableHeight(header, rows) ?? (rows_ + 1) * ROW_ESTIMATE_PX);
}

/** box 级运行态（活动格提交/关闭），供销毁与只读切换使用。 */
const boxStates = new WeakMap<HTMLElement, { commitActive: () => void; close: () => void }>();
const liveBoxes = new Set<HTMLElement>();

/** 只读生效时关闭所有活动格（不写回）——由编排插件在 readOnly 变更事务后调用。 */
export function closeAllTableEdits(view: EditorView): void {
  void view;
  for (const box of liveBoxes) boxStates.get(box)?.close();
}
