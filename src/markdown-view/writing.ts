import { EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentMore, indentLess, isolateHistory } from '@codemirror/commands';
import { acceptCompletion, selectedCompletion, closeBrackets, closeBracketsKeymap, closeCompletion } from '@codemirror/autocomplete';
import { syntaxTree, indentUnit } from '@codemirror/language';
import { markdownLanguage, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';
import { compositionActive, compositionChanged, isComposing } from '../common/composition';
import { splitTableRow } from './table-model';

export const inlineFormatMarks: Readonly<Record<string, string>> = { bold: '**', italic: '*', strike: '~~', inlineCode: '`' };
export interface InlineFormat { from: number; to: number; marks: readonly string[]; pending: boolean; trailing?: number }
/** 定界符按 外层→内层 存放；粗+斜组合即 ['**','*'] → 开 '***' 闭 '***'。 */
export const inlineFormatOpen = (value: InlineFormat): string => value.marks.join('');
export const inlineFormatClose = (value: InlineFormat): string => [...value.marks].reverse().join('');
export const inlineFormatChanged = StateEffect.define<InlineFormat | null>();
/** 待输入格式只保存源范围；首次输入才补定界符，组合期间仅映射，不扰动输入DOM。 */
export const inlineFormatField = StateField.define<InlineFormat | null>({
  create: () => null,
  update(value, tr) {
    if (value) value = { ...value, from: tr.changes.mapPos(value.from, -1), to: tr.changes.mapPos(value.to, 1) };
    for (const effect of tr.effects) if (effect.is(inlineFormatChanged)) value = effect.value;
    if (!value || tr.state.readOnly || tr.isUserEvent('undo') || tr.isUserEvent('redo')) return null;
    if (tr.selection && !tr.docChanged && !tr.effects.some(e => e.is(inlineFormatChanged))) return null;
    return value;
  },
});
const inlineFormatInput = EditorState.transactionFilter.of(tr => {
  const value = tr.startState.field(inlineFormatField, false);
  if (!value || tr.startState.readOnly) return tr;
  const settling = tr.effects.some(e => e.is(compositionChanged) && !e.value);
  if (tr.startState.field(compositionActive, false) && !settling) return tr;
  if (!settling && (!tr.docChanged || !(tr.isUserEvent('input.type') || tr.isUserEvent('input.paste') || tr.isUserEvent('delete')))) return tr;
  const from = tr.changes.mapPos(value.from, -1), to = tr.changes.mapPos(value.to, 1);
  const openMark = inlineFormatOpen(value), closeMark = inlineFormatClose(value), size = openMark.length;
  let content = tr.newDoc.sliceString(from, to), close = to;
  if (!value.pending) {
    close = tr.changes.mapPos(value.to - (value.trailing ?? 0) - size, 1);
    if (tr.newDoc.sliceString(from, from + size) !== openMark || tr.newDoc.sliceString(close, close + size) !== closeMark)
      return [tr, { effects: inlineFormatChanged.of(null) }];
    content = tr.newDoc.sliceString(from + size, close) + tr.newDoc.sliceString(close + size, to);
  }
  const newline = content.indexOf('\n'), first = newline < 0 ? content : content.slice(0, newline);
  if (value.pending && !first.trim()) return newline < 0 ? tr : [tr, { effects: inlineFormatChanged.of(null) }];
  const leading = first.length - first.trimStart().length, body = first.trim();
  const tail = content.slice(leading + body.length);
  // Markdown强调不能以空白收尾。把尾空白留在定界符之外，下一字输入时再纳入正文。
  const insert = content.slice(0, leading) + (body ? openMark + body + closeMark : '') + tail;
  if (!value.pending && newline < 0 && insert === tr.newDoc.sliceString(from, to)) return tr;
  const mapCursor = (pos: number): number => {
    const logical = pos - from - (value.pending ? 0 : pos <= close ? size : size * 2);
    return from + Math.max(0, logical) + (body && logical >= leading ? size : 0)
      + (body && logical > leading + body.length ? size : 0);
  };
  return [tr, { sequential: true, changes: { from, to, insert },
    selection: { anchor: mapCursor(tr.newSelection.main.anchor), head: mapCursor(tr.newSelection.main.head) },
    effects: inlineFormatChanged.of(newline >= 0 ? null : { from: from + leading, to: from + insert.length,
      marks: value.marks, pending: !body, trailing: tail.length }),
    ...(settling ? { userEvent: 'input.type.compose', annotations: isolateHistory.of('after') }
      : value.pending ? { annotations: isolateHistory.of('before') } : {}),
  }];
});

const fenceStart = /^(\s*(?:>\s*)*)(`{3,}|~{3,})([^`]*)$/;
export const fenceSourceChanged = StateEffect.define<number>();
export const fenceSourceField = StateField.define<number | null>({
  create: () => null,
  update(position, tr) {
    if (position !== null) position = tr.changes.mapPos(position);
    for (const effect of tr.effects) if (effect.is(fenceSourceChanged)) position = effect.value;
    return position !== null && tr.state.doc.lineAt(tr.state.selection.main.head).from === position ? position : null;
  },
});

