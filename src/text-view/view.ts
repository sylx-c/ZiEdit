// text-view —— 虚拟滚动文本视图（002 子 PRD P0 + M4 P1 批）
// 自绘滚动模型：总高 = 行数 × 行高；可视窗口 ± overscan 按需请求行区间。
// M4：Lezer 窗口级语法高亮、书签（Ctrl+F2/F2）、位置历史（Alt+←/→）、
// Ctrl+滚轮缩放、日志跟随（轮询 text_refresh）、正则查找。

import {
  docxOpen,
  docxLines,
  pdfOpen,
  pdfLines,
  onTextIndex,
  textFind,
  textLineSegment,
  textLines,
  textOpen,
  textRefresh,
  type FindOptions,
} from '../common/ipc';
import { getParser, hasHighlight, hasHighlightParser, highlightLines, loadHighlightParser, type Span } from './highlight';
import { Minimap } from './minimap';
import { FindBar, type FindRunResult } from './findbar';
import { markRectCopy, rectPointerPlan, rectSpanOfCells, charAtVisualCol, visualWidth, autoScrollBeyond } from './rect';
import { t, tf } from '../common/i18n';

export const LINE_HEIGHT = 19.2; // 定稿：12px × 1.6 行高
const OVERSCAN = 20;
const FETCH_BATCH = 300;
const FOLLOW_POLL_MS = 1200;
const HISTORY_MAX = 100;
/** 缩放字号范围 */
const FONT_MIN = 10;
const FONT_MAX = 18;
const LONG_LINE_SEGMENT_BYTES = 256 * 1024;

interface LongLineState {
  offset: number;
  nextOffset: number | null;
  totalBytes: number;
  text: string;
}

export interface TextViewStatus {
  rect: { lines: number; cols: number } | null;
  encoding: string;
  encodingSource: string;
  newline: string;
  size: number;
  totalLines: number;
  visibleLine: number;
  indexing: boolean;
  follow: boolean;
  bookmarks: number[];
  highlighted: boolean;
  /** 当前生效的高亮语言名（未启用为 null） */
  language: string | null;
}

/** 可视行区间（纯函数，供单测） */
export function visibleRange(scrollTop: number, viewportH: number, totalLines: number): { from: number; to: number } {
  const total = Math.max(1, totalLines);
  const from = Math.min(Math.max(1, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN + 1), total);
  const visible = Math.ceil(viewportH / LINE_HEIGHT) + OVERSCAN * 2;
  const to = Math.min(total, from + visible - 1);
  return { from, to };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 不可见字符（002 规则 25：零宽/控制/RTL；与 008 共享判定口径） */
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2060\u202A-\u202E\u2066-\u2069\uFEFF]/;
export { INVISIBLE_RE };
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060\uFEFF]/;

/** 行文本 + 语法区间 + 查找命中区间 + 矩形选区区间 → 安全 HTML（命中段优先着色，M6-3 字符级；
 *  markInvisible 时零宽/控制符标出并给替代符，002 规则 25） */
export function renderLineHtml(
  text: string,
  spans?: Span[],
  findRanges?: Array<{ from: number; to: number }>,
  markInvisible = false,
  selRanges?: Array<{ from: number; to: number }>,
  curFindFrom?: number
): string {
  if ((!spans || spans.length === 0) && (!findRanges || findRanges.length === 0) && !markInvisible && (!selRanges || selRanges.length === 0)) {
    return escapeHtml(text);
  }
  const n = text.length;
  const cls = new Array<string | null>(n).fill(null);
  if (spans) {
    for (const s of spans) {
      for (let i = s.from; i < s.to && i < n; i++) cls[i] = s.cls;
    }
  }
  if (findRanges) {
    // P1-2 三色（002 规则 7 v2.4）：命中词强色；当前命中（curFindFrom 起的那一段）第三色
    for (const r of findRanges) {
      const cur = curFindFrom != null && r.from === curFindFrom;
      for (let i = Math.max(0, r.from); i < r.to && i < n; i++) cls[i] = cur ? 'tv-hit-c current' : 'tv-hit-c';
    }
  }
  if (selRanges) {
    for (const r of selRanges) {
      for (let i = Math.max(0, r.from); i < r.to && i < n; i++) cls[i] = 'tv-rect';
    }
  }
  let out = '';
  let i = 0;
  while (i < n) {
    if (markInvisible && INVISIBLE_RE.test(text[i])) {
      let j = i + 1;
      while (j < n && INVISIBLE_RE.test(text[j])) j++;
      const run = text.slice(i, j);
      const shown = [...run].map(c => (ZERO_WIDTH_RE.test(c) ? '·' : c === '\t' ? c : '·')).join('');
      const cp = run.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
      out += `<span class="tv-invisible" title="${tf('tv.invisibleChar', cp)}">${escapeHtml(shown)}</span>`;
      i = j;
      continue;
    }
    const c = cls[i];
    let j = i + 1;
    while (j < n && cls[j] === c && !(markInvisible && INVISIBLE_RE.test(text[j]))) j++;
    const seg = escapeHtml(text.slice(i, j));
    out += c ? `<span class="${c}">${seg}</span>` : seg;
    i = j;
  }
  return out;
}

/** 查看态行缓存（T002-04，审计 2026-10-17）：修前 Map<number,string> 只增不减，且缩略图
 *  预取会按行数采样整文件——1GB/22 万长行文件浏览即把全文搬进 JS 字符串，内存无界。
 *  本类按**字节预算**管理：set 记账，超预算按「离视口最远」淘汰（视口行随取随回填）；
 *  预取方（缩略图）在预算耗尽时应停手（hasBudget()）——采样条回落中性宽度为既定降级。 */
export class LinesCache {
  private map = new Map<number, string>();
  private bytes = 0;
  constructor(private budgetBytes: number) {}
  get size(): number { return this.map.size; }
  get usedBytes(): number { return this.bytes; }
  /** 预算是否还有余量（预取闸；视口填充不受此限——只是不再预取） */
  hasBudget(): boolean { return this.bytes < this.budgetBytes; }
  has(n: number): boolean { return this.map.has(n); }
  get(n: number): string | undefined { return this.map.get(n); }
  set(n: number, text: string): void {
    const prev = this.map.get(n);
    if (prev !== undefined) this.bytes -= prev.length;
    this.map.set(n, text);
    this.bytes += text.length;
  }
  delete(n: number): void {
    const prev = this.map.get(n);
    if (prev !== undefined) { this.map.delete(n); this.bytes -= prev.length; }
  }
  clear(): void { this.map.clear(); this.bytes = 0; }
  /** 超预算时按离 center 最远淘汰到 80% 预算（返回是否发生了淘汰，供 cacheVersion 递增） */
  trimToBudget(center: number): boolean {
    if (this.bytes <= this.budgetBytes) return false;
    const target = Math.floor(this.budgetBytes * 0.8);
    const keys = [...this.map.keys()].sort((a, b) => Math.abs(b - center) - Math.abs(a - center));
    for (const k of keys) {
      if (this.bytes <= target) break;
      this.delete(k);
    }
    return true;
  }
}

