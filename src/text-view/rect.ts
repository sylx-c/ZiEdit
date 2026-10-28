// rect —— 矩形选区纯函数（005 规则 2/5 v1.0：列复制/剪切/编号的矩形重建与短行补齐）
// 从 CodeMirror/EditView 抽出为纯函数便于单测（vitest 无 DOM 环境）。
import { convertEol } from '../common/text';
import { findClusterBreak } from '@codemirror/state';

export interface RangePos {
  from: number;
  to: number;
}

/** 行定位最小接口（CodeMirror Text 满足；测试用字符串数组实现）。
 *  text：行文本（005-01 起字符索引→视觉列换算需要；CM Line 自带 text 字段）。 */
export interface RectDoc {
  lineAt(pos: number): { number: number; from: number; to: number; text: string };
}

export interface RectSpan {
  fromLine: number;
  toLine: number;
  colStart: number;
  colEnd: number;
  /** 非等宽块粘贴后，各行独立列光标（不补齐到最宽行）。 */
  cursorCols?: number[];
}

/**
 * 多选区推回矩形（005 规则 2 自研规格）：
 * ≥2 个 range、每个 range 单行内、行连续、至少一个非空选区时返回
 * [colStart, colEnd) 矩形；否则 null（非矩形选区）。
 * 空选区（短行超界被钳到行尾）不参与列推算，避免拉低真实起点。
 */
export function rectOf(ranges: RangePos[], doc: RectDoc): RectSpan | null {
  const rs = [...ranges].sort((a, b) => a.from - b.from);
  if (rs.length < 2) return null;
  let fromLine = 0;
  let toLine = 0;
  let colStart = Infinity;
  let colEnd = -1;
  let solid = 0;
  for (const r of rs) {
    const l = doc.lineAt(r.from);
    if (r.from < l.from || r.from > l.to) return null;
    // CM 在短行行尾会把 range 伸进下一行；钳回本行，不因此否定整块矩形
    const to = Math.min(r.to, l.to);
    if (fromLine && l.number !== toLine + 1) return null; // 行不连续 → 非矩形
    if (!fromLine) fromLine = l.number;
    toLine = l.number;
    if (to > r.from) {
      solid++;
      // 005-01（审计 2026-10-17）：矩形列统一**视觉列**口径（CJK 占 2 格）——
      // 修前这里记字符索引，而拖拽路径（cellAt/charAtVisualCol）记视觉列，rectText 两义混用，
      // CJK 行复制内容错位。此处用本行文本换算为视觉列，与拖拽路径同口径。
      colStart = Math.min(colStart, visualColOf(l.text, r.from - l.from));
      colEnd = Math.max(colEnd, visualColOf(l.text, to - l.from));
    }
  }
  if (!solid || colEnd < 0) return null;
  return { fromLine, toLine, colStart, colEnd };
}

/** 矩形逐行文本：短行以空格补齐到 colEnd（与列粘贴补齐对称，005 规则 2/5） */
export function rectText(rect: RectSpan, getLine: (n: number) => string): string[] {
  const out: string[] = [];
  for (let n = rect.fromLine; n <= rect.toLine; n++) {
    const text = getLine(n);
    // 005-01：colStart/colEnd 为视觉列——按本行文本映射到字符边界再切；短行按视觉宽补空格
    const a = charAtVisualCol(text, rect.colStart);
    const b = charAtVisualCol(text, rect.colEnd);
    const cut = text.slice(Math.min(a, b), Math.max(a, b));
    const missing = rect.colEnd - rect.colStart - visualWidth(cut, rect.colStart);
    out.push(missing > 0 ? cut + ' '.repeat(missing) : cut);
  }
  return out;
}

/** 两次点击的字符格合成矩形。同一行返回 null（交给普通选区）。右缘含终点所在格。 */
export function rectFromCells(
  a: { line: number; cell: number },
  b: { line: number; cell: number }
): RectSpan | null {
  if (a.line === b.line) return null;
  return rectSpanOfCells(a, b);
}

