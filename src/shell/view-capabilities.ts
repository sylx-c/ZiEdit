/** 当前视图能力：菜单/工具栏/快捷键的启用与执行共用的轻量判决。
 *  这里只识别结构能力，不包含具体实例；app.ts 的动作执行仍持有具体视图。 */
export type ViewKind = 'text' | 'edit' | 'ir' | 'preview' | 'csv' | 'compare' | 'image' | 'pdf' | 'none';
export type ViewCapability = 'edit' | 'sourceEdit' | 'find' | 'replace' | 'goto' | 'bookmark' | 'minimap' | 'save' | 'format';

const COMMON: Readonly<Record<ViewCapability, boolean>> = {
  edit: false, sourceEdit: false, find: false, replace: false, goto: false, bookmark: false, minimap: false, save: false, format: false,
};
const BY_KIND: Readonly<Record<ViewKind, Readonly<Record<ViewCapability, boolean>>>> = {
  text: { ...COMMON, find: true, goto: true, bookmark: true, minimap: true },
  edit: { ...COMMON, edit: true, sourceEdit: true, find: true, replace: true, goto: true, bookmark: true, minimap: true, save: true },
  ir: { ...COMMON, edit: true, find: true, replace: true, goto: true, minimap: true, save: true, format: true },
  preview: { ...COMMON, find: true, goto: true },
  csv: { ...COMMON }, compare: { ...COMMON }, image: { ...COMMON }, pdf: { ...COMMON }, none: COMMON,
};

export function viewCapabilities(kind: ViewKind, options: { markdown?: boolean; preview?: boolean } = {}): Readonly<Record<ViewCapability, boolean>> {
  const base = BY_KIND[kind];
  if (!options.markdown || kind !== 'edit') return base;
  return { ...base, format: !options.preview, bookmark: !options.preview, edit: !options.preview, sourceEdit: !options.preview, replace: !options.preview };
}

export function hasViewCapability(kind: ViewKind, capability: ViewCapability, options: { markdown?: boolean; preview?: boolean } = {}): boolean {
  return viewCapabilities(kind, options)[capability];
}
