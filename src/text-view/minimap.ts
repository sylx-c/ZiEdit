// minimap —— 缩略图导航条（002 规则 23 v1.4：按文档结构排列）
// 编辑行 flex 兄弟：[mm-resize][minimap][vscroll]；宽度 clamp 随窗口、拖拽后持久化（ZiEdit-mm-w）。
// 每根条按该行真实结构渲染：前导空白 → 缩进偏移；行内语法分段 → 逐段着色（tok-* 类随主题取 --syn-* 色，
// 与编辑区同源）。数据合规（性能红线）：已缓存行直接取；采样行经 requestLines 让视图分批小窗预取，
// 绝不整文件读入；未取到前画中性短条。渲染面通过适配器采样排版坐标，源码按行定位。
// 卸载清理：document 级监听全部登记，remove() 统一卸载（修复切换标签累积泄漏）。
import { t } from '../common/i18n';
import { RailScrollAnimator } from '../common/smooth-scroll';
import type { ScrollSurfaceAdapter, ScrollLayoutSnapshot, OverviewSample } from '../common/scroll-surface';

/** 语法分段（与 highlight.ts 的 Span 同构：字符区间 + tok-* 类名） */
export interface MmSpan {
  from: number;
  to: number;
  cls: string;
}

export interface MinimapAdapter {
  /** 渲染面：地图、视口框、滑块共用排版快照；源码保持原行采样协议。 */
  surface?: ScrollSurfaceAdapter;
  scrollTop(): number;
  scrollHeight(): number;
  clientHeight(): number;
  scrollTo(y: number): void;
  totalLines(): number;
  /** 显示行号（1-based，含折叠语义）→ 真实行号；缺省恒等 */
  realLineOf?(dispLine: number): number;
  /** 已缓存的行文本（无则 undefined） */
  lineText(realLine: number): string | undefined;
  /** 已缓存行的语法分段（无高亮/未缓存时 undefined） */
  lineSpans?(realLine: number): MmSpan[] | undefined;
  /** 采样行未缓存时由视图分批预取（红线合规：小窗口逐行） */
  requestLines?(from: number, to: number): void;
  /** 点击定位到真实行（走 goToLine 行锚点）；缺省退化为 scrollTo 像素比例 */
  goToLine?(realLine: number): void;
  /** 只滚动不动光标：把真实行滚到视口中央（优先于 goToLine——地图是导航，不是编辑） */
  scrollToLine?(realLine: number): void;
  /** 源码行采样适配器的显示行区间（1 起，可含小数）；surface 存在时统一按排版像素。 */
  visibleLines?(): { first: number; last: number } | null;
  /** 行缓存版本（变化时才重建密度条；缺省每次重建） */
  cacheVersion?(): number;
  /** 语法分段版本（高亮窗口变化时重建分段着色；缺省 0） */
  spansVersion?(): number;
  /** 滚动内容盒元素：IR/预览的延迟渲染会在没有 scroll 事件的情况下改变内容高度，
   *  依赖它补一次滚动条/视口框重同步；缺省不监听（纯文本视图高度稳定，fill 路径自带 sync）。 */
  contentElement?(): HTMLElement | null;
}

const MIN_W = 64;
const MAX_W = 320;
const STORE_KEY = 'ZiEdit-mm-w';
const BAR_H = 2;
// 走查增强 2026-10-28:条距 2→1(槽位 4px→3px),1 行 1 条的覆盖范围 ~171→~228 行
const BAR_GAP = 1;
/** 满宽映射的字符数（行长压缩下限：更长行封顶满宽） */
const FULL_COLS = 150;
/** 缩进偏移封顶（预留右侧有效长度） */
const MAX_INDENT = 55;