/** 视觉格端点合成半开矩形，包含右端点格（编辑与流式面同源）。 */
export function rectSpanOfCells(a: { line: number; cell: number }, b: { line: number; cell: number }): RectSpan {
  return {
    fromLine: Math.min(a.line, b.line),
    toLine: Math.max(a.line, b.line),
    colStart: Math.min(a.cell, b.cell),
    colEnd: Math.max(a.cell, b.cell) + 1,
  };
}

export interface RectLine {
  from: number;
  text: string;
}

/** Stable whole-row transforms keyed by the selected visual-column window. */
export function sortColumnBlock(lines: string[], colStart: number, colEnd: number, descending = false): string[] {
  const key = (line: string) => line.slice(charAtVisualCol(line, colStart), charAtVisualCol(line, colEnd));
  return lines.map((line, index) => ({ line, index, key: key(line) })).sort((a, b) =>
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) * (descending ? -1 : 1) || a.index - b.index
  ).map(row => row.line);
}

export function dedupeColumnBlock(lines: string[], colStart: number, colEnd: number): string[] {
  const seen = new Set<string>();
  return lines.filter(line => {
    const key = line.slice(charAtVisualCol(line, colStart), charAtVisualCol(line, colEnd));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Pad short rows to the selected right edge, never truncate existing text. */
export function padColumnBlock(lines: string[], colEnd: number): string[] {
  return lines.map(line => line + ' '.repeat(Math.max(0, colEnd - visualWidth(line))));
}

/** 删除矩形内已有字符（虚拟空格无字符可删），右侧左移 */
export function rectDeleteChanges(rect: RectSpan, getLine: (n: number) => RectLine): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let n = rect.fromLine; n <= rect.toLine; n++) {
    const l = getLine(n);
    if (rect.colStart >= l.text.length) continue;
    const from = l.from + rect.colStart;
    const to = l.from + Math.min(rect.colEnd, l.text.length);
    if (to > from) out.push({ from, to });
  }
  return out;
}

/** 每行用同一字符串替换矩形；起始列超过行尾时先补空格 */
export function rectFillChanges(
  rect: RectSpan,
  getLine: (n: number) => RectLine,
  text: string
): { from: number; to: number; insert: string }[] {
  const out: { from: number; to: number; insert: string }[] = [];
  for (let n = rect.fromLine; n <= rect.toLine; n++) {
    const l = getLine(n);
    if (l.text.length >= rect.colStart) {
      out.push({
        from: l.from + rect.colStart,
        to: l.from + Math.min(rect.colEnd, l.text.length),
        insert: text,
      });
    } else {
      out.push({
        from: l.from + l.text.length,
        to: l.from + l.text.length,
        insert: ' '.repeat(rect.colStart - l.text.length) + text,
      });
    }
  }
  return out;
}

/** 只改矩形内已有字符的大小写 */
export function rectCaseChanges(
  rect: RectSpan,
  getLine: (n: number) => RectLine,
  mode: 'upper' | 'lower'
): { from: number; to: number; insert: string }[] {
  const out: { from: number; to: number; insert: string }[] = [];
  for (let n = rect.fromLine; n <= rect.toLine; n++) {
    const l = getLine(n);
    if (rect.colStart >= l.text.length) continue;
    const end = Math.min(rect.colEnd, l.text.length);
    const slice = l.text.slice(rect.colStart, end);
    const insert = mode === 'upper' ? slice.toUpperCase() : slice.toLowerCase();
    if (insert !== slice) out.push({ from: l.from + rect.colStart, to: l.from + end, insert });
  }
  return out;
}

/** 按显示行数组构造 RectDoc（单测辅助：行偏移按 \n 累计） */
export function docOfLines(lines: string[]): RectDoc {
  const offs: number[] = [];
  let pos = 0;
  for (const l of lines) {
    offs.push(pos);
    pos += l.length + 1;
  }
  const lineAt = (p: number): { number: number; from: number; to: number; text: string } => {
    let lo = 0;
    let hi = offs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offs[mid]! <= p) lo = mid;
      else hi = mid - 1;
    }
    const from = offs[lo]!;
    return { number: lo + 1, from, to: from + lines[lo]!.length, text: lines[lo]! };
  };
  return { lineAt };
}

