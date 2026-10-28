// findbar —— 统一查找栏 `FindBar`（002 规则 7 v1.3：查看/编辑两态共用）
// 中文文案、设计令牌样式（.tv-bar 同款视觉），替代 CodeMirror 英文搜索面板；
// 显示"第 N / 共 M 处"计数，支持"全部高亮"回调（查看态窗口命中着色）。
import type { FindOptions } from '../common/ipc';
import { t, tf } from '../common/i18n';
import { buildFindRegex } from '../common/findall';

export interface FindHitPos {
  line: number;
  col: number;
}

export interface FindBarCounts {
  /** 全文命中总数；宿主无法计数时 null（不显示） */
  total: number | null;
  /** 当前命中之前的匹配数（"第 N 处" = before + 1）；无命中或未计数时 null */
  before: number | null;
}

export interface FindRunResult {
  hit: FindHitPos | null;
  counts: FindBarCounts;
}

export interface FindBarCfg {
  /**
   * 执行查找。dir=1 下一个 / -1 上一个（宿主负责环绕）；
   * count=true 时统计计数（查找词/选项变化后首次导航或输入防抖触发）；
   * jump=false 为纯计数/高亮刷新（输入防抖），不跳转。
   */
  run(needle: string, opts: FindOptions, dir: 1 | -1, count: boolean, jump: boolean): Promise<FindRunResult>;
  /** 全部高亮（查看态：窗口命中重渲染；空串=清除。编辑态可空 = 内建搜索高亮） */
  onHighlightAll?(needle: string, opts: FindOptions): void;
  /** 关闭回调（归还焦点等） */
  onClosed?(): void;
  /** B-3 替换行（#8）：提供任一回调即可展开替换行（编辑态） */
  onReplaceNext?(needle: string, replacement: string, opts: FindOptions): boolean;
  onReplaceAll?(needle: string, replacement: string, opts: FindOptions): number;
  /** 查看态「▸ 展开替换」的承接：宿主引导进入编辑态并带着查找词重开替换行（002 规则 22） */
  onRequestReplace?(): void;
  /** 005 v2.0：矩形选区在时显示「仅选区内」芯片（002 规则 28 列范围同源语义） */
  hasScope?: () => boolean;
}

/** 查找词 → 正则（非法正则显式报错）。 */
export function buildNeedleRe(needle: string, o: { caseSensitive: boolean; wholeWord: boolean; regex: boolean }): RegExp {
  return buildFindRegex(needle, o);
}

/** 统一查找栏控制器：el 挂宿主顶部；show/hide 控制可见性。
 *  P1-2（002 规则 7/22 v2.4 重设计；22 v2.5 替换行口径）：▸ 折叠/展开替换行（编辑态本栏内切换，
 *  仅本次栏打开期间有效；查看态经 onRequestReplace 引导进编辑态）、↑/↓ 步进按钮 + n/N 计数、
 *  F3/Shift+F3 步进（stepNext/Prev 供 ActionRegistry 调）、Esc 在任意焦点位置都能关闭（document
 *  捕获，照 overlayDialog 先例）。 */
