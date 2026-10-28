// 前后端共享类型与 Tauri IPC 封装（命名与 PRD 术语表对齐）
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type ViewRoute = 'text' | 'image';

export interface DirEntry {
  name: string;
  isDir: boolean;
  len: number;
  route: ViewRoute;
  language: string | null;
}

export interface OpenedInfo {
  path: string;
  len: number;
  route: ViewRoute;
  language: string | null;
  modifiedMs: number;
  readonly: boolean;
}

export interface TabState {
  path: string;
  route: ViewRoute;
  language: string | null;
  scroll: number;
  bookmarks?: number[];
}

export interface SessionState {
  tabs: TabState[];
  activeIndex: number;
}

export type EncodingSource = 'bom' | 'declaration' | 'heuristic' | 'fallback';

export interface EncodingInfo {
  name: string;
  source: EncodingSource;
  verified: boolean;
}

export interface TextOpenResult {
  path: string;
  len: number;
  encoding: EncodingInfo;
  /** 换行类型（主类型）：crlf / lf / cr / none */
  newline: string;
  /** 是否混合行尾（次类占比 ≥2%；保存按主类型统一并提示） */
  mixed: boolean;
  totalLines: number;
  indexReady: boolean;
}

export interface TextLine {
  no: number;
  text: string;
}

export interface FindHit {
  line: number;
  col: number;
}

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const listDir = (path: string) => invoke<DirEntry[]>('read_dir', { path });
export const openFile = (path: string) => invoke<OpenedInfo>('open_file', { path });

/** 轻量文件状态（001 规则 29 外部修改检测轮询） */
export interface FileStatResult {
  len: number;
  modifiedMs: number;
  isDir: boolean;
}
export const fileStat = (path: string) => invoke<FileStatResult>('file_stat', { path });
/** 树轻量管理（001 规则 28；冲突返回错误串 EXISTS/NOT_FOUND） */
export const fileCreate = (path: string) => invoke<void>('file_create', { path });
export const dirCreate = (path: string) => invoke<void>('dir_create', { path });
export const fileRename = (from: string, to: string) => invoke<void>('file_rename', { from, to });
export const loadSession = () => invoke<SessionState>('session_load');
export const saveSession = (session: SessionState) => invoke<void>('session_save', { session });
/** text_open 结果按路径备忘（性能：打开链上 app 与 edit 视图对同一文件重复 text_open 去重，
 *  并发调用共享同一 Promise）。
 *  备忘只对「打开事务内」的重复探测有意义，磁盘/索引状态演进必须失效——
 *  text_refresh（外部修改重载、尾随台每轮轮询）、text_close（标签关闭/重开）、
 *  text-index 事件（后台索引完成，totalLines/indexReady 才是终值）三类在封装层直接失效，
 *  保存落盘/编码切换由调用方经 textOpenMemoInvalidate 清除；
 *  显式指定 encodingName 的探测不进备忘（结果不同）。 */
const textOpenMemo = new Map<string, Promise<TextOpenResult>>();
export function textOpenMemoInvalidate(path: string): void {
  textOpenMemo.delete(path);
}
export const textOpen = (path: string, encodingName?: string): Promise<TextOpenResult> => {
  if (encodingName !== undefined) return invoke<TextOpenResult>('text_open', { path, encodingName });
  let p = textOpenMemo.get(path);
  if (!p) {
    p = invoke<TextOpenResult>('text_open', { path, encodingName: null });
    textOpenMemo.set(path, p);
    p.catch(() => textOpenMemo.delete(path)); // 失败不驻留，下次调用重试
  }
  return p;
};
export const textClose = (path: string) => {
  textOpenMemo.delete(path); // 句柄关闭：备忘的元数据随缓存一并作废（重开重新探测）
  return invoke<void>('text_close', { path });
};
export const textLines = (path: string, from: number, to: number, encodingName?: string) =>
  invoke<TextLine[]>('text_lines', { path, from, to, encodingName: encodingName ?? null });