/** 新键入的围栏尚未成为独立块，不能借用后文代码块的闭合标记。 */
export const fenceDraftField = StateField.define<number | null>({
  create: () => null,
  update(position, tr) {
    if (position !== null) position = tr.changes.mapPos(position, -1);
    const line = tr.newDoc.lineAt(tr.newSelection.main.head);
    if (tr.isUserEvent('input.type') && tr.newSelection.main.empty && fenceStart.test(line.text)) {
      const oldLine = tr.startState.doc.lineAt(tr.startState.selection.main.head);
      let singleLine = true;
      tr.changes.iterChanges((_a, _b, _c, _d, inserted) => { if (inserted.lines > 1) singleLine = false; });
      if (singleLine && !fenceStart.test(oldLine.text)) position = line.from;
    }
    return position === line.from && fenceStart.test(line.text) ? position : null;
  },
});

/** 围栏行被整块替换件隐藏后，空选区落在围栏行行首时浏览器会把键入内容转移到部件之后的
 *  可编辑节点（文字落到块外）。把这类落点回退到上一行末尾：闭合围栏→块内末行末尾；
 *  开启围栏→块上一行末尾。显式围栏编辑态（点击语言标签/草稿围栏）与组合输入不干预。 */
const fenceLineStartCaret = EditorState.transactionFilter.of(tr => {
  if (tr.docChanged || !tr.selection) return tr;
  const sel = tr.selection.main;
  if (!sel.empty) return tr;
  if (tr.effects.some(e => e.is(fenceSourceChanged))) return tr;
  if (tr.startState.field(compositionActive, false)) return tr;
  const state = tr.state;
  const pos = sel.head;
  if (pos === 0 || pos !== state.doc.lineAt(pos).from) return tr;
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node.parent && node.name !== 'FencedCode') node = node.parent;
  if (node.name !== 'FencedCode') return tr;
  const marks = node.getChildren('CodeMark');
  if (!marks.length) return tr;
  const openLine = state.doc.lineAt(marks[0].from).number;
  const closeLine = marks.length > 1 ? state.doc.lineAt(marks[marks.length - 1].from).number : -1;
  const lineNo = state.doc.lineAt(pos).number;
  if (lineNo !== openLine && lineNo !== closeLine) return tr;
  if (state.field(fenceSourceField, false) !== null || state.field(fenceDraftField, false) !== null) return tr;
  return [tr, { selection: { anchor: pos - 1 } }];
});

