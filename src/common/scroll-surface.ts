import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { cancelCmRestore, cmTopLine, cmScrollToLine, type ScrollAnchor } from './scroll-anchor';

export interface ScrollLayoutSnapshot {
  version: number;
  top: number;
  height: number;
  viewport: number;
}
export interface OverviewSample { text: string; kind?: string; width?: number }
export interface ScrollSurfaceAdapter {
  readonly element: HTMLElement;
  snapshot(): ScrollLayoutSnapshot;
  capture(): ScrollAnchor;
  restore(anchor: ScrollAnchor, align?: 'start' | 'center'): void;
  scrollTo(top: number): void;
  overview(count: number, snapshot: ScrollLayoutSnapshot): OverviewSample[];
}

/** CM 的高度图与滚动锚仍由 CM 管理；右轨只读公开布局 API。 */
export function cmScrollSurface(view: EditorView, surface: 'source' | 'ir'): ScrollSurfaceAdapter {
  let version = 0, key = '';
  let document = view.state.doc;
  let tree = syntaxTree(view.state);
  return {
    element: view.scrollDOM,
    snapshot: () => {
      const next = `${view.contentHeight}:${view.scrollDOM.clientWidth}:${view.state.doc.length}`;
      const parsed = syntaxTree(view.state);
      if (next !== key || document !== view.state.doc || parsed !== tree) { key = next; document = view.state.doc; tree = parsed; version++; }
      return { version, top: view.scrollDOM.scrollTop, height: view.scrollDOM.scrollHeight, viewport: view.scrollDOM.clientHeight };
    },
    capture: () => ({ line: cmTopLine(view), surface }),
    restore: (anchor, align = 'start') => cmScrollToLine(view, anchor.line, align),
    scrollTo: top => { cancelCmRestore(view); view.scrollDOM.scrollTop = Math.max(0, top); },
    overview: (count, snapshot) => {
      const doc = view.state.doc;
      const offset = view.documentTop - view.scrollDOM.getBoundingClientRect().top + snapshot.top;
      return Array.from({ length: count }, (_, i) => {
        const y = Math.max(0, ((i + .5) / count) * snapshot.height - offset);
        const block = view.lineBlockAtHeight(y);
        const first = doc.lineAt(Math.min(doc.length, block.from)).number;
        const last = doc.lineAt(Math.min(doc.length, block.to)).number;
        const fraction = block.height ? Math.min(1, Math.max(0, (y - block.top) / block.height)) : 0;
        const line = doc.line(Math.min(doc.lines, first + Math.floor((last - first) * fraction)));
        const visible = view.visibleRanges.some(range => range.from <= line.from && line.from <= range.to)
          ? view.domAtPos(line.from).node : null;
        const el = visible instanceof HTMLElement ? visible : visible?.parentElement;
        const rendered = el?.closest('.cm-line')?.textContent;
        let kind = /^\s*#{1,6}\s/.test(line.text) ? 'heading' : /^\s*\|/.test(line.text) ? 'table'
          : /^\s*(?:[-*+]|\d+[.)])\s/.test(line.text) ? 'list' : /!\[/.test(line.text) ? 'image' : 'text';
        if (surface === 'ir') for (let node = syntaxTree(view.state).resolveInner(line.from, 1); node; ) {
          if (/^(FencedCode|CodeBlock)$/.test(node.name)) { kind = 'code'; break; }
          if (node.name === 'Table') { kind = 'table'; break; }
          if (/^(BulletList|OrderedList)$/.test(node.name)) kind = 'list';
          const parent = node.parent;
          if (!parent) break;
          node = parent;
        }
        const text = surface === 'source' ? line.text : kind === 'image' ? '[image]'
          : rendered ?? line.text.replace(/^\s{0,3}#{1,6}\s+|^\s*>\s?|^\s*[-*+]\s+|[*_`~]/g, '');
        return { text, kind };
      });
    },
  };
}