/**
 * 鼠标按下时对矩形的处置（005 规则 2 v1.3「右键不得清除这份矩形」/ 规则 13 的单一判决）。
 * 编辑态与查看态共用：两处口径历来各写一遍，右键清矩形这个同源缺陷因此只修了一半。
 *
 * 为什么右键要 `preventDefault`：编辑面是 contenteditable，右键 mousedown 的**浏览器默认行为**
 * 会把原生选区重置到点击点；这条变更被 CM 的 DOMObserver **异步**回灌，等到落地时
 * `preserveRect` 早已被 mouseup/contextmenu 复位，矩形就被当成"用户新选择"清掉
 * （实测：右键后「列操作 ▸ 求和选区」报"选区内没有可求和的数字"、对齐/填充静默无效）。
 * 拦住默认行为即从源头不产生这条变更，矩形、原生选区与列宽全部原样。
 */
export interface RectPointerPlan {
  /** 左键 + 列模式/Alt：交由调用方开始列拖拽 */
  drag: boolean;
  /** 这一轮指针交互期间置保留位：选区变更不得作废矩形 */
  preserve: boolean;
  /** 阻止浏览器默认行为（右键落在矩形上时拦下原生选区重置） */
  preventDefault: boolean;
  /** 立即作废矩形（左键普通点击，规则 13「单击清除」） */
  clear: boolean;
}

/** 按键/修饰键/当前矩形 → 处置方案（其余按键 如中键 一律不碰矩形） */
export function rectPointerPlan(button: number, columnMode: boolean, altKey: boolean, hasRect: boolean): RectPointerPlan {
  if (button === 2) return { drag: false, preserve: true, preventDefault: hasRect, clear: false };
  if (button !== 0) return { drag: false, preserve: false, preventDefault: false, clear: false };
  if (columnMode || altKey) return { drag: true, preserve: false, preventDefault: false, clear: false };
  return { drag: false, preserve: false, preventDefault: false, clear: true };
}

/** 选区变更是否作废矩形：拖拽中或保留窗口内不作废 */
export function rectSelectionCleared(preserve: boolean, dragging: boolean): boolean {
  return !preserve && !dragging;
}

// ── 视觉列（005 v2.0：CJK 占 2 格，矩形按视觉格对齐——行业通行口径） ──

/** 字符的视觉宽度（CJK/全角=2，其余=1） */
function charW(ch: string | undefined, col = 0): number {
  if (!ch) return 0;
  if (ch === '\t') return 4 - col % 4;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(ch)) return 2;
  const c = ch.codePointAt(0) ?? 0;
  // CJK 统一表意/扩展/兼容 + 全角标点/假名/谚文等（宽松口径：>0x2E80 的东亚区块按 2 格）
  return c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)) ? 2 : 1;
}

/** 字符索引 → 视觉列（起点 0；按该行前缀累计宽度） */
export function visualColOf(text: string, charIndex: number): number {
  let v = 0;
  const n = Math.min(charIndex, text.length);
  for (let i = 0; i < n;) {
    const end = findClusterBreak(text, i);
    if (end > n) break;
    v += charW(text.slice(i, end), v);
    i = end;
  }
  return v;
}

/** 视觉列 → 字符索引（半格归左字符；超行尾钳到 length） */
export function charAtVisualCol(text: string, vcol: number): number {
  let v = 0;
  for (let i = 0; i < text.length;) {
    const end = findClusterBreak(text, i);
    const w = charW(text.slice(i, end), v);
    if (v + w > vcol) return i; // 目标格落在此字符内（半格归左）
    v += w;
    i = end;
  }
  return text.length;
}

/** 行的视觉宽度 */
export function visualWidth(text: string, startCol = 0): number {
  let col = startCol;
  for (let i = 0; i < text.length;) {
    const end = findClusterBreak(text, i);
    col += charW(text.slice(i, end), col);
    i = end;
  }
  return col - startCol;
}

// ── 求和 / 对齐 / 编号 / 无矩形插入（005 v2.0 规则 15，列编辑常用件） ──

/** 矩形求和：忽略非数字片段（每行提取全部数字求和）；无任何数字返回 null */
export function rectSum(cells: string[]): number | null {
  let sum: number | null = null;
  for (const c of cells) {
    for (const m of c.matchAll(/-?\d+(?:\.\d+)?/g)) {
      const n = Number(m[0]);
      if (Number.isFinite(n)) sum = (sum ?? 0) + n;
    }
  }
  return sum;
}

