// markdown-view/live-widgets —— live preview 装饰件（WidgetType）与表格几何/hydrate 系列
// （批次 4 自 livepreview.ts 拆分，行为不变；代码逐段原样搬移）。
import { EditorView, WidgetType } from '@codemirror/view';
import { EditorState, type Text } from '@codemirror/state';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { SyntaxNode } from '@lezer/common';
import { allowAssetFile } from '../common/ipc';
import { t } from '../common/i18n';
import { isComposing } from '../common/composition';
import { cellRange, activeCell, openCellEditor, syncCellEditor, destroyCellEditor, createTableTools, refreshTableTools } from './table-editor';
import { TableViewport, tableCellAt, tableRowNumber } from './table-viewport';
import { fenceSourceChanged, fenceSourceField, fenceDraftField } from './writing';
import { joinRelPath, decodeLocalRef, renderMarkdownInline, type HeadingItem } from './preview';
import { type RenderBlock } from './render-model';
import { createRenderContext, mountRender, type RenderContext } from './render-service';
import { SOURCE_LINE_HEIGHT_PX } from './layout';
import { currentPosition, referenceField, emojiField, imageContext, type ReferenceIndex } from './live-state';

/** 装饰构建期的图片 src 解析（规则 21：非活动块装饰件构建时解析相对路径 → asset 协议） */
function localImgPath(src: string, baseDir: string | null): string | null {
  if (!src || /^(https?:|data:|asset:|blob:|tauri:|\/\/)/i.test(src)) return null;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: unknown } }).__TAURI_INTERNALS__;
  if (typeof internals?.convertFileSrc !== 'function') {
    console.warn('[ZiEdit IR] 本地图片需要 Tauri asset 环境，浏览器开发态无法显示本地图片。');
    return null;
  }
  if (!baseDir) return null;
  return joinRelPath(baseDir, decodeLocalRef(src.split(/[?#]/)[0]!));
}

// ── 装饰件（WidgetType） ──

const renderMounts = new WeakMap<HTMLElement, () => void>();
export class RenderWidget extends WidgetType {
  constructor(readonly block: RenderBlock, readonly doc: Text, readonly context: RenderContext) { super(); }
  /** 保守托底高度：源行数×源行高，显示态对齐 CSS min-height 40px。仅供 CM6 视口估计，
   *  实际渲染完成经 requestMeasure 回填纠偏（v0.40 规则 22 登记）。 */
  get estimatedHeight(): number {
    const lines = Math.max(1, this.doc.lineAt(this.block.from).number === this.doc.lineAt(this.block.to - 1).number ? 1
      : this.doc.lineAt(this.block.to - 1).number - this.doc.lineAt(this.block.from).number + 1);
    return Math.max(lines * SOURCE_LINE_HEIGHT_PX, 40);
  }
  eq(other: RenderWidget): boolean {
    return this.doc === other.doc && this.block.from === other.block.from && this.block.to === other.block.to
      && this.block.kind === other.block.kind && this.block.display === other.block.display
      && this.block.source === other.block.source && this.context.mathDigest === other.context.mathDigest;
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement(this.block.display ? 'div' : 'span'); this.start(dom, view);
    dom.addEventListener('mousedown', event => {
      if (view.state.readOnly || isComposing(view)) return;
      event.preventDefault();
      const position = Number(dom.dataset.renderFrom);
      view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, position + 1) }, scrollIntoView: true }); view.focus();
    });
    return dom;
  }
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (dom.tagName !== (this.block.display ? 'DIV' : 'SPAN')) return false;
    this.start(dom, view); return true;
  }
  private start(dom: HTMLElement, view: EditorView): void {
    renderMounts.get(dom)?.(); dom.dataset.renderFrom = String(this.block.from);
    renderMounts.set(dom, mountRender(dom, this.block, this.context, document.documentElement.dataset.tone === 'dark',
      () => view.state.doc === this.doc, () => view.requestMeasure(), () => isComposing(view)));
  }
  destroy(dom: HTMLElement): void { renderMounts.get(dom)?.(); renderMounts.delete(dom); }
  ignoreEvent(): boolean { return true; }
}