export interface TextLineSegment {
  no: number;
  offset: number;
  nextOffset: number | null;
  totalBytes: number;
  text: string;
}
export const textLineSegment = (
  path: string,
  line: number,
  offset: number,
  maxBytes = 256 * 1024,
  encodingName?: string,
) => invoke<TextLineSegment>('text_line_segment', {
  path, line, offset, maxBytes, encodingName: encodingName ?? null,
});
export interface FindResult {
  hit: FindHit | null;
  /** 全文命中总数（未请求计数为 null） */
  total: number | null;
  /** 命中之前的匹配数（"第 N 处" = before + 1；未计数为 null） */
  before: number | null;
}

export const textFind = (
  path: string,
  needle: string,
  opts: FindOptions,
  fromLine: number,
  wantCount = false,
  backward = false
) =>
  invoke<FindResult>('text_find', { path, needle, opts, fromLine, wantCount, backward });

export interface TextRefreshResult {
  len: number;
  changed: boolean;
}

export const textRefresh = (path: string) => {
  textOpenMemo.delete(path); // 换缓存/重建索引前的快照不再可信：尾随台轮询（refresh→open）必须读到新值
  return invoke<TextRefreshResult>('text_refresh', { path });
};

export interface TextIndexEvent {
  path: string;
  totalLines?: number;
  error?: string;
}

export const onTextIndex = (handler: (e: TextIndexEvent) => void): Promise<UnlistenFn> =>
  listen<TextIndexEvent>('text-index', ev => {
    // 后台索引完成：totalLines/indexReady 终值就位——作废该路径的 text_open 备忘，
    // 后续读取（尾随台下一轮轮询、重挂探测）拿到真实行数而非打开瞬间的旧值
    textOpenMemo.delete(ev.payload.path);
    handler(ev.payload);
  });

// ---- M4b/M5 扩展 ----
export const textReadAll = (path: string, encodingName?: string) =>
  invoke<string>('text_read_all', { path, encodingName: encodingName ?? null });
/** 保存默认值（app 启动/设置变更时经 setSaveDefaults 注入，编辑缓冲与 WYSIWYG 两条保存路径共用） */
const saveDefaults = { backupKeep: 3 };
export function setSaveDefaults(d: Partial<typeof saveDefaults>): void {
  Object.assign(saveDefaults, d);
}
/** 保存落盘基线（A-11）：成功即返回——前端同步立大小/修改时间基线，消除轮询 TOCTOU 窗口 */
export interface SaveStat {
  len: number;
  modifiedMs: number;
}
export const textSave = (path: string, content: string, encodingName: string, backupKeep = saveDefaults.backupKeep) =>
  invoke<SaveStat>('text_save', { path, content, encodingName, backupKeep });
export const backupDir = () => invoke<string>('backup_dir');
/** 打开日志目录（H-4：OS 日志目录，经系统文件管理器展示） */
export const openLogDir = () => invoke<null>('open_log_dir');
/** 用系统默认程序打开任意用户路径（P0-3/RL-1：Rust 侧直调 opener，不走前端 open-path 权限面） */
export const openWithDefault = (path: string) => invoke<null>('open_with_default', { path });
/** 在系统文件管理器中定位（同 P0-3：Rust 侧直调） */
export const revealInDir = (path: string) => invoke<null>('reveal_in_dir', { path });
/** 放行 asset 协议目录（H-5 T9：scope 收紧为空，打开图片/md 前按文件目录动态放行） */
export const allowAssetDir = (dir: string) => invoke<null>('allow_asset_dir', { dir });
export const allowAssetFile = (path: string) => invoke<null>('allow_asset_file', { path });
export const formatJson = (text: string) => invoke<string>('format_json', { text });
export const formatXml = (text: string) => invoke<string>('format_xml', { text });
export const checksum = (path: string, algo: 'crc32' | 'md5' | 'sha1' | 'sha256') =>
  invoke<string>('checksum', { path, algo });

/** 扩展名 → 系统关联图标 data URL（001 规则 15，P2/W2 清偿）。
 *  按扩展名取一次（前端缓存）；无关联或非 Windows 返回 null，回退通用 SVG 图标。 */
