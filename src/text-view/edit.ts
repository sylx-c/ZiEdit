// edit —— CM6 编辑缓冲（005 列选择 v1.0 + 002 规则 15 折叠的载体）
// 决策 006：列选择在 CodeMirror 6 之上实现；查看路径（大文件）仍走 TextView（Alt+拖拽矩形复制）。
// v1.0：Alt+拖拽任何时候产生矩形选区；列模式开启后普通拖拽也矩形化；
// 列命令收进编辑右键"列操作"子菜单，行批处理进编辑菜单"行批处理"子菜单（悬浮工具条取消）。
import { bufferHistory, ReadOnlyControl, type EditorBuffer } from '../common/editor-buffer';
import { startParseWarmup } from '../common/parse-warmup';
import { safeSyntaxLanguage } from './language-guard';
import { compositionGuard, isComposing } from '../common/composition';
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, RangeSet, findClusterBreak, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, gutter, GutterMarker, drawSelection, rectangularSelection, crosshairCursor, highlightActiveLine, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, redoSelection, selectAll, undo, undoSelection } from '@codemirror/commands';
import { foldGutter, foldKeymap, syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { highlightSelectionMatches } from '@codemirror/search';
import { textReadAll, textSave, textOpen } from '../common/ipc';
import { t, tf } from '../common/i18n';
import { INVISIBLE_RE } from './view';
import { runMdFormat, type MdFormatCmd } from '../markdown-view/mdformat';
import { parsePairs, replaceDocLines, replaceInLine, type ReplaceOpts } from './replace';
import {
  markRectCopy,
  wasRectCopy,
  rectFromCells,
  rectOf,
  rectText,
  visualColOf,
  charAtVisualCol,
  visualWidth,
  rectSum,
  insertColumnChanges,
  rectPointerPlan,
  rectSelectionCleared,
  planColumnPaste,
  columnPasteChanges,
  autoScrollBeyond,
  rectInsertBlankChanges,
  rectNumberChanges,
  sortColumnBlock,
  dedupeColumnBlock,
  padColumnBlock,
  type RectSpan,
} from './rect';
import { Minimap } from './minimap';
import { FindBar, buildNeedleRe, type FindRunResult } from './findbar';
import { findAllIn } from '../common/findall';
import { convertEol } from '../common/text';
import { readClipboardText, writeClipboardText } from '../common/clipboard';
import { hasHighlightParser, highlightLines, loadHighlightParser, type Span } from './highlight';
import { snapshotDocument } from '../common/snapshot';

export const EDIT_LIMIT = 10 * 1024 * 1024; // CM6 文档实际上限（与 002/007 编辑缓冲口径一致：10MB）

// ---- P1-2：编辑态命中三色高亮（002 规则 7 v2.4）----
// @codemirror/search 的命中装饰只在「它的面板打开」时渲染（highlight() 开头 if (!panel)
// return none），本应用 FindBar 是自绘的、从不打开 CM 面板——依赖 setSearchQuery 的高亮
// 从没亮过（实测 cm-searchMatch 恒 0）。自建视口高亮器：全部命中 mark cm-searchMatch，
// 与选区重合的当前命中加 cm-searchMatch-selected（三色令牌与查看态同源，styles.css）。
/** 查询变化信号（FindBar.onHighlightAll 记录 findQuery 后派发，触发装饰重建） */
const findQueryChanged = StateEffect.define<null>();
const toggleBookmark = StateEffect.define<number>();
const bookmarkMarker = new class extends GutterMarker {
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-bookmark-marker';
    el.textContent = '•';
    return el;
  }
}();

interface FindQueryState {
  needle: string;
  opts: { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
}

function buildMatchDeco(view: EditorView, q: FindQueryState | null): DecorationSet {
  if (!q) return Decoration.none;
  const marks: ReturnType<ReturnType<typeof Decoration.mark>['range']>[] = [];
  const sel = view.state.selection.main;
  const seen = new Set<number>();
  try {
    for (const range of view.visibleRanges) {
      const first = view.state.doc.lineAt(range.from).number;
      const last = view.state.doc.lineAt(range.to).number;
      for (let n = first; n <= last; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        const line = view.state.doc.line(n);
        for (const m of findAllIn(line.text, q.needle, q.opts)) {
          if (m.to === m.from) continue;
          const from = line.from + m.from;
          const to = line.from + m.to;
          const cur = sel.from === from && sel.to === to;
          marks.push(
            Decoration.mark({ class: cur ? 'cm-searchMatch cm-searchMatch-selected' : 'cm-searchMatch' }).range(from, to)
          );
        }
      }
    }
  } catch {
    return Decoration.none;
  }
  return Decoration.set(marks, true);
}

/** 视口命中高亮器（FindBar 的「全部高亮」在编辑态的承载；闭包取宿主 EditView 的 findQuery） */
function matchHighlighter(getQuery: () => FindQueryState | null): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildMatchDeco(view, getQuery());
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.transactions.some(tr => tr.effects.some(e => e.is(findQueryChanged)))
        ) {
          this.decorations = buildMatchDeco(u.view, getQuery());
        }
      }
    },
    { decorations: v => v.decorations }
  );
}

/** 不可见字符装饰构建（002 规则 25）：视口内 INVISIBLE_RE 命中字符逐段打标，
 *  悬停 title 显码位（与查看面 renderLineHtml 同一判据与文案）。 */
function buildInvisibleDeco(view: EditorView): DecorationSet {
  const marks: ReturnType<ReturnType<typeof Decoration.mark>['range']>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos < to; ) {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      for (let i = 0; i < text.length; i++) {
        if (INVISIBLE_RE.test(text[i]!)) {
          let j = i + 1;
          while (j < text.length && INVISIBLE_RE.test(text[j]!)) j++;
          const cp = text.codePointAt(i)!.toString(16).toUpperCase().padStart(4, '0');
          marks.push(
            Decoration.mark({ class: 'cm-invisible', attributes: { title: tf('tv.invisibleChar', cp) } })
              .range(line.from + i, line.from + j)
          );
          i = j;
        }
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(marks, true);
}

/** 编辑面不可见字符高亮（002 规则 25，W2 清偿）：与查看面 tv-invisible 同观感 */
function invisibleMarkers(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildInvisibleDeco(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = buildInvisibleDeco(u.view);
      }
    },
    { decorations: v => v.decorations }
  );
}

/** 行批处理操作集（005 规则 14；编辑菜单"行批处理 ▸"子菜单） */
export type LineBatchOp = 'sort' | 'dedupe' | 'removeEmpty' | 'trim' | 'tabsToSpaces' | 'spacesToTabs';

/** shell 命令面板与右键列操作共用；接线层只负责提供当前 EditView。 */
export const columnCommands = [
  { id: 'column.fill', label: '填充列', run: (v: EditView) => v.cmdFill() },
  { id: 'column.number', label: '插入列编号', run: (v: EditView) => v.cmdNumbering() },
  { id: 'column.upper', label: '选区大写', run: (v: EditView) => v.cmdCase('upper') },
  { id: 'column.lower', label: '选区小写', run: (v: EditView) => v.cmdCase('lower') },
  { id: 'column.delete', label: '删除列', run: (v: EditView) => v.cmdDelete() },
  { id: 'column.cut', label: '剪切列', run: (v: EditView) => v.cmdCut() },
  { id: 'column.paste', label: '粘贴列', run: (v: EditView) => v.cmdPaste({ force: true }) },
  { id: 'column.sum', label: '求和选区', rectOnly: true, run: (v: EditView) => v.cmdSum() },
  { id: 'column.left', label: '列左对齐', rectOnly: true, run: (v: EditView) => v.cmdAlign('left') },
  { id: 'column.center', label: '列居中对齐', rectOnly: true, run: (v: EditView) => v.cmdAlign('center') },
  { id: 'column.right', label: '列右对齐', rectOnly: true, run: (v: EditView) => v.cmdAlign('right') },
  { id: 'column.sumInsert', label: '求和并插入到光标处', rectOnly: true, run: (v: EditView) => v.cmdSum(true) },
  { id: 'column.blank', label: '插入空列', rectOnly: true, run: (v: EditView) => v.cmdInsertBlankColumn() },
  { id: 'column.increment', label: '列内数字 +1', rectOnly: true, run: (v: EditView) => v.cmdChangeColumnNumbers(1) },
  { id: 'column.decrement', label: '列内数字 -1', rectOnly: true, run: (v: EditView) => v.cmdChangeColumnNumbers(-1) },
  { id: 'column.sortAsc', label: '按列升序', rectOnly: true, run: (v: EditView) => v.cmdSortColumn(false) },
  { id: 'column.sortDesc', label: '按列降序', rectOnly: true, run: (v: EditView) => v.cmdSortColumn(true) },
  { id: 'column.dedupe', label: '按列去重', rectOnly: true, run: (v: EditView) => v.cmdDedupeColumn() },
  { id: 'column.pad', label: '补齐固定列宽', rectOnly: true, run: (v: EditView) => v.cmdPadColumn() },
].map(cmd => ({ ...cmd, group: 'column' as const }));

export interface EditStatus {
  columnMode: boolean;
  ranges: number;
  selChars: number;
  dirty: boolean;
  /** 改写模式（005 规则 12，状态栏"插入"灯） */
  overwrite: boolean;
  /** 主光标位置（状态栏 行/列 格） */
  line: number;
  col: number;
  /** 打开时探测的行尾主类型（状态栏编辑态行尾格，002 规则 4 v1.4）；null=草稿/未知 */
  newline: string | null;
  /** 软换行开关（002 规则 11 v1.4：编辑态 lineWrapping，按标签记忆） */
  wrap: boolean;
  /** 活动矩形（005 v2.0：视觉列口径）尺寸——状态栏「N 行 × M 列」格；null=无矩形 */
  rect: { lines: number; cols: number } | null;
}

// 语言包动态加载（livepreview.ts:92-105 同款懒加载模式）：
// 语言扩展首次用到才动态 import，加载结果缓存复用；null/未知语言 → []（纯文本）。
const loadCpp = (): Promise<Extension[]> => import('@codemirror/lang-cpp').then(m => [m.cpp()]);
const LANG_LOADERS: Record<string, () => Promise<Extension[]>> = {
  JSON: () => import('@codemirror/lang-json').then(m => [m.json()]),
  JavaScript: () => import('@codemirror/lang-javascript').then(m => [m.javascript()]),
  TypeScript: () => import('@codemirror/lang-javascript').then(m => [m.javascript({ typescript: true })]),
  Markdown: () => import('@codemirror/lang-markdown').then(m => [m.markdown()]),
  YAML: () => import('@codemirror/lang-yaml').then(m => [m.yaml()]),
  XML: () => import('@codemirror/lang-xml').then(m => [m.xml()]),
  HTML: () => import('@codemirror/lang-html').then(m => [m.html()]),
  CSS: () => import('@codemirror/lang-css').then(m => [m.css()]),
  C: loadCpp,
  'C++': loadCpp,
  Python: () => import('@codemirror/lang-python').then(m => [m.python()]),
  Rust: () => import('@codemirror/lang-rust').then(m => [m.rust()]),
  Java: () => import('@codemirror/lang-java').then(m => [m.java()]),
  SQL: () => import('@codemirror/lang-sql').then(m => [m.sql()]),
};
const langExtCache = new Map<string, Extension[]>();
function loadLangExt(language: string | null): Promise<Extension[]> {
  if (language == null) return Promise.resolve([]);
  const loader = LANG_LOADERS[language];
  if (!loader) return Promise.resolve([]);
  const cached = langExtCache.get(language);
  if (cached) return Promise.resolve(cached);
  return loader().then(exts => {
    langExtCache.set(language, exts);
    return exts;
  });
}