export class Minimap {
  readonly root: HTMLElement;
  private barsHost: HTMLElement;
  private viewportEl: HTMLElement;
  private resizeEl: HTMLElement;
  private vscrollEl: HTMLElement;
  private thumbEl: HTMLElement;
  private dragScrolling = false;
  private dragMoved = false;
  /** 按住后已移动（真正的拖动，单击不算）：宿主据此把地图驱动的滚动登记为用户连续滚动 */
  get isDragging(): boolean { return this.dragScrolling && this.dragMoved; }
  private detachers: Array<() => void> = [];
  private barState: Array<{ line: number; text: string | null; spans?: MmSpan[]; kind?: string; paint?: string }> = [];
  private heightRo: ResizeObserver | null = null;
  private heightRoRaf = 0;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private themeObserver: MutationObserver | null = null;
  private palette: string[] | null = null;
  private readonly railAnimator = new RailScrollAnimator(y => this.adapter.scrollTo(y), () => this.adapter.scrollTop());

  constructor(
    parent: HTMLElement,
    private adapter: MinimapAdapter
  ) {
    this.resizeEl = document.createElement('div');
    this.resizeEl.className = 'mm-resize';
    this.resizeEl.title = t('mm.resizeTitle');
    this.root = document.createElement('div');
    this.root.className = 'minimap';
    this.root.setAttribute('aria-hidden', 'true');
    this.barsHost = document.createElement('div');
    this.barsHost.className = 'mm-bars';
    if (adapter.surface && typeof CanvasRenderingContext2D !== 'undefined') {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (context) {
        this.canvas = canvas; this.context = context;
        canvas.className = 'mm-canvas'; this.barsHost.append(canvas);
        this.themeObserver = new MutationObserver(() => {
          this.palette = null; this.barsVersion = '';
          if (!this.heightRoRaf) this.heightRoRaf = requestAnimationFrame(() => { this.heightRoRaf = 0; this.sync(); });
        });
        this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-tone'] });
      }
    }
    this.viewportEl = document.createElement('div');
    this.viewportEl.className = 'mm-viewport';
    this.root.append(this.barsHost, this.viewportEl);
    this.vscrollEl = document.createElement('div');
    this.vscrollEl.className = 'vscroll';
    this.thumbEl = document.createElement('div');
    this.thumbEl.className = 'vs-thumb';
    this.vscrollEl.appendChild(this.thumbEl);
    // 布局定稿(2026-10-28 深夜终版,不再变更):[文本][滚动条(昨天原版样式)][分隔线][小地图]
    parent.append(this.vscrollEl, this.resizeEl, this.root);

    const saved = localStorage.getItem(STORE_KEY);
    if (saved) this.root.style.width = `${saved}px`;

    // 内容高度变化补同步：延迟渲染块（IR/预览）在 scroll 事件之后才改变内容高度，
    // 纯高度变化没有滚动事件，thumb/视口框会一直按旧高度计算（实测 mid 视口偏差 30px+）。
    // RO 监听内容盒，rAF 合并补一次 sync；无 contentElement 或无 RO（jsdom）时跳过。
    const contentEl = this.adapter.contentElement?.();
    if (contentEl && typeof ResizeObserver !== 'undefined') {
      this.heightRo = new ResizeObserver(() => {
        if (this.heightRoRaf) return;
        this.heightRoRaf = requestAnimationFrame(() => {
          this.heightRoRaf = 0;
          this.sync();
        });
      });
      this.heightRo.observe(contentEl);
    }

    // document 级监听统一登记，remove() 时卸载（修复泄漏）
    const onDoc = (ev: 'mousemove' | 'mouseup', fn: (e: MouseEvent) => void): void => {
      document.addEventListener(ev, fn);
      this.detachers.push(() => document.removeEventListener(ev, fn));
    };

    // 点击/拖动跳转：按行号比例 → goToLine 行锚点（v1.4：不再按像素分数盲跳）
    const jump = (e: MouseEvent) => {
      const r = this.root.getBoundingClientRect();
      const inset = this.topInset();
      const ratio = Math.min(1, Math.max(0, (e.clientY - r.top - inset) / Math.max(1, r.height - inset - 10)));
      if (this.adapter.surface) {
        const layout = this.adapter.surface.snapshot();
        this.adapter.scrollTo(Math.max(0, ratio * layout.height - layout.viewport / 2));
        return;
      }
      if (this.adapter.scrollToLine || this.adapter.goToLine) {
        const dispTotal = Math.max(1, this.adapter.totalLines());
        const dispLine = Math.max(1, Math.round(ratio * dispTotal));
        const real = this.adapter.realLineOf?.(dispLine) ?? dispLine;
        if (this.adapter.scrollToLine) this.adapter.scrollToLine(real);
        else this.adapter.goToLine!(real);
      } else {
        this.adapter.scrollTo(ratio * (this.adapter.scrollHeight() - this.adapter.clientHeight()));
      }
    };
    this.root.addEventListener('mousedown', e => {
      this.railAnimator.cancel();
      this.dragScrolling = true;
      this.dragMoved = false;
      jump(e);
    });
    onDoc('mousemove', e => {
      if (!this.dragScrolling) return;
      this.dragMoved = true;
      jump(e);
    });
    onDoc('mouseup', () => (this.dragScrolling = false));

    // 滚轮转发到主滚动区（minimap / 分隔条 / 滚动条轨道）
    for (const el of [this.root, this.resizeEl, this.vscrollEl]) {
      el.addEventListener(
        'wheel',
        e => {
          e.preventDefault();
          // deltaMode：0=像素 1=行 2=页（部分鼠标驱动按行上报，修前当像素用，一格只滚 3px）
          const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.adapter.clientHeight() : 1;
          this.railAnimator.cancel();
          this.adapter.scrollTo(this.adapter.scrollTop() + e.deltaY * unit);
        },
        { passive: false }
      );
    }

    // 宽度拖拽 / 双击复位
    let resizing: { x: number; w: number } | null = null;
    this.resizeEl.addEventListener('mousedown', e => {
      resizing = { x: e.clientX, w: this.root.offsetWidth };
      this.resizeEl.classList.add('drag');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    });
    onDoc('mousemove', e => {
      if (!resizing) return;
      this.root.style.width = `${Math.min(MAX_W, Math.max(MIN_W, resizing.w - (e.clientX - resizing.x)))}px`;
      this.sync();
    });
    onDoc('mouseup', () => {
      if (!resizing) return;
      resizing = null;
      this.resizeEl.classList.remove('drag');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(STORE_KEY, String(this.root.offsetWidth));
    });
    this.resizeEl.addEventListener('dblclick', () => {
      this.root.style.width = '';
      localStorage.setItem(STORE_KEY, '');
      this.sync();
    });

    // 自绘滚动条：拇指拖拽 + 轨道翻页（行程与视口框同几何：top ∈ [inset, railH-10-h]）
    // 行程与可滚总量逐次实时取：渲染类视图拖动途中内容高度持续纠正（估计→实测），
    // 修前按按下时的快照换算，拖到后半程滑块与鼠标脱节、松手位置跳变。
    let thumbDrag: { y: number; top: number; inset: number } | null = null;
    this.thumbEl.addEventListener('mousedown', e => {
      this.railAnimator.cancel();
      thumbDrag = { y: e.clientY, top: this.thumbEl.offsetTop, inset: this.topInset() };
      this.thumbEl.classList.add('drag');
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    });
    onDoc('mousemove', e => {
      if (!thumbDrag) return;
      const range = Math.max(0, this.vscrollEl.clientHeight - thumbDrag.inset - 10 - this.thumbEl.offsetHeight);
      if (range <= 0) return;
      const lo = thumbDrag.inset;
      const top = Math.min(lo + range, Math.max(lo, thumbDrag.top + (e.clientY - thumbDrag.y)));
      const layout = this.adapter.surface?.snapshot();
      const total = Math.max(0, (layout?.height ?? this.adapter.scrollHeight()) - (layout?.viewport ?? this.adapter.clientHeight()));
      this.adapter.scrollTo(total * ((top - lo) / range));
    });
    onDoc('mouseup', () => {
      if (!thumbDrag) return;
      thumbDrag = null;
      this.thumbEl.classList.remove('drag');
      document.body.style.userSelect = '';
    });
    this.vscrollEl.addEventListener('mousedown', e => {
      if (e.target !== this.vscrollEl) return;
      const dir = e.clientY > this.thumbEl.offsetTop + this.thumbEl.offsetHeight ? 1 : -1;
      this.railAnimator.page(dir * this.adapter.clientHeight() * 0.9, this.adapter.scrollTop());
    });
  }

