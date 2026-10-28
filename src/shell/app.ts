// shell —— 应用骨架与总集成（001-008 各子 PRD 的装配层）
// 换肤批（001 v0.6）：自绘标题栏 / 菜单六 / 工具栏 / 状态栏三灯 / 侧栏新 IA / 命令面板 / 应用内对话框
import { homeDir } from '@tauri-apps/api/path';
const shellBridge = (globalThis as { __zieditTest?: Record<string, any> }).__zieditTest;
import { isCompositionKey } from './composition-key';
import { openUrl } from '@tauri-apps/plugin-opener';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { FileTree, kindOf, type TreeRoot } from '../file-tree/tree';
import { defaultModeFor, sanitize, MD_PREVIEW_LIMIT, WYSIWYG_LIMIT, lineBatchAllowed } from '../common/mode';
import {
  DEFAULT_SETTINGS,
  deleteToTrash,
  favoritesGroupAdd,
  favoritesGroupRemove,
  favoritesList,
  favoritesMove,
  favoritesToggle,
  fontRead,
  ooxmlClose,
  xlsxOpen,
  formatJson,
  formatXml,
  fileCreate,
  dirCreate,
  fileRename,
  fileStat,
  imageWrite,
  loadSession,
  namedSessionsLoad,
  namedSessionsSave,
  onCliOpen,
  cliTakePending,
  openFile,
  openLogDir,
  openWithDefault,
  revealInDir,
  allowAssetDir,
  recentAdd,
  recentClear,
  recentList,
  recentRemove,
  backupDir,
  saveSession,
  setSaveDefaults,
  settingsLoad,
  settingsSave as settingsSaveRaw,
  s3PutObject,
  s3GetImage,
  textOpen,
  textOpenMemoInvalidate,
  textClose,
  textReadAll,
  textSave,
  textRefresh,
  recoveryList,
  recoveryRead,
  recoverySnapshot,
  recoveryDiscard,
  recoveryClear,
  type OpenedInfo,
  type RecoveryItem,
  type SessionState,
  type Settings,
  type TabState,
} from '../common/ipc';
import { TabStore } from '../common/state';
import { convertEol, nlSaveName, NL_PRESETS, type NlId } from '../common/text';
import { writeClipboardText } from '../common/clipboard';
import { PreviewFind } from '../markdown-view/preview-find';
import type { TextView as TextViewT, TextViewStatus } from '../text-view/view';
import { Minimap } from '../text-view/minimap';
import type { EditStatus, EditView as EditViewT, LineBatchOp } from '../text-view/edit';
import type { EditorView } from '@codemirror/view';
import type { ImageView as ImageViewT } from '../image-view/view';
import type { LinkRouteOpts } from '../markdown-view/preview';
import type {
  ImageHostConfig,
  IngestPlan,
  trackImageTarget,
} from '../markdown-view/imagehost';
import type { LivePreviewView as LivePreviewViewT } from '../markdown-view/livepreview';
// 接线说明（007 v0.16）：LivePreviewView 仅此一处装配、无旧 IR 视图残留；
// 改懒加载——原静态形态为 import { LivePreviewView } from '../markdown-view/livepreview'
import type { HeadingItem } from '../markdown-view/preview';
import type { MdFormatCmd } from '../markdown-view/mdformat';
import type { CsvView as CsvViewT } from '../csv-view/table';
import type { CompareStatus, CompareView as CompareViewT } from '../compare-view/view';
import { NAV_SHORTCUTS } from '../compare-view/layout';
import { TailBoard, type TailStatus } from '../text-view/tailboard';
import { mountOutlineRows, parseOutlineHeadings } from './outline';
import {
  ActionRegistry,
  applyTheme,
  bindStatusHint,
  buildMenubar,
  buildToolbar,
  dlgAlert,
  dlgConfirm,
  dlgPrompt,
  brandSvg,
  icon,
  flash,
  initTitlebar,
  openPalette,
  openThemeDialog,
  L,
  overlayDialog,
  dlgPromptWithFormat,
  refreshTitlebar,
  setHintDefault,
  type CtxMenuItem,
  type OverlayMask,
  type MenuDef,
  type MenuEntry,
  type PaletteFileItem,
  type PaletteFileSource,
  type ToolbarSpec,
} from './chrome';
import { SidebarCtl, type RecentItem, type SidebarOpts } from './sidebar';
import { startAutosaveTimers, closeActionFor } from './autosave';
import type { EditorBuffer } from '../common/editor-buffer';
import { t as $t, tf as $tf, getLang, setLang, syncLangFromSettings, type Lang } from '../common/i18n';
import { normLocal, dirOf, isRealFilePath, isVirtualTab, deriveTreeRoot } from '../common/paths';
import { snapshotHint, INITIAL_SNAP_HINTS } from './recovery-hints';
import { placePopup, placeSubmenu } from '../common/popup';
import { effectiveCloseAction } from './close-behavior';
import { snapshotDocument } from '../common/snapshot';

// ---- 视图懒加载（性能）----
// 六个视图（TextView/EditView/ImageView/LivePreviewView/CsvView/CompareView）与 preview/blockcache
// 等重依赖（CodeMirror、语言包、markdown-it、图床件）离开首屏 chunk：首次挂载时动态 import 并
// 缓存模块 Promise（并发挂载共享同一加载）。顶层绑定用占位实现兜底——加载前不可能存在对应实例
// 或调用场景，占位仅保证语义安全（instanceof 恒 false、常量取安全缺省、纯函数零副作用），
// 模块就位即覆写为真实实现（挂载分支在构造视图前 await，保证此后 instanceof/调用全部生效）。
type TextViewModule = typeof import('../text-view/view');
type EditModule = typeof import('../text-view/edit');
type ImageViewModule = typeof import('../image-view/view');
type PreviewModule = typeof import('../markdown-view/preview');
type BlockcacheModule = typeof import('../markdown-view/blockcache');
type ImagehostModule = typeof import('../markdown-view/imagehost');
type MdFormatModule = typeof import('../markdown-view/mdformat');
type LivePreviewModule = typeof import('../markdown-view/livepreview');
type CsvModule = typeof import('../csv-view/table');
type CompareModule = typeof import('../compare-view/view');

const notLoaded = (name: string): never => {
  throw new Error(`view module not loaded: ${name}`);
};

let TextView: TextViewModule['TextView'] = class {} as unknown as TextViewModule['TextView'];
let ImageView: ImageViewModule['ImageView'] = class {} as unknown as ImageViewModule['ImageView'];
let EditView: EditModule['EditView'] = class {} as unknown as EditModule['EditView'];
let LivePreviewView: LivePreviewModule['LivePreviewView'] = class {} as unknown as LivePreviewModule['LivePreviewView'];
let CsvView: CsvModule['CsvView'] = class {} as unknown as CsvModule['CsvView'];
let CompareView: CompareModule['CompareView'] = class {} as unknown as CompareModule['CompareView'];
// 与 text-view/edit 同源常量（10MB）；编辑模块加载后以真实值覆写校准
let EDIT_LIMIT = 10 * 1024 * 1024;
// 高亮语言清单预置（与 text-view/highlight 的 HIGHLIGHT_LANGS 同源快照）：仅作模块就位前的
// 状态栏语言弹窗兜底（生产环境中模块在任何视图挂载时即随主模块加载，弹窗必晚于绑定覆写）；
// 权威清单仍在 highlight.ts，加载后整表覆写
let HIGHLIGHT_LANGS: readonly string[] = [
  'JSON', 'JavaScript', 'TypeScript', 'Markdown', 'YAML', 'XML', 'HTML', 'CSS',
  'C', 'C++', 'Python', 'Rust', 'Java', 'SQL', 'Log', 'Go', 'Shell', 'Batch', 'PowerShell', 'Config',
];
type CommandsModule = typeof import('@codemirror/commands');
let undoDepth: CommandsModule['undoDepth'] = () => 0;
let redoDepth: CommandsModule['redoDepth'] = () => 0;
let cmEditorView: typeof EditorView | null = null;
let runMdFormat: MdFormatModule['runMdFormat'] = () => notLoaded('mdformat');
let editMarkdownLink: MdFormatModule['editMarkdownLink'] = () => notLoaded('mdformat');
let MD_INLINE_COMMANDS: MdFormatModule['MD_INLINE_COMMANDS'] = [] as unknown as MdFormatModule['MD_INLINE_COMMANDS'];
let MD_BLOCK_COMMANDS: MdFormatModule['MD_BLOCK_COMMANDS'] = [] as unknown as MdFormatModule['MD_BLOCK_COMMANDS'];
let previewAnchorBefore: PreviewModule['previewAnchorBefore'] = () => notLoaded('preview');
let renderPreviewInto: PreviewModule['renderPreviewInto'] = () => notLoaded('preview');
let externalHrefAt: PreviewModule['externalHrefAt'] = () => notLoaded('preview');
let captureTopBlock: PreviewModule['captureTopBlock'] = () => notLoaded('preview');
let restoreTopBlock: PreviewModule['restoreTopBlock'] = () => notLoaded('preview');
let joinRelPath: PreviewModule['joinRelPath'] = () => notLoaded('preview');
let decodeLocalRef: PreviewModule['decodeLocalRef'] = () => notLoaded('preview');
let createBlockRenderer: BlockcacheModule['createBlockRenderer'] = () => notLoaded('blockcache');
let xlsxRecordProvider: CsvModule['xlsxRecordProvider'] = () => notLoaded('csv');

/** 图床件懒绑定（imagehost 引 @codemirror/view，未启用时保持零加载；同步入口取安全缺省） */
let imagehostMod: ImagehostModule | null = null;
let clipboardImageOf: ImagehostModule['clipboardImageOf'] = () => null;
let mimeOfPath: ImagehostModule['mimeOfPath'] = () => null;
let bytesToBase64: ImagehostModule['bytesToBase64'] = () => notLoaded('imagehost');
let imagehostPromise: Promise<ImagehostModule> | null = null;
const ensureImagehost = (): Promise<ImagehostModule> =>
  (imagehostPromise ??= import('../markdown-view/imagehost').then(m => {
    imagehostMod = m;
    clipboardImageOf = m.clipboardImageOf;
    mimeOfPath = m.mimeOfPath;
    bytesToBase64 = m.bytesToBase64;
    return m;
  }));

let textViewPromise: Promise<TextViewModule> | null = null;
const loadTextView = (): Promise<TextViewModule> =>
  (textViewPromise ??= import('../text-view/view').then(m => {
    TextView = m.TextView;
    // 伴生绑定后台就位：生产环境 highlight 随主模块同图（静态依赖）已被求值，此 import 为
    // 缓存命中（微任务级）；不阻塞挂载链
    void import('../text-view/highlight').then(hl => { HIGHLIGHT_LANGS = hl.HIGHLIGHT_LANGS; }).catch(() => undefined);
    return m;
  }));

let editPromise: Promise<EditModule> | null = null;
const loadEdit = (): Promise<EditModule> =>
  (editPromise ??= import('../text-view/edit').then(m => {
    EditView = m.EditView;
    EDIT_LIMIT = m.EDIT_LIMIT;
    // 伴生模块（highlight/mdformat/commands/view/imagehost）均为 edit 的静态依赖——
    // 主模块就位时其模块体已求值，下列 import 只取缓存引用（微任务级），后台补绑定即可：
    // 菜单/撤销深度/滚动定位/粘贴入稿都发生在挂载完成之后，不存在同挂载链的同步依赖
    void Promise.all([
      import('../text-view/highlight'),
      import('../markdown-view/mdformat'),
      import('@codemirror/commands'),
      import('@codemirror/view'),
      ensureImagehost(), // 粘贴/拖放图片入稿（md 源码态）依赖
    ]).then(([hl, md, cmd, cmv]) => {
      HIGHLIGHT_LANGS = hl.HIGHLIGHT_LANGS;
      runMdFormat = md.runMdFormat;
      editMarkdownLink = md.editMarkdownLink;
      MD_INLINE_COMMANDS = md.MD_INLINE_COMMANDS;
      MD_BLOCK_COMMANDS = md.MD_BLOCK_COMMANDS;
      undoDepth = cmd.undoDepth;
      redoDepth = cmd.redoDepth;
      cmEditorView = cmv.EditorView;
    }).catch(() => undefined);
    return m;
  }));

let previewKitPromise: Promise<void> | null = null;
const loadPreviewKit = (): Promise<void> =>
  (previewKitPromise ??= Promise.all([
    import('../markdown-view/preview'),
    import('../markdown-view/blockcache'),
    ensureImagehost().catch(() => undefined), // 静态渲染/分屏右栏远程图回填（失败不阻断渲染）
  ]).then(([pv, bc]) => {
    previewAnchorBefore = pv.previewAnchorBefore;
    renderPreviewInto = pv.renderPreviewInto;
    externalHrefAt = pv.externalHrefAt;
    captureTopBlock = pv.captureTopBlock;
    restoreTopBlock = pv.restoreTopBlock;
    joinRelPath = pv.joinRelPath;
    decodeLocalRef = pv.decodeLocalRef;
    createBlockRenderer = bc.createBlockRenderer;
  }));

let livePreviewPromise: Promise<LivePreviewModule> | null = null;
const loadLivePreview = (): Promise<LivePreviewModule> =>
  (livePreviewPromise ??= import('../markdown-view/livepreview').then(m => {
    LivePreviewView = m.LivePreviewView;
    // preview/图床件为 IR 静态依赖（同图已求值），后台补绑定
    void loadPreviewKit().catch(() => undefined);
    return m;
  }));

let imageViewPromise: Promise<ImageViewModule> | null = null;
const loadImage = (): Promise<ImageViewModule> =>
  (imageViewPromise ??= import('../image-view/view').then(m => {
    ImageView = m.ImageView;
    return m;
  }));

let csvPromise: Promise<CsvModule> | null = null;
const loadCsv = (): Promise<CsvModule> =>
  (csvPromise ??= import('../csv-view/table').then(m => {
    CsvView = m.CsvView;
    xlsxRecordProvider = m.xlsxRecordProvider;
    return m;
  }));

let comparePromise: Promise<CompareModule> | null = null;
const loadCompare = (): Promise<CompareModule> =>
  (comparePromise ??= import('../compare-view/view').then(m => {
    CompareView = m.CompareView;
    return m;
  }));

// panels 懒加载（panels 静态引 text-view/highlight——Lezer 语言包+CM 属重依赖）：
// 校验和/查找/规范化等面板函数首次使用时经 ensurePanels 取用
type PanelsModule = typeof import('./panels');
let panelsPromise: Promise<PanelsModule> | null = null;
const ensurePanels = (): Promise<PanelsModule> => (panelsPromise ??= import('./panels'));

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error($tf('err.missingEl', id));
  return e;
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ENCODING_CYCLE = ['UTF-8', 'GBK', 'GB18030', 'Big5', 'Shift_JIS', 'windows-1252'];

/** 大纲可用语言（006 规则 6：不在此列的文本类型页签置灰） */
const OUTLINE_LANGS = new Set([
  'JavaScript', 'TypeScript', 'Python', 'Rust', 'Markdown', 'JSON', 'YAML', 'C', 'C++', 'Java',
]);

// v2.6 起 'md'（独立渲染预览）删除——Markdown 三形态 = 源码（'edit' 编辑面）/ 分屏 / 即时渲染
type ViewMode = 'md' | 'view' | 'edit' | 'split' | 'csv' | 'wysiwyg';


// MD_PREVIEW_LIMIT 迁至 common/mode.ts 与 EDIT_LIMIT/WYSIWYG_LIMIT 同源（007 v0.8）

/** 菜单六结构（001 规则 19）：模块级纯数据定义，boot 与菜单结构单测共用；命名会话/最近打开等动态条目经回调注入 */
export function buildMenus(
  sessionNames: () => string[],
  recentFiles: () => Array<{ path: string; isDir: boolean }>
): MenuDef[] {
  return [
    {
      label: 'menu.fileF',
      entries: () => [
        { action: 'file.newDraft' }, { action: 'file.openFile' }, { action: 'file.openFolder' },
        { label: 'menu.recent', children: () => recentFiles().slice(0, 10).map(r => ({ action: `file.recent:${r.path}` })) },
        { sep: true },
        { action: 'file.save' }, { action: 'file.saveAs' },
        // 转换类另存收拢为一个子菜单（2026-10 菜单梳理）：与「另存为」同族但不平铺
        { label: 'menu.convertSave', children: () => [
          { action: 'edit.normalize' }, { action: 'edit.encSave' }, { action: 'edit.nlSave' },
        ] },
        { action: 'file.reload' },
        { sep: true },
        // 命名会话收进子菜单：文件菜单不随会话数量变长；空列表不出分隔线
        { label: 'menu.sessions', children: () => {
          const names = sessionNames();
          return [
            { action: 'file.saveSession' },
            ...(names.length ? [{ sep: true } as MenuEntry] : []),
            ...names.map(name => ({ action: `file.session:${name}` })),
          ];
        } },
        { sep: true },
        { action: 'file.closeTab' }, { action: 'file.exit' },
      ],
    },
    {
      label: 'menu.editF',
      entries: () => [
        { action: 'edit.undo' }, { action: 'edit.redo' },
        { sep: true },
        { action: 'edit.cut' }, { action: 'edit.copy' }, { action: 'edit.paste' }, { action: 'edit.selectAll' },
        { sep: true },
        { action: 'edit.format' }, { action: 'edit.column' },
        { sep: true },
        // 全局只读是编辑开关（作用所有标签），归编辑而非工具
        { action: 'view.readOnly' },
      ],
    },
    {
      label: 'menu.searchF',
      entries: () => [
        { action: 'find.find' }, { action: 'find.findInFiles' },
        { sep: true },
        { action: 'find.replace' }, { action: 'find.batchReplace' },
        { sep: true },
        { action: 'find.goto' },
      ],
    },
    {
      label: 'menu.viewF',
      entries: () => [
        { action: 'view.text' },
        { label: 'menu.markdown', children: () => [
          { action: 'view.mdSource' }, { action: 'view.mdSplit' }, { action: 'view.mdPreview' }, { action: 'view.mdWysiwyg' },
        ] },
        { sep: true },
        { action: 'view.toggleTree' },
        { sep: true },
        { action: 'view.minimap' },
        { action: 'view.toggleRuler' },
        { action: 'view.lineNumbers' },
        { action: 'view.invisible' },
        { action: 'view.wrap' },
        { sep: true },
        // 外观统一收口（2026-10 菜单梳理）：主题/文字大小/字体原横跨视图与工具两个菜单
        { label: 'menu.appearance', children: () => [
          { action: 'view.theme' },
          { label: 'menu.zoomGroup', children: () => [
            { action: 'view.zoomIn' }, { action: 'view.zoomOut' }, { action: 'view.zoomReset' },
          ] },
          { label: 'menu.fontGroup', children: () => [
            { action: 'tools.importFont' }, { action: 'tools.fontReset' },
          ] },
        ] },
      ],
    },
    {
      label: 'menu.toolsF',
      entries: () => [
        { action: 'tools.palette' },
        { sep: true },
        // 独立工作流类工具（双文件比较/日志尾随/图床/备份）与面板入口
        { action: 'file.compare' },
        { action: 'view.tailboard' },
        { action: 'tools.imageHost' },
        { action: 'tools.openBackup' },
        { sep: true },
        { action: 'tools.settings' },
      ],
    },
    {
      label: 'menu.helpF',
      entries: () => [
        { action: 'help.manual' },
        { action: 'help.shortcuts' },
        { sep: true },
        { action: 'help.about' },
      ],
    },
  ];
}

