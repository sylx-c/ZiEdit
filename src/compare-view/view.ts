// compare-view —— 深度对比视图（008 子 PRD，视觉定稿 docs/design/compare/compare-view.html）
// 三层头（身份统计行 / 类别过滤行 / A-B 对齐列头）+ 差异导航 + 概览视口框；
// 块级虚拟滚动（行文本按需取：相等块走 text_lines，变更块走 compare_detail 六类分类）。
// 性能红线：内容只在可视窗口按块拉取，永不整文件进前端。布局判决在 layout.ts（纯函数，可单测）。
import {
  compareDetail,
  compareOpen,
  docxRevisionReport,
  fileStat,
  officeLines,
  textLines,
  xlsxOpen,
  xlsxRecords,
  xlsxDiff,
  type CmpDetailLine,
  type CmpOpenResult,
  type CmpSpanCat,
  type DocxRevisionRecord,
  type XlsxDiffEntry,
} from '../common/ipc';
import { normalizeSaveDialog, encodeConvertDialog } from '../shell/panels';
import { t, tf } from '../common/i18n';
import { fmtSize } from '../common/format';
import { clampFontSize } from '../common/fontSize';
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
  /** Office 投影侧（批 1）：头部徽标分流 + 相等块取行走 office_lines */
  private officeA: 'docx' | 'xlsx' | null = null;
  private officeB: 'docx' | 'xlsx' | null = null;
  private revisions = false;
  /** xlsx 公式投影模式（批 2）：true 投影公式原文（对比口径切换，行结构不变） */
  private formulaMode = false;
  /** docx 扩围模式（批 3）：true 投影附加页眉脚/脚注/批注段与标题前缀 */
  private extendedMode = false;
  /** 结构差异清单（批 3）：xlsx 对的单元格级清单面板 */
  private listPanel: HTMLDivElement | null = null;
  /** 双表对照面板（批 6）：A/B 同名 sheet 并排，同步滚动 + 差异高亮 + 点击定位 */
  private duoPanel: HTMLDivElement | null = null;
  private duoSheet: string | null = null;
  private duoGen = 0;
  private duoCacheA = new Map<number, string[]>();
  private duoCacheB = new Map<number, string[]>();
  private duoTotalA = 0;
  private duoTotalB = 0;
  private duoCols = 0;
  /** 各侧当前 sheet 索引与在途取数标记（M2 窗口补取用） */
  private duoIdxA = 0;
  private duoIdxB = 0;
  /** 在途取数标记按代登记：旧代请求的 finally 不得清掉新代标记（审查 M2） */
  private duoFetchGenA: number | null = null;
  private duoFetchGenB: number | null = null;
  /** 差异索引（fillDiffList 顺带产出）：sheet → row → 变更列集合（cell 级） */
  private diffIndex = new Map<string, Map<number, Set<number>>>();
  private duoRowH = 24;
  private sheetLineOffsets: Map<string, number> = new Map();
  private keyColumn = 0;
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
    private opts: { isReadOnly?: () => boolean; onClose: () => void; onStatus: (s: CompareStatus) => void; flash: (msg: string) => void; onJump?: (path: string, line: number) => void },
    formula = false,
    extended = false
  ) {
    this.pathA = a;
    this.pathB = b;
    this.formulaMode = formula;
    this.extendedMode = extended;
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
      res = await compareOpen(this.pathA, this.pathB, this.formulaMode, this.extendedMode);
    } catch (err) {
      if (this.destroyed || generation !== this.generation) return;
      this.sizer.textContent = tf('cmp.openFail', String(err));
      return;
    }
    if (this.destroyed || generation !== this.generation) return;
    cancel.remove();
    this.inputState = res.inputState;
    if (res.binary) {
      // 批 4：旧式/私有 Office 容器（OLE 二进制）给「另存为」指引，替换一刀切文案
      const legacy = [this.pathA, this.pathB].some(p => /\.(ppt|wps|et|dps)$/i.test(p));
      this.opts.flash(t(legacy ? 'cmp.legacyOfficeHint' : 'cmp.binaryRouted'));
      const close = mk('button', 'cmp-btn', t('common.close'));
      close.addEventListener('click', () => this.opts.onClose());
      this.head.firstElementChild!.appendChild(close);
      this.startPolling();
      return;
    }
    // PDF（阶段 4 决策·方案 A）：诚实提示「暂不支持」——不出噪声 diff、不误报 0 差异
    if (res.pdfUnsupported) {
      const note = mk('div', 'cmp-pdf-note', t('cmp.pdfUnsupported'));
      this.sizer.appendChild(note);
      const close = mk('button', 'cmp-btn', t('common.close'));
      close.addEventListener('click', () => this.opts.onClose());
      this.head.firstElementChild!.appendChild(close);
      this.startPolling();
      return;
    }
    this.blocks = toViewBlocks(res.blocks);
    this.metaA = res.metaA;
    this.metaB = res.metaB;
    this.officeA = res.officeA ?? null;
    this.officeB = res.officeB ?? null;
    this.revisions = res.revisions === true;
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
      // 投影说明可能因头部宽度不足被容器查询隐藏——悬停仍可看到完整口径。
      const scopeTitle = side === 'A' ? this.officeA : this.officeB;
      s.title = m?.path ?? '';
      if (scopeTitle) {
        const ext = (side === 'A' ? this.pathA : this.pathB).toLowerCase();
        let scopeKey: 'ooxml.pptxScope' | 'ooxml.docxScope' | 'ooxml.xlsxScope';
        if (ext.endsWith('.pptx')) scopeKey = 'ooxml.pptxScope';
        else if (scopeTitle === 'docx') scopeKey = 'ooxml.docxScope';
        else scopeKey = 'ooxml.xlsxScope';
        s.title += `\n${t(scopeKey)}`;
      }
      const badge = mk('span', 'cmp-side', side);
      const file = mk('span', 'cmp-file', (m?.path ?? '').split(/[\\/]/).pop() ?? '');
      // 投影侧（批 1）：encoding/BOM/EOL 对投影无意义 → 改示投影说明（悬停给提取范围）
      const office = side === 'A' ? this.officeA : this.officeB;
      const dim = mk('span', 'cmp-meta-dim');
      if (office) {
        const pptxSide = (side === 'A' ? this.pathA : this.pathB).toLowerCase().endsWith('.pptx');
        // 行数已在下方 A/B 列头行显示（"11 行"）；首行只留投影口径 + 大小——
        // 投影说明较长会把两侧文件名挤成「①预算…」，文件名优先（修前实测）。
        dim.textContent = `${t(office === 'docx' ? 'cmp.proj.docx' : 'cmp.proj.xlsx')} · ${fmtSize(m?.len ?? 0)}`;
        if (pptxSide) dim.title = t('ooxml.pptxScope');
        else if (office === 'docx') dim.title = t('ooxml.docxScope');
        else dim.title = t('ooxml.xlsxScope');
      } else {
        dim.textContent = `${m?.encoding ?? ''}${m?.bom ? ' · BOM:' + m.bom : ''}${m?.eol && m.eol !== '-' ? ' · EOL:' + m.eol : ''} · ${tf('cmp.lines', m?.lines ?? 0)} · ${fmtSize(m?.len ?? 0)}`;
      }
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
    // 投影对不判 BOM（批 1 收尾）：任一侧为 Office 投影（officeA/officeB 非空）时，投影侧
    // bom 恒为空串占位——混合对（office vs 带 BOM 文本）会误报「BOM 差异」，如实语义是
    // 「投影无字节层，BOM 不适用」，与编码/EOL 徽标同一处理（不产出）。
    this.bomBadgeEl = null;
    if (!this.officeA && !this.officeB && (this.metaA?.bom ?? '') !== (this.metaB?.bom ?? '')) {
      const bomBadge = mk('span', 'cmp-bom-badge', 'BOM');
      bomBadge.title = `A: ${this.metaA?.bom || '-'} / B: ${this.metaB?.bom || '-'}`;
      this.bomBadgeEl = bomBadge;
      counts.appendChild(bomBadge);
    }
    // 修订徽标（批 1）：docx 侧含修订标记 → 如实告知对比口径=接受修订后终态
    if (this.revisions) {
      const revBadge = mk('span', 'cmp-rev-badge', t('cmp.revisions'));
      revBadge.title = t('cmp.revisionsTitle');
      counts.appendChild(revBadge);
    }
    // 动作按钮独立容器：头部空间不足时先截断左侧摘要文本，按钮保持可用——
    // 修前按钮挂在 .cmp-counts（overflow:hidden）里，窄窗口下「差异清单」被裁成「…」。
    const acts = mk('span', 'cmp-acts');
    // 公式投影开关（批 2）：任一侧 xlsx 时可切换「显示值 / 公式」对比口径。
    // 切换走整视图重建（投影行哈希/block 坐标全部随口径变化，增量更新无意义）。
    if (this.officeA === 'xlsx' || this.officeB === 'xlsx') {
      const fbtn = mk('button', 'cmp-btn' + (this.formulaMode ? ' on' : ''), t('cmp.formulaMode'));
      fbtn.title = t('cmp.formulaModeTitle');
      fbtn.addEventListener('click', () => {
        this.destroy();
        this.reloaded = new CompareView(this.host, this.pathA, this.pathB, this.opts, !this.formulaMode, this.extendedMode);
        this.reloaded.setFontSize(this.fontSize);
      });
      acts.appendChild(fbtn);
      // 结构差异清单（批 3）：xlsx 对的单元格级清单（Sheet2!C5: 100→200），
      // 点击定位到投影行；键列输入按列号对齐行（插入行不错位）
      const listBtn = mk('button', 'cmp-btn' + (this.listPanel ? ' on' : ''), t('cmp.diffList'));
      listBtn.title = t('cmp.diffListTitle');
      listBtn.addEventListener('click', () => this.toggleDiffList());
      acts.appendChild(listBtn);
    }
    // 扩围开关（批 3）：任一侧 docx 时投影附加页眉脚/脚注/批注段与标题前缀
    if (this.officeA === 'docx' || this.officeB === 'docx') {
      const ebtn = mk('button', 'cmp-btn' + (this.extendedMode ? ' on' : ''), t('cmp.extended'));
      ebtn.title = t('cmp.extendedTitle');
      ebtn.addEventListener('click', () => {
        this.destroy();
        this.reloaded = new CompareView(this.host, this.pathA, this.pathB, this.opts, this.formulaMode, !this.extendedMode);
        this.reloaded.setFontSize(this.fontSize);
      });
      acts.appendChild(ebtn);
      // 按修订对比（批 3）：docx 侧含修订标记时，修订记录直接读成差异清单
      if (this.revisions) {
        const rbtn = mk('button', 'cmp-btn', t('cmp.revisionMode'));
        rbtn.title = t('cmp.revisionModeTitle');
        rbtn.addEventListener('click', () => void this.showRevisionReport());
        acts.appendChild(rbtn);
      }
    }
    headline.appendChild(counts);
    if (acts.childElementCount > 0) headline.appendChild(acts);
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
    const v = clampFontSize(fs);
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
        // xlsx 投影侧（批 1）：投影行号≠Excel 行号，CsvView 无行锚——跳转不可达，不挂跳转样式
        if ((side === 'a' ? this.officeA : this.officeB) === 'xlsx') continue;
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
        // 投影对（批 1）：A 侧为 docx/xlsx 时相等块取行走 office_lines（同一分流口径；
        // 批 2：公式模式同口径透传）
        const fetched = this.officeA
          ? (await officeLines(this.pathA, blk.aStart, blk.aEnd, this.formulaMode, this.extendedMode)).lines
          : await textLines(this.pathA, blk.aStart, blk.aEnd);
        if (this.destroyed) return;
        const texts = fetched.map(l => l.text);
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
        this.pathA, this.pathB, blk.aStart, blk.aEnd, blk.bStart, blk.bEnd, this.formulaMode, this.extendedMode
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

  // ---- 批 3：结构差异清单 / 修订报告面板 ----

  /** 投影行定位：sheet 行偏移（头行 1 + 数据行），A 侧工作簿序 */
  private async ensureSheetOffsets(): Promise<void> {
    if (this.sheetLineOffsets.size > 0) return;
    try {
      const wb = this.officeA ? await xlsxOpen(this.pathA) : await xlsxOpen(this.pathB);
      let off = 1;
      for (const s of wb.sheets) {
        this.sheetLineOffsets.set(s.name, off);
        off += 1 + s.rows;
      }
    } catch { /* 打开失败时清单点击退化为无跳转 */ }
  }

  private toggleDiffList(): void {
    if (this.listPanel) {
      this.listPanel.remove();
      this.listPanel = null;
      return;
    }
    const panel = mk('div', 'cmp-list');
    panel.appendChild(mk('div', 'cmp-list-head', t('cmp.diffList')));
    this.host.appendChild(panel);
    this.listPanel = panel;
    void this.fillDiffList();
  }

  private async fillDiffList(): Promise<void> {
    const panel = this.listPanel;
    if (!panel || this.destroyed) return;
    panel.appendChild(mk('div', 'cmp-list-loading', t('common.loading')));
    try {
      await this.ensureSheetOffsets();
      const res = await xlsxDiff(this.pathA, this.pathB, this.keyColumn || undefined);
      if (this.destroyed || panel !== this.listPanel) return;
      // 差异索引（双表对照高亮用）：sheet → row → 变更列集合
      this.diffIndex.clear();
      for (const d of res.diffs) {
        if (d.kind !== 'cell') continue;
        let rows = this.diffIndex.get(d.sheet);
        if (!rows) this.diffIndex.set(d.sheet, (rows = new Map()));
        let cols = rows.get(d.row);
        if (!cols) rows.set(d.row, (cols = new Set()));
        cols.add(d.col);
      }
      panel.textContent = '';
      const head = mk('div', 'cmp-list-head');
      head.appendChild(mk('span', '', t('cmp.diffList')));
      // 键列输入（1 基；0/空 = 行号对齐）
      const keyWrap = mk('span', 'cmp-list-key');
      keyWrap.appendChild(mk('span', '', t('cmp.keyColumn')));
      const keyInput = document.createElement('input');
      keyInput.type = 'number';
      keyInput.min = '0';
      keyInput.value = String(this.keyColumn || '');
      keyInput.title = t('cmp.keyColumnTitle');
      keyInput.addEventListener('change', () => {
        this.keyColumn = Math.max(0, Math.floor(Number(keyInput.value) || 0));
        panel.textContent = '';
        panel.appendChild(mk('div', 'cmp-list-loading', t('common.loading')));
        void this.fillDiffList();
      });
      keyWrap.appendChild(keyInput);
      head.appendChild(keyWrap);
      // 双表对照（批 6）：A/B 同名 sheet 并排联动，点击清单条目定位到单元格
      const duoBtn = mk('button', 'cmp-btn' + (this.duoPanel ? ' on' : ''), t('cmp.duo'));
      duoBtn.title = t('cmp.duoTitle');
      duoBtn.addEventListener('click', () => this.toggleDuo());
      head.appendChild(duoBtn);
      panel.appendChild(head);
      if (!res.diffs.length) {
        panel.appendChild(mk('div', 'cmp-list-empty', t('cmp.diffListEmpty')));
        return;
      }
      // 按 sheet 分组折叠；条目点击 → 定位投影行（sheet 头 + 行号）
      const body = mk('div', 'cmp-list-body');
      let curSheet = null as string | null;
      let group: HTMLDivElement | null = null;
      let entries: HTMLDivElement | null = null;
      for (const d of res.diffs) {
        if (d.sheet !== curSheet) {
          curSheet = d.sheet;
          const count = res.groups.find(([n]) => n === d.sheet)?.[1] ?? 0;
          group = mk('div', 'cmp-list-group');
          const gbtn = mk('button', 'cmp-list-sheet', `${d.sheet} (${count})`);
          gbtn.addEventListener('click', () => entries?.classList.toggle('collapsed'));
          group.appendChild(gbtn);
          entries = mk('div', 'cmp-list-entries');
          group.appendChild(entries);
          body.appendChild(group);
        }
        entries!.appendChild(this.renderDiffEntry(d));
      }
      panel.appendChild(body);
    } catch (err) {
      if (this.destroyed || panel !== this.listPanel) return;
      panel.textContent = '';
      panel.appendChild(mk('div', 'cmp-list-empty', tf('cmp.detailFail', String(err))));
    }
  }

  private renderDiffEntry(d: XlsxDiffEntry): HTMLDivElement {
    const row = mk('div', 'cmp-list-row');
    const colName = (c: number): string => {
      let n = c + 1, s = '';
      while (n > 0) { n--; s = String.fromCharCode(65 + n % 26) + s; n = Math.floor(n / 26); }
      return s;
    };
    let ref: string;
    let before = d.before;
    let after = d.after;
    if (d.kind === 'cell') ref = `${d.sheet}!${colName(d.col)}${d.row}`;
    else if (d.kind === 'rowAdd') ref = tf('cmp.rowAddRef', d.row);
    else if (d.kind === 'rowDel') ref = tf('cmp.rowDelRef', d.row);
    else if (d.kind === 'sheetAdd') ref = tf('cmp.sheetAddRef', d.rows);
    else ref = tf('cmp.sheetDelRef', d.rows);
    row.appendChild(mk('span', 'cmp-list-ref', ref));
    row.appendChild(mk('span', 'cmp-list-val before', before || '∅'));
    row.appendChild(mk('span', 'cmp-list-arrow', '→'));
    row.appendChild(mk('span', 'cmp-list-val after', after || '∅'));
    // 定位：投影行 = sheet 偏移 + 行号（sheetAdd/Del 定位到 sheet 头）
    if (d.kind !== 'sheetAdd' && d.kind !== 'sheetDel') {
      row.classList.add('cmp-jump');
      row.addEventListener('click', () => {
        // 双表对照打开时优先定位双表（sheet/行/格）；关闭时定位对比视图投影行
        if (this.duoPanel) {
          void this.duoLocate(d.sheet, d.row, d.kind === 'cell' ? d.col : -1);
          return;
        }
        const base = this.sheetLineOffsets.get(d.sheet);
        if (base == null) return;
        const line = base + (d.kind === 'cell' || d.kind === 'rowAdd' || d.kind === 'rowDel' ? d.row : 0);
        this.scroller.scrollTop = Math.max(0, (line - 1) * this.rowH - 40);
      });
    }
    return row;
  }

  // ---- 批 6：双表对照（A/B 同名 sheet 并排联动）----

  private toggleDuo(): void {
    if (this.duoPanel) {
      this.duoPanel.remove();
      this.duoPanel = null;
      this.duoSheet = null;
      ++this.duoGen;
      return;
    }
    const panel = mk('div', 'cmp-duo');
    const head = mk('div', 'cmp-duo-head');
    const title = mk('span', '', t('cmp.duo'));
    head.appendChild(title);
    const closeBtn = mk('button', 'cmp-btn', t('common.close'));
    closeBtn.addEventListener('click', () => this.toggleDuo());
    head.appendChild(closeBtn);
    const body = mk('div', 'cmp-duo-body');
    const left = this.duoSide('A');
    const right = this.duoSide('B');
    body.append(left.wrap, right.wrap);
    panel.append(head, body);
    this.host.appendChild(panel);
    this.duoPanel = panel;
    // 同步滚动：A/B 行高一致，scrollTop 互推。回写回声与「短侧钳制回推」分开处理：
    // ① 程序化赋值产生的回声：值相同直接短路；
    // ② 短侧滚到上限后把长侧拉回（批 3 M3：长表尾部不可达）——用「用户意图驱动侧」
    //    判定，只有用户直接操作的一侧有资格驱动另一侧（wheel/pointerdown/touchstart/
    //    keydown 标记）。审查 M2：修前用事件次数计数抑制，程序化赋值被钳制为同值时
    //    浏览器不发 scroll 事件，计数泄漏会吞掉用户下一次真实滚动；改为意图标记后
    //    无计数可泄漏（程序化滚动的回声永远不是驱动侧）。
    let driver: HTMLDivElement | null = null;
    const markDriver = (scroller: HTMLDivElement): void => {
      for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const) {
        scroller.addEventListener(type, () => { driver = scroller; }, { passive: true });
      }
    };
    const link = (from: HTMLDivElement, to: HTMLDivElement): void => {
      markDriver(from);
      from.addEventListener('scroll', () => {
        if (driver && driver !== from) return; // 非驱动侧事件（程序化回声/钳制回推）不反推
        if (Math.abs(to.scrollTop - from.scrollTop) < 1) return;
        to.scrollTop = from.scrollTop;
      });
    };
    link(left.scroller, right.scroller);
    link(right.scroller, left.scroller);
    // 打开时定位到首个有差异的 sheet（无差异用 A 侧第一个 sheet）
    const firstDiffSheet = this.diffIndex.keys().next().value ?? null;
    void this.duoShow(firstDiffSheet ?? '');
  }

  private duoSide(side: 'A' | 'B'): { wrap: HTMLDivElement; scroller: HTMLDivElement; body: HTMLDivElement; head: HTMLDivElement } {
    const wrap = mk('div', 'cmp-duo-side');
    const head = mk('div', 'cmp-duo-colhead');
    const scroller = mk('div', 'cmp-duo-scroll');
    const body = mk('div', 'cmp-duo-rows');
    scroller.appendChild(body);
    wrap.append(head, scroller);
    void side;
    return { wrap, scroller, body, head };
  }

  /** 展示指定 sheet（空串 = 各自第一个）；重置缓存，首屏窗口取数后渲染 */
  private async duoShow(sheet: string): Promise<void> {
    const panel = this.duoPanel;
    if (!panel || this.destroyed) return;
    const gen = ++this.duoGen;
    this.duoCacheA.clear();
    this.duoCacheB.clear();
    this.duoCols = 0;
    this.duoTotalA = 0;
    this.duoTotalB = 0;
    this.duoFetchGenA = null;
    this.duoFetchGenB = null;
    const [wa, wb] = await Promise.all([
      xlsxOpen(this.pathA).catch(() => null),
      xlsxOpen(this.pathB).catch(() => null),
    ]);
    if (gen !== this.duoGen || this.destroyed) return;
    const idxA = sheet ? Math.max(0, (wa?.sheets ?? []).findIndex(s => s.name === sheet)) : 0;
    const idxB = sheet ? Math.max(0, (wb?.sheets ?? []).findIndex(s => s.name === sheet)) : 0;
    this.duoIdxA = idxA;
    this.duoIdxB = idxB;
    this.duoSheet = sheet || wa?.sheets?.[0]?.name || wb?.sheets?.[0]?.name || '';
    // 标题栏刷新 sheet 名
    const headEl = panel.querySelector('.cmp-duo-head span');
    if (headEl) headEl.textContent = `${t('cmp.duo')} · ${this.duoSheet}`;
    const sides = panel.querySelectorAll<HTMLDivElement>('.cmp-duo-side');
    if (sides.length !== 2) return;
    const left = sides[0]!, right = sides[1]!;
    const scrollers = [left.querySelector('.cmp-duo-scroll') as HTMLDivElement, right.querySelector('.cmp-duo-scroll') as HTMLDivElement];
    scrollers.forEach(s => { s.scrollTop = 0; });
    const onScroll = (): void => this.duoRender(gen);
    scrollers.forEach(s => { s.onscroll = onScroll; });
    // 首屏窗口取数（批 6 复验 M2：修前固定预取前 200 行且永不补取——第 201 行起
    // 恒空白、清单定位到 200 行外两侧全空；改按可视窗口滚动补取）
    await Promise.all([
      this.duoEnsure('A', 1, 60, gen),
      this.duoEnsure('B', 1, 60, gen),
    ]);
    if (gen !== this.duoGen || this.destroyed) return;
    this.duoRender(gen);
  }

  /** 窗口补取：可视范围内有未缓存行则整窗取数。每侧一个在途标记防滚动风暴
   * 重复请求；到达后 gen 校验再重绘。缓存 2 万行封顶防长会话无界增长。 */
  private async duoEnsure(side: 'A' | 'B', from: number, to: number, gen: number): Promise<void> {
    if (gen !== this.duoGen || this.destroyed) return;
    const cache = side === 'A' ? this.duoCacheA : this.duoCacheB;
    const total = side === 'A' ? this.duoTotalA : this.duoTotalB;
    const path = side === 'A' ? this.pathA : this.pathB;
    const sheetIndex = side === 'A' ? this.duoIdxA : this.duoIdxB;
    const hi = total > 0 ? Math.min(to, total) : to;
    let missing = false;
    for (let n = Math.max(1, from); n <= hi; n++) {
      if (!cache.has(n)) { missing = true; break; }
    }
    if (!missing) return;
    const inFlight = side === 'A' ? this.duoFetchGenA : this.duoFetchGenB;
    if (inFlight === gen) return;
    if (side === 'A') this.duoFetchGenA = gen; else this.duoFetchGenB = gen;
    try {
      const res = await xlsxRecords(path, sheetIndex, from, to);
      if (gen !== this.duoGen || this.destroyed) return;
      if (cache.size > 20_000) cache.clear();
      for (const r of res.records) {
        cache.set(r.no, r.cells);
        if (r.cells.length > this.duoCols) this.duoCols = r.cells.length;
      }
      if (side === 'A') this.duoTotalA = res.total; else this.duoTotalB = res.total;
      this.duoRender(gen);
    } catch { /* 打开失败侧保持空（如实呈现为空表） */ }
    finally {
      // 只清自己这一代：迟到的旧代响应不得解除新代在途状态（审查 M2 竞态）
      if (side === 'A') { if (this.duoFetchGenA === gen) this.duoFetchGenA = null; }
      else { if (this.duoFetchGenB === gen) this.duoFetchGenB = null; }
    }
  }

  /** 窗口渲染（虚拟滚动：可视区 ±缓冲，行 DOM 整窗重建——每侧 ≤ ~70 行，重建成本可忽略） */
  private duoRender(gen: number): void {
    const panel = this.duoPanel;
    if (!panel || gen !== this.duoGen || this.destroyed) return;
    const sides = panel.querySelectorAll<HTMLDivElement>('.cmp-duo-side');
    if (sides.length !== 2) return;
    const sheetDiffs = this.diffIndex.get(this.duoSheet ?? '');
    const colName = (c: number): string => {
      let n = c + 1, s = '';
      while (n > 0) { n--; s = String.fromCharCode(65 + n % 26) + s; n = Math.floor(n / 26); }
      return s;
    };
    for (const [i, sideEl] of [sides[0]!, sides[1]!].entries()) {
      const cache = i === 0 ? this.duoCacheA : this.duoCacheB;
      const total = i === 0 ? this.duoTotalA : this.duoTotalB;
      const scroller = sideEl.querySelector('.cmp-duo-scroll') as HTMLDivElement;
      const body = sideEl.querySelector('.cmp-duo-rows') as HTMLDivElement;
      const head = sideEl.querySelector('.cmp-duo-colhead') as HTMLDivElement;
      const rowH = this.duoRowH;
      const from = Math.max(1, Math.floor(scroller.scrollTop / rowH) + 1);
      const visible = Math.ceil(scroller.clientHeight / rowH) + 6;
      const to = Math.min(total, from + visible);
      // 滚动到未缓存窗口则补取（M2）：先按缓存渲染（未到行暂空），数据到达后重绘
      void this.duoEnsure(i === 0 ? 'A' : 'B', from, to, gen);
      body.style.transform = `translateY(${(from - 1) * rowH}px)`;
      // 列头：行号角 + 列字母
      head.replaceChildren(mk('span', 'cmp-duo-corner', ''));
      for (let c = 0; c < this.duoCols; c++) head.appendChild(mk('span', 'cmp-duo-col', colName(c)));
      const frag = document.createDocumentFragment();
      for (let n = from; n <= to; n++) {
        const cells = cache.get(n);
        const row = mk('div', 'cmp-duo-row');
        row.style.top = `${(n - from) * rowH}px`;
        row.style.height = `${rowH}px`;
        row.appendChild(mk('span', 'cmp-duo-no', String(n)));
        const cols = sheetDiffs?.get(n);
        if (cols) row.classList.add('cmp-duo-diff');
        for (let c = 0; c < this.duoCols; c++) {
          const cell = mk('span', 'cmp-duo-cell', cells?.[c] ?? '');
          if (cols?.has(c)) cell.classList.add('cmp-duo-cell-diff');
          row.appendChild(cell);
        }
        frag.appendChild(row);
      }
      body.replaceChildren(frag);
    }
  }

  /** 清单条目点击 → 双表定位（sheet 切换 + 滚动到行 + 闪烁该格） */
  private async duoLocate(sheet: string, row: number, col: number): Promise<void> {
    if (sheet !== this.duoSheet) await this.duoShow(sheet);
    const panel = this.duoPanel;
    if (!panel) return;
    const gen = this.duoGen;
    const y = Math.max(0, (row - 1) * this.duoRowH - 40);
    panel.querySelectorAll<HTMLDivElement>('.cmp-duo-scroll').forEach(s => { s.scrollTop = y; });
    // 目标行数据就位后再渲染+闪烁（远行首访的窗口取数是异步的，直接渲染会
    // 因 duoCols=0 没有格 DOM 可闪——批 6 复验 M2 定位链路）
    await Promise.all([
      this.duoEnsure('A', row, row + 60, gen),
      this.duoEnsure('B', row, row + 60, gen),
    ]);
    if (gen !== this.duoGen || this.destroyed) return;
    this.duoRender(gen);
    // 闪烁定位格（两侧同坐标）
    panel.querySelectorAll('.cmp-duo-row').forEach(r => {
      if ((r.querySelector('.cmp-duo-no')?.textContent ?? '') === String(row)) {
        const cell = r.children[1 + col];
        if (cell) {
          cell.classList.add('cmp-duo-cell-hit');
          setTimeout(() => cell.classList.remove('cmp-duo-cell-hit'), 1200);
        }
      }
    });
  }

  /** 按修订对比（批 3）：修订记录直接读成差异清单（审阅语义） */
  private async showRevisionReport(): Promise<void> {
    if (this.listPanel) {
      this.listPanel.remove();
      this.listPanel = null;
    }
    const panel = mk('div', 'cmp-list');
    panel.appendChild(mk('div', 'cmp-list-head', t('cmp.revisionMode')));
    panel.appendChild(mk('div', 'cmp-list-loading', t('common.loading')));
    this.host.appendChild(panel);
    this.listPanel = panel;
    const target = this.officeA === 'docx' ? this.pathA : this.pathB;
    const other = target === this.pathA ? this.pathB : this.pathA;
    try {
      let report = await docxRevisionReport(target);
      // 双侧均 docx 且仅另一侧含修订：首取为空回取另一侧（批 6 复验 L7——修前
      // 恒读 A 侧，「无修订记录」与「任一侧含修订」点亮的徽标/按钮自相矛盾）
      if (!report.records.length && this.officeA === 'docx' && this.officeB === 'docx' && other !== target) {
        const alt = await docxRevisionReport(other);
        if (this.destroyed || panel !== this.listPanel) return;
        if (alt.records.length) report = alt;
      }
      if (this.destroyed || panel !== this.listPanel) return;
      panel.textContent = '';
      panel.appendChild(mk('div', 'cmp-list-head', t('cmp.revisionMode')));
      if (!report.records.length) {
        panel.appendChild(mk('div', 'cmp-list-empty', t('cmp.revisionEmpty')));
        return;
      }
      const body = mk('div', 'cmp-list-body');
      for (const r of report.records as DocxRevisionRecord[]) {
        const row = mk('div', `cmp-list-row rev-${r.kind}`);
        row.appendChild(mk('span', 'cmp-list-ref', r.kind === 'ins' ? t('cmp.revIns') : t('cmp.revDel')));
        row.appendChild(mk('span', 'cmp-list-val', r.author || '-'));
        row.appendChild(mk('span', 'cmp-list-val', (r.date || '').replace('T', ' ').slice(0, 19)));
        row.appendChild(mk('span', 'cmp-list-val rev-text', r.text || '∅'));
        body.appendChild(row);
      }
      panel.appendChild(body);
    } catch (err) {
      if (this.destroyed || panel !== this.listPanel) return;
      panel.textContent = '';
      panel.appendChild(mk('div', 'cmp-list-empty', tf('cmp.detailFail', String(err))));
    }
  }

  destroy(): void {
    this.reloaded?.destroy();
    this.reloaded = undefined;
    ++this.generation;
    ++this.duoGen; // 双表迟到渲染一并作废
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
