// 纯文本工具（换行转换另存 002 规则 21 v1.3：单入口对话框/状态栏快项/标签右键共用）

export type NlId = 'CRLF' | 'LF' | 'CR';

/** 换行目标预设：转义序列 + 另存文件名后缀（插在扩展名前，如 a.md → a.lf.md） */
export const NL_PRESETS: ReadonlyArray<{ id: NlId; seq: string; suffix: string }> = [
  { id: 'CRLF', seq: '\r\n', suffix: '.crlf' },
  { id: 'LF', seq: '\n', suffix: '.lf' },
  { id: 'CR', seq: '\r', suffix: '.cr' },
];

/** 把全文换行符统一为 seq（混合 CRLF/LF/CR 一并归一） */
export function convertEol(text: string, seq: string): string {
  return text.replace(/\r\n|\r|\n/g, seq);
}

/** 另存文件名：后缀插在扩展名前；无扩展名时直接追加（a.md→a.lf.md；README→README.lf；.gitignore→.lf.gitignore） */
export function nlSaveName(path: string, id: NlId): string {
  const preset = NL_PRESETS.find(p => p.id === id) ?? NL_PRESETS[1]!;
  const base = path.split(/[\\/]/).pop() ?? 'untitled';
  return base.replace(/(\.[^.]+)?$/, m => preset.suffix + m);
}