/** 拖拽越界自动滚动（005 v2.0 规则 1）：指针超出滚动区上下边缘带时按越界距离比例滚动并回调重算矩形 */

export class EditView {
  view!: EditorView;
  private findBar: FindBar | null = null;
  /** 当前查找查询（P1-2：自建视口高亮器 matchHighlighter 的数据源，onHighlightAll 记录） */
  private findQuery: FindQueryState | null = null;
  private columnMode = false;
  /** 拖拽结束时记下的矩形。右键不得清掉；复制/删除/填充读它，不事后猜。 */
  private columnRect: RectSpan | null = null;
  private dragAnchor: { line: number; cell: number } | null = null;
  /** 右键按下期间为真，避免 CM 改选区时把矩形丢掉 */
  private preserveRect = false;
  private overwrite = false;
  private dirty = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private restoredBookmarks: number[] = [];
  private onBookmarksChange?: (path: string, bookmarks: number[]) => void;
  private locationHistory: number[] = [];
  private locationIndex = -1;
  private bookmarkState = StateField.define<readonly number[]>({
    create: state => this.restoredBookmarks.filter(n => n >= 1 && n <= state.doc.lines).map(n => state.doc.line(n).from),
    update: (positions, tr) => {
      let next = positions;
      if (tr.docChanged) next = [...new Set(positions.map(p => tr.newDoc.lineAt(tr.changes.mapPos(p, 1)).from))].sort((a, b) => a - b);
      for (const effect of tr.effects) {
        if (effect.is(toggleBookmark)) next = next.includes(effect.value)
          ? next.filter(p => p !== effect.value) : [...next, effect.value].sort((a, b) => a - b);
      }
      return next;
    },
  });
  private encoding: string;
  private path: string | null; // null = 草稿标签
  /** 持久化路径（只读暴露；app 侧脏缓冲守卫据此判定草稿/真实文件，#16） */
  get filePath(): string | null {
    return this.path;
  }
  private destroyed = false;
  private stopParseWarmup: (() => void) | null = null;
  /** 打开时探测的行尾主类型（保存时回写原行尾，002 规则 4 v1.4） */
  private newline: string | null = null;
  private newlineMixed = false;
  private mixedNoticed = false;
  /** 软换行（002 规则 11 v1.4） */
  private wrapOn = false;
  /** init() 挂载用初始开关（构造参数 opts 不入 init 作用域；002 规则 10/13/25 W2 清偿） */
  private initShowLineNumbers = true;
  private initSelectionHl = true;
  private initInvisible = false;
  private wrapComp = new Compartment();
  /** 行号可见性（002 规则 10：默认开可切——Compartment 动态增删 lineNumbers 扩展） */
  private lnComp = new Compartment();
  /** 选中词高亮相同词可关（002 规则 13 v2.8） */
  private selHlComp = new Compartment();
  /** 不可见字符高亮（002 规则 25，编辑面） */
  private invisibleComp = new Compartment();
  private buffer?: EditorBuffer;
  private readOnlyControl = new ReadOnlyControl();
  get isReadOnly(): boolean { return this.readOnlyControl.enabled; }
  setReadOnly(on: boolean): void { this.readOnlyControl.set(this.view, on); this.report(); }

  constructor(
    private host: HTMLElement,
    opts: {
      path: string | null;
      language: string | null;
      encoding: string;
      initialDoc?: string;
      buffer?: EditorBuffer;
      readOnly?: boolean;
      /** 以 initialDoc 恢复（崩溃恢复）：起始即脏（002 规则 29） */
      startDirty?: boolean;
      /** 初始软换行（按标签记忆） */
      wrap?: boolean;
      /** 初始行号可见性（002 规则 10；缺省开） */
      showLineNumbers?: boolean;
      /** 初始选中词高亮开关（002 规则 13；缺省开） */
      selectionHl?: boolean;
      /** 初始不可见字符高亮（002 规则 25；缺省关） */
      invisibleOn?: boolean;
      onStatus: (s: EditStatus) => void;
      onDirtyTitle?: () => void;
      onSaveAsNeeded: (content: string) => void; // 草稿保存 / 另存
      /** 轻提示（非模态；行尾 mixed 保存提示等） */
      onFlash?: (msg: string) => void;
      /** 应用内对话框注入（001 规则 24：不使用系统弹窗；缺省回退系统对话框） */
      onAlert?: (msg: string) => void;
      onConfirm?: (msg: string) => Promise<boolean>;
      onPrompt?: (title: string, def?: string) => Promise<string | null>;
      /** 右键菜单（app 侧统一菜单组件；不传则用浏览器默认菜单） */
      onContextMenu?: (x: number, y: number) => void;
      /** 字号（001 规则 31：10–18，持久化值传入） */
      fontSize?: number;
      /** Ctrl+滚轮缩放回调（app 侧持久化并同步查看态） */
      onFontSize?: (n: number) => void;
      /** 保存成功收口（H-6c）：真实写盘后回调 shell，由它刷新 mtime 基线/文件大小并弃掉该路径的
       *  崩溃恢复快照。必须挂在 save() 内部而不是各调用点——本视图的保存入口有三处
       *  （CM 键位 Mod-s、shell 菜单/工具栏 requestSave、脏缓冲守卫），调用点收口正是历来的漏网处：
       *  基线不刷新，2 秒轮询会把自己刚写的 mtime 当外部修改，轻则闪「已重新加载」并白读一遍盘、
       *  重则把用户这两秒内的新输入标成「外部修改」弹框。 */
      onSaved: (path: string, stat?: { len: number; modifiedMs: number }, clean?: boolean) => void;
      /** 编辑器就绪回调（CM 挂载完成；app 侧消费列模式切换/首字符补插等挂载后动作，替代定时器竞态） */
      onReady?: (view: EditView) => void;
      /** 文档变更信号（docChanged；分屏右侧防抖重渲染跟随用，007 v0.8 规则 6） */
      onDocChange?: () => void;
      restoreBookmarks?: number[];
      onBookmarksChange?: (path: string, bookmarks: number[]) => void;
    }
  ) {
    this.path = opts.path;
    this.encoding = opts.encoding;
    this.fontSize = opts.fontSize ?? 12;
    this.initShowLineNumbers = opts.showLineNumbers !== false;
    this.initSelectionHl = opts.selectionHl !== false;
    this.initInvisible = opts.invisibleOn === true;
    this.onStatus = opts.onStatus;
    this.onSaveAsNeeded = opts.onSaveAsNeeded;
    this.onFlash = opts.onFlash;
    this.onAlert = opts.onAlert;
    this.onConfirm = opts.onConfirm;
    this.onPrompt = opts.onPrompt;
    this.onContextMenu = opts.onContextMenu;
    this.onFontSize = opts.onFontSize;
    this.onSaved = opts.onSaved;
    this.onReady = opts.onReady;
    this.onDocChange = opts.onDocChange;
    this.restoredBookmarks = [...new Set(opts.restoreBookmarks ?? [])].sort((a, b) => a - b);
    this.onBookmarksChange = opts.onBookmarksChange;
    this.wrapOn = !!opts.wrap;
    this.buffer = opts.buffer;
    this.readOnlyControl.enabled = !!opts.readOnly;
    this.dirty = opts.buffer?.dirty ?? !!opts.startDirty;
    void this.init(opts.buffer?.state.doc.toString() ?? opts.initialDoc);
  }

  private onStatus: (s: EditStatus) => void;
  private onSaveAsNeeded: (content: string) => void;
  private onFlash?: (msg: string) => void;
  private onAlert?: (msg: string) => void;
  private onConfirm?: (msg: string) => Promise<boolean>;
  private onPrompt?: (title: string, def?: string) => Promise<string | null>;
  private onContextMenu?: (x: number, y: number) => void;
  private onFontSize?: (n: number) => void;
  private onSaved: (path: string, stat?: { len: number; modifiedMs: number }, clean?: boolean) => void;
  private onReady?: (view: EditView) => void;
  private onDocChange?: () => void;

  private async ask(title: string, def?: string): Promise<string | null> {
    if (this.onPrompt) return this.onPrompt(title, def);
    return prompt(title, def);
  }

  private async confirmBox(msg: string): Promise<boolean> {
    if (this.onConfirm) return this.onConfirm(msg);
    return confirm(msg);
  }

  private alertBox(msg: string): void {
    if (this.onAlert) this.onAlert(msg);
    else alert(msg);
  }

