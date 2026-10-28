// markdown-view/live-table-actions —— LivePreviewView 类外置的表格交互与查找替换
// （批次 4 自 livepreview.ts 拆分，行为不变；方法体逐段原样搬移，this.view/this.host/this.isReadOnly
// 改为显式入参，this.findRunVersion 并发版本位经 isStale 回调由视图侧持有）。
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { RegExpCursor } from '@codemirror/search';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { isComposing } from '../common/composition';
import { t } from '../common/i18n';
import type { CtxMenuItem } from '../shell/chrome';
import { buildNeedleRe, type FindRunResult } from '../text-view/findbar';
import type { FindOptions } from '../common/ipc';
import { runTableOperation, type TableOperation } from './table-model';
import { destroyCellEditor } from './table-editor';
import { resumeTableCaret, pipePositions, cellsBetween, type TableRowInfo } from './live-widgets';

// ---- 表格交互与任务勾选（规则 23 M2 / AC-27） ----

/** 位置 → 所在 GFM 表格几何（非空源行 + 竖线位 + 单元格段；第二非空行为分隔行） */
export function tableAt(view: EditorView, pos: number): { nodeFrom: number; nodeTo: number; rows: TableRowInfo[] } | null {
  const state = view.state;
  let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  while (n && n.name !== 'Table') n = n.parent;
  if (!n) {
    n = syntaxTree(state).resolveInner(pos, -1);
    while (n && n.name !== 'Table') n = n.parent;
  }
  if (n) {
    const rows: TableRowInfo[] = [];
    let seen = 0;
    for (let ln = state.doc.lineAt(n.from).number; ln <= state.doc.lineAt(Math.max(n.from, n.to - 1)).number; ln++) {
      const line = state.doc.line(ln);
      if (!line.text.trim()) continue;
      const pipes = pipePositions(line);
      rows.push({ lineFrom: line.from, lineTo: line.to, pipes, cells: cellsBetween(pipes, line), delim: seen === 1 });
      seen++;
    }
    return { nodeFrom: n.from, nodeTo: n.to, rows };
  }
  return null;
}

/**
 * 活动表格内 Tab/Shift+Tab 单元格导航；行尾 Tab 加列、末行行尾（含末行末列）加行。
 * 触发口径：「末列」以光标过末竖线（行尾）计——格内 Tab 保持通行跨行导航，
 * 行尾 Tab 追加列（末行例外，加行），与规则 23 措辞逐字对齐。
 */
export function tableTabNav(view: EditorView, dir: 1 | -1): boolean {
  const ctx = tableAt(view, view.state.selection.main.head);
  if (!ctx) return false;
  const pos = view.state.selection.main.head;
  const rowIdx = ctx.rows.findIndex(r => pos >= r.lineFrom && pos <= r.lineTo);
  if (rowIdx < 0 || ctx.rows[rowIdx]!.delim) return false;
  const row = ctx.rows[rowIdx]!;
  const pipes = row.pipes;
  if (pipes.length < 2) return false;
  const navIdx = ctx.rows.map((r, i) => (r.delim ? -1 : i)).filter(i => i >= 0); // 可导航行（源行序）
  const myNav = navIdx.indexOf(rowIdx);
  const lastPipe = pipes[pipes.length - 1]!;
  let j = 0; // 当前列：右界竖线 ≥ pos 的首格
  while (j + 1 < pipes.length && pipes[j + 1]! < pos) j++;
  const cells = row.cells;
  const go = (p: number): void => {
    view.dispatch({ selection: { anchor: p }, scrollIntoView: true });
  };
  if (dir === 1) {
    if (pos > lastPipe) { // 行尾：非末行加列、末行加行
      if (myNav >= navIdx.length - 1) appendRow(view, ctx, rowIdx);
      else appendColumn(view, ctx, rowIdx);
      return true;
    }
    if (j < cells.length - 1) { go(cells[j + 1]!.from); return true; }
    if (myNav < navIdx.length - 1) { // 末格非末行 → 下行首格
      const next = ctx.rows[navIdx[myNav + 1]!]!;
      go(next.cells[0]?.from ?? next.lineFrom + 1);
      return true;
    }
    appendRow(view, ctx, rowIdx); // 末行末列 → 加行
    return true;
  }
  if (pos > lastPipe) { go(cells[cells.length - 1]?.from ?? row.lineFrom + 1); return true; }
  if (j > 0) { go(cells[j - 1]!.from); return true; }
  if (myNav > 0) {
    const prev = ctx.rows[navIdx[myNav - 1]!]!;
    go(prev.cells[prev.cells.length - 1]?.from ?? prev.lineTo - 1);
    return true;
  }
  return true; // 首行首格吞掉 Shift+Tab，不往表格插入缩进字符。
}

