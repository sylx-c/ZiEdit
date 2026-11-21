// markdown-view/active-block —— REQ-014 P1：活动块集合（ActiveBlocks）计算（data-model.md §1）。
// 空光标 → 自光标向上找到的最小包含 Document 直接子节点（单元素数组；块间空白无覆盖时为空数组）；
// 非空选区 → 所有与选区相交的 Document 直接子节点，按文档序（跨块选区由多个块表达，不塞进单个区间）。
// 集合成员或边界的变化是触发「重建活动块装饰」的唯一信号，取代散布各处的 active(from,to) 闭包；
// 行内标记的显隐仍由投影器按「光标落在该语法节点内部」的更细粒度判定（spec R1），与本集合的块粒度互不越权。
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

export interface ActiveBlock {
  /** 一个 Document 直接子节点的起始文档位置（data-model.md §1 `ActiveBlock.from`）。 */
  readonly from: number;
  /** 同一 Document 直接子节点的结束文档位置（data-model.md §1 `ActiveBlock.to`）。 */
  readonly to: number;
  /** 节点类型名，如 Heading / Paragraph / ListItem（data-model.md §1 `ActiveBlock.kind`）。 */
  readonly kind: string;
}
export type ActiveBlocks = readonly ActiveBlock[];

/** 空光标取唯一包含块；非空选区取全部相交块（半开区间相交，与非空选区活动探针同口径）。 */
export function activeBlocks(state: EditorState): ActiveBlocks {
  const tree = syntaxTree(state);
  const top = tree.topNode;
  const out: ActiveBlock[] = [];
  const main = state.selection.main;
  if (main.empty) {
    const head = main.head;
    let node = tree.resolveInner(head, head > 0 ? -1 : 1);
    // topNode 每次访问返回新的包装实例，不能按身份比较——按「父节点是 Document」判定直接子级。
    while (node && node.parent && node.parent.name !== 'Document') node = node.parent;
    if (node && node.name !== 'Document') out.push({ from: node.from, to: node.to, kind: node.name });
    else {
      // 块间空白等无覆盖位：退回直接子节点的闭区间包含扫描（至多命中一个，Document 直接子节点互不嵌套）。
      for (let c = top.firstChild; c; c = c.nextSibling) {
        if (c.from <= head && head <= c.to) { out.push({ from: c.from, to: c.to, kind: c.name }); break; }
      }
    }
    return out;
  }
  for (let c = top.firstChild; c; c = c.nextSibling) {
    if (main.from < c.to && main.to > c.from) out.push({ from: c.from, to: c.to, kind: c.name });
  }
  return out;
}

/** 集合变化判定：成员增删或任一边界移动视为变化（块身份由区间承载，kind 名称不单独参与判定）。 */
export function activeBlocksChanged(prev: ActiveBlocks, next: ActiveBlocks): boolean {
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i]!.from !== next[i]!.from || prev[i]!.to !== next[i]!.to) return true;
  }
  return false;
}
