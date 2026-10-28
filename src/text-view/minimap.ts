// minimap —— 缩略图导航条（002 规则 23 v1.4：按文档结构排列）
// 编辑行 flex 兄弟：[mm-resize][minimap][vscroll]；宽度 clamp 随窗口、拖拽后持久化（ZiEdit-mm-w）。
// 每根条按该行真实结构渲染：前导空白 → 缩进偏移；行内语法分段 → 逐段着色（tok-* 类随主题取 --syn-* 色，
// 与编辑区同源）。数据合规（性能红线）：已缓存行直接取；采样行经 requestLines 让视图分批小窗预取，
// 绝不整文件读入；未取到前画中性短条。点击/拖动按行号定位（goToLine 行锚点）。
// 卸载清理：document 级监听全部登记，remove() 统一卸载（修复切换标签累积泄漏）。
import { t } from '../common/i18n';

/** 语法分段（与 highlight.ts 的 Span 同构：字符区间 + tok-* 类名） */
export interface MmSpan {
  from: number;
  to: number;
  cls: string;
}

export interface MinimapAdapter {
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
  /** 行缓存版本（变化时才重建密度条；缺省每次重建） */
  cacheVersion?(): number;
  /** 语法分段版本（高亮窗口变化时重建分段着色；缺省 0） */
  spansVersion?(): number;
}