  setVisible(v: boolean): void {
    for (const el of [this.root, this.resizeEl, this.vscrollEl]) el.style.display = v ? '' : 'none';
  }

  /** 视图暂存（切标签保留视图）：三件套移出编辑行，监听与状态保留，attach 后原样恢复 */
  detach(): void {
    this.railAnimator.cancel();
    this.vscrollEl.remove();
    this.resizeEl.remove();
    this.root.remove();
  }

  attach(parent: HTMLElement): void {
    parent.append(this.vscrollEl, this.resizeEl, this.root);
    requestAnimationFrame(() => this.sync());
  }

  /** 视图卸载时从编辑行移除三件套并卸载全部 document 监听 */
  remove(): void {
    this.railAnimator.cancel();
    if (this.heightRoRaf) cancelAnimationFrame(this.heightRoRaf);
    this.heightRoRaf = 0;
    this.heightRo?.disconnect();
    this.heightRo = null;
    this.themeObserver?.disconnect();
    for (const d of this.detachers) d();
    this.detachers = [];
    this.resizeEl.remove();
    this.root.remove();
    this.vscrollEl.remove();
  }

  /** TextView 渲染/滚动后调用：密度条仅在行缓存/行数/语法分段版本变化时重建；视口框与滚动条每次同步 */
  sync(): void {
    const h = this.root.clientHeight;
    if (h <= 0) return;
    const layout = this.adapter.surface?.snapshot();
    const total = layout ? Math.max(1, Math.ceil(layout.height / 20)) : this.adapter.totalLines();
    const inset = this.topInset();
    const width = this.canvas ? this.barsHost.clientWidth : 0;
    const dpr = this.canvas ? window.devicePixelRatio || 1 : 1;
    const version = `${this.adapter.cacheVersion?.() ?? -1}|${this.adapter.spansVersion?.() ?? 0}|${layout?.version ?? ''}|${layout?.height ?? ''}|${h}|${inset}|${width}|${dpr}`;
    const rebuild = version !== this.barsVersion || this.barsTotal !== total;
    const count = Math.max(1, Math.min(400, Math.floor((h - inset - 10) / (BAR_H + BAR_GAP)), total));
    // overview 会读取 CM 高度图和正文几何，必须先于滑块与条纹的任何 DOM 写入。
    const overview = rebuild && layout ? this.adapter.surface?.overview(count, layout) : undefined;
    if (rebuild && this.canvas && !this.palette) {
      const style = getComputedStyle(this.root);
      this.palette = ['--muted', '--accent', '--syn-cm', '--syn-ty'].map(name => style.getPropertyValue(name).trim());
    }
    this.syncViewport(layout);
    if (rebuild) {
      this.barsVersion = version;
      this.barsTotal = total;
      if (this.canvas && overview) this.paintCanvas(overview, width, Math.max(1, h - inset - 10), dpr);
      else this.rebuildBars(count, total, overview);
    }
  }