/** 行尾 Tab 加列：每个非空源行行尾补一格（分隔行补 --- 保持 GFM 有效）；单事务单步撤销 */
function appendColumn(view: EditorView, ctx: { rows: TableRowInfo[] }, rowIdx: number): void {
  const changes = ctx.rows.map(r => ({
    from: r.lineTo,
    to: r.lineTo,
    insert: r.delim ? ' ---|' : '  |',
  }));
  const cursor = ctx.rows[rowIdx]!.lineTo + 1;
  view.dispatch({ changes, selection: { anchor: cursor }, scrollIntoView: true, userEvent: 'input.table', annotations: isolateHistory.of('full') });
}

/** 末行行尾/末列 Tab 加行：表尾续一行空行（列数取表头）；单事务单步撤销 */
function appendRow(view: EditorView, ctx: { rows: TableRowInfo[] }, rowIdx: number): void {
  const cols = Math.max(1, ctx.rows[0]?.cells.length ?? 1);
  const row = '|' + '  |'.repeat(cols);
  const at = ctx.rows[rowIdx]!.lineTo;
  view.dispatch({
    changes: { from: at, to: at, insert: '\n' + row },
    selection: { anchor: at + 3 }, // 新行首格
    scrollIntoView: true,
    userEvent: 'input.table',
    annotations: isolateHistory.of('full'),
  });
}

/** 非活动表格右键「表格 ▸」行列增删：整表源重写（单 change 单步撤销），完成后光标入表转活动。
 *  tablePos 为菜单构建时的块内位（点菜单项时光标可能已动，不按选区反查）。 */
function tableOp(
  view: EditorView,
  host: HTMLElement,
  readOnly: boolean,
  kind: TableOperation,
  domRow: number,
  col: number,
  tablePos: number
): void {
  if (readOnly || isComposing(view)) return;
  const box = [...host.querySelectorAll<HTMLElement>('.mdir-tablebox')].find(el => Number(el.dataset.mdTableFrom) === tablePos);
  if (box) destroyCellEditor(box);
  if (runTableOperation(view, tablePos, domRow, col, kind)) {
    view.focus();
    if (box) resumeTableCaret(view, box);
  }
}

/** 右键「表格 ▸」项（点击的 DOM 行列相对化；表头行禁上方插行/删行——会让表失格） */
export function tableMenuItems(view: EditorView, host: HTMLElement, readOnly: boolean, domRow: number, col: number, tablePos: number): CtxMenuItem[] {
  const ops: [string, (() => void) | null][] = [
    [t('tbl.rowAbove'), domRow > 0 ? () => tableOp(view, host, readOnly, 'rowAbove', domRow, col, tablePos) : null],
    [t('tbl.rowBelow'), () => tableOp(view, host, readOnly, 'rowBelow', domRow, col, tablePos)],
    [t('tbl.colLeft'), () => tableOp(view, host, readOnly, 'colLeft', domRow, col, tablePos)],
    [t('tbl.colRight'), () => tableOp(view, host, readOnly, 'colRight', domRow, col, tablePos)],
    [t('tbl.delRow'), domRow > 0 ? () => tableOp(view, host, readOnly, 'delRow', domRow, col, tablePos) : null],
    [t('tbl.delCol'), () => tableOp(view, host, readOnly, 'delCol', domRow, col, tablePos)],
    [t('tbl.rowUp'), domRow > 1 ? () => tableOp(view, host, readOnly, 'rowUp', domRow, col, tablePos) : null],
    [t('tbl.rowDown'), domRow > 0 ? () => tableOp(view, host, readOnly, 'rowDown', domRow, col, tablePos) : null],
    [t('tbl.colPrev'), col > 0 ? () => tableOp(view, host, readOnly, 'colPrev', domRow, col, tablePos) : null],
    [t('tbl.colNext'), () => tableOp(view, host, readOnly, 'colNext', domRow, col, tablePos)],
    ...(['left', 'center', 'right'] as const).map(kind => [t('tbl.' + kind), () => tableOp(view, host, readOnly, kind, domRow, col, tablePos)] as [string, () => void]),
  ];
  return [[t('ctx.table'), () => void 0, ops.map(([label, run]) => [label, readOnly ? null : run])]];
}

// ---- 查找替换（FindBar 回调承载，规则 20） ----

/** 就地查找执行体（原 LivePreviewView.fbRun）：并发弃置判定（findRunVersion 版本位 + 销毁位）
 *  是视图生命周期状态，经 isStale 回调注入；其余逻辑逐行原样。 */
