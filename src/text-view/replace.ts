// replace —— 查找替换引擎（002 规则 22/28）：列范围限定 + 列表批量，纯函数便于单测
// 供编辑缓冲（EditView）调用：逐行计算替换后的整行文本，由调用方映射为 CM6 changes。

export interface ReplaceOpts {
  find: string;
  replaceWith: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** 1-based，含端点；缺省 = 全行 */
  colStart?: number;
  colEnd?: number;
  /** 单行内最多替换次数；缺省不限（「替换下一个」用 1） */
  limit?: number;
}

const isWordChar = (ch: string | undefined): boolean => !!ch && /[A-Za-z0-9_]/.test(ch);

/**
 * 单行替换：在 [colStart-1, colEnd)（0-based 半开，缺省全行）窗口内执行。
 * 返回 null 表示无变化；text 为替换后的**整行**文本（不含换行符），count 为命中次数。
 */
export function replaceInLine(line: string, o: ReplaceOpts): { text: string; count: number } | null {
  if (!o.find) return null;
  const w0 = Math.max(0, (o.colStart ?? 1) - 1);
  const w1 = Math.min(line.length, o.colEnd ?? line.length);
  if (w0 >= w1) return null;
  const head = line.slice(0, w0);
  const win = line.slice(w0, w1);
  const tail = line.slice(w1);
  let out: string;
  let count = 0;

  if (o.regex) {
    // 正则模式：wholeWord 不参与（与后端 text_find 行为一致）；支持 $1 反向引用；limit 截断
    let re: RegExp;
    try {
      re = new RegExp(o.find, 'g' + (o.caseSensitive ? '' : 'i'));
    } catch {
      return null;
    }
    let rebuilt = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(win)) !== null) {
      rebuilt += win.slice(last, m.index);
      rebuilt += o.replaceWith.replace(/\$(\d+)/g, (_, d: string) => m![Number(d)] ?? '');
      last = re.lastIndex;
      count++;
      if (m[0] === '') re.lastIndex++; // 零宽匹配防死循环
      if (o.limit && count >= o.limit) break;
    }
    rebuilt += win.slice(last);
    if (!count) return null;
    out = rebuilt;
  } else {
    const hay = o.caseSensitive ? win : win.toLowerCase();
    const needle = o.caseSensitive ? o.find : o.find.toLowerCase();
    let idx = 0;
    while ((idx = hay.indexOf(needle, idx)) !== -1) {
      if (o.wholeWord) {
        // 全字校验按整行上下文（窗口边界不人为造词边界）
        const before = line[w0 + idx - 1];
        const after = line[w0 + idx + needle.length];
        if (isWordChar(before) || isWordChar(after)) {
          idx += needle.length;
          continue;
        }
      }
      count++;
      idx += needle.length;
      if (o.limit && count >= o.limit) break;
    }
    if (!count) return null;
    // 重组：按命中分段拼接（保守做法，避免大小写折叠串错位）
    let rebuilt = '';
    let cur = 0;
    let i2 = 0;
    let done = 0;
    while ((i2 = hay.indexOf(needle, i2)) !== -1) {
      rebuilt += win.slice(cur, i2);
      const before = line[w0 + i2 - 1];
      const after = line[w0 + i2 + needle.length];
      const wordOk = !o.wholeWord || (!isWordChar(before) && !isWordChar(after));
      rebuilt += wordOk ? o.replaceWith : win.slice(i2, i2 + needle.length);
      if (wordOk) done++;
      cur = i2 + needle.length;
      i2 = cur;
      if (o.limit && done >= o.limit) break;
    }
    rebuilt += win.slice(cur);
    out = rebuilt;
  }
  return { text: head + out + tail, count };
}

/** 多行执行：返回有变化的行（1-based 行号 + 整行新文本）与合计命中数 */
export function replaceDocLines(lines: string[], o: ReplaceOpts): { changes: { line: number; text: string }[]; count: number } {
  const changes: { line: number; text: string }[] = [];
  let count = 0;
  lines.forEach((l, i) => {
    const r = replaceInLine(l, o);
    if (r) {
      changes.push({ line: i + 1, text: r.text });
      count += r.count;
    }
  });
  return { changes, count };
}

/** 首个匹配的替换（「替换下一个」语义：最早行内的第一个命中） */
export function replaceFirst(lines: string[], o: ReplaceOpts): { line: number; text: string } | null {
  for (let i = 0; i < lines.length; i++) {
    const r = replaceInLine(lines[i], { ...o, limit: 1 });
    if (r) return { line: i + 1, text: r.text };
  }
  return null;
}

/** 列表批量（002 规则 28）：每行 `查找<TAB>替换`；空行/缺 TAB/空查找 跳过 */
export function parsePairs(src: string): { find: string; replaceWith: string }[] {
  const out: { find: string; replaceWith: string }[] = [];
  for (const raw of src.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const idx = raw.indexOf('\t');
    if (idx <= 0) continue;
    const find = raw.slice(0, idx);
    const replaceWith = raw.slice(idx + 1);
    if (find) out.push({ find, replaceWith });
  }
  return out;
}