  private barsVersion = '';
  private barsTotal = -1;

  /** 阅读/IR 的结构缩略图共用一张画布，避免几何细化时修改数百个布局节点。 */
  private paintCanvas(samples: OverviewSample[], width: number, height: number, dpr: number): void {
    const canvas = this.canvas!, ctx = this.context!, palette = this.palette!;
    const pixelWidth = Math.max(1, Math.round(width * dpr)), pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < samples.length; i++) {
      const { text, kind = '' } = samples[i]!;
      const trimmed = text.replace(/[\r\n]+$/, '');
      const indent = Math.min(MAX_INDENT, this.leadCols(trimmed) * 100 / FULL_COLS);
      const length = trimmed.trim() ? indent + Math.min(100 - indent, Math.max(4, trimmed.length * 100 / FULL_COLS)) : 4;
      const y = samples.length > 1 ? i * (height - BAR_H) / (samples.length - 1) : 0;
      ctx.globalAlpha = .38; ctx.fillStyle = palette[0] || '#888';
      ctx.beginPath(); ctx.roundRect(0, y, width * length / 100, BAR_H, 1); ctx.fill();
      const color = /heading/i.test(kind) ? 1 : /code/i.test(kind) ? 2 : /list|table|image/i.test(kind) ? 3 : 0;
      if (color && trimmed.trim()) {
        ctx.globalCompositeOperation = 'source-atop'; ctx.globalAlpha = .55; ctx.fillStyle = palette[color] || '#888';
        ctx.fillRect(width * indent / 100, y, width * Math.min(100 - indent, text.length * 100 / FULL_COLS) / 100, BAR_H);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    ctx.globalAlpha = 1;
  }

  private rebuildBars(count: number, total: number, overview?: OverviewSample[]): void {
    // 短文档条数收敛到实际行数：1 行文件画 1 条（顶部）、3 行画 3 条——
    // 既不是满高重复同一行的致密条纹，也不是整列空白（反馈：短文件小地图一片空白像坏了）。
    if (this.barsHost.childElementCount !== count) {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < count; i++) {
        const b = document.createElement('span');
        b.className = 'mm-bar';
        frag.appendChild(b);
      }
      this.barsHost.replaceChildren(frag);
      this.barState = new Array(count);
    }
    const charW = 100 / FULL_COLS;
    const bars = this.barsHost.children;
    // 首个未缓存采样行区间 → 请求视图分批预取（空闲节流）
    let fetchFrom = 0;
    let fetchTo = 0;
    for (let i = 0; i < count; i++) {
      const dispLine = Math.max(1, Math.round(((i + 0.5) / count) * total));
      const real = this.adapter.realLineOf?.(dispLine) ?? dispLine;
      const text = overview ? overview[i]?.text ?? '' : this.adapter.lineText(real);
      if (text == null) {
        if (!fetchFrom) fetchFrom = real;
        fetchTo = real;
        const previous = this.barState[i];
        if (previous?.line === real && previous.text === null) continue;
        this.barState[i] = { line: real, text: null };
        const b = bars[i] as HTMLElement;
        b.className = 'mm-bar';
        b.style.width = '22%';
        b.replaceChildren();
        continue;
      }
      const kind = overview?.[i]?.kind ?? '';
      const cls = /heading/i.test(kind) ? 'mh' : /code/i.test(kind) ? 'mc' : /list|table|image/i.test(kind) ? 'ml' : '';
      const spans = overview ? (cls ? [{ from: 0, to: text.length, cls }] : undefined) : this.adapter.lineSpans?.(real);
      const previous = this.barState[i];
      if (previous && (overview || previous.line === real) && previous.text === text && (overview ? previous.kind === kind : previous.spans === spans)) continue;
      this.barState[i] = { line: real, text, spans, kind };
      const b = bars[i] as HTMLElement;
      const trimmed = text.replace(/[\r\n]+$/, '');
      if (!trimmed.trim()) {
        if (overview) {
          this.barState[i]!.paint = 'empty';
          if (previous?.paint === 'empty') continue;
          this.paintStructureBar(b, 4, '', 0, 0);
          continue;
        }
        // 空行：细短点，保留节奏感
        b.className = 'mm-bar';
        b.style.width = '4%';
        b.replaceChildren();
        continue;
      }
      const lead = this.leadCols(trimmed);
      const indent = Math.min(MAX_INDENT, lead * charW);
      const lenPct = Math.min(100 - indent, Math.max(4, trimmed.length * charW));
      if (overview) {
        const right = Math.min(100, indent + Math.min(Math.max(.5, text.length * charW), 100 - indent));
        const paint = (indent + lenPct) + '|' + cls + (cls ? '|' + indent + '|' + right : '');
        this.barState[i]!.paint = paint;
        if (previous?.paint === paint) continue;
        // 排版高度不断细化时采样会改变。结构条只更新绘制属性，避免修改宽度、
        // 替换色段后迫使下一次 CM 滚动测量再做整轮布局。
        this.paintStructureBar(b, indent + lenPct, cls, indent, right);
        continue;
      }
      b.className = 'mm-bar';
      b.style.width = `${indent + lenPct}%`;
      b.style.marginLeft = ''; // 缩进经 width 前缀表达（背景自左起）
      if (spans && spans.length) {
        // 语法分段着色：段宽按字符数映射，覆盖在基础条上方
        const frag = document.createDocumentFragment();
        for (const s of spans) {
          const seg = document.createElement('i');
          seg.className = 'mm-seg ' + s.cls;
          const w = Math.max(0.5, (s.to - s.from) * charW);
          seg.style.width = `${Math.min(w, 100 - indent)}%`;
          seg.style.left = `${indent + Math.min(s.from * charW, 100 - indent)}%`;
          frag.appendChild(seg);
        }
        b.replaceChildren(frag);
      } else {
        b.replaceChildren();
      }
    }
    if (fetchFrom && this.adapter.requestLines) {
      this.adapter.requestLines(fetchFrom, fetchTo);
    }
  }