export async function boot(): Promise<void> {
  const sidebarEl = el('sidebar');
  const tabbar = el('tabbar');
  const viewarea = el('viewarea');
  const statusbar = el('statusbar');

  // ---- 设置与主题（先于渲染，避免闪色；001 规则 21） ----
  let settings: Settings = { ...DEFAULT_SETTINGS };
  // 图床凭据仅留在本次进程内存；所有设置落盘前都剔除，避免旧字段或后续设置写入重新泄漏。
  const settingsSave = (s: Settings | Record<string, unknown> = settings): void => {
    const persisted: Record<string, unknown> = { ...s };
    delete persisted.s3Credentials;
    void settingsSaveRaw(persisted);
  };
  const applySavedTheme = (s: Settings) => applyTheme(s.theme ?? 'paper');

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSave = (s: SessionState) => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveSession(captureDrafts(s)), 500);
  };

  // 标签栏滚轮横滚 + 窗口缩放后刷新溢出按钮（#25）
  tabbar.addEventListener(
    'wheel',
    e => {
      if (tabbar.scrollWidth <= tabbar.clientWidth) return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        tabbar.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
    { passive: false }
  );
  window.addEventListener('resize', () => requestAnimationFrame(refreshTabbarChrome));

  const store = new TabStore({ onSave: scheduleSave, onChanged: () => render() });

  // ---- H-3：Ctrl+Tab MRU 与「重开关闭标签」（Ctrl+Shift+T）----
  let mruOrder: string[] = []; // path 序列，最近使用在前
  let lastActivePath: string | null = null;
  const closedTabs: Array<{ path: string; route: 'text' | 'image'; language: string | null }> = [];
  {
    // 记录关闭（包装 store.close，覆盖关闭守卫/中键/关闭全部全部路径）
    const origClose = store.close.bind(store);
    store.close = (i: number): void => {
      const t = store.tabs[i];
      if (t && !isVirtualTab(t.path)) {
        closedTabs.unshift({ path: t.path, route: t.route, language: t.language });
        if (closedTabs.length > 16) closedTabs.pop();
      }
      mruOrder = mruOrder.filter(p => p !== t?.path);
      origClose(i);
      if (t) {
        wysiwygHeadings.delete(t.path);
        csvDelimiters.delete(t.path);
      }
      if (t && !isVirtualTab(t.path)) {
        textOpenMemoInvalidate(t.path); // 标签关闭：备忘的 text_open 结果随句柄一并失效（重开重新探测）
        void textClose(t.path).catch(err => console.warn('text_close', String(err)));
        if (['Docx', 'Xlsx', 'Pdf'].includes(t.language ?? '')) void ooxmlClose(t.path).catch(err => console.warn('ooxml_close', String(err)));
      }
      syncTreeRootToActive(); // 001 规则 25 v2.0：关标签后按剩余活动标签重算树根（全关即清空）
    };
  }
  // R5 v0.46：open / activate / setRoute 直接切换；脏缓冲随标签保留，关闭才确认。
  function touchMru(path: string): void {
    mruOrder = [path, ...mruOrder.filter(p => p !== path)];
  }
  /** Ctrl+Tab：切换到最近使用的其他标签（001 规则 14 MRU 口径，H-3 修正原顺序切换） */
  function activateMruNext(): void {
    const cur = activeTab()?.path;
    const next = mruOrder.find(p => p !== cur && store.tabs.some(t => t.path === p));
    if (!next) {
      // 无历史（如首切）：退化为顺序下一个
      if (store.tabs.length > 1) store.activate((store.activeIndex + 1) % store.tabs.length);
      return;
    }
    store.activate(store.tabs.findIndex(t => t.path === next));
  }
  /** Ctrl+Shift+T：按关闭序重开最近关闭的标签 */
  function reopenClosedTab(): void {
    while (closedTabs.length) {
      const t = closedTabs.shift()!;
      if (!store.tabs.some(x => x.path === t.path)) {
        void openPath(t.path);
        return;
      }
    }
    flash($t('msg.noClosedTab'));
  }
  /** Ctrl+Shift+W：关闭全部（脏标签逐个走关闭守卫；关闭后续关下一个，P0-2/Z2-31）。
   *  净标签同步关后由 after 链继续；脏标签由确认回调续链；取消即停（剩余保留）。 */
  function closeAllTabs(): void {
    if (!store.tabs.length) return;
    closeTabGuarded(store.tabs.length - 1, () => closeAllTabs());
  }

  // ---- 全局状态 ----
  let currentView: TextViewT | EditViewT | CsvViewT | LivePreviewViewT | CompareViewT | ImageViewT | null = null;
  let viewCleanup: (() => void) | null = null;
  let currentViewKey = '\u0000'; // 哨兵：与任何真实 key（含无标签的 ''）都不相等，确保首帧渲染空态（P2-13）
  let viewStatus: TextViewStatus | null = null;
  let editStatus: EditStatus | null = null;
  let cmpStatus: CompareStatus | null = null;
  let cmpView: CompareViewT | null = null; // 在场比较视图（差异导航动作的 enabled 判决，001 规则 34 v2.4）
  let tailStatus: TailStatus | null = null;
  let tailBoard: TailBoard | null = null;
  let wysiwygDirty = false;
  let wyStats = { chars: 0, lines: 0 }; // IR 字数/行数（状态栏「N 字 · M 行」格，007 v0.11）
  let wyPos = { line: 1, col: 1 }; // IR 光标行列（状态栏行列格，与 EditView 同口径）
  const modeMap = new Map<string, ViewMode>(); // path → 视图模式（不持久化）
  const wrapMap = new Map<string, boolean>(); // path → 软换行（002 规则 11 v1.4，会话内按标签记忆）
  const csvDelimiters = new Map<string, string>(); // 显式选择随标签保留，视图重建不再重新嗅探。
  const editorBuffers = new Map<string, EditorBuffer>();
  const discardedBuffers = new Set<string>();
  const recoveryPending = new Map<string, { content: string; diskChanged: boolean }>(); // 崩溃恢复待挂载内容（002 规则 29）
  const modeLock = new Map<string, boolean>(); // 渲染守卫：视图切换中
  const pendingMount = new Map<string, { tab: TabState; mode: ViewMode }>(); // 挂载中收到的最新意图（B0）
  // fileSizes/fileMtimes：路径 → 磁盘大小/修改时间，是「大小」显示的唯一数据源。
  // 契约（H-6f）：**改动这两张表的调用点负责失效其派生显示**——状态栏大小格走 renderStatus()，
  // 标签悬停（修改时间/大小）走 renderTabs()；两处都只在渲染时读一次，不失效就会停在旧值。
  // 四个写入点：openFile（其后必 render）、ensureFileMeta（元信息就绪后 renderStatus）、
  // 外部修改轮询（两分支各自重渲染）、noteSaved（保存收口，异步取到 stat 后 renderStatus + renderTabs）。
  const fileSizes = new Map<string, number>(); // openFile 时记录，供 WYSIWYG 路由
  const fileMtimes = new Map<string, number>(); // openFile 时记录修改时间，供状态栏「修改」列
  const LANGUAGE_EXT: Record<string, string> = { Markdown: 'md', JSON: 'json', YAML: 'yaml', XML: 'xml', HTML: 'html', CSS: 'css', C: 'c', 'C++': 'cpp', Python: 'py', Rust: 'rs', Go: 'go', Java: 'java', JavaScript: 'js', TypeScript: 'ts', SQL: 'sql', Shell: 'sh', Batch: 'bat', PowerShell: 'ps1' };
  const fileReadonly = new Set<string>(); // openFile 时记录只读位（001 规则 23 可写灯；v2.6 起不再是编辑闸——只读文件照常进编辑面，Ctrl+S E1003 兜底）
  const tabLock = new Set<string>(); // 本标签编辑锁，仅当前会话有效
  if (shellBridge) Object.assign(shellBridge, { store, tabLock, getSettings: () => settings, setSettings: (v: Settings) => { settings = v; }, getMode: () => shellBridge._mode });
  const encodingByPath = new Map<string, string>(); // 各路径当前编码（B3：避免跨标签串用活动视图编码）
  const saveEpochByPath = new Map<string, number>();
  const dirtyPaths = new Map<string, boolean>(); // 各标签编辑缓冲脏标记，驱动标签圆点
  const hlOverride = new Map<string, string>(); // path → 手动指定高亮语言（'auto'=跟随扩展名，''=纯文本；状态栏语言弹窗）
  let previewHostEl: HTMLElement | null = null; // 静态预览宿主（独立/分屏，大纲定位用）
  let previewFind: PreviewFind | null = null;
  let wyMinimap: Minimap | null = null; // WYSIWYG 缩略图（同上）
  let previewMinimapCleanup: (() => void) | null = null;
  let recentCache: RecentItem[] = []; // 命令面板文件搜索来源（最近+收藏，不做全盘扫描）
  let favCache: RecentItem[] = [];
  const wysiwygHeadings = new Map<string, HeadingItem[]>(); // 大纲联动（007 规则 3）
  let namedSessions: Record<string, SessionState> = {};
  let markerOverlay: HTMLDivElement | null = null;
  let markerScrollDetach: (() => void) | null = null;
  let statusHintEl: HTMLSpanElement | null = null; // 常驻提示节点（B4：不随状态栏重建而丢失 flash 文案）
  let sidebarVisible = true;
  let toolbarCtl: { refresh: () => void } | null = null; // 工具栏控制器（语言切换时就地重建）
  let sidebarCtl!: SidebarCtl; // 侧栏控制器（语言切换时就地重建）
  let menubarCtl: { refresh: () => void; dispose: () => void; open: (i: number) => void } | null = null; // 菜单栏控制器（Alt 助记键 open 用）
  let localRoot: string | null = null; // 目录跟随（001 规则 25）：null = 空态
  // v2.5：「打开文件夹…」/最近目录显式指定的根——仅剩伪路径标签时树不清空（豁免自动清空）
  let explicitRoot = false;
  let homeDirCached = 'C:\\'; // 跨文件搜索等场景的兜底根
  let tree: FileTree | null = null;

  // ---- 视图模式与渲染 ----
  /** Markdown 文件是否可进即时渲染（007 规则 6：≤4MiB，只读 .md 同权——
   *  v2.6 起所有形态都在编辑缓冲内承载，保存侧 E1003 口径统一兜底，IR 不再单独设只读闸） */
  const wysiwygEligible = (tab: TabState): boolean =>
    tab.language === 'Markdown' &&
    (fileSizes.get(tab.path) ?? (tab.path.startsWith('draft://') ? 0 : Infinity)) <= WYSIWYG_LIMIT;
  /** 分屏右栏保留整篇 DOM，独立限制为 ≤2MiB。 */
  const mdSplitEligible = (tab: TabState): boolean =>
    tab.language === 'Markdown' &&
    (fileSizes.get(tab.path) ?? 0) <= MD_PREVIEW_LIMIT;

  const modeOf = (tab: TabState): ViewMode => {
    if (tab.language === 'Docx' || tab.language === 'Pdf') return 'view';
    if (tab.language === 'Xlsx') return 'csv';
    if (tab.route !== 'text') return 'view';
    // B-1 状态模型：modeMap 只记用户显式选择；缺省由 settings+元数据推（mode.ts 一个真相源）
    const meta = {
      language: tab.language,
      isDraft: tab.path.startsWith('draft://'),
      readonly: fileReadonly.has(tab.path),
      size: fileSizes.get(tab.path) ?? 0,
    };
    const mode = sanitize(modeMap.get(tab.path), meta) ?? defaultModeFor(meta, settings);
    if (shellBridge) shellBridge._mode = mode;
    return mode;
  };

  /** B-1 统一入口：记录用户显式选择的模式并重渲染（替换散落的 modeMap.set+render）。
   *  R5：切形态免确认，缓冲与脏标随标签驻留。
   *  D-T2-05：同键切换早退——已是该形态再点菜单/快捷键不重挂不重建（分屏填充中点同形态
   *  菜单项零扰动；modeMap 与 currentViewKey 双判防视图键失效时误吞真实重挂）。 */
  function setMode(tab: TabState, m: ViewMode): void {
    // F12（2026-10 审计）：早退比较与存储都用 sanitize 裁决后的形态——修前存的是请求值：
    // 被拒的形态滞留 modeMap 导致同菜单项反复点击每次重挂，且文件变小后非法形态会突然生效。
    modeMap.set(tab.path, m);
    const effective = modeOf(tab); // 裁决入口与读取同源（sanitize ?? default）
    modeMap.set(tab.path, effective);
    if (currentViewKey === `${tab.path}#${tab.route}#${effective}`) return;
    // 同文件换形态保留缓冲；仅关闭/退出走保存确认。
    render();
  }

  const activeTab = () => store.active();
  const activeName = (): string | null => {
    const t = activeTab();
    if (!t) return null;
    return t.path.startsWith('draft://')
      ? $tf('tab.draft', t.path.slice(8))
      : t.path.replace(/\\/g, '/').split('/').pop() ?? t.path;
  };

  const render = () => {
    // H-3：MRU 序列维护（激活变化时把当前标签置顶）
    const at = activeTab()?.path;
    if (at && at !== lastActivePath) {
      lastActivePath = at;
      touchMru(at);
    }
    renderTabs();
    maybeRenderView();
    renderStatus();
    applyRulerVisible();
    tree?.setActive(activeTab()?.path ?? null);
    syncTreeRootToActive(); // 目录跟随（001 规则 25 v2.0）：切标签换根/全关树空，幂等
    refreshTitlebar();
    toolbarCtl?.refresh();
    sidebarCtl?.refreshOutlineState();
  };

  /** 目录跟随（001 规则 25 v2.0/v2.5）：活动标签决定树根（判决在 common/paths.ts deriveTreeRoot）。
   *  切标签（render）/关闭标签（store.close 包装）/会话恢复同口径；打开文件另有
   *  syncTreeToFile 的 reveal 优先路径（同根内先展开定位不重建），本函数幂等不与之冲突。
   *  v2.5：仅剩伪路径标签（草稿/对比/尾随台，无任何真实文件标签存续）时树清空回空态——
   *  修前 deriveTreeRoot 对伪标签恒 keep，关掉全部真实文件只剩草稿时树残留旧目录；
   *  显式指定的根（explicitRoot）不受自动清空影响。 */
  function syncTreeRootToActive(): void {
    const hasRealTabs = store.tabs.some(t => isRealFilePath(t.path));
    const t = activeTab();
    const verdict = deriveTreeRoot(t ? t.path : null, localRoot, hasRealTabs);
    if (verdict === 'keep') return;
    // 显式根豁免（001 规则 25 v2.5 + 2026-10 上级导航）：打开文件夹/「返回上级」指定的根
    // 不被目录跟随拉回（切标签/渲染不再夺根）；跟随在下次打开根外文件时经 syncTreeToFile 重启。
    if (explicitRoot) return;
    localRoot = verdict;
    explicitRoot = false;
    void rebuildTree();
  }

  async function openPath(path: string, line?: number, isDir = false, opts?: { syncTree?: boolean }): Promise<void> {
    if (isDir) {
      localRoot = normLocal(path);
      explicitRoot = true; // v2.5：显式指定根——后续仅剩伪标签时不清树
      void recentAdd(path).then(() => void refreshRecents());
      await rebuildTree();
      return;
    }
    await openFileIntoTab(path, line, opts);
  }

  async function openFileIntoTab(path: string, line?: number, opts?: { syncTree?: boolean }): Promise<void> {
    try {
      const info: OpenedInfo = await openFile(path);
      // B-1：默认模式改由 modeOf 按 settings+元数据推导（mode.ts），openPath 不再写 modeMap。
      // 元数据须在 store.open 之前就位——open 同步触发渲染，否则先按缺省查看态挂载
      // H-5 T9：asset 协议 scope 已收紧为空——图片视图与 Markdown（本地图片解析）打开前放行其目录
      if (info.route === 'image' || info.language === 'Markdown') {
        // 非递归目录授权须在首帧解析图片前完成；子/上级引用仍逐文件授权。
        await allowAssetDir(dirOf(info.path)).catch(err => console.warn('allow_asset_dir', String(err)));
      }
      fileSizes.set(info.path, info.len);
      fileMtimes.set(info.path, info.modifiedMs);
      // text_open 按路径备忘预热——挂载链上 currentEncoding 与 EditView 探测的两次
      // text_open 均命中备忘，打开路径串行 IPC 由 4 次（open_file/text_open×2/text_read_all）
      // 降为 2 次（open_file → text_read_all，text_open 与模块加载并行已在挂载分支处理）
      if (info.route === 'text') void textOpen(info.path).catch(() => undefined);
      deletedPaths.delete(info.path); // 重新打开成功 = 文件在场，清删除标记（F001-03）
      if (info.readonly) fileReadonly.add(info.path);
      else fileReadonly.delete(info.path);
      // 002-AC-26 v2.6：>10MB 走流式查看面 → 轻提示一次（只读不再拦截——照常进编辑面，故无只读提示）
      // （CSV/TSV 默认表格态本就可用，超限不算"被拦"，不提示）
      const tableLang = info.language === 'CSV' || info.language === 'TSV';
      if (info.route === 'text' && !tableLang && info.len > EDIT_LIMIT) {
        flash($tf('edit.tooLarge', (info.len / 1048576).toFixed(1)));
      }
      store.open({ path: info.path, route: info.route, language: info.language, scroll: 0, bookmarks: [] });
      void recentAdd(info.path).then(() => void refreshRecents());
      // 目录跟随（001 规则 25）：树根切到文件所在目录并定位高亮
      if (opts?.syncTree !== false && isRealFilePath(info.path)) syncTreeToFile(info.path);
      if (line && info.route === 'text') {
        // 等视图挂载后定位（打开即编辑后通常为 EditView，两态都支持）
        setTimeout(() => {
          if (currentView instanceof TextView) void currentView.goToLine(line, undefined, true);
          else if (currentView instanceof EditView) void currentView.goToLine(line);
        }, 350);
      }
    } catch (err) {
      flash($tf('err.openFail', String(err)));
      dlgAlert($tf('err.openFail', String(err)));
    }
  }

  // ---- 目录跟随（001 规则 25）：串行执行，避免多文件并发打开时重建竞态 ----
  let treeSyncQueue: Promise<void> = Promise.resolve();
  function syncTreeToFile(filePath: string): void {
    treeSyncQueue = treeSyncQueue
      .then(async () => {
        if (!tree) return;
        if (await tree.reveal(filePath)) return; // 已在当前根下：仅定位，不重建
        localRoot = normLocal(dirOf(filePath));
        explicitRoot = false; // 根因跟随文件而变，不再视为显式指定
        await rebuildTree();
        await tree?.reveal(filePath);
      })
      .catch(() => { /* 目录跟随失败不阻断打开 */ });
  }

  /** 补齐文件元信息（会话恢复/CLI 打开未经 openPath 的标签：大小/修改时间/只读，状态栏列依赖）。
   *  v1.4：元数据就绪后按规则 7b 落默认模式（≤10MB 且可写 → 编辑），闪切一次可接受。 */
  function ensureFileMeta(path: string): void {
    if (!isRealFilePath(path) || fileMtimes.has(path)) return;
    fileMtimes.set(path, 0); // 先占位防重复请求
    void openFile(path)
      .then(async info => {
        if (info.language === 'Markdown' || info.route === 'image') {
          await allowAssetDir(dirOf(info.path)).catch(err => console.warn('allow_asset_dir', String(err)));
        }
        fileSizes.set(path, info.len);
        fileMtimes.set(path, info.modifiedMs);
        if (info.readonly) fileReadonly.add(path);
        else fileReadonly.delete(path);
        // B-1：元数据就绪后 modeOf 自行推导默认模式；modeMap 未记用户选择时按新元数据重挂载
        if (activeTab()?.path === path) render();
        else renderStatus();
      })
      .catch(() => fileMtimes.delete(path));
  }

  // ---- 草稿标签（001 规则 18）----
  let draftSeq = 1;
  /** 会话恢复的草稿序号取历史最大续排（001 规则 25 v2.5）：修前重启后计数归 1，
   *  Ctrl+N 生成 draft://1 会撞号激活恢复的同号草稿（open 按 path 去重，新草稿被吞）。 */
  function bumpDraftSeqFromStore(): void {
    for (const t of store.tabs) {
      if (t.path.startsWith('draft://') && typeof t.draftContent === 'string') {
        draftContent.set(t.path, t.draftContent);
        dirtyPaths.set(t.path, true);
      }
      const m = /^draft:\/\/(\d+)$/.exec(t.path);
      if (m) draftSeq = Math.max(draftSeq, Number(m[1]) + 1);
    }
  }
  function newDraft(content = ''): void {
    const path = `draft://${draftSeq++}`;
    modeMap.set(path, 'edit');
    draftContent.set(path, content);
    store.open({ path, route: 'text', language: null, scroll: 0, bookmarks: [] });
    render();
  }
  const draftContent = new Map<string, string>();

  function captureDrafts(session: SessionState): SessionState {
    for (const tab of session.tabs) {
      if (!tab.path.startsWith('draft://')) continue;
      const content = currentView instanceof EditView && currentViewKey.split('#')[0] === tab.path && currentView.view
        ? currentView.view.state.doc.toString()
        : draftContent.get(tab.path) ?? tab.draftContent ?? '';
      draftContent.set(tab.path, content);
      tab.draftContent = content;
    }
    return session;
  }

  // ---- 脏标签关闭确认（ADR 012；任何脏标签——含非激活——都必须经确认，保存成功才允许关） ----

  /** 外链交系统浏览器（R1 决策：应用进程零网络，openUrl 仅把 URL 递给 OS 默认处理器） */
  function openExternalUrl(url: string): void {
    void openUrl(url).catch(err => flash($tf('err.openUrlFail', String(err))));
  }

  /** 预览/分屏的链接路由（R1）：Ctrl+点击外链系统浏览器、.md 相对新标签、普通点击提示 */
  function mdLinkRoute(tab: TabState): LinkRouteOpts {
    return {
      baseDir: () => (isRealFilePath(tab.path) ? dirOf(tab.path) : null),
      openMarkdown: p => void openPath(p),
      openExternal: openExternalUrl,
      hint: msg => flash(msg),
      interactive: false,
    };
  }

  // ---- 图床（009 v0.2 / ADR 016：应用零网络的唯一例外；未启用时零入口零连接，规则 1/2） ----
  // 上传器会话级单例（规则 8：同内容去重 + ≤2 并发队列）；出网仅 s3PutObject 一处注入。
  // 图床件随视图懒加载（imagehost 引 CM）；设置启用或编辑面挂载时补载，未加载前按零启用处理。
  let uploadActive = 0; // 「上传中…」状态格计数（规则 7；重入安全：finally 递减）
  let uploaderInst: ReturnType<ImagehostModule['createUploader']> | null = null;
  const uploader = {
    upload: async (bytes: Uint8Array, mime: string, name: string, cfg: ImageHostConfig) => {
      const m = await ensureImagehost();
      uploaderInst ??= m.createUploader({ put: s3PutObject });
      return uploaderInst.upload(bytes, mime, name, cfg);
    },
  };
  const ihEnabled = (): boolean => {
    if (imagehostMod) return imagehostMod.imageHostEnabled(settings as Record<string, unknown>);
    // 模块未加载 = 零启用语义（009 规则 1 零加载）；设置已启用则补载，下次调用起恢复精确判定
    if ((settings as Record<string, unknown>).imageHostEnabled === true) void ensureImagehost();
    return false;
  };
  const ihCfg = async (): Promise<{ cfg: ImageHostConfig; missing: string[] }> => {
    const m = await ensureImagehost();
    return m.imageHostConfigOf(settings as Record<string, unknown>);
  };

  /** 静态渲染/分屏右栏远程图回填（规则 10）：未启用或未配基址即零请求（AC-7 读侧延伸） */
  function remoteImagesOf(root: ParentNode, isCurrent?: () => boolean): void {
    const base = settings.publicBaseUrl;
    if (!base || !ihEnabled()) return;
    // 模块未就位（已启用但刚补载）时载完后仍回填本次，不留一轮空窗
    if (imagehostMod) imagehostMod.resolveRemoteImages(root, base, s3GetImage, isCurrent);
    else void ensureImagehost().then(m => m.resolveRemoteImages(root, base, s3GetImage, isCurrent));
  }

  /** IR 图片装饰件远程回填（规则 10）：host 全等过滤 + data: 内联，失败静默（返回 null） */
  const remoteImageResolve = async (url: string): Promise<string | null> => {
    const base = settings.publicBaseUrl;
    if (!base || !ihEnabled()) return null;
    const m = await ensureImagehost();
    if (!m.imageHostEnabled(settings as Record<string, unknown>) || m.hostOf(url) !== m.hostOf(base)) return null;
    return m.fetchRemoteDataUrl(url, base, s3GetImage).catch(() => null);
  };

  /** md 可编辑上下文判定（源码/分屏左/即时渲染；草稿本地保存时提示先另存） */
  function mdEditableContext(t: TabState | null): boolean {
    if (settings.readOnlyMode || !t || t.route !== 'text' || t.language !== 'Markdown') return false;
    const m = modeOf(t);
    return (m === 'edit' || m === 'split' || m === 'wysiwyg')
      && (currentView instanceof EditView || currentView instanceof LivePreviewView);
  }

  /** 该标签的 CM6 视图（插入/改写落点；非激活或已切走返回 null） */
  function viewOfTab(t: TabState): EditorView | null {
    if (activeTab()?.path !== t.path) return null;
    if (currentView instanceof EditView) return currentView.view;
    if (currentView instanceof LivePreviewView) return currentView.view;
    return null;
  }

  /** 光标处插入 Markdown 片段（规则 6：三形态同一插入——单事务 userEvent 'input'，一步撤销；
   *  失焦兜底：URL 复制到剪贴板（异常表「URL 已得仍插入」的可达成口径） */
  function insertMdIntoTab(t: TabState, snippet: string, fallbackUrl: string, target: ReturnType<typeof trackImageTarget>): void {
    const view = viewOfTab(t);
    if (settings.readOnlyMode) return;
    const range = target.range();
    target.dispose();
    if (!view || view !== target.view || !range) {
      void writeClipboardText(fallbackUrl);
      flash($tf('ih.urlCopied', fallbackUrl));
      return;
    }
    view.dispatch({
      changes: { ...range, insert: snippet },
      selection: { anchor: range.from + snippet.length },
      scrollIntoView: true,
      userEvent: 'input',
    });
    view.focus();
  }

  /** E6001 缺失字段名 → 本地化标签 */
  const IH_FIELD_KEYS: Record<string, string> = {
    s3Endpoint: 'set.ihEndpoint',
    s3Region: 'set.ihRegion',
    s3Bucket: 'set.ihBucket',
    s3Credentials: 'set.ihCreds',
  };

  /** 图床问题对话框（规则 7：E6xxx 经对话框透出；E6001/E6002 引导打开设置，网络类给「重试」） */
  function uploadIssueDialog(msg: string, buttons: Array<[string, () => void]>, onClose?: () => void): void {
    const body = document.createElement('div');
    body.className = 'ov-body';
    const p = document.createElement('div');
    p.style.whiteSpace = 'pre-wrap';
    p.textContent = msg;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap';
    let mask: OverlayMask | null = null;
    buttons.forEach(([label, fn], i) => {
      const b = document.createElement('button');
      b.className = 'dlg-btn' + (i === 0 ? ' primary' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        fn();
        mask?.close();
      });
      row.appendChild(b);
    });
    body.append(p, row);
    mask = overlayDialog($t('ih.failTitle'), body, () => onClose?.());
    document.body.appendChild(mask);
  }

  /** E6xxx 错误串 → 呈现文案（规则 7 口径；raw 透出阶段标签/状态码/响应体截断） */
  function uploadErrorMsg(raw: string): string {
    const code = /^E6\d{3}/.exec(raw)?.[0] ?? 'E6004';
    const rest = raw.slice(code.length).replace(/^[:：]\s*/, '');
    switch (code) {
      case 'E6002': return $t('ih.E6002');
      case 'E6003': return $t('ih.E6003');
      case 'E6006': return $t('ih.E6006');
      case 'E6005': {
        const m = /^(\d+)\s*:?\s*([\s\S]*)$/.exec(rest);
        return $tf('ih.E6005', m?.[1] ?? '', (m?.[2] ?? '').slice(0, 300));
      }
      default:
        // E6001（端点/内容非法）/ E6004（阶段标签 dns/connect/tls/read/timeout…）及其余兜底
        return $tf('ih.E6004', code === 'E6001' ? 'config' : rest.split(':', 1)[0] || 'network', raw);
    }
  }

  /** 上传出错对话框（规则 7：含「重试」；E6001/E6002/E6003 无重试意义——引导设置/仅告知） */
  function uploadErrorDialog(raw: string): Promise<boolean> {
    const code = /^E6\d{3}/.exec(raw)?.[0] ?? 'E6004';
    const msg = uploadErrorMsg(raw);
    return new Promise(resolve => {
      const cancel = (): void => resolve(false);
      if (code === 'E6001' || code === 'E6002') {
        uploadIssueDialog(msg, [[$t('ih.openSettings'), () => { cancel(); openImageHost(); }], [$t('common.cancel'), cancel]], cancel);
      } else if (code === 'E6003') {
        uploadIssueDialog(msg, [[$t('common.ok'), cancel]], cancel);
      } else {
        uploadIssueDialog(msg, [[$t('ih.retry'), () => resolve(true)], [$t('common.cancel'), cancel]], cancel);
      }
    });
  }

  /** publicBaseUrl 未配置（规则 5：上传前提示补全，不猜测端点公网形态） */
  function needBaseUrlDialog(): void {
    uploadIssueDialog($t('ih.needBaseUrl'), [
      [$t('ih.openSettings'), () => openImageHost()],
      [$t('common.cancel'), () => void 0],
    ]);
  }

  /** 上传核心（规则 3/5/7/8）：配置闸（E6001/基址提示）→ 「上传中…」→ uploader（去重/队列在彼处） */
  async function uploadForUrl(bytes: Uint8Array, mime: string, name: string): Promise<string | null> {
    if (settings.readOnlyMode) return null;
    const { cfg, missing } = await ihCfg();
    if (missing.length > 0) {
      uploadIssueDialog(
        $tf('ih.E6001', missing.map(k => $t(IH_FIELD_KEYS[k] ?? 'set.ihEndpoint')).join('、')),
        [[$t('ih.openSettings'), () => openImageHost()], [$t('common.cancel'), () => void 0]]
      );
      return null;
    }
    if (!cfg.publicBaseUrl) {
      needBaseUrlDialog();
      return null;
    }
    for (;;) {
      uploadActive++;
      renderStatus();
      let failure: string;
      try {
        return (await uploader.upload(bytes, mime, name, cfg)).url;
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      } finally {
        uploadActive--;
        renderStatus();
      }
      if (!await uploadErrorDialog(failure)) return null;
    }
  }

  /** 「保存为本地文件」分支：落文档目录（hash + 时间戳，冲突加 -N），插入相对引用 */
  async function saveLocalImage(t: TabState, bytes: Uint8Array, name: string, mime: string): Promise<{ snippet: string; url: string } | null> {
    if (settings.readOnlyMode) return null;
    if (!isRealFilePath(t.path)) {
      flash($t('ih.saveMdFirst'));
      return null;
    }
    const m = await ensureImagehost();
    const stem = m.sanitizeName(name);
    const filename = await m.localImageName(bytes, mime);
    const dir = dirOf(t.path).replace(/\\/g, '/');
    let rel = filename;
    for (let i = 1; ; i++) {
      const exists = await fileStat(`${dir}/${rel}`).then(() => true).catch(() => false);
      if (!exists) break;
      rel = filename.replace(/\.[^.]+$/, `-${i}$&`);
    }
    try {
      if (settings.readOnlyMode) return null;
      await imageWrite(`${dir}/${rel}`, bytesToBase64(bytes));
    } catch (err) {
      flash($tf('ih.writeFail', String(err)));
      return null;
    }
    flash($tf('ih.savedLocal', rel));
    return { snippet: m.imageMarkdown(stem, m.encodePath(rel)), url: rel };
  }

  /** 触发①②公共执行体（规则 4：判决单一函数；三选弹窗在判决层） */
  async function ingestImageBytes(
    t: TabState,
    load: () => Promise<Array<{ bytes: Uint8Array; mime: string; name: string }>>
  ): Promise<void> {
    const view = viewOfTab(t);
    if (!view || settings.readOnlyMode) return;
    const sel = view.state.selection.main;
    const m = await ensureImagehost();
    const target = m.trackImageTarget(view, sel.from, sel.to);
    try {
    const plan: IngestPlan = m.imageIngestPlan({
      enabled: m.imageHostEnabled(settings as Record<string, unknown>),
      pasteAction: settings.pasteImageAction,
    });
    const action = plan === 'ask' ? await askImageIngest() : plan;
    if (action !== 'upload' && action !== 'local') return;
    let srcs: Array<{ bytes: Uint8Array; mime: string; name: string }>;
    try {
      srcs = await load();
    } catch {
      flash($t('ih.readFail'));
      return;
    }
    const snippets: string[] = [];
    const urls: string[] = [];
    for (const s of srcs) {
      if (settings.readOnlyMode) return;
      if (action === 'upload') {
        const url = await uploadForUrl(s.bytes, s.mime, s.name);
        if (url) { snippets.push(m.imageMarkdown(m.sanitizeName(s.name), url)); urls.push(url); }
      } else {
        const local = await saveLocalImage(t, s.bytes, s.name, s.mime);
        if (local) { snippets.push(local.snippet); urls.push(local.url); }
      }
    }
    if (snippets.length) insertMdIntoTab(t, snippets.join('\n'), urls.join('\n'), target);
    } finally { target.dispose(); }
  }

  /** 三选弹窗（规则 4 ①出厂「每次问」：上传到图床 / 保存为本地文件 / 取消） */
  function askImageIngest(): Promise<'upload' | 'local' | null> {
    return new Promise(resolve => {
      const body = document.createElement('div');
      body.className = 'ov-body';
      const p = document.createElement('p');
      p.textContent = $t('ih.askBody');
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap';
      let mask: OverlayMask | null = null;
      let settled = false;
      const done = (v: 'upload' | 'local' | null): void => {
        if (settled) return;
        settled = true;
        resolve(v);
        mask?.close();
      };
      const mk = (label: string, primary: boolean, v: 'upload' | 'local' | null): void => {
        const b = document.createElement('button');
        b.className = 'dlg-btn' + (primary ? ' primary' : '');
        b.textContent = label;
        b.addEventListener('click', () => {
          done(v);
        });
        row.appendChild(b);
      };
      if (ihEnabled()) mk($t('ih.upload'), true, 'upload');
      mk($t('ih.local'), false, 'local');
      mk($t('common.cancel'), false, null);
      body.append(p, row);
      mask = overlayDialog($t('ih.askTitle'), body, () => done(null));
      document.body.appendChild(mask);
    });
  }

  /** 本地引用 → 绝对路径（Windows 盘符 / POSIX 根之外的都按文档目录拼，007 joinRelPath 同口径） */
  // 已并入 uploadLocalRef（图床件/preview 懒加载后取绑定）；保留口径注释见该函数

  /** 触发③公共上传体（规则 4 ③）：读本地文件 → 上传 → 公开 URL（null=失败/取消，不改文档） */
  async function uploadLocalRef(t: TabState, ref: string): Promise<string | null> {
    if (settings.readOnlyMode) return null;
    if (!isRealFilePath(t.path)) return null;
    const m = await ensureImagehost();
    await loadPreviewKit(); // joinRelPath/decodeLocalRef 绑定就位
    // 本地引用 → 绝对路径（Windows 盘符 / POSIX 根之外的都按文档目录拼，007 joinRelPath 同口径）
    const dec = decodeLocalRef(ref);
    const abs = /^[A-Za-z]:[\\/]/.test(dec) || /^[\\/]/.test(dec) ? dec : joinRelPath(dirOf(t.path), dec);
    const mime = m.mimeOfPath(abs);
    if (!mime) {
      flash($t('ih.notImage'));
      return null;
    }
    let b64: string;
    try {
      b64 = await fontRead(abs); // 32MB 读上限（misc font_read 复用）
    } catch {
      flash($t('ih.readFail'));
      return null;
    }
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return uploadForUrl(bytes, mime, abs.split(/[\\/]/).pop() ?? 'image');
  }

  /**
   * 源码/分屏态改写既有引用（规则 4 ③：单事务改写 URL 子串，保 alt/title，一步撤销）。
   * preferFrom 给搜索起点（光标处命中优先），失焦/找不到时 URL 落剪贴板兜底。
   */
  async function rewriteLocalRef(t: TabState, ref: string, preferFrom?: number): Promise<void> {
    const view = viewOfTab(t);
    if (!view) return;
    const m = await ensureImagehost();
    const hit = m.findImageRefRange(view.state.doc.toString(), ref, preferFrom);
    // 命中变体（含解码/角括号形式）的原文作为回填校验基准，而非入参 ref 本身
    const matched = hit ? view.state.doc.sliceString(hit.from, hit.to) : '';
    const target = hit ? m.trackImageTarget(view, hit.from, hit.to) : null;
    try {
      const url = await uploadLocalRef(t, ref);
      if (!url) return;
      const range = target?.range();
      if (!range || viewOfTab(t) !== view || view.state.doc.sliceString(range.from, range.to) !== matched) {
        void writeClipboardText(url);
        flash($tf('ih.urlCopied', url));
        return;
      }
      view.dispatch({ changes: { ...range, insert: url }, userEvent: 'input' });
    } finally { target?.dispose(); }
  }

  /** 源码态光标处本地图片引用（规则 4 ③）：光标行与前一行内 ![…](url)，光标落 URL 段内才算 */
  function localImageRefAt(view: EditorView): { ref: string; from: number } | null {
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const lines = [line.number > 1 ? view.state.doc.line(line.number - 1) : null, line];
    for (const l of lines) {
      if (!l) continue;
      for (const m of l.text.matchAll(/!\[[^\]]*\]\(\s*(<[^<>]*>|[^()\s]+)(?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) {
        const urlRaw = m[1]!;
        const ref = urlRaw.startsWith('<') ? urlRaw.slice(1, -1) : urlRaw;
        const urlFrom = l.from + (m.index ?? 0) + m[0].indexOf(urlRaw);
        if (!ref || /^(https?:|data:|asset:|blob:|\/\/)/i.test(ref)) continue;
        if (pos >= urlFrom && pos <= urlFrom + urlRaw.length) return { ref, from: urlFrom };
      }
    }
    return null;
  }

  /** 关闭守卫（002 规则 31 / 001 规则 4）：脏标签弹三键，确认回调**按 path 重解索引**
   *  （P0-2/Z2-31 根修——对话框打开期间标签数组可能变动，捕获期数值索引会关错标签）。
   *  after：确认关闭成功后的续关链（「关闭全部」依赖它继续收下一个脏标签）。 */
  function closeTabGuarded(i: number, after?: () => void): void {
    const t0 = store.tabs[i];
    if (!t0) return;
    const dirty = !!t0 && dirtyPaths.get(t0.path) === true;
    if (closeActionFor(dirty, settings.closeAutoSave) === 'save') {
      void saveDirtyTab(t0.path).then(ok => {
        if (closeActionFor(true, true, ok) !== 'close') return;
        recoveryPending.delete(t0.path);
        void recoveryDiscard([t0.path]).catch(() => void 0);
        store.closeByPath(t0.path);
        after?.();
      });
      return;
    }
    if (!dirty) {
      store.closeByPath(t0!.path);
      after?.();
      return;
    }
    const body = document.createElement('div');
    body.className = 'ov-body';
    const p2 = document.createElement('p');
    p2.textContent = $tf('unsaved.msg', t0!.path.split(/[\\/]/).pop() ?? '');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px';
    let dlgMask: OverlayMask | null = null;
    const mk = (label: string, primary: boolean, fn: () => void) => {
      const b = document.createElement('button');
      b.className = 'dlg-btn' + (primary ? ' primary' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        dlgMask?.close();
        fn();
      });
      row.appendChild(b);
    };
    mk($t('common.cancel'), false, () => void 0);
    mk($t('unsaved.closeAnyway'), false, () => {
      recoveryPending.delete(t0!.path); // 放弃修改：内存 pending 与盘上快照一并弃（T10 修复：不清会复活已弃内容）
      void recoveryDiscard([t0!.path]).catch(() => void 0); // 放弃修改：同步弃快照（002 规则 29）
      store.closeByPath(t0!.path);
      after?.();
    });
    mk($t('unsaved.saveClose'), true, () => {
      // 等待保存真正成功才关闭；保存失败/取消另存则保留标签
      void saveDirtyTab(t0!.path).then(ok => {
        if (ok) {
          recoveryPending.delete(t0!.path); // 保存关闭：清 pending（防旧内容复活）
          void recoveryDiscard([t0!.path]).catch(() => void 0);
          store.closeByPath(t0!.path);
          after?.();
        }
      });
    });
    body.append(p2, row);
    dlgMask = overlayDialog($t('unsaved.title'), body, () => void 0);
    document.body.appendChild(dlgMask);
  }

  // ---- 另存为（返回落盘目标路径，null = 取消/失败；脏关闭守卫依赖其真假语义） ----
  async function saveTextAs(content: string, defaultName: string, encoding = 'UTF-8'): Promise<string | null> {
    const target = await saveDialog({ defaultPath: defaultName });
    if (!target) return null;
    if (settings.readOnlyMode && store.tabs.some(t => normLocal(t.path) === normLocal(target))) {
      flash($t('set.readOnlyMode')); return null;
    }
    try {
      await textSave(target, content, encoding);
      noteSaved(target); // 另存为新路径也要立基线：否则该路径一旦已开标签，2s 轮询会当成外部修改
      flash($tf('msg.saved', target));
      return target;
    } catch (err) {
      dlgAlert($tf('err.saveFail', String(err)));
      return null;
    }
  }

  /** 草稿另存（001-AC-13/F001-04）：落盘成功后标签关联新文件——弃草稿态（内容/快照/脏标），
   *  走标准 openPath（语言检测/路由判定/最近列表/树定位全部复用既有单一判决），再关草稿标签。
   *  修前：另存成功仅 flash，标签恒 draft:// 恒脏，后续 Ctrl+S/关闭反复弹另存框。
   *  目标已被其它标签打开时：写入即覆盖该标签的磁盘权威，先重开该标签保证显示新内容，
   *  若其有未保存修改则明示（不静默吞掉）。 */
  async function saveDraftAs(content: string, draftPath: string): Promise<void> {
    const language = store.tabs.find(t => t.path === draftPath)?.language;
    const ext = LANGUAGE_EXT[language ?? ''] ?? 'txt';
    const target = await saveTextAs(content, `untitled.${ext}`, 'UTF-8');
    if (!target) return;
    const dupIdx = store.tabs.findIndex(t => t.path === target);
    if (dupIdx >= 0 && dirtyPaths.get(target) === true) {
      dlgAlert($tf('msg.draftTargetDirty', target));
    }
    draftContent.delete(draftPath);
    recoveryPending.delete(draftPath);
    void recoveryDiscard([draftPath]).catch(() => void 0);
    setTabDirty(draftPath, false);
    if (dupIdx >= 0) store.closeByPath(target); // 重开以显示新内容（closeByPath 在 openPath 前，避免关掉刚激活的新标签）
    await openPath(target);
    store.closeByPath(draftPath);
  }

  // ---- 视图渲染 ----
  // 挂载序号（审计整改）：并发挂载竞态防护——较新的挂载意图使较早的在途挂载作废，
  // 作废视图立即销毁（否则其缩略图三件套残留在 #editorRow、行缓存滞留内存）
  let viewSeq = 0;

  // B-2 切换连续性：同文件切模式前记录锚点行，新视图就绪后恢复（不再丢滚动位置）
  const switchAnchor = new Map<string, number>();

  function maybeRenderView(): void {
    const tab = store.active();
    const key = tab ? `${tab.path}#${tab.route}#${modeOf(tab)}` : '';
    if (key === currentViewKey) return;
    // R5 v0.46：切换免确认；下面保留 Markdown EditorBuffer、脏标并写恢复快照。
    // 同文件模式切换：捕获当前锚点行（编辑态取光标行，查看态取可见行）
    const prevPath = currentViewKey.split('#')[0];
    if (tab && prevPath === tab.path && tab.route === 'text' && !(currentView instanceof EditView || currentView instanceof LivePreviewView)) {
      const anchor = editStatus?.line ?? viewStatus?.visibleLine;
      if (anchor && anchor > 0) switchAnchor.set(tab.path, anchor);
      else switchAnchor.delete(tab.path);
    }
    // 崩溃恢复以所选快照为权威，不能在卸载旧视图时重新缓存/快照旧内容。
    if (!currentViewKey.startsWith('\u0000recovery') && (currentView instanceof EditView || currentView instanceof LivePreviewView)) {
      const path = currentView instanceof EditView ? currentView.filePath ?? prevPath : currentView.path;
      // 验收缺陷 D3：重载换挂（'\u0000reload' 哨兵）意为"丢弃缓冲重读"。修前该哨兵只豁免
      // Markdown 的 editorBuffers 缓存分支，非 Markdown 脏缓冲仍走 saveDirtyIfAny(false) →
      // sidecar 快照把旧内容写回 recoveryPending，重挂时作为 initialDoc 复活——
      // "重载（丢弃修改）"实际无效。哨兵期跳过缓冲保留，让重挂走文件重读。
      // F1（2026-10 审计）：'\u0000enc'（切换编码重挂）同语义——旧解码缓冲若在此被捕获回写，
      // 新挂载会优先复用旧缓冲，切编码表面生效实则内容不变，Ctrl+S 即把旧文本按新编码写坏文件。
      if (currentViewKey.startsWith('\u0000reload') || currentViewKey.startsWith('\u0000enc')) {
        recoveryPending.delete(path); // 双保险：清掉换挂前可能残留的恢复挂起
      } else if (currentView.view && !discardedBuffers.has(path)
        && (store.tabs.some(t => t.path === path && t.language === 'Markdown')
          || path.startsWith('draft://'))) {
        // Markdown 跨形态：缓冲即权威；草稿（draft://）无磁盘权威，任何形态/语言切换前先保留缓冲，
        // 否则从 Markdown 形态改选其他语言时（此时 tab.language 已变）IR 期间编辑会随重挂丢失
        const dirty = dirtyPaths.get(path) === true;
        const scrollTop = currentViewKey.endsWith('#md') ? editorBuffers.get(path)?.scrollTop ?? 0 : currentView.view.scrollDOM.scrollTop;
        const doc = currentView.view.state.doc.toString();
        editorBuffers.set(path, { state: currentView.view.state, dirty, scrollTop });
        if (path.startsWith('draft://')) {
          draftContent.set(path, doc); // 重挂 initialDoc 的依据；EditView onStatus 会在就绪后继续同步
          const dt = store.tabs.find(t => t.path === path);
          if (dt) dt.draftContent = doc;
        }
        if (dirty) writeSnapshot(path, doc, false);
      } else if (store.tabs.some(t => t.path === path && t.language !== 'Markdown')) {
        // 普通文本同样保留选区与滚动；脏缓冲仍沿用原有保存通道。
        if (currentView.view && !discardedBuffers.has(path)) {
          editorBuffers.set(path, {
            state: currentView.view.state,
            dirty: dirtyPaths.get(path) === true,
            scrollTop: currentView.view.scrollDOM.scrollTop,
          });
        }
        void saveDirtyIfAny(false);
      }
    }
    discardedBuffers.clear();
    for (const path of editorBuffers.keys()) if (!store.tabs.some(t => t.path === path)) editorBuffers.delete(path);
    for (const path of tabLock) if (!store.tabs.some(t => t.path === path)) tabLock.delete(path); // 关闭即弃会话编辑锁，防重开残留意外只读
    for (const path of dirtyPaths.keys()) if (!store.tabs.some(t => t.path === path)) dirtyPaths.delete(path); // F4（审计）：放弃/关闭后脏标不残留——重开不再误报未保存
    for (const path of encodingByPath.keys()) if (!store.tabs.some(t => t.path === path)) encodingByPath.delete(path); // F5（审计）：手动编码覆盖「仅本标签」——关闭即清，不泄漏到重开
    for (const path of recoveryPending.keys()) if (!store.tabs.some(t => t.path === path)) recoveryPending.delete(path); // 已关标签的恢复挂起不再复活
    destroyView();
    currentViewKey = key;
    viewarea.innerHTML = '';
    viewSeq++;
    if (!tab) {
      // 空态纯空白（001 规则 32 v2.3，P3 用户定稿：推翻 v1.8 的引导式空态——品牌标/文案/
      // 三入口钮/最近列表全删，「什么都不需要写」；打开入口在菜单/工具栏/快捷键，欢迎页保留）
      const empty = document.createElement('div');
      empty.className = 'view-empty';
      viewarea.appendChild(empty);
      updateMarkers();
      return;
    }
    const mode = modeOf(tab);
    const seq = viewSeq;
    // 挂载完成后刷新工具栏快照：enabled/checked 在构建时求值，异步挂载（IR/编辑面都有 await）
    // 期间 currentView 未就位会滞留旧值——IR 下 tbmd 格式组恒灰即此因（2026-10-26 实证）
    void mountView(tab, mode, seq).then(() => { if (seq === viewSeq) toolbarCtl?.refresh(); });
    restoreSwitchAnchor(tab.path, seq);
  }

  /** B-2：切换后按锚点行恢复位置（挂载异步，轮询等待视图就绪） */
  function restoreSwitchAnchor(path: string, seq: number): void {
    const anchor = switchAnchor.get(path);
    if (!anchor) return;
    switchAnchor.delete(path);
    const t0 = Date.now();
    const tryGo = (): void => {
      if (seq !== viewSeq) return; // 已被更新的挂载取代
      if (currentView instanceof TextView) {
        void currentView.goToLine(anchor, undefined, true);
        return;
      }
      if (currentView instanceof EditView && currentView.view) {
        currentView.goToLine(anchor);
        return;
      }
      if (Date.now() - t0 < 2500) setTimeout(tryGo, 90);
    };
    setTimeout(tryGo, 120);
  }

  function destroyView(): void {
    viewCleanup?.();
    viewCleanup = null;
    detachMarkerScroll();
    markerOverlay?.remove();
    markerOverlay = null;
    previewHostEl = null;
    previewFind?.destroy();
    previewFind = null;
    previewMinimapCleanup?.();
    previewMinimapCleanup = null;
    wyMinimap?.remove();
    wyMinimap = null;
    if (currentView instanceof TextView) currentView.destroy();
    if (currentView instanceof ImageView) currentView.destroy();
    if (currentView instanceof EditView) currentView.destroy();
    if (currentView instanceof CsvView) currentView.destroy();
    if (currentView instanceof LivePreviewView) currentView.destroy();
    if (currentView instanceof CompareView) currentView.destroy();
    currentView = null;
    viewStatus = null;
    editStatus = null;
    cmpStatus = null;
    cmpView = null;
    tailStatus = null;
    if (tailBoard) {
      tailBoard.destroy();
      tailBoard = null;
    }
    wysiwygDirty = false;
    wyStats = { chars: 0, lines: 0 };
    wyPos = { line: 1, col: 1 };
  }

  /** 脏缓冲落盘守卫（ADR 012 v2）：视图销毁/切换前处理未保存内容，防静默丢失。返回是否已不脏。
   *  - explicit=true（关闭守卫等"必须落盘"路径）：真实写盘（失败保留标签）。
   *  - explicit=false（切模式/切标签的自动路径）：autoSaveTarget='sidecar'（出厂）时只写
   *    恢复快照旁路（内存 pending + recovery/ 盘），原文件不动——重挂时按快照还原并保持脏标；
   *    ='file' 时维持旧行为直写。
   *  判定一律基于「视图自身的 path + 该标签是否仍在 store」；标签已关闭 = 关闭守卫已决策。 */
  async function saveDirtyIfAny(explicit: boolean): Promise<boolean> {
    if (settings.readOnlyMode) {
      if (explicit) flash($t('set.readOnlyMode'));
      return !dirtyPaths.get(activeTab()?.path ?? '');
    }
    if (currentView instanceof EditView && editStatus?.dirty) {
      const vpath = currentView.filePath;
      if (vpath && store.tabs.some(t => t.path === vpath)) {
        if (!explicit && (settings.autoSaveTarget ?? 'sidecar') === 'sidecar') {
          // sidecar：切换不写原文件——内容进快照，重挂还原（H-5 T10）
          writeSnapshot(vpath, currentView.getContent(), false);
          return false; // 仍脏（正确：从未保存）
        }
        await currentView.save(); // 写盘成功的收口在 save() 内的 onSaved（见 noteSaved 注释）
        return !editStatus?.dirty;
      }
      return false; // 草稿无法原地保存；或标签已关闭（守卫已决策）
    }
    if (currentView instanceof LivePreviewView && wysiwygDirty) {
      const wasPath = currentView.path;
      if (!store.tabs.some(t => t.path === wasPath)) return false; // 标签已关闭：守卫已决策，不自动写盘
      await currentView.save(); // 显式保存或现有自动保存调度，不属于切换确认。
      return !wysiwygDirty; // 收口同样在 save() 内的 onSaved
    }
    const path = activeTab()?.path;
    if (path && dirtyPaths.get(path) === true && editorBuffers.has(path)) return saveBufferedTab(path);
    return true;
  }

  /** 非激活/独立预览中的 Markdown 仍可从驻留缓冲保存；失败保持脏标。 */
  async function saveBufferedTab(path: string): Promise<boolean> {
    const buffer = editorBuffers.get(path);
    if (!buffer || settings.readOnlyMode) return false;
    const state = buffer.state;
    try {
      let encoding: string;
      try {
        encoding = await currentEncoding(path);
      } catch {
        if (!await dlgConfirm('无法确定原编码，是否以 UTF-8 保存？')) return false;
        encoding = 'UTF-8';
      }
      const stat = await textSave(path, state.sliceDoc(), encoding);
      // 等待写盘期间用户可能切回继续编辑，只有同一缓冲身份才可转净。
      const live = (currentView instanceof EditView || currentView instanceof LivePreviewView) ? currentView.view : undefined;
      const livePath = currentView instanceof EditView ? currentView.filePath : currentView instanceof LivePreviewView ? currentView.path : null;
      const clean = editorBuffers.get(path)?.state === state && !(livePath === path && live && live.state.doc !== state.doc);
      if (clean) {
        buffer.dirty = false;
        setTabDirty(path, false);
      }
      noteSaved(path, stat, clean);
      return clean;
    } catch (err) {
      dlgAlert($tf('err.saveFail', String(err)));
      return false;
    }
  }

  /** 保存成功后的统一收口：刷新 mtime 基线（H4：防 2s 轮询把自己保存当外部修改而重挂视图）+
   *  清除该路径的崩溃恢复快照（转净即弃，ADR 012 v2）。
   *  H-6c：唯一触发点是 EditView / LivePreviewView 各自的 save() 成功回调 onSaved（写盘发生在视图内，
   *  收口就只能挂在那儿），shell 侧不再按调用点补调——旧实现只在脏缓冲守卫这一条路上补，
   *  编辑态 Ctrl+S（CM 键位 Mod-s）与 IR 的 Ctrl+S（host 键位）两条主路径全漏。 */
  function noteSaved(path: string, stat?: { len: number; modifiedMs: number }, clean = true): void {
    saveEpochByPath.set(path, (saveEpochByPath.get(path) ?? 0) + 1);
    if (!isRealFilePath(path)) return;
    textOpenMemoInvalidate(path); // 保存已改写磁盘（行尾/长度/编码）：备忘的 text_open 基线作废
    // A-11：保存方带回落盘基线（text_save 返回值）时同步立基线——修前 fileStat 异步回填，
    // 轮询器在窗口内以旧基线比新 mtime 误判外部修改（闪「已重新加载」并白读盘）。
    if (stat) {
      fileMtimes.set(path, stat.modifiedMs);
      fileSizes.set(path, stat.len);
      renderStatus();
      renderTabs();
    }
    // H-6f：两个 map 是「大小/修改时间」的唯一数据源，而显示它的两处（状态栏大小格、标签悬停）
    // 只在渲染时读一次——本函数的刷新是异步的（fileStat），必然晚于 save() 内那次 report()，
    // 若不在此处失效显示，保存后两处会一直停在旧值，直到用户动了光标触发一次视图 report 才偶然对上。
    // 与 ensureFileMeta（元信息就绪后 renderStatus）同法：改动数据源的人负责失效其派生视图。
    void fileStat(path)
      .then(st => {
        fileMtimes.set(path, st.modifiedMs);
        fileSizes.set(path, st.len);
        renderStatus();
        renderTabs();
      })
      .catch(e => console.warn('Saved file metadata refresh failed', e));
    deletedPaths.delete(path); // 保存成功 = 文件已回到磁盘，清除删除标记（F001-03）
    if (clean && dirtyPaths.get(path) !== true) {
      recoveryPending.delete(path);
      void recoveryDiscard([path]).catch(() => void 0);
    }
  }

  /** 保存指定脏标签（关闭守卫用）；草稿走另存为。返回是否可以安全关闭。 */
  async function saveDirtyTab(path: string): Promise<boolean> {
    if (path.startsWith('draft://')) {
      const content =
        activeTab()?.path === path && currentView instanceof EditView
          ? currentView.getContent()
          : draftContent.get(path) ?? '';
      return (await saveTextAs(content, 'untitled.txt', 'UTF-8')) !== null;
    }
    if (activeTab()?.path === path) return await saveDirtyIfAny(true); // 关闭守卫：必须真实落盘
    if (editorBuffers.has(path)) return saveBufferedTab(path);
    // F3（2026-10 审计）：脏内容仅驻留恢复快照的后台纯文本标签——按快照内容直接落盘，
    // 不再强制激活标签致退出/全部关闭链因「savePending」中断（口径与 saveBufferedTab 一致）。
    const pending = recoveryPending.get(path);
    if (pending) {
      try {
        let encoding: string;
        try {
          encoding = await currentEncoding(path);
        } catch {
          if (!await dlgConfirm('无法确定原编码，是否以 UTF-8 保存？')) return false;
          encoding = 'UTF-8';
        }
        const stat = await textSave(path, pending.content, encoding);
        setTabDirty(path, false);
        noteSaved(path, stat, true);
        return true;
      } catch (err) {
        dlgAlert($tf('err.saveFail', String(err)));
        return false;
      }
    }
    // 无驻留缓冲的标签激活后交用户处理，不静默关闭。
    const idx = store.tabs.findIndex(t => t.path === path);
    if (idx >= 0) store.activate(idx);
    flash($t('msg.savePending'));
    return false;
  }

  async function mountView(tab: TabState, mode: ViewMode, seq = viewSeq): Promise<void> {
    if (modeLock.get(tab.path)) {
      // 上一次挂载未完成：记住最新意图，待其结束后重放（避免模式切换被丢弃，B0）
      pendingMount.set(tab.path, { tab, mode });
      return;
    }
    modeLock.set(tab.path, true);
    pendingMount.delete(tab.path);
    // 作废判定：完成时已有更新的挂载意图 → 立即销毁刚建好的视图（防孤儿视图残留缩略图等全局挂件）
    const stale = (): boolean => seq !== viewSeq;
    try {
      ensureFileMeta(tab.path);
      // 对比伪标签（008：compare://A|B，两个路径 encodeURIComponent）
      if (tab.path.startsWith('compare://')) {
        const [ea, eb] = tab.path.slice('compare://'.length).split('|');
        try {
          await loadCompare();
        } catch (err) {
          flash($tf('err.openFail', String(err)));
          return;
        }
        if (stale()) return; //模块解析期间已有新挂载意图——迟到续体不得写入共享宿主
        const cv = new CompareView(viewarea, decodeURIComponent(ea), decodeURIComponent(eb), {
          isReadOnly: () => settings.readOnlyMode === true || tabLock.has(tab.path),
          onClose: () => store.close(store.activeIndex),
          onStatus: s => {
            cmpStatus = s;
            scheduleStatusRender();
          },
          flash,
          // 行点击跳转（008 规则 11 v0.6）：活动标签直达 / 已开激活 / 未开则打开（openPath anchor 机制）
          onJump: (path, line) => {
            void (async () => {
              const act = store.active();
              if (act && act.path === path) {
                if (currentView instanceof TextView) void currentView.goToLine(line, undefined, true);
                else if (currentView instanceof EditView) currentView.goToLine(line);
                return;
              }
              switchAnchor.set(path, line);
              await openPath(path);
            })();
          },
        });
        if (stale()) {
          cv.destroy();
          return;
        }
        currentView = cv;
        cmpView = cv;
        cv.setFontSize(settings.fontSize ?? 12); // v2.5 扩面：对比视图行距随字号派生（初始带上保存值）
        return;
      }
      // 尾随台伪标签（002 规则 27）
      if (tab.path === 'tail://') {
        const tb = new TailBoard(viewarea, {
          onPick: async () => ((await openDialog({ multiple: false })) as string | null) ?? null,
          intervalMs: 1200, // v2.50：followIntervalMs 设置项为悬空项已清（Z001-F02），回固定值
          onStatus: s => {
            tailStatus = s;
            scheduleStatusRender();
          },
        });
        if (stale()) {
          tb.destroy();
          return;
        }
        tailBoard = tb;
        return;
      }
      // 图片视图（批 D-1）：route='image'（png/jpg/gif/webp/svg/bmp）
      if (tab.route === 'image') {
        try {
          await loadImage();
        } catch (err) {
          flash($tf('err.openFail', String(err)));
          return;
        }
        if (stale()) return; //迟到续体不得触碰共享宿主
        // ImageView.mount 会清空宿主：挂独立包装层（F6 同法），stale 只移除自身节点，
        // 绝不清掉可能已就位的新视图/空态
        const imgHost = document.createElement('div');
        imgHost.style.cssText = 'height:100%'; // .img-view 高度按宿主百分比
        viewarea.appendChild(imgHost);
        const iv = new ImageView(imgHost, tab.path);
        await iv.mount();
        if (stale()) {
          imgHost.remove();
          iv.destroy();
          return;
        }
        currentView = iv;
        return;
      }
      if (mode === 'edit') {
        // 验收缺陷 D2：文件已不在（会话恢复指向被删文件/外部删除后切标签）时
        // currentEncoding 抛"无法确定原编码"且此前未捕获——未处理拒绝中断视图挂载。
        // 降级 UTF-8 继续（与另存为的 UTF-8 兜底口径一致），读取错误交由既有错误路径提示。
        // 编码探测（textOpen 已按路径备忘）与编辑模块加载互不依赖——并行进行；
        // 模块加载失败走既有打开失败提示（err.openFail），视图区保持空态
        const encPromise = currentEncoding(tab.path).catch(() => 'UTF-8');
        try {
          await loadEdit();
        } catch (err) {
          flash($tf('err.openFail', String(err)));
          return;
        }
        const enc = await encPromise;
        if (stale()) return; //探测/加载期间已有新挂载意图——不向共享宿主构造视图
        const recovered = recoveryPending.get(tab.path);
        recoveryPending.delete(tab.path);
        const ev = new EditView(viewarea, {
          path: tab.path.startsWith('draft://') ? null : tab.path,
          language: tab.language,
          encoding: enc,
          initialDoc: tab.path.startsWith('draft://')
            ? draftContent.get(tab.path) ?? tab.draftContent ?? ''
            : recovered?.content,
          startDirty: !!recovered || (tab.path.startsWith('draft://') && typeof tab.draftContent === 'string'),
          buffer: editorBuffers.get(tab.path),
          readOnly: settings.readOnlyMode === true || tabLock.has(tab.path),
          wrap: wrapMap.get(tab.path) === true,
          showLineNumbers: settings.showLineNumbers !== false,
          selectionHl: settings.selectionHl !== false,
          invisibleOn: settings.showInvisible === true,
          restoreBookmarks: tab.bookmarks,
          onBookmarksChange: (p, bm) => store.setBookmarks(p, bm),
          onStatus: s => {
            editStatus = s;
            if (tab.path.startsWith('draft://')) {
              // 草稿懒序列化：不再每次 onStatus 全文 doc.toString() 比对——
              // 只调度防抖会话保存（廉价），落盘时 captureDrafts 才取当前全文；
              // 切标签/关标签前的内容捕获由 render() 的缓冲保留分支与 close 守卫负责
              scheduleSave(store.session());
            }
            setTabDirty(tab.path, s.dirty);
            scheduleStatusRender();
            updateOutlineCur(s.line);
          },
          onFlash: msg => flash(msg),
          onSaveAsNeeded: content => {
            // 草稿走 saveDraftAs（AC-13）：成功后标签关联新文件；真文件另存为仅落盘副本（标签保持原文件）
            if (tab.path.startsWith('draft://')) void saveDraftAs(content, tab.path);
            else void saveTextAs(content, tab.path.split(/[\\/]/).pop() ?? 'untitled.txt', 'UTF-8');
          },
          onAlert: dlgAlert,
          onConfirm: dlgConfirm,
          onPrompt: dlgPrompt,
          onContextMenu: (x, y) => editViewMenu(tab, x, y),
          fontSize: settings.fontSize ?? 12,
          onFontSize: n => applyFontSize(n),
          onSaved: (p, stat, clean) => noteSaved(p, stat, clean),
          // 挂载完成回调（#10 竞态修复）：缩略图挂接不依赖定时器
          onReady: readyView => {
            // B-2：编辑态缩略图（与流式查看面视觉连续）
            if (settings.showMinimap !== false) {
              const row = document.getElementById('editorRow');
              if (row) readyView.attachMinimap(row);
            }
          },
        });
        ev.setLanguage(tab.language);
        {
          const ov = hlOverride.get(tab.path);
          if (ov === '') ev.setLanguage(null);
          else if (ov && ov !== 'auto') ev.setLanguage(ov);
        }
        if (stale()) {
          ev.destroy();
          return;
        }
        currentView = ev;
        renderStatus();
        if (recovered) {
          // 崩溃恢复（002 规则 29）：恢复的缓冲即脏；基线不匹配提示磁盘已变化
          setTabDirty(tab.path, true);
          if (recovered.diskChanged) flash($t('rec.diskChanged'));
        }
        return;
      }
      if (mode === 'wysiwyg') {
        // 超限守卫（007 规则 6：超 IR 上限回源码——≤10MB 即编辑面，>10MB 流式查看面）
        // 草稿无磁盘大小可查，跳过探测（内容承载于编辑缓冲，天然受 EDIT_LIMIT 约束）
        // IR 模块加载与大小探测并行；加载失败走既有打开失败提示
        const isDraft = tab.path.startsWith('draft://');
        const livePreviewReady = loadLivePreview().catch(err => err as unknown as Error);
        let len = fileSizes.get(tab.path) ?? 0;
        if (!len && !isDraft) {
          try {
            len = (await textOpen(tab.path)).len;
            fileSizes.set(tab.path, len);
          } catch {
            setMode(tab, 'view');
            flash($t('msg.mdIrTooLarge'));
            return;
          }
        }
        if (len > WYSIWYG_LIMIT) {
          setMode(tab, len <= EDIT_LIMIT ? 'edit' : 'view');
          flash($t('msg.mdIrTooLarge'));
          return;
        }
        const liveMod = await livePreviewReady;
        if (liveMod instanceof Error) {
          flash($tf('err.openFail', String(liveMod)));
          return;
        }
        const enc = await currentEncoding(tab.path).catch(() => 'UTF-8'); // D2：文件缺失时兜底
        if (stale()) return; //迟到续体不得触碰共享宿主
        // CM6 live preview（007 v0.16 规则 2/23 M1）：引擎自研，观感由应用令牌接管（无 dark 参数）
        const recovered = recoveryPending.get(tab.path);
        recoveryPending.delete(tab.path);
        const wv = new LivePreviewView(viewarea, {
          path: tab.path,
          encoding: enc,
          initialDoc: isDraft ? draftContent.get(tab.path) ?? tab.draftContent ?? '' : recovered?.content,
          startDirty: !!recovered || (isDraft && typeof tab.draftContent === 'string'),
          // 草稿无磁盘权威，Ctrl+S 交 shell 走 saveDraftAs（默认扩展名随语言）
          onSaveAsNeeded: isDraft ? content => void saveDraftAs(content, tab.path) : undefined,
          buffer: editorBuffers.get(tab.path),
          readOnly: settings.readOnlyMode === true || tabLock.has(tab.path),
          showMenu: (items, x, y) => menu(items, x, y),
          // 菜单同构（007 v0.8 规则 8）：右键尾部「Markdown 模式 ▸」（与其余形态同一构建函数）
          modeMenuItems: () => [[$t('ctx.mdModes'), () => void 0, mdModeMenuItems(tab)]],
          onStatus: s => {
            wysiwygDirty = s.dirty;
            wyStats = { chars: s.chars, lines: s.lines };
            wyPos = { line: s.line, col: s.col };
            setTabDirty(tab.path, s.dirty);
            scheduleStatusRender();
          },
          onSaved: (p, stat, clean) => noteSaved(p, stat, clean),
          onAlert: dlgAlert,
          onConfirm: dlgConfirm,
          onFlash: msg => flash(msg),
          // R1（007 v0.11）：.md 相对链接新标签；外链经 opener 交系统浏览器
          openMarkdown: p => void openPath(p),
          openExternal: openExternalUrl,
          onHeadings: heads => {
            if (!store.tabs.includes(tab)) return;
            wysiwygHeadings.set(tab.path, heads);
            if (sidebarCtl.isOutlineShown()) void renderOutlineInto(sidebarCtl.outlineHostEl);
          },
          // 缩略图接线（007 规则 13）：IR 滚动容器 + 编辑中行缓存；查不到容器则跳过
          onReady: api => {
            if (stale() || !api.scrollEl) return;
            wyMinimap = attachPreviewMinimap(api.scrollEl, api.lineCount, api.lineText, api.linesVersion);
          },
          // 图床（009）：图片件远程回填（规则 10）+ 右键「上传图片到图床」（规则 4 触发③，
          // 改写由视图单事务完成；canUploadImage 未启用不出现入口）
          remoteImages: remoteImageResolve,
          canUploadImage: ihEnabled,
          onUploadImage: ref => uploadLocalRef(tab, ref),
        });
        if (stale()) {
          wv.destroy();
          return;
        }
        currentView = wv;
        renderStatus();
        return;
      }
      if (mode === 'md') {
        const isDraft = tab.path.startsWith('draft://');
        // 编码探测与（编辑+渲染）模块加载并行；加载失败走既有打开失败提示
        const encPromise = currentEncoding(tab.path).catch(() => 'UTF-8'); // D2：文件缺失时兜底；草稿恒 UTF-8
        try {
          await Promise.all([loadEdit(), loadPreviewKit()]);
        } catch (err) {
          flash($tf('err.openFail', String(err)));
          return;
        }
        const enc = await encPromise;
        const buffer = editorBuffers.get(tab.path);
        const recovered = recoveryPending.get(tab.path);
        const text = isDraft
          ? buffer?.state.doc.toString() ?? draftContent.get(tab.path) ?? tab.draftContent ?? ''
          : buffer?.state.doc.toString() ?? recovered?.content ?? await textReadAll(tab.path, enc);
        if (stale()) return;
        const preview = document.createElement('div');
        preview.className = 'md-preview';
        const hidden = document.createElement('div');
        hidden.hidden = true;
        viewarea.append(preview, hidden);
        // 隐藏源缓冲承载保存、脏标与历史，预览始终读取同一源文档。
        const source = new EditView(hidden, {
          path: isDraft ? null : tab.path, language: tab.language, encoding: enc, initialDoc: text,
          buffer, startDirty: !!recovered || (isDraft && typeof tab.draftContent === 'string'), readOnly: settings.readOnlyMode === true || tabLock.has(tab.path),
          onStatus: s => { editStatus = s; setTabDirty(tab.path, s.dirty); scheduleStatusRender(); },
          // 草稿走 saveDraftAs（默认扩展名随语言）；真实文件按原名另存
          onSaveAsNeeded: isDraft
            ? content => void saveDraftAs(content, tab.path)
            : content => void saveTextAs(content, tab.path.split(/[\\/]/).pop() ?? 'untitled.md', enc),
          onSaved: (p, stat, clean) => noteSaved(p, stat, clean), onFlash: flash,
        });
        currentView = source;
        const result = await renderPreviewInto(preview, text, {
          dark: document.documentElement.dataset.tone === 'dark',
          isCurrent: () => !stale(),
          route: { baseDir: () => tab.path.replace(/\\/g, '/').replace(/\/[^/]*$/, ''),
            openMarkdown: p => void openPath(p), openExternal: openExternalUrl, hint: flash, interactive: false },
          remoteImages: remoteImagesOf,
        });
        if (stale()) return;
        previewHostEl = result.col;
        const lines = text.split('\n');
        wyMinimap = attachPreviewMinimap(preview, () => lines.length, line => lines[line - 1], () => 0);
        previewFind = new PreviewFind(preview, () => {
          // ▸ 展开替换（统一查找栏口径）：渲染预览无编辑面——带当前查找词切源码并展开替换行
          const seed = previewFind?.needle ?? '';
          setMode(tab, 'edit');
          const t0 = Date.now();
          const open = (): void => {
            if (currentView instanceof EditView) currentView.openReplace(seed);
            else if (Date.now() - t0 < 1500) setTimeout(open, 80); // 挂载竞态：短暂轮询等编辑面就位
          };
          setTimeout(open, 60);
        });
        preview.addEventListener('contextmenu', e => { e.preventDefault();
          const items: CtxMenuItem[] = [];
          const selected = document.getSelection()?.toString();
          if (selected) items.push([$t('ctx.copySel'), () => void writeClipboardText(selected)]);
          items.push([$t('ctx.mdModes'), () => void 0, mdModeMenuItems(tab)]);
          menu(items, e.clientX, e.clientY);
        });
        return;
      }
      if (mode === 'split') {
        // 分屏（007 v0.8 规则 6）：左 CM6 编辑缓冲就地编辑（脏标/Ctrl+S/列模式/关闭守卫随编辑态
        // 全链路生效），右静态渲染（renderPreviewInto）约 300ms 防抖跟随；滚动双向联动防回环；>2MB 守卫回退源码
        const isDraft = tab.path.startsWith('draft://');
        // 编码探测与（编辑+渲染）模块加载并行；加载失败交 catch 回流式查看面
        const kitReady = Promise.all([loadEdit(), loadPreviewKit()]).catch(err => err as unknown as Error);
        let text = '';
        let enc = '';
        try {
          enc = await currentEncoding(tab.path);
          const kit = await kitReady;
          if (kit instanceof Error) throw kit;
          text = editorBuffers.get(tab.path)?.state.doc.toString() ?? recoveryPending.get(tab.path)?.content
            ?? (isDraft ? draftContent.get(tab.path) ?? tab.draftContent ?? '' : await textReadAll(tab.path, enc));
        } catch {
          // 读取失败交回流式查看面由 TextView 呈现错误（保持旧口径）
          setMode(tab, 'view');
          return;
        }
        if (text.length > MD_PREVIEW_LIMIT) {
          // 字符数复核（字节闸在 sanitize/mdSplitEligible，此处兜底）：回源码即编辑面
          setMode(tab, 'edit');
          flash($t('msg.mdPreviewTooLarge'));
          return;
        }
        if (stale()) return; //编码/读取/模块加载期间已有新挂载意图——不写共享宿主
        const wrap = document.createElement('div');
        wrap.className = 'md-split';
        const srcHost = document.createElement('div');
        srcHost.className = 'md-split-src';
        const prevHost = document.createElement('div');
        prevHost.className = 'md-preview md-split-preview';
        wrap.append(srcHost, prevHost);
        viewarea.appendChild(wrap);
        currentView = null;

        // ── 右侧渲染（RenderEngine 统一路径）：防抖 300ms，进行中跳过并补跑最新一次 ──
        // 007 规则 24（UX-C2）：块级渲染缓存——按顶层块切分，未变块 DOM 原样保留；
        // 挂载即新实例 = 文档切换/重开分屏全量清空，主题/解析选项变更在渲染器内清空
        const blockRenderer = createBlockRenderer();
        let previewCol: HTMLElement | null = null;
        let previewBusy = false;
        let previewQueued = false;
        let previewTimer: ReturnType<typeof setTimeout> | undefined;
        let previewLastRender = 0; // 最长等待基准（上次真实渲染时刻）
        let previewDead = false;
        let writingTarget: { line: number; end: boolean } | null = null;
        // 最近的主动操作决定方向，避免CM延迟测量产生的scroll抢走预览阅读位置。
        let scrollOwner: 'left' | 'right' | null = null;
        const readPreview = (): void => { writingTarget = null; scrollOwner = 'right'; };
        const useSource = (): void => { scrollOwner = 'left'; };
        const minimapInput = (event: Event): void => {
          if ((event.target as Element).closest('.minimap, .vscroll')) useSource();
        };
        prevHost.addEventListener('wheel', readPreview, { passive: true });
        prevHost.addEventListener('pointerdown', readPreview);
        srcHost.addEventListener('wheel', useSource, { passive: true });
        srcHost.addEventListener('pointerdown', useSource);
        srcHost.addEventListener('keydown', useSource);
        const editorRow = document.getElementById('editorRow');
        editorRow?.addEventListener('pointerdown', minimapInput);
        editorRow?.addEventListener('wheel', minimapInput, { passive: true });
        const schedulePreview = (): void => {
          if (previewDead || stale()) return;
          // P2（007 规则 6 v2.0）：大文档（>2000 行）跟随防抖 300→500ms——重渲是全文级工作，
          // 连续键入时 300ms 节拍会叠出可感迟滞；小文档维持原手感
          const docLines = ev.view ? ev.view.state.doc.lines : 0;
          const delay = docLines > 2000 ? 500 : 300;
          // 节流改重置防抖 + 最长等待 1000ms——连续输入下预览至多 1s 陈旧强制渲一次
          // （原实现有定时器即跳过=节流，停顿 <300ms 的连续键入每拍全量重渲）
          const sinceRender = previewLastRender ? Date.now() - previewLastRender : Infinity;
          if (previewTimer) clearTimeout(previewTimer);
          previewTimer = setTimeout(() => {
            previewTimer = undefined;
            // 编辑器未就绪（CM6 未建、getContent 空）时跳过本轮——文档非空而内容为空视为未就绪，
            // 防竞态空渲（007 v0.9 AC-19：初渲染由挂载时 renderRight(text) 承担）
            if (previewDead || stale() || !ev.view) return;
            void renderRight();
          }, sinceRender >= 1000 - delay ? 0 : delay);
        };
        const renderRight = async (source?: string): Promise<void> => {
          if (previewDead || stale()) return;
          if (previewBusy) {
            previewQueued = true;
            return;
          }
          previewBusy = true;
          previewLastRender = Date.now(); // 防抖最长等待的计时基准
          try {
            // P2（007 规则 6 v2.0）：重渲前记「视口顶部块」锚（任意块级元素，不依赖标题），
            // 渲后回滚到同一块——修前 innerHTML='' 后 scrollTop 归零、按标题重对齐在文档上方
            // 无标题时 anchor=null 停在顶部（「一编辑右侧滚回最上面」）。
            // v0.16 规则 24：不再整篇 innerHTML 重建——块级缓存渲染器自管列交接
            // （新 col 组装完撤旧 col），未变块 DOM 原样保留、锚块未变时滚动位置天然不动
            let anchor = captureTopBlock(prevHost);
            let keepScroll = prevHost.scrollTop;
            // 初渲染（source=text）不依赖左侧编辑器异步初始化完成；防抖跟随取编辑器当前内容
            const renderDoc = ev.view?.state.doc;
            const target = writingTarget;
            const res = await blockRenderer.render(prevHost, source ?? ev.getContent(), {
              dark: document.documentElement.getAttribute('data-tone') === 'dark',
              route: mdLinkRoute(tab),
              remoteImages: remoteImagesOf, // 图床远程图回填（009 规则 10；未配置时函数内零请求）
              isCurrent: () => !previewDead && !stale() && (!renderDoc || ev.view?.state.doc === renderDoc),
              beforeCommit: () => { anchor = captureTopBlock(prevHost); keepScroll = prevHost.scrollTop; },
            });
            if (previewDead || stale() || !res.committed) return;
            previewCol = res.col;
            previewHostEl = res.col; // 大纲点击锚点作用域跟随最新容器
            armGuard(); // 恢复滚动是程序性滚动，不得回环触发 syncFromRight
            if (target && target === writingTarget && ev.view?.hasFocus) {
              if (target.end) prevHost.scrollTop = prevHost.scrollHeight;
              else {
                const block = previewAnchorBefore(res.col, target.line);
                if (block) {
                  const bounds = block.getBoundingClientRect(), viewport = prevHost.getBoundingClientRect();
                  if (bounds.bottom > viewport.bottom - 24) prevHost.scrollTop += bounds.bottom - viewport.bottom + 24;
                  else if (bounds.top < viewport.top + 24) prevHost.scrollTop += bounds.top - viewport.top - 24;
                }
              }
            } else restoreTopBlock(prevHost, anchor, keepScroll);
          } finally {
            previewBusy = false;
            if (previewQueued) {
              previewQueued = false;
              schedulePreview();
            }
          }
        };

        // ── 滚动双向联动（007 v0.8 规则 6）：方向标志 150ms 防回环，rAF 节流 ──
        let syncing = 0;
        const syncTimers = new Set<ReturnType<typeof setTimeout>>();
        const armGuard = (): void => {
          syncing++;
          const timer = setTimeout(() => { syncing--; syncTimers.delete(timer); }, 150);
          syncTimers.add(timer);
        };
        const firstVisibleLine = (): number => {
          const v = ev.view;
          if (!v) return 0;
          return v.state.doc.lineAt(v.lineBlockAtHeight(v.scrollDOM.scrollTop).from).number - 1;
        };
        const syncFromLeft = (): void => {
          if (previewDead || stale() || syncing || !previewCol || scrollOwner === 'right') return;
          const anchor = previewAnchorBefore(previewCol, firstVisibleLine());
          if (anchor) {
            armGuard();
            prevHost.scrollTop = Math.max(0, anchor.offsetTop - 8);
          }
        };
        const syncFromRight = (): void => {
          if (previewDead || stale() || syncing || !previewCol || !ev.view || scrollOwner === 'left') return;
          let best: HTMLElement | null = null;
          for (const el of previewCol.querySelectorAll<HTMLElement>('[data-line]')) {
            if (el.offsetTop >= prevHost.scrollTop + 4) break;
            best = el;
          }
          if (!best) return;
          const line = parseInt(best.dataset.line ?? '', 10);
          if (!Number.isFinite(line)) return;
          armGuard();
          const l = ev.view.state.doc.line(line + 1);
          ev.view.dispatch({ effects: cmEditorView!.scrollIntoView(l.from, { y: 'start', yMargin: 0 }) });
        };
        let leftRaf = 0;
        let rightRaf = 0;
        const onLeftScroll = (): void => {
          if (!leftRaf) leftRaf = requestAnimationFrame(() => { leftRaf = 0; syncFromLeft(); });
        };
        const onRightScroll = (): void => {
          if (!rightRaf) rightRaf = requestAnimationFrame(() => { rightRaf = 0; syncFromRight(); });
        };
        prevHost.addEventListener('scroll', onRightScroll, { passive: true });

        // ── 左侧编辑缓冲（opts 口径与 edit 分支一致；路径为真实文件，split 不收草稿） ──
        const ev = new EditView(srcHost, {
          path: isDraft ? null : tab.path,
          language: tab.language,
          encoding: enc,
          initialDoc: text,
          buffer: editorBuffers.get(tab.path),
          startDirty: !!recoveryPending.get(tab.path),
          readOnly: settings.readOnlyMode === true || tabLock.has(tab.path),
          wrap: wrapMap.get(tab.path) === true,
          showLineNumbers: settings.showLineNumbers !== false,
          selectionHl: settings.selectionHl !== false,
          invisibleOn: settings.showInvisible === true,
          restoreBookmarks: tab.bookmarks,
          onBookmarksChange: (p, bm) => store.setBookmarks(p, bm),
          onStatus: s => {
            editStatus = s;
            setTabDirty(tab.path, s.dirty);
            scheduleStatusRender();
            updateOutlineCur(s.line);
          },
          onFlash: msg => flash(msg),
          onSaveAsNeeded: isDraft
            ? content => void saveDraftAs(content, tab.path)
            : content => {
                void saveTextAs(content, tab.path.split(/[\\/]/).pop() ?? 'untitled.txt', 'UTF-8');
              },
          onAlert: dlgAlert,
          onConfirm: dlgConfirm,
          onPrompt: dlgPrompt,
          onContextMenu: (x, y) => editViewMenu(tab, x, y), // 含「格式 ▸」「Markdown 模式 ▸」（同构）
          fontSize: settings.fontSize ?? 12,
          onFontSize: n => applyFontSize(n),
          onSaved: (p, stat, clean) => noteSaved(p, stat, clean),
          onDocChange: () => {
            if (ev.view?.hasFocus) {
              useSource();
              const { doc, selection } = ev.view.state;
              writingTarget = { line: doc.lineAt(selection.main.head).number - 1, end: selection.main.head === doc.length };
            }
            blockRenderer.invalidate(); // 编辑即作废在途渲染，防抖期间不提交旧版本。
            schedulePreview();
          },
          onReady: readyView => {
            if (previewDead || stale()) return;
            if (settings.showMinimap !== false) {
              const row = document.getElementById('editorRow');
              if (row) readyView.attachMinimap(row);
            }
            if (readyView.view) {
              readyView.view.scrollDOM.addEventListener('scroll', onLeftScroll, { passive: true });
            }
          },
        });
        ev.setLanguage(tab.language);
        {
          const ov = hlOverride.get(tab.path);
          if (ov === '') ev.setLanguage(null);
          else if (ov && ov !== 'auto') ev.setLanguage(ov);
        }
        if (stale()) {
          blockRenderer.destroy();
          ev.destroy();
          return;
        }
        viewCleanup = () => {
          previewDead = true;
          clearTimeout(previewTimer);
          blockRenderer.destroy();
          cancelAnimationFrame(leftRaf);
          cancelAnimationFrame(rightRaf);
          for (const timer of syncTimers) clearTimeout(timer);
          syncTimers.clear();
          prevHost.removeEventListener('scroll', onRightScroll);
          prevHost.removeEventListener('wheel', readPreview);
          prevHost.removeEventListener('pointerdown', readPreview);
          srcHost.removeEventListener('wheel', useSource);
          srcHost.removeEventListener('pointerdown', useSource);
          srcHost.removeEventListener('keydown', useSource);
          editorRow?.removeEventListener('pointerdown', minimapInput);
          editorRow?.removeEventListener('wheel', minimapInput);
          ev.view?.scrollDOM.removeEventListener('scroll', onLeftScroll);
        };
        currentView = ev; // saveDirtyIfAny / Ctrl+S / 脏标 / 关闭守卫随编辑态自动生效
        renderStatus();
        // 右侧初渲染 + 预览侧右键（源码侧走 editViewMenu）
        prevHost.addEventListener('contextmenu', e => {
          e.preventDefault();
          const sel = document.getSelection()?.toString() ?? '';
          const items: CtxMenuItem[] = [];
          if (sel) items.push([$t('ctx.copySel'), () => void writeClipboardText(sel)]);
          const ext = externalHrefAt(e.target);
          if (ext) items.push([$t('md.openExternal'), () => openExternalUrl(ext)]);
          // 渲染图右键「上传图片到图床」（009 规则 4 触发③）：data-md-src 为原始本地引用
          // （resolveLocalImages/resolveRemoteImages 均已回填）；远程/内联引用不上传
          const rimg = (e.target as HTMLElement | null)?.closest?.('img') as HTMLImageElement | null;
          const rsrc = rimg?.dataset.mdSrc ?? '';
          if (rimg && rsrc && ihEnabled() && !/^(https?:|data:|asset:|blob:|\/\/)/i.test(rsrc)) {
            items.unshift([$t('ctx.uploadImage'), () => { void rewriteLocalRef(tab, rsrc); }]);
          }
          items.push([$t('ctx.mdModes'), () => void 0, mdModeMenuItems(tab)]);
          menu(items, e.clientX, e.clientY);
        });
        await renderRight(text); // AC-19：初渲染以打开时读入的源文本为基准
        return;
      }
      if (mode === 'csv') {
        // 表格模块加载与工作簿/编码探测并行；加载失败走既有打开失败提示
        const csvReady = loadCsv().catch(err => err as unknown as Error);
        const workbook = tab.language === 'Xlsx' ? await xlsxOpen(tab.path) : null;
        // F6 根修（阶段一面4）：CsvView 直写共享 viewarea，mount 的 host.innerHTML='' 与迟到续体
        // 会清掉/覆盖更新渲染放入的内容（关全部后的 .view-empty 即被如此吞掉，残留整张表格）——
        // 改挂包装层：stale 时只移除自身包装，绝不碰可能已就位的新视图；作废早退则完全不碰宿主。
        const enc = workbook ? '' : await currentEncoding(tab.path);
        const csvMod = await csvReady;
        if (csvMod instanceof Error) {
          flash($tf('err.openFail', String(csvMod)));
          return;
        }
        if (stale()) return;
        const csvHost = document.createElement('div');
        viewarea.appendChild(csvHost);
        let csv = new CsvView(csvHost, tab.path, enc, () => {
          toggleMode('csv');
        }, csvDelimiters.get(tab.path), workbook ? xlsxRecordProvider(0) : undefined);
        await csv.mount();
        if (workbook) {
          const installSheets = (sheet: number): void => {
            if (stale()) return;
            const button = document.createElement('button');
            button.textContent = workbook.sheets[sheet]?.name ?? '';
            button.addEventListener('click', e => menu(workbook.sheets.map((s, index): CtxMenuItem => [s.name, () => {
              csv.destroy();
              csv = new CsvView(csvHost, tab.path, '', () => void 0, undefined, xlsxRecordProvider(index));
              currentView = csv;
              csv.setFontSize(settings.fontSize ?? 12);
              void csv.mount().then(() => installSheets(index)).catch(err => flash(String(err)));
            }]), e.clientX, e.clientY));
            csvHost.querySelector('.csv-bar')?.appendChild(button);
          };
          installSheets(0);
        }
        if (stale()) {
          csvHost.remove();
          csv.destroy();
          return;
        }
        currentView = csv;
        csv.setFontSize(settings.fontSize ?? 12); // v2.5 扩面：CSV 表格行高随字号派生（初始带上保存值）
        return;
      }
      // 流式查看面（002 规则 7b v2.6：'view' 仅 >10MB 文件与读取失败兜底——不可编辑、无替换/列模式入口）
      try {
        await loadTextView();
      } catch (err) {
        flash($tf('err.openFail', String(err)));
        return;
      }
      if (stale()) return; //迟到续体不得触碰共享宿主
      // TextView.buildDom 会清空宿主：挂独立包装层（F6 同法），stale 只移除自身节点。
      // tv-scroller/tv-bar 均 absolute 定位（以 .view 为包含块），包装层不影响布局。
      const tvHost = document.createElement('div');
      tvHost.style.cssText = 'height:100%';
      viewarea.appendChild(tvHost);
      const tv = new TextView(tvHost, tab.path, {
        onStatus: s => {
          viewStatus = s;
          if (s.encoding) encodingByPath.set(tab.path, s.encoding);
          scheduleStatusRender();
          updateOutlineCur(s.visibleLine);
        },
        onScrollPersist: (p, sc) => store.setScroll(p, sc),
        onBookmarksChange: (p, bm) => store.setBookmarks(p, bm),
        onContextMenu: (x, y) => textViewMenu(tab, x, y),
        restoreScroll: tab.scroll,
        restoreBookmarks: tab.bookmarks ?? [],
        language: tab.language,
        minimap: settings.showMinimap !== false,
        showLineNumbers: settings.showLineNumbers !== false,
        fontSize: settings.fontSize ?? 12,
        onFontSize: n => applyFontSize(n),
      });
      await tv.mount();
      if (stale()) {
        tvHost.remove();
        tv.destroy();
        return;
      }
      currentView = tv;
      applyHlOverride(tv, tab.path);
      if (settings.showInvisible === true) tv.setInvisibleVisible(true);
      updateMarkers();
    } finally {
      modeLock.set(tab.path, false);
      const next = pendingMount.get(tab.path);
      if (next) {
        // 有更新意图：先拆掉刚挂载的视图，再按最新模式重挂
        pendingMount.delete(tab.path);
        destroyView();
        viewarea.innerHTML = '';
        currentViewKey = `${next.tab.path}#${next.tab.route}#${next.mode}`;
        void mountView(next.tab, next.mode);
      }
    }
  }

  /** Markdown 渲染类缩略图（007 规则 13）：复用 Minimap，密度条取源文本行，滚动分数同步 */
  function attachPreviewMinimap(
    scrollHost: HTMLElement,
    lineCount: () => number,
    lineText: (line: number) => string | undefined,
    linesVersion: () => number
  ): Minimap | null {
    const row = document.getElementById('editorRow');
    if (!row) return null;
    const mm = new Minimap(row, {
      scrollTop: () => scrollHost.scrollTop,
      scrollHeight: () => scrollHost.scrollHeight,
      clientHeight: () => scrollHost.clientHeight,
      scrollTo: y => {
        scrollHost.scrollTop = y;
      },
      totalLines: lineCount,
      lineText,
      cacheVersion: linesVersion,
    });
    const sync = (): void => mm.sync();
    scrollHost.addEventListener('scroll', sync, { passive: true });
    const frame = requestAnimationFrame(sync);
    previewMinimapCleanup = () => {
      scrollHost.removeEventListener('scroll', sync);
      cancelAnimationFrame(frame);
    };
    // 即使当前关闭也保留轻量适配器，模式切换后再次开启不遗漏创建路径。
    mm.setVisible(settings.showMinimap !== false);
    return mm;
  }

  async function currentEncoding(path: string): Promise<string> {
    if (path.startsWith('draft://')) return 'UTF-8';
    const cached = encodingByPath.get(path);
    if (cached) return cached;
    try {
      const enc = (await textOpen(path)).encoding.name;
      encodingByPath.set(path, enc);
      return enc;
    } catch {
      const fallback = encodingByPath.get(path);
      if (fallback) return fallback;
      throw new Error('无法确定原编码');
    }
  }

  // enterEditMode/键入即编辑/查看态「进入编辑」入口已随 002 v2.6 双模式删除：
  // ≤10MB 打开即编辑面，>10MB 流式查看面无任何编辑入口（工具栏/菜单/右键/快捷键同删）。

  // ---- 列标记覆盖层（007 规则 9）+ 列标尺 ----
  function detachMarkerScroll(): void {
    markerScrollDetach?.();
    markerScrollDetach = null;
  }
  function updateMarkers(): void {
    markerOverlay?.remove();
    markerOverlay = null;
    detachMarkerScroll();
    buildRuler();
    const cols = settings.columnMarkers ?? [];
    if (cols.length === 0 || !(currentView instanceof TextView)) return;
    const scroller = currentView.scrollEl;
    if (!scroller) return;
    // 用文本视图真实字体测字符宽（等宽；随缩放字号联动）
    const cs = getComputedStyle(scroller);
    const measurer = document.createElement('span');
    measurer.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font}`;
    measurer.textContent = '0'.repeat(100);
    viewarea.appendChild(measurer);
    const charW = measurer.getBoundingClientRect().width / 100;
    measurer.remove();
    const rootCs = getComputedStyle(document.documentElement);
    const gutterW = parseFloat(rootCs.getPropertyValue('--gutter-w')) || 46;
    const txPad = 16; // .tv-tx padding-left（定稿）
    const base = gutterW + txPad;
    markerOverlay = document.createElement('div');
    markerOverlay.className = 'cm-markers';
    const inner = document.createElement('div');
    inner.className = 'cm-markers-inner';
    for (const c of cols) {
      const line = document.createElement('div');
      line.className = 'cm-marker-line';
      line.style.left = `${base + c * charW}px`;
      line.title = $tf('col.label', c);
      inner.appendChild(line);
    }
    markerOverlay.appendChild(inner);
    viewarea.appendChild(markerOverlay);
    // 横向滚动时随文本平移（竖线对齐列位，B1）
    const sync = (): void => {
      inner.style.transform = `translateX(${-scroller.scrollLeft}px)`;
    };
    sync();
    scroller.addEventListener('scroll', sync, { passive: true });
    markerScrollDetach = () => scroller.removeEventListener('scroll', sync);
  }

  /** 列标尺（002 规则 24 v1.1）：刻度无限延伸——随文本横向滚动/窗口尺寸按需生成格号，并随滚动平移
   *  探针字符宽只测一次（字号变更时重测）；刻度格差量更新（复用已有格 DOM 仅改标签），
   *  不再每帧 innerHTML='' 全量重建、每帧新建探针 div 强制 layout */
  let rulerDetach: (() => void) | null = null;
  function buildRuler(): void {
    rulerDetach?.();
    rulerDetach = null;
    const marks = document.getElementById('rulerMarks');
    if (!marks) return;
    marks.replaceChildren(); // 重建（模式切换/设置变更）：清上一代刻度，防叠加
    const scroller = currentView instanceof TextView ? currentView.scrollEl : null;

    let rulerCellW = 0;
    let rulerFontKey = '';
    let rulerStart = -1;
    let rulerEnd = -1;
    const rulerSpacer = document.createElement('div');
    rulerSpacer.style.cssText = 'flex-shrink:0';
    const rulerCells: HTMLElement[] = [];

    const draw = (): void => {
      // 格号随文本字号走（Ctrl+滚轮缩放联动）
      if (scroller) marks.style.fontSize = getComputedStyle(scroller).fontSize;
      const fontKey = marks.style.fontSize;
      if (fontKey !== rulerFontKey || !rulerCellW) {
        rulerFontKey = fontKey;
        // 测 10ch 一格的像素宽（每字号只测一次，不再每帧新建探针）
        const probe = document.createElement('div');
        probe.className = 'ruler-cell';
        marks.appendChild(probe);
        rulerCellW = probe.getBoundingClientRect().width || 80;
        probe.remove();
      }
      const cellW = rulerCellW;
      const scrollX = scroller?.scrollLeft ?? 0;
      const vw = scroller?.clientWidth || marks.clientWidth || 600;
      const startIdx = Math.max(0, Math.floor(scrollX / cellW));
      const endIdx = Math.ceil((scrollX + vw) / cellW) + 1;
      if (startIdx !== rulerStart || endIdx !== rulerEnd) {
        // 差量更新：区间滚动平移时只增删两端格，其余格复用、标签变化才写 textContent
        const want = endIdx - startIdx + 1;
        while (rulerCells.length > want) rulerCells.pop()!.remove();
        while (rulerCells.length < want) {
          const cell = document.createElement('div');
          cell.className = 'ruler-cell';
          const label = document.createElement('span');
          label.className = 'ruler-label';
          cell.appendChild(label);
          marks.appendChild(cell);
          rulerCells.push(cell);
        }
        for (let k = 0; k < rulerCells.length; k++) {
          const v = String((startIdx + k) * 10);
          const label = rulerCells[k]!.firstElementChild as HTMLElement;
          if (label.textContent !== v) label.textContent = v;
        }
        // 前置占位（格区整体右移 startIdx 格）；宽变才写样式
        const spacerW = startIdx > 0 ? `${startIdx * cellW}px` : '0';
        if (rulerSpacer.style.width !== spacerW) rulerSpacer.style.width = spacerW;
        if (!rulerSpacer.parentNode) marks.insertBefore(rulerSpacer, marks.firstChild);
        rulerStart = startIdx;
        rulerEnd = endIdx;
      }
      // 列标记差量：按格内标记签名比对，未变不动 DOM
      const markerByCell = new Map<number, number[]>();
      for (const c of settings.columnMarkers ?? []) {
        const idx = Math.floor(c / 10);
        if (idx < startIdx || idx > endIdx) continue;
        const list = markerByCell.get(idx);
        if (list) list.push(c);
        else markerByCell.set(idx, [c]);
      }
      for (let k = 0; k < rulerCells.length; k++) {
        const cell = rulerCells[k]!;
        const cols = markerByCell.get(startIdx + k);
        const sig = cols ? cols.join(',') : '';
        if ((cell.dataset.cols ?? '') === sig) continue;
        cell.dataset.cols = sig;
        for (const mk of [...cell.querySelectorAll('.ruler-marker')]) mk.remove();
        if (cols) for (const c of cols) {
          const m = document.createElement('div');
          m.className = 'ruler-marker';
          m.title = $tf('col.label', c);
          // 10ch 一格：格内偏移 = (c%10)/10 * 格宽
          m.style.left = `calc(${(c % 10) / 10} * 10ch + 3px)`;
          cell.appendChild(m);
        }
      }
      // 随文本横向滚动平移（刻度与列位对齐）
      marks.style.transform = `translateX(${-scrollX}px)`;
    };
    draw();
    if (scroller) {
      let raf = 0;
      const onScroll = (): void => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      };
      scroller.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      rulerDetach = () => {
        scroller.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
        cancelAnimationFrame(raf);
      };
    }
  }

  /** 标尺可见性（定稿 demo 视图菜单：切换标尺；007 规则 14：md 渲染布局下隐藏——与文本列位无对应关系） */
  function applyRulerVisible(): void {
    const ruler = document.querySelector('.ruler');
    if (!(ruler instanceof HTMLElement)) return;
    const t = activeTab();
    const m = t ? modeOf(t) : 'view';
    const mdLayout = !!t && t.route === 'text' && (m === 'md' || m === 'split' || m === 'wysiwyg');
    ruler.style.display = settings.showRuler === false || mdLayout || t?.route === 'image' ? 'none' : '';
  }

  // ---- 标签栏（定稿卡片标签：拖拽排序/中键关/右键 QoL） ----
  let dragTabIndex = -1;
  function setTabDirty(path: string, dirty: boolean): void {
    if (dirtyPaths.get(path) === dirty) return;
    dirtyPaths.set(path, dirty);
    renderTabs();
  }

  function tabDisplayName(tab: { path: string }): string {
    if (tab.path.startsWith('draft://')) return $tf('tab.draft', tab.path.slice(8));
    if (tab.path === 'tail://') return $t('tab.tailboard');
    if (tab.path.startsWith('compare://')) {
      return tab.path
        .slice('compare://'.length)
        .split('|')
        .map(s => decodeURIComponent(s).replace(/\\/g, '/').split('/').pop())
        .join(' ↔ ');
    }
    return tab.path.replace(/\\/g, '/').split('/').pop() ?? tab.path;
  }

  // 溢出下拉按钮可见性 + 活动标签滚入视口（#25）
  function refreshTabbarChrome(): void {
    const btn = tabbar.querySelector('.tab-overflow') as HTMLElement | null;
    if (btn) btn.classList.toggle('show', tabbar.scrollWidth > tabbar.clientWidth + 8);
    const active = tabbar.querySelector('.tab.active');
    if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  function renderTabs(): void {
    tabbar.innerHTML = '';
    tabbar.classList.toggle('empty', store.tabs.length === 0);
    store.tabs.forEach((tab, i) => {
      const t = document.createElement('div');
      t.className = 'tab' + (i === store.activeIndex ? ' active' : '');
      t.draggable = true;
      const name = tabDisplayName(tab);
      // 标签图标：单色文件形（data-kind 驱动描边色，与文件树同源；特殊伪标签不着色）
      const special = !isRealFilePath(tab.path);
      const kind = special ? null : kindOf(name);
      const ic = document.createElement('span');
      ic.innerHTML =
        `<svg class="tab-ic"${kind ? ` data-kind="${kind}"` : ''} viewBox="0 0 16 16" aria-hidden="true">` +
        '<path d="M4.4 1.9h4.6l3 3v9.2H4.4z"/><path class="fold" d="M9 1.9v3h3z"/></svg>';
      t.appendChild(ic.firstElementChild as SVGElement);
      const nameEl = document.createElement('span');
      nameEl.className = 'tab-name';
      // 仅同名冲突时显示父目录，增删标签后的每次渲染均重新计算。
      const duplicate = isRealFilePath(tab.path) && store.tabs.some(other => other !== tab && tabDisplayName(other) === name);
      const parent = dirOf(tab.path).split(/[\\/]/).filter(Boolean).pop() ?? '';
      nameEl.textContent = duplicate ? `${name} (${parent})` : name;
      t.append(nameEl);
      if (dirtyPaths.get(tab.path)) {
        const dot = document.createElement('span');
        dot.className = 'tab-dot';
        dot.title = $t('tab.unsaved');
        t.appendChild(dot);
      }
      // 规则 7 状态标记（F001-03）：文件已不在——标签名划线弱化（.tab-del 见 styles.css）
      if (deletedPaths.has(tab.path)) t.classList.add('tab-del');
      // H-2：修改时间/大小从状态栏移到标签悬停（状态栏按视图裁剪降密度）
      {
        const mt = fileMtimes.get(tab.path);
        const size = fileSizes.get(tab.path);
        t.title =
          tab.path +
          (mt ? `\n${$tf('st.mtime', fmtDate(mt))}` : '') +
          (size ? `\n${$tf('st.size', fmtSize(size))}` : '') +
          (fileReadonly.has(tab.path) ? `\n${$t('status.readonly')}` : '');
      }
      t.addEventListener('click', () => store.activate(i));
      t.addEventListener('auxclick', e => {
        if (e.button === 1) {
          e.preventDefault();
          closeTabGuarded(i);
        }
      });
      t.addEventListener('contextmenu', e => {
        e.preventDefault();
        tabMenu(tab.path, i, e.clientX, e.clientY);
      });
      t.addEventListener('dragstart', e => {
        dragTabIndex = i;
        t.classList.add('dragging');
        try {
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer?.setData('text/plain', String(i));
        } catch { /* 沙箱兜底 */ }
      });
      t.addEventListener('dragend', () => {
        dragTabIndex = -1;
        t.classList.remove('dragging');
        tabbar.querySelectorAll('.tab').forEach(x => x.classList.remove('drop-before', 'drop-after'));
      });
      t.addEventListener('dragover', e => {
        e.preventDefault();
        if (dragTabIndex < 0 || dragTabIndex === i) return;
        const r = t.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        t.classList.toggle('drop-before', before);
        t.classList.toggle('drop-after', !before);
      });
      t.addEventListener('dragleave', () => t.classList.remove('drop-before', 'drop-after'));
      t.addEventListener('drop', e => {
        e.preventDefault();
        if (dragTabIndex < 0 || dragTabIndex === i) return;
        const r = t.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        t.classList.remove('drop-before', 'drop-after');
        store.move(dragTabIndex, before ? i : i + (dragTabIndex < i ? 1 : 0));
      });
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.title = $t('tab.closeTip');
      close.innerHTML = '<svg class="ic s9" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
      close.addEventListener('click', e => {
        e.stopPropagation();
        closeTabGuarded(i);
      });
      t.appendChild(close);
      tabbar.appendChild(t);
    });
    // 溢出下拉 ▾：列出全部标签（#25）
    const ov = document.createElement('button');
    ov.className = 'tab-overflow';
    ov.type = 'button';
    ov.title = $t('tab.overflowTip');
    ov.innerHTML = '<svg class="ic s10" viewBox="0 0 16 16"><path d="M3 5.5l5 5 5-5"/></svg>';
    ov.addEventListener('click', e => {
      e.stopPropagation();
      const r = ov.getBoundingClientRect();
      menu(
        store.tabs.map((tab, i) => [
          (dirtyPaths.get(tab.path) ? '● ' : '') + (i === store.activeIndex ? '✓ ' : '') + tabDisplayName(tab),
          () => store.activate(i),
        ]) as CtxMenuItem[],
        r.left,
        r.bottom
      );
    });
    tabbar.appendChild(ov);
    requestAnimationFrame(refreshTabbarChrome);
  }

  // ---- 上下文菜单（支持子菜单：编辑右键"列操作 ▸"等，001 规则 26） ----
  function menu(items: CtxMenuItem[], x: number, y: number): HTMLElement {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    const m = document.createElement('div');
    m.className = 'ctx-menu';
    for (const it of items) {
      if (it === 'sep') {
        const s = document.createElement('div');
        s.className = 'ctx-sep';
        m.appendChild(s);
        continue;
      }
      const [label, fn, children] = it;
      const el = document.createElement('div');
      if (children && children.length > 0) {
        // 父项：悬停向右展开子菜单
        el.className = 'ctx-parent';
        el.textContent = label;
        const arrow = document.createElement('span');
        arrow.className = 'ctx-arrow';
        arrow.textContent = '▸';
        el.appendChild(arrow);
        const sub = document.createElement('div');
        sub.className = 'ctx-sub';
        for (const child of children) {
          if (child === 'sep') {
            const divider = document.createElement('div');
            divider.className = 'ctx-sep'; sub.appendChild(divider);
            continue;
          }
          const [l2, f2, glyph] = child;
          const c = document.createElement('div');
          c.textContent = l2;
          if (glyph) c.insertAdjacentHTML('afterbegin', icon(glyph));
          if (f2) {
            c.addEventListener('click', e2 => {
              e2.stopPropagation();
              m.remove();
              f2();
            });
          } else {
            c.classList.add('disabled'); // 置灰不可点（007 v0.8：模式菜单超限项）
          }
          sub.appendChild(c);
        }
        el.appendChild(sub);
        el.addEventListener('mouseenter', () => placeSubmenu(el, sub));
      } else {
        el.textContent = label;
        if (fn) {
          el.addEventListener('click', () => {
            m.remove();
            fn();
          });
        } else {
          el.classList.add('disabled'); // 置灰不可点（007 v0.8：模式菜单超限项）
        }
      }
      m.appendChild(el);
    }
    m.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
    m.style.top = `${Math.min(y, window.innerHeight - 16 - mItemsHeight(items))}px`;
    document.body.appendChild(m);
    // 点击任意处或 Escape 关闭（Escape 走捕获，输入框聚焦时也生效）
    const onKey = (ke: KeyboardEvent) => {
      if (ke.key === 'Escape') {
        m.remove();
        document.removeEventListener('keydown', onKey, true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    setTimeout(
      () =>
        document.addEventListener(
          'click',
          () => {
            m.remove();
            document.removeEventListener('keydown', onKey, true);
          },
          { once: true }
        ),
      0
    );
    return m;
  }

  statusbar.addEventListener('contextmenu', e => {
    e.preventDefault();
    menu(['view.invisible', 'view.toggleRuler', 'view.minimap'].map(id => {
      const def = reg.get(id)!;
      return [(def.checked?.() ? '✓ ' : '') + $t(def.label), def.enabled?.() === false ? null : () => reg.run(id)] as CtxMenuItem;
    }), e.clientX, e.clientY);
  });

  /** 右键菜单预估高度（贴边防出屏用） */
  function mItemsHeight(items: CtxMenuItem[]): number {
    const rows = items.filter(i => i !== 'sep').length;
    // 与 styles.css 菜单小窗紧凑档（@media max-width:1279px）联动，防贴边翻转预估失准（001 v1.6）
    const compact = window.innerWidth < 1280;
    const row = compact ? 24 : 28;
    const sep = compact ? 8 : 9;
    return rows * row + (items.length - rows) * sep + (compact ? 8 : 10);
  }

  /** Markdown 模式 ▸ 子菜单（007 v0.15 规则 1/8：右键/状态栏/快捷入口唯一来源；三形态，超限项置灰） */
  function mdModeMenuItems(tab: TabState): [string, (() => void) | null][] {
    const ck = (m: ViewMode): string => (modeOf(tab) === m ? '✓ ' : '　');
    // 源码即编辑面（'edit'）：≤10MB 可进；>10MB 已在流式查看面看源码，置灰防误导（007 v0.15 AC-4）
    const srcOk = tab.path.startsWith('draft://') || (fileSizes.get(tab.path) ?? 0) <= EDIT_LIMIT;
    const splitOk = mdSplitEligible(tab);
    const irOk = wysiwygEligible(tab);
    return [
      srcOk
        ? [`${ck('edit')}${$t('act.mdSource')}`, () => setMode(tab, 'edit')]
        : [`　${$t('act.mdSource')}`, null],
      splitOk
        ? [`${ck('split')}${$t('act.mdSplit')}`, () => setMode(tab, 'split')]
        : [`　${$t('act.mdSplit')}`, null],
      splitOk ? [`${ck('md')}${$t('act.mdPreview')}`, () => setMode(tab, 'md')] : [`　${$t('act.mdPreview')}`, null],
      irOk
        ? [`${ck('wysiwyg')}${$t('act.mdWysiwyg')}`, () => setMode(tab, 'wysiwyg')]
        : [`　${$t('act.mdWysiwyg')}`, null],
    ];
  }

  /** 流式查看面右键菜单（001 v2.6 规则 26）：复制/矩形复制/查找/跳行 + Markdown 模式 ▸（超限置灰）；
   *  无编辑类与替换入口（v2.6 双模式删除——流式查看面不可编辑）；路径与文件管理器归标签右键 */
  function textViewMenu(tab: TabState, x: number, y: number): void {
    const sel = document.getSelection()?.toString() ?? '';
    const items: CtxMenuItem[] = [];
    const tvNow = currentView instanceof TextView ? currentView : null;
    if (sel) items.push([$t('ctx.copySel'), () => void writeClipboardText(sel)]);
    if (tvNow?.hasRectSelection()) {
      items.push([$t('ctx.copyRect'), () => {
        void tvNow.rectCopyText().then(rt => {
          if (rt != null) void writeClipboardText(rt);
        });
      }]);
    }
    items.push(
      [$t('act.find'), () => (currentView instanceof TextView ? currentView.openFindBar() : null)],
      [$t('act.gotoLine'), () => (currentView instanceof TextView ? currentView.openGotoBar() : null)]
    );
    // E 批沿用：Markdown 流式查看面右键直达三形态（超限项置灰）
    if (tab.language === 'Markdown') {
      items.push('sep', [$t('ctx.mdModes'), () => void 0, mdModeMenuItems(tab)]);
    }
    menu(items, x, y);
  }

  /** 行批处理 ▸（005 v1.3：在右键，不在编辑菜单；仅编辑面入口——流式查看面无此菜单） */
  function lineBatchMenuItems(): [string, () => void][] {
    const ops: [string, LineBatchOp][] = [
      ['ed.sort', 'sort'],
      ['ed.dedupe', 'dedupe'],
      ['ed.removeEmpty', 'removeEmpty'],
      ['ed.trim', 'trim'],
      ['ed.tabsToSpaces', 'tabsToSpaces'],
      ['ed.spacesToTabs', 'spacesToTabs'],
    ];
    return ops.map(([key, op]) => [$t(key), () => withEdit(v => v.lineBatch(op))]);
  }

  /** Markdown「段落 ▸」子菜单（007 v0.9 规则 2：块级格式收口 所见即所得式分组；CM6 侧自研命令） */
  function mdParagraphMenuItems(v: EditViewT): import('./chrome').CtxMenuLeaf[] {
    return MD_BLOCK_COMMANDS.map(([cmd, key]) => [$t(key), v.isReadOnly ? null : () => runSourceMdFormat(v, cmd),
      cmd === 'table' || cmd === 'codeBlock' ? cmd : cmd.startsWith('h') && cmd !== 'hr' ? 'heading' : undefined]);
  }

  /** Markdown「格式 ▸」子菜单：行内五项（含链接）。 */
  function mdInlineMenuItems(v: EditViewT): import('./chrome').CtxMenuLeaf[] {
    return MD_INLINE_COMMANDS.map(([cmd, key]) => [$t(key), v.isReadOnly ? null : () => runSourceMdFormat(v, cmd), cmd]);
  }

  function runSourceMdFormat(v: EditViewT, cmd: MdFormatCmd): void {
    if (!v.view || v.isReadOnly || v.view.composing) return;
    if (cmd === 'link') editMarkdownLink(v.view, () => currentView === v && !v.isReadOnly);
    else { runMdFormat(v.view, cmd); v.view.focus(); }
  }

  /** 编辑模式右键菜单（001 规则 26）：编辑组 + 列操作 ▸（多选区时）；md 文件追加「格式 ▸」「Markdown 模式 ▸」（007 v0.8 规则 8 同构） */
  function editViewMenu(tab: TabState, x: number, y: number): void {
    const ev = () => (currentView instanceof EditView ? currentView : null);
    const items: CtxMenuItem[] = [
      [$t('act.undo'), () => ev()?.cmUndo()],
      [$t('act.redo'), () => ev()?.cmRedo()],
      'sep',
      [$t('act.cut'), () => ev()?.cmCut()],
      [$t('act.copy'), () => ev()?.cmCopy()],
      [$t('act.paste'), () => ev()?.cmPaste()],
      [$t('act.selectAll'), () => ev()?.cmSelectAll()],
      'sep',
      [$t('act.find'), () => ev()?.openFindBar()],
      [$t('act.replace'), () => ev()?.openReplace()],
      [$t('act.gotoLine'), () => {
        void dlgPrompt($t('prompt.gotoLine')).then(v => {
          const n = parseInt(v ?? '', 10);
          if (Number.isFinite(n) && n >= 1) ev()?.goToLine(n);
        });
      }],
    ];
    const v = ev();
    // #10 放宽：多选区（矩形）或列模式开启时任一形态，「列操作 ▸」都可达
    if (v && (v.hasMultiSelection() || v.isColumnModeOn() || v.hasColumnRect())) {
      // 列操作 ▸（005 规则 14 v2.0：视觉列口径 + 求和/对齐）
      items.push('sep', [$t('ctx.colOps'), () => void 0, [
        [$t('ed.columnFillToEnd'), () => void v.cmdFill()],
        [$t('ed.number'), () => void v.cmdNumbering()],
        [$t('ed.upper'), () => v.cmdCase('upper')],
        [$t('ed.lower'), () => v.cmdCase('lower')],
        [$t('ed.deleteCol'), v.hasColumnRect() ? () => v.cmdDelete() : null],
        [$t('ed.cutCol'), v.hasColumnRect() ? () => void v.cmdCut() : null],
        [$t('ed.pasteCol'), () => void v.cmdPaste({ force: true })], // 005 规则 5a v3.0：显式列意图（不限列模式）
        [$t('ed.sumCol'), v.hasColumnRect() ? () => void v.cmdSum() : null],
        [$t('ed.sumColInsert'), v.hasColumnRect() ? () => void v.cmdSum(true) : null], // 批 B #11：求和并插入到光标处
        'sep',
        [$t('ed.alignLeft'), v.hasColumnRect() ? () => v.cmdAlign('left') : null],
        [$t('ed.alignCenter'), v.hasColumnRect() ? () => v.cmdAlign('center') : null],
        [$t('ed.alignRight'), v.hasColumnRect() ? () => v.cmdAlign('right') : null],
        [$t('ed.blankCol'), v.hasColumnRect() ? () => void v.cmdInsertBlankColumn() : null], // 批 2 同类缺口：插入空列（整列右移）
        'sep',
        [$t('ed.incCol'), v.hasColumnRect() ? () => void v.cmdChangeColumnNumbers(1) : null], // 批 2 同类缺口：列内数字 +1
        [$t('ed.decCol'), v.hasColumnRect() ? () => void v.cmdChangeColumnNumbers(-1) : null], // 批 2 同类缺口：列内数字 -1
        ['按列升序', v.hasColumnRect() ? () => v.cmdSortColumn(false) : null],
        ['按列降序', v.hasColumnRect() ? () => v.cmdSortColumn(true) : null],
        ['按列去重', v.hasColumnRect() ? () => v.cmdDedupeColumn() : null],
        'sep',
        ['补齐固定列宽', v.hasColumnRect() ? () => v.cmdPadColumn() : null],
      ]]);
    }
    // 行批处理（005 规则 14 v1.4）：适用矩阵经 lineBatchAllowed 单一判决（H-6d）
    if (lineBatchAllowed(tab.language)) items.push([$t('menu.lineBatch'), () => void 0, lineBatchMenuItems()]);
    // md 文件：段落 ▸ / 格式 ▸（所见即所得式双二级菜单，007 v0.9 规则 2/8）+ Markdown 模式 ▸（草稿不支持形态切换）
    if (tab.language === 'Markdown' && v) {
      items.push('sep', [$t('ctx.paragraph'), () => void 0, mdParagraphMenuItems(v)]);
      items.push([$t('ctx.format'), () => void 0, mdInlineMenuItems(v)]);
      // 源码内光标处本地图片引用 →「上传图片到图床」（009 规则 4 触发③；未启用不出现）
      const mview = v.view;
      const imgRef = mview ? localImageRefAt(mview) : null;
      if (imgRef && ihEnabled()) {
        items.push([$t('ctx.uploadImage'), () => { void rewriteLocalRef(tab, imgRef.ref, imgRef.from); }]);
      }
      if (!tab.path.startsWith('draft://')) {
        items.push([$t('ctx.mdModes'), () => void 0, mdModeMenuItems(tab)]);
      }
    }
    menu(items, x, y);
  }

  /** 应用该路径手动指定的高亮语言（挂载后调用；'auto' 缺省无需处理） */
  function applyHlOverride(tv: TextViewT, path: string): void {
    const ov = hlOverride.get(path);
    if (ov != null && ov !== 'auto') tv.setHighlightLanguage(ov);
  }

  /**
   * 编辑类动作统一入口：编辑面直接执行；IR 态交 IR 内建（不跨形态）。
   * irAction=null 表示该动作在 IR 下不适用（如粘贴交浏览器原生）。
   * H-6 根修：IR 里按 Ctrl+Z 不得把即时渲染标签切到源码编辑态（还要过 R5 确认框）。
   * v2.6 起无「查看态自动进编辑」兜底——流式查看面（>10MB）本就不可编辑，落到此分支即静默不执行；
   * 分屏左半是独立 EditView 实例，不在 currentView 上，分屏下的编辑类动作由各自右键/快捷键就地处理。
   */
  function withEdit(fn: (v: EditViewT) => void, irAction?: 'undo' | 'redo' | null): void {
    if (modeOf(activeTab()!) === 'md') return;
    if (currentView instanceof EditView && currentView.view) {
      fn(currentView);
      return;
    }
    if (currentView instanceof LivePreviewView) {
      // IR 态编辑类动作就地承载（CM6 history，不跨形态；v0.16 引擎自带 undo/redo）
      if (irAction === 'undo') currentView.cmUndo();
      else if (irAction === 'redo') currentView.cmRedo();
    }
  }

  function tabMenu(path: string, index: number, x: number, y: number): void {
    const tab = store.tabs[index];
    const isText = tab?.route === 'text' && !path.startsWith('draft://');
    const real = isRealFilePath(path);
    const items: CtxMenuItem[] = [
      [$t('common.close'), () => closeTabGuarded(index)],
      [$t('ctx.closeOther'), () => {
        const keep = store.tabs[index];
        for (let i = store.tabs.length - 1; i >= 0; i--) if (store.tabs[i] !== keep) closeTabGuarded(i);
      }],
      [$t('ctx.closeRight'), () => {
        for (let i = store.tabs.length - 1; i > index; i--) closeTabGuarded(i);
      }],
      [$t('ctx.closeAll'), () => {
        for (let i = store.tabs.length - 1; i >= 0; i--) closeTabGuarded(i);
      }],
    ];
    if (real && tab) {
      items.push(
        // 比较文件…（001 规则 26）：以本标签为一端，选另一端（AC-33）
        // （原「复制标签页」已移除：TabStore 按路径去重，同路径无法成二标签，此前为无效操作）
        [$t('ctx.compareWith'), () => {
          void openDialog({ multiple: false }).then(b => {
            if (b) openCompare(path, b as string);
          });
        }]
      );
    }
    items.push(
      'sep',
      [$t('ctx.copyFullPath'), () => void writeClipboardText(path)],
      [$t('ctx.revealInExplorer'), () => void revealInDir(path).catch(err => flash($tf('err.openSysFail', String(err))))]
    );
    if (real) {
      items.push([$t('ctx.openWith'), () => void openWithDefault(path).catch(err => flash($tf('err.openSysFail', String(err))))]);
    }
    items.push([$t('ctx.checksum'), () => void ensurePanels().then(m => document.body.appendChild(overlayDialog($t('checksum.title'), m.checksumPanel(path), () => void 0)))]);
    if (isText) items.push([$t('ctx.newlineConvert'), () => openNlConvertDialog(path)]);
    menu(items, x, y);
  }

  /** 树右键 —— 新建/重命名轻量管理（001 规则 28 v2.1：新建文件带格式下拉）+ 通用文件操作 */
  function promptCreate(dir: string, isDir: boolean): void {
    if (isDir) {
      void dlgPrompt($t('ctx.newFolder')).then(name => createIn(dir, name, '', true));
      return;
    }
    // P2（001 规则 28 v2.1 / 007）：新建文件选格式——建完 openPath 按扩展名路由，
    // Markdown 直达即时渲染（修前只有文件名输入，不带扩展名即落纯文本编辑态）
    const FORMATS: Array<{ id: string; label: string }> = [
      { id: 'txt', label: $t('fmt.txt') },
      { id: 'md', label: $t('fmt.md') },
      { id: 'csv', label: $t('fmt.csv') },
      { id: 'json', label: $t('fmt.json') },
      { id: 'xml', label: $t('fmt.xml') },
      { id: 'log', label: $t('fmt.log') },
    ];
    void dlgPromptWithFormat($t('ctx.newFile'), FORMATS).then(r => {
      if (!r) return;
      createIn(dir, r.name, r.format, false);
    });
  }

  /** 新建落盘（文件名缺所选格式扩展名时补上——已带任一扩展名则尊重用户输入不覆盖）；
   *  文件建完即打开（按扩展名路由视图），文件夹只建不开。 */
  function createIn(dir: string, name: string | null, format: string, isDir: boolean): void {
    if (!name || name.includes('/') || name.includes('\\')) return;
    let finalName = name;
    if (!isDir && format && !/\.[a-z0-9]+$/i.test(name)) finalName = `${name}.${format}`;
    const full = dir.endsWith('/') || dir.endsWith('\\') ? dir + finalName : dir + '\\' + finalName;
    void (isDir ? dirCreate(full) : fileCreate(full))
      .then(async () => {
        void rebuildTree().then(() => tree?.reveal(full));
        if (!isDir) {
          await openPath(full);
          const tab = activeTab();
          // 新建 Markdown 按 001 规则 28 直达即时渲染；打开既有文件仍遵循默认设置。
          if (tab?.path === normLocal(full) && tab.language === 'Markdown') setMode(tab, 'wysiwyg');
        }
      })
      .catch(err =>
        dlgAlert(String(err).includes('EXISTS') ? $t('msg.nameExists') : $tf('err.createFail', String(err)))
      );
  }

  function promptRename(path: string): void {
    const old = path.split(/[\\/]/).pop() ?? '';
    void dlgPrompt($t('prompt.rename'), old).then(name => {
      if (!name || name === old || name.includes('/') || name.includes('\\')) return;
      const dir = path.slice(0, path.length - old.length);
      const target = dir + name;
      const viewPath = currentView instanceof EditView ? currentView.filePath : currentView instanceof LivePreviewView ? currentView.path : null;
      const follows = viewPath && (viewPath === path || viewPath.startsWith(path + '\\') || viewPath.startsWith(path + '/'));
      const rename = () => fileRename(path, target);
      const move = follows && (currentView instanceof EditView || currentView instanceof LivePreviewView)
        ? currentView.relocate(target + viewPath.slice(path.length), rename) : rename();
      void move
        .then(() => {
          const affected = store.tabs.filter(t => t.path === path || t.path.startsWith(path + '\\') || t.path.startsWith(path + '/'));
          if (affected.some(t => t.path === activeTab()?.path)) {
            const active = activeTab()!;
            if (currentView instanceof EditView && editStatus?.dirty) {
              recoveryPending.set(active.path, { content: currentView.getContent(), diskChanged: false });
            } else if (currentView instanceof LivePreviewView && currentView.isDirty) {
              recoveryPending.set(active.path, { content: currentView.getMarkdown(), diskChanged: false });
            }
            destroyView();
            currentViewKey = '\u0000';
            viewSeq++;
          }
          const migrate = <T,>(map: Map<string, T>, oldPath: string, newPath: string): void => {
            if (!map.has(oldPath)) return;
            map.set(newPath, map.get(oldPath)!);
            map.delete(oldPath);
          };
          for (const tab of affected) {
            const next = target + tab.path.slice(path.length);
            migrate(modeMap, tab.path, next);
            migrate(editorBuffers, tab.path, next);
            migrate(wrapMap, tab.path, next);
            migrate(csvDelimiters, tab.path, next);
            migrate(recoveryPending, tab.path, next);
            migrate(fileSizes, tab.path, next);
            migrate(fileMtimes, tab.path, next);
            migrate(encodingByPath, tab.path, next);
            migrate(dirtyPaths, tab.path, next);
            migrate(hlOverride, tab.path, next);
            migrate(wysiwygHeadings, tab.path, next);
            migrate(switchAnchor, tab.path, next);
            migrate(saveEpochByPath, tab.path, next);
            if (fileReadonly.delete(tab.path)) fileReadonly.add(next);
            if (deletedPaths.delete(tab.path)) deletedPaths.add(next);
            if (discardedBuffers.delete(tab.path)) discardedBuffers.add(next);
            if (tabLock.delete(tab.path)) tabLock.add(next); // F6（审计）：只读锁随改名迁移，防锁定标签改名后意外可编辑
            textOpenMemoInvalidate(tab.path); // F14（审计）：旧路径的前端 text_open 备忘作废，新路径按需重取（后端探测缓存按 len+mtime 自失效）
            const pending = recoveryPending.get(next);
            if (pending) writeSnapshot(next, pending.content, false);
            void recoveryDiscard([tab.path]).catch(err => console.warn('Discard renamed recovery failed', err));
            mruOrder = mruOrder.map(p => p === tab.path ? next : p);
          }
          store.renamePath(path, target);
          syncTreeRootToActive();
          void rebuildTree();
          flash($t('msg.renamed'));
        })
        .catch(err =>
          dlgAlert(String(err).includes('EXISTS') ? $t('msg.nameExists') : $tf('err.renameFail', String(err)))
        );
    });
  }

  /** 删除路径（文件或目录）后处置对应标签（001 规则 11，F001-06）：净标签同步关闭；
   *  脏标签保留并标「已删除」——内容仅存在于缓冲，静默关闭即数据丢失，交用户经
   *  状态栏删除格另存恢复或三键守卫处置。 */
  function closeTabsForDeletedPath(path: string): void {
    const under = (p: string): boolean =>
      p === path || p.startsWith(path + '\\') || p.startsWith(path + '/');
    let touched = false;
    for (const t of [...store.tabs]) {
      if (!under(t.path)) continue;
      if (dirtyPaths.get(t.path) === true) {
        deletedPaths.add(t.path); // 脏：标记保留（激活后状态栏删除格可另存恢复）
        touched = true;
      } else if (store.closeByPath(t.path)) {
        touched = true;
      }
    }
    if (touched) {
      renderStatus();
      renderTabs();
    }
  }

  function trashTreePath(path: string): void {
    void dlgConfirm($tf('msg.confirmTrash', path)).then(ok => {
      if (ok) void deleteToTrash(path).then(() => {
        void tree?.refresh();
        closeTabsForDeletedPath(path);
      }).catch(err => dlgAlert($tf('err.trashFail', String(err))));
    });
  }

  function treeMenu(path: string, x: number, y: number, sel?: string[]): void {
    const items: Array<[string, () => void] | 'sep'> = [
        [$t('ctx.open'), () => void openPath(path)],
        [$t('ctx.rename'), () => promptRename(path)],
        'sep',
        [$t('ctx.copyFullPath'), () => void writeClipboardText(path)],
        [$t('ctx.revealInExplorer'), () => void revealInDir(path).catch(err => flash($tf('err.openSysFail', String(err))))],
        [$t('ctx.openWith'), () => void openWithDefault(path).catch(err => flash($tf('err.openSysFail', String(err))))],
        [$t('ctx.checksum'), () => void ensurePanels().then(m => document.body.appendChild(overlayDialog($t('checksum.title'), m.checksumPanel(path), () => void 0)))],
        [$t('ctx.deleteTrash'), () => trashTreePath(path)],
    ];
    if (sel && sel.length >= 2) {
      // 批 F #21：Ctrl+多选两个文件右键直达比较（008 规则 1 v0.3）
      items.unshift('sep');
      items.unshift([$t('ctx.compareSel'), () => openCompare(sel[0]!, sel[1]!)]);
    }
    menu(
      items,
      x,
      y
    );
  }

  /** 目录行右键（001 规则 28：新建文件/文件夹/重命名 + 定位/系统打开） */
  function treeDirMenu(path: string, x: number, y: number): void {
    menu(
      [
        [$t('ctx.newFile'), () => promptCreate(path, false)],
        [$t('ctx.newFolder'), () => promptCreate(path, true)],
        [$t('ctx.rename'), () => promptRename(path)],
        [$t('ctx.deleteTrash'), () => trashTreePath(path)],
        'sep',
        [$t('ctx.copyFullPath'), () => void writeClipboardText(path)],
        [$t('ctx.revealInExplorer'), () => void revealInDir(path).catch(err => flash($tf('err.openSysFail', String(err))))],
        [$t('ctx.openWith'), () => void openWithDefault(path).catch(err => flash($tf('err.openSysFail', String(err))))],
      ],
      x,
      y
    );
  }

  // ---- 状态栏（定稿分段格 + 三灯，001 规则 23/24）----
  // 增量更新：格子序列（布局签名）变化才重建 DOM；滚动/光标等高频回调只改文本与类名。
  // 此前每个滚动事件全量重建整条状态栏，是滚动"卡卡的"主因之一。
  let sbLayoutKey = '\u0000';
  let sbSync: (() => void) | null = null;

  /** 锚点弹层（P2：定位单一实现 placePopup——按锚点自动上/下翻转）：
   *  底部状态栏锚点照旧向上弹；顶部工具栏锚点（「标题 ▾」「分隔符 ▾」）向下弹，
   *  修前恒 bottom 锚定向上生长把 H1/H2 顶出视口（用户反馈「只显示标题 3/4」）。 */
  function popupAbove(anchor: HTMLElement, items: CtxMenuItem[]): void {
    const r = anchor.getBoundingClientRect();
    const m = menu(items, r.left, 0);
    placePopup(anchor, m);
  }

  // onStatus 高频上报（每次按键/选区变化）经 rAF 合并——同帧多次上报只渲一次；
  // 直接调用的 renderStatus（保存收口/设置变更等）保持同步语义不变（状态栏有同步读取方）。
  // 测试桥（__zieditTest）环境改用微任务——jsdom 的 rAF 定时器不被测试 settle 微任务链驱动。
  let statusRenderQueued = false;
  function scheduleStatusRender(): void {
    if (statusRenderQueued) return;
    statusRenderQueued = true;
    const run = (): void => {
      statusRenderQueued = false;
      renderStatus();
    };
    if (shellBridge) queueMicrotask(run);
    else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else queueMicrotask(run);
  }

  function renderStatus(): void {
    scheduleBufferOutline();
    const tab = store.active();
    if (!statusHintEl) {
      statusHintEl = document.createElement('span');
      statusHintEl.className = 'st-hint';
      bindStatusHint(statusHintEl);
    }
    setHintDefault(tab ? (tab.path.startsWith('draft://') ? $t('status.draft') : tab.path) : $t('status.ready'));
    const mode: ViewMode = tab ? modeOf(tab) : 'view';
    const isMd = !!tab && tab.route === 'text' && tab.language === 'Markdown';
    const realText =
      !!tab && tab.route === 'text' && isRealFilePath(tab.path);
    const layoutKey = [
      tab ? `${tab.path}|${tab.route}|${mode}` : '',
      viewStatus ? 'v' : '',
      viewStatus?.rect ? 'vr' : '', // 005 AC-23：流式矩形激活 → 增/删「N 行 × M 列」格（buildStatusbar 门控分支）
      editStatus ? 'e' : '',
      cmpStatus ? 'c' : '',
      tailStatus ? 't' : '',
      viewStatus && viewStatus.bookmarks.length > 0 ? 'bm' : '',
      viewStatus?.indexing ? 'idx' : '',
      isMd && (fileSizes.get(tab!.path) ?? 0) <= EDIT_LIMIT ? 'mded' : '', // md 快捷格三形态对称（007 v0.15）：mode 已在键内，仅随可选格变化
      isMd && mdSplitEligible(tab!) ? 'mdsp' : '',
      isMd && wysiwygEligible(tab!) ? 'mdok' : '',
      realText && (tab!.language === 'CSV' || tab!.language === 'TSV') && mode !== 'csv' ? 'csvq' : '',
      tab && extModified.has(tab.path) ? 'extmod' : '',
      tab && deletedPaths.has(tab.path) ? 'extdel' : '',
    ].join('#');
    if (layoutKey !== sbLayoutKey) {
      sbLayoutKey = layoutKey;
      buildStatusbar();
    }
    sbSync?.();
  }

  function buildStatusbar(): void {
    const tab = store.active();
    const mode: ViewMode = tab ? modeOf(tab) : 'view';
    statusbar.innerHTML = '';
    statusbar.appendChild(statusHintEl!); // 复用同一节点，保留进行中的 flash 文案
    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    statusbar.appendChild(spacer);

    const cell = (cls?: string, title?: string): HTMLElement => {
      const s = document.createElement('div');
      s.className = 'st-cell' + (cls ? ' ' + cls : '');
      if (title) s.title = title;
      statusbar.appendChild(s);
      return s;
    };
    const clickable = (el: HTMLElement, fn: (e: MouseEvent) => void): HTMLElement => {
      el.classList.add('clickable');
      el.addEventListener('click', fn);
      return el;
    };

    // 定稿单元格序列：模式 / 行列 / 行尾 / 编码 / 高亮语言 / 修改日期 / 大小 / （视图专属） / COL / 三灯
    // 模式格（2026-10 定稿）：唯一形态入口——显示当前形态名，点击弹菜单选择（mdModeMenuItems：
    // 当前项打 ✓、超限项置灰）。不再有快捷格/多按钮分段（此前两套并存与四按钮分段均为反馈否决形态）。
    const modeCell = clickable(cell('mode-cell', $t('st.tip.mode')), e => onModeCellClick(e));
    const posCell = clickable(cell('mono', $t('st.tip.pos')), () =>
      currentView instanceof TextView ? currentView.openGotoBar() : null
    );
    const nlQuick = (id: NlId) => () => {
      const t0 = store.active();
      if (t0 && t0.route === 'text' && !t0.path.startsWith('draft://')) void nlConvertSave(t0.path, id);
    };
    const nlCell = clickable(cell('', $t('st.tip.nl')), () =>
      popupAbove(nlCell, [
        [$tf('ctx.newlineTo', 'LF'), nlQuick('LF')],
        [$tf('ctx.newlineTo', 'CRLF'), nlQuick('CRLF')],
        [$tf('ctx.newlineTo', 'CR'), nlQuick('CR')],
      ]));
    const encCell = clickable(cell('combo', $t('st.tip.enc')), () => {
      // IR（即时渲染）同为文本承载（草稿/Markdown 默认形态），编码切换经哨兵重挂支持（002 规则 1 修订）
      if (!(currentView instanceof TextView) && !(currentView instanceof EditView) && !(currentView instanceof LivePreviewView)) return;
      const cur =
        viewStatus?.encoding ?? (tab ? encodingByPath.get(tab.path) : undefined) ?? 'UTF-8';
      popupAbove(encCell, ENCODING_CYCLE.map(enc => [
        `${enc === cur ? '✓ ' : '　'}${enc}`,
        () => setEncoding(enc),
      ] as [string, () => void]));
    });
    // 语法高亮语言格（002 规则 6）：显示当前语言名，弹窗列出全部支持语言供选择/查看
    const langCell = clickable(cell('combo', $t('st.tip.lang')), e => onLangCellClick(e));

    // H-2：修改时间移到标签悬停（状态栏降密度）；大小格保留（排查常看）
    const sizeCell = cell('mono', $t('st.tip.size'));
    // 图片没有文本语义；Office/PDF 的行列与编码也不是原文件属性。
    const imageOnly = tab?.route === 'image';
    const documentOnly = ['Docx', 'Xlsx', 'Pdf'].includes(tab?.language ?? '');
    if (imageOnly) {
      for (const c of [modeCell, posCell, nlCell, encCell, langCell]) c.remove();
    } else if (documentOnly) {
      posCell.remove();
      encCell.remove();
    }

    // 视图专属附加格（布局签名已按存在性门控）
    let wySave: HTMLElement | null = null;
    let wyCount: HTMLElement | null = null;
    let editSel: HTMLElement | null = null;
    let bmCell: HTMLElement | null = null;
    let followCell: HTMLElement | null = null;
    let cmpDiffCell: HTMLElement | null = null;
    let tailCell: HTMLElement | null = null;
    /** 静态文本快捷格（布局签名门控，无动态文本） */
    const quick = (label: string, title: string, fn: () => void): void => {
      clickable(cell('', title), () => fn()).textContent = label;
    };
    const realText =
      !!tab && tab.route === 'text' && isRealFilePath(tab.path);
    if (tab && !imageOnly) {
      if (mode === 'wysiwyg') {
        wySave = cell('mono', $t('st.tip.wySave'));
        wyCount = cell('mono', $t('st.tip.mdCount')); // 「N 字 · M 行」（007 v0.11）
      } else if (mode === 'edit' && editStatus) {
        editSel = cell('mono', $t('st.tip.sel'));
      } else if (viewStatus?.rect) {
        // 流式查看面矩形活动时的尺寸格（005 AC-23「流式面上报 N 行 × M 列」；无矩形时不占格）
        editSel = cell('mono', $t('st.tip.sel'));
      }
      if (viewStatus) {
        if (viewStatus.bookmarks.length > 0) bmCell = cell('mono', $t('st.tip.bm'));
        // H-3 适用矩阵：日志跟随格只对 Log/txt 显示（Markdown/JSON 等非日志不显示"日志跟随：关"）
        if (tab.language === 'Log' || tab.language == null) {
          followCell = clickable(cell('', $t('st.tip.follow')), () => toggleFollow());
        }
        // #20：删除「编辑」快捷格——模式格单击/工具栏编辑钮/Ctrl+E 已三重覆盖
        if (viewStatus.indexing) cell('mono', $t('st.quick.indexingTip')).textContent = $t('st.quick.indexing');
      } else if (cmpStatus) {
        cell('', cmpStatus.degraded ? $t('st.cmp.degraded') : $t('st.cmp.six')).textContent = $t('st.mode.compare');
        cmpDiffCell = cell('mono', $t('st.tip.cmpDiff'));
      } else if (tailStatus) {
        cell('', $t('st.tip.tail')).textContent = $t('tab.tailboard');
        tailCell = cell('mono', $t('st.tip.tail'));
      }
      // CSV 源码包括编辑面与流式查看面，两者都保留返回表格的入口。
      if (realText && (tab.language === 'CSV' || tab.language === 'TSV') && mode !== 'csv') {
        quick($t('st.quick.table'), $t('st.quick.tableTip'), () => toggleMode('csv'));
      }
      // Markdown 快捷格已由「四形态分段」取代（见上方 mdSegTab 分支，2026-10 梳理）
      // 外部修改提示格（001 规则 29：脏缓冲下检测到外部修改 → 三选）
      if (extModified.has(tab.path)) {
        const cellExt = clickable(cell('raised ext-mod', $t('msg.fileChanged')), () =>
          popupAbove(cellExt, [
            [$t('msg.fileChangedReload'), () => reloadActiveTab()],
            [$t('msg.fileChangedSave'), () => {
              void saveDirtyTab(tab.path).then(ok => {
                if (ok) reloadActiveTab();
              });
            }],
            [$t('msg.fileChangedIgnore'), () => {
              extModified.delete(tab.path);
              renderStatus();
            }],
          ]));
        cellExt.textContent = $t('msg.fileChanged');
      }
      // 外部删除提示格（001 规则 7/29，F001-03）：文件已不在——另存恢复缓冲 / 关闭标签 / 忽略
      if (deletedPaths.has(tab.path)) {
        const cellDel = clickable(cell('raised ext-del', $t('msg.fileDeleted')), () =>
          popupAbove(cellDel, [
            [$t('msg.fileDeletedSaveAs'), () => {
              // 缓冲内容另存到新位置（脏缓冲的唯一恢复路径；原路径文件已入回收站）
              const content = currentView instanceof EditView ? currentView.getContent() : null;
              if (content != null) void saveTextAs(content, tab.path.split(/[\\/]/).pop() ?? 'untitled.txt', 'UTF-8');
            }],
            [$t('common.close'), () => {
              const i = store.tabs.findIndex(t => t.path === tab.path);
              if (i >= 0) closeTabGuarded(i); // 脏缓冲仍走三键守卫（closeTabGuarded 内部按 path 重解）
            }],
            [$t('msg.fileChangedIgnore'), () => {
              deletedPaths.delete(tab.path);
              renderStatus();
            }],
          ]));
        cellDel.textContent = $t('msg.fileDeleted');
      }
    }

    // 图床上传指示格（009 规则 7）：上传期间显示「上传中…」，结束即随重建消失（renderStatus 驱动）
    const uploadCell = uploadActive > 0 ? cell('raised', $t('ih.uploading')) : null;
    if (uploadCell) uploadCell.textContent = $t('ih.uploading');

    // H-2/005 v2.4 规则 12：列模式灯仅编辑面（'edit'/分屏左半）显示——流式查看面/IR/表格无列语义；
    // 伪标签（对比/尾随台）同样无列语义（P0-2）
    const colRelevant =
      !!tab && tab.route === 'text' && !isVirtualTab(tab.path) && (mode === 'edit' || mode === 'split');
    let colCell: HTMLElement | null = null;
    if (colRelevant) {
      colCell = clickable(cell('raised col-badge', $t('st.tip.col')), () => {
        // v2.6：流式查看面不可编辑，COL 点击仅在编辑面有效（分屏左半经其自身 Alt+C/右键切换）
        if (currentView instanceof EditView) currentView.toggleColumnMode();
      });
      colCell.textContent = 'COL';
    }

    // 三灯（001 规则 23）
    // P3（反馈 26）：可写灯可点——弹当前文件属性（路径/大小/修改时间/只读态），点击不再无反应
    const wrCell = clickable(cell('raised'), () => {
      const t = activeTab();
      if (!t || !isRealFilePath(t.path)) return;
      const size = fileSizes.get(t.path);
      const mt = fileMtimes.get(t.path);
      const ro = fileReadonly.has(t.path);
      dlgAlert(
        `${t.path}\n\n` +
          $tf('wrinfo.size', size != null ? fmtSize(size) : '—') +
          '\n' +
          $tf('wrinfo.mtime', mt ? fmtDate(mt) : '—') +
          '\n' +
          $tf('wrinfo.readonly', ro ? $t('common.yes') : $t('common.no')),
        $t('wrinfo.title')
      );
    });
    const wrDot = document.createElement('span');
    const wrLabel = document.createElement('span');
    wrCell.append(wrDot, wrLabel);
    // H-2：插入/改写灯仅编辑缓冲形态有意义（CM6 编辑/分屏/草稿；IR/预览/查看隐藏）
    const insRelevant = !settings.readOnlyMode && !!tab && tab.route === 'text' && (mode === 'edit' || mode === 'split');
    let insCell: HTMLElement | null = null;
    if (insRelevant) {
      insCell = clickable(cell('raised', ''), () =>
        currentView instanceof EditView ? currentView.toggleOverwrite() : null
      );
    }
    const insDot = document.createElement('span');
    const insLabel = document.createElement('span');
    if (insCell) insCell.append(insDot, insLabel);

    const setTxt = (el: HTMLElement | null, v: string): void => {
      if (el && el.textContent !== v) el.textContent = v;
    };
    sbSync = () => {
      const t = activeTab();
      const m: ViewMode = t ? modeOf(t) : 'view';
      // 模式名
      let modeName = '';
      if (t) {
        if (t.path.startsWith('compare://')) modeName = $t('st.mode.compare');
        else if (t.path === 'tail://') modeName = $t('tab.tailboard');
        else
          switch (m) {
            // md 源码即编辑面：显示形态名「源码」而非通用「编辑」（007 v0.15 规则 1：三形态一致）
            case 'edit': modeName = t.language === 'Markdown' ? $t('st.md.source') : $t('st.mode.edit'); break;
            case 'md': modeName = $t('act.mdPreview'); break;
            case 'split': modeName = $t('st.mode.split'); break;
            case 'wysiwyg': modeName = $t('st.mode.wysiwyg'); break;
            case 'csv': modeName = $t('st.mode.csv'); break;
            // 'view' = 流式查看面（>10MB/读取失败兜底）；>10MB md 亦以流式源码呈现
            default: modeName = t.language === 'Markdown' ? $t('st.md.source') : $t('st.mode.text');
          }
      }
      setTxt(modeCell, modeName);
      // 编辑缓冲/即时渲染在场：模式格着强调色 + 圆点（P3 反馈 13 语义沿用；工具栏 editToggle 已随 v2.6 删除）
      // 锁态与工具栏「编辑|只读」段同一事实源（2026-10 反馈）：标签锁/全局只读时不亮「编辑」并显示「只读」。
      const editingNow =
        !!t && (currentView instanceof EditView || currentView instanceof LivePreviewView);
      const locked = editingNow && (settings.readOnlyMode || (t ? tabLock.has(t.path) : false));
      modeCell.classList.toggle('editing', editingNow && !locked && m !== 'md');
      if (locked && m !== 'md') setTxt(modeCell, $t('status.readonly'));
      setTxt(
        posCell,
        m === 'edit' && editStatus
          ? $tf('st.pos.lineCol', editStatus.line, editStatus.col)
          : m === 'wysiwyg'
            ? $tf('st.pos.lineCol', wyPos.line, wyPos.col)
            : viewStatus
              ? $tf('st.pos.line', viewStatus.visibleLine)
              : $t('st.pos.lineCol1')
      );
      // 行尾格（002 规则 4 v1.4）：查看态与编辑态都显示（编辑态来自打开时探测的基线）
      setTxt(nlCell, viewStatus?.newline ?? editStatus?.newline ?? '—');
      // 编码格附 BOM 标记（探测来源 = BOM 即文件带 BOM，）
      const encName = viewStatus?.encoding ?? (t ? encodingByPath.get(t.path) : undefined) ?? 'UTF-8';
      setTxt(encCell, encName + (viewStatus?.encodingSource === 'bom' ? ' ·BOM' : ''));
      // 高亮语言名
      let langName = '—';
      if (t && t.route === 'text') {
        if (currentView instanceof TextView) langName = viewStatus?.language ?? $t('lang.plainText');
        else if (currentView instanceof EditView) {
          const ov = hlOverride.get(t.path);
          langName = ov === '' ? $t('lang.plainText') : ov && ov !== 'auto' ? ov : (t.language ?? $t('lang.plainText'));
        } else langName = t.language ?? $t('lang.plainText');
      }
      setTxt(langCell, langName);
      const mt = t ? fileMtimes.get(t.path) : undefined;
      void mt;
      const size = viewStatus?.size ?? (t ? fileSizes.get(t.path) : undefined) ?? 0;
      setTxt(sizeCell, t ? $tf('st.size', fmtSize(size)) : $t('st.sizeDash'));
      setTxt(wySave, wysiwygDirty ? $t('tab.unsaved') : $t('status.saved'));
      if (wyCount) setTxt(wyCount, $tf('st.mdCount', wyStats.chars, wyStats.lines));
      if (editSel && editStatus) {
        // 005 v2.0：矩形活动时显示尺寸格（N 行 × M 列，行业通行口径）
        setTxt(editSel, editStatus.rect ? $tf('st.rectSize', editStatus.rect.lines, editStatus.rect.cols) : $tf('st.selInfo', editStatus.ranges, editStatus.selChars));
      }
      // 批 B #16：流式查看面矩形尺寸指示（TextViewStatus.rect；与编辑态同口径「N 行 × M 列」）
      if (editSel && !editStatus && viewStatus?.rect) {
        setTxt(editSel, $tf('st.rectSize', viewStatus.rect.lines, viewStatus.rect.cols));
      }
      if (bmCell && viewStatus) setTxt(bmCell, $tf('st.bmInfo', viewStatus.bookmarks.length));
      setTxt(followCell, viewStatus ? (viewStatus.follow ? $t('st.followOn') : $t('st.followOff')) : '');
      if (cmpDiffCell && cmpStatus) setTxt(cmpDiffCell, $tf('cmp.diffCount', cmpStatus.diffs));
      if (tailCell && tailStatus) setTxt(tailCell, $tf('st.tailInfo', tailStatus.sources, tailStatus.rows));
      if (colCell) colCell.classList.toggle('on', editStatus?.columnMode ?? false);
      // 可写灯：绿=可写；黄+「只读」=文件带只读属性；无文件=熄灭
      const readonly = !!t && fileReadonly.has(t.path);
      wrDot.className = `st-led ${!t ? 'off' : readonly ? 'warn' : 'ok'}`;
      setTxt(wrLabel, !t ? '—' : readonly ? $t('st.diskReadonly') : $t('st.diskWritable'));
      wrCell.title = !t
        ? $t('status.noFile')
        : readonly
          ? $t('status.roHint')
          : $t('status.writable');
      // 插入/改写灯：编辑模式下 Insert 键或点击切换；无文件=熄灭
      const overwrite = (m === 'edit' || m === 'split') && (editStatus?.overwrite ?? false);
      insDot.className = `st-led ${!t ? 'off' : overwrite ? 'info' : 'off'}`;
      setTxt(insLabel, !t ? '—' : overwrite ? $t('st.overwrite') : $t('st.insert'));
      if (insCell) {
        insCell.title = overwrite
          ? $t('status.ovwHint')
          : $t('status.insHint');
      }
      // #18：CAPS 灯已移除（仅按键时刷新、无行为联动）
    };
    sbSync();
    // H-2：视图挂载是异步的（currentView 在 mountView 完成时才就位）——状态刷新时同步
    // 刷新工具栏 enabled/checked/上下文段，消除挂载后按钮滞后置灰
    toolbarCtl?.refresh();
  }

  /** 状态栏语言格点击：弹出全部支持的高亮语言（002 规则 6） */
  function onLangCellClick(e: MouseEvent): void {
    const tab = activeTab();
    if (!tab || tab.route !== 'text') return;
    const apply = (v: 'auto' | '' | string): void => {
      hlOverride.set(tab.path, v);
      if (currentView instanceof TextView) currentView.setHighlightLanguage(v === 'auto' ? 'auto' : v);
      else if (currentView instanceof EditView) currentView.setLanguage(v === 'auto' ? tab.language : v === '' ? null : v);
      if (tab.path.startsWith('draft://')) {
        const language = v === '' || v === 'auto' ? null : v;
        if (language !== tab.language) {
          if (language === 'Markdown') modeMap.delete(tab.path);
          else modeMap.set(tab.path, 'edit');
          store.setTabLanguage(tab.path, language);
        }
      }
      renderStatus();
    };
    const cur = hlOverride.get(tab.path) ?? 'auto';
    const items: CtxMenuItem[] = [[`${cur === 'auto' ? '✓ ' : '　'}${$t('lang.auto')}`, () => apply('auto')]];
    for (const lang of HIGHLIGHT_LANGS) items.push([`${cur === lang ? '✓ ' : '　'}${lang}`, () => apply(lang)]);
    items.push([`${cur === '' ? '✓ ' : '　'}${$t('lang.plainShort')}`, () => apply('')]);
    popupAbove(e.currentTarget as HTMLElement, items);
  }

  function onModeCellClick(e?: MouseEvent): void {
    const tab = activeTab();
    if (!tab) return;
    if (isVirtualTab(tab.path)) return; // 伪标签（对比/尾随台）无形态语义，点了不动作（002 规则 7b/30）
    if (tab.language === 'Markdown') {
      // MD 三形态菜单（007 v0.15 规则 1）：与右键「Markdown 模式 ▸」同一构建函数（超限项置灰）
      popupAbove((e?.currentTarget as HTMLElement) ?? modeCellAnchor(), mdModeMenuItems(tab));
      return;
    }
    // v2.6 双模式删除：普通文本无「查看⇄编辑」可切（≤10MB 恒编辑面、>10MB 流式查看面）；
    // 仅 CSV/TSV 保留 源码⇄表格 两态互切（toggleMode 自带双向：csv 态再点回源码）
    if (tab.language === 'CSV' || tab.language === 'TSV') toggleMode('csv');
  }

  /** 无事件时（菜单动作触发）贴状态栏左侧弹出 */
  function modeCellAnchor(): HTMLElement {
    return (statusbar.querySelector('.st-cell.clickable') as HTMLElement) ?? statusbar;
  }

  /** CSV 源码/表格两态互切（001 v2.6：再次点击回源码——≤10MB 即编辑面，>10MB 流式查看面） */
  function toggleMode(m: 'csv'): void {
    const tab = store.active();
    if (!tab) return;
    if (modeOf(tab) === m) {
      setMode(tab, tab.path.startsWith('draft://') || (fileSizes.get(tab.path) ?? 0) <= EDIT_LIMIT ? 'edit' : 'view');
    } else {
      setMode(tab, m);
    }
  }

  /** IR 内 Ctrl+F（007 v0.16 规则 20）：就地查找——live preview 引擎自带 FindBar，
   *  切源码 workaround 废止；带选词回填。挂载竞态（异步 mount 未就位）1s 内重试。 */
  function irFind(): void {
    const seed = (document.getSelection()?.toString() ?? '').slice(0, 200);
    const tryOpen = (): void => {
      if (currentView instanceof LivePreviewView) {
        currentView.openFindBar(seed || undefined);
        return;
      }
    };
    tryOpen();
    // 视图未就位时短暂重试（与旧实现的挂载竞态口径同源；CM6 挂载快，1 次 200ms 足够）
    if (!(currentView instanceof LivePreviewView)) setTimeout(tryOpen, 200);
  }

  /** 切换编码（002 规则 1：手动覆盖仅本标签）。
   *  TextView 内建重读（view.ts setEncoding 清缓存重取）；EditView / LivePreviewView 无重读能力——
   *  经「哨兵重挂」整读（挂载走 currentEncoding → encodingByPath），脏缓冲先确认丢弃（与 F5 同语义）。 */
  function setEncoding(next: string): void {
    const tab = activeTab();
    if (!tab) return;
    // 编码切换：同一字节流按新编码解读，len/newline/totalLines 全变——text_open 备忘作废；
    // 旧解码的跨形态缓冲（editorBuffers）与恢复挂起（recoveryPending）不得跨编码复活，
    // 否则哨兵重挂带回乱码旧缓冲（F5 重载同款清理，2026-10 修复）
    textOpenMemoInvalidate(tab.path);
    editorBuffers.delete(tab.path);
    recoveryPending.delete(tab.path);
    if (currentView instanceof TextView) {
      currentView.setEncoding(next);
      encodingByPath.set(tab.path, next);
      renderStatus();
      return;
    }
    if (!(currentView instanceof EditView) && !(currentView instanceof LivePreviewView)) return;
    const remount = (): void => {
      encodingByPath.set(tab.path, next);
      currentViewKey = '\u0000enc'; // 哨兵：强制按新编码重挂（file.reload 同机制）
      render();
    };
    if (dirtyPaths.get(tab.path) === true) {
      void dlgConfirm($t('msg.reloadDirtyConfirm')).then(ok => {
        if (ok) remount();
      });
      return;
    }
    remount();
  }

  function toggleFollow(): void {
    const view = currentView;
    if (view instanceof TextView) view.toggleFollow();
  }

  // ---- 动作注册表（菜单/工具栏/命令面板/快捷键同源，001 规则 22） ----
  const reg = new ActionRegistry();
  const registerAction = reg.add.bind(reg);
  // 所有可改文档/写原文件的动作共享权限判定，菜单、工具栏、命令面板和快捷键同源。
  reg.add = def => {
    if (def.id === 'file.saveAs' || def.id === 'tbcsv.delim') {
      const enabled = def.enabled;
      def.enabled = () => enabled?.() !== false && !['Docx', 'Xlsx', 'Pdf'].includes(activeTab()?.language ?? '');
    }
    if (/^(?:edit\.(?:undo|redo|cut|paste|format|column|lineBatch|normalize|nlSave|encSave)|find\.(?:replace|batchReplace)|tbmd\.(?:headings|bold|italic|strike|inlineCode|codeBlock|link|table)|file\.save$)/.test(def.id)) {
      const enabled = def.enabled;
      def.enabled = () => enabled?.() !== false && !settings.readOnlyMode
        && !['Docx', 'Xlsx', 'Pdf'].includes(activeTab()?.language ?? '')
        && (def.id === 'file.save' || !activeTab() || modeOf(activeTab()!) !== 'md');
    }
    registerAction(def);
  };
  const isEditActive = () => currentView instanceof EditView && activeTab() != null && modeOf(activeTab()!) !== 'md';
  const isTextActive = () => activeTab()?.route === 'text';
  reg.add({ id: 'view.outline', label: 'act.outline', group: 'view', run: () => sidebarCtl.show(sidebarCtl.isOutlineShown() ? 'files' : 'outline') });
  reg.add({ id: 'nav.prevBookmark', label: 'act.prevBookmark', group: 'view', enabled: () => currentView instanceof EditView || currentView instanceof TextView, run: () => { if (currentView instanceof EditView || currentView instanceof TextView) currentView.prevBookmark(); } });
  reg.add({ id: 'nav.nextBookmark', label: 'act.nextBookmark', group: 'view', enabled: () => currentView instanceof EditView || currentView instanceof TextView, run: () => { if (currentView instanceof EditView || currentView instanceof TextView) currentView.nextBookmark(); } });
  /** IR（即时渲染）承载中：编辑类动作就地承载（CM6 live preview），不跨形态进源码编辑态（H-6） */
  const isIrActive = () => currentView instanceof LivePreviewView;
  /** 比较视图在场且有差异（差异步进键位放行判决，008 规则 14 无差异即禁用） */
  const hasDiffs = () => !!cmpView && cmpView.diffCount() > 0;
  const isMdActive = () => {
    const t = activeTab();
    return !!t && t.route === 'text' && t.language === 'Markdown' && !t.path.startsWith('compare://');
  };
  const mdMode = (m: ViewMode): void => {
    const t = activeTab();
    if (!t) return;
    setMode(t, m);
  };

  reg.add({ id: 'file.newDraft', label: 'act.newDraft', shortcut: 'Ctrl+N', group: 'file', icon: 'newFile', tint: 'blue', run: () => newDraft() });
  reg.add({
    id: 'file.openFile', label: 'act.openFile', shortcut: 'Ctrl+O', group: 'file', icon: 'open', tint: 'amber',
    run: () => void openDialog({ multiple: true }).then(paths => {
      for (const p of paths ?? []) void openPath(p);
    }),
  });
  reg.add({
    id: 'file.openFolder', label: 'act.openFolder', shortcut: 'Ctrl+Shift+O', group: 'file', icon: 'folder',
    run: () => void openDialog({ directory: true }).then(path => {
      if (path) void openPath(path, undefined, true);
    }),
  });
  reg.add({
    id: 'file.compare', label: 'act.compare', group: 'file', icon: 'replace',
    run: () => {
      void openDialog({ multiple: true }).then(async paths => {
        let [a, b] = (paths ?? []) as (string | null)[];
        if (!a) return;
        if (!b) {
          b = ((await openDialog({ multiple: false })) as string | null) ?? null;
          if (!b) return;
        }
        openCompare(a, b);
      });
    },
  });
  function openCompare(a: string, b: string): void {
    store.open({
      path: `compare://${encodeURIComponent(a)}|${encodeURIComponent(b)}`,
      route: 'text',
      language: null,
      scroll: 0,
      bookmarks: [],
    });
    render();
  }
  reg.add({
    id: 'file.saveSession', label: 'act.saveSession', group: 'file',
    run: () => void dlgPrompt($t('prompt.sessionName')).then(async name => {
      if (!name) return;
      const next = { ...namedSessions, [name]: captureDrafts(store.session()) };
      try {
        await namedSessionsSave(next);
        namedSessions = next;
        // 菜单按名称列举，但未知动作会被略过；保存成功必须同步注册新名称。
        registerSessionActions();
      } catch (err) {
        void dlgAlert($tf('err.saveFail', String(err)));
      }
    }),
  });
  reg.add({
    id: 'file.save', label: 'act.save', shortcut: 'Ctrl+S', group: 'file', icon: 'save', tint: 'violet',
    enabled: () => {
      const t = activeTab();
      return !!t && t.route === 'text' && !isVirtualTab(t.path);
    },
    run: () => {
      if (currentView instanceof EditView) currentView.requestSave();
      else if (currentView instanceof LivePreviewView) void currentView.save();
      else flash($t('msg.noDirtyInView'));
    },
  });
  reg.add({
    id: 'file.saveAs', label: 'act.saveAs', shortcut: 'Ctrl+Shift+S', group: 'file', icon: 'saveAs', tint: 'slate',
    enabled: () => {
      const t = activeTab();
      // 草稿与 file.save 同口径放行（草稿的「保存」本就是另存）；对比/尾随台伪标签仍禁用
      return !!t && t.route === 'text' && !isVirtualTab(t.path);
    },
    run: () => {
      const tab = activeTab();
      if (!tab) return;
      if (tab.path.startsWith('draft://')) {
        // 草稿：与 Ctrl+S 同一收口——saveDraftAs（默认扩展名随语言，成功后标签关联新文件并关草稿）
        const content = currentView instanceof EditView ? currentView.getContent()
          : currentView instanceof LivePreviewView ? currentView.getContent() : '';
        void saveDraftAs(content, tab.path);
        return;
      }
      if (currentView instanceof EditView) {
        void saveTextAs(currentView.getContent(), activeName() ?? 'untitled.txt', 'UTF-8');
        return;
      }
      // 查看模式直接另存：整读 → 另存对话框
      void (async () => {
        try {
          const raw = await textReadAll(tab.path, await currentEncoding(tab.path));
          await saveTextAs(raw, activeName() ?? 'untitled.txt', await currentEncoding(tab.path));
        } catch (err) {
          dlgAlert($tf('err.saveAsFail', String(err)));
        }
      })();
    },
  });
  reg.add({
    id: 'file.closeTab', label: 'act.closeTab', shortcut: 'Ctrl+W', group: 'file', enabled: () => store.tabs.length > 0,
    run: () => closeTabGuarded(store.activeIndex),
  });
  // H-3：关闭全部（Ctrl+Shift+W；脏标签逐个走关闭守卫）
  reg.add({
    id: 'file.closeAll', label: 'act.closeAllTabs', shortcut: 'Ctrl+Shift+W', group: 'file', enabled: () => store.tabs.length > 0,
    run: () => closeAllTabs(),
  });
  // H-5 T8：重开最近关闭（表驱动派发注册）
  reg.add({
    id: 'file.reopen', label: 'act.reopenTab', shortcut: 'Ctrl+Shift+T', group: 'file',
    run: () => reopenClosedTab(),
  });
  // ---- 文件重载（001 规则 29：F5 手动 + 活动标签 mtime 轮询自动检测） ----
  const extModified = new Set<string>(); // 外部已修改但缓冲脏着的路径（状态栏提示格）
  const deletedPaths = new Set<string>(); // 文件已不在（外部删除/移走）的路径（规则 7 标记；F001-03）
  function reloadActiveTab(): void {
    const tab = activeTab();
    if (!tab || !isRealFilePath(tab.path)) return;
    editorBuffers.delete(tab.path);
    recoveryPending.delete(tab.path);
    extModified.delete(tab.path);
    deletedPaths.delete(tab.path); // F5 重载即重探：文件回来则正常载入，仍在则轮询重新标记
    // H3 修复：重挂前先让后端换缓存重建索引（text_refresh 变更时后台重建并发 text-index 事件），
    // 否则 ensure_open 复用旧缓存，"重载"仍显示旧内容
    textOpenMemoInvalidate(tab.path); // 外部修改重载：备忘的 text_open 元数据（长度/行尾）作废
    encodingByPath.delete(tab.path); // F5（审计）：F5 即重探编码——外部把文件改存为其他编码后不再按旧码解码
    void textRefresh(tab.path)
      .catch(() => void 0)
      .finally(() => {
        currentViewKey = '\u0000reload'; // 哨兵：强制重挂当前视图（重读文件）
        render();
      });
  }
  reg.add({
    id: 'file.reload', label: 'act.reload', shortcut: 'F5', group: 'file',
    enabled: () => {
      const t = activeTab();
      return !!t && isRealFilePath(t.path);
    },
    run: () => {
      const t = activeTab();
      if (!t) return;
      if (dirtyPaths.get(t.path) === true) {
        void dlgConfirm($t('msg.reloadDirtyConfirm')).then(ok => {
          if (ok) reloadActiveTab();
        });
        return;
      }
      reloadActiveTab();
    },
  });
  // 外部修改轮询（2 秒；跟随模式有自己的增量刷新，跳过；脏缓冲只标提示不覆盖）
  setInterval(() => {
    const tab = activeTab();
    if (!tab || !isRealFilePath(tab.path) || extModified.has(tab.path) || deletedPaths.has(tab.path)) return;
    if (viewStatus?.follow) return; // TailMode 自己管重载
    void fileStat(tab.path)
      .then(st => {
        const known = fileMtimes.get(tab.path);
        if (!known) return; // 元信息未就绪：交给 ensureFileMeta，勿在此抢先
        // 变更判定同时看大小：mtime 粒度粗的盘（FAT/exFAT、网络盘、部分按秒取整）会把同一刻度内的
        // 两次写入报成同一 mtime，只看 mtime 会永久漏掉这次外部修改（内容与大小格都停在旧值）。
        const knownSize = fileSizes.get(tab.path);
        if (st.modifiedMs <= known && (knownSize === undefined || st.len === knownSize)) return;
        fileMtimes.set(tab.path, st.modifiedMs);
        fileSizes.set(tab.path, st.len);
        if (dirtyPaths.get(tab.path) === true) {
          extModified.add(tab.path);
          renderStatus();
          renderTabs(); // 悬停里的修改时间/大小同上（干净分支走 reloadActiveTab → render 已覆盖）
        } else {
          reloadActiveTab();
          flash($t('msg.reloaded'));
        }
      })
      .catch(() => {
        // F001-03（审计 db528fd，规则 7/29）：fileStat 失败 = 文件已不在（外部删除/移走）。
        // 修前注释称"走既有提示机制"实则不存在——外部删除零提示零标记，catch 整段吞掉。
        // 标记一次 + 提示一次；F5/重新打开/保存成功都会清标记重探。
        if (!deletedPaths.has(tab.path)) {
          deletedPaths.add(tab.path);
          renderStatus();
          renderTabs();
          flash($t('msg.fileDeleted'));
        }
      });
  }, 2000);
  // ---- 字号缩放（001 规则 31：10–18，Ctrl+滚轮 / Ctrl+=/-/0，两态一致，持久化） ----
  // C-2 字号控件组（#15/#22 步进式）：工具栏数字输入 + ± 步进，与 Ctrl+滚轮/菜单三入口同源
  let fsInputEl: HTMLInputElement | null = null;
  function syncFsWidget(): void {
    if (fsInputEl && fsInputEl.value !== String(settings.fontSize ?? 12)) fsInputEl.value = String(settings.fontSize ?? 12);
  }

  /** Markdown 正文字号跟随（007 规则 20 v2.1，2026-10 用户定稿）：--md-fs-base 由用户字号派生
   *  （12=13.5px 出厂基准，线性缩放），预览/IR/分屏三形态共用；块间距等排版令牌全部
   *  calc(var(--md-fs-base) * 系数) 派生（styles.css），一次变量整体等比缩放。 */
  function syncMdFontSize(): void {
    const fs = settings.fontSize ?? 12;
    document.documentElement.style.setProperty('--md-fs-user', `${(13.5 * fs) / 12}px`);
  }

  function applyFontSize(n: number): void {
    const v = Math.min(18, Math.max(10, Math.round(n)));
    syncFsWidget();
    if (v === settings.fontSize) return;
    settings = { ...settings, fontSize: v };
    void settingsSave(settings as Record<string, unknown>);
    syncFsWidget();
    if (currentView instanceof TextView) currentView.setFontSize(v);
    else if (currentView instanceof EditView) currentView.setFontSize(v);
    // v2.5 扩面（001 规则 31）：对比（行距派生）/ CSV 表格（行高派生）接线；
    // Markdown 渲染正文同步跟随（007 规则 20 v2.1：--md-fs-user 派生 --md-fs-base，三形态一致缩放）
    if (currentView instanceof CompareView) currentView.setFontSize(v);
    else if (currentView instanceof CsvView) currentView.setFontSize(v);
    syncMdFontSize();
    updateMarkers(); // 列标记/标尺随字符宽联动
  }

  // C-3 字体族（#22）：捆绑 JetBrains Mono（出厂）/ 本地导入（FontFace 会话注册，启动按路径重注册）
  const LOCAL_FONT_FAMILY = 'ZiEdit Local';
  async function registerLocalFont(path: string): Promise<boolean> {
    try {
      const b64 = await fontRead(path);
      const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const face = new FontFace(LOCAL_FONT_FAMILY, bin.buffer as ArrayBuffer);
      await face.load();
      document.fonts.add(face);
      return true;
    } catch (err) {
      flash($tf('font.loadFail', String(err)));
      return false;
    }
  }

  function applyEditorFontOverride(): void {
    const head = settings.editorFont === 'local' ? `'${LOCAL_FONT_FAMILY}',` : '';
    document.documentElement.style.setProperty(
      '--mono',
      `${head}'JetBrains Mono','Cascadia Code','SF Mono',ui-monospace,Menlo,Consolas,monospace`
    );
  }

  /** 差异配色自定义（批 F #21：覆盖 --diff-* 令牌；空值回退主题默认） */
  function applyDiffColorOverride(): void {
    const root = document.documentElement;
    const d = settings.diffColors;
    for (const [k, v] of [['add', d?.add], ['del', d?.del], ['chg', d?.chg]] as const) {
      if (v) root.style.setProperty(`--diff-${k}`, v);
      else root.style.removeProperty(`--diff-${k}`);
    }
  }

  /** 大纲当前符号高亮色（批 G：覆盖 --outline-cur 令牌；空值回退主题默认） */
  function applyOutlineColorOverride(): void {
    if (settings.outlineCur) document.documentElement.style.setProperty('--outline-cur', settings.outlineCur);
    else document.documentElement.style.removeProperty('--outline-cur');
  }

  /** 当前行高亮色（P3，反馈 14：编辑态 CM 活动行底色 --line-hl 令牌覆盖；空值回退主题默认）。
   *  修前该颜色是主题定值不可调，而设置里唯一沾「高亮色」的大纲项改的是侧栏面板条目色——
   *  用户想调正文那行却调不到、调了还回不去；本次两项拆开命名，取消勾选即恢复默认。 */
  function applyLineHlOverride(): void {
    if (settings.lineHl) document.documentElement.style.setProperty('--line-hl', settings.lineHl);
    else document.documentElement.style.removeProperty('--line-hl');
  }

  async function importLocalFont(): Promise<void> {
    const p = (await openDialog({
      multiple: false,
      filters: [{ name: 'Font', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
    })) as string | null;
    if (!p) return;
    if (await registerLocalFont(p)) {
      settings = { ...settings, editorFont: 'local', localFontPath: p };
      void settingsSave(settings as Record<string, unknown>);
      applyEditorFontOverride();
      flash($t('font.imported'));
    }
  }
  reg.add({ id: 'view.zoomIn', label: 'act.zoomIn', shortcut: 'Ctrl+=', group: 'view', enabled: () => !!activeTab(), run: () => applyFontSize((settings.fontSize ?? 12) + 1) });
  reg.add({ id: 'view.zoomOut', label: 'act.zoomOut', shortcut: 'Ctrl+-', group: 'view', enabled: () => !!activeTab(), run: () => applyFontSize((settings.fontSize ?? 12) - 1) });
  reg.add({ id: 'view.zoomReset', label: 'act.zoomReset', shortcut: 'Ctrl+0', group: 'view', enabled: () => !!activeTab(), run: () => applyFontSize(12) });
  reg.add({ id: 'view.font', label: 'act.font', group: 'view', icon: 'font', tint: 'slate', enabled: () => !isMdActive(), run: () => openFontPopover() });
  // 比较视图差异步进（008 规则 14 v0.4；键位与视图内 ◀/▶ 提示同源 NAV_SHORTCUTS）。
  // 与文本视图点击历史（view.ts 内 Alt+←/→ 局部绑定）互斥：两视图不共存，且文本视图
  // 命中时已 preventDefault（ActionRegistry 对已消费事件短路）。
  reg.add({ id: 'view.prevDiff', label: 'cmp.navPrev', shortcut: NAV_SHORTCUTS.prev, group: 'view', enabled: hasDiffs, run: () => cmpView?.stepDiff(-1) });
  reg.add({ id: 'view.nextDiff', label: 'cmp.navNext', shortcut: NAV_SHORTCUTS.next, group: 'view', enabled: hasDiffs, run: () => cmpView?.stepDiff(1) });
  reg.add({
    id: 'file.exit', label: 'act.exit', shortcut: 'Alt+F4', group: 'file',
    run: () => void (async () => {
      if (!('__TAURI_INTERNALS__' in window)) return;
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    })(),
  });
  // 编辑组（工具栏不再灰着没反应：查看模式下点击自动进入编辑并执行，002 增补）
  // H-6：IR 态不得被编辑动作拖去源码编辑态——撤销/重做走 CM6 history；
  // IR 剪切/粘贴就地操作 CM6 选区；全选仍由编辑器键位承载。
  const hasHistory = (redo = false): boolean => {
    if (activeTab() && modeOf(activeTab()!) === 'md') return false;
    const view = currentView instanceof EditView || currentView instanceof LivePreviewView ? currentView.view : null;
    return !!view && (redo ? redoDepth(view.state) : undoDepth(view.state)) > 0;
  };
  reg.add({ id: 'edit.undo', label: 'act.undo', shortcut: 'Ctrl+Z', group: 'edit', icon: 'undo', tint: 'teal', enabled: () => hasHistory(), run: () => withEdit(v => v.cmUndo(), 'undo') });
  reg.add({ id: 'edit.redo', label: 'act.redo', shortcut: 'Ctrl+Y', group: 'edit', icon: 'redo', tint: 'teal', enabled: () => hasHistory(true), run: () => withEdit(v => v.cmRedo(), 'redo') });
  reg.add({ id: 'edit.redoShift', label: 'act.redo', shortcut: 'Ctrl+Shift+Z', group: 'edit', enabled: () => hasHistory(true), run: () => reg.run('edit.redo') });
  reg.add({ id: 'edit.cut', label: 'act.cut', shortcut: 'Ctrl+X', group: 'edit', icon: 'cut', tint: 'slate', enabled: () => isTextActive() && modeOf(activeTab()!) !== 'md', run: () => currentView instanceof LivePreviewView ? currentView.cmCut() : withEdit(v => v.cmCut()) });
  reg.add({
    id: 'edit.copy', label: 'act.copy', shortcut: 'Ctrl+C', group: 'edit', icon: 'copy', tint: 'blue', enabled: isTextActive,
    run: () => {
      // 查看态矩形选区优先（005 规则 13）；其次原生选区；否则进编辑复制 CM 选区
      if (currentView instanceof TextView && currentView.hasRectSelection()) {
        void currentView.rectCopyText().then(rt => {
          if (rt != null) void writeClipboardText(rt);
        });
        return;
      }
      const sel = document.getSelection()?.toString() ?? '';
      if (!isEditActive() && sel) {
        void writeClipboardText(sel);
        return;
      }
      if (currentView instanceof LivePreviewView) {
        const view = currentView.view;
        void writeClipboardText(view.state.selection.ranges.map(r => view.state.sliceDoc(r.from, r.to)).join('\n'));
      } else withEdit(v => v.cmCopy());
    },
  });
  reg.add({ id: 'edit.paste', label: 'act.paste', shortcut: 'Ctrl+V', group: 'edit', icon: 'paste', tint: 'amber', enabled: () => isTextActive() && modeOf(activeTab()!) !== 'md', run: () => currentView instanceof LivePreviewView ? currentView.cmPaste() : withEdit(v => v.cmPaste()) });
  reg.add({ id: 'edit.selectAll', label: 'act.selectAll', shortcut: 'Ctrl+A', group: 'edit', enabled: () => isTextActive() && !isIrActive(), run: () => previewFind ? previewFind.selectAll() : withEdit(v => v.cmSelectAll()) });
  reg.add({
    id: 'edit.column', label: 'act.column', short: 'tb.column', shortcut: 'Alt+C', group: 'edit', icon: 'column', tint: 'blue',
    checked: () => editStatus?.columnMode ?? false,
    enabled: () => isTextActive() && modeOf(activeTab()!) !== 'wysiwyg', // 005 规则 12：WYSIWYG 下列模式入口置灰
    run: () => withEdit(v => v.toggleColumnMode()),
  });
  reg.add({
    id: 'edit.format', label: 'act.format', shortcut: 'Ctrl+Shift+J', group: 'edit', icon: 'format', tint: 'teal',
    enabled: () => {
      const t = activeTab();
      // 批 D-2 守卫：>10MB 不整读格式化（性能红线）
      return (
        !!t &&
        (t.language === 'JSON' || t.language === 'XML') &&
        !t.path.startsWith('draft://') &&
        (fileSizes.get(t.path) ?? 0) <= 10 * 1024 * 1024
      );
    },
    run: () => {
      const tab = activeTab();
      if (!tab || tab.path.startsWith('draft://')) return;
      void (async () => {
        try {
          // 批 D-2：编辑态就地格式化（单次 dispatch = 单步撤销）；查看态格式化为草稿
          if (currentView instanceof EditView) {
            const raw = currentView.getContent();
            const pretty = tab.language === 'JSON' ? await formatJson(raw) : await formatXml(raw);
            if (!currentView.applyFormatted(pretty)) return;
            flash($t('msg.formatDone'));
            return;
          }
          const raw = await textReadAll(tab.path, await currentEncoding(tab.path));
          const pretty = tab.language === 'JSON' ? await formatJson(raw) : await formatXml(raw);
          newDraft(pretty);
        } catch (err) {
          // 格式错误行内提示：serde 错误串自带行列信息，直接透出
          flash($tf('err.formatFail', String(err)));
        }
      })();
    },
  });
  // 换行转换另存（002 规则 21 v1.3：单一对话框入口；状态栏快项与标签右键复用同一实现）
  async function nlConvertSave(path: string, id: NlId): Promise<void> {
    try {
      const enc = await currentEncoding(path);
      const raw = await textReadAll(path, enc);
      const preset = NL_PRESETS.find(p => p.id === id)!;
      await saveTextAs(convertEol(raw, preset.seq), nlSaveName(path, id), enc);
    } catch (err) {
      dlgAlert($tf('err.nlSaveFail', String(err)));
    }
  }
  function openNlConvertDialog(path?: string): void {
    const p = path ?? activeTab()?.path;
    if (!p || p.startsWith('draft://')) return;
    const body = document.createElement('div');
    body.className = 'ov-body';
    const row = document.createElement('label');
    row.className = 'set-row';
    const sel = document.createElement('select');
    for (const preset of NL_PRESETS) {
      const o = document.createElement('option');
      o.value = preset.id;
      o.textContent = `${preset.id}（${preset.suffix}）`;
      sel.appendChild(o);
    }
    sel.value = 'LF';
    row.append(document.createTextNode($t('nlDialog.target')), sel);
    const btn = document.createElement('button');
    btn.className = 'dlg-btn primary';
    btn.textContent = $t('cmp.saveAsNew');
    let dlgMask: OverlayMask | null = null;
    btn.addEventListener('click', () => {
      dlgMask?.close();
      void nlConvertSave(p, sel.value as NlId);
    });
    body.append(row, btn);
    dlgMask = overlayDialog($t('nlDialog.title'), body, () => void 0);
    document.body.appendChild(dlgMask);
  }
  reg.add({
    id: 'edit.nlSave', label: 'act.nlSave', group: 'edit', icon: 'swap',
    enabled: () => {
      const t = activeTab();
      return !!t && t.route === 'text' && !t.path.startsWith('draft://');
    },
    run: () => openNlConvertDialog(),
  });
  // 行批处理（005 规则 14 v1.0：编辑菜单"行批处理 ▸"，选区行或全文；原悬浮工具条项迁移）
  const LINE_BATCH: Array<{ id: string; label: string; op: LineBatchOp }> = [
    { id: 'edit.lineBatch.sort', label: 'ed.sort', op: 'sort' },
    { id: 'edit.lineBatch.dedupe', label: 'ed.dedupe', op: 'dedupe' },
    { id: 'edit.lineBatch.removeEmpty', label: 'ed.removeEmpty', op: 'removeEmpty' },
    { id: 'edit.lineBatch.trim', label: 'ed.trim', op: 'trim' },
    { id: 'edit.lineBatch.tabsToSpaces', label: 'ed.tabsToSpaces', op: 'tabsToSpaces' },
    { id: 'edit.lineBatch.spacesToTabs', label: 'ed.spacesToTabs', op: 'spacesToTabs' },
  ];
  for (const b of LINE_BATCH) {
    // 行批处理（005 规则 14 v1.4；H-3 适用矩阵）：Markdown 与结构化格式（JSON/XML/CSV/TSV）
    // 不启用——排序/去重会破坏对象键序与表头；判决收口 lineBatchAllowed（与两处右键菜单同源，H-6d）
    reg.add({
      id: b.id, label: b.label, group: 'edit',
      enabled: () => isEditActive() && lineBatchAllowed(activeTab()?.language ?? null),
      run: () => withEdit(v => v.lineBatch(b.op)),
    });
  }
  reg.add({
    id: 'find.find', label: 'act.find', shortcut: 'Ctrl+F', group: 'find', icon: 'find', tint: 'teal',
    enabled: isTextActive,
    run: () => {
      const v = currentView;
      if (previewFind) previewFind.show();
      else if (v instanceof TextView) v.openFindBar();
      else if (v instanceof EditView) v.openFindBar();
      else if (v instanceof LivePreviewView) v.openFindBar();
      else {
        // 分屏等其余无查找承载面：交 irFind 就地/回退口径
        const tab = activeTab();
        if (tab && tab.route === 'text' && isRealFilePath(tab.path)) irFind();
      }
    },
  });
  reg.add({
    id: 'find.replace', label: 'act.replace', shortcut: 'Ctrl+H', group: 'find', icon: 'replace', tint: 'violet',
    enabled: () => {
      const t = activeTab();
      return !!t && t.route === 'text' && modeOf(t) !== 'view' && isRealFilePath(t.path);
    },
    run: () => {
      // v0.16：IR 态就地替换（FindBar 替换行），源码态仍走 EditView.openReplace
      if (currentView instanceof LivePreviewView) currentView.openFindBar(undefined, true);
      else withEdit(v => v.openReplace());
    },
  });
  // P1-2（002 规则 7 v2.4）：F3/Shift+F3 步进——栏已开步进、未开则打开（编辑态以选词回填）；
  // v0.16：IR 态同样就地步进（live preview 自带 FindBar）。
  reg.add({
    id: 'find.next', label: 'act.findNext', shortcut: 'F3', group: 'find',
    enabled: () => isTextActive(),
    run: () => {
      const v = currentView;
      if (previewFind) previewFind.step(1);
      else if (v instanceof TextView) v.findStep(1);
      else if (v instanceof EditView) v.findStep(1);
      else if (v instanceof LivePreviewView) v.findStep(1);
    },
  });
  reg.add({
    id: 'find.prev', label: 'act.findPrev', shortcut: 'Shift+F3', group: 'find',
    enabled: () => isTextActive(),
    run: () => {
      const v = currentView;
      if (previewFind) previewFind.step(-1);
      else if (v instanceof TextView) v.findStep(-1);
      else if (v instanceof EditView) v.findStep(-1);
      else if (v instanceof LivePreviewView) v.findStep(-1);
    },
  });

  // 列表批量替换（002 规则 28）：两列成对、按序执行
  function openBatchReplace(): void {
    const body = document.createElement('div');
    body.className = 'ov-body';
    const ta = document.createElement('textarea');
    ta.className = 'dlg-input';
    ta.style.cssText = 'height:180px;resize:vertical;font-family:Consolas,monospace';
    ta.placeholder = $t('br.placeholder');
    const rowOpt = document.createElement('div');
    rowOpt.style.cssText = 'display:flex;gap:12px;align-items:center;margin:8px 0';
    const mkCb = (label: string) => {
      const lab = document.createElement('label');
      lab.style.cssText = 'display:flex;gap:4px;align-items:center;font-size:12px';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      lab.append(cb, document.createTextNode(label));
      rowOpt.appendChild(lab);
      return cb;
    };
    const cbCase = mkCb($t('find.case'));
    const cbWord = mkCb($t('find.word'));
    const cbRe = mkCb($t('find.regex'));
    const note = document.createElement('span');
    note.style.cssText = 'font-size:12px;color:var(--muted);margin-left:auto';
    const rowBtn = document.createElement('div');
    rowBtn.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const closeB = document.createElement('button');
    closeB.className = 'dlg-btn';
    closeB.textContent = $t('common.close');
    let dlgMask: OverlayMask | null = null;
    closeB.addEventListener('click', () => dlgMask?.close());
    const runB = document.createElement('button');
    runB.className = 'dlg-btn primary';
    runB.textContent = $t('br.run');
    runB.addEventListener('click', () => {
      if (!(currentView instanceof EditView)) return;
      const total = currentView.applyBatchReplace(ta.value, {
        caseSensitive: cbCase.checked,
        wholeWord: cbWord.checked,
        regex: cbRe.checked,
      });
      flash($tf('br.done', total));
      dlgMask?.close();
    });
    rowBtn.append(closeB, runB);
    body.append(ta, rowOpt, rowBtn, note);
    dlgMask = overlayDialog($t('br.title'), body, () => void 0);
    document.body.appendChild(dlgMask);
  }

  reg.add({
    id: 'find.batchReplace', label: 'act.batchReplace', group: 'find', icon: 'replace',
    enabled: () => {
      const t = activeTab();
      return !!t && t.route === 'text' && isRealFilePath(t.path);
    },
    run: () => withEdit(() => openBatchReplace()),
  });
  reg.add({
    id: 'find.goto', label: 'act.goto', shortcut: 'Ctrl+G', group: 'find', icon: 'goto', tint: 'green', enabled: () => isTextActive() && (currentView instanceof TextView || currentView instanceof EditView || currentView instanceof LivePreviewView),
    run: () => {
      const tv = currentView;
      if (tv instanceof TextView) {
        tv.openGotoBar();
      } else if (tv instanceof EditView || tv instanceof LivePreviewView) {
        void dlgPrompt($t('prompt.gotoLine')).then(v => {
          const n = parseInt(v ?? '', 10);
          if (Number.isFinite(n) && n >= 1 && currentView === tv) {
            if (activeTab() && modeOf(activeTab()!) === 'md' && previewHostEl) {
              previewAnchorBefore(previewHostEl, n - 1)?.scrollIntoView({ block: 'start' });
            } else tv.goToLine(n);
          }
        });
      }
    },
  });
  reg.add({
    id: 'find.findInFiles', label: 'act.findInFiles', shortcut: 'Ctrl+Shift+F', group: 'find',
    run: () => {
      const tab = activeTab();
      const root = tab && isRealFilePath(tab.path) ? dirOf(tab.path) : (localRoot ?? homeDirCached);
      void ensurePanels().then(m => {
        const panel = m.findInFilesPanel(root, (p, l) => void openPath(p, l));
        document.body.appendChild(overlayDialog($t('fif.title'), panel, () => panel.dispose()));
      });
    },
  });
  reg.add({
    id: 'view.text', label: 'act.textView', short: 'tb.text', group: 'view', icon: 'text', tint: 'blue', checked: isTextActive,
    enabled: () => {
      const t = activeTab();
      return !!t && isRealFilePath(t.path);
    },
    run: () => {
      const t = activeTab();
      if (t && isRealFilePath(t.path)) store.setRoute(t.path, 'text');
    },
  });
  /** 「可编辑面」的视图类型判定（供 enabled 与非 Markdown 的选中态使用）：
   *  EditView（源码/分屏/文本/渲染预览的隐藏源承载）与 LivePreviewView（即时渲染）。
   *  注意：渲染预览（mode 'md'）虽挂隐藏 EditView，但用户无可编辑面——选中态判定用 editLit。 */
  const editableSurface = (): boolean =>
    currentView instanceof EditView || currentView instanceof LivePreviewView;
  /** 编辑|只读 段定稿语义（2026-10 用户定稿）：分段控件 = 文件当前形态的可编辑性，点哪边切到哪边形态。
   *  Markdown：源码/分屏/即时渲染 =「编辑」亮；渲染预览 =「只读」亮——点「编辑」切源码，
   *  点「只读」切渲染预览（超 2MB 无预览则回退会话级编辑锁）。渲染预览内部虽挂隐藏 EditView
   *  承载保存/脏标（mode 'md' 挂载分支），但那不是用户可编辑面，不得点亮「编辑」。
   *  非 Markdown：可编辑面 =「编辑」；流式查看/表格/图片等 =「只读」，点「只读」=会话级锁（按路径独立）。 */
  const isMdFile = (t: TabState): boolean =>
    t.route === 'text' && t.language === 'Markdown' && !t.path.startsWith('compare://');
  const editLit = (t: TabState): boolean => {
    if (tabLock.has(t.path)) return false;
    return isMdFile(t) ? modeOf(t) !== 'md' : editableSurface();
  };
  const applyTabLock = (locked: boolean) => {
    const t = activeTab();
    if (!t) return;
    if (locked) tabLock.add(t.path);
    else tabLock.delete(t.path);
    if (currentView instanceof EditView || currentView instanceof LivePreviewView) currentView.setReadOnly(locked);
    sbLayoutKey = '\u0000readonly'; renderStatus();
    toolbarCtl?.refresh();
  };
  reg.add({ id: 'view.tabEdit', label: 'tb.tabEdit', short: 'tb.tabEdit', group: 'view', checked: () => { const t = activeTab(); return !!t && editLit(t); }, enabled: () => !!activeTab() && settings.readOnlyMode !== true && (editableSurface() || modeOf(activeTab()!) === 'md'), run: () => {
    const t = activeTab();
    if (!t) return;
    // 渲染预览形态没有可编辑面：「编辑」= 开始编辑 → 解锁并切源码视图（即时渲染是编辑器，原地解锁即可）
    if (t.route === 'text' && modeOf(t) === 'md') { applyTabLock(false); setMode(t, 'edit'); return; }
    applyTabLock(false);
  } });
  reg.add({ id: 'view.tabLock', label: 'tb.readOnly', short: 'tb.readOnly', group: 'view', checked: () => { const t = activeTab(); return !!t && !editLit(t); }, enabled: () => !!activeTab() && settings.readOnlyMode !== true, run: () => {
    const t = activeTab();
    if (!t) return;
    // Markdown 有预览资格时「只读」= 切渲染预览（与「编辑」=切源码对称：形态即状态）
    if (isMdFile(t) && mdSplitEligible(t)) {
      if (modeOf(t) !== 'md') setMode(t, 'md');
      return;
    }
    applyTabLock(true); // 非 Markdown / 超限无预览：会话级编辑锁
  } });
  reg.add({
    id: 'view.readOnly', label: 'set.readOnlyMode', short: 'tb.readOnly', group: 'view',
    checked: () => settings.readOnlyMode === true,
    enabled: () => !!activeTab(),
    run: () => {
      const readOnlyMode = !settings.readOnlyMode;
      settings = { ...settings, readOnlyMode };
      if (currentView instanceof EditView || currentView instanceof LivePreviewView) currentView.setReadOnly(readOnlyMode);
      void settingsSave(settings as Record<string, unknown>);
      sbLayoutKey = '\u0000readonly'; renderStatus();
      toolbarCtl?.refresh();
    },
  });
  // Markdown 三形态（007 v0.15：源码即编辑面 / 分屏预览 / 即时渲染；独立渲染预览已删；
  // 视图菜单收敛为「Markdown ▸」子菜单，分屏与 IR 超 2MB 置灰——与右键/状态栏同一闸）
  reg.add({ id: 'view.mdSource', label: 'act.mdSource', group: 'view', icon: 'mdSource', checked: () => isMdActive() && modeOf(activeTab()!) === 'edit', enabled: isMdActive, run: () => mdMode('edit') });
  reg.add({ id: 'view.mdPreview', label: 'act.mdPreview', group: 'view', checked: () => isMdActive() && modeOf(activeTab()!) === 'md', enabled: () => isMdActive() && mdSplitEligible(activeTab()!), run: () => mdMode('md') });
  reg.add({ id: 'view.mdSplit', label: 'act.mdSplit', group: 'view', icon: 'mdSplit', checked: () => isMdActive() && modeOf(activeTab()!) === 'split', enabled: () => isMdActive() && mdSplitEligible(activeTab()!), run: () => mdMode('split') });
  reg.add({
    id: 'view.mdWysiwyg', label: 'act.mdWysiwyg', group: 'view', icon: 'mdWysiwyg',
    checked: () => isMdActive() && modeOf(activeTab()!) === 'wysiwyg',
    enabled: () => isMdActive() && wysiwygEligible(activeTab()!),
    run: () => mdMode('wysiwyg'),
  });
  reg.add({
    id: 'view.toggleTree', label: 'act.toggleTree', shortcut: 'Ctrl+Shift+B', group: 'view',
    checked: () => sidebarVisible,
    run: () => {
      sidebarVisible = !sidebarVisible;
      sidebarEl.style.display = sidebarVisible ? '' : 'none';
      (document.getElementById('sbResize') as HTMLElement).style.display = sidebarVisible ? '' : 'none';
    },
  });
  reg.add({
    id: 'view.lineNumbers', label: 'act.lineNumbers', group: 'view', icon: 'goto',
    checked: () => settings.showLineNumbers !== false,
    enabled: isTextActive,
    run: () => {
      settings = { ...settings, showLineNumbers: settings.showLineNumbers === false };
      void settingsSave(settings as Record<string, unknown>);
      if (currentView instanceof TextView) currentView.setLineNumbersVisible(settings.showLineNumbers !== false);
      if (currentView instanceof EditView) currentView.setLineNumbersVisible(settings.showLineNumbers !== false);
    },
  });
  reg.add({
    id: 'view.invisible', label: 'act.invisible', group: 'view', icon: 'invisible',
    checked: () => settings.showInvisible === true,
    enabled: isTextActive,
    run: () => {
      settings = { ...settings, showInvisible: settings.showInvisible !== true };
      void settingsSave(settings as Record<string, unknown>);
      if (currentView instanceof EditView) currentView.setInvisibleVisible(settings.showInvisible === true);
      else if (currentView instanceof TextView) currentView.setInvisibleVisible(settings.showInvisible === true);
    },
  });
  // 自动换行（002 规则 11 v1.4）：编辑态软换行，按标签记忆（会话内）；查看态维持横向滚动模型
  // v1.6：移入工具栏左组（格式化之后）随 tinted 序列
  reg.add({
    id: 'view.wrap', label: 'act.wrap', shortcut: 'Alt+Z', group: 'view', icon: 'wrap', tint: 'teal',
    checked: () => {
      const t = activeTab();
      return !!t && wrapMap.get(t.path) === true;
    },
    enabled: isTextActive,
    run: () => withEdit(v => {
      const t = activeTab();
      if (!t) return;
      const next = !v.wrap;
      wrapMap.set(t.path, next);
      v.setWrap(next);
    }),
  });
  // ---- H-2 工具栏上下文动作（方案 A：右段随视图，复用 ActionRegistry 单一来源） ----
  // enabled 按文档/模式状态判定（mountView 异步完成前 currentView 未就位，instanceof 会滞后一拍）
  const isCsvActive = () => {
    const t = activeTab();
    return !!t && modeOf(t) === 'csv';
  };
  const isImageActive = () => activeTab()?.route === 'image';
  const canFormatMarkdown = () => isMdActive() && !settings.readOnlyMode &&
    (currentView instanceof EditView || currentView instanceof LivePreviewView) && !currentView.isReadOnly &&
    modeOf(activeTab()!) !== 'md';
  const formatMarkdown = (cmd: MdFormatCmd): void => {
    if (currentView instanceof LivePreviewView) currentView.runFormat(cmd);
    else if (currentView instanceof EditView) runSourceMdFormat(currentView, cmd);
  };
  // Markdown IR 格式钮（所见即所得式；v0.16：与源码态右键/IR 右键同一 runMdFormat 实现，规则 17）。
  // 2026-10 图标统一：与工具栏其余按钮同口径**纯图标**（悬停 title 已含完整名称）——修前
  // B/I/S 带字母 short（图标+字母双写）、代码/链接/表格带中文 short（块面更大更重），
  // 同组两种尺寸混排很不协调。
  const wyBtn = (id: string, labelKey: string, type: 'bold' | 'italic' | 'strike' | 'inlineCode' | 'codeBlock' | 'link' | 'table', tint: 'blue' | 'violet' | 'teal' | 'amber' | 'green'): void => {
    reg.add({
      id, label: labelKey, icon: type, group: 'edit', tint, enabled: canFormatMarkdown,
      run: () => formatMarkdown(type),
    });
  };
  wyBtn('tbmd.bold', 'md.bold', 'bold', 'blue');
  wyBtn('tbmd.italic', 'md.italic', 'italic', 'violet');
  wyBtn('tbmd.strike', 'md.strike', 'strike', 'teal');
  wyBtn('tbmd.inlineCode', 'md.inlineCode', 'inlineCode', 'amber');
  wyBtn('tbmd.codeBlock', 'md.codeBlock', 'codeBlock', 'amber');
  wyBtn('tbmd.link', 'md.link', 'link', 'blue');
  wyBtn('tbmd.table', 'md.table', 'table', 'green');
  reg.add({
    id: 'tbmd.headings', label: 'md.headingBtn', icon: 'heading', group: 'edit', tint: 'slate',
    enabled: canFormatMarkdown,
    popup: anchor => {
      popupAbove(anchor, (['h1', 'h2', 'h3', 'h4', 'paragraph'] as const).map(tag => [
        $t(`md.${tag}`),
        () => {
          formatMarkdown(tag);
        },
      ] as [string, () => void]));
    },
    run: () => void 0,
  });
  // Markdown 三形态直达（工具栏中段 seg；007 v0.15——源码即编辑面；分屏/IR 超 2MB 置灰与菜单同一闸）
  const mdSeg = (
    id: string, labelKey: string, shortKey: string, m: ViewMode,
    icon?: 'mdSource' | 'mdSplit' | 'mdWysiwyg', tint?: 'slate' | 'violet' | 'teal' | 'green',
    extraEnabled?: (t: TabState) => boolean
  ): void => {
    reg.add({
      id, label: labelKey, short: shortKey, group: 'view', icon, tint,
      enabled: () => {
        const t = activeTab();
        return isMdActive() && !!t && (!extraEnabled || extraEnabled(t));
      },
      checked: () => {
        const t = activeTab();
        return !!t && modeOf(t) === m;
      },
      run: () => mdMode(m),
    });
  };
  mdSeg('tbmd.source', 'act.mdSource', 'tb.mdSource', 'edit', 'mdSource', 'slate',
    t => (fileSizes.get(t.path) ?? 0) <= EDIT_LIMIT); // >10MB 已在流式查看面看源码，置灰防误导
  mdSeg('tbmd.split', 'act.mdSplit', 'tb.mdSplit', 'split', 'mdSplit', 'violet', mdSplitEligible);
  mdSeg('tbmd.ir', 'act.mdWysiwyg', 'tb.mdWysiwyg', 'wysiwyg', 'mdWysiwyg', 'green', wysiwygEligible);
  // CSV 上下文：源码/表格 seg + 分隔符 ▾
  reg.add({
    id: 'tbcsv.source', label: 'act.textView', short: 'tb.csvSource', group: 'view', icon: 'text', tint: 'blue',
    enabled: () => !!activeTab() && (activeTab()!.language === 'CSV' || activeTab()!.language === 'TSV'),
    // 源码形态 = 'edit'（≤10MB 编辑面）或 'view'（>10MB 流式查看面），非 'csv' 即源码
    checked: () => !!activeTab() && modeOf(activeTab()!) !== 'csv',
    run: () => {
      const t = activeTab();
      if (!t) return;
      setMode(t, t.path.startsWith('draft://') || (fileSizes.get(t.path) ?? 0) <= EDIT_LIMIT ? 'edit' : 'view');
    },
  });
  reg.add({
    id: 'tbcsv.table', label: 'act.csvTable', short: 'tb.csvTable', group: 'view', icon: 'grid', tint: 'teal',
    enabled: () => !!activeTab() && (activeTab()!.language === 'CSV' || activeTab()!.language === 'TSV'),
    checked: isCsvActive,
    run: () => toggleMode('csv'),
  });
  reg.add({
    id: 'tbcsv.delim', label: 'act.csvDelim', short: 'tb.csvDelim', group: 'view', tint: 'teal',
    enabled: isCsvActive,
    popup: anchor => {
      const opts = [
        [',', $t('csv.delimComma')],
        [';', $t('csv.delimSemicolon')],
        ['\t', $t('csv.delimTab')],
        ['|', $t('csv.delimPipe')],
      ] as const;
      const cur = currentView instanceof CsvView ? currentView.delimiter : ',';
      popupAbove(anchor, opts.map(([d, name]) => [
        `${cur === d ? '✓ ' : '　'}${name}`,
        () => {
          const tab = activeTab();
          if (tab && currentView instanceof CsvView) {
            csvDelimiters.set(tab.path, d);
            currentView.setDelim(d);
          }
        },
      ] as [string, () => void]));
    },
    run: () => void 0,
  });
  // 图片上下文：适应窗 / 100% / 缩放±
  reg.add({
    id: 'tbimg.fit', label: 'act.imgFit', short: 'tb.imgFit', group: 'view', tint: 'blue', enabled: isImageActive,
    checked: () => currentView instanceof ImageView && (currentView as ImageViewT & { displayMode?: string }).displayMode === 'fit',
    run: () => currentView instanceof ImageView && currentView.fitToWindow(),
  });
  reg.add({
    id: 'tbimg.100', label: 'act.img100', short: 'tb.img100', group: 'view', tint: 'violet', enabled: isImageActive,
    checked: () => currentView instanceof ImageView && (currentView as ImageViewT & { displayMode?: string }).displayMode === '100',
    run: () => currentView instanceof ImageView && currentView.zoom100(),
  });
  reg.add({
    id: 'tbimg.zoomIn', label: 'act.imgZoomIn', short: 'tb.imgZoomIn', group: 'view', tint: 'teal', enabled: isImageActive,
    run: () => currentView instanceof ImageView && currentView.zoomBy(1.25),
  });
  reg.add({
    id: 'tbimg.zoomOut', label: 'act.imgZoomOut', short: 'tb.imgZoomOut', group: 'view', tint: 'teal', enabled: isImageActive,
    run: () => currentView instanceof ImageView && currentView.zoomBy(0.8),
  });
  reg.add({
    id: 'view.tailboard', label: 'act.tailboard', group: 'view', icon: 'clock',
    run: () => {
      if (store.tabs.some(t => t.path === 'tail://')) {
        store.activate(store.tabs.findIndex(t => t.path === 'tail://'));
        return;
      }
      store.open({ path: 'tail://', route: 'text', language: null, scroll: 0, bookmarks: [] });
      render();
    },
  });
  reg.add({
    id: 'edit.normalize', label: 'act.normalize', group: 'edit', icon: 'replace',
    enabled: () => {
      const t = activeTab();
      return !!t && t.route === 'text' && isRealFilePath(t.path);
    },
    run: () => openNormalizeDialog(),
  });
  reg.add({
    // 编码转换另存（002 规则 21a）：编辑菜单入口——源编码取当前标签探测值
    id: 'edit.encSave', label: 'act.encSave', group: 'edit', icon: 'replace',
    enabled: () => {
      const t = activeTab();
      return !!t && t.route === 'text' && isRealFilePath(t.path);
    },
    run: () => {
      const t = activeTab()!;
      void ensurePanels().then(m => m.encodeConvertDialog({
        isReadOnly: () => settings.readOnlyMode === true,
        path: t.path,
        fromEnc: encodingByPath.get(t.path) ?? '',
        title: $t('enc.title'),
        flash,
      }));
    },
  });
  reg.add({
    id: 'view.minimap', label: 'act.minimap', group: 'view', icon: 'minimap',
    checked: () => settings.showMinimap !== false,
    run: () => {
      settings = { ...settings, showMinimap: settings.showMinimap === false };
      void settingsSave(settings as Record<string, unknown>);
      const on = settings.showMinimap !== false;
      if (currentView instanceof TextView) currentView.setMinimapVisible(on);
      else if (currentView instanceof EditView && !wyMinimap) {
        // B-2：编辑态两态——已挂载直接显隐；未挂载且开启中，现场补挂
        if (currentView.hasMinimap()) currentView.setMinimapVisible(on);
        else if (on) {
          const row = document.getElementById('editorRow');
          if (row) currentView.attachMinimap(row);
        }
      }
      wyMinimap?.setVisible(on);
      if (on) wyMinimap?.sync();
    },
  });
  reg.add({
    id: 'view.toggleRuler', label: 'act.toggleRuler', group: 'view', icon: 'ruler',
    checked: () => settings.showRuler !== false,
    run: () => {
      settings = { ...settings, showRuler: settings.showRuler === false };
      void settingsSave(settings as Record<string, unknown>);
      applyRulerVisible();
    },
  });
  reg.add({
    id: 'view.theme', label: 'act.theme', group: 'view', icon: 'theme',
    run: () => openThemeDialog(settings.theme ?? 'paper', key => {
      applyTheme(key);
      settings = { ...settings, theme: key };
      void settingsSave(settings as Record<string, unknown>);
      // CM6 即时渲染直接使用主题令牌；重挂会丢光标、滚动及撤销历史，且重复读取文件。
    }),
  });
  reg.add({ id: 'tools.importFont', label: 'act.importFont', group: 'tools', run: () => void importLocalFont() });
  reg.add({
    id: 'tools.fontReset', label: 'act.fontReset', group: 'tools', enabled: () => settings.editorFont === 'local',
    run: () => {
      settings = { ...settings, editorFont: 'bundled', localFontPath: undefined };
      void settingsSave(settings as Record<string, unknown>);
      applyEditorFontOverride();
      flash($t('font.reset'));
    },
  });
  reg.add({ id: 'tools.palette', label: 'act.commandPalette', shortcut: 'Ctrl+Shift+P', group: 'tools', icon: 'cmd', run: () => openPalette(reg, paletteFileSource()) });
  reg.add({ id: 'tools.imageHost', label: 'act.imageHost', group: 'tools', run: openImageHost });
  reg.add({ id: 'tools.openBackup', label: 'set.openBak', group: 'tools', run: openBackupDirectory });
  reg.add({ id: 'tools.settings', label: 'act.settings', shortcut: 'Ctrl+,', group: 'tools', icon: 'settings', run: () => openSettings() });
  function openManual(): void {
    const body = document.createElement('div');
    body.className = 'ov-body help-manual';
    const sections: [string, string][] = [
      ['help.h.open', 'help.b.open'],
      ['help.h.edit', 'help.b.edit'],
      ['help.h.column', 'help.b.column'],
      ['help.h.find', 'help.b.find'],
      ['help.h.md', 'help.b.md'],
      ['help.h.compare', 'help.b.compare'],
      ['help.h.settings', 'help.b.settings'],
    ];
    for (const [h, b] of sections) {
      const title = document.createElement('h3');
      title.className = 'help-h';
      title.textContent = $t(h);
      const p = document.createElement('p');
      p.className = 'help-p';
      p.textContent = $t(b);
      body.append(title, p);
    }
    document.body.appendChild(overlayDialog($t('act.manual'), body, () => void 0));
  }
  reg.add({ id: 'help.about', label: 'act.about', group: 'help', icon: 'info', run: () => void openAboutDialog() });
  reg.add({ id: 'help.manual', label: 'act.manual', group: 'help', icon: 'info', run: () => openManual() });
  reg.add({
    id: 'help.shortcuts', label: 'act.shortcuts', group: 'help',
    run: () => {
      const body = document.createElement('div');
      body.className = 'ov-body';
      for (const d of reg.all().filter(d => d.shortcut)) {
        const row = document.createElement('div');
        row.className = 'sum-row';
        const k = document.createElement('span');
        k.textContent = d.shortcut!;
        const v = document.createElement('span');
        v.textContent = L(d.label);
        row.append(k, v);
        body.appendChild(row);
      }
      const extra = document.createElement('div');
      extra.className = 'ov-path';
      extra.textContent = $t('help.extra');
      body.appendChild(extra);
      const mn = document.createElement('div');
      mn.className = 'ov-path';
      mn.textContent = $t('help.mnemonics');
      body.appendChild(mn);
      document.body.appendChild(overlayDialog($t('help.shortcuts'), body, () => void 0));
    },
  });
  // 命名会话动态条目（文件菜单）：注册表按 id 覆盖式更新
  function registerSessionActions(): void {
    for (const name of Object.keys(namedSessions)) {
      reg.add({
        id: `file.session:${name}`, label: `act.restoreSession:${name}`, group: 'file',
        run: () => void restoreNamedSession(name),
      });
    }
  }

  /** 恢复命名会话（F001-01 根修，001 规则 4/AC-11）：整组替换标签**先过脏守卫**——
   *  修前 store.restore 直接整组换掉当前标签，未保存修改静默丢弃（autosave 关时彻底丢失）。
   *  有脏标签时三键确认：取消 / 放弃修改并恢复 / 保存全部并恢复（任一保存失败则中止保留现组）。 */
  function restoreNamedSession(name: string): void {
    const snap = namedSessions[name];
    if (!snap) return;
    const applyRestore = (): void => {
      if (store.restore(snap) === 0) flash($t('msg.sessionEmpty'));
      bumpDraftSeqFromStore(); // v2.5：命名会话恢复后草稿序号取历史最大续排
    };
    const dirty = store.tabs.filter(t => dirtyPaths.get(t.path) === true);
    if (dirty.length === 0) {
      applyRestore();
      return;
    }
    const discardAll = (): void => {
      for (const t of dirty) {
        recoveryPending.delete(t.path);
        editorBuffers.delete(t.path);
        discardedBuffers.add(t.path);
        void recoveryDiscard([t.path]).catch(() => void 0);
        setTabDirty(t.path, false);
      }
      applyRestore();
    };
    const saveAll = (): void => {
      void (async () => {
        for (const t of dirty) {
          const ok = await saveDirtyTab(t.path);
          if (!ok) {
            flash($tf('save.failQuit', t.path.split(/[\\/]/).pop() ?? t.path));
            return; // 保存失败/取消另存：中止恢复，现组保留
          }
        }
        applyRestore();
      })();
    };
    const body = document.createElement('div');
    body.className = 'ov-body';
    const p = document.createElement('p');
    p.textContent = $tf('exit.dirtyMsg', dirty.length);
    body.appendChild(p);
    const hint = document.createElement('p');
    hint.style.cssText = 'color:var(--muted);font-size:12px;margin-top:6px';
    hint.textContent = $t('msg.sessionRestoreHint');
    body.appendChild(hint);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px';
    const mk = (label: string, primary: boolean, fn: () => void) => {
      const b = document.createElement('button');
      b.className = 'dlg-btn' + (primary ? ' primary' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        maskH?.close();
        fn();
      });
      row.appendChild(b);
    };
    let maskH: OverlayMask | null = null;
    mk($t('common.cancel'), false, () => void 0);
    mk($t('exit.discardExit'), false, discardAll);
    mk($t('exit.saveExit'), true, saveAll);
    body.appendChild(row);
    maskH = overlayDialog($t('named.restoreTitle'), body, () => void 0);
    document.body.appendChild(maskH);
  }

  // 最近打开动态条目（文件菜单"最近打开 ▸"，001 规则 27）：与侧栏最近面板同源
  function registerRecentActions(): void {
    for (const r of recentMenuCache.slice(0, 10)) {
      reg.add({
        id: `file.recent:${r.path}`,
        label: r.path.replace(/\\/g, '/').split('/').pop() ?? r.path,
        group: 'file',
        run: () => void openPath(r.path, undefined, r.isDir),
      });
    }
  }

  // ---- 菜单（六个，001 规则 19；结构定义见模块级 buildMenus） ----
  let recentMenuCache: Array<{ path: string; isDir: boolean }> = [];
  const MENUS: MenuDef[] = buildMenus(() => Object.keys(namedSessions), () => recentMenuCache);

  // 工具栏（H-2 方案 A，审计 §2.1 用户拍板）：左段恒定（文件/撤销重做/剪贴板/查找），
  // 中段随活动视图上下文切换——文本/代码、Markdown IR（所见即所得式格式钮）、CSV、图片各一套；
  // 右区恒定（命令面板 + 主题）。buildToolbar 按结构签名重建，enabled/checked 始终新鲜。
  const TOOLBAR_SPEC = (): ToolbarSpec => {
    const tab = store.active();
    const mode = tab ? modeOf(tab) : 'view';
    const left: ToolbarSpec['left'] = [
      { action: 'file.newDraft' }, { action: 'file.openFile' }, { action: 'file.save' }, { action: 'file.saveAs' },
      'sep',
      { action: 'edit.undo' }, { action: 'edit.redo' },
      'sep',
      { action: 'edit.cut' }, { action: 'edit.copy' }, { action: 'edit.paste' },
      'sep',
      { action: 'find.find' }, { action: 'find.replace' }, { action: 'find.goto' },
    ];
    let context: ToolbarSpec['context'];
    if (tab?.route === 'image') {
      context = [{ action: 'tbimg.fit' }, { action: 'tbimg.100' }, { action: 'tbimg.zoomOut' }, { action: 'tbimg.zoomIn' }];
    } else if (tab?.route === 'text' && (tab.language === 'CSV' || tab.language === 'TSV')) {
      context = [{ seg: ['tbcsv.source', 'tbcsv.table'] }, { action: 'tbcsv.delim' }];
    } else if (tab?.language === 'Markdown' && (mode === 'md' || mode === 'edit' || mode === 'split' || mode === 'wysiwyg')) {
      // v2.5（001 规则 19）：形态切换段 [源码|分屏|预览|即时] 移除——与状态栏快捷格/模式格入口重复
      context = [
        { seg: ['view.tabEdit', 'view.tabLock'] },
        { action: 'tbmd.headings' },
        { action: 'tbmd.bold' }, { action: 'tbmd.italic' }, { action: 'tbmd.strike' },
        { action: 'tbmd.inlineCode' }, { action: 'tbmd.codeBlock' },
        { action: 'tbmd.link' }, { action: 'tbmd.table' },
        { action: 'view.font' },
      ];
    } else {
      // 文本/代码（含 md 三形态的通用组；工具栏「编辑」钮已随 002 v2.6 双模式删除）
      context = [
        { seg: ['view.tabEdit', 'view.tabLock'] },
        { action: 'edit.column' },
        { action: 'edit.format' },
        { action: 'view.wrap' },
        { action: 'view.font' },
      ];
    }
    return {
      left,
      context,
      right: [
        // v1.6 清理：设置/不可见字符按钮移除（功能入口在工具/视图菜单与命令面板）
        { action: 'tools.palette' },
        { action: 'view.theme' },
      ],
    };
  };

  /** 窗口 chrome 装配（语言切换时就地重建：菜单栏 + 工具栏，不重载页面） */
  function mountChrome(): void {
    menubarCtl?.dispose(); // 卸载旧 document 级监听，避免语言反复切换时累积
    const menubarEl = el('menubar');
    menubarEl.innerHTML = '';
    menubarCtl = buildMenubar(menubarEl, MENUS, reg);
    const toolbarEl = el('toolbar');
    toolbarEl.innerHTML = '';
    toolbarCtl = buildToolbar(toolbarEl, TOOLBAR_SPEC, reg);
  }

  /** 大写 A：只调字号（10–18，与 Ctrl+滚轮同源）。字体导入/恢复在工具菜单。 */
  function openFontPopover(): void {
    document.querySelector('.font-pop')?.remove();
    const anchor = document.querySelector<HTMLElement>('#toolbar [data-action="view.font"]');
    const pop = document.createElement('div');
    pop.className = 'font-pop';
    pop.title = $t('fs.tip');
    const sizeRow = document.createElement('div');
    sizeRow.className = 'font-pop-row';
    const lab = document.createElement('span');
    lab.textContent = $t('set.fontSize');
    const input = document.createElement('input');
    input.className = 'fs-input';
    input.type = 'number';
    input.min = '10';
    input.max = '18';
    input.value = String(settings.fontSize ?? 12);
    const step = (delta: number): void => {
      applyFontSize((settings.fontSize ?? 12) + delta);
      input.value = String(settings.fontSize ?? 12);
    };
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'fs-step';
    minus.textContent = '−';
    minus.addEventListener('click', () => step(-1));
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'fs-step';
    plus.textContent = '+';
    plus.addEventListener('click', () => step(1));
    input.addEventListener('change', () => applyFontSize(parseInt(input.value || '12', 10)));
    sizeRow.append(lab, minus, input, plus);
    pop.append(sizeRow);
    document.body.appendChild(pop);
    const r = anchor?.getBoundingClientRect();
    pop.style.top = `${(r?.bottom ?? 64) + 4}px`;
    pop.style.left = `${Math.max(8, Math.min(r?.left ?? 8, window.innerWidth - 248))}px`;
    setTimeout(() => {
      const close = (ev: MouseEvent): void => {
        if (pop.contains(ev.target as Node)) return;
        pop.remove();
        document.removeEventListener('mousedown', close, true);
      };
      document.addEventListener('mousedown', close, true);
    }, 0);
  }

  initTitlebar(activeName);
  mountChrome();

  // ---- 侧栏（001 规则 20：文件/大纲 + ⮂ 切最近） ----
  const outlineAvailable = () => {
    const tab = activeTab();
    return !!tab && tab.route === 'text' && !!tab.language && OUTLINE_LANGS.has(tab.language);
  };
  let outlineList: ReturnType<typeof mountOutlineRows> | null = null;
  let outlineRequest = 0;
  let outlineCancel: (() => void) | null = null;
  // 指纹门控（doc.length + EditView 内容修订号）替代文档对象同一性比对——
  // 纯光标/选区变化（文档未变）不触发重解析；修订号来自 edit.ts docVer，内容每变必增
  let outlineFingerprint = '';
  let outlineTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleBufferOutline(): void {
    const language = activeTab()?.language;
    if (!(currentView instanceof EditView) || !language || !OUTLINE_LANGS.has(language) || !sidebarCtl?.isOutlineShown()) return;
    const doc = currentView.view?.state.doc;
    if (!doc) return;
    const fp = `${doc.length}#${currentView.contentRevision()}`;
    if (fp === outlineFingerprint) return; // 内容未变（仅光标移动）：跳过重解析
    outlineFingerprint = fp;
    if (outlineTimer) clearTimeout(outlineTimer);
    outlineTimer = setTimeout(() => {
      outlineTimer = undefined;
      if (sidebarCtl.isOutlineShown()) void renderOutlineInto(sidebarCtl.outlineHostEl);
    }, 300);
  }
  async function renderOutlineInto(host: HTMLElement): Promise<void> {
    const request = ++outlineRequest;
    outlineCancel?.(); outlineCancel = null;
    outlineList?.dispose(); outlineList = null;
    const scroller = host.closest<HTMLElement>('.sidebar-body') ?? host;
    const keepScroll = host.dataset.path === activeTab()?.path ? scroller.scrollTop : 0;
    host.dataset.path = activeTab()?.path ?? '';
    host.innerHTML = '';
    const tab = activeTab();
    if (!tab || !outlineAvailable()) return;
    host.className = 'sym-list';
    // WYSIWYG 模式：标题树来自编辑器实时上报，按序号滚动到对应块（007 规则 3）
    if (modeOf(tab) === 'wysiwyg') {
      const heads = wysiwygHeadings.get(tab.path) ?? [];
      if (heads.length === 0) {
        host.textContent = $t('outline.empty');
        return;
      }
      outlineList = mountOutlineRows(host, heads.map(h => ({ line: h.line + 1, name: h.text, level: h.level })), i => {
        if (currentView instanceof LivePreviewView) currentView.scrollToHeading(i);
      });
      scroller.scrollTop = keepScroll;
      return;
    }
    host.textContent = $t('outline.parsing');
    try {
      let syms;
      if (tab.language === 'Markdown' && currentView instanceof EditView) {
        const doc = currentView.view.state.doc;
        outlineFingerprint = `${doc.length}#${currentView.contentRevision()}`;
        // 全文快照走 snapshot 分段取（64KB 段间让出主线程），不再一次性 toString 长占
        const text = await snapshotDocument(doc);
        if (!(currentView instanceof EditView) || currentView.view.state.doc !== doc) return; // 快照期间文档已变：丢弃
        const parse = parseOutlineHeadings(text);
        outlineCancel = parse.cancel;
        const heads = await parse.result;
        if (!(currentView instanceof EditView) || currentView.view.state.doc !== doc) return;
        syms = heads.map(h => ({ line: h.line + 1, name: h.text, kind: `H${h.level}` }));
      } else if (currentView instanceof EditView && currentView.view.state.doc.lines <= 5000) {
        // 006 规则 6：代码大纲读未保存缓冲（≤5000 行直读；更大文件退回磁盘路径，避免每次编辑全树解析）
        const doc = currentView.view.state.doc;
        outlineFingerprint = `${doc.length}#${currentView.contentRevision()}`;
        const text = await snapshotDocument(doc); // 分段取，同上
        if (!(currentView instanceof EditView) || currentView.view.state.doc !== doc) return;
        const panels = await ensurePanels(); // 面板模块与当前语言语法包均按需加载
        syms = await panels.symbolsFromTextAsync(text, tab.language!);
      } else {
        const panels = await ensurePanels();
        syms = await panels.extractSymbols(tab.path, tab.language!, await currentEncoding(tab.path));
      }
      if (request !== outlineRequest || activeTab()?.path !== tab.path) return;
      host.innerHTML = '';
      if (syms.length === 0) {
        host.textContent = $t('outline.none');
        return;
      }
      const isMdOutline = tab.language === 'Markdown';
      outlineList = mountOutlineRows(host, syms.map(s => ({ line: s.line, name: s.name, level: isMdOutline && /^H[1-6]$/.test(s.kind) ? Number(s.kind.slice(1)) : undefined, showLine: !isMdOutline })), i => outlineJump(syms[i]!.line));
      scroller.scrollTop = keepScroll;
    } catch (err) {
      if (request !== outlineRequest || activeTab()?.path !== tab.path) return;
      host.textContent = $tf('outline.fail', String(err));
    }
  }

  /** 大纲当前项常亮（#12）：光标/点击所在行落在哪个符号区间，就高亮哪个符号 */
  function updateOutlineCur(line: number): void {
    if (!sidebarCtl.isOutlineShown()) return;
    if (outlineList) { outlineList.setCurrent(line); return; }
    const host = sidebarCtl.outlineHostEl;
    const items = Array.from(host.querySelectorAll<HTMLElement>('.sym-item[data-line]'));
    let hit: HTMLElement | null = null;
    for (const it of items) {
      if (Number(it.dataset.line) <= line) hit = it;
    }
    const curKey = hit ? (hit.dataset.line ?? '') : '';
    if (host.dataset.curLine === curKey) return; // 未变不重绘
    host.dataset.curLine = curKey;
    items.forEach(it => it.classList.toggle('cur', it === hit));
  }

  /** 大纲点击跳转：按当前视图模式落到源码行 / 预览锚点（此前 md 预览与挂载竞态下点击无响应） */
  function outlineJump(line: number): void {
    updateOutlineCur(line);
    const tab = activeTab();
    if (!tab) return;
    const mode = modeOf(tab);
    if ((mode === 'md' || mode === 'split' || mode === 'wysiwyg') && previewHostEl) {
      // 渲染面在场：跳预览锚点（分屏右侧宿主；007 v0.15 起独立渲染预览已删）
      previewAnchorBefore(previewHostEl, Math.max(0, line - 1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (mode === 'edit') {
      // 编辑缓冲行号与源码行一致（打开即整读）
      if (currentView instanceof EditView && currentView.view) {
        currentView.goToLine(line);
      }
      return;
    }
    // 源码/分屏：TextView 可能仍在挂载（异步），轮询等待后定位
    const t0 = Date.now();
    const tryGo = (): void => {
      if (currentView instanceof TextView) void currentView.goToLine(line, undefined, true);
      else if (Date.now() - t0 < 1500) setTimeout(tryGo, 100);
    };
    tryGo();
  }

  async function refreshRecents(): Promise<void> {
    try {
      const [recents, favs] = await Promise.all([recentList(), favoritesList()]);
      const recentItems: RecentItem[] = recents.map(r => ({ path: r.path, isDir: r.isDir }));
      const favFlat: RecentItem[] = [
        ...favs.items.map(f => ({ path: f.path, isDir: f.isDir })),
        ...favs.groups.flatMap(g => g.items.map(f => ({ path: f.path, isDir: f.isDir }))),
      ];
      const favPaths = new Set(favFlat.map(f => f.path));
      sidebarCtl.setRecentData(recentItems, favPaths);
      sidebarCtl.setFavData(
        favs.items.map(f => ({ path: f.path, isDir: f.isDir })),
        favs.groups.map(g => ({ name: g.name, items: g.items.map(f => ({ path: f.path, isDir: f.isDir })) }))
      );
      recentCache = recentItems;
      favCache = favFlat;
      recentMenuCache = recentItems.filter(r => isRealFilePath(r.path));
      registerRecentActions();
      // v2.3 空态已改纯空白（无最近列表），数据就位不再需要强制重渲染空态
    } catch {
      /* 最近列表载入失败不打扰 */
    }
  }

  /** 命令面板文件搜索来源：打开的标签 + 收藏 + 最近（不做全盘扫描，避免性能红线） */
  function paletteFileSource(): PaletteFileSource {
    const base = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p;
    const dir = (p: string): string => {
      const s = p.replace(/\\/g, '/').split('/');
      s.pop();
      return s.join('/');
    };
    const pseudo = (p: string): boolean => !isRealFilePath(p);
    return {
      items: () => {
        const out: PaletteFileItem[] = [];
        const seen = new Set<string>();
        const push = (path: string, isDir?: boolean): void => {
          if (!path || pseudo(path) || seen.has(path)) return;
          seen.add(path);
          out.push({ path, label: base(path), sub: dir(path), isDir });
        };
        for (const t of store.tabs) push(t.path);
        for (const f of favCache) push(f.path, f.isDir);
        for (const r of recentCache) push(r.path, r.isDir);
        return out;
      },
      open: (path, isDir) => void openPath(path, undefined, isDir),
    };
  }

  const sidebarOpts: SidebarOpts = {
    outlineAvailable,
    renderOutline: host => void renderOutlineInto(host),
    onOpenPath: (path, isDir) => void openPath(path, undefined, isDir),
    // 返回上级文件夹：树重根为父目录（显式指定，目录跟随豁免）；盘符根/无根时按钮已隐藏，双保险再守一层
    onUpRoot: () => {
      if (!localRoot) return;
      const parent = normLocal(dirOf(localRoot));
      if (!parent || parent === localRoot) return;
      void openPath(parent, undefined, true);
    },
    onHide: () => reg.run('view.toggleTree'),
    onRemoveRecents: paths => {
      void recentRemove(paths).then(() => void refreshRecents());
    },
    onClearRecents: () => {
      void dlgConfirm($t('rec.clearConfirm')).then(ok => {
        if (ok) void recentClear().then(() => void refreshRecents());
      });
    },
    onToggleFavorite: path => {
      void favoritesToggle(path).then(() => void refreshRecents());
    },
    onFavoriteCurrent: () => {
      const t = activeTab();
      if (!t || !isRealFilePath(t.path)) {
        flash($t('msg.noLocalFile'));
        return;
      }
      void favoritesToggle(t.path).then(() => void refreshRecents());
    },
    onAddGroup: name => {
      void favoritesGroupAdd(name).then(() => void refreshRecents());
    },
    onRemoveGroup: name => {
      void favoritesGroupRemove(name).then(() => void refreshRecents());
    },
    onMoveFavorite: (path, group) => {
      void favoritesMove(path, group).then(() => void refreshRecents());
    },
    showMenu: (items, x, y) => menu(items, x, y),
    promptText: msg => dlgPrompt(msg),
  };

  /** 侧栏装配（语言切换时就地重建：SidebarCtl 构造即清空宿主并按新语言重建全部文案） */
  function mountSidebar(): void {
    sidebarCtl = new SidebarCtl(sidebarEl, sidebarOpts);
    sidebarEl.style.display = sidebarVisible ? '' : 'none';
    (document.getElementById('sbResize') as HTMLElement).style.display = sidebarVisible ? '' : 'none';
    tree = null; // 旧文件树宿主随侧栏一并移除，交由 rebuildTree 重挂
  }
  mountSidebar();

  // 侧栏拖宽（160–400）
  {
    const handle = document.getElementById('sbResize') as HTMLElement;
    let resizing = false;
    handle.addEventListener('mousedown', () => {
      resizing = true;
    });
    document.addEventListener('mousemove', e => {
      if (resizing) sidebarEl.style.width = `${Math.max(160, Math.min(400, e.clientX))}px`;
    });
    document.addEventListener('mouseup', () => {
      resizing = false;
    });
  }

  async function rebuildTree(): Promise<void> {
    // 001 规则 25：无本地根时空态提示
    const roots: TreeRoot[] = localRoot
      ? [{ label: localRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || localRoot, path: localRoot }]
      : [];
    // 「返回上级」可见性（2026-10 反馈）：有根且父目录与当前根不同（非盘符根）才显示
    const upTo = localRoot ? normLocal(dirOf(localRoot)) : '';
    if (sidebarCtl) sidebarCtl.upRootBtn.style.display = localRoot && upTo && upTo !== localRoot ? '' : 'none';
    if (tree) {
      await tree.refresh(roots);
    } else {
      tree = new FileTree(sidebarCtl.filesHost, roots, {
        onOpenFile: path => void openPath(path),
        onOpenPath: (path, isDir) => void openPath(path, undefined, isDir),
        onContextFile: (path, x, y, sel) => treeMenu(path, x, y, sel),
        onContextDir: (path, x, y) => treeDirMenu(path, x, y),
      });
      await tree.render();
    }
    tree.setActive(activeTab()?.path ?? null);
  }

  // ---- 设置 ----
  /** 版本号（001 规则 30）：Tauri 运行时读取（打包值为 tauri.conf.json 注入），Web/异常回退构建期注入 */
  async function appVersion(): Promise<string> {
    if ('__TAURI_INTERNALS__' in window) {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        return await getVersion();
      } catch {
        /* 回退构建期值 */
      }
    }
    return __APP_VERSION__;
  }

  /** 版本口径（001 规则 30 v2.0 修订）：「版本 · 渠道 · 构建 SHA」——构建日期不再展示（2026-10 用户定稿） */
  function buildLabel(version: string): string {
    const channel = $t(__BUILD_CHANNEL__ === 'release' ? 'about.channelRelease' : 'about.channelDev');
    return [version, channel, __GIT_SHA__].join(' · ');
  }

  /** 关于对话框 `AboutDialog`（001 规则 30）：图标/名称/版本/简介/标识符/版权/日志入口 */
  async function openAboutDialog(): Promise<void> {
    const body = document.createElement('div');
    body.className = 'about-box';
    const logo = document.createElement('span');
    logo.className = 'about-logo';
    // H-2：品牌标三处统一（标题栏/关于/欢迎页同一 16 栅格版——I5「光标 Z」定稿，icons/icon-master.svg）
    logo.innerHTML = brandSvg();
    const name = document.createElement('div');
    name.className = 'about-name';
    name.textContent = 'ZiEdit';
    const ver = document.createElement('div');
    ver.className = 'about-ver';
    ver.textContent = $tf('about.version', buildLabel(await appVersion()));
    const tag = document.createElement('div');
    tag.className = 'about-tag';
    tag.textContent = $t('about.tagline');
    const sep = document.createElement('div');
    sep.className = 'about-sep';
    const idf = document.createElement('div');
    idf.className = 'about-meta';
    idf.textContent = $tf('about.identifier', 'dev.ziedit.app');
    const cr = document.createElement('div');
    cr.className = 'about-meta';
    cr.textContent = $t('about.copyright');
    body.append(logo, name, ver, tag, sep, idf, cr);
    if ('__TAURI_INTERNALS__' in window) {
      // H-4：打开日志目录（tauri-plugin-log 落盘位置，"闪退"排障入口）
      const logs = document.createElement('button');
      logs.className = 'dlg-btn about-logs';
      logs.textContent = $t('about.openLogs');
      logs.addEventListener('click', () => {
        void openLogDir().catch(err => flash($tf('err.openLogDirFail', String(err))));
      });
      body.append(logs);
    }
    document.body.appendChild(overlayDialog($t('act.about'), body, () => void 0));
  }
  /** 独立规范化另存（002 增补 / 008 闭环的单文件入口；对话框与对比视图共享 panels.normalizeSaveDialog） */
  function openNormalizeDialog(): void {
    const tab = activeTab();
    if (!tab || !isRealFilePath(tab.path)) return;
    void ensurePanels().then(m => m.normalizeSaveDialog({ path: tab.path, title: $tf('st.normSaveTitle', tab.path), flash, isReadOnly: () => settings.readOnlyMode === true }));
  }

  /** 设置面板开着时切换语言：重建后重新打开，不把用户扔出设置 */
  let reopenSettings = false;

  /** 界面语言切换：就地重建 chrome（菜单/工具栏）、侧栏与视图（无页面重载） */
  function switchLanguage(lang: Lang): void {
    const reopen = reopenSettings;
    reopenSettings = false;
    setLang(lang);
    (document.querySelector('.ov-mask') as OverlayMask | null)?.close();
    mountChrome();
    mountSidebar();
    void rebuildTree();
    void refreshRecents(); // 重灌最近/收藏：侧栏重建后需要重新填充
    if (sidebarCtl.isOutlineShown()) void renderOutlineInto(sidebarCtl.outlineHostEl);
    sbLayoutKey = '\u0000'; // 哨兵：状态栏布局键不含语言，重置以强制按新语言重建
    // WYSIWYG 有未保存内容时不重挂视图（避免丢失编辑态），仅 chrome/侧栏换语言
    if (currentView instanceof LivePreviewView && wysiwygDirty) {
      flash($t('msg.langChanged'));
      render();
    } else {
      currentViewKey = '\u0000lang'; // 哨兵：强制重挂当前视图，使视图内文案按新语言重建
      render();
    }
    if (reopen) openSettings();
  }

  function openBackupDirectory(): void {
    void backupDir().then(d => revealInDir(d)).catch(() => flash($t('msg.bakDirMissing')));
  }

  /** 专项工具仅合并自己的配置字段，通用设置保存不会覆盖此面板。 */
  function openImageHost(): void {
    const body = document.createElement('div'); body.className = 'ov-body';
    const mkSel = (value: string, options: string[][]): HTMLSelectElement => {
      const sel = document.createElement('select');
      for (const [v, label] of options) { const o = document.createElement('option'); o.value = v!; o.textContent = label!; sel.append(o); }
      sel.value = value; return sel;
    };
    // ---- 图床组（009 规则 2 / AC-1/AC-9：启用开关默认关；凭据掩码 + 清除凭据即时动作） ----
    const ihText = (v: string, ph = ''): HTMLInputElement => {
      const i = document.createElement('input');
      i.value = v;
      i.placeholder = ph;
      i.autocomplete = 'off';
      return i;
    };
    const ihEnabledCb = document.createElement('input');
    ihEnabledCb.type = 'checkbox';
    ihEnabledCb.checked = settings.imageHostEnabled === true;
    const rowIhOn = document.createElement('label');
    rowIhOn.className = 'set-row';
    rowIhOn.append(document.createTextNode($t('set.ihEnabled')), ihEnabledCb);
    const ihEndpoint = ihText(settings.s3Endpoint ?? '', 'https://s3.example.com');
    const rowIhEndpoint = document.createElement('label');
    rowIhEndpoint.className = 'set-row';
    rowIhEndpoint.append(document.createTextNode($t('set.ihEndpoint')), ihEndpoint);
    const ihRegion = ihText(settings.s3Region ?? '', 'auto');
    const rowIhRegion = document.createElement('label');
    rowIhRegion.className = 'set-row';
    rowIhRegion.append(document.createTextNode($t('set.ihRegion')), ihRegion);
    const ihBucket = ihText(settings.s3Bucket ?? '');
    const rowIhBucket = document.createElement('label');
    rowIhBucket.className = 'set-row';
    rowIhBucket.append(document.createTextNode($t('set.ihBucket')), ihBucket);
    const ihAk = ihText(settings.s3Credentials?.accessKeyId ?? '');
    const rowIhAk = document.createElement('label');
    rowIhAk.className = 'set-row';
    rowIhAk.append(document.createTextNode($t('set.ihAccessKey')), ihAk);
    // Secret 掩码输入（AC-9：type=password 呈点；凭据仅本次会话内存，不随 settings.json 落盘）
    const ihSk = document.createElement('input');
    ihSk.type = 'password';
    ihSk.autocomplete = 'new-password';
    ihSk.value = settings.s3Credentials?.secretAccessKey ?? '';
    const ihClearCreds = document.createElement('button');
    ihClearCreds.className = 'dlg-btn';
    ihClearCreds.textContent = $t('set.ihClearCreds');
    // 「清除凭据」即时动作（AC-9）：清内存并立即重写无凭据设置（规则 9：不残留内存界面态）
    ihClearCreds.addEventListener('click', () => {
      settings = { ...settings, s3Credentials: undefined };
      void settingsSave(settings as Record<string, unknown>);
      ihAk.value = '';
      ihSk.value = '';
    });
    const rowIhSk = document.createElement('div');
    rowIhSk.className = 'set-row';
    rowIhSk.append(document.createTextNode($t('set.ihSecretKey')), ihSk, ihClearCreds);
    const ihBase = ihText(settings.publicBaseUrl ?? '', 'https://cdn.example.com');
    const rowIhBase = document.createElement('label');
    rowIhBase.className = 'set-row';
    rowIhBase.append(document.createTextNode($t('set.ihBaseUrl')), ihBase);
    const ihPrefix = ihText(settings.s3Prefix ?? '', 'img');
    const rowIhPrefix = document.createElement('label');
    rowIhPrefix.className = 'set-row';
    rowIhPrefix.append(document.createTextNode($t('set.ihPrefix')), ihPrefix);
    const ihTpl = ihText(settings.s3NameTemplate ?? '{date}/{hash}', '{date}/{hash}');
    const rowIhTpl = document.createElement('label');
    rowIhTpl.className = 'set-row';
    rowIhTpl.append(document.createTextNode($t('set.ihTemplate')), ihTpl);
    const ihStyleSel = mkSel(settings.s3AddressStyle ?? 'path', [
      ['path', $t('set.ihStylePath')],
      ['virtual-host', $t('set.ihStyleVHost')],
    ]);
    const rowIhStyle = document.createElement('label');
    rowIhStyle.className = 'set-row';
    rowIhStyle.append(document.createTextNode($t('set.ihStyle')), ihStyleSel);
    const ihInsecureCb = document.createElement('input');
    ihInsecureCb.type = 'checkbox';
    ihInsecureCb.checked = settings.s3AllowInsecure === true;
    const rowIhInsecure = document.createElement('label');
    rowIhInsecure.className = 'set-row';
    rowIhInsecure.append(document.createTextNode($t('set.ihInsecure')), ihInsecureCb);
    const ihPasteSel = mkSel(settings.pasteImageAction ?? 'ask', [
      ['ask', $t('set.ihPasteAsk')],
      ['upload', $t('set.ihPasteUpload')],
      ['local', $t('set.ihPasteLocal')],
    ]);
    const rowIhPaste = document.createElement('label');
    rowIhPaste.className = 'set-row';
    rowIhPaste.append(document.createTextNode($t('set.ihPasteAction')), ihPasteSel);
    const btn = document.createElement('button'); btn.className = 'dlg-btn primary'; btn.textContent = $t('ed.save');
    let mask: OverlayMask | null = null;
    btn.addEventListener('click', () => {
      // 图床组（009 规则 2）：凭据两框齐填才进入本次会话内存；落盘层统一剔除，半填触发时按 E6001 呈现
      settings = {
        ...settings,
        imageHostEnabled: ihEnabledCb.checked,
        s3Endpoint: ihEndpoint.value.trim(),
        s3Region: ihRegion.value.trim(),
        s3Bucket: ihBucket.value.trim(),
        publicBaseUrl: ihBase.value.trim(),
        s3Prefix: ihPrefix.value.trim(),
        s3NameTemplate: ihTpl.value.trim() || '{date}/{hash}',
        s3AddressStyle: ihStyleSel.value as Settings['s3AddressStyle'],
        s3AllowInsecure: ihInsecureCb.checked,
        pasteImageAction: ihPasteSel.value as Settings['pasteImageAction'],
      };
      const ak = ihAk.value.trim();
      settings = {
        ...settings,
        s3Credentials: ak && ihSk.value ? { accessKeyId: ak, secretAccessKey: ihSk.value } : undefined,
      };
      void settingsSave(settings as Record<string, unknown>);
      mask?.close();
    });
    body.append(rowIhOn, rowIhEndpoint, rowIhRegion, rowIhBucket, rowIhAk, rowIhSk, rowIhBase, rowIhPrefix, rowIhTpl, rowIhStyle, rowIhInsecure, rowIhPaste, btn);
    mask = overlayDialog($t('act.imageHost'), body, () => void 0); document.body.append(mask);
  }

  function openSettings(): void {
    const roInput = document.createElement('input'); roInput.type = 'checkbox'; roInput.checked = settings.readOnlyMode === true;
    const rowReadOnly = document.createElement('label'); rowReadOnly.className = 'set-row'; rowReadOnly.append(document.createTextNode($t('set.readOnlyMode')), roInput);
    const body = document.createElement('div');
    body.className = 'ov-body';
    const markersInput = document.createElement('input');
    markersInput.value = (settings.columnMarkers ?? []).join(',');
    markersInput.placeholder = $t('set.markersPh');
    const row1 = document.createElement('label');
    row1.className = 'set-row';
    row1.append(document.createTextNode($t('set.markers')), markersInput);
    // 字号（001 规则 31：10–18，查看/编辑两态一致）
    const fsInput = document.createElement('input');
    fsInput.type = 'number';
    fsInput.min = '10';
    fsInput.max = '18';
    fsInput.style.width = '70px';
    fsInput.value = String(settings.fontSize ?? 12);
    const rowFs = document.createElement('label');
    rowFs.className = 'set-row';
    rowFs.append(document.createTextNode($t('set.fontSize')), fsInput);
    const autoInput = document.createElement('input');
    autoInput.type = 'number';
    autoInput.min = '0';
    autoInput.style.width = '70px';
    autoInput.value = String(settings.autoSaveSec ?? 15);
    const row2 = document.createElement('label');
    row2.className = 'set-row';
    row2.append(document.createTextNode($t('set.autosave')), autoInput);
    // H-5 T10：自动保存目标（sidecar=旁路快照（出厂）/file=直写原文件）
    const targetSel = document.createElement('select');
    for (const [v, key] of [['sidecar', 'set.autoSaveSidecar'], ['file', 'set.autoSaveFile']] as const) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = $t(key);
      targetSel.appendChild(o);
    }
    targetSel.value = settings.autoSaveTarget ?? 'sidecar';
    const rowTarget = document.createElement('label');
    rowTarget.className = 'set-row';
    rowTarget.append(document.createTextNode($t('set.autoSaveTarget')), targetSel);
    // 仅修改面板暂存值，和其余设置一起保存；取消选择不改变原值。
    let snapshotDir = settings.snapshotDir;
    const rowSnapDir = document.createElement('div');
    rowSnapDir.className = 'set-row';
    const snapPath = document.createElement('span');
    snapPath.style.cssText = 'min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const refreshSnapDir = (): void => {
      snapPath.textContent = snapshotDir || `${$t('set.snapDirDefault')} (config/recovery/)`;
      snapPath.title = snapPath.textContent;
    };
    const snapBrowse = document.createElement('button');
    snapBrowse.className = 'dlg-btn';
    snapBrowse.textContent = $t('set.snapDirBrowse');
    snapBrowse.addEventListener('click', () => {
      if (!('__TAURI_INTERNALS__' in window)) return;
      void openDialog({ directory: true, multiple: false, defaultPath: snapshotDir || undefined }).then(path => {
        if (typeof path === 'string') { snapshotDir = path; refreshSnapDir(); }
      }).catch(() => void 0);
    });
    const snapDefault = document.createElement('button');
    snapDefault.className = 'dlg-btn';
    snapDefault.textContent = $t('set.snapDirDefault');
    snapDefault.addEventListener('click', () => { snapshotDir = undefined; refreshSnapDir(); });
    refreshSnapDir();
    rowSnapDir.append(document.createTextNode($t('set.snapDir')), snapPath, snapBrowse, snapDefault);
    const keepInput = document.createElement('input');
    keepInput.type = 'number';
    keepInput.min = '0';
    keepInput.style.width = '70px';
    keepInput.value = String(settings.backupKeep ?? 3);
    // P3（反馈 24）：备份显式开关（backupEnabled=false 时份数输入禁用并按 0 传 Rust，契约不变）
    const backupCb = document.createElement('input');
    backupCb.type = 'checkbox';
    backupCb.checked = settings.backupEnabled !== false;
    const syncBackupUi = (): void => {
      keepInput.disabled = !backupCb.checked;
    };
    backupCb.addEventListener('change', syncBackupUi);
    syncBackupUi();
    // 显式开关独占一行（「启用」语义自洽），份数行只放数字输入——两行同禁用联动
    const rowBakOn = document.createElement('label');
    const closeAutoSaveCb = document.createElement('input');
    closeAutoSaveCb.type = 'checkbox';
    closeAutoSaveCb.checked = settings.closeAutoSave === true;
    const rowCloseAutoSave = document.createElement('label');
    rowCloseAutoSave.className = 'set-row';
    rowCloseAutoSave.append(document.createTextNode($t('settings.closeAutoSave')), closeAutoSaveCb);
    rowBakOn.className = 'set-row';
    rowBakOn.append(document.createTextNode($t('set.backupOn')), backupCb);
    const row3 = document.createElement('div');
    row3.className = 'set-row';
    row3.append(
      document.createTextNode($t('set.backupKeep')),
      keepInput,
    );
    // 界面语言（i18n）：下拉选中即就地切换（见上方 change 监听），保存按钮兜底同值不重复处理
    const langSel = document.createElement('select');
    for (const [code, key] of [['zh-CN', 'common.langZh'], ['en-US', 'common.langEn']] as const) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = $t(key);
      langSel.appendChild(o);
    }
    langSel.value = getLang();
    // 选中即就地切换（不重载页面）：落库 + 重建 chrome/侧栏/视图（switchLanguage 会关闭本面板）
    langSel.addEventListener('change', () => {
      const picked = langSel.value as Lang;
      if (picked === getLang()) return;
      settings = { ...settings, language: picked };
      void settingsSave(settings as Record<string, unknown>);
      reopenSettings = true;
      switchLanguage(picked);
    });
    const rowLang = document.createElement('label');
    rowLang.className = 'set-row';
    rowLang.append(document.createTextNode($t('common.language')), langSel);
    // 关闭按钮行为（ADR 015）：每次询问（出厂）/直接退出/最小化到托盘；ask 有记忆时可清除
    const closeSel = document.createElement('select');
    for (const [v, key] of [
      ['ask', 'set.closeAsk'],
      ['exit', 'set.closeExit'],
      ['tray', 'set.closeTray'],
    ] as const) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = $t(key);
      closeSel.appendChild(o);
    }
    closeSel.value = settings.closeBehavior ?? 'ask';
    const clearRemembered = document.createElement('button');
    clearRemembered.className = 'dlg-btn';
    clearRemembered.textContent = $t('set.clearRemembered');
    clearRemembered.title = $t('set.clearRemembered');
    const refreshClearRemembered = (): void => {
      const showBtn = closeSel.value === 'ask' && !!settings.rememberedCloseAction;
      clearRemembered.style.display = showBtn ? '' : 'none';
    };
    // 「清除记忆」是即时动作（改的是历史记忆而非设置项本体）；closeBehavior 与面板其余行一致经「保存」落库
    clearRemembered.addEventListener('click', () => {
      settings = { ...settings, rememberedCloseAction: undefined };
      void settingsSave(settings as Record<string, unknown>);
      refreshClearRemembered();
    });
    closeSel.addEventListener('change', refreshClearRemembered);
    const rowClose = document.createElement('div');
    rowClose.className = 'set-row';
    rowClose.append(
      document.createTextNode($t('set.closeBehavior')),
      closeSel,
      clearRemembered,
    );
    refreshClearRemembered();
    // 差异配色自定义（批 F #21：三个 color 输入覆盖令牌，空=跟主题；重置按钮清空回退）
    const diffRow = document.createElement('div');
    diffRow.className = 'set-row';
    const diffLabel = document.createElement('span');
    diffLabel.textContent = $t('set.diffColors');
    const diffPickers = (['add', 'del', 'chg'] as const).map(k => {
      const c = document.createElement('input');
      c.type = 'color';
      c.value = settings.diffColors?.[k] ?? '#cccccc';
      c.title = $t(k === 'add' ? 'set.diffAdd' : k === 'del' ? 'set.diffDel' : 'set.diffChg');
      return c;
    });
    const diffUse = (['add', 'del', 'chg'] as const).map(k => {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!settings.diffColors?.[k];
      cb.addEventListener('change', () => {
        diffPickers[['add', 'del', 'chg'].indexOf(k)].disabled = !cb.checked;
      });
      return cb;
    });
    diffRow.append(diffLabel);
    for (let i = 0; i < 3; i++) diffRow.append(diffUse[i], diffPickers[i]);
    const diffReset = document.createElement('button');
    diffReset.className = 'dlg-btn';
    diffReset.textContent = $t('set.diffReset');
    diffReset.addEventListener('click', () => {
      for (const cb of diffUse) cb.checked = false;
    });
    diffRow.append(diffReset);
    // ---- 批 G：设置面板分组重排（外观/编辑/Markdown/对比/大纲/备份恢复/高级） ----
    const grp = (key: string): HTMLElement => {
      const h = document.createElement('div');
      h.className = 'set-grp';
      h.textContent = $t(key);
      return h;
    };
    const mkSel = (value: string, options: Array<[string, string]>): HTMLSelectElement => {
      const sel = document.createElement('select');
      for (const [v, label] of options) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = value;
      return sel;
    };
    const themeSel = mkSel(settings.theme ?? 'paper', [
      ['paper', $t('theme.paper')], ['cool', $t('theme.cool')], ['graphite', $t('theme.graphite')], ['black', $t('theme.black')],
    ]);
    const rowTheme = document.createElement('label');
    rowTheme.className = 'set-row';
    rowTheme.append(document.createTextNode($t('set.theme')), themeSel);
    // 当前行高亮色（P3，反馈 14）：编辑态活动行底色，取消勾选即恢复主题默认
    const lineHlCb = document.createElement('input');
    lineHlCb.type = 'checkbox';
    lineHlCb.checked = !!settings.lineHl;
    const lineHlPick = document.createElement('input');
    lineHlPick.type = 'color';
    lineHlPick.value = settings.lineHl ?? '#eaeef4'; // v2.5：取色器初始色对齐 paper 主题新默认
    lineHlPick.disabled = !lineHlCb.checked;
    lineHlCb.addEventListener('change', () => (lineHlPick.disabled = !lineHlCb.checked));
    const rowLineHl = document.createElement('div');
    rowLineHl.className = 'set-row';
    rowLineHl.append(document.createTextNode($t('set.lineHl')), lineHlCb, lineHlPick);
    // 「默认打开模式」已随 002 v2.6 双模式删除（≤10MB 恒编辑面）；此处不再渲染该行
    const mdSel = mkSel(settings.mdDefaultMode ?? 'ir', [
      ['ir', $t('set.mdIr')], ['source', $t('set.mdSource')], ['preview', $t('act.mdPreview')],
    ]);
    const rowMd = document.createElement('label');
    rowMd.className = 'set-row';
    rowMd.append(document.createTextNode($t('set.mdDefault')), mdSel);
    // 大纲当前符号高亮色（批 A 令牌 --outline-cur 的自定义覆盖）
    const outlineCb = document.createElement('input');
    outlineCb.type = 'checkbox';
    outlineCb.checked = !!settings.outlineCur;
    const outlinePick = document.createElement('input');
    outlinePick.type = 'color';
    outlinePick.value = settings.outlineCur ?? '#3377cc';
    outlinePick.disabled = !outlineCb.checked;
    outlineCb.addEventListener('change', () => (outlinePick.disabled = !outlineCb.checked));
    const rowOutline = document.createElement('div');
    rowOutline.className = 'set-row';
    rowOutline.append(document.createTextNode($t('set.outlineCur')), outlineCb, outlinePick);
    const btn = document.createElement('button');
    btn.className = 'dlg-btn primary';
    btn.textContent = $t('ed.save');
    let dlgMask: OverlayMask | null = null;
    btn.addEventListener('click', () => {
      const cols = markersInput.value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0).slice(0, 12); // ≤12（007 规则 11 校验）
      const as = Math.max(0, parseInt(autoInput.value, 10) || 0);
      // P3（反馈 24）：开关关闭时份数按 0 传 Rust（Rust 契约不变，显式开关只是 UI 升格）
      const bk = Math.min(10, Math.max(0, parseInt(keepInput.value, 10) || 0));
      const lang = langSel.value as Lang;
      settings = { ...settings, closeAutoSave: closeAutoSaveCb.checked, columnMarkers: cols, autoSaveSec: as, autoSaveTarget: targetSel.value as 'sidecar' | 'file', backupKeep: bk, backupEnabled: backupCb.checked, language: lang };
      settings = { ...settings, readOnlyMode: roInput.checked };
      if (currentView instanceof EditView || currentView instanceof LivePreviewView) currentView.setReadOnly(roInput.checked);
      sbLayoutKey = '\u0000readonly'; renderStatus();
      setSaveDefaults({ backupKeep: backupCb.checked ? bk : 0 });
      const diffKeys = ['add', 'del', 'chg'] as const;
      const dc: { add?: string; del?: string; chg?: string } = {};
      for (let i = 0; i < 3; i++) if (diffUse[i].checked) dc[diffKeys[i]] = diffPickers[i].value;
      settings = { ...settings, diffColors: Object.keys(dc).length ? dc : undefined };
      applyDiffColorOverride();
      settings = {
        ...settings,
        theme: themeSel.value as Settings['theme'],
        // defaultOpenMode 废止：不再下发（磁盘旧值读入即忽略）；mdDefaultMode 历史值 preview 随保存迁移 source
        mdDefaultMode: mdSel.value as Settings['mdDefaultMode'],
        outlineCur: outlineCb.checked ? outlinePick.value : undefined,
        lineHl: lineHlCb.checked ? lineHlPick.value : undefined,
        closeBehavior: closeSel.value as Settings['closeBehavior'],
        snapshotDir: snapshotDir || undefined,
      };
      applySavedTheme(settings);
      applyOutlineColorOverride();
      applyLineHlOverride();
      void settingsSave(settings as Record<string, unknown>);
      dlgMask?.close();
      updateMarkers();
      applyFontSize(Math.min(18, Math.max(10, parseInt(fsInput.value, 10) || 12)));
      if (lang !== getLang()) switchLanguage(lang);
      toolbarCtl?.refresh();
    });
    const card = (title: string, ...rows: HTMLElement[]): HTMLElement => {
      const box = document.createElement('section');
      box.className = 'set-card';
      box.append(grp(title), ...rows);
      return box;
    };
    body.append(
      card('set.grpAppearance', rowTheme, rowLineHl),
      card('set.grpEdit', rowReadOnly, rowFs, row1),
      card('set.grpMarkdown', rowMd),
      card('set.grpCompare', diffRow),
      card('set.grpOutline', rowOutline),
      card('set.grpBackup', row2, rowTarget, rowSnapDir, rowCloseAutoSave, rowBakOn, row3),
      card('set.grpAdvanced', rowLang, rowClose),
      btn
    );
    dlgMask = overlayDialog($t('set.title'), body, () => void 0);
    document.body.appendChild(dlgMask);
  }

  // ---- 自动保存与恢复快照调度（ADR 012 v2 / H-5 T10，逻辑在 shell/autosave.ts） ----
  // sidecar（出厂）：自动保存写恢复快照旁路，原文件仅在 Ctrl+S / 三键确认 / 关闭确认时写；
  // file：直写原文件（显式选项）。R5 确认挂起期间暂停（防架空「放弃修改」）。
  // P3-25 灾备可观测：超限跳过 / 总量淘汰的提示判决在 recovery-hints.ts（超限只提示一次，
  // 写入成功复位；心跳式快照不得反复刷屏）
  let snapHints = INITIAL_SNAP_HINTS;
  const writeSnapshot = (path: string, content: string, draft: boolean): void => {
    if (!draft) {
      // 切换/关闭后重挂时经 recoveryPending 还原内容（sidecar 的内存侧）
      recoveryPending.set(path, { content, diskChanged: false });
    }
    void recoverySnapshot(
      path,
      content,
      draft ? 0 : (fileMtimes.get(path) ?? 0),
      draft ? 0 : (fileSizes.get(path) ?? 0),
      draft
    )
      .then(out => {
        if (!out) return;
        const h = snapshotHint(out, snapHints);
        snapHints = h.state;
        if (h.key) flash(h.arg === undefined ? $t(h.key) : $tf(h.key, h.arg));
      })
      .catch(e => {
        console.warn('Recovery snapshot failed', e);
        flash($tf('snapshot.failed', String(e)));
      });
  };
  startAutosaveTimers({
    saveEpoch: () => saveEpochByPath.get(store.active()?.path ?? '') ?? 0,
    getSettings: () => settings.readOnlyMode ? { ...settings, autoSaveTarget: 'sidecar' } : settings,
    activeInfo: () => {
      const tab = store.active();
      if (!tab) return null;
      if (isVirtualTab(tab.path)) return null;
      return { path: tab.path, draft: tab.path.startsWith('draft://') };
    },
    isDirty: () =>
      (currentView instanceof EditView && !!editStatus?.dirty) ||
      (currentView instanceof LivePreviewView && wysiwygDirty),
    content: () =>
      currentView instanceof EditView
        ? currentView.snapshotContent()
        : currentView instanceof LivePreviewView
          ? currentView.snapshotContent()
          : '',
    contentRevision: () =>
      currentView instanceof EditView
        ? currentView.contentRevision()
        : currentView instanceof LivePreviewView
          ? currentView.contentRevision()
          : 0,
    // P2：大文档快照降频的体量判据（廉价估计，1.5s 心跳里绝不全文序列化）
    sizeHint: () =>
      currentView instanceof EditView
        ? currentView.contentSizeHint()
        : currentView instanceof LivePreviewView
          ? currentView.contentSizeHint()
          : 0,
    snapshot: writeSnapshot,
    saveNow: () => saveDirtyIfAny(false),
    onFileSaved: () => flash($t('msg.autoSaved')),
    onSaveFailed: () => flash($t('msg.autoSaveFail')),
    isSwitchPending: () => false, // 切换免确认，不再有挂起的 IR 切换决策。
  });

  // ---- 全局快捷键 / 拖放 / CLI（H-5 T8：和弦查表统一派发，单一来源 = ActionDef.shortcut；
  // 此处只做焦点守卫与少数事件语义特例，if/else 链已删） ----
  document.addEventListener('keydown', e => {
    if (isCompositionKey(e)) return;
    // 焦点守卫：对话框/命令面板/右键菜单内不响应全局快捷键（防输入框里 Ctrl+W 关标签等）
    const ae = document.activeElement;
    const inOverlay = !!(ae && ae.closest('.ov-mask, .cmd-overlay, .ctx-menu, .menu-dropdown'));
    if (inOverlay) return;
    const inEditor = !!(ae && ae.closest('.cm-editor')); // v0.16：IR 也是 CM6，编辑器焦点判定收窄到 .cm-editor
    // 菜单助记键（001 规则 19 v1.2）：Alt+F/E/S/V/T/H 打开对应菜单（无 Ctrl/Shift）
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
      const mi = { KeyF: 0, KeyE: 1, KeyS: 2, KeyV: 3, KeyT: 4, KeyH: 5 }[e.code];
      if (mi != null) {
        e.preventDefault();
        menubarCtl?.open(mi);
        return;
      }
    }
    // 事件语义特例（不可表驱动）：Tab 系 / PageUp/Down / F11 / 编辑器内交还编辑器的组合键
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      activateMruNext();
      return;
    }
    if (e.ctrlKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      e.preventDefault();
      if (store.tabs.length > 1) {
        const d = e.key === 'PageDown' ? 1 : -1;
        store.activate((store.activeIndex + d + store.tabs.length) % store.tabs.length);
      }
      return;
    }
    if (e.key === 'F11') {
      // F11 = 窗口最大化/还原（002 规则 20 v1.3；纯 Web 开发模式回退浏览器全屏）
      e.preventDefault();
      if ('__TAURI_INTERNALS__' in window) {
        void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().toggleMaximize());
      } else if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void document.documentElement.requestFullscreen();
      }
      return;
    }
    // 编辑器内交还编辑器的组合：CM6 键位自带（Ctrl+S 保存 / Ctrl+B 加粗 / Ctrl+F 查找均就地承载）
    if (inEditor) {
      const k = e.key.toLowerCase();
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (k === 's' || k === 'b' || k === 'h')) return;
      // Ctrl+F：CM6 自带 Mod-f；IR 态切源码视图承载查找（R6）
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'f') {
        e.preventDefault();
        if (currentView instanceof LivePreviewView) irFind();
        return;
      }
    }
    // 表驱动派发（Ctrl+N/O/S/W/…、Alt+Z/C、F5、Ctrl+=/-/0、Ctrl+, 等）
    if (reg.dispatch(e)) e.preventDefault();
  });

  // 剪贴板贴图：md 可编辑上下文含图片即拦；本地保存不依赖图床配置。
  document.addEventListener('paste', e => {
    const ae = document.activeElement;
    if (ae && ae.closest('.ov-mask, .ctx-menu, .cmd-overlay, .menu-dropdown')) return; // 对话框/菜单内不劫持
    const target = e.target as HTMLElement | null;
    if (!target?.closest?.('.cm-editor')) return; // 仅 md 编辑器内（源码/分屏左/即时渲染同为 CM6）
    const t = activeTab();
    if (!mdEditableContext(t)) return;
    const dt = e.clipboardData;
    const f = dt ? clipboardImageOf(dt) : null;
    if (!f) return; // 非图片剪贴板：交回默认粘贴
    e.preventDefault();
    e.stopPropagation(); // 捕获阶段接管，避免 CM6 默认粘贴重复插入文本
    void ingestImageBytes(t!, async () => [await ensureImagehost().then(m => m.readImageFile(f))]);
  }, true);

  // 拖放（001 规则 9 v1.3）：文件打开；文件夹路由为「打开文件夹」（树根切换，不再报错）。
  // 009 规则 4 触发②：全为图片文件且落在 md 可编辑上下文 → 图床/本地入稿（混合拖放走原打开逻辑）
  void listen<{ paths: string[] }>('tauri://drag-drop', ev => {
    hideDropOverlay();
    const paths = ev.payload.paths;
    if (dropImagesIntoMd(paths)) return;
    for (const p of paths) {
      void fileStat(p)
        .then(async st => {
          if (st.isDir && !await dlgConfirm($tf('msg.confirmDropFolder', p))) return;
          await openPath(p, undefined, st.isDir);
        })
        .catch(() => openPath(p));
    }
  });

  /** 触发②拦截判定（009 规则 4：全图才拦；非 md 上下文不拦——图片走 image 路由打开） */
  function dropImagesIntoMd(paths: string[]): boolean {
    if (paths.length === 0) return false;
    const t = activeTab();
    if (!mdEditableContext(t)) return false;
    if (!paths.every(p => mimeOfPath(p))) return false;
    void ingestImageBytes(t!, async () => {
      const out: Array<{ bytes: Uint8Array; mime: string; name: string }> = [];
      for (const p of paths) {
        const b64 = await fontRead(p); // 32MB 读上限；>20MB 由上传分支 E6003 前置拒绝
        out.push({
          bytes: Uint8Array.from(atob(b64), c => c.charCodeAt(0)),
          mime: mimeOfPath(p)!,
          name: p.split(/[\\/]/).pop() ?? 'image',
        });
      }
      return out;
    });
    return true;
  }
  // 悬停遮罩反馈（drag-enter 出现 / drag-leave、drop 消失）
  let dropOverlay: HTMLDivElement | null = null;
  function hideDropOverlay(): void {
    dropOverlay?.remove();
    dropOverlay = null;
  }
  function showDropOverlay(): void {
    if (dropOverlay) return;
    dropOverlay = document.createElement('div');
    dropOverlay.className = 'drop-overlay';
    dropOverlay.textContent = $t('msg.dropOverlay');
    document.body.appendChild(dropOverlay);
  }
  void listen('tauri://drag-enter', () => showDropOverlay());
  void listen('tauri://drag-leave', () => hideDropOverlay());
  const openCliFiles = (files: string[]): void => {
    for (const f of files) {
      // 支持 `path:line`（001 规则 10；Windows 盘符不受影响——`:数字` 只出现在路径尾）
      const m = /^(.+):(\d+)$/.exec(f);
      void openPath(m ? m[1] : f, m ? parseInt(m[2], 10) : undefined);
    }
  };
  void onCliOpen(openCliFiles);

  // ---- 启动序列（各步独立容错：设置/会话损坏或非 Tauri 环境不阻断启动，001 异常处理） ----
  const [loadedSettings, loadedSession, loadedNamedSessions, loadedHome] = await Promise.all([
    settingsLoad().catch(() => ({}) as Settings),
    loadSession().catch(() => null),
    namedSessionsLoad().catch(() => ({})),
    homeDir().catch(() => 'C:\\'),
  ]);
  settings = { ...DEFAULT_SETTINGS, ...loadedSettings };
  // 窗口几何独立容错；物理像素记录，恢复时限制在当前屏幕工作区。
  void (async () => {
    const { getCurrentWindow, currentMonitor, primaryMonitor, PhysicalSize, PhysicalPosition } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const rect = (settings as Record<string, unknown>).winRect as { width: number; height: number; x: number; y: number } | undefined;
    if (rect && [rect.width, rect.height, rect.x, rect.y].every(Number.isFinite) && rect.width > 0 && rect.height > 0) {
      const monitor = await currentMonitor() ?? await primaryMonitor();
      if (monitor) {
        const area = monitor.workArea;
        const width = Math.min(Math.max(320, rect.width), area.size.width);
        const height = Math.min(Math.max(240, rect.height), area.size.height);
        const x = Math.max(area.position.x, Math.min(rect.x, area.position.x + area.size.width - width));
        const y = Math.max(area.position.y, Math.min(rect.y, area.position.y + area.size.height - height));
        await win.setSize(new PhysicalSize(width, height));
        await win.setPosition(new PhysicalPosition(x, y));
      }
    }
    let rectTimer: ReturnType<typeof setTimeout> | undefined;
    const remember = () => {
      clearTimeout(rectTimer);
      rectTimer = setTimeout(() => {
        void Promise.all([win.innerSize(), win.outerPosition(), win.isMaximized(), win.isMinimized()]).then(([size, pos, maximized, minimized]) => {
          if (maximized || minimized) return;
          Object.assign(settings, { winRect: { width: size.width, height: size.height, x: pos.x, y: pos.y } });
          settingsSave();
        }).catch(() => undefined);
      }, 400);
    };
    await win.onResized(remember);
    await win.onMoved(remember);
  })().catch(() => undefined);
  // 旧版本曾把 S3 凭据明文写入 settings.json；启动后立即用剔除凭据的配置重写一次。
  // 兜底 null（验收缺陷 D1：后端设置文件缺失时曾返回 null，此处解引用使首启崩溃）
  if (loadedSettings?.s3Credentials) settingsSave(settings);
  setSaveDefaults({ backupKeep: settings.backupEnabled === false ? 0 : settings.backupKeep ?? 3 });
  // P3-30 语言真相源：settings.language 为准（localStorage 仅是启动早期缓存）；不一致时
  // 此处早于会话恢复与视图挂载，只需重建已挂载的 chrome/侧栏静态文案
  if (syncLangFromSettings(settings.language)) {
    mountChrome();
    mountSidebar();
    sbLayoutKey = '\u0000';
  }
  applySavedTheme(settings);
  // 007 规则 20 v2.1（2026-10 用户定稿）：--md-fs-user 派生 --md-fs-base，
  // Markdown 渲染正文随编辑区字号等比缩放（预览/IR/分屏三形态一致）
  syncMdFontSize();
  applyDiffColorOverride(); // 批 F：差异配色自定义覆盖
  applyOutlineColorOverride(); // 批 G：大纲高亮色自定义覆盖
  applyLineHlOverride(); // P3：当前行高亮色覆盖（反馈 14）
  // C-3 本地字体重注册：启动按 localFontPath 重注册；失败静默回退捆绑栈
  if (settings.editorFont === 'local' && settings.localFontPath) {
    void registerLocalFont(settings.localFontPath).then(ok => { if (ok) applyEditorFontOverride(); });
  }
  namedSessions = loadedNamedSessions;
  registerSessionActions();
  try {
    const session = loadedSession ?? { tabs: [], activeIndex: 0 };
    if (store.restore(session) === 0) render();
    bumpDraftSeqFromStore(); // v2.5：会话恢复后草稿序号取历史最大续排（防 Ctrl+N 撞号）
  } catch {
    render();
  }
  window.addEventListener('beforeunload', () => {
    if (saveTimer) clearTimeout(saveTimer);
    void saveSession(captureDrafts(store.session()));
  });

  homeDirCached = loadedHome;
  // 会话恢复已经完成。文件首屏不必等待侧栏磁盘枚举与最近列表；避免慢目录拖住CLI打开。
  void cliTakePending()
    .then(files => { if (files.length) openCliFiles(files); })
    .catch(err => console.warn('读取待打开文件失败', err));
  // 目录跟随（001 规则 25）：会话恢复的活动标签决定树的根并定位；无则空态
  const restored = store.active();
  if (restored && isRealFilePath(restored.path)) localRoot = normLocal(dirOf(restored.path));
  // ---- 崩溃恢复（002 规则 29）：上次异常退出 + 存在脏缓冲快照 → 恢复对话框 ----
  void checkCrashRecovery();
  // ---- 退出守卫（002 规则 29）：窗口关闭统一拦截（脏标签确认；全净则清快照放行） ----
  void installCloseGuard();
  showWelcomeOnce();

  // Directory enumeration and recents are secondary startup work. Keep session
  // restore, CLI opens, recovery and the first usable window independent of them.
  const startupTree = (async () => {
    await rebuildTree();
    // tree 由 rebuildTree（闭包）赋值，流分析无法感知，显式放宽类型
    if (localRoot && restored && store.active() === restored) await (tree as FileTree | null)?.reveal(restored.path);
  })();
  void Promise.all([startupTree, refreshRecents()]).catch(err => console.warn('启动侧栏加载失败', err));

  /** H-4：首启欢迎页（一次性）——品牌标 + 三条亮点 + 开始使用 */
  function showWelcomeOnce(): void {
    const KEY = 'ZiEdit-welcomed-v1';
    try {
      if (localStorage.getItem(KEY)) return;
      localStorage.setItem(KEY, '1');
    } catch {
      return; // localStorage 不可用（极端隐私模式）不打扰启动
    }
    const body = document.createElement('div');
    body.className = 'welcome-box';
    const logo = document.createElement('span');
    logo.className = 'welcome-logo';
    logo.innerHTML = brandSvg();
    body.appendChild(logo);
    const h = document.createElement('h3');
    h.textContent = $t('welcome.title');
    body.appendChild(h);
    const p = document.createElement('p');
    p.textContent = $t('welcome.p1');
    body.appendChild(p);
    const ul = document.createElement('ul');
    for (const k of ['welcome.li1', 'welcome.li2', 'welcome.li3']) {
      const li = document.createElement('li');
      li.textContent = $t(k);
      ul.appendChild(li);
    }
    body.appendChild(ul);
    const row = document.createElement('div');
    row.className = 'ov-row';
    const ok = document.createElement('button');
    ok.className = 'dlg-btn primary';
    ok.textContent = $t('welcome.start');
    ok.addEventListener('click', () => (ok.closest('.ov-mask') as OverlayMask | null)?.close());
    row.appendChild(ok);
    body.appendChild(row);
    document.body.appendChild(overlayDialog($t('welcome.title'), body, () => void 0));
  }

  /** 恢复检查：读快照列表，异常退出且非空时弹对话框（逐项勾选/全选/全部丢弃） */
  async function checkCrashRecovery(): Promise<void> {
    let list: { crashed: boolean; items: RecoveryItem[] } | null = null;
    try {
      list = await recoveryList();
    } catch {
      return; // 非 Tauri 环境（纯浏览器 dev）无恢复通道
    }
    if (!list || !list.crashed || list.items.length === 0) return;
    const checks = new Map<string, boolean>(list.items.map(it => [it.key, true]));
    const body = document.createElement('div');
    body.className = 'ov-body';
    const info = document.createElement('p');
    info.style.cssText = 'color:var(--muted);font-size:12px';
    info.textContent = $t('rec.intro');
    body.appendChild(info);
    for (const it of list.items) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.addEventListener('change', () => checks.set(it.key, cb.checked));
      const name = document.createElement('span');
      name.textContent = it.draft ? $tf('rec.draftItem', new Date(it.ts).toLocaleTimeString()) : it.key.split(/[\\/]/).pop() ?? it.key;
      const meta = document.createElement('span');
      meta.style.cssText = 'color:var(--faint);font-size:11px';
      meta.textContent = `${fmtSize(it.bytes)} · ${new Date(it.ts).toLocaleTimeString()}`;
      label.append(cb, name, meta);
      label.title = it.draft ? it.key : it.key;
      body.appendChild(label);
    }
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px';
    let dlgMask: OverlayMask | null = null;
    const mk = (labelKey: string, primary: boolean, fn: () => void) => {
      const b = document.createElement('button');
      b.className = 'dlg-btn' + (primary ? ' primary' : '');
      b.textContent = $t(labelKey);
      b.addEventListener('click', () => {
        dlgMask?.close();
        fn();
      });
      row.appendChild(b);
    };
    mk('rec.discardAll', false, () => {
      void recoveryDiscard(list.items.map(i => i.key)).catch(() => void 0);
    });
    mk('rec.restore', true, () => {
      void (async () => {
        const picked = list.items.filter(i => checks.get(i.key));
        void recoveryDiscard(list.items.filter(i => !checks.get(i.key)).map(i => i.key)).catch(() => void 0);
        for (const it of picked) {
          try {
            const rec = await recoveryRead(it.key);
            if (!rec) continue;
            if (it.draft) {
              newDraft(rec.content);
              void recoveryDiscard([it.key]).catch(() => void 0); // F8（审计）：恢复即弃旧草稿快照，防下次崩溃重复出现
              continue;
            }
            const st = await fileStat(it.key).catch(() => null);
            // F13（审计）：快照基线缺失（0=写入时未取到元信息）不误报「磁盘已变化」
            const known = rec.mtime > 0 && rec.len > 0;
            const diskChanged = !st || (known && (st.modifiedMs !== rec.mtime || st.len !== rec.len));
            recoveryPending.set(it.key, { content: rec.content, diskChanged });
            editorBuffers.delete(it.key); // 快照优先于会话恢复时已挂载/缓存的磁盘文本
            modeMap.set(it.key, 'edit'); // F8（审计）：恢复内容必须落进可编辑面——表格/流式形态不消费 pending 会静默丢恢复（超 10MB 仍回查看面，属能力边界）
            if (activeTab()?.path === it.key) currentViewKey = '\u0000recovery';
            // 打开（打开即编辑路径会把 modeMap 置 edit；恢复内容经 recoveryPending 注入缓冲并标脏）
            await openPath(it.key, undefined, false, { syncTree: false });
          } catch {
            /* 单项恢复失败不阻断其余 */
          }
        }
        flash($t('rec.restored'));
      })();
    });
    body.appendChild(row);
    dlgMask = overlayDialog($t('rec.title'), body, () => void 0);
    document.body.appendChild(dlgMask);
  }

  /** 退出守卫（ADR 015 / 002 规则 29 v2.3）：标题栏 × / 文件菜单退出 / Alt+F4 / 托盘「退出」
   *  四个入口全部收敛到 handleExitRequest 单一判决——
   *    有脏标签 → 多文件脏标签清单（勾选保存/放弃全部/取消），任何 closeBehavior 都先走这条（安全底线）；
   *    无脏 → effectiveCloseAction：exit → 退出流；tray → window.hide()（不清快照，进托盘不是退出）；
   *           ask 无记忆 → 「退出 / 最小化到托盘」选择框（带记住勾选，勾选写 rememberedCloseAction）。
   *  onCloseRequested 一律 preventDefault，destroy 全走本守卫 exitNow（防前端 API 自行 destroy
   *  与本判决双轨；capabilities 已含 allow-destroy/allow-hide，P0/P1 补齐）。
   *  托盘侧只 emit('ziedit://tray-quit') 不自行退出（Rust 不成为第二判决点）。 */
  async function installCloseGuard(): Promise<void> {
    if (!('__TAURI_INTERNALS__' in window)) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const dirtyTabList = () => store.tabs.filter(t => dirtyPaths.get(t.path) === true);
      /** 真正退出：内存 pending 与盘上快照一并清（对照 closeTabGuarded 的 T10 模式），再 destroy */
      const exitNow = (): void => {
        if (saveTimer) clearTimeout(saveTimer);
        const session = captureDrafts(store.session());
        for (const t of dirtyTabList()) recoveryPending.delete(t.path);
        void recoveryClear().catch(() => void 0);
        void saveSession(session).then(() => getCurrentWindow().destroy()).catch(err => flash(String(err)));
      };
      const hideToTray = (): void => {
        void getCurrentWindow().hide().catch(() => void 0);
      };
      /** 关闭方式选择框（ask 且无记忆时） */
      const showAskCloseDialog = (): void => {
        const body = document.createElement('div');
        body.className = 'ov-body';
        const p = document.createElement('p');
        p.textContent = $t('exit.askMsg');
        body.appendChild(p);
        const rememberRow = document.createElement('label');
        rememberRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px;cursor:pointer';
        const rememberCb = document.createElement('input');
        rememberCb.type = 'checkbox';
        const rememberTxt = document.createElement('span');
        rememberTxt.textContent = $t('exit.remember');
        rememberRow.append(rememberCb, rememberTxt);
        body.appendChild(rememberRow);
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px';
        let dlgMask: OverlayMask | null = null;
        const mk = (labelKey: string, primary: boolean, fn: () => void) => {
          const b = document.createElement('button');
          b.className = 'dlg-btn' + (primary ? ' primary' : '');
          b.textContent = $t(labelKey);
          b.addEventListener('click', () => {
            dlgMask?.close();
            fn();
          });
          row.appendChild(b);
        };
        const apply = (action: 'exit' | 'tray'): void => {
          if (rememberCb.checked) {
            settings = { ...settings, rememberedCloseAction: action };
            void settingsSave(settings as Record<string, unknown>);
          }
          if (action === 'exit') exitNow();
          else hideToTray();
        };
        mk('common.cancel', false, () => void 0);
        mk('exit.toTray', false, () => apply('tray'));
        mk('exit.exitNow', true, () => apply('exit'));
        body.appendChild(row);
        dlgMask = overlayDialog($t('exit.askTitle'), body, () => void 0);
        document.body.appendChild(dlgMask);
      };
      /** 多文件脏标签清单：勾选保存（默认全选）/ 放弃全部 / 取消（002 规则 29 v2.3） */
      const showDirtyExitDialog = (): void => {
        const dirtyTabs = dirtyTabList();
        if (closeActionFor(dirtyTabs.length > 0, settings.closeAutoSave) === 'save') {
          void (async () => {
            for (const tab of dirtyTabs) {
              if (closeActionFor(true, true, await saveDirtyTab(tab.path)) !== 'close') return;
            }
            exitNow();
          })();
          return;
        }
        const checks = new Map<string, boolean>(dirtyTabs.map(t => [t.path, true]));
        const body = document.createElement('div');
        body.className = 'ov-body';
        const hint = document.createElement('p');
        hint.style.cssText = 'color:var(--muted);font-size:12px';
        hint.textContent = $t('exit.dirtyHint');
        body.appendChild(hint);
        for (const t of dirtyTabs) {
          const label = document.createElement('label');
          label.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = true;
          cb.addEventListener('change', () => checks.set(t.path, cb.checked));
          const name = document.createElement('span');
          name.textContent = t.path.split(/[\\/]/).pop() ?? t.path;
          const meta = document.createElement('span');
          meta.style.cssText = 'color:var(--faint);font-size:11px';
          meta.textContent = dirOf(t.path);
          label.append(cb, name, meta);
          label.title = t.path;
          body.appendChild(label);
        }
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px';
        let dlgMask: OverlayMask | null = null;
        const mk = (labelKey: string, primary: boolean, fn: () => void) => {
          const b = document.createElement('button');
          b.className = 'dlg-btn' + (primary ? ' primary' : '');
          b.textContent = $t(labelKey);
          b.addEventListener('click', () => {
            dlgMask?.close();
            fn();
          });
          row.appendChild(b);
        };
        mk('common.cancel', false, () => void 0);
        mk('exit.discardExit', false, exitNow);
        mk('exit.saveChecked', true, () => {
          void (async () => {
            for (const t of dirtyTabs.filter(x => checks.get(x.path))) {
              const ok = await saveDirtyTab(t.path);
              if (!ok) {
                flash($tf('save.failQuit', t.path.split(/[\\/]/).pop() ?? t.path));
                return; // 保存失败/取消另存：中止退出，标签保留（已保存的照常生效）
              }
            }
            exitNow();
          })();
        });
        body.appendChild(row);
        dlgMask = overlayDialog($t('exit.dirtyTitle'), body, () => void 0);
        document.body.appendChild(dlgMask);
      };
      const handleExitRequest = (): void => {
        if (dirtyTabList().length > 0) {
          showDirtyExitDialog();
          return;
        }
        recoveryPending.clear(); // 全净：内存 pending 清空（盘上快照由 exitNow 清；tray 分支保留快照继续节拍）
        const action = effectiveCloseAction(settings.closeBehavior, settings.rememberedCloseAction);
        if (action === 'exit') exitNow();
        else if (action === 'tray') hideToTray();
        else showAskCloseDialog();
      };
      await getCurrentWindow().onCloseRequested(e => {
        e.preventDefault(); // 判决统一在本守卫（exitNow 自行 destroy），防与前端 API 自行 destroy 双轨
        handleExitRequest();
      });
      // 托盘「退出」（ADR 015）：Rust 只 emit，前端走与点 × 完全相同的判决
      void listen('ziedit://tray-quit', () => handleExitRequest());
    } catch {
      /* 非 Tauri 环境无窗口 API */
    }
  }
}

export { fmtSize };
