import { syntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { isComposing } from '../common/composition';

export type TableOperation = 'rowAbove' | 'rowBelow' | 'colLeft' | 'colRight' | 'delRow' | 'delCol'
  | 'rowUp' | 'rowDown' | 'colPrev' | 'colNext' | 'left' | 'center' | 'right';
export interface TableModel { from: number; to: number; prefix: string; rows: string[][] }

/** GFM 的分隔符只认未转义竖线，代码中的竖线也必须转义。 */
export function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  let slashes = 0;
  for (let i = text.length - 2; i >= 0 && text[i] === '\\'; i--) slashes++;
  if (text.endsWith('|') && slashes % 2 === 0) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = ''; slashes = 0;
  for (const char of text) {
    if (char === '|' && slashes % 2 === 0) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
    slashes = char === '\\' ? slashes + 1 : 0;
  }
  cells.push(cell.trim());
  return cells;
}

export function safeCell(text: string): string {
  let out = '', slashes = 0;
  for (const char of text.replace(/\r\n?/g, '\n')) {
    if (char === '|' && slashes % 2 === 0) out += '\\';
    out += char === '\n' ? '<br>' : char;
    slashes = char === '\\' ? slashes + 1 : 0;
  }
  return out;
}

export function tableModel(state: EditorState, pos: number): TableModel | null {
  if (pos < 0 || pos > state.doc.length) return null;
  const tree = syntaxTree(state);
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node && node.name !== 'Table') node = node.parent;
  if (!node) {
    node = tree.resolveInner(pos, -1);
    while (node && node.name !== 'Table') node = node.parent;
  }
  if (!node) return null;
  const first = state.doc.lineAt(node.from);
  const prefix = state.doc.sliceString(first.from, node.from);
  const rows: string[][] = [];
  for (let line = first.number; line <= state.doc.lineAt(node.to).number; line++) {
    const text = state.doc.line(line).text;
    rows.push(splitTableRow(text.startsWith(prefix) ? text.slice(prefix.length) : text));
  }
  return { from: node.from, to: node.to, prefix, rows };
}

/** 删除结构本身而非逐格清空，避免留下仍可解析的竖线骨架。 */
export function deleteTable(view: EditorView, pos: number): boolean {
  if (view.state.readOnly || isComposing(view)) return false;
  const model = tableModel(view.state, pos);
  if (!model) return false;
  view.dispatch({ changes: { from: model.from, to: model.to }, selection: { anchor: model.from },
    userEvent: 'delete.table', annotations: isolateHistory.of('full') });
  return true;
}

function commit(view: EditorView, model: TableModel, row: number, col: number): void {
  const lines = model.rows.map(cells => '| ' + cells.join(' | ') + ' |');
  const sourceRow = row === 0 ? 0 : row + 1;
  let anchor = model.from;
  for (let i = 0; i < sourceRow; i++) anchor += lines[i]!.length + 1 + model.prefix.length;
  anchor += 2;
  for (let i = 0; i < col; i++) anchor += (model.rows[sourceRow]![i]?.length ?? 0) + 3;
  view.dispatch({ changes: { from: model.from, to: model.to, insert: lines.join('\n' + model.prefix) },
    selection: { anchor }, scrollIntoView: true, userEvent: 'input.table', annotations: isolateHistory.of('full') });
}

function pad(model: TableModel, cols: number): void {
  for (let i = 0; i < model.rows.length; i++) {
    const row = model.rows[i]!;
    while (row.length < cols) row.push(i === 1 ? '---' : '');
  }
}