/** 编辑器的隐藏围栏是结构边界，单次删除键只移入/移出，不删除半个块。 */
function fenceBoundary(view: EditorView, direction: -1 | 1): boolean {
  const { state } = view, range = state.selection.main;
  if (state.readOnly || isComposing(view) || !range.empty || state.selection.ranges.length !== 1) return false;
  const near = Math.max(0, Math.min(state.doc.length, range.head + direction));
  for (const position of [range.head, near]) {
    let node = syntaxTree(state).resolveInner(position, direction);
    while (node.parent && node.name !== 'FencedCode') node = node.parent;
    if (node.name !== 'FencedCode') continue;
    const marks = node.getChildren('CodeMark'), open = state.doc.lineAt(node.from);
    if (state.field(fenceSourceField) === open.from || state.field(fenceDraftField) === open.from) continue;
    const close = marks.length > 1 ? state.doc.lineAt(marks[marks.length - 1]!.from) : null;
    const first = open.number < state.doc.lines ? state.doc.line(open.number + 1) : open;
    const last = close && close.number > first.number ? state.doc.line(close.number - 1) : first;
    const prefixLength = node.from - open.from;
    const bodyStart = first
      ? first.from + Math.min(prefixLength, /^[ >\t]*/.exec(first.text)![0].length)
      : open.to;
    const beforeOpen = direction > 0 && range.head === open.from - 1;
    const atFirst = direction < 0 && range.head === bodyStart;
    const atClose = close && range.head >= close.from && range.head <= close.to;
    const afterClose = direction < 0 && close && range.head === close.to + 1;
    const atLast = direction > 0 && close && range.head === last.to;
    if (!beforeOpen && !atFirst && !atClose && !afterClose && !atLast) continue;
    if (atFirst) {
      const bodyEnd = close?.from ?? node.to;
      const bodyLines = bodyEnd > first.from
        ? Array.from({ length: (close?.number ?? state.doc.lines) - first.number }, (_, i) =>
          state.doc.line(first.number + i).text.replace(/^[\t >]*/, '').trim())
        : [];
      if (bodyLines.every(line => !line)) {
        const prefix = state.doc.sliceString(open.from, node.from);
        view.dispatch({ changes: { from: open.from, to: close?.to ?? node.to, insert: prefix },
          selection: { anchor: open.from + prefix.length }, userEvent: 'delete.backward',
          annotations: isolateHistory.of('full'), scrollIntoView: true });
        return true;
      }
    }
    if (atFirst || (beforeOpen && close?.number === first.number)) {
      const info = node.getChild('CodeInfo');
      view.dispatch({ selection: { anchor: info?.from ?? marks[0]!.to, head: info?.to ?? marks[0]!.to },
        effects: fenceSourceChanged.of(open.from), scrollIntoView: true });
    } else {
      const anchor = direction < 0 ? last.to : close && !beforeOpen
        ? (close.to === state.doc.length ? last.to : close.to + 1) : bodyStart;
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
    }
    return true;
  }
  return false;
}

interface Pair { open: number; close: number; mark: string }
const pairChanged = StateEffect.define<Pair | null>();
const pairField = StateField.define<Pair | null>({
  create: () => null,
  update(pair, tr) {
    if (pair && tr.docChanged) pair = { ...pair, open: tr.changes.mapPos(pair.open, -1), close: tr.changes.mapPos(pair.close, 1) };
    for (const effect of tr.effects) if (effect.is(pairChanged)) pair = effect.value;
    if (pair && (tr.state.doc.sliceString(pair.open, pair.open + pair.mark.length) !== pair.mark
      || tr.state.doc.sliceString(pair.close, pair.close + pair.mark.length) !== pair.mark
      || tr.state.selection.main.head < pair.open || tr.state.selection.main.head > pair.close + pair.mark.length)) return null;
    return pair;
  },
});

function inNode(view: EditorView, names: readonly string[]): boolean {
  for (let node = syntaxTree(view.state).resolveInner(view.state.selection.main.head, -1); node; node = node.parent!) {
    if (names.includes(node.name)) return true;
  }
  return false;
}

