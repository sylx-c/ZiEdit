// markdown-view/livepreview —— CM6 live preview 自研引擎（007 v0.16 规则 2/23 M1；ADR 011 修订）。
// 即时渲染：缓冲即文档模型（无序列化），按视口构建持续的块布局与按元素展开的行内装饰——
// 标题定级与 # 隐藏、加粗/斜体/删除线/行内代码定界符隐藏、引用竖线、列表观感、任务勾选框、
// 围栏代码围栏隐藏 + 语言标签 + 嵌套语言高亮 + 语言补全、图片装饰件构建时解析；
// 表格网格/分隔线为块级替换件，由 liveBlockField（StateField）承载（CM6 约束：插件侧
// 不得产出块级装饰）；表格保持网格，由局部编辑器映射单元格源范围。
// 格式命令与源码态同一实现（mdformat.runMdFormat，规则 17 三上下文单源）；
// 查找替换就地承载（FindBar 复用，规则 20 v0.16——切源码 workaround 废止）；
// 保存链路复用 textSave + 行尾回写 + UNMAPPABLE 三键（与旧 IR 同口径）。
// 批次 4 拆分（行为不变）：共享 StateField/effects/常量在 live-state.ts；装饰件与表格几何/
// hydrate 在 live-widgets.ts；行内/行级装饰构建在 live-deco.ts；块级 StateField 与查找高亮在
// live-block-field.ts；表格交互与查找替换纯函数在 live-table-actions.ts；统计/大纲上报机构在
// live-reporter.ts。本文件保留补全源、LiveStatus/Opts 与 LivePreviewView 类；对外 export 面
// 完全不变（app.ts 等调用方 import 路径零变化）。
import {
  EditorView,
  keymap,
  drawSelection,
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
  type WidgetType,
} from '@codemirror/view';
import { bufferHistory, ReadOnlyControl, type EditorBuffer } from '../common/editor-buffer';
import { compositionActive, compositionGuard, isComposing } from '../common/composition';
import { EditorState, StateEffect, type Range } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, undo, redo, selectAll } from '@codemirror/commands';
import { syntaxTree, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';
import { textOpen, textReadAll, textSave } from '../common/ipc';
import { type CtxMenuItem, type CtxMenuLeaf } from '../shell/chrome';
import { readClipboardText, writeClipboardText } from '../common/clipboard';
import { t, tf } from '../common/i18n';
import { FindBar } from '../text-view/findbar';
import { runMdFormat, editMarkdownLink, MD_INLINE_COMMANDS, MD_BLOCK_COMMANDS, type MdFormatCmd } from './mdformat';
import { liveMarkdownExtensions } from './extensions';
import { destroyCellEditor } from './table-editor';
import { tableRowNumber } from './table-viewport';
import { markdownWriting, markdownIndent, inlineFormatChanged, inlineFormatField, inlineFormatMarks, inlineFormatOpen, inlineFormatClose, type InlineFormat } from './writing';
import { trackImageTarget } from './imagehost';
import { snapshotDocument } from '../common/snapshot';
import { startParseWarmup } from '../common/parse-warmup';
import { loadUnicodeEmojis, CODE_HINT_LANGS, decodeLocalRef, isExternalHref, routeLinkHref, type HeadingItem } from './preview';
import { loadMarkdownIt } from './md';
import { codeHighlight } from './code-highlight';
import { irPerfEnabled, irPerfProbe, recordLiveDeco } from './ir-perf';
import { VIEWPORT_MARGIN, imageContext, emojiField, emojisReady, mdTouchedField, referenceField, referenceUrls, referenceLabel, linkUrlOfNode, currentPosition } from './live-state';
import { buildLiveDeco } from './live-deco';
import { liveBlockField, liveGeometryChanged, viewportReporter, findHighlighter, findQueryChanged, type LiveFindQuery } from './live-block-field';
import { tableTabNav, tableMenuItems, fbRun, fbReplaceNext, fbReplaceAll } from './live-table-actions';
import { LiveDocTracker } from './live-reporter';
import { clipWindows, missingWindows, type DecoWindow } from './deco-window';
import { paragraphTypingWindow } from './typing-window';
import { TextWidget } from './live-widgets';
import { requestIrFrame, cancelIrFrame } from './frame-work';
import { blockInteractions } from './block-interactions';

// 对外面零变化：buildLiveDeco/referenceField 原由本文件导出，拆分后经转发保持 import 路径不变。
export { buildLiveDeco } from './live-deco';
export { referenceField } from './live-state';

// ── 常量 ──


// ── 代码块语言补全（规则 2：CM6 autocompletion，44 语言数据源自建补全源） ──

function emojiCompletion(ctx: CompletionContext) {
  const match = ctx.matchBefore(/:[\w+-]*$/);
  if (!match || /[\w\\:]/.test(ctx.state.doc.sliceString(Math.max(0, match.from - 1), match.from))) return null;
  for (let node: SyntaxNode | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); node; node = node.parent) {
    if (['FencedCode', 'CodeBlock', 'InlineCode', 'Link', 'URL', 'HTMLBlock'].includes(node.name)) return null;
  }
  return { from: match.from, options: Object.entries(ctx.state.field(emojiField)).map(([label, emoji]) => ({
    label: ':' + label + ':', detail: emoji, type: 'text', apply: ':' + label + ':',
  })), validFor: /^:[\w+-]*:?$/ };
}

