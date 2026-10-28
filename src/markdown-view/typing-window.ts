import type { ChangeSet, EditorState } from '@codemirror/state';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import type { DecoWindow } from './deco-window';

/** 保守快路：只有同一段落内部的文字编辑。结构字符、换行、跨段及解析未就绪均回退。 */
export function paragraphTypingWindow(before: EditorState, after: EditorState, changes: ChangeSet): DecoWindow | null {
  if (before.selection.ranges.length !== 1 || after.selection.ranges.length !== 1
    || !before.selection.main.empty || !after.selection.main.empty) return null;
  let result: DecoWindow | null = null, count = 0;
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    count++;
    if (count !== 1 || !/^[\p{L}\p{N}]*$/u.test(inserted.toString())
      || !/^[\p{L}\p{N}]*$/u.test(before.doc.sliceString(fromA, toA))) return;
    const paragraph = (state: EditorState, pos: number): SyntaxNode | null => {
      let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
      while (node && node.name !== 'Paragraph') node = node.parent;
      return node;
    };
    const old = paragraph(before, fromA), current = paragraph(after, fromB);
    if (!old || !current || old.parent?.name !== 'Document' || current.parent?.name !== 'Document'
      || fromA <= old.from || toA > old.to
      || !syntaxTreeAvailable(before, old.to) || !syntaxTreeAvailable(after, current.to)
      || changes.mapPos(old.from, -1) !== current.from || changes.mapPos(old.to, 1) !== current.to
      || before.selection.main.head < old.from || before.selection.main.head > old.to
      || after.selection.main.head < current.from || after.selection.main.head > current.to) return;
    // 祖先容器身份不变，避免把段落重新归属（例如列表/引用结构变化）误当普通文字修改。
    let a: SyntaxNode | null = old.parent, b: SyntaxNode | null = current.parent;
    for (; a && b; a = a.parent, b = b.parent) if (a.name !== b.name) return;
    if (a || b || toB > current.to) return;
    result = { from: current.from, to: current.to };
  });
  return count === 1 ? result : null;
}