// GFM 表格会吸收紧邻的下文行（即使该行不含竖线，lezer 与 markdown-it 一致）。
// IR 中表格渲染为独立部件，用户在表格下方的行输入时视觉在表外、实际被并进表格。
// 开始输入时先补一个空行把新段落与表格隔开；键入竖线视为有意续表，不干预。
const tableGapBlank = /^[ \t]*(?:>[ \t]?)*$/;
const tableGapQuote = /^[ \t]*(?:>[ \t]?)+/;
interface TableGap { from: number; insert: string }
const tableGapChanged = StateEffect.define<TableGap | null>();
/** 组合输入开始时记录待分离位置（组合期间不能改动文档），结束时若组合文本会被吸收则补空行。 */
const tableGapField = StateField.define<TableGap | null>({
  create: () => null,
  update(value, tr) {
    // 偏置 -1：组合文本插在该位置之后时，记录点始终指向组合文本的起点。
    if (value) value = { ...value, from: tr.changes.mapPos(value.from, -1) };
    for (const effect of tr.effects) if (effect.is(tableGapChanged)) value = effect.value;
    return value;
  },
});
/** 键入连击所在的行；点击或键盘移动光标后清空。用于区分"在表格末行源码上逐字键入新行"与"光标落到表格外后输入"。 */
const tableRowTyping = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    if (tr.docChanged && tr.isUserEvent('input')) return tr.newDoc.lineAt(tr.newSelection.main.head).from;
    if (tr.selection && !tr.docChanged) return null;
    return value === null ? null : tr.changes.mapPos(value, -1);
  },
});
function tableGapInsert(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos);
  if (pos !== line.to) return null;
  if (tableGapBlank.test(line.text)) {
    if (line.number <= 1) return null;
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from - 1, -1);
    while (node && node.name !== 'Table') node = node.parent;
    if (!node) return null;
    return '\n' + (tableGapQuote.exec(line.text)?.[0] ?? '');
  }
  // 表格在文末且无尾换行：点表格下方时光标落在末行源码末尾，输入同样被吸进末格。
  // 正在该行键入连击（如逐字键入新表行）时不干预。
  if (pos !== state.doc.length || state.field(tableRowTyping, false) === line.from) return null;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node && node.name !== 'Table') node = node.parent;
  if (!node || node.to !== pos) return null;
  const prefix = tableGapQuote.exec(line.text)?.[0] ?? '';
  return '\n' + prefix + '\n' + prefix;
}
const tableBoundaryInput = EditorState.transactionFilter.of(tr => {
  if (tr.startState.readOnly) return tr;
  const settling = tr.effects.some(e => e.is(compositionChanged) && !e.value);
  if (tr.effects.some(e => e.is(compositionChanged) && e.value)) {
    const head = tr.startState.selection.main.head, insert = tableGapInsert(tr.startState, head);
    return [tr, { effects: tableGapChanged.of(insert === null ? null : { from: head, insert }) }];
  }
  if (tr.startState.field(compositionActive, false) && !settling) return tr;
  if (settling) {
    const gap = tr.startState.field(tableGapField, false);
    if (!gap) return tr;
    const pos = Math.min(tr.changes.mapPos(gap.from, -1), tr.newDoc.length);
    const tail = tr.newDoc.sliceString(pos, tr.newDoc.lineAt(pos).to);
    if (!tail.trim() || tail.includes('|')) return [tr, { effects: tableGapChanged.of(null) }];
    return [tr, { sequential: true, changes: { from: pos, insert: gap.insert }, effects: tableGapChanged.of(null) }];
  }
  if (!tr.docChanged || !tr.isUserEvent('input')) return tr;
  const fixes: { from: number; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    if (fromA !== toA) return;
    const insert = tableGapInsert(tr.startState, fromA);
    if (insert === null) return;
    const first = inserted.line(1).text;
    if (!first.trim() || first.includes('|')) return;
    fixes.push({ from: fromB, insert });
  });
  return fixes.length ? [tr, { sequential: true, changes: fixes }] : tr;
});

