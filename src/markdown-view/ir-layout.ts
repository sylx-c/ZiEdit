import { EditorView } from '@codemirror/view';
import type { StateEffect } from '@codemirror/state';

/** 段间空行会从源码行高收缩为排版间距。CM 的默认锚若落在该空行顶部，
 *  空行本身不动、后面的可见文字仍会移动。把本次事务的原生滚动目标交给
 *  下一条可见正文；定位与高度测量在 CM 同一轮完成，不再追加像素补偿。 */
function gapAnchor(view: EditorView): StateEffect<unknown> | undefined {
  const scroller = view.scrollDOM;
  if (!scroller.clientHeight || scroller.scrollTop <= 0
    || scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1) return;
  const bounds = scroller.getBoundingClientRect();
  const block = view.lineBlockAtHeight(Math.max(0, bounds.top - view.documentTop + 8));
  const doc = view.state.doc;
  if (block.to - block.from >= 256 || doc.sliceString(block.from, block.to).trim()) return;
  let number = doc.lineAt(block.to).number + 1;
  for (let i = 0; i < 16 && number <= doc.lines; i++, number++) {
    const line = doc.line(number);
    if (!line.text.trim()) continue;
    const rect = view.coordsAtPos(line.from);
    // 横向不可见时保持 CM 原锚，避免定位正文开头改变横向位置。
    if (rect && rect.top >= bounds.top && rect.top < bounds.bottom && rect.left >= bounds.left && rect.right <= bounds.right)
      return EditorView.scrollIntoView(line.from, { y: 'start', yMargin: rect.top - bounds.top, xMargin: 0 });
    break;
  }
  return;
}

export function dispatchIrLayout(view: EditorView, effects: StateEffect<unknown> | readonly StateEffect<unknown>[]): void {
  const anchor = gapAnchor(view);
  view.dispatch({ effects: anchor ? [...(Array.isArray(effects) ? effects : [effects]), anchor] : effects });
}