function codeLangCompletion(ctx: CompletionContext) {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const prefix = ctx.state.doc.sliceString(line.from, ctx.pos);
  const match = /^(?:[ >]*)?(`{3,}|~{3,})([a-zA-Z0-9+#-]*)$/.exec(prefix);
  if (!match) return null;
  let node: SyntaxNode | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
  while (node && node.name !== 'FencedCode') node = node.parent;
  if (!node || ctx.state.doc.lineAt(node.from).number !== line.number) return null;
  return { from: ctx.pos - match[2]!.length,
    options: CODE_HINT_LANGS.map(label => ({ label, type: 'text' })), validFor: /^[a-zA-Z0-9+#-]*$/ };

}

// ── 嵌套代码语言（与编辑面 langExt 同集，懒加载 LanguageDescription） ──

const codeLanguages = [
  ['json', [], () => import('@codemirror/lang-json').then(m => m.json())],
  ['javascript', ['js'], () => import('@codemirror/lang-javascript').then(m => m.javascript())],
  ['typescript', ['ts'], () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true }))],
  ['python', ['py'], () => import('@codemirror/lang-python').then(m => m.python())],
  ['rust', ['rs'], () => import('@codemirror/lang-rust').then(m => m.rust())],
  ['java', [], () => import('@codemirror/lang-java').then(m => m.java())],
  ['cpp', ['c++'], () => import('@codemirror/lang-cpp').then(m => m.cpp())],
  ['c', [], () => import('@codemirror/lang-cpp').then(m => m.cpp())],
  ['sql', [], () => import('@codemirror/lang-sql').then(m => m.sql())],
  ['yaml', ['yml'], () => import('@codemirror/lang-yaml').then(m => m.yaml())],
  ['xml', [], () => import('@codemirror/lang-xml').then(m => m.xml())],
  ['html', [], () => import('@codemirror/lang-html').then(m => m.html())],
  ['css', [], () => import('@codemirror/lang-css').then(m => m.css())],
  ['markdown', ['md'], () => import('@codemirror/lang-markdown').then(m => m.markdown())],
].map(([name, alias, load]) => LanguageDescription.of({
  name: name as string,
  alias: alias as string[],
  load: load as () => Promise<import('@codemirror/language').LanguageSupport>,
}));

// ── LivePreviewView ──

export interface LiveStatus {
  dirty: boolean;
  /** 全文字符数（去空白，状态栏「N 字」格，与旧 IR 同口径） */
  chars: number;
  /** 全文行数（状态栏「M 行」格） */
  lines: number;
  /** 光标行（1 基，状态栏行列格；与 EditView 同口径） */
  line: number;
  /** 光标列（1 基字符列，状态栏行列格） */
  col: number;
}

/** 缩略图接线 API（规则 13：滚动容器 + 源文本行；CM6 引擎滚动容器即 view.scrollDOM） */
export interface LiveReadyApi {
  scrollEl: HTMLElement | null;
  getLines: () => string[];
  linesVersion: () => number;
  lineCount: () => number;
  lineText: (line: number) => string | undefined;
}

export interface LivePreviewOpts {
  /** 右键菜单尾部追加项（app 侧注入「Markdown 模式 ▸」，菜单同构规则 8） */
  modeMenuItems?: () => CtxMenuItem[];
  path: string;
  encoding: string;
  initialDoc?: string;
  buffer?: EditorBuffer;
  readOnly?: boolean;
  startDirty?: boolean;
  onStatus: (s: LiveStatus) => void;
  /** 保存成功收口（H-6c）：真实写盘后回调 shell（挂 save() 内部，键位/菜单/自动保存三入口同收） */
  onSaved: (path: string, stat?: { len: number; modifiedMs: number }, clean?: boolean) => void;
  /** 草稿（draft://）无磁盘权威，textSave 无法直写——由 shell 走另存为（默认扩展名随语言） */
  onSaveAsNeeded?: (content: string) => void;
  onAlert?: (msg: string) => void;
  onConfirm?: (msg: string) => Promise<boolean>;
  onFlash?: (msg: string) => void;
  /** 标题树变化上报（大纲联动，规则 3；输入防抖） */
  onHeadings?: (headings: HeadingItem[]) => void;
  /** 右键格式菜单（app 侧统一菜单组件） */
  showMenu?: (items: CtxMenuItem[], x: number, y: number) => void;
  /** 编辑器就绪后回调（缩略图接线） */
  onReady?: (api: LiveReadyApi) => void;
  /** .md 相对链接 → 新标签打开（app 侧 openPath） */
  openMarkdown?: (absPath: string) => void;
  /** 外链 → 系统浏览器（app 侧 opener.openUrl） */
  openExternal?: (url: string) => void;
  /** 图床远程图取回（009 规则 10）：url → data: URL；非图床 host 返回 null（host 过滤在 app 侧） */
  remoteImages?: (url: string) => Promise<string | null>;
  /** 右键图片「上传到图床」（009 规则 4 触发③）：入参为原始本地引用，返回图床公开 URL；
   *  返回 null 表示未配置/取消/失败（无改写）。改写由本视图单事务完成（保 alt/title，单步撤销） */
  onUploadImage?: (ref: string) => Promise<string | null>;
  /** 上传入口可见性闸（009 规则 4：图床未启用不出现上传入口；缺省视为可见） */
  canUploadImage?: () => boolean;
}

/** CM6 live preview 视图（007 v0.16 M1）。对外表面与旧 WysiwygView 对齐（挂载/保存/状态/大纲/缩略图）。 */
/**
 * 已生效格式内的组合/取消：改写定界符本身。
 * 例：**abc** 内按斜体 → ***abc***；***abc*** 内按粗体 → *abc*。
 */
function combineLiveMark(view: EditorView, current: InlineFormat, mark: string): void {
  const doc = view.state.doc;
  const size = inlineFormatOpen(current).length, trailing = current.trailing ?? 0;
  const openFrom = current.from, openTo = current.from + size;
  const closeFrom = current.to - trailing - size, closeTo = closeFrom + size;
  if (doc.sliceString(openFrom, openTo) !== inlineFormatOpen(current)
    || doc.sliceString(closeFrom, closeTo) !== inlineFormatClose(current)) {
    view.dispatch({ effects: inlineFormatChanged.of(null) });
    return;
  }
  const marks = current.marks.includes(mark)
    ? current.marks.filter(item => item !== mark) : [...current.marks, mark];
  const newOpen = marks.join(''), newClose = [...marks].reverse().join('');
  const delta = newOpen.length - size, head = view.state.selection.main.head;
  const anchor = head <= openTo ? head : head > closeFrom ? head + delta * 2 : head + delta;
  view.dispatch({
    changes: [{ from: openFrom, to: openTo, insert: newOpen }, { from: closeFrom, to: closeTo, insert: newClose }],
    selection: { anchor },
    effects: inlineFormatChanged.of(marks.length
      ? { from: openFrom, to: current.to + delta * 2, marks, pending: false, trailing } : null),
    userEvent: 'input.format',
  });
}

export class LivePreviewView {
  view!: EditorView;
  private host: HTMLElement;
  private destroyed = false;
  private readOnlyControl = new ReadOnlyControl();
  get isReadOnly(): boolean { return this.readOnlyControl.enabled; }
  setReadOnly(on: boolean): void {
    this.readOnlyControl.set(this.view, on);
    if (on) for (const box of this.host.querySelectorAll<HTMLElement>('.mdir-tablebox')) destroyCellEditor(box);
  }
  private dirty = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private newline: string | null = null; // 打开时行尾主类型（保存回写，002 规则 4 v1.4）
  private cursor = { line: 1, col: 1 };
  private findBar: FindBar | null = null;
  private findQuery: LiveFindQuery | null = null;
  private stopParseWarmup: (() => void) | null = null;
  private findRunVersion = 0;
  /** 统计/行缓存/大纲上报机构（批次 4 外置至 live-reporter.ts，行为不变）。 */
  private tracker: LiveDocTracker;

  constructor(host: HTMLElement, private opts: LivePreviewOpts) {
    this.host = host;
    this.dirty = opts.buffer?.dirty ?? !!opts.startDirty;
    this.readOnlyControl.enabled = !!opts.readOnly;
    this.tracker = new LiveDocTracker(() => this.view, () => this.destroyed, opts.onHeadings);
    host.classList.add('md-ir');
    void this.init();
  }

  get path(): string {
    return this.opts.path;
  }

  get isDirty(): boolean { return this.dirty; }

  private baseDir(): string | null {
    const p = this.opts.path.replace(/\\/g, '/');
    const i = p.lastIndexOf('/');
    return i > 0 ? p.slice(0, i) : null;
  }

  private async init(): Promise<void> {
    let text = '';
    try {
      const info = await textOpen(this.opts.path);
      this.newline = info.newline;
    } catch {
      /* 探测失败不阻断；保存按 LF 原样 */
    }
    try {
      text = this.opts.buffer?.state.doc.toString() ?? this.opts.initialDoc ?? await textReadAll(this.opts.path, this.opts.encoding);
    } catch (err) {
      this.host.textContent = tf('err.readFail', String(err));
      return;
    }
    if (this.destroyed) return;
    // FC 收口 1 就绪屏障（IR 挂载）：mountEditor 创建 EditorState 时 referenceField.create
    // 同步提取元数据（mdLinkTools）、后续装饰/行内投影走 markdownIt()——先等共享单例就绪。
    await loadMarkdownIt();
    this.mountEditor(text);
    this.tracker.prime(this.view);
    void loadUnicodeEmojis().then(map => { if (!this.destroyed) this.view.dispatch({ effects: emojisReady.of(map) }); });
    if (this.opts.buffer) this.view.scrollDOM.scrollTop = this.opts.buffer.scrollTop;
    this.stopParseWarmup = startParseWarmup(this.view, () => !this.destroyed);
    this.opts.onReady?.({
      scrollEl: this.view.scrollDOM,
      getLines: () => this.tracker.getLines(),
      linesVersion: () => this.tracker.linesVer,
      lineCount: () => this.view.state.doc.lines,
      lineText: line => line >= 1 && line <= this.view.state.doc.lines ? this.view.state.doc.line(line).text : undefined,
    });
    void this.tracker.refreshStats().then(() => { if (!this.destroyed) this.reportStatus(); });
    this.reportStatus();
    void this.tracker.reportHeadings();
  }

  private mountEditor(text: string): void {
    this.findBar = new FindBar({
      run: (needle, o, dir, count, jump) => {
        const runVersion = ++this.findRunVersion;
        return fbRun(this.view, needle, o, dir, count, jump, () => runVersion !== this.findRunVersion || this.destroyed);
      },
      onHighlightAll: (needle, o) => {
        if (!this.view) return;
        this.findQuery = needle ? { needle, opts: { ...o } } : null;
        this.view.dispatch({ effects: findQueryChanged.of(null) });
      },
      onClosed: () => this.view?.focus(),
      onReplaceNext: (needle, replacement, o) => this.view ? fbReplaceNext(this.view, needle, replacement, o) : false,
      onReplaceAll: (needle, replacement, o) => this.view ? fbReplaceAll(this.view, needle, replacement, o) : 0,
    });
    this.host.appendChild(this.findBar.el);

    const baseDir = this.baseDir();
    const remoteResolve = this.opts.remoteImages
      ? (url: string) => this.opts.remoteImages!(url)
      : undefined;
    const decoSlice = StateEffect.define<null>();
    const liveDeco = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        private frame = 0;
        private next = 0;
        private end = 0;
        private covered: DecoWindow[] = [];
        private pending: DecoWindow[] = [];
        private budgeted = false;
        private complete = false;
        private sharedFrame = false;
        constructor(v: EditorView) { this.decorations = Decoration.none; this.rebuild(v); }
        private cancelFrame(): void {
          if (this.sharedFrame) cancelIrFrame(this.frame); else cancelAnimationFrame(this.frame);
          this.frame = 0;
        }
        destroy(): void { this.cancelFrame(); }
        private rebuild(view: EditorView, scrolling = false, deferred = scrolling, complete = false): void {
          this.cancelFrame();
          this.budgeted = deferred;
          this.complete = complete;
          const from = Math.max(0, view.viewport.from - VIEWPORT_MARGIN);
          this.end = Math.min(view.state.doc.length, view.viewport.to + VIEWPORT_MARGIN);
          const target = { from, to: this.end };
          this.covered = scrolling ? clipWindows(target, this.covered) : [];
          this.decorations = scrolling ? this.decorations.update({ filter: f => f >= from && (f < this.end || this.end === view.state.doc.length) }) : Decoration.none;
          this.pending = missingWindows(target, this.covered);
          if (this.pending.length) {
            this.next = this.pending[0]!.from;
            if (deferred) {
              this.sharedFrame = true;
              this.frame = requestIrFrame(() => { this.frame = 0; if (!isComposing(view)) view.dispatch({ effects: decoSlice.of(null) }); });
            }
            else this.appendSlice(view);
          }
        }
        private appendSlice(v: EditorView): void {
          if (!this.pending.length) return;
          const from = this.next;
          const end = this.pending[0]!.to;
          // 小文档不改既有同步行为；大文档每帧最多构建一小片。
          const to = this.complete || (!this.budgeted && v.state.doc.length < 256 * 1024) ? end
            : this.budgeted ? Math.min(end, from + 512)
            : Math.min(end, v.state.doc.lineAt(Math.min(end, from + 2048)).to);
          if (irPerfEnabled()) recordLiveDeco(from, to);
          const built = buildLiveDeco(v, baseDir, remoteResolve, { from, to });
          const add: Range<Decoration>[] = [];
          for (let c = built.iter(); c.value; c.next()) {
            if (c.from >= from && (c.from < to || (to === v.state.doc.length && c.from === to))) add.push(c.value.range(c.from, c.to));
          }
          this.decorations = this.decorations.update({ add, sort: true });
          this.next = to;
          this.covered = clipWindows({ from: 0, to: v.state.doc.length }, [...this.covered, { from, to }]);
          if (to === end) { this.pending.shift(); if (this.pending.length) this.next = this.pending[0]!.from; }
          if (this.pending.length) {
            this.sharedFrame = this.budgeted;
            const next = () => { this.frame = 0; if (!isComposing(v)) v.dispatch({ effects: decoSlice.of(null) }); };
            this.frame = this.budgeted ? requestIrFrame(next) : requestAnimationFrame(next);
          }
        }
        update(u: ViewUpdate): void {
          if (isComposing(u.view)) { this.decorations = this.decorations.map(u.changes); return; }
          if (u.transactions.some(tr => tr.effects.some(effect => effect.is(liveGeometryChanged)))) {
            this.rebuild(u.view, false, false, true);
            return;
          }
          const typing = u.docChanged && !this.pending.length
            && u.startState.field(referenceField).inlineKey === u.state.field(referenceField).inlineKey
            && u.startState.field(inlineFormatField) === u.state.field(inlineFormatField)
            && u.startState.field(emojiField) === u.state.field(emojiField)
            && u.startState.field(compositionActive) === u.state.field(compositionActive)
            ? paragraphTypingWindow(u.startState, u.state, u.changes) : null;
          if (typing) {
            // 带源码坐标/文档快照的 widget 不能仅靠 RangeSet.map 更新内部位置。
            // 此类视口保留原重建路径；纯标记与无坐标 TextWidget 可安全复用。
            let reusable = true;
            for (let c = this.decorations.iter(); c.value; c.next()) {
              const widget = c.value.spec.widget;
              if (widget && !(widget instanceof TextWidget)) { reusable = false; break; }
            }
            if (reusable) {
              const mapped = this.decorations.map(u.changes);
              this.decorations = mapped.update({ filter: (f, t) => t < typing.from || f > typing.to });
              this.covered = this.covered.map(range => ({ from: u.changes.mapPos(range.from, -1), to: u.changes.mapPos(range.to, 1) }));
              this.covered = this.covered.flatMap(range => [
                { from: range.from, to: Math.min(range.to, typing.from) },
                { from: Math.max(range.from, typing.to), to: range.to },
              ].filter(part => part.from < part.to));
              this.rebuild(u.view, true, false);
              return;
            }
          }
          if (u.docChanged || u.viewportChanged || u.selectionSet
            || u.startState.field(compositionActive) !== u.state.field(compositionActive)
            || syntaxTree(u.startState) !== syntaxTree(u.state)
            || u.startState.field(referenceField) !== u.state.field(referenceField)
            || u.startState.field(inlineFormatField) !== u.state.field(inlineFormatField)
            || u.startState.field(emojiField) !== u.state.field(emojiField)
            || u.startState.field(mdTouchedField, false) !== u.state.field(mdTouchedField, false)) {
            const scrolling = u.viewportChanged && !u.docChanged && !u.selectionSet
              && u.startState.field(compositionActive) === u.state.field(compositionActive)
              && syntaxTree(u.startState) === syntaxTree(u.state)
              && u.startState.field(referenceField) === u.state.field(referenceField)
              && u.startState.field(inlineFormatField) === u.state.field(inlineFormatField)
              && u.startState.field(emojiField) === u.state.field(emojiField)
              && u.startState.field(mdTouchedField, false) === u.state.field(mdTouchedField, false);
            this.rebuild(u.view, scrolling);
          } else if (u.transactions.some(tr => tr.effects.some(e => e.is(decoSlice)))) {
            this.appendSlice(u.view);
          }
        }
      },
      { decorations: v => v.decorations }
    );

    this.view = new EditorView({
      parent: this.host,
      state: EditorState.create({
        doc: this.opts.buffer?.state.doc ?? text,
        selection: this.opts.buffer?.state.selection,
        extensions: [
          irPerfProbe(),
          drawSelection(),
          // CM6 baseTheme 聚焦选区为 6 类选择器 #d7d4f0，应用侧单类 var(--selection) 在顺序与特异性
          // 双重必输——用户主题挂载序在 baseTheme 后，配合 !important 定向夺回（007 v0.39 选区可见性）
          // 合成器滚动：表格等大块留在主线程重绘时，每次滚轮都错过一次刷新（31Hz 下稳定 ~65ms 双帧，script=0）。
          // will-change: scroll-position 不建立包含块，只把这个滚动容器交给合成器。
          EditorView.theme({
            '& .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
            '.cm-scroller': { willChange: 'scroll-position' },
          }),
          compositionGuard(),
          imageContext.of({ baseDir, remoteResolve }),
          referenceField,
          emojiField,
          mdTouchedField,
          history(),
          bufferHistory(this.opts.buffer),
          this.readOnlyControl.extension(),
          EditorState.allowMultipleSelections.of(true),
          EditorView.lineWrapping,
          // base 必须 markdownLanguage（GFM：表格/任务列表/删除线/自动链接）——markdown() 出厂
          // 默认 commonmarkLanguage（严格 CommonMark，无 GFM）
          markdown({ base: markdownLanguage, codeLanguages, extensions: [liveMarkdownExtensions] }),
          markdownWriting(),
          syntaxHighlighting(classHighlighter),
          codeHighlight(codeLanguages),
          autocompletion({ override: [codeLangCompletion, emojiCompletion] }),
          liveBlockField, // 块级件（表格/分隔线）：StateField 承载（CM6 约束）
          EditorView.atomicRanges.of(view => view.state.field(liveBlockField).set.update({ filter: (_from, _to, value) => !!(value.spec.fence || value.spec.blockAtomic || (value as unknown as { widget?: WidgetType & { fence?: boolean } }).widget?.fence) })),
          viewportReporter, // 视口界报给 liveBlockField（构造即报，滚动随报）
          liveDeco,
          findHighlighter(() => this.findQuery),
          keymap.of([
            // 块边界命令优先于默认方向键与全文选择。
            ...defaultKeymap,
            ...historyKeymap,
            // 活动表格内单元格导航/加行加列（规则 23 M2）；不在表格内返回 false 交回默认缩进
            { key: 'Tab', run: () => this.tableTab(1) || markdownIndent(this.view, 1) },
            { key: 'Shift-Tab', run: () => this.tableTab(-1) || markdownIndent(this.view, -1) },
            { key: 'Mod-s', preventDefault: true, run: () => { void this.save(); return true; } },
            { key: 'Mod-f', preventDefault: true, run: () => { this.openFindBar(); return true; } },
            { key: 'Mod-h', preventDefault: true, run: () => { this.openFindBar(undefined, true); return true; } },
            { key: 'Mod-b', run: () => this.formatKey('bold') },
            { key: 'Mod-i', run: () => this.formatKey('italic') },
            { key: 'Mod-k', run: () => this.formatKey('link') },
            { key: 'Shift-Mod-k', run: () => this.formatKey('inlineCode') },
            { key: 'Mod-1', run: () => this.formatKey('h1') },
            { key: 'Mod-2', run: () => this.formatKey('h2') },
            { key: 'Mod-3', run: () => this.formatKey('h3') },
            { key: 'Mod-4', run: () => this.formatKey('h4') },
          ]),
          blockInteractions,
          EditorView.updateListener.of(u => {
            if (u.selectionSet) {
              const head = u.state.selection.main.head;
              const ln = u.state.doc.lineAt(head);
              this.cursor = { line: ln.number, col: head - ln.from + 1 };
              if (!u.docChanged) this.reportStatus();
            }
            if (!u.docChanged) return;
            // 冻结块 DOM 时仍映射表格位置，否则表格前的改动会让格内提交写错范围。
            if (u.state.field(compositionActive)) for (const box of this.host.querySelectorAll<HTMLElement>('.mdir-tablebox')) {
              box.dataset.mdTableFrom = String(u.changes.mapPos(Number(box.dataset.mdTableFrom), 1));
              box.dataset.mdTableTo = String(u.changes.mapPos(Number(box.dataset.mdTableTo), -1));
            }
            this.tracker.patchStats(u);
            const wasDirty = this.dirty;
            this.dirty = true;
            // 脏状态参与同步离开守卫，不能等待字数统计防抖。
            if (!wasDirty) this.reportStatus();
            this.tracker.noteChange(u);
            this.tracker.scheduleStats(() => {
              if (!this.destroyed) this.reportStatus();
            });
            this.tracker.scheduleHeadings();
          }),
        ],
      }),
    });

    // Ctrl/Cmd 在 mousedown 路由，后续 click 只阻止默认导航，避免打开两次。
    let routedLink: Element | null = null;
    // 在CM鼠标选区更新/装饰展开之前读取链接源位置。
    this.view.contentDOM.addEventListener('mousedown', e => {
      routedLink = null;
      // 保留链接 DOM 至 click；否则 CM 的选区更新会先把链接展开为源码。
      if (e.button === 0 && !(e.ctrlKey || e.metaKey) && (e.target as Element | null)?.closest('a.mdir-link[href]')) {
        e.preventDefault(); e.stopPropagation();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
      const el = e.target as HTMLElement | null;
      const equation = el?.closest('.md-render-target[data-render-kind="math"] a[href]');
      if (equation) {
        e.preventDefault(); e.stopPropagation();
        const id = decodeLocalRef((equation.getAttribute('href') ?? '').slice(1));
        if (!id.startsWith('mjx-eqn:')) return;
        const label = id.slice('mjx-eqn:'.length), index = this.view.state.field(referenceField);
        for (const block of index.metadata.renderBlocks) {
          if (block.kind !== 'math') continue;
          const from = currentPosition(index, block.from), to = currentPosition(index, block.to);
          const source = this.view.state.doc.sliceString(from, to);
          if (![...source.matchAll(/\\label\s*\{([^{}]+)\}/g)].some(match => match[1] === label)) continue;
          this.view.dispatch({ selection: { anchor: Math.min(this.view.state.doc.length, from + 1) }, scrollIntoView: true });
          this.view.focus(); break;
        }
        return;
      }
      if (!el?.closest?.('.mdir-link')) return;
      const pos = this.view.posAtDOM(el);
      let link: SyntaxNode | null = syntaxTree(this.view.state).resolveInner(Math.min(this.view.state.doc.length, pos + 1), 1);
      while (link && !['Link', 'Autolink', 'Image', 'URL'].includes(link.name)) link = link.parent;
      if (link?.name === 'URL' && link.parent && ['Link', 'Autolink', 'Image'].includes(link.parent.name)) link = link.parent;
      if (!link) return;
      const href = linkUrlOfNode(link, this.view.state.doc, () => referenceUrls(this.view.state));
      if (!href) return;
      e.preventDefault();
      routedLink = el.closest('a.mdir-link[href]');
      this.openLink(href);
    }, true);
    this.view.contentDOM.addEventListener('click', event => {
      const link = (event.target as Element | null)?.closest('a.mdir-link[href]');
      if (link) {
        event.preventDefault(); event.stopPropagation();
        if (link !== routedLink) this.openLink(link.getAttribute('href') ?? '', event.ctrlKey || event.metaKey);
        routedLink = null;
        return;
      }
      if ((event.target as Element | null)?.closest('.md-render-target[data-render-kind="math"] a[href]')) event.preventDefault();
    }, true);

    // 右键格式菜单（规则 17：与源码态右键同一 runMdFormat 实现；尾部「Markdown 模式 ▸」同构）。
    // 表格件上右键（块非活动）前置「表格 ▸」行列增删（规则 23 M2）；图片件上右键前置
    // 「上传到图床」（009 规则 4 触发③，未配置图床时 app 侧返回 null 即无改写）
    this.view.contentDOM.addEventListener('mousedown', e => {
      if (e.button === 2 && (e.target as HTMLElement | null)?.closest('.mdir-imgbox')) e.preventDefault();
    }, true);
    this.view.contentDOM.addEventListener('contextmenu', e => {
      if (!this.opts.showMenu) return;
      e.preventDefault();
      const items = this.contextMenuItems();
      const target = e.target as HTMLElement | null;
      const pos = target?.closest('.mdir-link')
        ? this.view.posAtDOM(target.closest('.mdir-link')!) + 1
        : this.view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos !== null && pos !== undefined) {
        let link: SyntaxNode | null = syntaxTree(this.view.state).resolveInner(Math.min(this.view.state.doc.length, pos), 1);
        while (link && !['Link', 'Autolink', 'URL', 'Image'].includes(link.name)) link = link.parent;
        if (link?.name === 'URL' && link.parent && ['Link', 'Autolink', 'Image'].includes(link.parent.name)) link = link.parent;
        const href = link && link.name !== 'Image'
          ? linkUrlOfNode(link, this.view.state.doc, () => referenceUrls(this.view.state)) : null;
        if (href && isExternalHref(href)) items.unshift([t('md.openExternal'), () => this.openLink(href)]);
      }
      const cell = (e.target as HTMLElement | null)?.closest?.('td,th') as HTMLTableCellElement | null;
      if (cell?.closest('.mdir-tablebox')) {
        const tr = cell.closest('tr');
        const table = cell.closest('table');
        if (tr && table) {
          const domRow = tableRowNumber(cell);
          if (domRow >= 0) items.unshift(tableMenuItems(this.view, this.host, this.isReadOnly, domRow, cell.cellIndex, Number(cell.closest<HTMLElement>('.mdir-tablebox')!.dataset.mdTableFrom))[0]!);
        }
      } else {
        const imgEl = (e.target as HTMLElement | null)?.closest?.('img') as HTMLImageElement | null;
        if (
          imgEl?.closest('.mdir-imgbox') && this.opts.onUploadImage
          && (this.opts.canUploadImage?.() ?? true)
        ) {
          items.unshift([
            t('ctx.uploadImage'),
            () => { void this.uploadImageAt(imgEl); },
          ]);
        }
      }
      this.opts.showMenu(items, e.clientX, e.clientY);
    });
  }

  private openLink(href: string, ctrl = true): void {
    routeLinkHref(href, ctrl, {
      baseDir: () => this.baseDir(),
      openExternal: url => this.opts.openExternal?.(url),
      openMarkdown: path => this.opts.openMarkdown?.(path),
      hint: () => {}, interactive: true,
    }, this.host);
  }

  /**
   * 右键图片「上传到图床」（009 规则 4 触发③）：取图片件处 Image 节点的原始引用 →
   * app 侧上传 → 单事务改写 URL 子节点区间（保 alt/title，userEvent 'input' 单步撤销）。
   * 上传期间文档可能已变：改写前按原始引用重扫树定位现区间，找不到（引用已被删改）即放弃。
   */
  private async uploadImageAt(el: HTMLImageElement): Promise<void> {
    if (this.isReadOnly) return;
    if (!this.opts.onUploadImage) return;
    const sourceFrom = el.closest<HTMLElement>('[data-md-from]')?.dataset.mdFrom;
    const pos = sourceFrom !== undefined ? Number(sourceFrom) + 1 : this.view.posAtDOM(el);
    let n: SyntaxNode | null = syntaxTree(this.view.state).resolveInner(pos, 1);
    while (n && n.name !== 'Image') n = n.parent;
    if (!n) return;
    const ref = linkUrlOfNode(n, this.view.state.doc, () => referenceUrls(this.view.state));
    if (!ref || /^(https?:|data:|asset:|blob:|\/\/)/i.test(ref)) return; // 仅本地相对引用
    let urlNode: SyntaxNode | null = null;
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === 'URL') { urlNode = c; break; }
    const close = n.getChildren('LinkMark').find(mark => this.view.state.doc.sliceString(mark.from, mark.to) === ']');
    if (!urlNode && !close) return;
    // 引用式图片只改当前图片为行内引用，避免修改共享定义而误改其他图片。
    const prefix = !urlNode ? this.view.state.doc.sliceString(n.from, close!.to) : '';
    const title = !urlNode ? this.view.state.field(referenceField).titles.get(referenceLabel(n, this.view.state.doc)) : '';
    const target = trackImageTarget(this.view, urlNode?.from ?? n.from, urlNode?.to ?? n.to);
    let newUrl: string | null;
    let range: { from: number; to: number } | null = null;
    try { newUrl = await this.opts.onUploadImage(ref); range = target.range(); }
    finally { target.dispose(); }
    if (!newUrl || this.destroyed || !range) return;
    this.view.dispatch({
      changes: { ...range, insert: urlNode ? newUrl : `${prefix}(${newUrl}${title ? ' ' + title : ''})` },
      userEvent: 'input',
    });
  }

  /** 编辑组 / 格式 ▸ / 段落 ▸ / Markdown 模式 ▸（app 注入） */
  private contextMenuItems(): CtxMenuItem[] {
    const fmt: CtxMenuLeaf[] = MD_INLINE_COMMANDS.map(([cmd, key]) => [t(key), this.isReadOnly ? null : () => this.runFormat(cmd), cmd]);
    const para: CtxMenuLeaf[] = MD_BLOCK_COMMANDS.map(([cmd, key]) => [t(key), this.isReadOnly ? null : () => this.runFormat(cmd),
      cmd === 'table' || cmd === 'codeBlock' ? cmd : cmd.startsWith('h') && cmd !== 'hr' ? 'heading' : undefined]);
    const items: CtxMenuItem[] = [
      [t('act.undo'), this.isReadOnly ? null : () => this.cmUndo()],
      [t('act.redo'), this.isReadOnly ? null : () => this.cmRedo()],
      [t('act.cut'), this.isReadOnly ? null : () => this.cmCut()],
      [t('act.copy'), () => { this.view.focus(); document.execCommand('copy'); }],
      [t('act.paste'), this.isReadOnly ? null : () => this.cmPaste()],
      [t('act.selectAll'), () => { this.view.focus(); selectAll(this.view); }],
      [t('act.find'), () => this.openFindBar()],
      [t('act.replace'), this.isReadOnly ? null : () => this.openFindBar(undefined, true)],
      'sep',
      [t('ctx.format'), () => void 0, fmt],
      [t('ctx.paragraph'), () => void 0, para],
    ];
    return items.concat(this.opts.modeMenuItems?.() ?? []);
  }

  // ---- 表格交互（规则 23 M2 / AC-27；实现外置 live-table-actions.ts，行为不变） ----

  /** 活动表格内 Tab/Shift+Tab 导航/加行加列（键位入口；委托 live-table-actions）。 */
  private tableTab(dir: 1 | -1): boolean {
    if (!this.view) return false;
    return tableTabNav(this.view, dir);
  }

  private reportStatus(): void {
    this.opts.onStatus({ dirty: this.dirty, ...this.tracker.stats, ...this.cursor });
  }

  // ---- 对外 API（与旧 WysiwygView 表面对齐 + 引擎新增） ----

  getMarkdown(): string {
    return this.view?.state.doc.toString() ?? '';
  }

  /** 内容体量廉价估计（autosave sizeHint）：O(1)，不做全文序列化 */
  contentSizeHint(): number {
    return this.view ? this.view.state.doc.length : 0;
  }

  /** 自动快照分段取值，避免大 Markdown 在定时器回调中同步复制整篇文档。 */
  snapshotContent(): Promise<string> {
    return snapshotDocument(this.view?.state.doc ?? { length: 0, sliceString: () => '' });
  }

  contentRevision(): number {
    return this.tracker.linesVer;
  }

  /** 格式命令统一入口（规则 17：源码编辑面/IR 右键/IR 工具栏三上下文同一 runMdFormat） */
  runFormat(cmd: MdFormatCmd): void {
    if (!this.view || this.isReadOnly || isComposing(this.view)) return;
    if (cmd === 'link') { editMarkdownLink(this.view, () => !this.destroyed && !this.isReadOnly); return; }
    const selection = this.view.state.selection.main, mark = inlineFormatMarks[cmd];
    if (mark && selection.empty && this.view.state.selection.ranges.length === 1) {
      const current = this.view.state.field(inlineFormatField);
      if (current?.pending) {
        // 待输入态：定界符尚未写入文档，组合/取消都是纯状态切换
        const marks = current.marks.includes(mark)
          ? current.marks.filter(item => item !== mark) : [...current.marks, mark];
        this.view.dispatch(marks.length
          ? { effects: inlineFormatChanged.of({ ...current, marks }) }
          : { effects: inlineFormatChanged.of(null), selection: { anchor: selection.head } });
      } else if (current) {
        const size = inlineFormatOpen(current).length, closeFrom = current.to - (current.trailing ?? 0) - size;
        if (selection.head >= closeFrom && current.marks.includes(mark)) {
          // 已生效格式的末尾边界按同一格式：退出该格式，不解除已写内容
          const rest = current.marks.filter(item => item !== mark);
          this.view.dispatch(rest.length
            ? { selection: { anchor: current.to }, effects: inlineFormatChanged.of({ from: current.to, to: current.to, marks: rest, pending: true }) }
            : { effects: inlineFormatChanged.of(null), selection: { anchor: current.to } });
        } else if (current.from < selection.head) {
          // 词中间或末尾边界按新格式：叠加进当前格式区（如 **abc** 内按斜体 → ***abc***）
          combineLiveMark(this.view, current, mark);
        } else {
          this.view.dispatch({ effects: inlineFormatChanged.of({ from: selection.head, to: selection.head, marks: [mark], pending: true }) });
        }
      } else this.view.dispatch({ effects: inlineFormatChanged.of({ from: selection.head, to: selection.head, marks: [mark], pending: true }) });
      this.view.focus(); return;
    }
    this.view.focus();
    runMdFormat(this.view, cmd);
    if (mark) {
      const range = this.view.state.selection.main;
      if (range.from >= mark.length && this.view.state.doc.sliceString(range.from - mark.length, range.from) === mark)
        this.view.dispatch({ effects: inlineFormatChanged.of({ from: range.from - mark.length, to: range.to + mark.length, marks: [mark], pending: false }) });
    }
    this.view.focus();
  }

  private formatKey(cmd: MdFormatCmd): boolean {
    this.runFormat(cmd);
    return true;
  }

  cmUndo(): void {
    if (this.view) undo(this.view);
  }

  cmRedo(): void {
    if (this.view) redo(this.view);
  }

  cmCut(): void {
    if (!this.view || this.isReadOnly || isComposing(this.view)) return;
    const view = this.view, state = view.state, doc = state.doc;
    const text = view.state.selection.ranges.map(r => doc.sliceString(r.from, r.to)).join('\n');
    if (!text) return;
    void writeClipboardText(text).then(() => {
      if (this.destroyed || this.isReadOnly || view.state !== state || isComposing(view)) return;
      view.dispatch({ ...view.state.replaceSelection(''), userEvent: 'delete.cut' }); view.focus();
    });
  }

  cmPaste(): void {
    if (!this.view || this.isReadOnly || isComposing(this.view)) return;
    const view = this.view, state = view.state;
    void readClipboardText().then(text => {
      if (!text || this.destroyed || this.isReadOnly || view.state !== state || isComposing(view)) return;
      view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input.paste' }); view.focus();
    });
  }

  /** 打开就地查找栏（规则 20 v0.16：不再切源码承载；seed 回填选词） */
  openFindBar(seed?: string, withReplace = false): void {
    if (!this.findBar) return;
    let s = seed;
    if (s === undefined && this.view) {
      const sel = this.view.state.selection.main;
      s = this.view.state.sliceDoc(sel.from, sel.to).slice(0, 200);
    }
    this.findBar.show(s ?? '', withReplace);
  }

  /** F3/Shift+F3：栏未开时打开（选词回填），已开时步进 */
  findStep(dir: 1 | -1): void {
    if (!this.findBar) return;
    if (!this.findBar.visible) {
      this.openFindBar();
      return;
    }
    void this.findBar.go(dir);
  }

  /** 大纲点击联动（规则 3）：按标题序号定位源文本行（extractHeadings 行号直用，比 DOM 匹配稳） */
  scrollToHeading(index: number): void {
    const h = this.tracker.headings[index];
    if (!this.view || !h) return;
    this.goToLine(h.line + 1);
    // 跳转闪示（2026-10-26）：正文无指示的问题——目标标题行短暂高亮脉冲，与侧栏选中条呼应
    const line = this.view.state.doc.line(h.line + 1);
    const pos = this.view.domAtPos(line.from);
    const el = (pos.node instanceof Element ? pos.node : pos.node.parentElement)?.closest('.cm-line') as HTMLElement | null;
    if (el) {
      el.classList.remove('mdir-flash');
      void el.offsetWidth; // 重启动画
      el.classList.add('mdir-flash');
      window.setTimeout(() => el.classList.remove('mdir-flash'), 1500);
    }
  }

  goToLine(number: number): void {
    if (!this.view || !Number.isFinite(number)) return;
    const line = this.view.state.doc.line(Math.max(1, Math.min(Math.trunc(number), this.view.state.doc.lines)));
    this.view.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
    this.view.focus();
  }

  /** 当前文档全文（草稿另存为等 shell 侧收口用；与 saveCurrent 同一读取口径） */
  getContent(): string {
    return this.view?.state.doc.toString() ?? '';
  }

  save(): Promise<void> {
    const task = this.saveQueue.then(() => this.saveCurrent());
    this.saveQueue = task.catch(() => {});
    return task;
  }

  relocate(path: string, move: () => Promise<void>): Promise<void> {
    const task = this.saveQueue.then(async () => { await move(); this.opts.path = path; });
    this.saveQueue = task.catch(() => {});
    return task;
  }

  private async saveCurrent(): Promise<void> {
    if (this.isReadOnly) return;
    if (this.destroyed || !this.view) return;
    const savedDoc = this.view.state.doc;
    let content = savedDoc.toString();
    if (this.opts.path.startsWith('draft://')) { this.opts.onSaveAsNeeded?.(content); return; }
    // 行尾保留（002 规则 4 v1.4）：按打开时主类型回写
    if (this.newline === 'crlf') content = content.replace(/\r\n|\r|\n/g, '\r\n');
    else if (this.newline === 'cr') content = content.replace(/\r\n|\r|\n/g, '\r');
    try {
      const stat = await textSave(this.opts.path, content, this.opts.encoding);
      const clean = !this.destroyed && this.view.state.doc === savedDoc;
      if (clean) this.dirty = false;
      if (!this.destroyed) this.reportStatus();
      this.opts.onSaved(this.opts.path, stat, clean);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('UNMAPPABLE')) {
        const ok = this.opts.onConfirm
          ? await this.opts.onConfirm(t('md.unmappableAsk'))
          : confirm(msg);
        if (ok) {
          try {
            const stat = await textSave(this.opts.path, content, 'UTF-8');
            this.opts.encoding = 'UTF-8';
            const clean = !this.destroyed && this.view.state.doc === savedDoc;
            if (clean) this.dirty = false;
            if (!this.destroyed) this.reportStatus();
            this.opts.onSaved(this.opts.path, stat, clean);
          } catch (err2) {
            const msg2 = String(err2);
            (this.opts.onAlert ?? alert)(msg2.includes('EXTERNAL_CHANGED') ? t('err.saveConflict') : tf('err.saveFail', msg2));
          }
        }
      } else {
        (this.opts.onAlert ?? alert)(msg.includes('EXTERNAL_CHANGED') ? t('err.saveConflict') : tf('err.saveFail', msg));
      }
    }
  }

  destroy(): void {
    this.tracker.dispose();
    this.destroyed = true;
    this.stopParseWarmup?.();
    this.stopParseWarmup = null;
    try {
      this.view?.destroy();
    } catch {
      /* 销毁竞态不打扰 */
    }
    this.host.classList.remove('md-ir');
    this.host.innerHTML = '';
  }
}