function enter(view: EditorView): boolean {
  if (view.state.readOnly || isComposing(view) || view.state.selection.ranges.length !== 1) return false;
  // 写作键位优先于默认补全键位；必须先提交选中的语言，不能把候选丢弃后直接进入正文。
  if (selectedCompletion(view.state) && fenceStart.test(view.state.doc.lineAt(view.state.selection.main.head).text)) {
    if (!acceptCompletion(view)) return true;
  }
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const line = view.state.doc.lineAt(range.head);
  if (range.head !== line.to) return false;
  const match = fenceStart.exec(line.text);
  if (match) {
    let node = syntaxTree(view.state).resolveInner(range.head, -1);
    while (node.parent && node.name !== 'FencedCode') node = node.parent;
    if (node.name !== 'FencedCode' || node.from < line.from) return false;
    closeCompletion(view);
    const prefix = match[1]!;
    const closed = node.getChildren('CodeMark').length > 1 && view.state.field(fenceDraftField) !== line.from;
    if (closed && view.state.field(fenceSourceField) === line.from) {
      const body = view.state.doc.line(line.number + 1), marks = node.getChildren('CodeMark'), close = marks[marks.length - 1]!;
      if (close.from > body.to) {
        view.dispatch({ selection: { anchor: body.from + prefix.length }, scrollIntoView: true });
        return true;
      }
    }
    const insert = '\n' + prefix + (closed ? '' : '\n' + prefix + match[2]);
    view.dispatch({ changes: { from: range.head, insert }, selection: { anchor: range.head + 1 + prefix.length },
      userEvent: 'input', annotations: isolateHistory.of('full') });
    return true;
  }
  if (inNode(view, ['FencedCode', 'CodeBlock', 'Table', 'HTMLBlock'])) return false;
  // 空列表项回车 = 退出列表（通行编辑习惯）：摘掉本行标记并在原位补一个前导空行——
  // 光标落在块间空行上，接下来键入的段落不会被 GFM 懒续行进上一项（块边界正确）。
  const emptyItem = /^(\s*)(?:[-*+]|\d+[.)])(?:\s+\[[ xX]\])?(\s+)$/.exec(line.text);
  if (emptyItem && range.head > line.from + emptyItem[1]!.length) {
    const indent = emptyItem[1]!;
    const at = line.from + indent.length;
    view.dispatch({
      changes: { from: at, to: line.to, insert: '\n' },
      selection: { anchor: at + 1 },
      userEvent: 'input', annotations: isolateHistory.of('full'),
    });
    return true;
  }
  const header = /^(\s*(?:>\s*)*)(\|.*\|)\s*$/.exec(line.text);
  if (!header) return false;
  const cells = splitTableRow(header[2]!);
  if (cells.length < 2 || cells.every(cell => /^:?-+:?$/.test(cell))) return false;
  const prefix = header[1]!;
  const insert = '\n' + prefix + '| ' + cells.map(() => '---').join(' | ') + ' |'
    + '\n' + prefix + '|' + cells.map(() => '  |').join('') + '\n';
  const anchor = range.head + insert.indexOf('\n', 1) + 1 + prefix.length + 2;
  view.dispatch({ changes: { from: range.head, insert }, selection: { anchor },
    userEvent: 'input.table', annotations: isolateHistory.of('full') });
  return true;
}

export function markdownIndent(view: EditorView, direction: 1 | -1): boolean {
  if (view.state.readOnly || isComposing(view) || !inNode(view, ['ListItem'])) return false;
  return (direction > 0 ? indentMore : indentLess)(view);
}

function exitCode(view: EditorView): boolean {
  if (view.state.readOnly || isComposing(view) || !view.state.selection.main.empty) return false;
  let node = syntaxTree(view.state).resolveInner(view.state.selection.main.head, -1);
  while (node.parent && node.name !== 'FencedCode') node = node.parent;
  if (node.name !== 'FencedCode' || node.getChildren('CodeMark').length < 2) return false;
  const end = view.state.doc.lineAt(node.to).to;
  const changes = end === view.state.doc.length ? { from: end, insert: '\n\n' } : undefined;
  view.dispatch({ changes, selection: { anchor: end + 1 }, scrollIntoView: true,
    userEvent: changes ? 'input' : undefined, annotations: isolateHistory.of('full') });
  return true;
}

/** Shift-Enter 段内硬换行（007 v0.37，通行编辑习惯）：源码为行尾两空格 + 换行的 CommonMark
 *  硬换行，渲染沿用 v0.27 投影口径（行尾标记折叠、换行保留）；与 Enter（新块/续项）区分。 */
function insertHardBreak(view: EditorView): boolean {
  const range = view.state.selection.main;
  if (view.state.readOnly || isComposing(view) || view.state.selection.ranges.length !== 1 || !range.empty) return false;
  if (inNode(view, ['FencedCode', 'CodeBlock', 'InlineCode', 'Table', 'HTMLBlock'])) return false;
  // 标题是单行块，硬换行会把标题拆散；Lezer 节点名是 ATXHeading1-6/SetextHeading1-6（无裸 ATXHeading）。
  for (let node = syntaxTree(view.state).resolveInner(range.head, -1); node; node = node.parent!)
    if (/^(?:ATX|Setext)Heading[1-6]$/.test(node.name)) return false;
  view.dispatch({ changes: { from: range.head, insert: '  \n' }, selection: { anchor: range.head + 3 },
    userEvent: 'input', annotations: isolateHistory.of('full') });
  return true;
}

