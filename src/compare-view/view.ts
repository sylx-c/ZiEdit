// compare-view —— 深度对比视图（008 子 PRD，视觉定稿 docs/design/compare/compare-view.html）
// 三层头（身份统计行 / 类别过滤行 / A-B 对齐列头）+ 差异导航 + 概览视口框；
// 块级虚拟滚动（行文本按需取：相等块走 text_lines，变更块走 compare_detail 六类分类）。
// 性能红线：内容只在可视窗口按块拉取，永不整文件进前端。布局判决在 layout.ts（纯函数，可单测）。
import {
  compareDetail,
  compareOpen,
  fileStat,
  textLines,
  type CmpDetailLine,
  type CmpOpenResult,
  type CmpSpanCat,
} from '../common/ipc';
import { normalizeSaveDialog, encodeConvertDialog } from '../shell/panels';
import { t, tf } from '../common/i18n';
import {
  NAV_SHORTCUTS,
  chordLabel,
  cmpFontPx,
  cmpRowHeight,
  cmpSkipHeight,
  diffCounts,
  diffIdxList,
  diffStat,
  isEqualish,
  layoutBlocks,
  lineCatClass,
  lineCatKey,
  lineParts,
  stepIndex,
  toViewBlocks,
  totalHeight,
  type DisplayBlock,
  type ViewBlock,
  ROW_H,
  SKIP_H,
} from './layout';