export const treeFileIcon = (ext: string) => invoke<string | null>('tree_file_icon', { ext });
export const deleteToTrash = (path: string) => invoke<void>('delete_to_trash', { path });

export interface FifHit {
  line: number;
  col: number;
  text: string;
}
export interface FifFile {
  path: string;
  hits: FifHit[];
}
export interface FifResult {
  files: FifFile[];
  scanned: number;
  skipped: { path: string; reason: string }[];
  skippedCount: number;
  limits: string[];
  cancelled: boolean;
}
export const findInFiles = (
  root: string,
  needle: string,
  opts: FindOptions,
  jobId: string,
  glob = '*'
) => invoke<FifResult>('find_in_files', { root, needle, opts, jobId, glob, maxFiles: null });
export const findCancel = (jobId: string) => invoke<void>('find_cancel', { jobId });

// ---- 最近列表与收藏（001 规则 20 v1.1：四页签侧栏；is_dir 由后端读取时现算）----
export interface RecentEntry {
  path: string;
  isDir: boolean;
}
export interface FavGroupView {
  name: string;
  items: RecentEntry[];
}
export interface FavoritesView {
  items: RecentEntry[];
  groups: FavGroupView[];
}
export const recentList = () => invoke<RecentEntry[]>('recent_list');
export const recentAdd = (path: string) => invoke<void>('recent_add', { path });
export const recentRemove = (paths: string[]) => invoke<void>('recent_remove', { paths });
export const recentClear = () => invoke<void>('recent_clear');
export const favoritesList = () => invoke<FavoritesView>('favorites_list');
export const favoritesToggle = (path: string) =>
  invoke<FavoritesView>('favorites_toggle', { path });
export const favoritesGroupAdd = (name: string) =>
  invoke<FavoritesView>('favorites_group_add', { name });
export const favoritesGroupRemove = (name: string) =>
  invoke<FavoritesView>('favorites_group_remove', { name });
export const favoritesMove = (path: string, group: string | null) =>
  invoke<FavoritesView>('favorites_move', { path, group });

// ---- CSV 记录级解析（批 D-3，007：引号内嵌换行不拆记录）----
export interface CsvRecord {
  no: number;
  cells: string[];
}
export interface CsvRecordsResult {
  records: CsvRecord[];
  total: number;
  delimiter: string;
}
export const csvRecords = (
  path: string, from: number, to: number, delim: string, encodingName?: string
) => invoke<CsvRecordsResult>('csv_records', { path, from, to, delim, encodingName: encodingName ?? null });

export interface DocxOpenResult { paraCount: number; totalChars: number; truncated: boolean }
export interface DocxLinesResult { lines: TextLine[]; total: number }
export interface XlsxOpenResult { sheets: { name: string; rows: number }[]; truncated: boolean }
export interface XlsxRecordsResult { records: CsvRecord[]; total: number }
export const docxOpen = (path: string) => invoke<DocxOpenResult>('docx_open', { path });
export const pdfOpen = (path: string) => invoke<DocxOpenResult>('pdf_open', { path });
export const pdfLines = (path: string, from: number, to: number) => invoke<DocxLinesResult>('pdf_lines', { path, from, to });
export const docxLines = (path: string, from: number, to: number) => invoke<DocxLinesResult>('docx_lines', { path, from, to });
export const xlsxOpen = (path: string) => invoke<XlsxOpenResult>('xlsx_open', { path });
/** sheet is zero-based; record windows are one-based, inclusive. */
export const xlsxRecords = (path: string, sheet: number, from: number, to: number) =>
  invoke<XlsxRecordsResult>('xlsx_records', { path, sheet, from, to });
export const ooxmlClose = (path: string) => invoke<void>('ooxml_close', { path });