/** 无矩形时的插入列（005 v2.0 规则 15：从起始行到文末，按光标列插入，短行补空格） */
export function insertColumnChanges(
  fromLine: number,
  col: number,
  getLine: (n: number) => RectLine,
  text: string,
  totalLines: number
): { from: number; to: number; insert: string }[] {
  const out: { from: number; to: number; insert: string }[] = [];
  for (let n = fromLine; n <= totalLines; n++) {
    const l = getLine(n);
    if (l.text.length >= col) {
      out.push({ from: l.from + col, to: l.from + col, insert: text });
    } else {
      const end = l.from + l.text.length;
      out.push({ from: end, to: end, insert: ' '.repeat(col - l.text.length) + text });
    }
  }
  return out;
}

/** 最近一次复制是否来自矩形选区（005 规则 5 v2.2 列粘贴判决的「来源标记」）。
 *  剪贴板系统无元数据，只能用应用内标记 + 普通复制自然覆盖；查看态与编辑态共用、跨视图
 *  实例存活（查看态 Alt+拖拽矩形复制 → 点进编辑态粘贴的场景正是要靠它）。
 *  除布尔标记外还记下复制文本：粘贴时与剪贴板实际内容比对——中途发生了其它复制（含浏览器
 *  原生 Ctrl+C，不经本应用代码）时文本必不相等，标记自动失效，杜绝把普通多行文本误列展开。 */
let lastRectCopyText: string | null = null;
export function markRectCopy(v: boolean, text = ''): void {
  lastRectCopyText = v ? text : null;
}
export function wasRectCopy(clipText?: string): boolean {
  if (lastRectCopyText == null) return false;
  if (clipText == null) return true;
  // 005 规则 5 v2.3：比对前同口径归一行尾（与 readClipboardText 出口一致）——复制端恒
  // LF，但平台剪贴板可能自行转成 CRLF 再转回，直接字符串比对会让来源标记无端失效，
  // 矩形复制出来的块粘贴时判不出列来源。
  return convertEol(clipText, '\n') === convertEol(lastRectCopyText, '\n');
}

// ── 列粘贴语义矩阵（005 规则 5a v3.0：v2.3 缓期四项落档，判决/生成纯函数） ──

/** 列粘贴判决输入（原始事实，无编辑器依赖；cursor 仅在唯一 range 且空选区时给） */
export interface ColumnPasteInput {
  rect: RectSpan | null;                         // 活动矩形（colEnd===colStart 为零宽=列光标）
  columnMode: boolean;
  cursor: { line: number; col: number } | null;  // 单光标（视觉列）；多选区为 null
  clipText: string;                              // 已归一 LF 的剪贴板文本
  clipIsRect: boolean;                           // 来源标记命中（wasRectCopy(clipText)）
  force?: boolean;                               // 右键「列操作 ▸ 粘贴列」显式列意图（单光标免判决直列插入）
}

/** 判决结果：overwrite=矩形窗口覆盖；columnInsert=列插入（不删字符）；plainAtCol=零宽×单行的列位普通插入；normal=普通粘贴 */
export type ColumnPastePlan =
  | { kind: 'overwrite'; rect: RectSpan; parts: string[] }
  | { kind: 'columnInsert'; fromLine: number; col: number; parts: string[] }
  | { kind: 'plainAtCol'; line: number; col: number; text: string }
  | { kind: 'normal' };

/**
 * 列粘贴语义矩阵单一判决（005 规则 5a v3.0；Mod-v/右键粘贴/菜单粘贴同一入口）：
 * - 矩形活动（有宽）恒**覆盖**（剪贴板来源不敏感；单行按一行块=只动首行）；
 * - 零宽矩形（列光标）：多行**列插入**（不删字符）、单行**列位普通插入**；
 * - 单光标 +（列模式开或来源标记命中或显式列意图）且多行 → **列插入**（从光标行起）；
 * - 其余（含多选区无矩形、单行、标记中途失效）→ **普通粘贴**。
 */
