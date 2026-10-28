// Markdown 源码空行恒为完整行高（通行口径）：光标进出与首字输入均不引起位移；块间距由首行 padding-top 承载。
import { Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import type { EditorState, Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { irWorkStart, recordIrWork } from './ir-perf';

/** IR 源行高（px）：13.5px×1.6（styles.css .md-ir .cm-scroller），CM6 视口高度估计与 CSS 契约基准。
 *  显示公式 CSS min-height 40px、表格行高初值 32px（table-viewport.ts）均以此为对照。 */
export const SOURCE_LINE_HEIGHT_PX = 21.6;

class BlockSpace extends WidgetType {
  constructor(private height: string, private quoted: boolean) { super(); }
  eq(other: BlockSpace): boolean { return this.height === other.height && this.quoted === other.quoted; }
  get estimatedHeight(): number { return 11; }
  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mdir-block-space' + (this.quoted ? ' mdir-quote-space' : '');
    el.style.height = this.height;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}

const containers = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem']);
const markers = new Set(['QuoteMark', 'ListMark']);
function margin(node: SyntaxNode, edge: 'before' | 'after'): string {
  const level = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name)?.[1];
  return level ? `var(--md-h${level}-${edge})`
    : node.name === 'HorizontalRule' ? 'var(--md-rule-gap)' : 'var(--md-block-gap)';
}

/** 仅遍历视口相邻兄弟块；不在选区变化时扫描整篇文档。高度装饰由直接StateField提供。 */
export function blockLayout(state: EditorState, from: number, to: number): DecorationSet {
  const started = irWorkStart();
  try { return buildBlockLayout(state, from, to); }
  finally { recordIrWork('blockLayout', started); }
}
function buildBlockLayout(state: EditorState, from: number, to: number): DecorationSet {
  const doc = state.doc, tree = syntaxTree(state), out: Range<Decoration>[] = [];
  const lo = doc.lineAt(Math.max(0, from)).number, hi = doc.lineAt(Math.min(doc.length, to)).number;
  const gap = (start: number, end: number, height: string, next: SyntaxNode | null, quoted: boolean): void => {
    if (end < lo || start > hi) return;
    if (start > end) {
      if (next && next.from >= from && next.from <= to)
        out.push(Decoration.widget({ block: true, side: -1, widget: new BlockSpace(height, quoted) }).range(doc.lineAt(next.from).from));
      return;
    }
    for (let n = Math.max(start, lo); n <= Math.min(end, hi); n++) {
      const line = doc.line(n);
      // 容器前缀可以是空行的一部分，代码正文不会进入此路径。
      if (!/^[\t >]*$/.test(line.text)) continue;
      const active = state.selection.ranges.some(r => r.from <= line.to && r.to >= line.from);
      out.push(Decoration.line({ class: 'mdir-gap' + (active ? ' mdir-gap-active' : ''),
        // 间距只分配一次，避免多个空行各自取整后累积亚像素偏差。
        attributes: { style: `--mdir-gap-height:${n === start ? height : '0px'}` },
      }).range(line.from));
    }
  };
  const walk = (parent: SyntaxNode, quoted: boolean): void => {
    if (!containers.has(parent.name) || parent.from > to || parent.to < from) return;
    const isQuote = quoted || parent.name === 'Blockquote';
    let child = parent.childAfter(Math.max(parent.from, from));
    while (child && markers.has(child.name)) child = child.nextSibling;
    if (!child) {
      if (parent.name === 'Document' && !parent.firstChild && tree.length === doc.length)
        gap(1, doc.lines, '0px', null, false);
      return;
    }
    let previous = child.prevSibling;
    while (previous && markers.has(previous.name)) previous = previous.prevSibling;
    for (; child && child.from <= to; child = child.nextSibling) {
      if (markers.has(child.name)) continue;
      const start = previous ? doc.lineAt(Math.max(previous.from, previous.to - 1)).number + 1 : doc.lineAt(parent.from).number;
      const end = doc.lineAt(child.from).number - 1;
      if (previous) {
        const height = parent.name === 'BulletList' || parent.name === 'OrderedList'
          ? (start <= end ? 'var(--md-block-gap)' : 'var(--md-list-gap)')
          : `max(${margin(previous, 'after')}, ${margin(child, 'before')})`;
        gap(start, end, height, child, isQuote);
      } else if (parent.name === 'Document') gap(start, end, '0px', null, false);
      walk(child, isQuote);
      previous = child;
    }
    // 尾部可写段落预留正文块间距，首字输入时不再突然补出间距。
    if (!child && previous && parent.name === 'Document' && tree.length === doc.length)
      gap(doc.lineAt(Math.max(previous.from, previous.to - 1)).number + 1, doc.lines,
        `max(${margin(previous, 'after')}, var(--md-block-gap))`, null, false);
  };
  walk(tree.topNode, false);
  return Decoration.set(out, true);
}