// ---- 深度对比（008，ADR 010）----
export interface CmpBlock {
  kind: 'equal' | 'replace' | 'delete' | 'insert';
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}
export interface CmpFileMeta {
  path: string;
  encoding: string;
  bom: string;
  /** 行尾类型（008 规则 5 v0.6）：LF/CRLF/CR/MIX/- */
  eol?: string;
  lines: number;
  len: number;
}
export interface CmpOpenResult {
  binary: boolean;
  inputState: { aMtimeMs: number; aSize: number; bMtimeMs: number; bSize: number };
  blocks: CmpBlock[];
  metaA: CmpFileMeta;
  metaB: CmpFileMeta;
  encMarksA: Array<[number, number]>;
  encMarksB: Array<[number, number]>;
  degraded: boolean;
}
export type CmpSpanCat = 'homoglyph' | 'normalize' | 'invisible' | 'whitespace' | 'content';
export interface CmpSpan {
  textA: string;
  textB: string;
  cat: CmpSpanCat;
  /** 等值分段（全行分段渲染：等值段纯文本） */
  eq?: boolean;
}
export interface CmpDetailLine {
  no: number;
  text: string;
  lineCat: 'encoding' | 'eol' | null;
  spans: CmpSpan[];
}
export interface NormalizeOpts {
  stripBom: boolean;
  nfc: boolean;
  newline: string | null;
  fullToHalf: boolean;
}

export const compareOpen = (a: string, b: string) => invoke<CmpOpenResult>('compare_open', { a, b });
export const compareDetail = (
  a: string, b: string, aFrom: number, aTo: number, bFrom: number, bTo: number
) => invoke<CmpDetailLine[][]>('compare_detail', { a, b, aFrom, aTo, bFrom, bTo });
export const normalizeSave = (src: string, dst: string, opts: NormalizeOpts, encodingName?: string) =>
  invoke<number>('normalize_save', { src, dst, opts, encodingName: encodingName ?? null });

/** 规范化预览（008 规则 12 v0.6）：按当前选项计算修复 diff 概要（计数+≤20 行样本），不落盘 */
export interface NormalizePreviewLine { line: number; before: string; after: string }
export interface NormalizePreviewResult { same: boolean; changed: number; added: number; removed: number; sample: NormalizePreviewLine[] }
export const normalizePreview = (src: string, opts: NormalizeOpts, encodingName?: string) =>
  invoke<NormalizePreviewResult>('normalize_preview', { src, opts, encodingName: encodingName ?? null });

/** 编码转换另存（002 规则 21a / 008 规则 13 v0.6）：原编码自动探测 → 目标编码写新文件 */
export const encodeConvertSave = (src: string, dst: string, toEnc: string) =>
  invoke<number>('encode_convert_save', { src, dst, toEnc });
/** 常用目标编码（encoding_rs 标签；UTF-8 恒不带 BOM——BOM 属元信息另由规范化另存处理） */
export const ENC_TARGETS = ['UTF-8', 'GBK', 'GB18030', 'UTF-16LE', 'UTF-16BE'] as const;

/** 冷启动 CLI 文件拉取（P5-6）：监听就绪后取走 Rust 暂存的 pending（一次性） */
export const cliTakePending = () => invoke<string[]>('cli_take_pending');

export const onCliOpen = (handler: (files: string[]) => void): Promise<UnlistenFn> =>
  listen<string[]>('cli-open', ev => handler(ev.payload));

// ---- 崩溃恢复（ADR 012 v2，002 规则 29）----
export interface RecoveryItem {
  key: string;
  ts: number;
  bytes: number;
  draft: boolean;
}
export interface RecoveryList {
  crashed: boolean;
  items: RecoveryItem[];
}
export interface RecoveryRecord {
  key: string;
  content: string;
  mtime: number;
  len: number;
  draft: boolean;
  ts: number;
}
/** 快照写入结果（P3-25 灾备可观测：skipped=超限未入快照 / evicted=本次淘汰的旧快照数） */
export interface SnapshotOutcome {
  skipped: boolean;
  evicted: number;
}
let recoveryQueue: Promise<unknown> = Promise.resolve();
/** 快照与弃快照按调用顺序执行，防保存成功后迟到的旧快照重新出现。 */
function recoveryCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const pending = recoveryQueue.then(() => invoke<T>(command, args));
  recoveryQueue = pending.catch(() => undefined);
  return pending;
}
export const recoverySnapshot = (
  key: string, content: string, mtime: number, len: number, draft: boolean
) => recoveryCommand<SnapshotOutcome>('recovery_snapshot', { key, content, mtime, len, draft });
export const recoveryList = () => recoveryCommand<RecoveryList>('recovery_list');
export const recoveryRead = (key: string) => recoveryCommand<RecoveryRecord | null>('recovery_read', { key });
export const recoveryDiscard = (keys: string[]) => recoveryCommand<void>('recovery_discard', { keys });
export const recoveryClear = () => recoveryCommand<void>('recovery_clear');