  private async init(doc: string | undefined): Promise<void> {
    if (this.destroyed) return;
    let text = doc ?? '';
    if (this.path) {
      let tooLarge = false;
      try {
        // 行尾基线（002 规则 4 v1.4）：保存时按主类型回写，编辑不再静默改 LF
        const info = await textOpen(this.path);
        this.newline = info.newline;
        this.newlineMixed = !!info.mixed;
        tooLarge = info.len > EDIT_LIMIT;
      } catch {
        /* 探测失败不阻断编辑；保存按 LF 原样 */
      }
      if (doc === undefined) {
        // 恢复竞态（走查 H1 根修）：>10MB 文件在 fileSizes 就绪前会被误挂编辑面，
        // ensureFileMeta 就绪后即刻重挂流式面；尺寸已知就别发起注定超 EDIT_LIMIT 的整读。
        if (tooLarge) return;
        try {
          text = await textReadAll(this.path, this.encoding);
        } catch (err) {
          // 挂载竞态闸（走查 H1 根修）：恢复 >10MB 文件时 fileSizes 未就绪会先误挂编辑面，
          // 元数据就绪后 destroy 本视图重挂流式面；迟到的拒绝不得再写 host——host 即共享
          // viewarea（app.ts 传入），textContent= 会抹掉新视图 DOM 只留错误文本。
          if (this.destroyed) return;
          this.host.textContent = tf('err.readFail', String(err));
          return;
        }
      }
    }
    if (this.destroyed) return;
    // 统一查找栏 FindBar（002 规则 7 v1.3：替代 CM 英文搜索面板；SearchCursor 实现计数与导航）
    this.findBar = new FindBar({
      hasScope: () => !!this.columnRect && this.columnRect.colEnd > this.columnRect.colStart,
      run: (needle, opts, dir, count, jump) => this.fbRun(needle, opts, dir, count, jump),
      onHighlightAll: (needle, opts) => {
        if (!this.view) return;
        // P1-2 根修：@codemirror/search 的命中装饰只在「面板打开」时渲染（其 highlight()
        // 开头 if (!panel) return none），ZiEdit 用自绘 FindBar 不开 CM 面板——依赖 setSearchQuery
        // 的高亮从来没亮过。改为自建视口高亮器（matchHighlighter，见 extensions），此处只记查询。
        this.findQuery = needle ? { needle, opts: { ...opts } } : null;
        this.view.dispatch({ effects: findQueryChanged.of(null) });
      },
      onClosed: () => this.view?.focus(),
      // B-3 替换行（#8）：合并进 FindBar；单次/全部替换各一次 dispatch = 单步 undo
      // 005 v2.0：「仅选区内」勾选且矩形活动时按逐行视觉列窗口限定（002 规则 28 同源语义）
      onReplaceNext: (needle, replacement, opts) => {
        if (!this.view) return false;
        const scope = this.findBar?.scopeEnabled ? this.columnRect : null;
        if (scope) {
          const one = this.scopedReplaceOne(needle, replacement, opts, scope);
          if (!one) return false;
          this.applyLineChanges([one]);
          return true;
        }
        // P1-2（002 规则 22 v2.4）：替换「当前/下一个」命中并前进，与查找导航共用选区游标——
        // 修前 replaceFirst 永远替换全文档第一个命中，用户查到第 N 处点「替换」改的是第 1 处。
        const state = this.view.state;
        const docText = state.doc.toString();
        const sel = state.selection.main;
        const base = buildNeedleRe(needle, opts);
        const g = new RegExp(base.source, base.flags.includes('g') ? base.flags : base.flags + 'g');
        let target: RegExpExecArray | null = null;
        let m: RegExpExecArray | null;
        while ((m = g.exec(docText)) != null) {
          if (m.index >= sel.from) {
            target = m; // 光标处/之后的首个命中（选区恰为当前命中时 m.index === sel.from，即替换当前）
            break;
          }
          if (m.index === g.lastIndex) g.lastIndex++;
        }
        if (!target) {
          // 光标已越过末个命中：环绕替换第一个
          g.lastIndex = 0;
          target = g.exec(docText);
        }
        if (!target) return false;
        const inner = new RegExp(base.source, base.flags); // 非全局，$&/$1 组引用按单次替换语义
        const replaced = target[0].replace(inner, replacement);
        const from = target.index;
        const to = from + target[0].length;
        // 替换后的新文本里找「替换点起的首个命中」（无则环绕首个）选中之——后续「替换」/Enter 自然步进；
        // 新文本位置与 dispatch 后文档位置一一对应；单次 dispatch = 单步撤销。
        const newText = docText.slice(0, from) + replaced + docText.slice(to);
        const g2 = new RegExp(base.source, base.flags.includes('g') ? base.flags : base.flags + 'g');
        let next: { from: number; to: number } | null = null;
        let mm: RegExpExecArray | null;
        while ((mm = g2.exec(newText)) != null) {
          if (mm.index >= from) {
            next = { from: mm.index, to: mm.index + mm[0].length };
            break;
          }
          if (mm.index === g2.lastIndex) g2.lastIndex++;
        }
        if (!next) {
          g2.lastIndex = 0;
          const m3 = g2.exec(newText);
          if (m3 && m3[0].length >= 0) next = { from: m3.index, to: m3.index + m3[0].length };
        }
        this.view.dispatch({
          changes: { from, to, insert: replaced },
          selection: next ? { anchor: next.from, head: next.to } : { anchor: from + replaced.length },
          scrollIntoView: true,
        });
        return true;
      },
      onReplaceAll: (needle, replacement, opts) => {
        if (!this.view) return 0;
        const scope = this.findBar?.scopeEnabled ? this.columnRect : null;
        if (scope) {
          const { changes, count } = this.scopedReplaceAll(needle, replacement, opts, scope);
          if (changes.length) this.applyLineChanges(changes);
          return count;
        }
        const { changes, count } = replaceDocLines(this.docLines(), { find: needle, replaceWith: replacement, ...opts });
        if (changes.length) this.applyLineChanges(changes);
        return count;
      },
    });
    this.host.appendChild(this.findBar.el);
    this.view = new EditorView({
      state: EditorState.create({
        doc: this.buffer?.state.doc ?? text,
        selection: this.buffer?.state.selection,
        extensions: [
          this.lnComp.of(this.initShowLineNumbers ? lineNumbers() : []),
          this.bookmarkState,
          gutter({
            class: 'cm-bookmarks',
            markers: view => RangeSet.of(view.state.field(this.bookmarkState).map(p => bookmarkMarker.range(p))),
            lineMarkerChange: u => u.startState.field(this.bookmarkState) !== u.state.field(this.bookmarkState),
            domEventHandlers: { mousedown: (view, line, e) => {
              if ((e as MouseEvent).button !== 0) return false;
              view.dispatch({ effects: toggleBookmark.of(line.from) });
              return true;
            } },
          }),
          foldGutter(),
          drawSelection(),
          // CM6 baseTheme 聚焦选区为 6 类选择器 #d7d4f0，应用侧单类 var(--selection) 在顺序与特异性
          // 双重必输——用户主题挂载序在 baseTheme 后，配合 !important 定向夺回（007 v0.39 选区可见性）
          EditorView.theme({ '& .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' } }),
          compositionGuard(),
          // R8 根修（005 v2.0）：多选区许可——缺省 false 时 CM 把任何多 range 选区归并成
          // main range，矩形选区/多行同步输入/零宽列全部失效（列命令只因私有 columnRect 才"看起来能用"）
          EditorState.allowMultipleSelections.of(true),
          // 列选择的兜底（主路径是下面的拖拽手势，记下列宽）。只认左键，右键不得另起矩形。
          rectangularSelection({ eventFilter: e => e.button === 0 && (this.columnMode || e.altKey) }),
          crosshairCursor(),
          highlightActiveLine(),
          history(),
          bufferHistory(this.buffer),
          this.readOnlyControl.extension(),
          this.selHlComp.of(this.initSelectionHl ? highlightSelectionMatches() : []),
          // 002 规则 25（W2 清偿）：编辑面不可见字符高亮——与查看面 renderLineHtml 同一
          // INVISIBLE_RE 判据（008 规则 6「同一检测底座」前端侧口径），悬停显码位。
          this.invisibleComp.of(this.initInvisible ? invisibleMarkers() : []),
          // P1-2（002 规则 7 v2.4）：编辑态命中三色高亮——CM 自带 search 扩展的高亮只在它
          // 自己的面板打开时渲染，本应用 FindBar 是自绘的，故用自建视口高亮器（详见文件头）
          matchHighlighter(() => this.findQuery),
          Prec.high(keymap.of([
            { key: 'Ctrl-F2', preventDefault: true, run: () => { this.toggleBookmark(); return true; } },
            { key: 'F2', preventDefault: true, run: () => { this.nextBookmark(); return true; } },
            { key: 'Alt-ArrowLeft', preventDefault: true, run: () => { this.historyBack(); return true; } },
            { key: 'Alt-ArrowRight', preventDefault: true, run: () => { this.historyForward(); return true; } },
            { key: 'Mod-f', preventDefault: true, run: () => { this.openFindBar(); return true; } },
            { key: 'Mod-h', preventDefault: true, run: () => { this.openReplace(); return true; } },
            { key: 'Backspace', run: () => this.columnDeleteIfAny() },
            { key: 'Delete', run: () => this.columnDeleteIfAny() },
            { key: 'Mod-v', run: () => this.pasteColumnIfApplicable() },
            // 键盘扩块（005 v2.0 规则 1）：Alt+Shift+↑/↓ 覆盖 CM 默认 copyLine（实测曾把行复制三遍）
            { key: 'Alt-Shift-ArrowUp', preventDefault: true, run: () => { this.growColumnRect(-1); return true; } },
            { key: 'Alt-Shift-ArrowDown', preventDefault: true, run: () => { this.growColumnRect(1); return true; } },
            // 列模式开时 Shift+方向键扩块（关时返回 false 放行普通选区）
            { key: 'Shift-ArrowUp', run: () => (this.columnMode ? (this.growColumnRect(-1), true) : false) },
            { key: 'Shift-ArrowDown', run: () => (this.columnMode ? (this.growColumnRect(1), true) : false) },
            { key: 'Shift-ArrowLeft', run: () => (this.columnMode && this.columnRect ? (this.growColumnHorizontal(-1), true) : false) },
            { key: 'Shift-ArrowRight', run: () => (this.columnMode && this.columnRect ? (this.growColumnHorizontal(1), true) : false) },
            // Escape 清矩形回单光标（无矩形放行默认）
            { key: 'Escape', run: () => this.escapeColumnRect() },
          ])),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            indentWithTab,
            { key: 'Mod-s', preventDefault: true, run: () => { void this.save(); return true; } },
            { key: 'Alt-c', preventDefault: true, run: () => { this.toggleColumnMode(); return true; } },
            { key: 'Insert', preventDefault: true, run: () => { this.toggleOverwrite(); return true; } },
            // Markdown 格式键（007 v0.11 R6）：仅 Markdown 语言生效，其余语言放行默认行为
            { key: 'Mod-b', run: () => this.mdFormatKey('bold') },
            { key: 'Mod-i', run: () => this.mdFormatKey('italic') },
            { key: 'Mod-k', run: () => this.mdFormatKey('link') },
            { key: 'Shift-Mod-k', run: () => this.mdFormatKey('inlineCode') },
            { key: 'Mod-1', run: () => this.mdFormatKey('h1') },
            { key: 'Mod-2', run: () => this.mdFormatKey('h2') },
            { key: 'Mod-3', run: () => this.mdFormatKey('h3') },
            { key: 'Mod-4', run: () => this.mdFormatKey('h4') },
          ]),
          syntaxHighlighting(classHighlighter),
          // 矩形选区复制恒补齐（005 规则 5 v1.0：Ctrl+C 与菜单/右键输出一致）；
          // P1-2 起顺带记录「列复制来源标记」（005 规则 5 v2.2——粘贴端判决用，普通复制覆盖为 false）
          EditorView.clipboardOutputFilter.of((copied, state) => {
            const r = this.columnRect ?? rectOf(state.selection.ranges.map(x => ({ from: x.from, to: x.to })), state.doc);
            // 零宽矩形按普通光标复制（005 规则 5a ②：复制不产生列块——空内容列复制只会产出空行块）
            const rect = r && r.colEnd > r.colStart ? r : null;
            if (!rect) {
              markRectCopy(false);
              return copied;
            }
            const out = rectText(rect, n => state.doc.line(n).text).join('\n');
            markRectCopy(true, out);
            return out;
          }),
          EditorView.domEventHandlers({
            // 按下处置统一走 rectPointerPlan（005 规则 2 v1.3：右键不得清除矩形——详见 rect.ts 该函数注释）
            mousedown: (e, view) => {
              const plan = rectPointerPlan(e.button, this.columnMode, e.altKey, this.columnRect != null);
              if (plan.preserve) this.preserveRect = true;
              if (plan.preventDefault) {
                e.preventDefault();
                if (!view.hasFocus) view.focus(); // 拦下默认行为也就拦下了原生聚焦，补回来
              }
              if (plan.clear) {
                this.columnRect = null;
                return false;
              }
              if (plan.drag) return this.beginColumnDrag(view, e);
              return false;
            },
            mouseup: e => {
              if (e.button === 2) this.preserveRect = false;
              return false;
            },
          }),
          // 改写模式（005 规则 12）：插入点吞掉光标后一字符（行尾不吞）。多选区交给 CM，避免列输入被吞成单光标。
          EditorView.inputHandler.of((view, from, to, text) => {
            if (isComposing(view)) return false;
            // 列内键入（005 v2.0 虚拟空格）：矩形活动的多选区键入走列窗口（短行补齐）
            if (this.columnRect && view.state.selection.ranges.length > 1 && !text.includes('\n')) {
              if (this.typeInColumn(text)) return true;
            }
            if (view.state.selection.ranges.length > 1) return false;
            if (!this.overwrite || text.includes('\n')) return false;
            if (from === to) {
              const line = view.state.doc.lineAt(from);
              if (from < line.to) to = line.from + findClusterBreak(line.text, from - line.from);
            }
            view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type' });
            return true;
          }),
          this.langComp.of([]), // 语言扩展经 applyLanguage 动态加载后精确 reconfigure
          this.fontComp.of(this.fontTheme(this.fontSize)),
          this.wrapComp.of(this.wrapOn ? EditorView.lineWrapping : []),
          EditorView.updateListener.of(u => {
            if (u.docChanged) {
              this.locationHistory = this.locationHistory.map(p => u.changes.mapPos(p, 1));
              this.dirty = true;
              this.docVer++; // 缩略图密度条重建信号（B-2）
              this.mmSpanVersion++;
              this.onDocChange?.();
            }
            if (u.startState.field(this.bookmarkState) !== u.state.field(this.bookmarkState) && this.path) {
              this.onBookmarksChange?.(this.path, u.state.field(this.bookmarkState).map(p => u.state.doc.lineAt(p).number));
            }
            if (u.selectionSet && rectSelectionCleared(this.preserveRect, this.dragAnchor != null)) {
              this.columnRect = null;
              this.findBar?.refreshScope();
            }
            if (u.docChanged || u.selectionSet) this.report();
          }),
        ],
      }),
      parent: this.host,
    });
    // 右键菜单（002 增补：编辑模式与查看模式右键体验一致）
    this.view.dom.addEventListener('contextmenu', e => {
      this.preserveRect = false;
      if (!this.onContextMenu) return;
      e.preventDefault();
      this.onContextMenu(e.clientX, e.clientY);
    });
    // Ctrl+滚轮字号缩放（001 规则 31：与查看态同值联动）
    this.view.dom.addEventListener(
      'wheel',
      e => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.setFontSize(this.fontSize - Math.sign(e.deltaY));
        this.onFontSize?.(this.fontSize);
      },
      { passive: false }
    );
    this.report();
    // 草稿无异步读取，会在构造期间就绪；直接传实例，调用方无需引用尚未赋值的变量。
    if (this.buffer) this.view.scrollDOM.scrollTop = this.buffer.scrollTop;
    this.applyLanguage();
    this.stopParseWarmup = startParseWarmup(this.view, () => !this.destroyed);
    this.onReady?.(this);
  }

  private language: string | null = null;
  private langComp = new Compartment();
  /** 语言应用代际：快速连续切换时，仅最新一次加载完成的 reconfigure 生效 */
  private langApplySeq = 0;
  private mmParserSeq = 0;
  private fontSize: number;
  private fontComp = new Compartment();
  private static FONT_MIN = 10;
  private static FONT_MAX = 18;
  private fontTheme(px: number) {
    return EditorView.theme({ '&': { fontSize: `${px}px` } });
  }

  /** 设置字号（001 规则 31：与查看态同值联动） */
  setFontSize(n: number): void {
    const v = Math.min(EditView.FONT_MAX, Math.max(EditView.FONT_MIN, Math.round(n)));
    if (v === this.fontSize) return;
    this.fontSize = v;
    if (this.view) this.view.dispatch({ effects: this.fontComp.reconfigure(this.fontTheme(v)) });
  }

  /** 设置/切换语法语言（状态栏语言弹窗；视图未挂载时仅记录，挂载时生效） */
  setLanguage(l: string | null): void {
    if (this.language !== l) {
      this.mmSpanCache.clear();
      this.mmSpanLanguage = undefined;
      this.mmSpanVersion++;
      this.mmParserSeq++;
      requestAnimationFrame(() => this.mm?.sync());
    }
    this.language = l;
    const parserSeq = ++this.mmParserSeq;
    if (l && hasHighlightParser(l)) {
      void loadHighlightParser(l).then(parser => {
        if (!parser || this.destroyed || parserSeq !== this.mmParserSeq || this.language !== l) return;
        this.mmSpanCache.clear();
        this.mmSpanVersion++;
        requestAnimationFrame(() => this.mm?.sync());
      }).catch(err => console.warn('缩略图语法高亮加载失败', l, err));
    }
    if (this.view) this.applyLanguage();
  }

  /** 异步应用当前语言：语言包动态加载完成后经 langComp 精确 reconfigure（保持高亮行为与切换语义） */
  private applyLanguage(): void {
    const language = this.language === 'JSON'
      ? safeSyntaxLanguage(this.language, this.view.state.doc.iterLines()) : this.language;
    const seq = ++this.langApplySeq;
    void loadLangExt(language).then(exts => {
      if (this.destroyed || seq !== this.langApplySeq) return;
      this.view.dispatch({ effects: this.langComp.reconfigure(exts) });
    });
  }

  /** Markdown 格式快捷键分发（007 v0.11 R6）：非 Markdown 语言返回 false 放行默认行为 */
  private mdFormatKey(cmd: MdFormatCmd): boolean {
    if (this.language !== 'Markdown' || !this.view) return false;
    runMdFormat(this.view, cmd);
    return true;
  }

  /** 软换行开关（002 规则 11 v1.4）：编辑态显示层折行，不改文件字节；按标签记忆由 app 层负责 */
  setWrap(on: boolean): void {
    this.wrapOn = on;
    if (this.view) {
      this.view.dispatch({ effects: this.wrapComp.reconfigure(on ? EditorView.lineWrapping : []) });
      this.report();
    }
  }

  get wrap(): boolean {
    return this.wrapOn;
  }

  /** 行号可见性（002 规则 10 v2.8：默认开可切；Compartment 增删 lineNumbers 扩展） */
  setLineNumbersVisible(on: boolean): void {
    if (!this.view) return;
    this.view.dispatch({ effects: this.lnComp.reconfigure(on ? lineNumbers() : []) });
  }

  /** 选中词高亮相同词开关（002 规则 13 v2.8：可关） */
  setSelectionHl(on: boolean): void {
    if (!this.view) return;
    this.view.dispatch({
      effects: this.selHlComp.reconfigure(on ? highlightSelectionMatches() : []),
    });
  }

  /** 不可见字符高亮开关（002 规则 25：编辑面与查看面同判据） */
  setInvisibleVisible(on: boolean): void {
    if (!this.view) return;
    this.view.dispatch({
      effects: this.invisibleComp.reconfigure(on ? invisibleMarkers() : []),
    });
  }

  /** 打开统一查找栏（菜单「查找」在编辑模式的落点；002 规则 7 v1.3；
   *  v2.6 可选 seed 回填——IR 切源码承载查找时 CM6 选区已随切换丢失，由 app 层带 IR 选词） */
  openFindBar(seed?: string): void {
    if (!this.findBar) return;
    if (seed) {
      this.findBar.show(seed);
      return;
    }
    const sel = this.view.state.selection.main;
    this.findBar.show(this.view.state.sliceDoc(sel.from, sel.to).slice(0, 200));
  }

  /** F3/Shift+F3（002 规则 7 v2.4）：栏未开时打开（以选词回填），已开时步进 */
  findStep(dir: 1 | -1): void {
    if (!this.findBar) return;
    if (!this.findBar.visible) {
      this.openFindBar();
      return;
    }
    void this.findBar.go(dir);
  }

  /** 统一查找栏执行器（编辑态）：全文正则匹配（doc 字符串偏移 = CM 位置）+ 本地计数；
   *  「仅选区内」勾选且矩形活动时，命中限定在矩形行与逐行视觉列窗口内（005 v2.0） */
  private async fbRun(
    needle: string,
    opts: { caseSensitive: boolean; wholeWord: boolean; regex: boolean },
    dir: 1 | -1,
    count: boolean,
    jump: boolean
  ): Promise<FindRunResult> {
    const noCounts = { total: null, before: null };
    if (!needle || !this.view) return { hit: null, counts: noCounts };
    const doc = this.view.state.doc;
    const all: Array<{ from: number; to: number }> = [];
    const scope = this.findBar?.scopeEnabled ? this.columnRect : null;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      for (const m of findAllIn(line.text, needle, opts)) {
        const from = line.from + m.from, to = line.from + m.to;
        if (!scope || this.posInRect(doc, from, to, scope)) all.push({ from, to });
      }
    }
    if (all.length === 0) return { hit: null, counts: count ? { total: 0, before: null } : noCounts };
    const sel = this.view.state.selection.main;
    let idx: number;
    if (dir === 1) {
      idx = all.findIndex(mm => mm.from >= sel.to);
      if (idx < 0) idx = 0; // 环绕回首个
    } else {
      idx = -1;
      for (let i = 0; i < all.length; i++) {
        if (all[i]!.from < sel.from) idx = i;
        else break;
      }
      if (idx < 0) idx = all.length - 1; // 环绕回末个
    }
    // P1-2：计数恒返回——all 本来就是全文扫出来的，步进（count=false）不返回计数会让
    // FindBar 的「第 N / 共 M 处」被清空（display 收到 total=null 即抹白）
    const counts = { total: all.length, before: idx };
    const mm = all[idx]!;
    if (jump) {
      this.navigateTo(mm.from, mm.to);
    }
    const line = doc.lineAt(mm.from);
    return { hit: { line: line.number, col: Array.from(line.text.slice(0, mm.from - line.from)).length + 1 }, counts };
  }

  /** 列模式开关（005 规则 1 v1.0）：开启后普通拖拽即产生矩形选区（eventFilter 见 extensions），状态栏 COL 灯亮 */
  toggleColumnMode(): void {
    this.columnMode = !this.columnMode;
    if (!this.columnMode) this.columnRect = null;
    this.syncColumnCursor();
    this.report();
  }

  /** 指针所在视觉字符格（向下取整；jsdom 等无布局环境回退按字符宽度折算）。竖直拖过同一格也有宽度 1。 */
  private cellAt(view: EditorView, e: MouseEvent): { line: number; cell: number } | null {
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    if (pos == null) return null;
    const line = view.state.doc.lineAt(pos);
    const origin = view.coordsAtPos(line.from);
    const w = view.defaultCharacterWidth || 8;
    if (!origin) return { line: line.number, cell: visualColOf(line.text, Math.max(0, pos - line.from)) };
    return { line: line.number, cell: Math.max(0, Math.floor((e.clientX - origin.left) / w)) };
  }

  private beginColumnDrag(view: EditorView, e: MouseEvent): boolean {
    const anchor = this.cellAt(view, e);
    if (!anchor) return false;
    this.dragAnchor = anchor;
    e.preventDefault();
    let autoScrollRaf = 0;
    const move = (ev: MouseEvent): void => {
      if (!this.dragAnchor || !this.view) return;
      autoScrollBeyond(this.view.scrollDOM, ev.clientY, () => (autoScrollRaf = requestAnimationFrame(() => runMove(ev))));
      runMove(ev);
    };
    const runMove = (ev: MouseEvent): void => {
      if (!this.dragAnchor || !this.view) return;
      const cur = this.cellAt(this.view, ev);
      if (!cur) return;
      const rect = rectFromCells(this.dragAnchor, cur);
      if (rect) this.applyColumnRect(rect);
    };
    const up = (ev: MouseEvent): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (autoScrollRaf) cancelAnimationFrame(autoScrollRaf);
      const start = this.dragAnchor;
      this.dragAnchor = null;
      if (!start || !this.view) return;
      const cur = this.cellAt(this.view, ev) ?? start;
      const rect = rectFromCells(start, cur);
      if (rect) this.applyColumnRect(rect);
      else {
        this.columnRect = null;
        this.placeCaret(start);
      }
      this.view.focus();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return true;
  }

  private placeCaret(p: { line: number; cell: number }): void {
    if (!this.view) return;
    this.findBar?.refreshScope();
    const line = this.view.state.doc.line(Math.min(Math.max(1, p.line), this.view.state.doc.lines));
    const col = charAtVisualCol(line.text, Math.max(0, p.cell));
    this.preserveRect = true;
    this.view.dispatch({ selection: { anchor: line.from + col } });
    this.preserveRect = false;
  }

  private applyColumnRect(rect: RectSpan): void {
    if (!this.view) return;
    this.columnRect = rect; // 视觉列口径（005 v2.0）：CJK 行按视觉格对齐，超行尾为虚拟列
    const ranges = [];
    for (let n = rect.fromLine; n <= rect.toLine; n++) {
      const line = this.view.state.doc.line(n);
      const a = charAtVisualCol(line.text, rect.colStart);
      const b = charAtVisualCol(line.text, rect.colEnd);
      ranges.push(EditorSelection.range(line.from + Math.min(a, b), line.from + Math.max(a, b)));
    }
    if (!ranges.length) return;
    this.preserveRect = true;
    this.view.dispatch({ selection: EditorSelection.create(ranges) });
    this.preserveRect = false;
    this.findBar?.refreshScope();
  }

  /** 测试口（edit-column.test.ts）：直接施加视觉矩形 */
  applyColumnRectForTest(rect: RectSpan): void {
    this.applyColumnRect(rect);
  }

  /** 测试口：当前矩形逐行取文本（与列命令同源，验证"右键后列宽未丢"） */
  visualRectTextForTest(): string[] {
    return this.visualRectText();
  }

  /**
   * 键盘扩块（005 v2.0 规则 1）：Alt+Shift+↑/↓ 增减矩形行数（禁 CM 默认 copyLine）；
   * 列模式开时 Shift+↑/↓ 同效。无矩形时从光标处起零宽矩形（光标列=视觉列）。
   */
  growColumnRect(dir: 1 | -1): void {
    if (!this.view) return;
    const doc = this.view.state.doc;
    if (!this.columnRect) {
      // 首按即扩一行（与 Shift+方向键语义一致）：光标行 + 相邻行，零宽视觉列
      const pos = this.view.state.selection.main.head;
      const line = doc.lineAt(pos);
      const col = visualColOf(line.text, pos - line.from);
      const to = Math.min(doc.lines, Math.max(1, line.number + dir));
      this.applyColumnRect({ fromLine: Math.min(line.number, to), toLine: Math.max(line.number, to), colStart: col, colEnd: col });
      return;
    }
    const r = this.columnRect;
    const toLine = Math.min(doc.lines, Math.max(1, r.toLine + dir));
    this.applyColumnRect({ ...r, fromLine: Math.min(r.fromLine, toLine), toLine: Math.max(r.fromLine, toLine) });
  }

  /** 水平扩块（列模式开时 Shift+←/→，005 v2.0 规则 1） */
  growColumnHorizontal(dir: 1 | -1): void {
    if (!this.view || !this.columnRect) {
      this.growColumnRect(1);
      if (!this.columnRect) return;
    }
    const r = this.columnRect;
    const colEnd = Math.max(r.colStart + 1, r.colEnd + dir);
    this.applyColumnRect({ ...r, colEnd });
  }

  /** Escape 清矩形回单光标（005 v2.0 规则 1）；无矩形返回 false 放行默认行为 */
  escapeColumnRect(): boolean {
    if (!this.columnRect) return false;
    const main = this.view.state.selection.main;
    this.columnRect = null;
    this.preserveRect = true;
    this.view.dispatch({ selection: { anchor: main.head } });
    this.preserveRect = false;
    this.findBar?.refreshScope();
    this.report();
    return true;
  }

  /**
   * 视觉矩形 → 逐行 CM 变更的通用映射（005 v2.0）：
   * a/b=该行字符窗口 [a,b)（视觉列 colStart/colEnd 映射结果）；pad>0 表示 colStart 超行尾
   * （虚拟列），gen 自行决定是否前置补空格。gen 返回 null 跳过该行。
   */
  private visualChanges(
    rect: RectSpan,
    gen: (n: number, lineFrom: number, a: number, b: number, text: string, pad: number) => { from: number; to: number; insert: string } | null
  ): { from: number; to: number; insert: string }[] {
    if (!this.view || !rect) return [];
    const doc = this.view.state.doc;
    const out: { from: number; to: number; insert: string }[] = [];
    for (let n = rect.fromLine; n <= rect.toLine; n++) {
      const line = doc.line(n);
      const w = visualWidth(line.text);
      const c =
        w < rect.colStart
          ? gen(n, line.from, line.length, line.length, line.text, rect.colStart - w)
          : gen(n, line.from, charAtVisualCol(line.text, rect.colStart), charAtVisualCol(line.text, rect.colEnd), line.text, 0);
      if (c) out.push(c);
    }
    return out;
  }

  /**
   * 列内键入（005 v2.0 虚拟空格）：矩形活动时把键入文本落到每行的视觉列窗口——
   * 短行先补空格到 colStart（超行尾的格是虚拟列），长行替换 [colStart, colEnd) 窗口。
   * inputHandler 与测试共用。返回是否已处理。
   */
  typeInColumn(text: string): boolean {
    if (!this.view || !this.columnRect || this.view.state.selection.ranges.length < 2 || text.includes('\n')) return false;
    if (this.columnRect.cursorCols) {
      const rect = this.columnRect;
      this.preserveRect = true;
      this.view.dispatch({ ...this.view.state.replaceSelection(text), userEvent: 'input.type' });
      const cursorCols = this.view.state.selection.ranges.map(r => {
        const l = this.view.state.doc.lineAt(r.head);
        return visualColOf(l.text, r.head - l.from);
      });
      this.columnRect = { ...rect, colStart: cursorCols[0], colEnd: cursorCols[0], cursorCols };
      this.preserveRect = false;
      this.findBar?.refreshScope();
      this.report();
      return true;
    }
    const changes = this.visualChanges(this.columnRect, (_n, lf, a, b, _t, pad) =>
      pad > 0 ? null : { from: lf + a, to: lf + b, insert: text }
    );
    // 虚拟列行单独生成（补空格插入）
    const rect = this.columnRect;
    const doc = this.view.state.doc;
    for (let n = rect.fromLine; n <= rect.toLine; n++) {
      const line = doc.line(n);
      const w = visualWidth(line.text);
      if (w < rect.colStart) {
        changes.push({ from: line.to, to: line.to, insert: ' '.repeat(rect.colStart - w) + text });
      }
    }
    if (!changes.length) return false;
    changes.sort((x, y) => x.from - y.from);
    const sel = [];
    let off = 0;
    for (const c of changes) {
      const contentStart = c.from + off + c.insert.length - text.length;
      sel.push(EditorSelection.range(contentStart, contentStart + text.length));
      off += c.insert.length - (c.to - c.from);
    }
    this.preserveRect = true;
    this.columnRect = { ...rect, colEnd: rect.colStart + visualWidth(text, rect.colStart) };
    this.view.dispatch({ changes, selection: EditorSelection.create(sel), userEvent: 'input.type' });
    this.preserveRect = false;
    this.findBar?.refreshScope();
    this.report();
    return true;
  }

  /** 矩形逐行文本（视觉口径：短行按视觉宽度补齐，通用复制语义） */
  private visualRectText(): string[] {
    const rect = this.columnRect;
    if (!rect || !this.view) return [];
    const doc = this.view.state.doc;
    const out: string[] = [];
    const width = rect.colEnd - rect.colStart;
    for (let n = rect.fromLine; n <= rect.toLine; n++) {
      const text = doc.line(n).text;
      const a = charAtVisualCol(text, rect.colStart);
      const b = charAtVisualCol(text, rect.colEnd);
      const slice = text.slice(a, b);
      out.push(slice + ' '.repeat(Math.max(0, width - visualWidth(slice))));
    }
    return out;
  }

  private lineRef(n: number): { from: number; text: string } {
    const l = this.view.state.doc.line(n);
    return { from: l.from, text: l.text };
  }

  /** 范围内替换单处（005 v2.0）：矩形行 × 逐行视觉列窗口，最早命中 */
  private scopedReplaceOne(
    needle: string,
    replacement: string,
    opts: { caseSensitive: boolean; wholeWord: boolean; regex: boolean },
    rect: RectSpan
  ): { line: number; text: string } | null {
    for (let n = rect.fromLine; n <= rect.toLine; n++) {
      const { text } = this.lineRef(n);
      const a = charAtVisualCol(text, rect.colStart);
      const b = charAtVisualCol(text, rect.colEnd);
      const r = replaceInLine(text, { find: needle, replaceWith: replacement, ...opts, colStart: a + 1, colEnd: b });
      if (r) return { line: n, text: r.text };
    }
    return null;
  }

  /** 范围内全部替换（005 v2.0） */
  private scopedReplaceAll(
    needle: string,
    replacement: string,
    opts: { caseSensitive: boolean; wholeWord: boolean; regex: boolean },
    rect: RectSpan
  ): { changes: { line: number; text: string }[]; count: number } {
    const changes: { line: number; text: string }[] = [];
    let count = 0;
    for (let n = rect.fromLine; n <= rect.toLine; n++) {
      const { text } = this.lineRef(n);
      const a = charAtVisualCol(text, rect.colStart);
      const b = charAtVisualCol(text, rect.colEnd);
      const r = replaceInLine(text, { find: needle, replaceWith: replacement, ...opts, colStart: a + 1, colEnd: b });
      if (r) {
        changes.push({ line: n, text: r.text });
        count += r.count;
      }
    }
    return { changes, count };
  }

  /** 位置区间是否落在视觉矩形内（005 v2.0 查找范围芯片）：行在矩形内且与该行字符窗口相交 */
  private posInRect(doc: { lineAt: (p: number) => { from: number; to: number; number: number; text: string } }, from: number, to: number, rect: RectSpan): boolean {
    const l = doc.lineAt(from);
    if (l.number < rect.fromLine || l.number > rect.toLine) return false;
    const a = charAtVisualCol(l.text, rect.colStart);
    const b = charAtVisualCol(l.text, rect.colEnd);
    return from < l.from + b && to > l.from + a; // 窗口相交
  }

  /** 记下的矩形优先；否则从当前选区钳回（CM 越界 range 不再整块作废） */
  private activeRect(): RectSpan | null {
    return this.columnRect ?? this.rectNow();
  }

  private columnDeleteIfAny(): boolean {
    if (!this.activeRect()) return false;
    this.cmdDelete();
    return true;
  }

  /** 列模式开时编辑区 crosshair 光标反馈（C-1 专业编辑器级手感） */
  private syncColumnCursor(): void {
    this.host.classList.toggle('col-mode', this.columnMode);
    if (this.view) this.view.scrollDOM.classList.toggle('col-mode', this.columnMode);
  }

  /** 是否为多选区（右键"列操作"子菜单显示依据之一） */
  hasMultiSelection(): boolean {
    return !!this.view && this.view.state.selection.ranges.length > 1;
  }

  // ---- 编辑态缩略图（B-2 #5/#11：MinimapAdapter 第四次复用，CM 滚动容器+doc 行数据） ----
  private mm: Minimap | null = null;
  private docVer = 0;
  /** 编辑态缩略图着色缓存（P3，002 规则 23「编辑态同享」欠账）：行号 → 语法区间；
   *  用查看态同一 highlightLines（Lezer + classHighlighter），按采样行惰性计算 */
  private mmSpanCache = new Map<number, { text: string; spans: Span[] }>();
  private mmSpanLanguage: string | null | undefined;
  private mmSpanVersion = 0;

  /** 缩略图行着色（按行文本复用；无语言返回 undefined = 单色条） */
  private mmLineSpans(n: number): Span[] | undefined {
    if (!this.view) return undefined;
    const language = this.language;
    if (this.mmSpanLanguage !== language) {
      this.mmSpanCache.clear();
      this.mmSpanLanguage = language;
    }
    const d = this.view.state.doc;
    if (n < 1 || n > d.lines) return undefined;
    const text = d.line(n).text;
    const cached = this.mmSpanCache.get(n);
    if (cached?.text === text) {
      this.mmSpanCache.delete(n);
      this.mmSpanCache.set(n, cached);
      return cached.spans;
    }
    const spans = highlightLines([text], language ?? '')[0] ?? [];
    this.mmSpanCache.set(n, { text, spans });
    if (this.mmSpanCache.size > 2048) this.mmSpanCache.delete(this.mmSpanCache.keys().next().value!);
    return spans;
  }

  /** 挂载缩略图（app 在 onReady 后调用；parent = editorRow） */
  attachMinimap(parent: HTMLElement): Minimap | null {
    if (this.mm || !this.view || this.destroyed) return this.mm;
    this.mm = new Minimap(parent, {
      scrollTop: () => this.view?.scrollDOM.scrollTop ?? 0,
      scrollHeight: () => this.view?.scrollDOM.scrollHeight ?? 1,
      clientHeight: () => this.view?.scrollDOM.clientHeight ?? 1,
      scrollTo: y => {
        if (this.view) this.view.scrollDOM.scrollTop = y;
      },
      totalLines: () => this.view?.state.doc.lines ?? 1,
      lineText: n => {
        const d = this.view?.state.doc;
        return d && n >= 1 && n <= d.lines ? d.line(n).text : undefined;
      },
      lineSpans: n => this.mmLineSpans(n),
      spansVersion: () => this.mmSpanVersion,
      cacheVersion: () => this.docVer,
      goToLine: n => {
        const v = this.view;
        if (!v) return;
        const l = v.state.doc.line(Math.min(Math.max(1, n), v.state.doc.lines));
        v.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
      },
    });
    this.view.scrollDOM.addEventListener('scroll', () => this.mm?.sync(), { passive: true });
    requestAnimationFrame(() => this.mm?.sync());
    return this.mm;
  }

  /** 缩略图是否已挂载（视图菜单开关两态判断） */
  hasMinimap(): boolean {
    return this.mm != null;
  }

  setMinimapVisible(on: boolean): void {
    this.mm?.setVisible(on);
  }

  /** 列模式是否开启（#10：列模式开时「列操作 ▸」恒可达，不依赖多选区形态） */
  isColumnModeOn(): boolean {
    return this.columnMode;
  }

  /** 已记下矩形（右键清掉 CM 选区后列命令仍要在） */
  hasColumnRect(): boolean {
    return this.columnRect != null;
  }

  /** 行批处理统一入口（编辑菜单"行批处理 ▸"，005 规则 14：选区行或全文） */
  lineBatch(op: LineBatchOp): void {
    switch (op) {
      case 'sort': return this.cmdSort();
      case 'dedupe': return this.cmdDedupe();
      case 'removeEmpty': return this.cmdRemoveEmpty();
      case 'trim': return this.cmdTrim();
      case 'tabsToSpaces': return this.cmdTabsToSpaces();
      case 'spacesToTabs': return this.cmdSpacesToTabs();
    }
  }

  /** 文本批处理：选区所在行（无选区=全文）整体变换（M7-3） */
  private transformLines(fn: (lines: string[]) => string[]): void {
    const { state } = this.view;
    const sel = state.selection;
    const wholeDoc = sel.ranges.length === 1 && sel.ranges[0].from === sel.ranges[0].to;
    const from = wholeDoc ? 0 : Math.min(...sel.ranges.map(r => r.from));
    const to = wholeDoc ? state.doc.length : Math.max(...sel.ranges.map(r => r.to));
    const startLine = state.doc.lineAt(from).number;
    const endLine = state.doc.lineAt(to).number;
    const lines: string[] = [];
    for (let n = startLine; n <= endLine; n++) lines.push(state.doc.line(n).text);
    const text = fn(lines).join('\n');
    this.view.dispatch({
      changes: { from: state.doc.line(startLine).from, to: state.doc.line(endLine).to, insert: text },
    });
    this.view.focus();
  }

  private cmdSort(): void {
    this.transformLines(ls => [...ls].sort((a, b) => a.localeCompare(b)));
  }
  private cmdDedupe(): void {
    this.transformLines(ls => [...new Set(ls)]);
  }
  private cmdRemoveEmpty(): void {
    this.transformLines(ls => ls.filter(l => l.trim() !== ''));
  }
  private cmdTrim(): void {
    this.transformLines(ls => ls.map(l => l.replace(/\s+$/, '')));
  }
  private cmdTabsToSpaces(): void {
    this.transformLines(ls => ls.map(l => l.replace(/\t/g, '    ')));
  }
  private cmdSpacesToTabs(): void {
    this.transformLines(ls => ls.map(l => l.replace(/ {4}/g, '\t')));
  }

  private ranges(): { from: number; to: number }[] {
    const sel = this.view.state.selection;
    return sel.ranges.map(r => ({ from: r.from, to: r.to })).sort((a, b) => a.from - b.from);
  }

  /** 矩形重建（rect.ts 纯函数）：当前选区是矩形时返回 [colStart, colEnd) 跨度 */
  private rectNow() {
    return rectOf(this.ranges(), this.view.state.doc);
  }

  private report(): void {
    if (this.destroyed) return;
    const rs = this.ranges();
    // 零复制口径：r.to - r.from 与 sliceString().length 同为 UTF-16 码元数
    let chars = 0;
    for (const r of rs) chars += r.to - r.from;
    const pos = this.view.state.selection.main.head;
    const ln = this.view.state.doc.lineAt(pos);
    this.onStatus({
      columnMode: this.columnMode,
      ranges: rs.length,
      selChars: chars,
      dirty: this.dirty,
      overwrite: this.overwrite,
      line: ln.number,
      col: pos - ln.from + 1,
      newline: this.newline,
      wrap: this.wrapOn,
      rect: this.columnRect ? { lines: this.columnRect.toLine - this.columnRect.fromLine + 1, cols: this.columnRect.colEnd - this.columnRect.colStart } : null,
    });
  }

  // ---- 列命令（005 规则 3-8 v2.0：视觉列口径 + 虚拟空格 + 求和/对齐/无矩形插入；公有化供右键"列操作 ▸"）----
  async cmdFill(): Promise<void> {
    const s = await this.ask(t('ed.fillText'));
    if (s === null) return; // 取消；空串 = 清空选区内容（005 规则 6）
    if (this.columnRect) {
      // 矩形填充：视觉窗口替换 + 虚拟列补齐（005 v2.0）
      const changes = this.visualChanges(this.columnRect, (_n, lf, a, b, _t, pad) =>
        pad > 0 ? { from: lf + a, to: lf + b, insert: ' '.repeat(pad) + s } : { from: lf + a, to: lf + b, insert: s }
      );
      this.columnRect = null;
      this.findBar?.refreshScope();
      if (changes.length) this.view.dispatch({ changes, userEvent: 'column.edit' });
      this.view.focus();
      return;
    }
    // 无矩形（005 v2.0 规则 15）：插入列——光标列到文末，短行补空格
    if (!s) return;
    const pos = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(pos);
    const col = pos - line.from;
    const changes = insertColumnChanges(line.number, col, n => this.lineRef(n), s, this.view.state.doc.lines);
    if (changes.length) this.view.dispatch({ changes, userEvent: 'column.edit' });
    this.view.focus();
  }

  async cmdNumbering(): Promise<void> {
    const s = await this.ask(t('ed.seqPrompt'), '1,1,0');
    if (s === null) return;
    // v2.0：第 4 段可选 hex=十六进制（如 254,1,2,hex——起始/步进按十进制读，输出按十六进制）；末空行不编号
    const parts = s.split(',').map(x => x.trim());
    const radix = parts[3] === 'hex' ? 16 : 10;
    const [start, step, minDigits] = parts.slice(0, 3).map(x => parseInt(x ?? '0', 10) || 0);
    const rect = this.columnRect;
    if (rect) {
      let i = 0;
      const changes = this.visualChanges(rect, (n, lf, a, b, text, pad) => {
        if (n === rect.toLine && !text.trim()) return null; // 末空行不编号
        const num = (start + i++ * step).toString(radix).padStart(minDigits, '0');
        return pad > 0
          ? { from: lf + a, to: lf + b, insert: ' '.repeat(pad) + num }
          : { from: lf + a, to: lf + b, insert: num };
      });
      this.columnRect = null;
      this.findBar?.refreshScope();
      if (changes.length) this.view.dispatch({ changes, userEvent: 'column.edit' });
      this.view.focus();
      return;
    }
    const changes = this.ranges().map((r, i) => ({
      from: r.from,
      to: r.to,
      insert: (start + i * step).toString(radix).padStart(minDigits, '0'),
    }));
    this.view.dispatch({ changes, userEvent: 'column.edit' });
    this.view.focus();
  }

  cmdCase(mode: 'upper' | 'lower'): void {
    if (this.columnRect) {
      const changes = this.visualChanges(this.columnRect, (_n, lf, a, b, text, pad) => {
        if (pad > 0 || b <= a) return null;
        const slice = text.slice(a, b);
        const insert = mode === 'upper' ? slice.toUpperCase() : slice.toLowerCase();
        return insert !== slice ? { from: lf + a, to: lf + b, insert } : null;
      });
      this.columnRect = null;
      this.findBar?.refreshScope();
      if (changes.length) this.view.dispatch({ changes, userEvent: 'column.edit' });
      this.view.focus();
      return;
    }
    const changes = this.ranges().map(r => {
      const slice = this.view.state.sliceDoc(r.from, r.to);
      return { from: r.from, to: r.to, insert: mode === 'upper' ? slice.toUpperCase() : slice.toLowerCase() };
    });
    if (changes.length) this.view.dispatch({ changes, userEvent: 'column.edit' });
    this.view.focus();
  }

  cmdDelete(): void {
    if (this.columnRect) {
      if (this.columnRect.colEnd === this.columnRect.colStart) return; // 零宽矩形：删除键无操作且矩形保留（005 规则 5a ②）
      const changes = this.visualChanges(this.columnRect, (_n, lf, a, b, _text, pad) =>
        pad > 0 || b <= a ? null : { from: lf + a, to: lf + b, insert: '' }
      );
      this.columnRect = null;
      this.findBar?.refreshScope();
      if (changes.length) this.view.dispatch({ changes, userEvent: 'column.edit' });
      this.view.focus();
      return;
    }
    const changes = this.ranges().filter(r => r.to > r.from).map(r => ({ from: r.from, to: r.to }));
    this.columnRect = null;
    this.findBar?.refreshScope();
    if (changes.length) this.view.dispatch({ changes, userEvent: 'column.edit' });
    this.view.focus();
  }

  /** 列剪切（005 规则 5 v2.0：视觉口径矩形文本，短行按视觉宽度补齐；v3.0 零宽矩形按普通光标复制+删除无操作） */
  async cmdCut(): Promise<void> {
    const doc = this.view.state.doc;
    const r0 = this.columnRect;
    const rect = r0 && r0.colEnd > r0.colStart ? r0 : null; // 零宽矩形：复制按普通光标、删除无操作（005 规则 5a ②）
    let text: string;
    if (rect) {
      text = this.visualRectText().join('\n');
    } else if (r0) {
      const main = this.view.state.selection.main;
      const ln = doc.lineAt(main.head);
      text = ln.text + (ln.number < doc.lines ? '\n' : '');
    } else {
      text = this.ranges().map(r => doc.sliceString(r.from, r.to)).join('\n');
    }
    markRectCopy(!!rect, text); // 005 规则 5 v2.3：剪切与复制同补来源标记（修前右键「剪切列」出的矩形块粘贴判不出列来源）
    await writeClipboardText(text);
    this.cmdDelete(); // 零宽矩形在 cmdDelete 内无操作且矩形保留
  }

  /**
   * 列粘贴（005 规则 5a v3.0 语义矩阵）：判决单一函数 `planColumnPaste`（rect.ts），键位
   * Mod-v/右键粘贴/菜单粘贴同一判决——矩形活动（有宽）覆盖、零宽矩形与单光标列意图列插入、
   * 零宽×单行列位普通插入、其余普通粘贴；覆盖/列插入生成共口径（`columnPasteChanges`）：
   * 文末续行、块行数少于目标行不追加、EOL 缓冲恒 LF（CRLF 由保存侧按主行尾统一回写）、
   * 粘贴后列光标恢复与粘贴同一事务（AC-19~22）。右键「列操作 ▸ 粘贴列」传 `{ force: true }`
   * （显式列意图，不限列模式）；pasteColumnIfApplicable 判决进入时缺省 force（读剪贴板后
   * 按实际文本终判来源标记，中途其它复制自动回普通粘贴）。
   */
  async cmdPaste(opts: { force?: boolean } = {}): Promise<void> {
    const text = await readClipboardText();
    if (!text) return;
    const st = this.view.state;
    const sel = st.selection;
    let cursor: { line: number; col: number } | null = null;
    if (sel.ranges.length === 1 && sel.main.from === sel.main.to) {
      const ln = st.doc.lineAt(sel.main.head);
      cursor = { line: ln.number, col: visualColOf(ln.text, sel.main.head - ln.from) };
    }
    const plan = planColumnPaste({
      rect: this.columnRect,
      columnMode: this.columnMode,
      cursor,
      clipText: text,
      clipIsRect: text.includes('\n') && wasRectCopy(text),
      force: opts.force,
    });
    if (plan.kind === 'overwrite' || plan.kind === 'columnInsert') {
      const res = columnPasteChanges(plan, {
        lineAt: n => {
          const l = st.doc.line(n);
          return { from: l.from, text: l.text };
        },
        totalLines: st.doc.lines,
        docLength: st.doc.length,
      });
      this.columnRect = res.rectAfter;
      this.preserveRect = true; // 同事务改选区（列光标恢复），勿让 updateListener 清掉矩形
      this.view.dispatch({
        changes: res.changes,
        selection: EditorSelection.create(res.selection.map(r => EditorSelection.range(r.from, r.to))),
        scrollIntoView: true,
        userEvent: 'input.paste',
      });
      this.preserveRect = false;
      this.findBar?.refreshScope();
      this.view.focus();
      this.report();
      return;
    }
    if (plan.kind === 'plainAtCol') {
      // 零宽矩形 × 单行（规则 5a 矩阵）：列位普通单行插入（虚拟列补空格），矩形不保留
      const line = st.doc.line(plan.line);
      const w = visualWidth(line.text);
      const at = w < plan.col ? line.to : line.from + charAtVisualCol(line.text, plan.col);
      const insert = w < plan.col ? ' '.repeat(plan.col - w) + plan.text : plan.text;
      this.columnRect = null;
      this.view.dispatch({ changes: { from: at, to: at, insert }, selection: { anchor: at + insert.length }, userEvent: 'input.paste' });
      this.view.focus();
      return;
    }
    // 普通粘贴（矩阵未命中列语义）；多选区时保持既有逐光标分发（显式粘贴列入口可达的边角）
    const parts = text.split('\n');
    if (sel.ranges.length > 1) {
      const cursors = sel.ranges.map(r => r.to).sort((a, b) => a - b);
      this.view.dispatch({
        changes: cursors.map((pos, i) => ({ from: pos, insert: parts[Math.min(i, parts.length - 1)] ?? '' })),
        userEvent: 'input.paste',
      });
      this.view.focus();
      return;
    }
    this.view.dispatch(st.replaceSelection(text));
    this.view.focus();
  }

  /** 求和选区（005 v2.0 规则 15，列求和）：忽略非数字，结果闪示 + 复制 */
  async cmdSum(insert = false): Promise<void> {
    const cells = this.columnRect ? this.visualRectText() : this.ranges().map(r => this.view.state.sliceDoc(r.from, r.to));
    const sum = rectSum(cells);
    if (sum === null) {
      this.onFlash?.(t('ed.sumNone'));
      return;
    }
    const pretty = String(Math.round(sum * 1e6) / 1e6);
    await writeClipboardText(pretty);
    this.onFlash?.(tf('ed.sumDone', pretty) + '（已复制）');
    if (insert) {
      const at = this.view.state.selection.main.head;
      this.columnRect = null;
      this.view.dispatch({ changes: { from: at, insert: pretty }, selection: { anchor: at + pretty.length }, userEvent: 'column.edit' });
      this.findBar?.refreshScope();
      this.view.focus();
    }
  }

  cmdInsertBlankColumn(): void {
    if (!this.columnRect) return;
    const changes = rectInsertBlankChanges(this.columnRect, n => this.lineRef(n));
    this.columnRect = null;
    this.view.dispatch({ changes, userEvent: 'column.edit' });
    this.findBar?.refreshScope();
    this.view.focus();
  }

  private transformColumnRows(transform: (lines: string[], rect: RectSpan) => string[]): void {
    const rect = this.columnRect;
    if (!rect) return;
    const doc = this.view.state.doc;
    const lines: string[] = [];
    for (let n = rect.fromLine; n <= rect.toLine; n++) lines.push(doc.line(n).text);
    const insert = transform(lines, rect).join('\n');
    if (insert === lines.join('\n')) return;
    const from = doc.line(rect.fromLine).from, to = doc.line(rect.toLine).to;
    this.columnRect = null;
    this.view.dispatch({ changes: { from, to, insert }, selection: { anchor: from }, userEvent: 'column.edit' });
    this.findBar?.refreshScope();
    this.view.focus();
  }

  cmdSortColumn(descending = false): void {
    this.transformColumnRows((lines, r) => r.colEnd > r.colStart ? sortColumnBlock(lines, r.colStart, r.colEnd, descending) : lines);
  }

  cmdDedupeColumn(): void {
    this.transformColumnRows((lines, r) => r.colEnd > r.colStart ? dedupeColumnBlock(lines, r.colStart, r.colEnd) : lines);
  }

  cmdPadColumn(): void {
    this.transformColumnRows((lines, r) => padColumnBlock(lines, r.colEnd));
  }

  cmdChangeColumnNumbers(delta: 1 | -1): void {
    if (!this.columnRect) return;
    const changes = rectNumberChanges(this.columnRect, n => this.lineRef(n), delta);
    if (!changes.length) return;
    this.columnRect = null;
    this.view.dispatch({ changes, userEvent: 'column.edit' });
    this.findBar?.refreshScope();
    this.view.focus();
  }

  /** 列对齐（005 v2.0 规则 15：左/中/右，块内容按最宽单元对齐，其余补空格） */
  cmdAlign(mode: 'left' | 'center' | 'right'): void {
    if (!this.columnRect || !this.view) return;
    const cells = this.visualRectText().map(s => s.trim());
    if (!cells.length) return;
    const w = Math.max(...cells.map(c => visualWidth(c, this.columnRect!.colStart)), 1);
    let i = 0;
    const changes = this.visualChanges(this.columnRect, (_n, lf, a, b, _text, pad) => {
      const cell = cells[i++] ?? '';
      const pad2 = Math.max(0, w - visualWidth(cell, this.columnRect!.colStart));
      const aligned =
        mode === 'left' ? cell + ' '.repeat(pad2)
        : mode === 'right' ? ' '.repeat(pad2) + cell
        : ' '.repeat(Math.floor(pad2 / 2)) + cell + ' '.repeat(Math.ceil(pad2 / 2));
      return pad > 0
        ? { from: lf + a, to: lf + b, insert: ' '.repeat(pad) + aligned }
        : { from: lf + a, to: lf + b, insert: aligned };
    });
    this.columnRect = null;
    this.findBar?.refreshScope();
    if (changes.length) this.view.dispatch({ changes, userEvent: 'column.edit' });
    this.view.focus();
  }

  save(): Promise<void> {
    const task = this.saveQueue.then(() => this.saveCurrent());
    this.saveQueue = task.catch(() => {});
    return task;
  }

  relocate(path: string, move: () => Promise<void>): Promise<void> {
    const task = this.saveQueue.then(async () => { await move(); this.path = path; });
    this.saveQueue = task.catch(() => {});
    return task;
  }

  private async saveCurrent(): Promise<void> {
    if (this.destroyed || !this.view || this.isReadOnly) return;
    if (!this.path) {
      this.onSaveAsNeeded(this.view.state.doc.toString());
      return;
    }
    const savedDoc = this.view.state.doc;
    const savedPath = this.path;
    let content = savedDoc.toString();
    // 行尾保留（002 规则 4 v1.4）：CM 文档以 \n 连接，写盘前按打开时主类型回写；
    // mixed 文件按主类型统一并提示一次
    if (this.newline === 'crlf') content = convertEol(content, '\r\n');
    else if (this.newline === 'cr') content = convertEol(content, '\r');
    if (this.newlineMixed && !this.mixedNoticed) {
      this.mixedNoticed = true;
      this.onFlash?.(t('msg.nlMixedSaved'));
    }
    try {
      const stat = await textSave(savedPath, content, this.encoding);
      const clean = !this.destroyed && this.path === savedPath && this.view.state.doc === savedDoc;
      if (clean) this.dirty = false;
      if (!this.destroyed) this.report();
      this.onSaved(savedPath, stat, clean);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('UNMAPPABLE')) {
        // 「另存为」路径的收口在 shell 的 saveTextAs 内（同一处，见 app.ts 注释）
        if (await this.confirmBox(t('ed.unmappableAsk'))) {
          this.onSaveAsNeeded(content);
        }
      } else {
        this.alertBox(msg.includes('EXTERNAL_CHANGED') ? t('err.saveConflict') : tf('err.saveFail', msg));
      }
    }
  }

  getContent(): string {
    return this.view?.state.doc.toString() ?? '';
  }

  /** 内容体量廉价估计（P2，autosave sizeHint）：CM doc.length 无序列化 */
  contentSizeHint(): number {
    return this.view?.state.doc.length ?? 0;
  }

  /** 自动快照分段取值；保存本身仍使用同步快照，保持显式保存的单次事务语义。 */
  snapshotContent(): Promise<string> {
    return snapshotDocument(this.view?.state.doc ?? { length: 0, sliceString: () => '' });
  }

  contentRevision(): number {
    return this.docVer;
  }

  /** 就地格式化（批 D-2）：整文档单次替换 = 单步撤销；内容未变返回 false */
  applyFormatted(text: string): boolean {
    if (!this.view) return false;
    const cur = this.view.state.doc.toString();
    if (cur === text) return false;
    this.view.dispatch({
      changes: { from: 0, to: cur.length, insert: text },
      selection: { anchor: 0 },
    });
    this.view.focus();
    return true;
  }

  /** 行定位（CLI `path:line` 打开即编辑路径）：光标落目标行行首并滚入视口 */
  goToLine(line: number): void {
    if (!this.view || !Number.isFinite(line)) return;
    const n = Math.max(1, Math.min(Math.trunc(line), this.view.state.doc.lines));
    const l = this.view.state.doc.line(n);
    this.navigateTo(l.from);
  }

  private navigateTo(from: number, to = from, record = true): void {
    if (record) {
      const cur = this.view.state.selection.main.head;
      this.locationHistory = this.locationHistory.slice(0, this.locationIndex + 1);
      if (this.locationHistory[this.locationHistory.length - 1] !== cur) this.locationHistory.push(cur);
      if (this.locationHistory[this.locationHistory.length - 1] !== from) this.locationHistory.push(from);
      if (this.locationHistory.length > 100) this.locationHistory.splice(0, this.locationHistory.length - 100);
      this.locationIndex = this.locationHistory.length - 1;
    }
    this.view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    this.view.focus();
  }

  historyBack(): void {
    if (this.locationIndex > 0) this.navigateTo(this.locationHistory[--this.locationIndex]!, undefined, false);
  }

  historyForward(): void {
    if (this.locationIndex < this.locationHistory.length - 1) this.navigateTo(this.locationHistory[++this.locationIndex]!, undefined, false);
  }

  toggleBookmark(): void {
    if (!this.view) return;
    this.view.dispatch({ effects: toggleBookmark.of(this.view.state.doc.lineAt(this.view.state.selection.main.head).from) });
  }

  nextBookmark(): void {
    if (!this.view) return;
    const marks = this.view.state.field(this.bookmarkState);
    const cur = this.view.state.selection.main.head;
    const next = marks.find(p => p > cur) ?? marks[0];
    if (next !== undefined) this.navigateTo(next);
  }

  prevBookmark(): void {
    if (!this.view) return;
    const marks = this.view.state.field(this.bookmarkState);
    const cur = this.view.state.selection.main.head;
    const prev = [...marks].reverse().find(p => p < cur) ?? marks[marks.length - 1];
    if (prev !== undefined) this.navigateTo(prev);
  }

  // ---- shell 菜单/工具栏接线入口（chrome：编辑组动作仅编辑模式可用） ----
  requestSave(): void {
    void this.save();
  }

  cmUndo(): void {
    if (this.view) void (undo(this.view) || undoSelection(this.view));
  }

  cmRedo(): void {
    if (this.view) void (redo(this.view) || redoSelection(this.view));
  }

  cmSelectAll(): void {
    if (this.view) void selectAll(this.view);
  }

  /**
   * Mod-v / 菜单粘贴的列粘贴路由（005 规则 5a v3.0）：矩形活动（有宽=覆盖、零宽=列插入/
   * 列位插入）恒拦截走 `cmdPaste` 语义矩阵；单光标 +（列模式开或来源标记弱命中）也拦截，
   * 终判在 cmdPaste 内按剪贴板实际文本比对（中途其它复制自动回普通粘贴）；其余返回 false
   * 交回 CM 原生粘贴（多选区行数匹配时自动逐行分发）。键位与右键/菜单粘贴同口径。
   */
  private pasteColumnIfApplicable(): boolean {
    if (!this.view) return false;
    if (this.columnRect) {
      void this.cmdPaste();
      return true;
    }
    const sel = this.view.state.selection;
    if (!(sel.ranges.length === 1 && sel.main.from === sel.main.to && (this.columnMode || wasRectCopy()))) return false;
    void this.cmdPaste();
    return true;
  }

  cmCopy(): void {
    if (!this.view) return;
    const r0 = this.activeRect();
    const rect = r0 && r0.colEnd > r0.colStart ? r0 : null; // 零宽矩形按普通光标复制（005 规则 5a ②）
    let text: string;
    if (rect) {
      text = rectText(rect, n => this.view.state.doc.line(n).text).join('\n');
    } else if (r0) {
      // 零宽矩形：按普通光标复制——空选区=行复制（与 CM 原生空选区同口径，含行尾换行）
      const main = this.view.state.selection.main;
      const ln = this.view.state.doc.lineAt(main.head);
      text = ln.text + (ln.number < this.view.state.doc.lines ? '\n' : '');
    } else {
      text = this.ranges().map(r => this.view.state.doc.sliceString(r.from, r.to)).join('\n');
    }
    markRectCopy(!!rect, text); // 005 规则 5 v2.2：列复制来源标记（菜单复制不经 clipboardOutputFilter）
    if (text) void writeClipboardText(text);
  }

  cmCut(): void {
    if (!this.view) return;
    this.cmCopy();
    this.cmdDelete();
  }

  cmPaste(): void {
    if (!this.view) return;
    // P1-3（005 规则 5 v2.2）：菜单/右键粘贴与键位同一判决——列模式下（或来源是矩形复制）
    // 多行剪贴板按列展开，修前菜单粘贴永远普通粘贴的口径分裂
    if (this.pasteColumnIfApplicable()) return;
    void readClipboardText().then(text => {
      if (!text) return;
      this.view.dispatch(
        this.view.state.replaceSelection(text)
      );
      this.view.focus();
    });
  }

  private docLines(): string[] {
    const doc = this.view.state.doc;
    const out: string[] = [];
    for (let i = 1; i <= doc.lines; i++) out.push(doc.line(i).text);
    return out;
  }

  private applyLineChanges(changes: { line: number; text: string }[]): void {
    const doc = this.view.state.doc;
    const ch = changes.map(c => {
      const l = doc.line(c.line);
      return { from: l.from, to: l.from + l.text.length, insert: c.text };
    });
    this.view.dispatch({ changes: ch });
    this.view.focus();
  }

  /** 列表批量替换（002 规则 28）：按列表顺序逐对全文档替换，返回合计次数 */
  applyBatchReplace(src: string, base: Omit<ReplaceOpts, 'find' | 'replaceWith'>): number {
    let total = 0;
    for (const p of parsePairs(src)) {
      const { changes, count } = replaceDocLines(this.docLines(), {
        ...base,
        find: p.find,
        replaceWith: p.replaceWith,
      });
      if (changes.length) this.applyLineChanges(changes);
      total += count;
    }
    return total;
  }

  /** 查找替换（002 规则 22 v1.5 / B-3 #8）：合并进 FindBar 替换行（原居中模态已删）。
   *  列范围替换保留在「批量替换」模态（多行列表承载更复杂的选项面）。
   *  seedText：外部带入的查找词（如渲染预览 ▸ 引导切源码时接力当前词），缺省取选区。 */
  openReplace(seedText?: string): void {
    if (!this.view) return;
    let seed = seedText;
    if (seed === undefined) {
      const sel0 = this.view.state.selection.main;
      seed = this.view.state.sliceDoc(sel0.from, sel0.to).slice(0, 200);
    }
    this.findBar?.show(seed, true);
  }

  /** 改写模式开关（005 规则 12：Insert 键或状态栏"插入"灯） */
  toggleOverwrite(): void {
    this.overwrite = !this.overwrite;
    this.report();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopParseWarmup?.(); // 解析预热随视图卸载（007 规则 22）
    this.stopParseWarmup = null;
    this.findBar?.el.remove(); // 查找栏随视图卸载（防销毁后计数定时器再触发一次查找 IPC）
    this.findBar = null;
    this.mm?.remove(); // 缩略图三件套随视图卸载（B-2）
    this.mm = null;
    this.view?.destroy();
  }
}