export class TextView {
  private fetchLines: typeof textLines = (path, from, to, encoding) => this.opts.language === 'Docx'
    ? docxLines(path, from, to).then(result => result.lines)
    : this.opts.language === 'Pdf' ? pdfLines(path, from, to).then(result => result.lines)
    : textLines(path, from, to, encoding);
  private host: HTMLElement;
  private path: string;
  private scroller!: HTMLDivElement;
  private sizer!: HTMLDivElement;
  private viewport!: HTMLDivElement;
  private bar!: HTMLDivElement; // 跳转行栏（查找已并入统一查找栏 FindBar）
  private barInput!: HTMLInputElement;
  private barMode: 'goto' | null = null;
  private findBar!: FindBar;
  private findCurHit: number | null = null; // 最近命中行（前进/后退的游标基准）

  private lines = new LinesCache(32 * 1024 * 1024); // T002-04：32MB 字节预算（原裸 Map 无界）
  private longLines = new Map<number, LongLineState>();
  private longLineVersion = 0;
  private totalLines = 0;
  private encoding = '';
  private encodingSource = '';
  private encodingRevision = 0;
  private newline = '';
  private size = 0;
  private indexing = false;
  private hlLang: string | null = null;
  private hlCacheKey = '';
  private hlSpanMap: Map<number, Span[]> | null = null;
  private hlLoadLang: string | null = null;
  private hlLoadSeq = 0;
  private bookmarks = new Set<number>();
  /** bookmarks 升序缓存（set 变化时才重排，滚动上报路径零拷贝排序） */
  private sortedBookmarksCache: number[] | null = null;
  /** 滚动上报 rAF 句柄（每帧至多一次 reportStatus + minimap.sync） */
  private scrollReportRaf = 0;
  private history: number[] = [];
  private hIndex = -1;
  private follow = false;
  private followTimer: ReturnType<typeof setInterval> | null = null;
  private fontSize: number; // 定稿 demo 默认 12px / 行高 1.6（001 规则 31 持久化）
  private renderedKey = '';
  private filling = false;
  private pendingFill = false;
  private lastReportedScroll = 0;
  private unlisten?: () => void;
  private destroyed = false;
  /** 行缓存版本（缩略图据此判断密度条是否需要重建，避免滚动路径全量重画） */
  private cacheVersion = 0;

  // ---- Markdown 标题折叠（M6-4，≤2 万行启用）----
  private headings = new Map<number, number>(); // 真实行 → 标题层级
  private folded = new Set<number>();
  private dispLines: number[] | null = null; // 显示行(0基) → 真实行(1基)；null=未折叠模式
  private foldReady = false;