export async function fbRun(
  view: EditorView | undefined,
  needle: string,
  o: FindOptions,
  dir: 1 | -1,
  count: boolean,
  jump: boolean,
  isStale: () => boolean
): Promise<FindRunResult> {
  const noCounts = { total: null, before: null };
  if (!needle || !view) return { hit: null, counts: noCounts };
  const doc = view.state.doc;
  const all: Array<{ from: number; to: number }> = [];
  try {
    const base = buildNeedleRe(needle, o);
    // RegExpCursor 直接在 CM Text 上分行扫描，避免为一次查找复制整篇 Markdown。
    // 每批命中让出事件循环；输入期间如果出现新请求，旧请求立即丢弃结果。
    const cursor = new RegExpCursor(doc, base.source, { ignoreCase: base.ignoreCase });
    while (!cursor.done && all.length < 200000) {
      cursor.next();
      if (cursor.done) break;
      const m = cursor.value;
      all.push({ from: m.from, to: m.to });
      if (all.length % 2048 === 0) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (isStale()) return { hit: null, counts: noCounts };
      }
    }
  } catch {
    return { hit: null, counts: noCounts };
  }
  if (isStale()) return { hit: null, counts: noCounts };
  if (all.length === 0) return { hit: null, counts: count ? { total: 0, before: null } : noCounts };
  const sel = view.state.selection.main;
  let idx: number;
  if (dir === 1) {
    idx = all.findIndex(mm => mm.from >= sel.to);
    if (idx < 0) idx = 0; // 环绕回首个
  } else {
    idx = -1;
    for (let i = 0; i < all.length; i++) {
      if (all[i]!.from < sel.from) idx = i;
      else break;
    }
    if (idx < 0) idx = all.length - 1; // 环绕回末个
  }
  const counts = { total: all.length, before: idx };
  const mm = all[idx]!;
  if (jump) {
    view.dispatch({ selection: { anchor: mm.from, head: mm.to }, scrollIntoView: true });
    view.focus();
  }
  const line = doc.lineAt(mm.from);
  return { hit: { line: line.number, col: mm.from - line.from + 1 }, counts };
}

export function fbReplaceNext(view: EditorView | undefined, needle: string, replacement: string, o: FindOptions): boolean {
  if (!view) return false;
  const docText = view.state.doc.toString();
  const sel = view.state.selection.main;
  const base = buildNeedleRe(needle, o);
  const g = new RegExp(base.source, base.flags.includes('g') ? base.flags : base.flags + 'g');
  let target: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = g.exec(docText)) != null) {
    if (m.index >= sel.from) { target = m; break; }
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  if (!target) {
    g.lastIndex = 0;
    target = g.exec(docText);
  }
  if (!target) return false;
  const inner = new RegExp(base.source, base.flags);
  const replaced = target[0].replace(inner, replacement);
  const from = target.index;
  const to = from + target[0].length;
  // 替换点起的首个命中选中之——后续「替换」/Enter 自然步进；单次 dispatch = 单步撤销
  const newText = docText.slice(0, from) + replaced + docText.slice(to);
  const g2 = new RegExp(base.source, base.flags.includes('g') ? base.flags : base.flags + 'g');
  let next: { from: number; to: number } | null = null;
  let mm: RegExpExecArray | null;
  while ((mm = g2.exec(newText)) != null) {
    if (mm.index >= from) { next = { from: mm.index, to: mm.index + mm[0].length }; break; }
    if (mm.index === g2.lastIndex) g2.lastIndex++;
  }
  if (!next) {
    g2.lastIndex = 0;
    const m3 = g2.exec(newText);
    if (m3) next = { from: m3.index, to: m3.index + m3[0].length };
  }
  view.dispatch({
    changes: { from, to, insert: replaced },
    selection: next ? { anchor: next.from, head: next.to } : { anchor: from + replaced.length },
    scrollIntoView: true,
  });
  return true;
}

export function fbReplaceAll(view: EditorView | undefined, needle: string, replacement: string, o: FindOptions): number {
  if (!view) return 0;
  const docText = view.state.doc.toString();
  const base = buildNeedleRe(needle, o);
  const g = new RegExp(base.source, base.flags.includes('g') ? base.flags : base.flags + 'g');
  const changes: { from: number; to: number; insert: string }[] = [];
  let m: RegExpExecArray | null;
  const inner = new RegExp(base.source, base.flags);
  while ((m = g.exec(docText)) != null) {
    changes.push({ from: m.index, to: m.index + m[0].length, insert: m[0].replace(inner, replacement) });
    if (m.index === g.lastIndex) g.lastIndex++;
  }
  if (changes.length) view.dispatch({ changes }); // 单次 dispatch = 单步撤销
  return changes.length;
}
