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

/** 归一为 LF 并剥离前导 BOM（Markdown 渲染输入契约：外部文本进入 Lezer 前必须是 LF）。
 *  前导 U+FEFF 是不可见字符，会让首行的 ATX 标题/表格判定失效——解码层（encoding_rs
 *  decode 的 BOM 嗅探）正常会剥离它，这里兜住剪贴板、草稿、恢复快照等绕过文件解码的路径。
 *  无 \r 且无前导 BOM 时原样返回（同一引用），避免对已归一的编辑器缓冲做大字符串改写。 */
export function toLf(text: string): string {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return body.includes('\r') ? convertEol(body, '\n') : body;
}

/** 另存文件名：后缀插在扩展名前；无扩展名时直接追加（a.md→a.lf.md；README→README.lf；.gitignore→.lf.gitignore） */
export function nlSaveName(path: string, id: NlId): string {
  const preset = NL_PRESETS.find(p => p.id === id) ?? NL_PRESETS[1]!;
  const base = path.split(/[\\/]/).pop() ?? 'untitled';
  return base.replace(/(\.[^.]+)?$/, m => preset.suffix + m);
}