/** 只在第二枚标记输入时补成对定界符，首枚 * 仍可用于列表和分隔线。 */
export function markdownWriting(): Extension {
  return [inlineFormatField, inlineFormatInput, pairField, fenceSourceField, fenceDraftField, fenceLineStartCaret, tableGapField, tableRowTyping, tableBoundaryInput, indentUnit.of('    '),
    markdownLanguage.data.of({ closeBrackets: { brackets: ['(', '[', '{', '"'] } }), closeBrackets(),
    EditorView.inputHandler.of((view, from, to, text) => {
      if (view.state.readOnly || isComposing(view) || view.state.selection.ranges.length !== 1 || text.length !== 1 || from !== to) return false;
      const pair = view.state.field(pairField);
      if (pair && from === pair.close && pair.close === pair.open + pair.mark.length && text === pair.mark[0]) {
        const raw = pair.mark + text;
        view.dispatch({ changes: { from: pair.open, to: pair.close + pair.mark.length, insert: raw },
          selection: { anchor: pair.open + raw.length }, effects: pairChanged.of(null), userEvent: 'input.type' });
        return true;
      }
      if (pair && from >= pair.close && from < pair.close + pair.mark.length && text === pair.mark[from - pair.close]) {
        view.dispatch({ selection: EditorSelection.cursor(from + 1), annotations: Transaction.addToHistory.of(false) });
        return true;
      }
      if (!/^[*_~]$/.test(text) || inNode(view, ['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock'])) return false;
      const line = view.state.doc.lineAt(from);
      if (view.state.doc.sliceString(Math.max(line.from, from - 1), from) !== text
        || view.state.doc.sliceString(Math.max(line.from, from - 2), from - 1) === text
        || /\S/.test(view.state.doc.sliceString(to, Math.min(view.state.doc.length, to + 1)))) return false;
      const mark = text.repeat(2);
      view.dispatch({ changes: { from, insert: text + mark }, selection: { anchor: from + 1 },
        effects: pairChanged.of({ open: from - 1, close: from + 1, mark }), userEvent: 'input.type' });
      return true;
    }),
    Prec.highest(keymap.of([
      { key: 'Mod-Enter', run: exitCode },
      { key: 'Shift-Enter', run: insertHardBreak },
      { key: 'Enter', run: enter },
      { key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
      { key: 'ArrowLeft', run: view => fenceBoundary(view, -1) },
      { key: 'ArrowRight', run: view => fenceBoundary(view, 1) },
      { key: 'Delete', run: view => fenceBoundary(view, 1) },
      { key: 'Mod-Delete', run: view => fenceBoundary(view, 1) },
      { key: 'Mod-Backspace', run: view => fenceBoundary(view, -1) },
      { key: 'Backspace', run: view => {
        if (view.state.readOnly || isComposing(view)) return false;
        if (fenceBoundary(view, -1)) return true;
        const range = view.state.selection.main;
        // 列表项内容行首 Backspace：摘掉标记与尾随空白，内容顶到基准缩进（通行编辑习惯）——
        // 修前 CM 默认行为把标记替换成等宽空格（顶层残留 2–6 空格，观感像标记变成了空白）。
        if (range.empty && view.state.selection.ranges.length === 1
          && !inNode(view, ['FencedCode', 'CodeBlock', 'Table', 'HTMLBlock'])) {
          const line = view.state.doc.lineAt(range.head);
          const item = /^(\s*)(?:[-*+]|\d+[.)])(?:\s+\[[ xX]\])?\s+/.exec(line.text);
          if (item) {
            const contentStart = line.from + item[0].length;
            if (range.head === contentStart) {
              const base = line.from + item[1]!.length;
              view.dispatch({ changes: { from: base, to: contentStart },
                selection: { anchor: base }, userEvent: 'delete.backward' });
              return true;
            }
          }
        }
        const pair = view.state.field(pairField);
        if (!pair || !range.empty || range.head !== pair.close || pair.close !== pair.open + pair.mark.length) return false;
        view.dispatch({ changes: { from: pair.open, to: pair.close + pair.mark.length }, selection: { anchor: pair.open },
          effects: pairChanged.of(null), userEvent: 'delete.backward' });
        return true;
      } }, ...closeBracketsKeymap,
    ])),
  ];
}