const MIN_W = 64;
const MAX_W = 320;
const STORE_KEY = 'ZiEdit-mm-w';
const BAR_H = 2;
const BAR_GAP = 2;
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
  private detachers: Array<() => void> = [];
  private barState: Array<{ line: number; text: string | null; spans?: MmSpan[] }> = [];

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
    this.viewportEl = document.createElement('div');
    this.viewportEl.className = 'mm-viewport';
    this.root.append(this.barsHost, this.viewportEl);
    this.vscrollEl = document.createElement('div');
    this.vscrollEl.className = 'vscroll';
    this.thumbEl = document.createElement('div');
    this.thumbEl.className = 'vs-thumb';
    this.vscrollEl.appendChild(this.thumbEl);
    parent.append(this.resizeEl, this.root, this.vscrollEl);

    const saved = localStorage.getItem(STORE_KEY);
    if (saved) this.root.style.width = `${saved}px`;

    // document 级监听统一登记，remove() 时卸载（修复泄漏）
    const onDoc = (ev: 'mousemove' | 'mouseup', fn: (e: MouseEvent) => void): void => {
      document.addEventListener(ev, fn);
      this.detachers.push(() => document.removeEventListener(ev, fn));
    };

    // 点击/拖动跳转：按行号比例 → goToLine 行锚点（v1.4：不再按像素分数盲跳）
    const jump = (e: MouseEvent) => {
      const r = this.root.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      if (this.adapter.goToLine) {
        const dispTotal = Math.max(1, this.adapter.totalLines());
        const dispLine = Math.max(1, Math.round(ratio * dispTotal));
        const real = this.adapter.realLineOf?.(dispLine) ?? dispLine;
        this.adapter.goToLine(real);
      } else {
        this.adapter.scrollTo(ratio * (this.adapter.scrollHeight() - this.adapter.clientHeight()));
      }
    };
    this.root.addEventListener('mousedown', e => {
      this.dragScrolling = true;
      jump(e);
    });
    onDoc('mousemove', e => {
      if (this.dragScrolling) jump(e);
    });
    onDoc('mouseup', () => (this.dragScrolling = false));

    // 滚轮转发到主滚动区（minimap / 分隔条 / 滚动条轨道）
    for (const el of [this.root, this.resizeEl, this.vscrollEl]) {
      el.addEventListener(
        'wheel',
        e => {
          e.preventDefault();
          this.adapter.scrollTo(this.adapter.scrollTop() + e.deltaY);
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

    // 自绘滚动条：拇指拖拽 + 轨道翻页
    let thumbDrag: { y: number; top: number; range: number; total: number } | null = null;
    this.thumbEl.addEventListener('mousedown', e => {
      const track = this.vscrollEl.clientHeight;
      const h = this.thumbEl.offsetHeight;
      thumbDrag = {
        y: e.clientY,
        top: this.thumbEl.offsetTop,
        range: track - h,
        total: this.adapter.scrollHeight() - this.adapter.clientHeight(),
      };
      this.thumbEl.classList.add('drag');
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    });
    onDoc('mousemove', e => {
      if (!thumbDrag || thumbDrag.range <= 0) return;
      const top = Math.min(thumbDrag.range, Math.max(0, thumbDrag.top + (e.clientY - thumbDrag.y)));
      this.adapter.scrollTo(thumbDrag.total * (top / thumbDrag.range));
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
      this.adapter.scrollTo(this.adapter.scrollTop() + dir * this.adapter.clientHeight() * 0.9);
    });
  }

  setVisible(v: boolean): void {
    for (const el of [this.root, this.resizeEl, this.vscrollEl]) el.style.display = v ? '' : 'none';
  }

  /** 视图卸载时从编辑行移除三件套并卸载全部 document 监听 */
  remove(): void {
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
    const total = this.adapter.totalLines();
    const version = `${this.adapter.cacheVersion?.() ?? -1}|${this.adapter.spansVersion?.() ?? 0}`;
    if (version !== this.barsVersion || this.barsTotal !== total) {
      this.barsVersion = version;
      this.barsTotal = total;
      this.rebuildBars(h, total);
    }
    this.syncViewport();
  }

  private barsVersion = '';
  private barsTotal = -1;

  private rebuildBars(h: number, total: number): void {
    // 极短文档不做满高采样，避免同一行重复成密集条纹；同时清理上一文档的条目。
    if (total <= 3) {
      this.barsHost.replaceChildren();
      this.barState = [];
      return;
    }
    const slot = BAR_H + BAR_GAP;
    const count = Math.max(1, Math.min(400, Math.floor(h / slot)));
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
      const text = this.adapter.lineText(real);
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
      const spans = this.adapter.lineSpans?.(real);
      const previous = this.barState[i];
      if (previous?.line === real && previous.text === text && previous.spans === spans) continue;
      this.barState[i] = { line: real, text, spans };
      const b = bars[i] as HTMLElement;
      const trimmed = text.replace(/[\r\n]+$/, '');
      if (!trimmed.trim()) {
        // 空行：细短点，保留节奏感
        b.className = 'mm-bar';
        b.style.width = '4%';
        b.replaceChildren();
        continue;
      }
      const lead = this.leadCols(trimmed);
      const indent = Math.min(MAX_INDENT, lead * charW);
      const lenPct = Math.min(100 - indent, Math.max(4, trimmed.length * charW));
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

  private syncViewport(): void {
    const sh = this.adapter.scrollHeight();
    const ch = this.adapter.clientHeight();
    const rootH = this.root.clientHeight;
    if (sh > ch + 1) {
      const inner = Math.max(40, rootH - 20);
      this.viewportEl.classList.add('live');
      this.viewportEl.style.height = `${Math.max(18, (ch / sh) * inner)}px`;
      this.viewportEl.style.top = `${10 + (this.adapter.scrollTop() / sh) * inner}px`;
      this.viewportEl.style.bottom = 'auto';
      const track = this.vscrollEl.clientHeight;
      const th = Math.max(28, (ch / sh) * track);
      this.thumbEl.style.display = '';
      this.thumbEl.style.height = `${th}px`;
      this.thumbEl.style.top = `${(this.adapter.scrollTop() / (sh - ch)) * (track - th)}px`;
    } else {
      this.viewportEl.classList.remove('live');
      this.viewportEl.style.height = '';
      this.viewportEl.style.top = '';
      this.viewportEl.style.bottom = '';
      this.thumbEl.style.display = 'none';
    }
  }
}
