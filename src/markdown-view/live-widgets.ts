// markdown-view/live-widgets —— live preview 装饰件（WidgetType）
// （批次 4 自 livepreview.ts 拆分；REQ-014 P5 起表格机械移驻 table-widget.ts）。
import { EditorView, WidgetType } from '@codemirror/view';
import { EditorState, type Text } from '@codemirror/state';
import { zassetUrl } from '../common/ipc';
import type { SyntaxNode } from '@lezer/common';
import { zassetAllow } from '../common/ipc';
import { t } from '../common/i18n';
import { isComposing } from '../common/composition';
import { userScrolledRecently } from '../common/user-scroll';
import { fenceSourceChanged, fenceSourceField, fenceDraftField } from './writing';
import { localImagePath, type HeadingItem } from './preview';
import { type RenderBlock } from './render-model';
import { createRenderContext, mountRender, renderMountKey, rememberedRenderHeight, rememberRenderHeight, type RenderContext } from './render-service';
import { currentPosition, type ReferenceIndex } from './live-state';

/** IR 源行高（px）：13.5px×1.6（styles.css .md-ir .cm-scroller），挂件高度保守托底基准。 */
const SOURCE_LINE_HEIGHT_PX = 21.6;

/** 装饰构建期的图片 src 解析（规则 21：非活动块装饰件构建时解析相对路径 → asset 协议） */
function localImgPath(src: string, baseDir: string | null): string | null {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (!internals) {
    if (src && !/^(https?:|data:|asset:|blob:|tauri:|\/\/)/i.test(src)) {
      console.warn('[ZiEdit IR] 本地图片需要 Tauri asset 环境，浏览器开发态无法显示本地图片。');
    }
    return null;
  }
  return localImagePath(src, baseDir);
}

// ── 装饰件（WidgetType） ──

const renderMounts = new WeakMap<HTMLElement, () => void>();
const renderKeys = new WeakMap<HTMLElement, string>();
export class RenderWidget extends WidgetType {
  constructor(readonly block: RenderBlock, readonly doc: Text, readonly context: RenderContext) { super(); }
  /** 高度估计：同一块渲染过则用实测高度（重挂/滚回/离屏估计零跳变）；否则保守托底：
   *  源行数×源行高，显示态对齐 CSS min-height 40px（v0.40 规则 22/27）。 */
  get estimatedHeight(): number {
    const remembered = rememberedRenderHeight(this.block, this.context);
    if (remembered) return remembered;
    const lines = Math.max(1, this.doc.lineAt(this.block.from).number === this.doc.lineAt(this.block.to - 1).number ? 1
      : this.doc.lineAt(this.block.to - 1).number - this.doc.lineAt(this.block.from).number + 1);
    return Math.max(lines * SOURCE_LINE_HEIGHT_PX, 40);
  }
  // 不比较 doc：同区间同源码即同行数，doc 引用每次按键都变，修前令视口内全部公式件逐键 updateDOM。
  eq(other: RenderWidget): boolean {
    return this.block.from === other.block.from && this.block.to === other.block.to
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
    // 仅位置移动（上方键入）或无关公式改动：挂载身份不变则保留在途/已完成的渲染，只回写位置。
    if (renderKeys.get(dom) === renderMountKey(this.block, this.context) && renderMounts.has(dom)) {
      dom.dataset.renderFrom = String(this.block.from); return true;
    }
    this.start(dom, view); return true;
  }
  private start(dom: HTMLElement, view: EditorView): void {
    renderMounts.get(dom)?.(); dom.dataset.renderFrom = String(this.block.from);
    renderKeys.set(dom, renderMountKey(this.block, this.context));
    // 加载态按估计高度预留（styles.css 读 --md-render-reserve），出图前后只变一次高度
    if (this.block.display) dom.style.setProperty('--md-render-reserve', this.estimatedHeight + 'px');
    const { block, context } = this;
    renderMounts.set(dom, mountRender(dom, block, context, document.documentElement.dataset.tone === 'dark',
      () => view.dom.contains(dom), () => view.requestMeasure({ key: dom,
        read: () => dom.isConnected && dom.dataset.renderState === 'ready' ? dom.getBoundingClientRect().height : 0,
        write: height => rememberRenderHeight(block, context, height) }), () => isComposing(view),
      () => userScrolledRecently(view.scrollDOM, 150)));
  }
  destroy(dom: HTMLElement): void { renderMounts.get(dom)?.(); renderMounts.delete(dom); renderKeys.delete(dom); }
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
const imageDetach = new WeakMap<HTMLElement, () => void>();
export class ImgWidget extends WidgetType {
  constructor(
    private src: string,
    private alt: string,
    private remoteResolve?: (url: string) => Promise<string | null>,
    private sourceFrom?: number,
    private baseDir: string | null = null,
    private sourceTo?: number
  ) { super(); }
  eq(other: ImgWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.sourceFrom === this.sourceFrom
      && other.sourceTo === this.sourceTo
      && other.baseDir === this.baseDir && other.remoteResolve === this.remoteResolve;
  }
  destroy(dom: HTMLElement): void { liveImages.delete(dom); imageDetach.get(dom)?.(); imageDetach.delete(dom); }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    liveImages.add(el); // 构建阶段尚未挂 DOM，不能以 isConnected 判定是否有效。
    el.className = 'mdir-imgbox';
    if (this.sourceFrom !== undefined) el.dataset.mdFrom = String(this.sourceFrom);
    // (2026-10-29 用户需求) IR 模式图片整体替换源码——点击选中源区间，Delete/Backspace 可删除
    if (this.sourceFrom !== undefined && this.sourceTo !== undefined) {
      el.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        view.dispatch({ selection: { anchor: this.sourceFrom!, head: this.sourceTo! } });
        view.focus();
        el.classList.add('is-selected');
      });
      // 选区离开图片区间时移除选中态（监听挂在编辑器根上，件销毁时必须解绑——修前每次重建泄漏一个）
      const onEditorClick = (): void => {
        const sel = view.state.selection.main;
        if (sel.from >= this.sourceTo! || sel.to <= this.sourceFrom!) el.classList.remove('is-selected');
      };
      view.dom.addEventListener('click', onEditorClick);
      imageDetach.set(el, () => view.dom.removeEventListener('click', onEditorClick));
      el.title = this.alt || this.src.slice(0, 80);
    }
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
    // 加载/失败都会改变行高；CM6 不观察件内尺寸变化，主动请求一次测量让高度图与滚动锚及时纠正。
    img.addEventListener('error', () => { broken(); if (liveImages.has(el)) view.requestMeasure(); });
    img.addEventListener('load', () => { el.classList.remove('is-broken'); if (liveImages.has(el)) view.requestMeasure(); });
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
      if (path) void zassetAllow(path).then(() => {
        if (!liveImages.has(el)) return;
        el.replaceChildren(img);
        img.src = zassetUrl(path);
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
// REQ-014 P5：表格机械（TableWidget/hydrate 系列/嵌套格编辑器/行虚拟化）已由
// table-widget.ts 的 TableEditWidget（contenteditable 直接编辑）整体取代并删除。
