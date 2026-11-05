// 已有约 115KB 单行 JSON 卡死案例；用更保守的 64K 字符阈值在解析前降级。
export const JSON_MAX_LINE_CHARS = 64 * 1024;

export function safeSyntaxLanguage(language: string | null, lines: Iterable<string>): string | null {
  if (language !== 'JSON') return language;
  for (const line of lines) if (line.length > JSON_MAX_LINE_CHARS) return null;
  return language;
}

/** Same guard for a contiguous snapshot, without allocating an array of every line. */
export function safeSyntaxText(language: string | null, text: string): string | null {
  if (language !== 'JSON') return language;
  let from = 0;
  while (from <= text.length) {
    const end = text.indexOf('\n', from);
    const lineEnd = end < 0 ? text.length : end;
    if (lineEnd - from > JSON_MAX_LINE_CHARS) return null;
    if (end < 0) return language;
    from = end + 1;
  }
  return language;
}
