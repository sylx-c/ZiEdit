/** 仅消费随包高亮器的 span 输出，返回 UTF-16 范围；源码永不作为 HTML 插入编辑器。 */
export interface CodeToken { from: number; to: number; classes: string }

/** 只映射可见范围的 token；源码片段之间的引用/列表前缀不参与着色坐标。 */
export function visibleCodeTokens(tokens: readonly CodeToken[], segments: readonly { from: number; to: number; offset: number }[],
  visible: readonly { from: number; to: number }[]): CodeToken[] {
  const result: CodeToken[] = [];
  for (const range of visible) {
    let lo = 0, hi = segments.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (segments[mid]!.to <= range.from) lo = mid + 1; else hi = mid; }
    for (let s = lo; s < segments.length && segments[s]!.from < range.to; s++) {
      const segment = segments[s]!;
      const from = segment.offset + Math.max(range.from - segment.from, 0);
      const to = segment.offset + Math.min(range.to, segment.to) - segment.from;
      let lo = 0, hi = tokens.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (tokens[mid]!.to <= from) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < tokens.length && tokens[i]!.from < to; i++) {
        const token = tokens[i]!;
        result.push({ from: segment.from + Math.max(token.from, from) - segment.offset,
          to: segment.from + Math.min(token.to, to) - segment.offset, classes: token.classes });
      }
    }
  }
  return result;
}

export function codeLanguage(info: string): string {
  const name = info.trim().split(/\s+/, 1)[0]!.toLowerCase();
  return ['sh', 'shell', 'zsh'].includes(name) ? 'bash' : name;
}
