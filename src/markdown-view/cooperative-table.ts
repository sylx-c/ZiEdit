import { Table, parser, type BlockContext, type Element, type MarkdownConfig } from '@lezer/markdown';
import { Tree, type SyntaxNode } from '@lezer/common';

interface TableProgress { row: number; setext: boolean }
const progress = new WeakMap<BlockContext, TableProgress>();
const normalized = new WeakSet<BlockContext>();
const delimiter = /^[>\s]*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;
const probe = parser.configure(Table);

// 改写自 @lezer/markdown（MIT）的 GFM 单元格边界算法，版权与许可见 THIRD-PARTY-NOTICES.md。
function row(cx: BlockContext, text: string, start = 0, offset = 0, output?: Element[]): number {
  let count = 0, first = true, from = -1, to = -1, escaped = false;
  const cell = (): void => { output!.push(cx.elt('TableCell', offset + from, offset + to,
    cx.parser.parseInline(text.slice(from, to), offset + from))); };
  for (let i = start; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 124 && !escaped) {
      if (!first || from >= 0) count++;
      first = false;
      if (output) { if (from >= 0) cell(); output.push(cx.elt('TableDelimiter', offset + i, offset + i + 1)); }
      from = to = -1;
    } else if (escaped || ch !== 32 && ch !== 9) { if (from < 0) from = i; to = i + 1; }
    escaped = !escaped && ch === 92;
  }
  if (from >= 0) { count++; if (output) cell(); }
  return count;
}

/** 顶层表格逐行 advance，让 CM 的解析预算能在行间让出；容器内仍沿用原 GFM 规则。 */
export const cooperativeTableNodes: MarkdownConfig = {
  defineNodes: Table.defineNodes!.map(spec => typeof spec !== 'string' && spec.name === 'Table'
    ? { ...spec, composite(cx: BlockContext, line: Parameters<NonNullable<typeof spec.composite>>[1]): boolean {
      const state = progress.get(cx);
      if (!state || state.setext || line.pos === line.text.length) return false;
      if (state.row === 1 || line.indent >= line.baseIndent + 4) return true;
      // 普通单元格不解析两次。只有可能中断段落的前缀才用现有语法判断，
      // 保留 1. 与 2.、HTML block 与 inline tag 等细节，而非另一套近似正则。
      if (!/^[#>`~*+_\-<\d=]/.test(line.text.slice(line.pos))) return true;
      const first = probe.parse('x\n' + line.text + '\n').topNode.firstChild;
      if (first?.name.startsWith('SetextHeading')) return true;
      return first?.name === 'Paragraph' && first.to > 1;
    } } : spec),
};

export const cooperativeTableParser: MarkdownConfig = {
  parseBlock: [{ name: 'CooperativeTable', before: 'IndentedCode', parse(cx, line) {
    if (cx.parentType().name === 'Table') {
      const state = progress.get(cx)!;
      const from = cx.lineStart + line.pos, to = cx.lineStart + line.text.length;
      if (state.row === 1) cx.addElement(cx.elt('TableDelimiter', from, to));
      else if (state.row > 1 && line.indent < line.baseIndent + 4 && /^\s*(?:=+|-+)\s*$/.test(line.text)) {
        // 原 GFM 的 Setext 叶解析器可把此前的整个表格转成标题；只在这个罕见分支
        // 交回原解析器，普通巨表不再有不可抢占的整块扫描。
        state.setext = true; normalized.add(cx);
        cx.addElement(cx.elt('HeaderMark', from, cx.lineStart + line.text.trimEnd().length));
      } else {
        const cells: Element[] = []; row(cx, line.text, line.pos, cx.lineStart, cells);
        cx.addElement(cx.elt(state.row === 0 ? 'TableHeader' : 'TableRow', from, to, cells));
      }
      state.row++; cx.nextLine(); return true;
    }
    if (cx.depth !== 1 || line.indent >= 4 || !/(^|[^\\])\|/.test(line.text.slice(line.pos))) return false;
    const next = cx.peekLine();
    if (!delimiter.test(next) || row(cx, line.text, line.pos) !== row(cx, next)) return false;
    // 本规则早于容器解析器，仅顶层真实表头可启动；引号/列表/代码等先交给原规则。
    if (probe.parse(line.text + '\n' + next).topNode.firstChild?.name !== 'Table') return false;
    progress.set(cx, { row: 0, setext: false });
    cx.startComposite('Table', line.pos); return null;
  } }],
  wrap(inner, input) {
    const cx = inner as BlockContext;
    return {
      get parsedPos() { return inner.parsedPos; },
      get stoppedAt() { return inner.stoppedAt; },
      stopAt(pos) { inner.stopAt(pos); },
      advance() {
        const tree = inner.advance();
        if (!tree || !normalized.has(cx)) return tree;
        const children: Tree[] = [], positions: number[] = [];
        for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
          // 表尾下划线行交回原规则重解析：Setext 全局不解析后，重解析产出是
          // 「Table + 分隔线/段落」等多个顶层块，须整组拼回（修前只取 firstChild，
          // 会把尾随的分隔线块静默丢掉）。范围含下划线行，node.from + child.from 为绝对位。
          // 重解析意外产出空树时保留原节点，不静默丢块。
          if (node.name === 'Table' && node.getChild('HeaderMark')) {
            const reparsed = cx.parser.configure({ remove: ['CooperativeTable'] }).parse(input.read(node.from, node.to)).topNode;
            const first: SyntaxNode | null = reparsed.firstChild;
            if (first) {
              for (let child: SyntaxNode | null = first; child; child = child.nextSibling) {
                children.push(child.toTree()); positions.push(node.from + child.from);
              }
              continue;
            }
          }
          children.push(node.toTree()); positions.push(node.from);
        }
        return new Tree(tree.type, children, positions, tree.length);
      },
    };
  },
};