export function planColumnPaste(inp: ColumnPasteInput): ColumnPastePlan {
  const parts = inp.clipText.split('\n');
  const multi = parts.length > 1;
  const rect = inp.rect;
  if (rect && rect.colEnd > rect.colStart) return { kind: 'overwrite', rect, parts };
  if (rect) {
    // 零宽矩形（列光标，Alt+Shift+↑/↓ 产生）
    if (multi) return { kind: 'columnInsert', fromLine: rect.fromLine, col: rect.colStart, parts };
    return { kind: 'plainAtCol', line: rect.fromLine, col: rect.colStart, text: inp.clipText };
  }
  if (inp.cursor && multi && (inp.columnMode || inp.clipIsRect || inp.force)) {
    return { kind: 'columnInsert', fromLine: inp.cursor.line, col: inp.cursor.col, parts };
  }
  return { kind: 'normal' };
}

/** 列粘贴执行结果：changes 对当前文档；selection=粘贴后列光标恢复（新文档坐标，每行粘贴
 *  内容末尾的零宽 range，行数=块行数——与 changes 同一事务派发=一步撤销，AC-19）；
 *  rectAfter=恢复的零宽列光标（cursorCols 记录逐行内容末尾，不向最长行补齐）。 */
export interface ColumnPasteResult {
  changes: { from: number; to: number; insert: string }[];
  selection: { from: number; to: number }[];
  rectAfter: RectSpan | null;
}

/**
 * 覆盖/列插入两义的变更生成（005 规则 5a v3.0 纯函数，视觉列口径）：
 * - 覆盖：矩形行内先删 [colStart,colEnd) 视觉窗口再插入（colStart 超行尾=虚拟列补空格）；
 *   块行数超出矩形行时超出行按**同列插入**延伸（删除只发生在矩形内）；
 * - 列插入：逐行在列位纯插入（不删字符；短行/虚拟列补空格到列位）；
 * - 共口径：块行数超出文档末行 → **文末续行**（'\n' 前导+补空格对齐列位，末行无尾换行不强加、
 *   首条续行起才带行尾）；块行数少于目标行数 → 只动块内行（不重复末行、不追加行）；
 * - EOL：缓冲内部恒 '\n'（CRLF 文档由保存侧按主行尾统一回写，002 规则 4；剪贴板行尾已在读侧归一）。
 */
export function columnPasteChanges(
  plan: Extract<ColumnPastePlan, { kind: 'overwrite' | 'columnInsert' }>,
  ctx: { lineAt: (n: number) => RectLine; totalLines: number; docLength: number }
): ColumnPasteResult {
  const overwrite = plan.kind === 'overwrite';
  const firstLine = overwrite ? plan.rect.fromLine : plan.fromLine;
  const colStart = overwrite ? plan.rect.colStart : plan.col;
  const colEnd = overwrite ? plan.rect.colEnd : colStart;
  const parts = plan.parts;
  const targetEnd = firstLine + parts.length - 1;      // 块驱动的目标末行
  const inDoc = Math.min(targetEnd, ctx.totalLines);   // 文档内可落的末行
  const changes: { from: number; to: number; insert: string }[] = [];
  const widths: number[] = [];                         // 逐块行粘贴内容视觉宽（列光标右缘用）
  for (let i = 0; i < parts.length && firstLine + i <= inDoc; i++) {
    const line = ctx.lineAt(firstLine + i);
    const part = parts[i];
    widths.push(visualWidth(part, colStart));
    const w = visualWidth(line.text);
    if (w < colStart) {
      // 虚拟列（含列插入短行）：行尾补空格到列位再插入
      const at = line.from + line.text.length;
      changes.push({ from: at, to: at, insert: ' '.repeat(colStart - w) + part });
    } else if (overwrite && firstLine + i <= plan.rect.toLine) {
      // 覆盖：矩形行内删 [colStart,colEnd) 视觉窗口再插入
      const a = charAtVisualCol(line.text, colStart);
      const b = charAtVisualCol(line.text, colEnd);
      changes.push({ from: line.from + a, to: line.from + b, insert: part });
    } else {
      // 列插入（或覆盖块超出矩形行的延伸行）：列位纯插入，不删字符
      const a = charAtVisualCol(line.text, colStart);
      changes.push({ from: line.from + a, to: line.from + a, insert: part });
    }
  }
  // 文末续行：块行数超出文档末行（并入同一 change → 整块一步撤销）
  let tailSegs: string[] = [];
  if (targetEnd > ctx.totalLines) {
    const extraFrom = inDoc - firstLine + 1;
    tailSegs = parts.slice(extraFrom).map(p => '\n' + ' '.repeat(colStart) + p);
    for (let i = extraFrom; i < parts.length; i++) widths.push(visualWidth(parts[i], colStart));
    changes.push({ from: ctx.docLength, to: ctx.docLength, insert: tailSegs.join('') });
  }
  // 列光标恢复（AC-19）：按变更偏移换算新文档坐标，逐行落在该行粘贴内容末尾
  const selection: { from: number; to: number }[] = [];
  let off = 0;
  const rowChanges = tailSegs.length ? changes.slice(0, -1) : changes;
  for (const c of rowChanges) {
    selection.push({ from: c.from + off + c.insert.length, to: c.from + off + c.insert.length });
    off += c.insert.length - (c.to - c.from);
  }
  if (tailSegs.length) {
    const t = changes[changes.length - 1];
    let pos = t.from + off;
    for (const seg of tailSegs) {
      pos += seg.length;
      selection.push({ from: pos, to: pos });
    }
  }
   const cursorCols = widths.map(w => colStart + w);
   const rightCol = cursorCols[0] ?? colStart;
   return { changes, selection, rectAfter: { fromLine: firstLine, toLine: targetEnd, colStart: rightCol, colEnd: rightCol, cursorCols } };
}