/** 返回目标格供 UI 恢复焦点；键盘、工具条和菜单共用一条主历史事务。 */
export function runTableOperation(view: EditorView, pos: number, row: number, col: number, operation: TableOperation): { row: number; col: number } | null {
  if (view.state.readOnly || isComposing(view)) return null;
  const model = tableModel(view.state, pos);
  if (!model || row < 0 || row >= model.rows.length - 1 || col < 0 || col >= model.rows[0]!.length) return null;
  const cols = model.rows[0]!.length;
  const sourceRow = row === 0 ? 0 : row + 1;
  if (operation === 'rowAbove' || operation === 'rowBelow') {
    if (operation === 'rowAbove' && row === 0) return null;
    const at = operation === 'rowAbove' ? sourceRow : row === 0 ? 2 : sourceRow + 1;
    model.rows.splice(at, 0, Array(cols).fill(''));
    row = at - 1;
  } else if (operation === 'delRow') {
    if (row === 0) return null;
    model.rows.splice(sourceRow, 1); row = Math.min(row, model.rows.length - 2);
  } else if (operation === 'rowUp' || operation === 'rowDown') {
    const target = sourceRow + (operation === 'rowUp' ? -1 : 1);
    if (row === 0 || target < 2 || target >= model.rows.length) return null;
    [model.rows[sourceRow], model.rows[target]] = [model.rows[target]!, model.rows[sourceRow]!];
    row = target - 1;
  } else if (operation === 'delCol') {
    if (cols <= 1) return null;
    for (const cells of model.rows) if (col < cells.length) cells.splice(col, 1);
    col = Math.min(col, cols - 2);
  } else if (operation === 'colLeft' || operation === 'colRight') {
    const at = col + (operation === 'colRight' ? 1 : 0);
    for (let i = 0; i < model.rows.length; i++) {
      const cells = model.rows[i]!;
      while (cells.length < at) cells.push(i === 1 ? '---' : '');
      cells.splice(at, 0, i === 1 ? '---' : '');
    }
    col = at;
  } else if (operation === 'colPrev' || operation === 'colNext') {
    const target = col + (operation === 'colPrev' ? -1 : 1);
    if (target < 0 || target >= cols) return null;
    pad(model, cols);
    for (const cells of model.rows) [cells[col], cells[target]] = [cells[target]!, cells[col]!];
    col = target;
  } else {
    model.rows[1]![col] = operation === 'center' ? ':---:' : operation === 'right' ? '---:' : ':---';
  }
  commit(view, model, row, col);
  return { row, col };
}

export function resizeTable(view: EditorView, pos: number, rows: number, cols: number): boolean {
  if (view.state.readOnly || isComposing(view) || !Number.isInteger(rows) || !Number.isInteger(cols)
    || rows < 1 || cols < 1 || rows > 1000 || cols > 100) return false;
  const model = tableModel(view.state, pos);
  if (!model) return false;
  while (model.rows.length < rows + 2) model.rows.push(Array(cols).fill(''));
  model.rows.length = rows + 2;
  pad(model, cols);
  for (const cells of model.rows) cells.length = cols;
  commit(view, model, 1, 0);
  return true;
}

/** TSV 保留空格和空单元格，支持电子表格剪贴板的双引号/内嵌换行。 */
export function parseTablePaste(text: string): string[][] | null {
  if (!text.includes('\t')) return null;
  const grid: string[][] = [[]];
  let cell = '', quoted = false;
  const source = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '"' && (!cell || quoted)) {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === '\t' || ch === '\n')) {
      grid[grid.length - 1]!.push(safeCell(cell)); cell = '';
      if (ch === '\n') grid.push([]);
    } else cell += ch;
  }
  grid[grid.length - 1]!.push(safeCell(cell));
  if (source.endsWith('\n') && grid[grid.length - 1]!.length === 1 && !grid[grid.length - 1]![0]) grid.pop();
  return grid;
}

export function pasteTable(view: EditorView, pos: number, row: number, col: number, grid: string[][]): boolean {
  if (view.state.readOnly || isComposing(view) || !grid.length) return false;
  const model = tableModel(view.state, pos);
  if (!model) return false;
  const width = Math.max(model.rows[0]!.length, col + Math.max(...grid.map(r => r.length)));
  pad(model, width);
  for (let r = 0; r < grid.length; r++) {
    const at = row + r === 0 ? 0 : row + r + 1;
    while (model.rows.length <= at) model.rows.push(Array(width).fill(''));
    for (let c = 0; c < grid[r]!.length; c++) model.rows[at]![col + c] = grid[r]![c]!;
  }
  commit(view, model, row, col);
  return true;
}
