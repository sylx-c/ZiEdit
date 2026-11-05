import type { FindOptions } from './ipc';

const word = (s: string): boolean => /[\p{Alphabetic}\p{Number}_]/u.test(s);

/** 目标 lib 兼容：末字符取法（等价 Array.at(-1) ?? ''）。 */
const lastOf = (s: string): string => { const a = Array.from(s); return a.length ? a[a.length - 1]! : ''; };

/** Rust find_all_in 的行内镜像；位置保留 CM 所需 UTF-16 偏移，col 为 1 起码位列。 */
export function findAllIn(line: string, needle: string, opts: FindOptions): Array<{ from: number; to: number; col: number }> {
  if (!needle) return [];
  const out: Array<{ from: number; to: number; col: number }> = [];
  const add = (from: number, to: number): void => {
    if (opts.wholeWord && (word(lastOf(line.slice(0, from))) || word(Array.from(line.slice(to))[0] ?? ''))) return;
    out.push({ from, to, col: Array.from(line.slice(0, from)).length + 1 });
  };
  if (opts.regex) {
    const re = buildFindRegex(needle, { ...opts, wholeWord: false });
    const g = new RegExp(re.source, re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(line))) {
      add(m.index, m.index + m[0].length);
      if (!m[0].length) g.lastIndex += (line.codePointAt(g.lastIndex) ?? 0) > 0xffff ? 2 : 1;
    }
    return out;
  }
  // Rust 按原字符逐一 lowercase；İ 的展开必须映射回原位置，不能用 i 正则替代。
  let hay = '';
  const starts: number[] = [], ends: number[] = [];
  let pos = 0;
  for (const ch of line) {
    const folded = opts.caseSensitive ? ch : ch.toLowerCase();
    for (let i = 0; i < folded.length; i++) { starts.push(pos); ends.push(pos + ch.length); }
    hay += folded;
    pos += ch.length;
  }
  const ned = opts.caseSensitive ? needle : needle.toLowerCase();
  for (let i = 0; (i = hay.indexOf(ned, i)) >= 0;) {
    const end = i + ned.length;
    if (!opts.wholeWord || (!word(lastOf(hay.slice(0, i))) && !word(Array.from(hay.slice(end))[0] ?? ''))) {
      const from = starts[i]!, to = ends[end - 1]!;
      // 全字字面量的边界在折叠串上判定（与 Rust 一致）。
      out.push({ from, to, col: Array.from(line.slice(0, from)).length + 1 });
    }
    i += opts.wholeWord ? (hay.codePointAt(i)! > 0xffff ? 2 : 1) : ned.length;
  }
  return out;
}

/** 非法表达式显式报错，不退化为字面量；全字与正则组合使用 Unicode 字母数字边界。 */
export function buildFindRegex(needle: string, opts: FindOptions): RegExp {
  try {
    if (opts.regex && /\(\?[=!<]|\\[1-9]/u.test(needle)) throw new Error('unsupported look-around or backreference');
    let source = opts.regex ? needle : needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (opts.wholeWord) source = `(?<![\\p{Alphabetic}\\p{Number}_])(?:${source})(?![\\p{Alphabetic}\\p{Number}_])`;
    return new RegExp(source, opts.caseSensitive ? 'u' : 'iu');
  } catch (e) {
    throw new Error(`Regex error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
