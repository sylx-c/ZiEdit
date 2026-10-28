// mode —— 视图模式裁决纯函数（002 v2.7 / 007 v0.21，编辑能力与 Markdown 四形态）。
// 一个真相源：默认模式由 settings + 文件元数据推出；modeMap 只记用户显式选择。
// v2.6 起「查看/编辑」双模式废止：≤10MB 文本（含磁盘只读）恒进编辑面（EditView/CM6），
// >10MB 走流式查看面（TextView）；defaultOpenMode 废止；只读偏好由视图约束处理，
// 四形态 = 源码 edit / 分屏 split / 独立渲染预览 md / 即时渲染 wysiwyg。
// 纯函数无 DOM / IPC 依赖，便于单测（src/common/mode.test.ts）。

/** 视图模式（与 app 内 ViewMode 同形；收口于此避免循环依赖） */
export type ViewMode = 'view' | 'md' | 'edit' | 'split' | 'wysiwyg' | 'csv';

/** 文件元数据（裁决入参；由 openFile / fileSizes 等既有来源填充） */
export interface ModeMeta {
  language: string | null;
  /** 草稿伪标签（draft://）：恒可编辑 */
  isDraft: boolean;
  /** 只读（磁盘属性 / 打开探测）——v2.6 起不再阻止编辑（缓冲内照常编辑，Ctrl+S 报 E1003/另存为可用） */
  readonly: boolean;
  /** 字节数（> EDIT_LIMIT 走流式查看面） */
  size: number;
}

export interface ModeSettings {
  /** v2.6 废止 defaultOpenMode（≤10MB 恒编辑面）；历史值不再参与裁决 */
  mdDefaultMode?: 'ir' | 'source' | 'preview';
}

/** 编辑缓冲上限（字节；与 app 的 EDIT_LIMIT 同值，收口于此） */
export const EDIT_LIMIT = 10 * 1024 * 1024;
/** 即时渲染上限（007 v0.34：2026-10-19 原生 release 实测 3.9MiB 挂载 ltMax 146ms、跳尾/键入/滚动零长任务；
 *  9MiB 仍超输入门禁，维持不进 IR） */
export const WYSIWYG_LIMIT = 4 * 1024 * 1024;
/** Markdown 渲染预览/分屏上限（字符；分屏右栏保留整篇 DOM，未随 IR 提档——保持 2MiB 直至实测通过） */
export const MD_PREVIEW_LIMIT = 2 * 1024 * 1024;

/** 是否可进编辑面（002 规则 7b v2.6：草稿恒可；真实文件 ≤10MB 即可——磁盘只读不再阻止，
 *  只读文件缓冲内照常编辑，Ctrl+S 报 E1003、另存为可用，编辑缓冲的崩溃快照照常保护） */
export function editableFile(meta: ModeMeta): boolean {
  if (meta.isDraft) return true;
  return meta.size <= EDIT_LIMIT;
}

/** 是否可进即时渲染（007 规则 6 v0.15：Markdown、非草稿、≤2MB——只读 .md 同权进 IR：
 *  v2.6 起所有形态都在编辑缓冲内承载，只读不再是 IR 的独立闸；保存侧 E1003 口径统一兜底） */
export function wysiwygEligibleFile(meta: ModeMeta): boolean {
  return meta.language === 'Markdown' && meta.size <= WYSIWYG_LIMIT;
}

/** 是否可进分屏预览（007 v0.15 规则 6：与 IR 同闸 ≤2MB；字节近似门，挂载侧字符数复核兜底） */
export function mdSplitEligibleFile(meta: ModeMeta): boolean {
  return meta.language === 'Markdown' && meta.size <= MD_PREVIEW_LIMIT;
}

/** 行批处理适用矩阵（005 规则 14 v1.4 / H-3）：Markdown 与结构化格式（JSON/XML/CSV/TSV）不启用
 *  ——排序/去重/删空行会破坏文档结构、对象键序与表头。注册表 enabled 与两处右键菜单共用的唯一判决；
 *  旧实现同一政策写了三遍且口径不一（右键两处只挡 Markdown），JSON/XML 可经右键执行破坏性行批处理。 */
export function lineBatchAllowed(language: string | null): boolean {
  switch (language) {
    case 'Markdown':
    case 'JSON':
    case 'XML':
    case 'CSV':
    case 'TSV':
      return false;
    default:
      return true;
  }
}

/**
 * 打开时的默认模式（用户未显式选择时）：
 * - CSV/TSV：表格态（H-3 适用矩阵——CSV 用户第一反应是"看表"）
 * - Markdown：mdDefaultMode（ir=即时渲染（出厂）；source→源码即编辑面；
 *   preview→独立渲染预览；渲染形态超 2MB 或 source 且 ≤10MB → edit，
 *   >10MB → view 流式查看面）
 * - 其他文本：≤10MB（含只读）→ edit 编辑面；>10MB → view 流式查看面
 * - 非 text 路由不进本函数（app 层先分流）
 */
export function defaultModeFor(meta: ModeMeta, settings: ModeSettings): ViewMode {
  if (meta.isDraft && meta.language !== 'Markdown') return 'edit';
  const editable = editableFile(meta);
  if (meta.language === 'CSV' || meta.language === 'TSV') return 'csv';
  if (meta.language === 'Markdown') {
    const pref = settings.mdDefaultMode ?? 'ir'; // preview 恢复为独立渲染预览（007 v0.21）
    if (pref === 'preview' && mdSplitEligibleFile(meta)) return 'md';
    if (pref === 'ir' && wysiwygEligibleFile(meta)) return 'wysiwyg';
    return editable ? 'edit' : 'view';
  }
  return editable ? 'edit' : 'view';
}

/**
 * 用户显式选择的合法性清洗：模式与文件形态不符时视为未选择（回落默认）。
 * 返回 null 表示非法（含 undefined）；独立渲染预览与分屏共用体量门槛。
 */
export function sanitize(m: ViewMode | undefined, meta: ModeMeta): ViewMode | null {
  if (!m) return null;
  if (meta.isDraft && meta.language !== 'Markdown') return m === 'edit' ? 'edit' : null;
  if (meta.isDraft && m === 'view') return null; // 草稿无磁盘权威，不进流式查看面（回落默认形态）
  if (m === 'edit') return editableFile(meta) ? 'edit' : null;
  if (m === 'md') return mdSplitEligibleFile(meta) ? 'md' : null;
  if (m === 'split') return mdSplitEligibleFile(meta) ? 'split' : null;
  if (m === 'wysiwyg') return wysiwygEligibleFile(meta) ? 'wysiwyg' : null;
  if (m === 'csv') return meta.language === 'CSV' || meta.language === 'TSV' ? 'csv' : null;
  return 'view';
}