  private paintStructureBar(bar: HTMLElement, width: number, cls: string, left: number, right: number): void {
    bar.className = 'mm-bar mm-structure' + (cls ? ' ' + cls : '');
    bar.style.width = '100%';
    bar.style.transform = `scaleX(${width / 100})`;
    bar.style.setProperty('--mm-left', `${left}%`);
    bar.style.setProperty('--mm-right', `${right}%`);
    if (bar.childElementCount) bar.replaceChildren();
  }

  /** 前导空白折算显示列（Tab 按 4 列） */
  private leadCols(text: string): number {
    let n = 0;
    for (const ch of text) {
      if (ch === ' ') n += 1;
      else if (ch === '\t') n += 4;
      else break;
    }
    return n;
  }

  private syncViewport(layout?: ScrollLayoutSnapshot): void {
    const sh = layout?.height ?? this.adapter.scrollHeight();
    const ch = layout?.viewport ?? this.adapter.clientHeight();
    // 滑块与视口框共用同一几何（2026-10-28 对齐定稿）：两者同挂 .editor-rail（等高），
    // 行程统一为 [inset, railH-10]；inset = 尺子可见 29（尺 19 + 留白 10）/ 隐藏 10（.no-ruler），
    // 标准滚动条映射（st/(sh-ch)）保证滚到顶/底时双双贴齐行程两端。
    const railH = this.vscrollEl.clientHeight || this.root.clientHeight;
    const inset = this.topInset();
    const inner = Math.max(40, railH - inset - 10);
    if (sh > ch + 1) {
      const h = Math.max(18, (ch / sh) * inner);
      const top = inset + Math.min(1, Math.max(0, (layout?.top ?? this.adapter.scrollTop()) / (sh - ch))) * (inner - h);
      // 渲染面直接使用同一快照；仅旧源码行采样适配器使用显示行区间。
      const lines = layout ? null : this.adapter.visibleLines?.();
      const total = Math.max(1, this.adapter.totalLines());
      let boxTop = top, boxH = h;
      if (lines) {
        const first = Math.min(total, Math.max(1, lines.first)), last = Math.min(total + 1, Math.max(first, lines.last));
        boxH = Math.max(18, ((last - first) / total) * inner);
        boxTop = inset + Math.min(inner - boxH, ((first - 1) / total) * inner);
      }
      this.viewportEl.classList.add('live');
      this.viewportEl.style.display = '';
      this.viewportEl.style.height = `${boxH}px`;
      this.viewportEl.style.top = `${boxTop}px`;
      this.viewportEl.style.bottom = 'auto';
      this.thumbEl.style.display = '';
      this.thumbEl.style.height = `${h}px`;
      this.thumbEl.style.top = `${top}px`;
    } else {
      // 无溢出：窗口==全文——滑块满行程、视口框满图，常在但不滑动（2026-10-28 用户定稿）
      this.viewportEl.classList.remove('live');
      this.viewportEl.style.display = '';
      this.viewportEl.style.height = '';
      this.viewportEl.style.top = '';
      this.viewportEl.style.bottom = '';
      this.thumbEl.style.display = '';
      this.thumbEl.style.height = `${inner}px`;
      this.thumbEl.style.top = `${inset}px`;
    }
  }

  /** 轨顶 inset：尺子可见 29（功能件起于尺子线下方），md/图等隐藏尺子视图 10（轨顶不留空） */
  private topInset(): number {
    return this.root.closest('.editor-rail')?.classList.contains('no-ruler') ? 10 : 29;
  }
}