/** 渲染上下文按引用索引实例缓存：元数据引用在 B2 指纹门控下跨键入稳定，
 *  摘要与批量特征零重算；块表位置映射推迟到真正发起整批渲染时（resolve 内一次物化），
 *  纯文本键入与视口/选区重建不再为每个视口公式件复制整篇 renderBlocks。 */
const renderContexts = new WeakMap<ReferenceIndex, RenderContext>();
export function renderContextOf(index: ReferenceIndex): RenderContext {
  let context = renderContexts.get(index);
  if (!context) {
    context = createRenderContext(index.metadata.renderBlocks, position => currentPosition(index, position));
    renderContexts.set(index, context);
  }
  return context;
}

/** 分隔线：`---` 行 → 自绘横线（块级替换） */
export class HrWidget extends WidgetType {
  eq(): boolean { return true; }
  toDOM(): HTMLElement {
    const el = document.createElement('hr');
    el.className = 'mdir-hr';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}

/** 任务列表勾选框（M2 交互：点击切换 [ ]/[x]，单事务单步撤销；readOnly 挡原生翻转） */
export class TaskWidget extends WidgetType {
  constructor(private from: number, private to: number, private checked: boolean) { super(); }
  // from/to 参与 eq：位置漂移后必须换件，闭包里的旧位切换会改错处
  eq(other: TaskWidget): boolean {
    return other.from === this.from && other.to === this.to && other.checked === this.checked;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.className = 'mdir-task';
    el.checked = this.checked;
    el.readOnly = true;
    el.addEventListener('click', e => {
      e.preventDefault();
      if (!view.state.readOnly) view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' },
        userEvent: 'input',
      });
      // checkbox 的原生回滚发生在 click 派发之后，重新从文档读取，兼容键盘 Space 与只读。
      queueMicrotask(() => { el.checked = /\[[xX]\]/.test(view.state.doc.sliceString(this.from, this.to)); });
    });
    return el;
  }
}

/** 纯文本投影件，原文仍留在 CM 文档。 */
export class TextWidget extends WidgetType {
  constructor(private text: string, private cls: string, private id = '') { super(); }
  eq(other: TextWidget): boolean { return this.text === other.text && this.cls === other.cls && this.id === other.id; }
  toDOM(): HTMLElement { const el = document.createElement('span'); el.className = this.cls; el.textContent = this.text; if (this.id) el.id = this.id; return el; }
}

export class FootnoteWidget extends WidgetType {
  constructor(private text: string, private cls: string, private id: string, private target: number, private href: string) { super(); }
  eq(other: FootnoteWidget): boolean { return this.text === other.text && this.cls === other.cls && this.id === other.id && this.target === other.target && this.href === other.href; }
  toDOM(view: EditorView): HTMLElement {
    const link = document.createElement('a'); link.className = this.cls; link.textContent = this.text; link.id = this.id;
    link.href = '#' + this.href; link.title = this.cls === 'mdir-footnote-back' ? t('md.footnoteBack') : t('md.footnoteJump');
    link.addEventListener('mousedown', event => event.preventDefault());
    link.addEventListener('click', event => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, this.target) }, scrollIntoView: true }); view.focus();
    });
    return link;
  }
  ignoreEvent(): boolean { return true; }
}

export class TocWidget extends WidgetType {
  constructor(private entries: Array<{ heading: HeadingItem; position: number }>) { super(); }
  eq(other: TocWidget): boolean { return JSON.stringify(this.entries) === JSON.stringify(other.entries); }
  toDOM(view: EditorView): HTMLElement {
    const nav = document.createElement('nav'); nav.className = 'mdir-toc'; nav.setAttribute('aria-label', t('md.toc'));
    for (const { heading, position } of this.entries) {
      const link = document.createElement('a'); link.textContent = heading.text; link.href = '#' + heading.id;
      link.style.paddingInlineStart = (heading.level - 1) * 16 + 'px';
      link.addEventListener('mousedown', event => event.preventDefault());
      link.addEventListener('click', event => { event.preventDefault(); view.dispatch({ selection: { anchor: position }, scrollIntoView: true }); view.focus(); });
      nav.append(link);
    }
    return nav;
  }
  ignoreEvent(): boolean { return true; }
}