/** 两面共用：按边缘带越界距离滚动；调用方负责 rAF 续选。 */
export function autoScrollBeyond(scroller: HTMLElement, clientY: number, onScrolled: () => void): void {
  const r = scroller.getBoundingClientRect();
  if (r.bottom <= r.top) return;
  const margin = Math.min(28, (r.bottom - r.top) / 2);
  const over = clientY < r.top + margin ? clientY - r.top - margin
    : clientY > r.bottom - margin ? clientY - r.bottom + margin : 0;
  if (!over) return;
  const before = scroller.scrollTop;
  scroller.scrollTop += Math.round(over / 3);
  if (scroller.scrollTop !== before) onScrolled();
}

/** 插入矩形宽度的空列，不覆盖；短行先补到视觉起始列。 */
export function rectInsertBlankChanges(rect: RectSpan, getLine: (n: number) => RectLine) {
  const changes: { from: number; to: number; insert: string }[] = [];
  const width = Math.max(1, rect.colEnd - rect.colStart);
  for (let n = rect.fromLine; n <= rect.toLine; n++) {
    const line = getLine(n);
    const at = line.from + charAtVisualCol(line.text, rect.colStart);
    changes.push({ from: at, to: at, insert: ' '.repeat(Math.max(0, rect.colStart - visualWidth(line.text)) + width) });
  }
  return changes;
}

/** 矩形内完整十进制数字统一增减，定点 BigInt 保精度、位数与前导零。 */
export function rectNumberChanges(rect: RectSpan, getLine: (n: number) => RectLine, delta: 1 | -1) {
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let n = rect.fromLine; n <= rect.toLine; n++) {
    const line = getLine(n);
    const a = charAtVisualCol(line.text, rect.colStart), b = charAtVisualCol(line.text, rect.colEnd);
    for (const m of line.text.matchAll(/[+-]?\d+(?:\.\d+)?/g)) {
      const at = m.index!;
      if (at < a || at + m[0].length > b) continue;
      const [integer, fraction = ''] = m[0].replace(/^[+-]/, '').split('.');
      const scale = 10n ** BigInt(fraction.length);
      const magnitude = BigInt(integer + fraction);
      const value = (m[0][0] === '-' ? -magnitude : magnitude) + BigInt(delta) * scale;
      const sign = value < 0n ? '-' : m[0][0] === '+' ? '+' : '';
      const digits = (value < 0n ? -value : value).toString().padStart(integer.length + fraction.length, '0');
      const insert = sign + (fraction.length ? digits.slice(0, -fraction.length) + '.' + digits.slice(-fraction.length) : digits);
      changes.push({ from: line.from + at, to: line.from + at + m[0].length, insert });
    }
  }
  return changes;
}