// ---- 命名会话与设置 ----
export const namedSessionsLoad = () =>
  invoke<Record<string, SessionState>>('named_sessions_load');
export const namedSessionsSave = (sessions: Record<string, SessionState>) =>
  invoke<void>('named_sessions_save', { sessions });
export const settingsLoad = () => invoke<Record<string, unknown>>('settings_load');
export const settingsSave = (settings: Record<string, unknown>) =>
  invoke<void>('settings_save', { settings });
/** 本地字体导入（C-3）：读字体文件返回 base64（Rust 侧 32MB 上限） */
export const fontRead = (path: string) => invoke<string>('font_read', { path });

// ---- 图床网络例外（009 / ADR 016：应用唯一两条出网命令 + 本地落盘辅助） ----

export interface S3PutRequest {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  key: string;
  contentBase64: string;
  contentType: string;
  addressStyle: 'path' | 'virtual-host';
  allowInsecure: boolean;
}
export interface S3PutResult {
  status: number;
  etag: string | null;
}
/** S3 兼容 PUT Object（SigV4 + UNSIGNED-PAYLOAD，仅用户配置端点；错误串 E6xxx 前缀） */
export const s3PutObject = (req: S3PutRequest) =>
  invoke<S3PutResult>('s3_put_object', { req });
export interface S3GetImageResult {
  mime: string;
  dataBase64: string;
  cached: boolean;
}
/** 图床公网基址图片取回（host 全等校验在 Rust 侧；磁盘缓存 256MB LRU） */
export const s3GetImage = (url: string, allowedBase: string) =>
  invoke<S3GetImageResult>('s3_get_image', { url, allowedBase });
/** 图片落盘（009 规则 4「保存为本地文件」分支；已存在报 EXISTS 不覆盖） */
export const imageWrite = (path: string, dataBase64: string) =>
  invoke<void>('image_write', { path, dataBase64 });