export function editingFence(state: EditorState, from: number): boolean {
  return state.field(fenceSourceField, false) === from || state.field(fenceDraftField, false) === from;
}
/** 起始围栏折叠为代码头；点击语言才展开起始源行。 */
export class CodeLabelWidget extends WidgetType {
  constructor(private lang: string, private from: number, private to: number, private inset: number, private quoted: number,
    private readOnly: boolean, private empty = false) { super(); }
  eq(other: CodeLabelWidget): boolean {
    return other.lang === this.lang && other.from === this.from && other.to === this.to
      && other.inset === this.inset && other.quoted === this.quoted && other.readOnly === this.readOnly && other.empty === this.empty;
  }
  /** 参与 CM6 原子域（与 blockAtomic 通用口径合并判定；见 atomicRanges facet）。 */
  get fence(): boolean { return true; }
  get estimatedHeight(): number { return this.empty ? 38 : 9; }
  toDOM(view: EditorView): HTMLElement {
    const head = document.createElement('div'); head.className = 'mdir-codehead';
    head.style.setProperty('--mdir-code-inset', this.inset + 'px');
    head.style.setProperty('--mdir-quote-depth', String(this.quoted));
    if (this.quoted) head.classList.add('mdir-code-quoted');
    const label = document.createElement('button'); label.type = 'button'; label.className = 'mdir-codelabel';
    label.textContent = this.lang || 'text'; label.title = t('common.language'); label.disabled = view.state.readOnly;
    label.addEventListener('mousedown', event => event.preventDefault());
    label.addEventListener('click', () => {
      if (view.state.readOnly) return;
      view.dispatch({ selection: { anchor: this.from, head: this.to },
        effects: fenceSourceChanged.of(view.state.doc.lineAt(this.from).from), scrollIntoView: true }); view.focus();
    });
    head.append(label);
    if (this.empty) {
      head.classList.add('mdir-codehead-empty');
      const body = document.createElement('div'); body.className = 'mdir-codeempty';
      body.addEventListener('mousedown', event => {
        if (view.state.readOnly || isComposing(view)) return;
        event.preventDefault();
        const line = view.state.doc.lineAt(this.from);
        const prefix = /^(.*?)(?:`{3,}|~{3,})/.exec(line.text)?.[1]?.replace(/(?:[-+*]|\d+[.)]) /g, mark => ' '.repeat(mark.length)) ?? '';
        const at = view.state.doc.line(line.number + 1).from;
        view.dispatch({ changes: { from: at, insert: prefix + '\n' }, selection: { anchor: at + prefix.length }, userEvent: 'input' }); view.focus();
      });
      head.append(body);
    }
    return head;
  }
  ignoreEvent(): boolean { return true; }
}

export function codeContainer(node: SyntaxNode): { inset: number; quoted: number } {
  let inset = 0, quoted = 0;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === 'Blockquote') { inset += 19; quoted++; }
    if (parent.name === 'ListItem') inset += 21.6;
  }
  return { inset, quoted };
}

/** 图片件：构建时解析 src；加载失败静默降级为占位（规则 21：失败静默占位）。
 *  009 规则 10：图床远程图经 remoteResolve 取回 data: URL 回填（host 过滤在调用方），
 *  取回失败静默——保留原 src，CSP 拦截呈占位（与预览路径同口径）。 */
// CM 在 eq 命中后会把同一 DOM 交给新的 Widget 实例，存活状态必须绑定 DOM，不能绑实例。
const liveImages = new WeakSet<HTMLElement>();
export class ImgWidget extends WidgetType {
  constructor(
    private src: string,
    private alt: string,
    private remoteResolve?: (url: string) => Promise<string | null>,
    private sourceFrom?: number,
    private baseDir: string | null = null
  ) { super(); }
  eq(other: ImgWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.sourceFrom === this.sourceFrom
      && other.baseDir === this.baseDir && other.remoteResolve === this.remoteResolve;
  }
  destroy(dom: HTMLElement): void { liveImages.delete(dom); }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    liveImages.add(el); // 构建阶段尚未挂 DOM，不能以 isConnected 判定是否有效。
    el.className = 'mdir-imgbox';
    if (this.sourceFrom !== undefined) el.dataset.mdFrom = String(this.sourceFrom);
    const img = document.createElement('img');
    img.className = 'mdir-img';
    img.alt = this.alt;
    img.dataset.mdSrc = this.src;
    const broken = (): void => {
      if (!liveImages.has(el)) return;
      el.classList.add('is-broken');
      const ph = document.createElement('span');
      ph.className = 'mdir-img-broken';
      ph.textContent = this.alt || this.src.slice(0, 120);
      el.replaceChildren(ph);
    };
    img.addEventListener('error', broken);
    img.addEventListener('load', () => el.classList.remove('is-broken'));
    if (this.remoteResolve && /^https?:\/\//i.test(this.src)) {
      void this.remoteResolve(this.src).then(
        dataUrl => {
          if (!liveImages.has(el)) return;
          if (dataUrl) {
            el.replaceChildren(img);
            img.src = dataUrl;
          } else broken();
        },
        broken
      );
    } else if (/^(https?:|\/\/)/i.test(this.src)) {
      broken();
      return el;
    } else {
      const path = localImgPath(this.src, this.baseDir);
      if (path) void allowAssetFile(path).then(() => {
        if (!liveImages.has(el)) return;
        el.replaceChildren(img);
        img.src = convertFileSrc(path);
      }, broken);
      else img.src = this.src;
    }
    el.appendChild(img);
    return el;
  }
}

/** 表格行内未转义竖线的文档坐标位（\| 转义跳过；行内导航与行列增删的几何基准） */
export function pipePositions(line: { from: number; to: number; text: string }): number[] {
  const ps: number[] = [];
  let slashes = 0;
  for (let i = 0; i < line.text.length; i++) {
    const ch = line.text[i]!;
    if (ch === '|' && slashes % 2 === 0) ps.push(line.from + i);
    slashes = ch === '\\' ? slashes + 1 : 0;
  }
  const prefix = /^\s*(?:>\s*)*/.exec(line.text)![0].length;
  if (ps[0] !== line.from + prefix) ps.unshift(line.from + prefix - 1);
  if (ps[ps.length - 1] !== line.to - (line.text.match(/\s*$/)?.[0].length ?? 0) - 1) ps.push(line.to);
  return ps;
}

/** 竖线位 → 单元格段（from = 段内首个非空白，to = 右界竖线；外缘竖线只作边界不分格） */
export function cellsBetween(pipes: number[], line: { from: number; text: string }): Array<{ from: number; to: number }> {
  const cells: Array<{ from: number; to: number }> = [];
  for (let j = 0; j + 1 < pipes.length; j++) {
    let s = pipes[j]! + 1;
    while (s < pipes[j + 1]! && /\s/.test(line.text[s - line.from]!)) s++;
    cells.push({ from: s, to: pipes[j + 1]! });
  }
  return cells;
}

/** 表格源行几何（导航与行列增删的行模型；delim = 对齐分隔行，非可导航行） */
export interface TableRowInfo {
  lineFrom: number;
  lineTo: number;
  pipes: number[];
  cells: Array<{ from: number; to: number }>;
  delim: boolean;
}

/** 表格对齐（从分隔行 :--- 读出） */
export function cellAlign(delims: string[]): ('left' | 'center' | 'right')[] {
  return delims.map(d => {
    const s = d.trim();
    const l = s.startsWith(':');
    const r = s.endsWith(':');
    return l && r ? 'center' : r ? 'right' : 'left';
  });
}

/** 表格整块网格渲染（规则 2：非活动表格块网格观感，块级替换件）。块级装饰只能出自
 *  StateField（CM6 约束：插件提供的装饰不得为块级/跨行替换），故本件由 liveBlockField
 *  侧产出；点击经 toDOM(view) 拿宿主视图直接派发光标（StateField 构造期无 view 可捕获）。 */
const tableImages = new WeakMap<HTMLElement, Array<{ widget: ImgWidget; dom: HTMLElement }>>();
const tableRenderCleanups = new WeakMap<HTMLElement, Array<() => void>>();
const tableViewports = new WeakMap<HTMLElement, TableViewport>();
function hydrateTableRenders(box: HTMLElement, view: EditorView): void {
  tableRenderCleanups.get(box)?.forEach(cancel => cancel());
  const cleanups: Array<() => void> = [], doc = view.state.doc;
  for (const target of box.querySelectorAll<HTMLElement>('.md-render-target[data-render-offset]')) {
    const cell = target.closest<HTMLTableCellElement>('td,th');
    if (!cell || cell.querySelector('.cm-editor')) continue;
    const row = tableRowNumber(cell), col = cell.cellIndex;
    const range = cellRange(view, box, row, col); if (!range) continue;
    const raw = doc.sliceString(range.from, range.to), pad = raw.length - raw.trimStart().length;
    const from = range.from + pad + Number(target.dataset.renderOffset), to = from + Number(target.dataset.renderLength);
    const block: RenderBlock = { kind: 'math', source: doc.sliceString(from + 1, to - 1), display: false, from, to };
    cleanups.push(mountRender(target, block, renderContextOf(view.state.field(referenceField)), document.documentElement.dataset.tone === 'dark',
      () => view.state.doc === doc, () => view.requestMeasure(), () => isComposing(view)));
  }
  tableRenderCleanups.set(box, cleanups);
}
/** 新输入行被 GFM 纳入表格时，把主光标交给对应格，避免块替换后 DOM 光标退回前文。 */
export function resumeTableCaret(view: EditorView, box: HTMLElement): void {
  const focused = view.hasFocus;
  queueMicrotask(() => {
    if (!focused || !box.isConnected || view.state.readOnly || activeCell(box)) return;
    const { head, empty } = view.state.selection.main;
    const start = Number(box.dataset.mdTableFrom), end = Number(box.dataset.mdTableTo);
    if (!empty || head <= start || head > end) return;
    const line = view.state.doc.lineAt(head).number - view.state.doc.lineAt(start).number;
    if (line === 1) return; // 分隔行仍按源语法输入。
    const row = tableCellAt(box, line > 1 ? line - 1 : 0, 0)?.parentElement as HTMLTableRowElement | undefined;
    if (!row) return;
    for (const cell of row.cells) {
      const range = cellRange(view, box, tableRowNumber(cell), cell.cellIndex, false);
      if (range && head >= range.from && head <= range.to) {
        openCellEditor(view, box, cell, { anchor: view.state.selection.main.anchor, head });
        return;
      }
    }
  });
}
function hydrateTableImages(box: HTMLElement, view: EditorView): void {
  const context = view.state.facet(imageContext);
  const images = (tableImages.get(box) ?? []).filter(image => {
    if (box.contains(image.dom)) return true;
    image.widget.destroy(image.dom); return false;
  });
  for (const img of box.querySelectorAll<HTMLImageElement>('img:not(.mdir-img)')) {
    const widget = new ImgWidget(img.getAttribute('src') ?? '', img.alt, context.remoteResolve, undefined, context.baseDir);
    const dom = widget.toDOM(); images.push({ widget, dom }); img.replaceWith(dom);
  }
  tableImages.set(box, images);
}
function hydrateTableNotes(box: HTMLElement, view: EditorView): void {
  const index = view.state.field(referenceField);
  for (const link of box.querySelectorAll<HTMLAnchorElement>('a[data-md-note]')) {
    const cell = link.closest<HTMLTableCellElement>('td,th')!;
    const range = cellRange(view, box, tableRowNumber(cell), cell.cellIndex);
    const note = index.footnotes.get(link.dataset.mdNote!);
    if (!range || !note) continue;
    const position = range.from + Number(link.dataset.mdOffset);
    const occurrence = note.references.findIndex(ref => currentPosition(index, ref.from) === position);
    link.id = `footnotes-ref-${note.number}${occurrence > 0 ? ':' + (occurrence + 1) : ''}`;
  }
}
export class TableWidget extends WidgetType {
  constructor(
    private header: string[],
    private align: ('left' | 'center' | 'right')[],
    private rows: string[][],
    /** 块位（点击进块的光标落点 = 首格；to 为界内钳制） */
    private from: number,
    private to: number,
    /** 源行数（doc.lineAt 换算于构建期，供 estimatedHeight 保守托底） */
    private sourceLines: number,
    private references: ReferenceIndex | null,
    private emojis: Readonly<Record<string, string>>,
    private inset: number,
    private quoted: number
  ) { super(); }
  private sameContent(other: TableWidget): boolean {
    if (other.emojis !== this.emojis) return false;
    if (other.references?.inlineKey !== this.references?.inlineKey) return false;
    if (other.header === this.header && other.rows === this.rows && other.align === this.align) return true;
    return other.header.length === this.header.length && other.header.every((c, i) => c === this.header[i])
      && other.rows.length === this.rows.length
      && other.rows.every((r, i) => r.length === this.rows[i]!.length && r.every((c, j) => c === this.rows[i]![j]))
      && other.align.join() === this.align.join();
  }
  /** 保守托底高度：源行数×源行高与 (行数+1)×表格行高初值 32 取大。仅供 CM6 视口估计，
   *  实际行高经 ResizeObserver/requestMeasure 回填纠偏（v0.40 规则 22 登记）。 */
  get estimatedHeight(): number {
    return Math.max(Math.max(1, this.sourceLines) * SOURCE_LINE_HEIGHT_PX, (this.rows.length + 1) * 32);
  }
  eq(other: TableWidget): boolean {
    return other.from === this.from && other.to === this.to && other.inset === this.inset && other.quoted === this.quoted && this.sameContent(other);
  }
  updateDOM(dom: HTMLElement, _view: EditorView, previous: TableWidget): boolean {
    const sameShape = previous.header.length === this.header.length && previous.rows.length === this.rows.length;
    const restoreFocus = !sameShape && !!activeCell(dom)?.contains(document.activeElement);
    if (!sameShape) destroyCellEditor(dom, false);
    // 表格外编辑只移动源码坐标，网格和图片继续复用；点击读最新坐标，不能保留旧闭包位置。
    dom.dataset.mdTableFrom = String(this.from);
    dom.dataset.mdTableTo = String(this.to);
    this.containerStyle(dom);
    if (!this.sameContent(previous)) tableViewports.get(dom)!.update(this.rows.length + 1, this.header.length, this.rowRenderer(dom));
    syncCellEditor(_view, dom);
    hydrateTableImages(dom, _view);
    hydrateTableNotes(dom, _view);
    hydrateTableRenders(dom, _view);
    refreshTableTools(_view, dom);
    if (restoreFocus) _view.focus();
    resumeTableCaret(_view, dom);
    return true;
  }
  private rowRenderer(box: HTMLElement): (row: number, existing?: HTMLTableRowElement) => HTMLTableRowElement {
    const cache = new Map<string, string>();
    return (row, existing) => {
      const tr = existing ?? document.createElement('tr'); tr.dataset.mdRow = String(row);
      tr.classList.toggle('mdir-table-head', row === 0);
      tr.classList.toggle('mdir-table-even', row > 0 && row % 2 === 0);
      tr.setAttribute('aria-rowindex', String(row + 1));
      const values = row === 0 ? this.header : this.rows[row - 1]!;
      for (let col = 0; col < this.header.length; col++) {
        const cell = tr.cells[col] ?? tr.appendChild(document.createElement(row === 0 ? 'th' : 'td'));
        cell.style.textAlign = this.align[col] ?? 'left';
        if (cell === activeCell(box)) continue;
        const text = values[col] ?? '';
        let html = cache.get(text);
        if (html === undefined) {
          html = renderMarkdownInline(text, this.references?.definitions, this.emojis, this.references?.footnotes);
          if (cache.size < 1024) cache.set(text, html);
        }
        if (cell.dataset.mdCellHtml !== html) { cell.innerHTML = html; cell.dataset.mdCellHtml = html; }
      }
      return tr;
    };
  }
  private containerStyle(box: HTMLElement): void {
    box.classList.toggle('mdir-quote-block', this.quoted > 0);
    box.style.setProperty('--mdir-quote-depth', String(this.quoted));
    box.style.paddingInlineStart = this.inset + 'px';
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div');
    box.className = 'mdir-tablebox';
    this.containerStyle(box);
    box.dataset.mdTableFrom = String(this.from);
    box.dataset.mdTableTo = String(this.to);
    const table = document.createElement('table');
    table.className = 'mdir-table';
    const scroll = document.createElement('div'); scroll.className = 'mdir-tablescroll'; scroll.append(table);
    box.append(createTableTools(view), scroll);
    table.setAttribute('aria-rowcount', String(this.rows.length + 1));
    tableViewports.set(box, new TableViewport(view, box, table, this.rows.length + 1, this.header.length, this.rowRenderer(box),
      () => activeCell(box)?.parentElement as HTMLTableRowElement | null,
      () => { hydrateTableImages(box, view); hydrateTableNotes(box, view); hydrateTableRenders(box, view); }));
    box.addEventListener('mdir-cell-render', e => {
      const cell = e.target as HTMLTableCellElement;
      const { row, col } = (e as CustomEvent<{ row: number; col: number }>).detail;
      const range = cellRange(view, box, row, col);
      const index = view.state.field(referenceField);
      if (range) cell.innerHTML = renderMarkdownInline(view.state.doc.sliceString(range.from, range.to), index.definitions, view.state.field(emojiField), index.footnotes);
      hydrateTableImages(box, view);
      hydrateTableNotes(box, view);
      hydrateTableRenders(box, view);
    });
    box.addEventListener('click', event => {
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-md-note]');
      if (!link) return;
      event.preventDefault();
      const index = view.state.field(referenceField), note = index.footnotes.get(link.dataset.mdNote!);
      if (note) { view.dispatch({ selection: { anchor: currentPosition(index, note.from) }, scrollIntoView: true }); view.focus(); }
    });
    box.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
      if ((e.target as HTMLElement).closest('a[data-md-note]')) { e.preventDefault(); return; }
      const cell = (e.target as HTMLElement | null)?.closest('td,th') as HTMLTableCellElement | null;
      if (!cell || cell.querySelector('.cm-editor')?.contains(e.target as Node)) return;
      if (view.state.readOnly) return;
      e.preventDefault();
      openCellEditor(view, box, cell);
    });
    resumeTableCaret(view, box);
    refreshTableTools(view, box);
    hydrateTableNotes(box, view);
    hydrateTableRenders(box, view);
    return box;
  }
  destroy(dom: HTMLElement): void {
    tableViewports.get(dom)?.destroy(); tableViewports.delete(dom);
    destroyCellEditor(dom, false);
    tableRenderCleanups.get(dom)?.forEach(cancel => cancel()); tableRenderCleanups.delete(dom);
    for (const image of tableImages.get(dom) ?? []) image.widget.destroy(image.dom);
    tableImages.delete(dom);
  }
}