function fmtSize(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function mk<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text = ''
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** 六类图例（= 过滤器），按设计规格着色；BOM 为文件级类别（008 规则 8 v0.6：图例含 BOM、
 *  纯内容差异非类别无图例项——v0.6 前的 content chip 为口径漂移已除）。 */
const CATS: Array<{ key: CmpSpanCat | 'encoding' | 'bom'; label: string; cls: string }> = [
  { key: 'encoding', label: 'cmp.cat.encoding', cls: 'cat-encoding' },
  { key: 'homoglyph', label: 'cmp.cat.homoglyph', cls: 'cat-homoglyph' },
  { key: 'normalize', label: 'cmp.cat.normalize', cls: 'cat-normalize' },
  { key: 'invisible', label: 'cmp.cat.invisible', cls: 'cat-invisible' },
  { key: 'whitespace', label: 'cmp.cat.whitespace', cls: 'cat-whitespace' },
  { key: 'bom', label: 'cmp.cat.bom', cls: 'cat-bom' },
];

export interface CompareStatus {
  aName: string;
  bName: string;
  diffs: number;
  degraded: boolean;
}

export class CompareView {
  private head!: HTMLDivElement;
  private cols!: HTMLDivElement;
  private scroller!: HTMLDivElement;
  private sizer!: HTMLDivElement;
  private overview!: HTMLDivElement;
  private ovView!: HTMLDivElement;
  private ovCur!: HTMLDivElement;
  private navPos!: HTMLSpanElement;
  private navPrev!: HTMLButtonElement;
  private navNext!: HTMLButtonElement;
  private blocks: ViewBlock[] = [];
  private display: DisplayBlock[] = [];
  private diffIdxs: number[] = [];
  private detailCache = new Map<number, CmpDetailLine[][]>();
  private equalCache = new Map<number, string[]>(); // blockIdx → A 侧行文本
  private onlyDiff = true;
  private expanded = new Set<number>();
  private hiddenCats = new Set<string>();
  private bomBadgeEl: HTMLElement | null = null;
  private encA = new Set<number>();
  private encB = new Set<number>();
  private pathA = '';
  private pathB = '';
  private metaA: CmpOpenResult['metaA'] | null = null;
  private metaB: CmpOpenResult['metaB'] | null = null;
  private degraded = false;
  /** 当前差异序号（1-based；0=未定位/无差异） */
  private curDiff = 0;
  private totalH = 1;
  private dragging = false;
  private destroyed = false;
  private generation = 0;
  private poll?: ReturnType<typeof setInterval>;
  private inputState?: CmpOpenResult['inputState'];
  private reloaded?: CompareView;
  private rendering = false;
  /** 字号消费（001 规则 31 v2.5）：行距/折叠行高/滚动/概览全部随 fs 重派生重排 */
  private fontSize = 12;
  private rowH = ROW_H;
  private skipH = SKIP_H;
  private onWinMove?: (e: MouseEvent) => void;
  private onWinUp?: () => void;
  private onWinResize?: () => void;

  constructor(
    private host: HTMLElement,
    a: string,
    b: string,
    private opts: { isReadOnly?: () => boolean; onClose: () => void; onStatus: (s: CompareStatus) => void; flash: (msg: string) => void; onJump?: (path: string, line: number) => void }
  ) {
    this.pathA = a;
    this.pathB = b;
    void this.init();
  }

  private async init(): Promise<void> {
    this.buildSkeleton();
    const generation = ++this.generation;
    const cancel = mk('button', 'cmp-btn', t('common.cancel'));
    cancel.addEventListener('click', () => { this.destroy(); this.opts.onClose(); });
    this.head.firstElementChild!.appendChild(cancel);
    let res: CmpOpenResult;
    try {
      res = await compareOpen(this.pathA, this.pathB);
    } catch (err) {
      if (this.destroyed || generation !== this.generation) return;
      this.sizer.textContent = tf('cmp.openFail', String(err));
      return;
    }
    if (this.destroyed || generation !== this.generation) return;
    cancel.remove();
    this.inputState = res.inputState;
    if (res.binary) {
      this.opts.flash(t('cmp.binaryRouted'));
      const close = mk('button', 'cmp-btn', t('common.close'));
      close.addEventListener('click', () => this.opts.onClose());
      this.head.firstElementChild!.appendChild(close);
      this.startPolling();
      return;
    }
    this.blocks = toViewBlocks(res.blocks);
    this.metaA = res.metaA;
    this.metaB = res.metaB;
    this.degraded = res.degraded;
    this.encA = new Set(res.encMarksA.map(m => m[0]));
    this.encB = new Set(res.encMarksB.map(m => m[0]));
    this.renderHead();
    this.measureTop();
    this.relayout();
    // 开局落在第 1 处差异（无差异则不标记，计数显示 –/–）
    this.curDiff = this.diffIdxs.length ? 1 : 0;
    this.render();
    this.updateNav();
    this.updateOvView();
    this.scroller.addEventListener('scroll', () => {
      this.scheduleRender();
      this.updateOvView();
    });
    this.onWinResize = () => {
      this.measureTop();
      this.updateOvView();
    };
    window.addEventListener('resize', this.onWinResize);
    this.opts.onStatus({
      aName: (this.metaA?.path ?? '').split(/[\\/]/).pop() ?? '',
      bName: (this.metaB?.path ?? '').split(/[\\/]/).pop() ?? '',
      diffs: this.diffIdxs.length,
      degraded: res.degraded,
    });
    this.startPolling();
  }

  private startPolling(): void {
    if (!this.inputState) return;
    let pending = false;
    this.poll = setInterval(() => {
      if (pending || this.destroyed) return;
      pending = true;
      void Promise.all([fileStat(this.pathA), fileStat(this.pathB)]).then(([a, b]) => {
        if (this.destroyed) return;
        const s = this.inputState!;
        if (a.modifiedMs === s.aMtimeMs && a.len === s.aSize && b.modifiedMs === s.bMtimeMs && b.len === s.bSize) return;
        clearInterval(this.poll);
        const reload = mk('button', 'cmp-btn', t('cmp.inputsChanged'));
        reload.addEventListener('click', () => {
          this.destroy();
          this.reloaded = new CompareView(this.host, this.pathA, this.pathB, this.opts);
          this.reloaded.setFontSize(this.fontSize);
        });
        this.head.firstElementChild!.appendChild(reload);
        this.measureTop();
      }).catch(() => { /* 文件暂不可访问时保留结果，下一轮重试。 */ }).finally(() => { pending = false; });
    }, 2000);
  }

  /** 骨架：三层头 + 滚动区 + 概览条（内容由 renderHead 填） */
  private buildSkeleton(): void {
    this.head = mk('div', 'cmp-head');
    this.head.append(mk('div', 'cmp-headline'), mk('div', 'cmp-legend'));
    this.cols = mk('div', 'cmp-cols');
    this.scroller = mk('div', 'cmp-scroller');
    // 001 规则 31 v2.5：字号落滚动区正文（行内覆盖 styles.css 的 12.5px 基准；出厂 fs12 → 12.5px 观感不变）
    this.scroller.style.fontSize = `${cmpFontPx(this.fontSize)}px`;
    this.sizer = mk('div', 'cmp-sizer');
    this.scroller.appendChild(this.sizer);
    this.overview = mk('div', 'cmp-overview');
    this.overview.title = t('cmp.overviewTitle');
    this.ovView = mk('div', 'cmp-ov-view');
    this.ovCur = mk('div', 'cmp-ov-cur');
    this.ovCur.style.display = 'none';
    this.overview.append(this.ovView, this.ovCur);
    this.host.append(this.head, this.cols, this.scroller, this.overview);
    // 概览条：点击/拖动定位（mousemove/up 挂 window，destroy 时卸载）
    this.overview.addEventListener('mousedown', e => {
      this.dragging = true;
      this.seek(e.clientY);
      e.preventDefault();
    });
    this.onWinMove = (e: MouseEvent) => {
      if (this.dragging) this.seek(e.clientY);
    };
    this.onWinUp = () => {
      this.dragging = false;
    };
    window.addEventListener('mousemove', this.onWinMove);
    window.addEventListener('mouseup', this.onWinUp);
  }

  /** 头部高度（两层头 + 列头）→ --cmp-top：滚动区与概览条的起点（修前是写死的 34px） */
  private measureTop(): void {
    const top = this.head.offsetHeight + this.cols.offsetHeight;
    if (top > 0) this.host.style.setProperty('--cmp-top', `${top}px`);
  }

  private renderHead(): void {
    const headline = this.head.firstElementChild as HTMLDivElement;
    const legend = this.head.lastElementChild as HTMLDivElement;
    headline.textContent = '';
    legend.textContent = '';
    const mkMeta = (m: CmpOpenResult['metaA'] | null, side: 'A' | 'B'): HTMLSpanElement => {
      const s = mk('span', 'cmp-meta');
      s.title = m?.path ?? '';
      const badge = mk('span', 'cmp-side', side);
      const file = mk('span', 'cmp-file', (m?.path ?? '').split(/[\\/]/).pop() ?? '');
      const dim = mk(
        'span',
        'cmp-meta-dim',
        `${m?.encoding ?? ''}${m?.bom ? ' · BOM:' + m.bom : ''}${m?.eol && m.eol !== '-' ? ' · EOL:' + m.eol : ''} · ${tf('cmp.lines', m?.lines ?? 0)} · ${fmtSize(m?.len ?? 0)}`
      );
      s.append(badge, file, dim);
      return s;
    };
    headline.append(mkMeta(this.metaA, 'A'), mk('span', 'cmp-arrow', '→'), mkMeta(this.metaB, 'B'));

    // diffstat：三色配比条（按受影响行数 flex）+ 计数（~改 / +增 / −删）
    const st = diffStat(this.blocks);
    const stat = mk('span', 'cmp-stat');
    const bar = mk('span', 'cmp-stat-bar');
    for (const [cls, n] of [['chg', st.chg], ['add', st.add], ['del', st.del]] as const) {
      const seg = mk('span', 'cmp-stat-seg ' + cls);
      seg.style.flex = String(n);
      bar.appendChild(seg);
    }
    const num = mk('span', 'cmp-stat-num');
    for (const [cls, n, sign] of [['chg', st.chg, '~'], ['add', st.add, '+'], ['del', st.del, '−']] as const) {
      const grp = mk('span', cls);
      grp.appendChild(mk('b', '', sign + n));
      num.append(grp, document.createTextNode(' '));
    }
    stat.append(bar, num);
    headline.appendChild(stat);

    const counts = mk('span', 'cmp-counts');
    const dc = diffCounts(this.blocks);
    counts.appendChild(mk('em', '', tf('cmp.diffCount', dc.diffs)));
    counts.append(
      document.createTextNode(` · ${tf('cmp.affectedRows', dc.affected)}`),
      ...(this.encA.size > 0 ? [document.createTextNode(tf('cmp.encCandidates', this.encA.size))] : []),
      ...(this.degraded ? [document.createTextNode(t('cmp.blockLevel'))] : [])
    );
    // BOM 文件级徽标（008 规则 8 v0.6）：A/B BOM 有无或类型不同 → 计数行红色「BOM」徽标。
    // 徽标是六类图例 BOM 项的「可过滤载体」——chip 空心（hiddenCats 含 bom）时随之隐藏（G-014 根修）。
    this.bomBadgeEl = null;
    if ((this.metaA?.bom ?? '') !== (this.metaB?.bom ?? '')) {
      const bomBadge = mk('span', 'cmp-bom-badge', 'BOM');
      bomBadge.title = `A: ${this.metaA?.bom || '-'} / B: ${this.metaB?.bom || '-'}`;
      this.bomBadgeEl = bomBadge;
      counts.appendChild(bomBadge);
    }
    headline.appendChild(counts);
    headline.appendChild(mk('span', 'tb-spacer'));

    // 差异导航 ◀ n/m ▶（键位 = ActionRegistry 同源，001 规则 34 v2.4）
    const nav = mk('span', 'cmp-nav');
    this.navPrev = mk('button', '', '◀');
    this.navPrev.title = `${t('cmp.navPrev')} (${chordLabel(NAV_SHORTCUTS.prev)})`;
    this.navPrev.addEventListener('click', () => this.stepDiff(-1));
    this.navPos = mk('span', 'cmp-nav-pos', t('cmp.navPosNone'));
    this.navNext = mk('button', '', '▶');
    this.navNext.title = `${t('cmp.navNext')} (${chordLabel(NAV_SHORTCUTS.next)})`;
    this.navNext.addEventListener('click', () => this.stepDiff(1));
    nav.append(this.navPrev, this.navPos, this.navNext);
    headline.appendChild(nav);

    const normBtn = mk('button', 'cmp-btn', t('act.normalize'));
    normBtn.addEventListener('click', () => this.openNormalize());
    const encBtn = mk('button', 'cmp-btn', t('act.encSave'));
    normBtn.disabled = encBtn.disabled = this.opts.isReadOnly?.() === true;
    encBtn.addEventListener('click', () => this.openEncodeConvert());
    const closeBtn = mk('button', 'cmp-btn', t('common.close'));
    closeBtn.addEventListener('click', () => this.opts.onClose());
    headline.append(normBtn, encBtn, closeBtn);

    // ② 类别过滤行：chips（色点 + 名称，空心点 = 已过滤）+「仅差异」
    legend.appendChild(mk('span', 'cmp-legend-label', t('cmp.legendLabel')));
    for (const c of CATS) {
      const chip = mk('button', 'cmp-chip ' + c.cls + (this.hiddenCats.has(c.key) ? ' off' : ''));
      chip.appendChild(mk('span', 'dot'));
      chip.appendChild(document.createTextNode(t(c.label)));
      chip.title = t('cmp.legendTitle');
      chip.addEventListener('click', () => {
        if (this.hiddenCats.has(c.key)) this.hiddenCats.delete(c.key);
        else this.hiddenCats.add(c.key);
        chip.classList.toggle('off');
        if (c.key === 'bom' && this.bomBadgeEl) {
          this.bomBadgeEl.style.display = this.hiddenCats.has('bom') ? 'none' : '';
        }
        this.scheduleRender();
      });
      legend.appendChild(chip);
    }
    legend.appendChild(mk('span', 'cmp-legend-note', t('cmp.legendNote')));
    legend.appendChild(mk('span', 'tb-spacer'));
    const onlyBtn = mk('button', 'cmp-btn' + (this.onlyDiff ? ' on' : ''), t('cmp.onlyDiff'));
    onlyBtn.addEventListener('click', () => {
      this.onlyDiff = !this.onlyDiff;
      this.expanded.clear();
      onlyBtn.classList.toggle('on', this.onlyDiff);
      this.relayout();
      this.render();
      this.updateOvView();
      this.updateNav();
    });
    legend.appendChild(onlyBtn);

    // ③ A/B 对齐列头（列名与行数压各栏上方，双栏归属无需靠猜）
    this.cols.textContent = '';
    const mkCol = (side: 'A' | 'B', m: CmpOpenResult['metaA'] | null): HTMLSpanElement => {
      const c = mk('span', 'cmp-col');
      c.append(
        mk('b', '', side),
        mk('span', '', (m?.path ?? '').split(/[\\/]/).pop() ?? ''),
        mk('span', 'cmp-col-dim', tf('cmp.lines', m?.lines ?? 0))
      );
      return c;
    };
    this.cols.append(mk('span'), mkCol('A', this.metaA), mk('span'), mk('span'), mkCol('B', this.metaB));
  }

  /** 块 → 显示布局（prefix 前缀和），并重建总览色块 */
  private relayout(): void {
    this.display = layoutBlocks(this.blocks, this.onlyDiff, this.expanded, this.rowH, this.skipH);
    this.diffIdxs = diffIdxList(this.blocks);
    if (this.curDiff > this.diffIdxs.length) this.curDiff = this.diffIdxs.length;
    const top = totalHeight(this.display);
    this.totalH = Math.max(top, this.scroller.clientHeight || 0, 1);
    this.sizer.style.height = `${top}px`;
    this.buildOverview();
  }

  private buildOverview(): void {
    for (const old of [...this.overview.children]) if (old !== this.ovView && old !== this.ovCur) old.remove();
    for (const d of this.display) {
      if (isEqualish(d.blk.kind)) continue;
      const seg = mk('div', 'cmp-ov-seg ' + d.blk.kind);
      seg.style.top = `${(d.top / this.totalH) * 100}%`;
      seg.style.height = `${Math.max(0.8, (d.height / this.totalH) * 100)}%`;
      seg.addEventListener('click', e => {
        e.stopPropagation();
        this.scroller.scrollTop = Math.max(0, d.top - 40);
      });
      this.overview.insertBefore(seg, this.ovView);
    }
  }

  /** 滚动条定位（概览条点击/拖动）：比率 → 滚动位置 */
  private seek(clientY: number): void {
    const r = this.overview.getBoundingClientRect();
    if (r.height <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    this.scroller.scrollTop = ratio * Math.max(0, this.sizer.clientHeight - this.scroller.clientHeight);
  }

  /** 视口框（概览条内）与当前差异标记 */
  private updateOvView(): void {
    const sc = this.scroller;
    this.ovView.style.top = `${(sc.scrollTop / this.totalH) * 100}%`;
    this.ovView.style.height = `${((sc.clientHeight || 1) / this.totalH) * 100}%`;
    const d = this.display.find(x => x.idx === this.curDiffIdx());
    if (d) {
      this.ovCur.style.display = 'block';
      this.ovCur.style.top = `${(d.top / this.totalH) * 100}%`;
    } else {
      this.ovCur.style.display = 'none';
    }
  }

  // ---- 差异导航（008 规则 14）----
  private curDiffIdx(): number {
    return this.curDiff ? (this.diffIdxs[this.curDiff - 1] ?? -1) : -1;
  }

  /** 差异处数（app.ts 的动作 enabled 判决：无差异则键位不放行） */
  diffCount(): number {
    if (this.reloaded) return this.reloaded.diffCount();
    return this.diffIdxs.length;
  }

  /** 设置字号（001 规则 31 v2.5 / 002 规则 12 v2.5：行距派生）。
   *  行高/折叠行高重派生，布局（layoutBlocks）→ 滚动总高 → 概览条全部按新行高重排；
   *  视觉位置按内容占比保持。幂等：重复同值调用无副作用。构造后任意时机可调
   *  （init 未完成时仅记录派生值，其后 init 的 relayout/render 自然用新行高）。 */
  setFontSize(fs: number): void {
    if (this.reloaded) { this.reloaded.setFontSize(fs); return; }
    const v = Math.min(18, Math.max(10, Math.round(fs))); // 与设置字号同域（10–18px）
    if (v === this.fontSize || this.destroyed) return;
    this.fontSize = v;
    this.rowH = cmpRowHeight(v);
    this.skipH = cmpSkipHeight(v);
    if (!this.scroller) return; // 骨架未建（防御；正常路径构造即同步建骨架）
    // 视觉位置保持：按内容占比重映射 scrollTop（totalH 由 relayout 按新行高重算）
    const denom = Math.max(1, this.totalH - this.scroller.clientHeight);
    const ratio = this.scroller.scrollTop / denom;
    this.scroller.style.fontSize = `${cmpFontPx(v)}px`;
    this.relayout();
    this.scroller.scrollTop = ratio * Math.max(0, this.totalH - this.scroller.clientHeight);
    this.render();
    this.updateOvView();
  }

  /** 环绕步进：落点块滚入视口（顶部留 40px 语境）并加当前标记 */
  stepDiff(dir: 1 | -1): void {
    if (this.reloaded) { this.reloaded.stepDiff(dir); return; }
    if (!this.diffIdxs.length) return;
    this.curDiff = stepIndex(this.curDiff, this.diffIdxs.length, dir);
    const d = this.display.find(x => x.idx === this.curDiffIdx());
    if (d) this.scroller.scrollTop = Math.max(0, d.top - 40);
    this.render();
    this.updateNav();
    this.updateOvView();
  }

  private updateNav(): void {
    const n = this.diffIdxs.length;
    this.navPos.textContent = n ? `${this.curDiff}/${n}` : t('cmp.navPosNone');
    this.navPrev.disabled = !n;
    this.navNext.disabled = !n;
  }

  private scheduleRender(): void {
    if (this.rendering) return;
    this.rendering = true;
    requestAnimationFrame(() => {
      this.rendering = false;
      this.render();
    });
  }

  private render(): void {
    if (this.destroyed) return;
    const st = this.scroller.scrollTop;
    const vh = this.scroller.clientHeight;
    const visible = this.display.filter(d => d.top + d.height >= st && d.top <= st + vh);
    const frag = document.createDocumentFragment();
    for (const d of visible) {
      const el = this.renderBlock(d);
      el.style.top = `${d.top}px`;
      frag.appendChild(el);
    }
    for (const old of [...this.sizer.children]) old.remove();
    this.sizer.appendChild(frag);
    // 异步补内容
    for (const d of visible) void this.fillBlock(d);
  }

  private renderBlock(d: DisplayBlock): HTMLDivElement {
    const box = mk('div', 'cmp-block ' + d.blk.kind);
    box.style.height = `${d.height}px`;
    const blk = d.blk;
    if (d.idx === this.curDiffIdx()) box.classList.add('cur');
    if (blk.kind === 'equal' && d.height === this.skipH) {
      const skip = mk('div', 'cmp-skip');
      skip.style.height = `${this.skipH}px`; // 行内覆盖 styles.css 24px 基准（随字号派生）
      skip.appendChild(mk('span', 'chev', '▼'));
      skip.appendChild(document.createTextNode(tf('cmp.sameLines', blk.aEnd - blk.aStart + 1)));
      skip.appendChild(mk('span', 'act', t('cmp.expand')));
      skip.addEventListener('click', () => {
        this.expanded.add(d.idx);
        this.relayout();
        this.render();
        this.updateOvView();
        this.updateNav();
      });
      box.appendChild(skip);
      return box;
    }
    if (isEqualish(blk.kind)) {
      // 行骨架（文本由 fillBlock 异步填；未变文本降档）
      for (let i = 0; i < d.rows; i++) {
        box.appendChild(this.rowShell(blk.aStart + i, blk.bStart + i, true));
      }
      return box;
    }
    // replace/delete/insert 骨架
    for (let i = 0; i < d.rows; i++) {
      const aNo = blk.aStart + i <= blk.aEnd && blk.kind !== 'insert' ? blk.aStart + i : null;
      const bNo = blk.bStart + i <= blk.bEnd && blk.kind !== 'delete' ? blk.bStart + i : null;
      box.appendChild(this.rowShell(aNo, bNo, false));
    }
    return box;
  }

  /** 行骨架：双行号 + 双文本单元 + 中缝（kind 类驱动背景；eq=相等行降档）。
   *  行点击跳转（008 规则 11 v0.6）：行号/文本格点击 → 单文件视图定位（onJump 由 shell 接
   *  openPath(anchor)/活动标签直达；位置历史同源走 goToLine）。 */
  private rowShell(aNo: number | null, bNo: number | null, eq: boolean): HTMLDivElement {
    const row = mk('div', 'cmp-row');
    row.style.height = `${this.rowH}px`; // 行内覆盖（随字号派生，001 规则 31 v2.5）
    const mkLn = (no: number | null): HTMLSpanElement => mk('span', 'cmp-ln', no != null ? String(no) : '');
    const mkTx = (cls: string): HTMLSpanElement => mk('span', `cmp-tx ${cls}${eq ? ' cmp-eq' : ''}`);
    row.append(
      mkLn(aNo),
      mkTx('cmp-a'),
      mk('span', 'cmp-mid'),
      mkLn(bNo),
      mkTx('cmp-b')
    );
    if (this.opts.onJump) {
      const cells: Array<[HTMLElement, 'a' | 'b', number | null]> = [
        [row.children[0] as HTMLElement, 'a', aNo],
        [row.children[1] as HTMLElement, 'a', aNo],
        [row.children[3] as HTMLElement, 'b', bNo],
        [row.children[4] as HTMLElement, 'b', bNo],
      ];
      for (const [cell, side, no] of cells) {
        if (no == null) continue;
        cell.classList.add('cmp-jump');
        cell.addEventListener('click', () => this.opts.onJump!(side === 'a' ? this.pathA : this.pathB, no));
      }
    }
    return row;
  }

  private async fillBlock(d: DisplayBlock): Promise<void> {
    const blk = d.blk;
    // 找到对应 DOM（render 后同步存在，按 top 定位）
    const el = [...this.sizer.children].find(c => (c as HTMLElement).style.top === `${d.top}px`) as HTMLElement | undefined;
    if (!el) return;
    if (isEqualish(blk.kind)) {
      if (this.equalCache.has(d.idx)) {
        this.fillText(el, this.equalCache.get(d.idx)!);
        return;
      }
      try {
        const lines = await textLines(this.pathA, blk.aStart, blk.aEnd);
        if (this.destroyed) return;
        const texts = lines.map(l => l.text);
        this.equalCache.set(d.idx, texts);
        const cur = [...this.sizer.children].find(c => (c as HTMLElement).style.top === `${d.top}px`) as HTMLElement | undefined;
        if (cur) this.fillText(cur, texts);
      } catch {
        /* 索引未就绪等，骨架保持空 */
      }
      return;
    }
    // 变更块：detail
    if (this.detailCache.has(d.idx)) {
      this.fillDetail(el, d.idx);
      return;
    }
    try {
      const [la, lb] = await compareDetail(
        this.pathA, this.pathB, blk.aStart, blk.aEnd, blk.bStart, blk.bEnd
      );
      if (this.destroyed) return;
      this.detailCache.set(d.idx, [la, lb]);
      const cur = [...this.sizer.children].find(c => (c as HTMLElement).style.top === `${d.top}px`) as HTMLElement | undefined;
      if (cur) this.fillDetail(cur, d.idx);
    } catch (err) {
      const first = el.querySelector('.cmp-tx');
      if (first) first.textContent = tf('cmp.detailFail', String(err));
    }
  }

  private fillText(el: HTMLElement, texts: string[]): void {
    const rows = el.querySelectorAll(':scope > .cmp-row');
    rows.forEach((row, i) => {
      const text = texts[i] ?? '';
      (row.querySelector('.cmp-tx.cmp-a') as HTMLElement).textContent = text;
      (row.querySelector('.cmp-tx.cmp-b') as HTMLElement).textContent = text;
    });
  }

  private fillDetail(el: HTMLElement, idx: number): void {
    const [la, lb] = this.detailCache.get(idx) ?? [[], []];
    const rows = el.querySelectorAll(':scope > .cmp-row');
    rows.forEach((row, i) => {
      const da = la[i];
      const db = lb[i];
      const ta = row.querySelector('.cmp-tx.cmp-a') as HTMLElement;
      const tb = row.querySelector('.cmp-tx.cmp-b') as HTMLElement;
      if (da) this.renderSpans(ta, da, 'a');
      else ta.classList.add('cmp-absent');
      if (db) this.renderSpans(tb, db, 'b');
      else tb.classList.add('cmp-absent');
      const lineCat = da?.lineCat ?? db?.lineCat ?? null;
      // 未配对行回退到 open 阶段的编码候选标记（行号级）
      const fallback =
        !lineCat && ((da && this.encA.has(da.no)) || (db && this.encB.has(db.no))) ? 'encoding' : null;
      const cat = lineCat ?? fallback;
      // 类别被隐藏 = 该类别不参与差异（规则 9 v0.4）：行底色与中缝徽标一并撤下
      if (!cat || this.hiddenCats.has(lineCatKey(cat) ?? '')) return;
      const cls = lineCatClass(cat);
      if (cls) {
        row.classList.add(cls);
        ta.classList.add(cls);
        tb.classList.add(cls);
      }
      const badge = mk('span', 'cmp-badge', cat === 'encoding' ? t('cmp.cat.encoding') : t('cmp.eol'));
      (row.querySelector('.cmp-mid') as HTMLElement).appendChild(badge);
    });
  }

  /** 全行分段渲染（等值段纯文本；变更段按类别着色，被过滤的类别降级为普通文本）。
   *  分段判决在 layout.lineParts（含「空 spans 回退整行文本」——单侧行不空白），此处只落 DOM。 */
  private renderSpans(target: HTMLElement, line: CmpDetailLine, side: 'a' | 'b'): void {
    target.textContent = '';
    for (const p of lineParts(line, side)) {
      if (!p.cat || this.hiddenCats.has(p.cat)) {
        target.appendChild(document.createTextNode(p.text));
      } else {
        target.appendChild(mk('span', 'cmp-cat cat-' + p.cat, p.text));
      }
    }
  }

  // ---- 规范化另存向导（008 规则 12：对比检出 → 修复闭环；与编辑菜单共享 panels.normalizeSaveDialog）----
  private openNormalize(): void {
    normalizeSaveDialog({
      isReadOnly: this.opts.isReadOnly,
      path: this.pathA,
      title: t('cmp.normalizeDialogTitle'),
      flash: this.opts.flash,
      pathNote: tf('cmp.applyToA', this.pathA),
      onError: msg => this.opts.flash(msg),
    });
  }

  /** 编码转换另存（008 规则 13 v0.6）：作用于 A 侧（与规范化另存同族） */
  private openEncodeConvert(): void {
    encodeConvertDialog({
      isReadOnly: this.opts.isReadOnly,
      path: this.pathA,
      fromEnc: this.metaA?.encoding ?? '',
      title: t('enc.title'),
      flash: this.opts.flash,
      pathNote: tf('cmp.applyToA', this.pathA),
      onError: msg => this.opts.flash(msg),
    });
  }

  destroy(): void {
    this.reloaded?.destroy();
    this.reloaded = undefined;
    ++this.generation;
    clearInterval(this.poll);
    this.destroyed = true;
    if (this.onWinMove) window.removeEventListener('mousemove', this.onWinMove);
    if (this.onWinUp) window.removeEventListener('mouseup', this.onWinUp);
    if (this.onWinResize) window.removeEventListener('resize', this.onWinResize);
    this.onWinMove = undefined;
    this.onWinUp = undefined;
    this.onWinResize = undefined;
    this.host.innerHTML = '';
    this.host.style.removeProperty('--cmp-top');
  }
}
