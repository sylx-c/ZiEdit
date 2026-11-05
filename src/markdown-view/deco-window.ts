import type { Text } from '@codemirror/state';

export interface DecoWindow { from: number; to: number }

/** 普通行完整归属一片；超长行仍分片，最多多处理 256 字符，不能因对齐变成整条巨行。 */
export function decorationSliceEnd(doc: Text, from: number, end: number, budget: number): number {
  const target = Math.min(end, from + budget), line = doc.lineAt(target);
  return Math.min(end, line.to - target <= 256 ? line.to : line.from > from ? line.from : target);
}

/** 从目标视口减去已完成的片段；未完成的计划不算覆盖，滚动中断不会留下永久空洞。 */
export function missingWindows(target: DecoWindow, covered: readonly DecoWindow[]): DecoWindow[] {
  const missing: DecoWindow[] = [];
  let from = target.from;
  for (const range of [...covered].sort((a, b) => a.from - b.from)) {
    if (range.to <= from || range.from >= target.to) continue;
    if (range.from > from) missing.push({ from, to: range.from });
    from = Math.max(from, range.to);
  }
  if (from < target.to) missing.push({ from, to: target.to });
  return missing;
}

export function clipWindows(target: DecoWindow, covered: readonly DecoWindow[]): DecoWindow[] {
  const result: DecoWindow[] = [];
  for (const range of [...covered].sort((a, b) => a.from - b.from)) {
    const from = Math.max(target.from, range.from), to = Math.min(target.to, range.to);
    if (from >= to) continue;
    const last = result[result.length - 1];
    if (last && last.to >= from) last.to = Math.max(last.to, to);
    else result.push({ from, to });
  }
  return result;
}