export interface Settings {
  closeAutoSave?: boolean;
  /** 用户主动只读，独立于磁盘权限，默认关闭。 */
  readOnlyMode?: boolean;
  columnMarkers?: number[];
  /** 行号可见性（002 规则 10：默认开可切；查看面/编辑面一致） */
  showLineNumbers?: boolean;
  /** 选中词高亮相同词（002 规则 13：可关；编辑面 CM highlightSelectionMatches） */
  selectionHl?: boolean;
  /** 外观主题（001 规则 21：四套，默认 paper=简洁白） */
  theme?: 'paper' | 'cool' | 'graphite' | 'black';
  /** 缩略图可见性（002 规则 23） */
  showMinimap?: boolean;
  /** 不可见字符高亮（002 规则 25） */
  showInvisible?: boolean;
  /** 标尺可见性（定稿 demo 视图菜单：切换标尺） */
  showRuler?: boolean;
  /** 自动保存间隔秒（ADR 012：激活标签脏标后触发，0=关，默认 15） */
  autoSaveSec?: number;
  /** 自动保存目标（ADR 012 v2 / H-5 T10）：'sidecar'=恢复快照旁路文件（出厂，原文件仅在
   *  Ctrl+S / 切换三键确认 / 关闭确认时写）；'file'=自动保存直写原文件（旧行为，显式选项） */
  autoSaveTarget?: 'sidecar' | 'file';
  /** 恢复快照目录；空/未设置使用配置目录下 recovery。 */
  snapshotDir?: string;
  /** 备份保留份数（ADR 012：保存时滚动，0=关，默认 3） */
  backupKeep?: number;
  /** 界面语言（i18n：zh-CN / en-US；缺省跟随系统，见 detectLang） */
  language?: 'zh-CN' | 'en-US';
  /** 字号（001 规则 31：10–18，Ctrl+滚轮 / Ctrl+=/-/0，查看与编辑两态一致） */
  fontSize?: number;
  /** 默认打开模式——002 规则 7b v2.6 废止（≤10MB 恒编辑面）；磁盘旧值读入即忽略（读写兼容，不再下发） */
  defaultOpenMode?: 'edit' | 'view';
  /** Markdown 默认形态（007 v0.15：ir=即时渲染（出厂） / source=源码即编辑面；
   *  preview=渲染预览（v0.21 恢复：裁决层映射 'md' 形态，超 2MB 回 source）） */
  mdDefaultMode?: 'ir' | 'source' | 'preview';
  /** 编辑器字体族覆盖（C-3 #22）：'bundled'=捆绑 JetBrains Mono（出厂）；'local'=本地导入字体 */
  editorFont?: 'bundled' | 'local';
  /** 本地导入字体文件路径（editorFont='local' 时启动重注册） */
  localFontPath?: string;
  /** 差异配色自定义（批 F #21：覆盖 --diff-add/del/chg 令牌；空值回退主题默认） */
  diffColors?: { add?: string; del?: string; chg?: string };
  /** 大纲当前符号高亮色（批 G：覆盖 --outline-cur 令牌；空值回退主题默认） */
  outlineCur?: string;
  /** 当前行高亮色（P3，反馈 14：覆盖编辑态活动行 --line-hl 令牌；空值回退主题默认） */
  lineHl?: string;
  /** 备份开关（P3，反馈 24）：false 时保存不滚动 .bak（传 Rust 的 backupKeep 同步按 0，契约不变） */
  backupEnabled?: boolean;
  /** 关闭按钮行为（ADR 015 / 002 规则 29）：'ask'=每次询问（出厂）/ 'exit'=直接退出 / 'tray'=最小化到托盘；
   *  有脏标签时任何设置都先走脏文件清单（安全底线） */
  closeBehavior?: 'ask' | 'exit' | 'tray';
  /** 「每次询问」弹窗里勾选「记住我的选择」的记忆（只在 closeBehavior='ask' 时生效；设置面板可清除） */
  rememberedCloseAction?: 'exit' | 'tray';
  // ---- 图床（009 / ADR 016：零网络唯一例外；凭据仅当前会话内存，界面掩码显示） ----
  /** 图床启用开关（009 规则 2：默认关；未启用时三触发与远程图回填全部不出现） */
  imageHostEnabled?: boolean;
  /** S3 兼容端点（如 https://s3.example.com 或自建 MinIO） */
  s3Endpoint?: string;
  s3Region?: string;
  s3Bucket?: string;
  /** 访问凭据（仅当前会话内存；启动清除旧版落盘字段，不入日志/文档/仓库） */
  s3Credentials?: { accessKeyId: string; secretAccessKey: string };
  /** 公网访问基址（公开读；渲染面取图与公开 URL 前缀，缺省时上传前询问） */
  publicBaseUrl?: string;
  /** 对象键前缀（如 img/；空=无前缀） */
  s3Prefix?: string;
  /** 命名模板（默认 {date}/{hash}；可含 {name}） */
  s3NameTemplate?: string;
  /** 寻址风格（默认 path=MinIO/R2/自建兼容面最广） */
  s3AddressStyle?: 'path' | 'virtual-host';
  /** 明文 http 端点豁免（默认关；局域网 MinIO 用） */
  s3AllowInsecure?: boolean;
  /** 粘贴图片默认动作（009 规则 4：'ask'=三选（出厂）/ 'upload'=直接上传 / 'local'=保存本地） */
  pasteImageAction?: 'ask' | 'upload' | 'local';
}
export const DEFAULT_SETTINGS: Settings = { closeAutoSave: false, columnMarkers: [], theme: 'paper', showMinimap: true, showRuler: true, showLineNumbers: true, selectionHl: true, autoSaveSec: 15, autoSaveTarget: 'sidecar', backupKeep: 3, fontSize: 12, mdDefaultMode: 'ir', readOnlyMode: false, closeBehavior: 'ask' };