  private get foldEligible(): boolean {
    return this.opts.language === 'Markdown' && this.totalLines > 0 && this.totalLines <= 20000 && !this.indexing;
  }
  private get dispCount(): number {
    return this.dispLines ? this.dispLines.length : this.totalLines;
  }
  private realOfDisp(disp0: number): number {
    if (!this.dispLines) return disp0 + 1;
    return this.dispLines[Math.min(Math.max(0, disp0), this.dispLines.length - 1)] ?? disp0 + 1;
  }
  private dispOfReal(real: number): number {
    if (!this.dispLines) return real - 1;
    let lo = 0;
    let hi = this.dispLines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.dispLines[mid] < real) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private async ensureFoldMap(): Promise<void> {
    if (!this.foldEligible || this.foldReady) return;
    const BATCH = 5000;
    for (let from = 1; from <= this.totalLines;) {
      try {
        const got = await this.fetchLines(this.path, from, Math.min(this.totalLines, from + BATCH - 1), this.encoding);
        if (!got.length) return;
        for (const l of got) {
          const m = l.text.match(/^(#{1,6})\s+\S/);
          if (m) this.headings.set(l.no, m[1].length);
        }
        from = got[got.length - 1]!.no + 1;
      } catch {
        return; // 索引变化等情况放弃本轮
      }
    }
    this.foldReady = true;
    this.rebuildDisp();
  }

  private foldScheduled = false;
  /** 折叠地图后台构建（性能整改：原先 Markdown 首屏前同步全量读 ≤2 万行，改首屏后 idle 构建再补渲染） */
  private scheduleFoldMap(): void {
    if (!this.foldEligible || this.foldReady || this.foldScheduled) return;
    this.foldScheduled = true;
    const idle = (cb: () => void): void => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(cb, { timeout: 1500 });
      else setTimeout(cb, 250);
    };
    idle(() => {
      this.foldScheduled = false;
      if (this.destroyed) return;
      void this.ensureFoldMap().then(() => {
        if (this.destroyed) return;
        this.updateSizer();
        this.scheduleFill();
        this.reportStatus();
      });
    });
  }

  private rebuildDisp(): void {
    if (!this.foldReady || this.folded.size === 0) {
      this.dispLines = null;
      return;
    }
    const disp: number[] = [];
    let skippingUntilLevel = 0;
    for (let n = 1; n <= this.totalLines; n++) {
      const lvl = this.headings.get(n);
      if (skippingUntilLevel > 0) {
        if (lvl && lvl <= skippingUntilLevel) {
          skippingUntilLevel = 0;
        } else {
          continue;
        }
      }
      disp.push(n);
      if (this.folded.has(n) && lvl) skippingUntilLevel = lvl;
    }
    this.dispLines = disp;
  }

  private toggleFold(line: number): void {
    if (!this.headings.has(line)) return;
    if (this.folded.has(line)) this.folded.delete(line);
    else this.folded.add(line);
    this.rebuildDisp();
    this.updateSizer();
    this.scheduleFill();
    this.reportStatus();
  }

  constructor(
    host: HTMLElement,
    path: string,
    private opts: {
      onStatus: (s: TextViewStatus) => void;
      onScrollPersist: (path: string, scrollTop: number) => void;
      onBookmarksChange: (path: string, bookmarks: number[]) => void;
      restoreScroll: number;
      restoreBookmarks?: number[];
      language?: string | null;
      /** 缩略图（002 规则 23）：缺省开启 */
      minimap?: boolean;
      /** 行号可见性（002 规则 10 v2.8：缺省开可切；与编辑面一致） */
      showLineNumbers?: boolean;
      /** 字号（001 规则 31：10–18，持久化值传入） */
      fontSize?: number;
      /** Ctrl+滚轮缩放回调（app 侧持久化并同步编辑态） */
      onFontSize?: (n: number) => void;
      /** 右键上下文菜单（app 侧实现；缺省用 webview 默认菜单） */
      onContextMenu?: (x: number, y: number, line: number) => void;
    }
  ) {
    this.host = host;
    this.path = path;
    this.fontSize = opts.fontSize ?? 12;
    if (opts.restoreBookmarks) {
      for (const b of opts.restoreBookmarks) this.bookmarks.add(b);
      this.sortedBookmarksCache = null; // restore 改动了 set：排序缓存失效
    }
    this.minimapEnabled = opts.minimap !== false;
    this.showLn = opts.showLineNumbers !== false;
  }

  private minimap: import('./minimap').Minimap | null = null;
  private minimapEnabled = true;
  private invisibleOn = false;
  private showLn = true;

  // ---- 查看态矩形选区（005 规则 13 v1.0：Alt+拖拽框选竖块复制，任意大小文件可用）----
  private rectSel: { lineA: number; colA: number; lineB: number; colB: number } | null = null;
  private rectDragging = false;
  private charW = 0; // 等宽字符像素宽（随字号缓存）

  /** 当前是否存在矩形选区（右键"复制矩形选区"显示依据） */
  hasRectSelection(): boolean {
    return this.rectSel != null;
  }

  get rectSize(): { lines: number; cols: number } | null {
    const r = this.rectSel;
    return r ? { lines: Math.abs(r.lineB - r.lineA) + 1, cols: Math.abs(r.colB - r.colA) + 1 } : null;
  }

  /** 矩形选区补齐文本（短行补空格，与编辑态列复制同口径；#10：未缓存行先回源补读） */
  async rectCopyText(): Promise<string | null> {
    if (!this.rectSel) return null;
    const { fromLine, toLine, colStart, colEnd } = rectSpanOfCells(
      { line: this.rectSel.lineA, cell: this.rectSel.colA }, { line: this.rectSel.lineB, cell: this.rectSel.colB }
    );
    // 回源补读未缓存行（此前未命中行按空串补空格，复制内容失真）
    for (let n = fromLine; n <= toLine; n += FETCH_BATCH) {
      const hi = Math.min(toLine, n + FETCH_BATCH - 1);
      if (this.lines.has(n) && this.lines.has(hi)) continue;
      try {
        const got = await this.fetchLines(this.path, n, hi, this.encoding);
        for (const l of got) this.lines.set(l.no, l.text);
        this.cacheVersion++;
      } catch {
        /* 索引中等瞬态失败按已有缓存继续 */
      }
    }
    const out: string[] = [];
    for (let n = fromLine; n <= toLine; n++) {
      const text = this.lines.get(n) ?? '';
      // 005-03：colStart/colEnd 为像素格（视觉列）——按本行文本映射字符边界再切，短行按视觉宽补齐
      const a = charAtVisualCol(text, colStart);
      const b = charAtVisualCol(text, colEnd);
      const cut = text.slice(Math.min(a, b), Math.max(a, b));
      const missing = colEnd - colStart - visualWidth(cut);
      out.push(missing > 0 ? cut + ' '.repeat(missing) : cut);
    }
    const joined = out.join('\n');
    markRectCopy(true, joined); // 005 规则 5 v2.2：查看态矩形复制同样记来源标记（跨视图存活）
    return joined;
  }

  private clearRectSelection(): void {
    if (!this.rectSel) return;
    this.rectSel = null;
    this.render(true);
    this.reportStatus();
  }

  private measureCharW(): number {
    if (this.charW > 0) return this.charW;
    const span = document.createElement('span');
    span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${getComputedStyle(this.scroller).font}`;
    span.textContent = '0'.repeat(50);
    this.scroller.appendChild(span);
    this.charW = span.getBoundingClientRect().width / 50 || 7.2;
    span.remove();
    return this.charW;
  }

  /** 鼠标坐标 →（真实行, 列）：y 按行高；x 减行号栏与文本内边距后按字符宽取整（UTF-16 列口径，与列标记一致） */
  private posAt(ev: MouseEvent): { line: number; col: number } {
    const r = this.scroller.getBoundingClientRect();
    const disp = Math.max(0, Math.floor((ev.clientY - r.top + this.scroller.scrollTop) / LINE_HEIGHT));
    const line = this.realOfDisp(disp);
    const gutterW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gutter-w')) || 46;
    const x = ev.clientX - r.left + this.scroller.scrollLeft - gutterW - 16; // 16 = .tv-tx padding-left
    const col = Math.max(0, Math.floor(x / this.measureCharW()));
    return { line, col };
  }

  private onMouseDown(ev: MouseEvent): void {
    // 按下处置统一走 rectPointerPlan（005 规则 13：右键要留着矩形给「复制矩形选区」入口——
    // 旧实现不区分按键，右键 mousedown 先清矩形，随后 contextmenu 构菜单时 hasRectSelection()
    // 已为 false，该入口在查看态永不出现）
    const plan = rectPointerPlan(ev.button, false, ev.altKey, this.rectSel != null);
    if (plan.drag) {
      // Alt+拖拽：矩形选区（阻止原生文本选择）
      ev.preventDefault();
      const p = this.posAt(ev);
      this.rectSel = { lineA: p.line, colA: p.col, lineB: p.line, colB: p.col };
      this.rectDragging = true;
      this.render(true);
      this.reportStatus();
      let raf = 0;
      const onMove = (e2: MouseEvent): void => {
        cancelAnimationFrame(raf);
        if (!this.rectDragging) return;
        const q = this.posAt(e2);
        if (this.rectSel) {
          this.rectSel.lineB = q.line;
          this.rectSel.colB = q.col;
          this.render(true);
          this.reportStatus();
        }
        autoScrollBeyond(this.scroller, e2.clientY, () => {
          raf = requestAnimationFrame(() => onMove(e2));
        });
      };
      const onUp = (): void => {
        cancelAnimationFrame(raf);
        this.rectDragging = false;
        if (this.rectSel && this.rectSel.lineA === this.rectSel.lineB && this.rectSel.colA === this.rectSel.colB) {
          this.clearRectSelection();
        }
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    } else if (plan.clear && this.rectSel) {
      this.clearRectSelection();
    }
  }

  /** shell 视图菜单接线（002 规则 23：可隐藏） */
  setMinimapVisible(v: boolean): void {
    this.minimapEnabled = v;
    this.minimap?.setVisible(v);
  }

  /** 不可见字符高亮开关（002 规则 25） */
  setInvisibleVisible(v: boolean): void {
    this.invisibleOn = v;
    this.render(true);
  }

  /** 行号可见性开关（002 规则 10 v2.8 W2 清偿）：关时行号元素逐行隐藏（CSS .tv-noln 同口径） */
  setLineNumbersVisible(v: boolean): void {
    this.showLn = v;
    this.render(true);
  }

  async mount(): Promise<void> {
    this.buildDom();
    if (!['Docx', 'Pdf'].includes(this.opts.language ?? '')) this.unlisten = await onTextIndex(e => {
      if (e.path !== this.path || this.destroyed) return;
      if (e.error) {
        // 索引构建失败不再静默：退出 indexing 态并提示，用户可重载重试（M13 修复）
        this.indexing = false;
        this.updateSizer();
        this.reportStatus();
        return;
      }
      const totalChanged = (e.totalLines ?? this.totalLines) !== this.totalLines;
      this.totalLines = e.totalLines ?? this.totalLines;
      this.indexing = false;
      if (totalChanged) {
        // 行数变化（追加或截断）：旧行缓存可能含被续写/删除的尾行，清空重取；折叠地图同时失效
        this.lines.clear();
        this.longLines.clear();
        this.longLineVersion++;
        this.cacheVersion++;
        this.hlCacheKey = '';
        this.foldReady = false;
        this.headings.clear();
        this.folded.clear();
        this.dispLines = null;
      }
      this.updateSizer();
      if (this.follow) {
        this.scroller.scrollTop = this.sizer.clientHeight;
      }
      this.scheduleFill();
      this.reportStatus();
    });
    try {
      if (this.opts.language === 'Docx' || this.opts.language === 'Pdf') {
        const info = await (this.opts.language === 'Pdf' ? pdfOpen : docxOpen)(this.path);
        this.totalLines = info.paraCount;
        this.size = info.totalChars;
        this.encoding = 'UTF-8';
        this.indexing = false;
        this.updateSizer();
      } else {
      const info = await textOpen(this.path);
      this.size = info.len;
      this.encoding = info.encoding.name;
      this.encodingSource = info.encoding.source;
      this.newline = info.newline;
      if (info.indexReady) {
        this.totalLines = info.totalLines;
        this.indexing = false;
      } else {
        this.indexing = true;
      }
      this.setupHighlight(this.opts.language ?? null);
      // 打开即知总行数（indexReady）的文件也要立即撑高滚动区（D3 修复：
      // 此前仅 text-index 事件路径调 updateSizer，≤8MB 文件 sizer 从未设置，滚动被钳制在首屏）
      this.updateSizer();
      }
    } catch (err) {
      this.viewport.textContent = tf('err.openFail', String(err));
      return;
    }
    this.reportStatus();
    if (this.opts.restoreScroll > 0) {
      this.scroller.scrollTop = this.opts.restoreScroll;
    }
    // 缩略图（002 规则 23）：编辑行 flex 兄弟 [mm-resize][minimap][vscroll]
    this.minimap = new Minimap(this.host.closest('.editor-row') ?? this.host, {
      scrollTop: () => this.scroller.scrollTop,
      scrollHeight: () => this.scroller.scrollHeight,
      clientHeight: () => this.scroller.clientHeight,
      scrollTo: y => (this.scroller.scrollTop = y),
      totalLines: () => this.dispCount || this.totalLines,
      realLineOf: d => (this.dispLines ? (this.dispLines[d - 1] ?? d) : d),
      lineText: n => this.lines.get(n),
      lineSpans: n => (this.hlLang ? this.hlSpanMap?.get(n) : undefined),
      requestLines: (from, to) => this.mmRequestLines(from, to),
      goToLine: line => void this.goToLine(line, undefined, false),
      cacheVersion: () => this.cacheVersion,
      spansVersion: () => (this.hlLang ? this.hlVer : 0),
    });
    this.minimap.setVisible(this.minimapEnabled);
    await this.fill();
    this.reportStatus();
    this.scroller.addEventListener('scroll', () => this.onScroll());
    this.scroller.addEventListener('keydown', e => this.onKey(e));
    this.scroller.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    this.scroller.addEventListener('mousedown', e => this.onMouseDown(e));
    this.scroller.addEventListener('contextmenu', e => {
      if (!this.opts.onContextMenu) return;
      e.preventDefault();
      this.opts.onContextMenu(e.clientX, e.clientY, this.currentLine());
    });
    this.scroller.tabIndex = 0;
  }

  /** 语言名 → 高亮启用（在首次 fill 前，树/打开信息到位后调用） */
  private setupHighlight(language: string | null): void {
    this.hlLang = hasHighlight(language, this.size) ? language : null;
  }

  /** 状态栏"语法高亮"组合格：开/关纯文本（定稿 demo 交互） */
  setHighlight(on: boolean): void {
    const lang = this.opts.language ?? null;
    this.hlLang = on && hasHighlight(lang, this.size) ? lang : null;
    this.hlSpanMap = null;
    this.hlCacheKey = '';
    this.renderedKey = '';
    void this.fill();
    this.reportStatus();
  }

  /**
   * 手动指定高亮语言（状态栏语言选择弹窗，002 规则 6）。
   * @param lang 语言名；null=跟随扩展名自动探测；''=纯文本
   */
  setHighlightLanguage(lang: string | null | 'auto'): void {
    if (lang === null || lang === 'auto') {
      this.setupHighlight(this.opts.language ?? null);
    } else if (lang === '') {
      this.hlLang = null;
    } else {
      this.hlLang = hasHighlight(lang, this.size) ? lang : null;
    }
    this.hlSpanMap = null;
    this.hlCacheKey = '';
    this.renderedKey = '';
    void this.fill();
    this.reportStatus();
  }

  /** 滚动容器（供列标记覆盖层同步横向滚动，007 规则 9） */
  get scrollEl(): HTMLDivElement {
    return this.scroller;
  }

  destroy(): void {
    this.destroyed = true;
    this.stopFollow();
    if (this.scrollReportRaf) cancelAnimationFrame(this.scrollReportRaf);
    this.scrollReportRaf = 0;
    if (this.mmFetchTimer) clearTimeout(this.mmFetchTimer);
    this.mmFetchTimer = null;
    this.mmPendingLines.clear();
    this.unlisten?.();
    this.minimap?.remove();
    this.minimap = null;
  }

  private buildDom(): void {
    this.host.innerHTML = '';
    this.scroller = document.createElement('div');
    this.scroller.className = 'tv-scroller';
    this.scroller.style.setProperty('--tv-fs', `${this.fontSize}px`);
    this.sizer = document.createElement('div');
    this.sizer.className = 'tv-sizer';
    this.viewport = document.createElement('div');
    this.viewport.className = 'tv-viewport';
    this.sizer.appendChild(this.viewport);
    this.scroller.appendChild(this.sizer);

    // 统一查找栏 FindBar（002 规则 7 v2.6）：Rust 计数（第 N/共 M 处）+ 全部高亮三色；
    // 流式查看面无替换（002 规则 22 v2.6：▸ 引导随双模式删除，FindBar 不传 onRequestReplace 即隐藏 ▸）
    this.findBar = new FindBar({
      run: (needle, opts, dir, count, jump) => this.runFind(needle, opts, dir, count, jump),
      onHighlightAll: (needle, opts) => this.setFindNeedle(needle, opts.caseSensitive),
      onClosed: () => this.scroller.focus(),
    });

    // 跳转行栏（goto 专用）
    this.bar = document.createElement('div');
    this.bar.className = 'tv-bar';
    this.bar.style.display = 'none';
    this.barInput = document.createElement('input');
    this.barInput.className = 'tv-bar-input';
    this.barInput.placeholder = t('tv.gotoPlaceholder');
    this.bar.appendChild(this.barInput);
    this.barInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') void this.barAction();
      if (e.key === 'Escape') this.hideBar();
    });

    this.host.append(this.findBar.el, this.bar, this.scroller);
  }

  private async barAction(): Promise<void> {
    const v = this.barInput.value.trim();
    if (this.barMode === 'goto') {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= 1) await this.goToLine(n, undefined, true);
      this.hideBar();
    }
  }

  /** 统一查找栏执行器（查看态）：Rust text_find，环绕由本层实现；计数仅在正向扫描时请求 */
  private async runFind(
    needle: string,
    opts: FindOptions,
    dir: 1 | -1,
    count: boolean,
    jump: boolean
  ): Promise<FindRunResult> {
    const noCounts = { total: null, before: null };
    if (!needle || ['Docx', 'Pdf'].includes(this.opts.language ?? '')) return { hit: null, counts: noCounts };
    try {
      const base = this.findCurHit ?? this.currentLine();
      // 游标：命中行 L 之后，正向从 L+1 找（≥），反向从 L 找（<）；未命中过则以当前行为基准
      let r = dir === 1
        ? await textFind(this.path, needle, opts, this.findCurHit != null ? base + 1 : base, count, false)
        : await textFind(this.path, needle, opts, this.findCurHit != null ? base : base + 1, false, true);
      if (!r.hit) {
        // 环绕：正向回文件头；反向取全文最后一个（超大 from_line）
        r = dir === 1
          ? await textFind(this.path, needle, opts, 1, false, false)
          : await textFind(this.path, needle, opts, Number.MAX_SAFE_INTEGER, false, true);
      }
      if (!r.hit) return { hit: null, counts: r.total != null ? r : noCounts };
      this.findCurHit = r.hit.line;
      this.findCurCol = r.hit.col;
      if (jump) await this.goToLine(r.hit.line, r.hit.col, false);
      return { hit: r.hit, counts: r.total != null ? r : noCounts };
    } catch {
      // INDEXING / 读取失败等：不跳转不计数
      return { hit: null, counts: noCounts };
    }
  }

  private showBar(mode: 'goto'): void {
    this.barMode = mode;
    this.bar.style.display = 'flex';
    this.barInput.value = '';
    this.barInput.focus();
  }

  private hideBar(): void {
    this.barMode = null;
    this.bar.style.display = 'none';
    this.scroller.focus();
  }

  /** shell 菜单/工具栏接线入口（chrome：查找与跳转动作）；seed=选词回填（R6 IR Ctrl+F） */
  openFindBar(seed = ''): void {
    this.findCurHit = null;
    this.findCurCol = null;
    this.findBar.show(seed);
  }

  /** F3/Shift+F3（002 规则 7 v2.4）：栏未开时先打开（不自动跳，无词可跳），已开时步进 */
  findStep(dir: 1 | -1): void {
    if (!this.findBar.visible) {
      this.openFindBar();
      return;
    }
    void this.findBar.go(dir);
  }

  openGotoBar(): void {
    this.showBar('goto');
  }

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      this.openFindBar();
    } else if (e.ctrlKey && (e.key === 'g' || e.key === 'G')) {
      e.preventDefault();
      this.showBar('goto');
    } else if (e.ctrlKey && e.key === 'F2') {
      e.preventDefault();
      this.toggleBookmark(this.currentLine());
    } else if (e.key === 'F2') {
      this.nextBookmark();
    } else if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      this.historyBack();
    } else if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      this.historyForward();
    } else if (e.key === 'Escape') {
      if (this.rectSel) this.clearRectSelection();
      this.hideBar();
    }
    // v2.6 起流式查看面不可编辑：Alt+C 进列模式与键入即编辑入口随双模式删除（002 规则 7a/7b）
  }

  /** 当前查找词（M6-3 字符级命中高亮；P1-2 起命中行弱底 + 词强色 + 当前第三色） */
  setFindNeedle(needle: string, caseSensitive: boolean): void {
    this.findNeedle = needle;
    this.findCase = caseSensitive;
    if (!needle) {
      this.findCurHit = null;
      this.findCurCol = null;
    }
    this.render(true);
  }

  private findNeedle = '';
  private findCase = false;
  /** 当前命中列（runFind 命中时记录，renderLineHtml 标 current 第三色；P1-2） */
  private findCurCol: number | null = null;

  private lineFindRanges(text: string): Array<{ from: number; to: number }> {
    if (!this.findNeedle) return [];
    const hay = this.findCase ? text : text.toLowerCase();
    const ned = this.findCase ? this.findNeedle : this.findNeedle.toLowerCase();
    const out: Array<{ from: number; to: number }> = [];
    let idx = 0;
    while ((idx = hay.indexOf(ned, idx)) !== -1) {
      out.push({ from: idx, to: idx + ned.length });
      idx += ned.length;
    }
    return out;
  }

  /** 行 n 的矩形选区字符区间（钳到行内实际长度；005 规则 13） */
  private lineRectRanges(n: number, text: string): Array<{ from: number; to: number }> {
    if (!this.rectSel) return [];
    const { fromLine, toLine, colStart, colEnd } = rectSpanOfCells(
      { line: this.rectSel.lineA, cell: this.rectSel.colA }, { line: this.rectSel.lineB, cell: this.rectSel.colB }
    );
    if (n < fromLine || n > toLine) return [];
    // 005-03（审计 2026-10-17）：rectSel 的列来自 posAt 的像素格（视觉列，CJK 占 2 格）——
    // 修前直接当字符索引用，CJK 行拖拽高亮相对拖拽轨迹右移错位；按本行文本映射到字符边界。
    if (colStart >= visualWidth(text)) return [];
    const a = charAtVisualCol(text, colStart);
    const b = charAtVisualCol(text, colEnd);
    return [{ from: Math.min(a, b), to: Math.max(a, b) }];
  }

  private onWheel(e: WheelEvent): void {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, this.fontSize - Math.sign(e.deltaY)));
    if (next !== this.fontSize) {
      this.setFontSize(next);
      this.opts.onFontSize?.(next);
    }
  }

  /** 设置字号（菜单/设置入口；滚轮路径经 onWheel 后也走这里保持一致） */
  setFontSize(n: number): void {
    const v = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
    if (v === this.fontSize) return;
    this.fontSize = v;
    this.charW = 0; // 字号变化后重测字符宽（矩形选区列定位用）
    this.scroller?.style.setProperty('--tv-fs', `${v}px`);
    this.render(true);
  }

  // ---- 书签（002 规则 9）----
  private toggleBookmark(line: number): void {
    if (this.bookmarks.has(line)) this.bookmarks.delete(line);
    else this.bookmarks.add(line);
    this.sortedBookmarksCache = null;
    this.opts.onBookmarksChange(this.path, this.sortedBookmarks());
    this.render(true);
    this.reportStatus();
  }

  nextBookmark(): void {
    const cur = this.currentLine();
    const sorted = this.sortedBookmarks();
    if (sorted.length === 0) return;
    const next = sorted.find(b => b > cur) ?? sorted[0];
    void this.goToLine(next, undefined, true);
  }

  prevBookmark(): void {
    const cur = this.currentLine();
    const asc = this.sortedBookmarks();
    if (!asc.length) return;
    // 升序缓存复用：从尾向前找第一个小于当前行的书签（等价原降序 find）；
    // 无更小书签时环绕到最大书签（等价原降序数组首元素）
    let target = asc[asc.length - 1];
    for (let i = asc.length - 1; i >= 0; i--) {
      if (asc[i] < cur) { target = asc[i]; break; }
    }
    void this.goToLine(target, undefined, true);
  }

  // ---- 位置历史（002 规则 14）----
  private pushHistory(line: number): void {
    this.history = this.history.slice(0, this.hIndex + 1);
    if (this.history[this.history.length - 1] !== line) {
      this.history.push(line);
      if (this.history.length > HISTORY_MAX) this.history.shift();
      this.hIndex = this.history.length - 1;
    }
  }

  private historyBack(): void {
    if (this.hIndex > 0) {
      this.hIndex -= 1;
      void this.goToLine(this.history[this.hIndex], undefined, false);
    }
  }

  private historyForward(): void {
    if (this.hIndex < this.history.length - 1) {
      this.hIndex += 1;
      void this.goToLine(this.history[this.hIndex], undefined, false);
    }
  }

  // ---- 日志跟随（002 规则 17，tail -f 语义）----
  toggleFollow(): void {
    if (this.opts.language === 'Docx' || this.opts.language === 'Pdf') return;
    if (this.follow) {
      this.stopFollow();
    } else {
      this.follow = true;
      this.followTimer = setInterval(() => void this.followTick(), FOLLOW_POLL_MS);
      void this.followTick();
    }
    this.reportStatus();
  }

  private stopFollow(): void {
    this.follow = false;
    if (this.followTimer) {
      clearInterval(this.followTimer);
      this.followTimer = null;
    }
  }

  private async followTick(): Promise<void> {
    if (this.destroyed) return;
    try {
      const r = await textRefresh(this.path);
      if (r.changed) {
        this.size = r.len;
        this.indexing = true;
        this.reportStatus();
      }
    } catch {
      /* 文件暂时不可读：跳过本轮 */
    }
  }

  private currentLine(): number {
    return this.realOfDisp(Math.floor(this.scroller.scrollTop / LINE_HEIGHT));
  }

  async goToLine(line: number, _col?: number, record = false): Promise<void> {
    const clamped = Math.max(1, line);
    if (record) this.pushHistory(this.currentLine());
    await this.ensureFoldMap();
    if (this.foldEligible && !this.foldReady) await this.ensureFoldMap();
    await this.fillAround(clamped);
    const disp = this.dispOfReal(clamped);
    this.scroller.scrollTop = Math.max(0, disp * LINE_HEIGHT - this.scroller.clientHeight / 3);
    this.render(true);
    this.reportStatus();
  }

  private updateSizer(): void {
    const est = this.indexing ? Math.max(1, Math.floor(this.size / 80)) : this.dispCount;
    this.sizer.style.height = `${Math.max(1, est) * LINE_HEIGHT}px`;
  }

  private onScroll(): void {
    this.scheduleFill();
    this.scheduleScrollReport();
    if (Math.abs(this.scroller.scrollTop - this.lastReportedScroll) > 200) {
      this.lastReportedScroll = this.scroller.scrollTop;
      this.opts.onScrollPersist(this.path, this.scroller.scrollTop);
    }
  }

  /** 滚动上报 rAF 合并：scroll 事件每帧至多触发一次
   *  reportStatus + minimap.sync；scheduleFill 自带 filling/pending 调度机制，不在此动。 */
  private scheduleScrollReport(): void {
    if (this.scrollReportRaf) return;
    this.scrollReportRaf = requestAnimationFrame(() => {
      this.scrollReportRaf = 0;
      if (this.destroyed) return;
      this.reportStatus();
      this.minimap?.sync();
    });
  }

  /** bookmarks 升序数组（缓存；set 变化处负责失效，另带 size 兜底——直接替换字段等旁路写入也能自愈） */
  private sortedBookmarks(): number[] {
    if (this.sortedBookmarksCache && this.sortedBookmarksCache.length === this.bookmarks.size) {
      return this.sortedBookmarksCache;
    }
    return (this.sortedBookmarksCache = [...this.bookmarks].sort((a, b) => a - b));
  }

  private scheduleFill(): void {
    if (this.filling) {
      this.pendingFill = true;
      return;
    }
    this.filling = true;
    void this.fill().finally(() => {
      this.filling = false;
      if (this.pendingFill) {
        this.pendingFill = false;
        this.scheduleFill();
      }
    });
  }

  private async fill(): Promise<void> {
    const revision = this.encodingRevision;
    // 折叠地图不阻塞首屏（性能整改：idle 构建，完成后补一次 sizer/fill）
    if (this.foldEligible && !this.foldReady) this.scheduleFoldMap();
    const { from, to } = visibleRange(
      this.scroller.scrollTop,
      this.scroller.clientHeight,
      this.indexing ? Math.max(1, Math.floor(this.size / 80)) : this.dispCount
    );
    if (this.indexing) return;
    // 显示窗口 → 真实行集合（折叠时是离散子集）
    const realLines: number[] = [];
    for (let d = from - 1; d <= to - 1; d++) {
      const real = this.realOfDisp(d);
      if (realLines[realLines.length - 1] !== real) realLines.push(real);
    }
    const missing: Array<[number, number]> = [];
    let start = 0;
    for (const n of realLines) {
      if (!this.lines.has(n)) {
        if (!start) start = n;
      } else if (start) {
        missing.push([start, n - 1]);
        start = 0;
      }
    }
    if (start) missing.push([start, realLines[realLines.length - 1]]);
    for (const [a, b] of missing) {
      for (let x = a; x <= b;) {
        const hi = Math.min(b, x + FETCH_BATCH - 1);
        try {
          const got = await this.fetchLines(this.path, x, hi, this.encoding);
          if (this.destroyed || revision !== this.encodingRevision) return;
          if (!got.length) break;
          for (const l of got) this.lines.set(l.no, l.text);
          x = got[got.length - 1]!.no + 1;
          if (this.lines.trimToBudget(this.currentLine())) this.cacheVersion++;
          this.cacheVersion++;
        } catch (err) {
          if (this.destroyed || revision !== this.encodingRevision) return;
          if (String(err).includes('INDEXING')) return;
          if (String(err).includes('LINE_WINDOW_TOO_LARGE')) {
            const segment = await this.fetchLongLine(x, 0, revision);
            if (segment) {
              x++;
              continue;
            }
          }
          this.viewport.textContent = tf('err.readFail', String(err));
          return;
        }
      }
    }
    this.render();
  }

  private async fillAround(line: number): Promise<void> {
    if (this.lines.has(line) || this.longLines.has(line)) return;
    const revision = this.encodingRevision;
    try {
      const got = await this.fetchLines(this.path, Math.max(1, line - 40), line + 40, this.encoding);
      if (this.destroyed || revision !== this.encodingRevision) return;
      for (const l of got) this.lines.set(l.no, l.text);
      this.cacheVersion++;
    } catch (err) {
      if (String(err).includes('LINE_WINDOW_TOO_LARGE')) await this.fetchLongLine(line, 0, revision);
      /* 索引中则忽略 */
    }
  }

  /** 加载超长单行的一个有界片段；行号仍保持真实行号，片段只改变行内横向内容。 */
  private async fetchLongLine(line: number, offset: number, revision = this.encodingRevision): Promise<LongLineState | null> {
    try {
      const got = await textLineSegment(this.path, line, offset, LONG_LINE_SEGMENT_BYTES, this.encoding);
      if (this.destroyed || revision !== this.encodingRevision) return null;
      const state: LongLineState = {
        offset: got.offset,
        nextOffset: got.nextOffset,
        totalBytes: got.totalBytes,
        text: got.text,
      };
      this.longLines.delete(line);
      this.longLines.set(line, state);
      // 保留少量最近片段，防止反复跳转时单独的长行缓存绕过总预算。
      while (this.longLines.size > 8) this.longLines.delete(this.longLines.keys().next().value!);
      this.lines.set(line, state.text);
      if (this.lines.trimToBudget(this.currentLine())) this.cacheVersion++;
      this.longLineVersion++;
      this.cacheVersion++;
      this.render(true);
      return state;
    } catch {
      return null;
    }
  }

  /** 手动切换编码（002 规则 1：覆盖自动结果，清缓存重取） */
  setEncoding(name: string): void {
    if (this.opts.language === 'Docx' || this.opts.language === 'Pdf') return;
    const revision = ++this.encodingRevision;
    this.encoding = name;
    this.encodingSource = 'manual';
    this.lines.clear();
    this.longLines.clear();
    this.longLineVersion++;
    this.cacheVersion++;
    this.hlCacheKey = '';
    this.indexing = true;
    this.foldReady = false;
    this.headings.clear();
    this.folded.clear();
    this.dispLines = null;
    void textOpen(this.path, name).then(info => {
      if (this.destroyed || revision !== this.encodingRevision) return;
      this.totalLines = info.totalLines;
      this.newline = info.newline;
      this.indexing = !info.indexReady;
      this.updateSizer();
      this.reportStatus();
      void this.fill();
    }).catch(error => {
      if (this.destroyed || revision !== this.encodingRevision) return;
      this.indexing = false;
      this.viewport.textContent = tf('err.readFail', String(error));
      this.reportStatus();
    });
    this.reportStatus();
  }

  /** 缩略图采样行预取（002 规则 23 v1.4）：未缓存的采样行分批小窗拉取，绝不整文件读入 */
  private mmPendingLines = new Set<number>();
  private mmFetchTimer: ReturnType<typeof setTimeout> | null = null;
  mmRequestLines(from: number, to: number): void {
    if (this.indexing || this.destroyed) return;
    // 大文件只对窗口附近渐进采样：采样总量 ≤400 行，超阈值文件（>50 万行）跳过预取，保持中性条
    if (this.totalLines > 500_000) return;
    // T002-04：字节预算耗尽即停预取（采样条回落中性宽度）；视口填充不受此限
    if (!this.lines.hasBudget()) return;
    for (let n = from; n <= to; n++) {
      if (!this.lines.has(n)) this.mmPendingLines.add(n);
    }
    if (this.mmFetchTimer || this.mmPendingLines.size === 0) return;
    this.mmFetchTimer = setTimeout(() => void this.mmFetchTick(), 400);
  }

  private async mmFetchTick(): Promise<void> {
    const revision = this.encodingRevision;
    this.mmFetchTimer = null;
    if (this.destroyed || this.indexing) { this.mmPendingLines.clear(); return; }
    const batch: number[] = [];
    for (const n of this.mmPendingLines) {
      batch.push(n);
      if (batch.length >= 24) break;
    }
    for (const n of batch) this.mmPendingLines.delete(n);
    try {
      for (const n of batch) {
        if (this.lines.has(n)) continue;
        const got = await this.fetchLines(this.path, n, n, this.encoding);
        if (this.destroyed || revision !== this.encodingRevision) return;
        for (const l of got) this.lines.set(l.no, l.text);
      }
      if (batch.length) this.cacheVersion++;
      if (this.lines.trimToBudget(this.currentLine())) this.cacheVersion++;
      if (!this.lines.hasBudget()) { this.mmPendingLines.clear(); return; } // 预算尽：停续批
    } catch {
      /* 采样行读取失败：保持中性条，不阻断主流程 */
    }
    if (this.mmPendingLines.size > 0) {
      this.mmFetchTimer = setTimeout(() => void this.mmFetchTick(), 400);
    }
  }

  private render(force = false): void {
    // 每次渲染对齐 sizer 高度（D3 修复：与 totalLines/dispCount 恒同步，跳行/滚动不再被钳制）
    this.updateSizer();
    const { from, to } = visibleRange(
      this.scroller.scrollTop,
      this.scroller.clientHeight,
      Math.max(1, this.dispCount)
    );
    const key = `${from}-${to}-${this.totalLines}-${this.encoding}-${this.fontSize}-${this.folded.size}-${this.longLineVersion}`;
    if (!force && key === this.renderedKey) return;
    this.renderedKey = key;
    const realWindow: number[] = [];
    for (let d = from - 1; d <= to - 1; d++) {
      const real = this.realOfDisp(d);
      if (realWindow[realWindow.length - 1] !== real) realWindow.push(real);
    }
    this.updateHighlight(realWindow);
    this.minimap?.sync();
    const frag = document.createDocumentFragment();
    for (const n of realWindow) {
      const long = this.longLines.get(n);
      const text = long?.text ?? this.lines.get(n) ?? '';
      const row = document.createElement('div');
      row.className = 'tv-row' + (long ? ' tv-long' : '') + (this.findNeedle && this.lineFindRanges(text).length > 0 ? ' hit' : '');
      const ln = document.createElement('span');
      const isHeading = this.headings.has(n);
      ln.className = 'tv-ln' + (this.bookmarks.has(n) ? ' bm' : '') + (isHeading ? ' foldable' : '');
      ln.textContent = (isHeading ? (this.folded.has(n) ? '▸' : '▾') : '') + String(n);
      ln.title = this.bookmarks.has(n)
        ? t('tv.bookmark')
        : isHeading
          ? t('tv.foldToggle')
          : '';
      if (isHeading) ln.addEventListener('click', () => this.toggleFold(n));
      const tx = document.createElement('span');
      tx.className = 'tv-tx';
      const spans = this.hlLang ? this.hlSpanMap?.get(n) : undefined;
      tx.innerHTML = renderLineHtml(
        text,
        spans,
        this.findNeedle ? this.lineFindRanges(text) : undefined,
        this.invisibleOn,
        this.rectSel ? this.lineRectRanges(n, text) : undefined,
        this.findNeedle && this.findCurHit === n && this.findCurCol != null ? this.findCurCol : undefined
      );
      // 002 规则 10（v2.8 W2 清偿）：行号可关——关时藏行号元素（CSS .tv-noln），文本占满行
      if (!this.showLn) ln.style.display = 'none';
      row.append(ln, tx);
      if (long) {
        const controls = document.createElement('span');
        controls.className = 'tv-long-controls';
        controls.title = `${long.offset}-${Math.min(long.totalBytes, long.offset + text.length)} / ${long.totalBytes}`;
        if (long.offset > 0) {
          const prev = document.createElement('button');
          prev.type = 'button';
          prev.className = 'tv-long-btn';
          prev.textContent = '‹';
          prev.title = '上一段';
          prev.setAttribute('aria-label', '上一段');
          prev.addEventListener('click', e => {
            e.stopPropagation();
            void this.fetchLongLine(n, Math.max(0, long.offset - LONG_LINE_SEGMENT_BYTES));
          });
          controls.appendChild(prev);
        }
        if (long.nextOffset !== null) {
          const next = document.createElement('button');
          next.type = 'button';
          next.className = 'tv-long-btn';
          next.textContent = '›';
          next.title = '下一段';
          next.setAttribute('aria-label', '下一段');
          next.addEventListener('click', e => {
            e.stopPropagation();
            void this.fetchLongLine(n, long.nextOffset!);
          });
          controls.appendChild(next);
        }
        row.appendChild(controls);
      }
      frag.appendChild(row);
    }
    this.viewport.style.transform = `translateY(${(from - 1) * LINE_HEIGHT}px)`;
    this.viewport.replaceChildren(frag);
  }

  /** 窗口级高亮（决策 004 降级路径：可视区接管，Lezer 解析窗口文本；按行映射支持折叠空洞） */
  private hlVer = 0;
  private updateHighlight(realWindow: number[]): void {
    if (!this.hlLang) {
      this.hlLoadSeq++;
      this.hlLoadLang = null;
      this.hlSpanMap = null;
      return;
    }
    const language = this.hlLang;
    const key = `${language}|${realWindow.join('-')}`;
    if (key === this.hlCacheKey) return;
    if (hasHighlightParser(language) && !getParser(language)) {
      this.hlSpanMap = null;
      this.hlCacheKey = key;
      if (this.hlLoadLang !== language) {
        const seq = ++this.hlLoadSeq;
        this.hlLoadLang = language;
        void loadHighlightParser(language).then(parser => {
          if (this.hlLoadSeq !== seq) return;
          this.hlLoadLang = null;
          if (!parser || this.destroyed || this.hlLang !== language) return;
          this.hlCacheKey = '';
          this.renderedKey = '';
          void this.fill();
        }).catch(err => {
          if (this.hlLoadSeq !== seq) return;
          this.hlLoadLang = null;
          this.hlCacheKey = '';
          this.renderedKey = '';
          console.warn('语法高亮语言加载失败', language, err);
        });
      }
      return;
    }
    this.hlLoadSeq++;
    this.hlLoadLang = null;
    const texts = realWindow.map(n => this.lines.get(n) ?? '');
    const spansArr = highlightLines(texts, language);
    this.hlSpanMap = new Map(realWindow.map((n, i) => [n, spansArr[i]]));
    this.hlCacheKey = key;
    this.hlVer++; // 缩略图分段重建信号（v1.4）
  }

  private reportStatus(): void {
    this.opts.onStatus({
      rect: this.rectSize,
      encoding: this.encoding,
      encodingSource: this.encodingSource,
      newline: this.newline,
      size: this.size,
      totalLines: this.totalLines,
      visibleLine: this.currentLine(),
      indexing: this.indexing,
      follow: this.follow,
      bookmarks: this.sortedBookmarks(),
      highlighted: !!this.hlLang,
      language: this.hlLang,
    });
  }

  /** 行缓存版本（缩略图增量刷新依据） */
  get linesVersion(): number {
    return this.cacheVersion;
  }
}