export class FindBar {
  readonly el: HTMLElement;
  readonly inputEl: HTMLInputElement;
  private countEl: HTMLElement;
  private repRowEl: HTMLElement;
  private repInputEl: HTMLInputElement;
  private repCountEl: HTMLElement;
  private toggleEl: HTMLButtonElement;
  private opts: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };
  private lastKey = '';
  private countTimer: ReturnType<typeof setTimeout> | undefined;
  private scopeCbEl!: HTMLInputElement;
  private scopeLabEl!: HTMLElement;
  private repExpanded = false;
  /** 编辑态（宿主提供替换回调）才能本栏内展开替换行；查看态只有引导入口 */
  private readonly replaceAvailable: boolean;
  private docEsc: ((e: KeyboardEvent) => void) | null = null;

  /** 「仅选区内」是否勾选（芯片仅在矩形活动时可见，005 v2.0） */
  get scopeEnabled(): boolean {
    return this.scopeCbEl ? this.scopeCbEl.checked : false;
  }

  constructor(private cfg: FindBarCfg) {
    this.replaceAvailable = !!cfg.onReplaceNext || !!cfg.onReplaceAll;
    this.el = document.createElement('div');
    this.el.className = 'tv-bar';
    this.el.style.display = 'none';
    // 行 1：查找。▸ 折叠/展开替换（有替换回调或引导入口才显示）。
    const rowFind = document.createElement('div');
    rowFind.className = 'fb-row';
    this.toggleEl = document.createElement('button');
    this.toggleEl.type = 'button';
    this.toggleEl.className = 'fb-toggle';
    this.toggleEl.title = t('fb.toggleReplace');
    this.toggleEl.setAttribute('aria-label', t('fb.toggleReplace'));
    this.toggleEl.innerHTML = '<svg class="ic s9" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5l5 4.5-5 4.5"/></svg>';
    if (!this.replaceAvailable && !cfg.onRequestReplace) this.toggleEl.style.display = 'none';
    this.toggleEl.addEventListener('click', () => this.toggleReplace());
    rowFind.appendChild(this.toggleEl);
    const findLab = document.createElement('span');
    findLab.className = 'fb-lab';
    findLab.textContent = t('fb.findLabel');
    rowFind.appendChild(findLab);
    this.inputEl = document.createElement('input');
    this.inputEl.className = 'tv-bar-input';
    this.inputEl.placeholder = t('tv.findPlaceholder');
    rowFind.appendChild(this.inputEl);
    const flag = (label: string, title: string, key: 'caseSensitive' | 'wholeWord' | 'regex'): void => {
      const lab = document.createElement('label');
      lab.className = 'tv-bar-cb';
      lab.title = title;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', () => {
        this.opts[key] = cb.checked;
        this.recount();
      });
      lab.append(cb, document.createTextNode(label));
      rowFind.appendChild(lab);
    };
    flag('Aa', t('tv.caseSensitive'), 'caseSensitive');
    flag('W', t('tv.wholeWord'), 'wholeWord');
    flag('.*', t('tv.regex'), 'regex');
    // 005 v2.0：仅选区内芯片（矩形活动时显示；勾选后查找/替换限定在矩形内）
    const scopeLab = document.createElement('label');
    scopeLab.className = 'tv-bar-cb fb-scope';
    scopeLab.title = t('fb.scopeTip');
    scopeLab.style.display = 'none';
    const scopeCb = document.createElement('input');
    scopeCb.type = 'checkbox';
    // 与 Aa/W/.* 三旗标同口径：勾选变化即时重算（否则计数停在旧口径直至下次输入/步进）
    scopeCb.addEventListener('change', () => this.recount());
    scopeLab.append(scopeCb, document.createTextNode(t('fb.scopeOnly')));
    rowFind.appendChild(scopeLab);
    this.scopeCbEl = scopeCb;
    this.scopeLabEl = scopeLab;
    // ↑/↓ 步进（与 Enter/Shift+Enter、F3/Shift+F3 同一 go 通道；002 规则 7 v2.4）
    const mkStep = (dir: 1 | -1, label: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fb-step';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.textContent = dir === 1 ? '▾' : '▴';
      b.addEventListener('click', () => void this.go(dir));
      return b;
    };
    rowFind.append(
      mkStep(-1, `${t('fb.prev')} (Shift+F3)`),
      mkStep(1, `${t('fb.next')} (F3)`),
    );
    this.countEl = document.createElement('span');
    this.countEl.className = 'fb-count';
    const hint = document.createElement('span');
    hint.className = 'tv-bar-hint';
    hint.textContent = t('bar.hint');
    rowFind.append(this.countEl, hint);
    this.el.appendChild(rowFind);
    // 行 2：替换（P1-2 起按需挂载；v2.5：查找入口收起、替换入口展开，▸ 本栏内切换）
    this.repRowEl = document.createElement('div');
    this.repRowEl.className = 'fb-row fb-rep';
    const repLab = document.createElement('span');
    repLab.className = 'fb-lab';
    repLab.textContent = t('fb.replacePlaceholder');
    this.repInputEl = document.createElement('input');
    this.repInputEl.className = 'tv-bar-input';
    this.repInputEl.placeholder = t('fb.replacePlaceholder');
    this.repRowEl.append(repLab, this.repInputEl);
    this.repCountEl = document.createElement('span');
    this.repCountEl.className = 'fb-count';
    const mkRepBtn = (label: string, fn: () => void): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fb-btn';
      b.textContent = label;
      b.addEventListener('click', fn);
      this.repRowEl.appendChild(b);
    };
    mkRepBtn(t('fb.replaceNext'), () => this.replaceNext());
    mkRepBtn(t('fb.replaceAll'), () => this.replaceAll());
    this.repRowEl.append(this.repCountEl);
    this.inputEl.addEventListener('keydown', e => {
      e.stopPropagation();
      // P0-1（审计 2026-10-17）：Enter 是导航不是输入——宿主 fbRun 会在 keydown 派发期内同步
      // view.focus()，未拦默认动作时该次 Enter 以 insertParagraph 落进 CM 正文，破坏文档。
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.go(e.shiftKey ? -1 : 1);
      } else if (e.key === 'F3') {
        e.preventDefault();
        void this.go(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') this.hide();
    });
    this.inputEl.addEventListener('input', () => this.recount());
    this.repInputEl.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault(); // 同 P0-1：防默认动作落正文
        this.replaceNext();
      } else if (e.key === 'F3') {
        e.preventDefault();
        void this.go(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') this.hide();
    });
  }

  get visible(): boolean {
    return this.el.style.display !== 'none';
  }

  /** 替换行是否展开（挂载在 DOM） */
  get replaceOpen(): boolean {
    return this.repExpanded;
  }

  /** ▸ 折叠/展开替换行：编辑态本栏内切换（仅本次栏打开期间有效，重开由入口决定，002 规则 22 v2.5）；
   *  查看态交宿主引导进编辑态（与 Ctrl+H 同一条路）。 */
  toggleReplace(force?: boolean): void {
    if (!this.replaceAvailable) {
      // 查看态：没有替换回调，展开请求交宿主（进编辑态后重开本栏即带替换行）
      if (force !== false) this.cfg.onRequestReplace?.();
      return;
    }
    const open = force ?? !this.repExpanded;
    if (open === this.repExpanded) {
      if (open) {
        this.repInputEl.focus();
        this.repInputEl.select();
      }
      return;
    }
    this.repExpanded = open;
    if (open) {
      this.el.insertBefore(this.repRowEl, this.el.children[1] ?? null);
      this.toggleEl.classList.add('open');
      this.repInputEl.focus();
      this.repInputEl.select();
    } else {
      this.repRowEl.remove();
      this.toggleEl.classList.remove('open');
      this.inputEl.focus();
    }
  }

  /** F3 / Shift+F3 步进（ActionRegistry 派发；栏已显示时生效，002 规则 7 v2.4） */
  stepNext(): void {
    if (this.visible) void this.go(1);
  }
  stepPrev(): void {
    if (this.visible) void this.go(-1);
  }

  show(seed = '', withReplace = false): void {
    this.el.style.display = 'flex';
    this.refreshScope();
    this.inputEl.value = seed;
    // 002 规则 22 v2.5：打开形态由入口唯一决定且不跨 show 记忆（废止"折叠跨会话记忆"）——
    // 查找入口（无 withReplace）恒收起替换行；替换入口（withReplace = Ctrl+H/工具栏/菜单/
    // 查看态 ▸ 引导）恒展开；▸ 手动折叠/展开仅本次栏打开期间有效，重开即回到入口形态。
    this.repExpanded = this.replaceAvailable && withReplace;
    if (this.repExpanded) {
      this.el.insertBefore(this.repRowEl, this.el.children[1] ?? null);
      this.toggleEl.classList.add('open');
    } else {
      this.repRowEl.remove();
      this.toggleEl.classList.remove('open');
    }
    if (withReplace && this.repExpanded) {
      this.repInputEl.focus();
      this.repInputEl.select();
    } else {
      this.inputEl.focus();
      this.inputEl.select();
    }
    this.lastKey = '';
    // P1-2：Esc 任意焦点位置可关（此前只挂在两个输入框上；照 overlayDialog 的 document 捕获先例）
    this.installDocEsc();
    if (seed) this.recount();
  }

  hide(): void {
    this.el.style.display = 'none';
    clearTimeout(this.countTimer);
    this.uninstallDocEsc();
    this.cfg.onHighlightAll?.('', this.opts);
    this.cfg.onClosed?.();
  }

  refreshScope(): void {
    const hasScope = !!this.cfg.hasScope?.();
    this.scopeLabEl.style.display = hasScope ? '' : 'none';
    if (!hasScope) this.scopeCbEl.checked = false;
    if (this.visible) this.recount();
  }

  /** document 捕获阶段 Esc：焦点在正文/树/工具栏时也能关掉查找栏（自愈式卸载） */
  private installDocEsc(): void {
    this.uninstallDocEsc();
    this.docEsc = (e: KeyboardEvent): void => {
      if (!this.el.isConnected) {
        this.uninstallDocEsc();
        return;
      }
      if (!this.visible) {
        this.uninstallDocEsc();
        return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.hide();
      }
    };
    document.addEventListener('keydown', this.docEsc, true);
  }

  private uninstallDocEsc(): void {
    if (this.docEsc) {
      document.removeEventListener('keydown', this.docEsc, true);
      this.docEsc = null;
    }
  }

  /** 替换一处（B-3：宿主单次 dispatch，单步 undo；P1-2 起替换当前/下一个并前进，成功后刷新计数） */
  private replaceNext(): void {
    const needle = this.inputEl.value;
    if (!needle || !this.cfg.onReplaceNext) return;
    try {
      buildNeedleRe(needle, this.opts);
    } catch (e) { this.showError(e); return; }
    const ok = this.cfg.onReplaceNext(needle, this.repInputEl.value, this.opts);
    this.repCountEl.textContent = ok ? t('fb.replacedOne') : t('tv.notFoundBar');
    if (ok) void this.recount();
  }

  /** 全部替换 */
  private replaceAll(): void {
    const needle = this.inputEl.value;
    if (!needle || !this.cfg.onReplaceAll) return;
    try {
      buildNeedleRe(needle, this.opts);
    } catch (e) { this.showError(e); return; }
    const n = this.cfg.onReplaceAll(needle, this.repInputEl.value, this.opts);
    this.repCountEl.textContent = tf('fb.replacedN', n);
    void this.recount();
  }

  private key(): string {
    return `${this.inputEl.value}\u0000${this.opts.caseSensitive}/${this.opts.wholeWord}/${this.opts.regex}`;
  }

  private display(c: FindBarCounts, hitShown: boolean): void {
    if (c.total == null) {
      this.countEl.textContent = '';
      return;
    }
    this.countEl.textContent =
      hitShown && c.before != null ? tf('fb.count', c.before + 1, c.total) : tf('fb.total', c.total);
  }

  /** 输入/选项变化：防抖计数 + 全部高亮（不跳转） */
  private recount(): void {
    const needle = this.inputEl.value;
    try {
      if (needle) buildNeedleRe(needle, this.opts);
      this.cfg.onHighlightAll?.(needle, this.opts);
    } catch (e) {
      clearTimeout(this.countTimer);
      this.showError(e);
      return;
    }
    if (!needle) {
      clearTimeout(this.countTimer);
      this.countEl.textContent = '';
      return;
    }
    clearTimeout(this.countTimer);
    this.countTimer = setTimeout(() => {
      void this.cfg.run(needle, this.opts, 1, true, false).then(r => {
        this.lastKey = this.key();
        this.display(r.counts, false);
      }).catch(e => this.showError(e));
    }, 300);
  }

  /** Enter / ↑/↓ / F3 共用的导航通道（查找词或选项变化时顺带重新计数；公开供宿主 findStep） */
  async go(dir: 1 | -1): Promise<void> {
    try {
      await this.runGo(dir);
    } catch (e) {
      this.showError(e);
    }
  }

  private showError(e: unknown): void {
    this.lastKey = '';
    // E3xxx 前缀单一判决：查找/替换失败文案统一经 tf('err.findFail')（001 规则 31）
    this.countEl.textContent = tf('err.findFail', e instanceof Error ? e.message : String(e));
  }

  private async runGo(dir: 1 | -1): Promise<void> {
    const needle = this.inputEl.value;
    if (!needle) return;
    const needCount = this.key() !== this.lastKey;
    const r = await this.cfg.run(needle, this.opts, dir, needCount, true);
    if (needCount) this.lastKey = this.key();
    if (r.hit) {
      // P1-2：宿主未计数（total=null，如查看态大文件步进）时保留上次计数文案，不再清空
      if (r.counts.total != null) this.display(r.counts, true);
    } else if (r.counts.total === 0) {
      this.display(r.counts, false);
    } else {
      this.countEl.textContent = t('tv.notFoundBar');
    }
  }
}
