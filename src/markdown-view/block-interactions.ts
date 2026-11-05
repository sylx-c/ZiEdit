import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { isolateHistory } from '@codemirror/commands';
import { isComposing } from '../common/composition';
import { tableAt } from './live-table-actions';
import { runTableOperation } from './table-model';

function fence(view: EditorView) {
  const { state } = view, pos = state.selection.main.head;
  for (const bias of [-1, 1] as const) {
    let node = syntaxTree(state).resolveInner(pos, bias);
    while (node.parent && node.name !== 'FencedCode') node = node.parent;
    if (node.name !== 'FencedCode') continue;
    const marks = node.getChildren('CodeMark');
    if (marks.length < 2) return null;
    const open = state.doc.lineAt(node.from), close = state.doc.lineAt(marks[marks.length - 1]!.from);
    return { node, open, close, from: Math.min(open.to + 1, close.from), to: Math.max(open.to + 1, close.from - 1) };
  }
  return null;
}

// 围栏是原子块替换件，默认垂直移动无法可靠跨过隐藏末行；边界显式落到源坐标。
function escape(view: EditorView, direction: -1 | 1, exit = false): boolean {
  if (isComposing(view) || !view.state.selection.main.empty) return false;
  const block = fence(view);
  if (!block) return false;
  const { doc } = view.state, line = doc.lineAt(view.state.selection.main.head);
  if (!exit && line.number !== (direction < 0 ? block.open.number + 1 : block.close.number - 1)) return false;
  let anchor: number;
  if (direction < 0) anchor = block.open.from > 0 ? block.open.from - 1 : block.open.from;
  else if (block.close.to < doc.length) anchor = block.close.to + 1;
  else if (exit && !view.state.readOnly) {
    view.dispatch({ changes: { from: doc.length, insert: '\n' }, selection: { anchor: doc.length + 1 },
      userEvent: 'input', annotations: isolateHistory.of('full'), scrollIntoView: true });
    return true;
  } else anchor = block.close.to;
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
  return true;
}

export const blockInteractions = Prec.highest(keymap.of([
  { key: 'ArrowDown', run: view => escape(view, 1) },
  { key: 'ArrowUp', run: view => escape(view, -1) },
  { key: 'Mod-Enter', run: view => {
    if (isComposing(view)) return false;
    if (escape(view, 1, true)) return true;
    const table = tableAt(view, view.state.selection.main.head);
    if (!table || view.state.readOnly) return false;
    const sourceRow = table.rows.findIndex(row => view.state.selection.main.head <= row.lineTo);
    return !!runTableOperation(view, table.nodeFrom, Math.max(0, sourceRow - 1), 0, 'rowBelow');
  } },
  { key: 'Mod-a', run: view => {
    if (isComposing(view)) return false;
    const block = fence(view);
    if (!block) return false;
    const selection = view.state.selection.main;
    if (!selection.empty && selection.from <= block.node.from && selection.to >= block.node.to) return false;
    // 第二级选中完整围栏，删除时不会遗留空代码壳；第三级交回 CM 全文选择。
    const whole = selection.from === block.from && selection.to === block.to;
    view.dispatch({ selection: { anchor: whole ? block.node.from : block.from, head: whole ? block.node.to : block.to } });
    return true;
  } },
]));
