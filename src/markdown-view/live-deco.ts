// markdown-view/live-deco —— live preview 行内/行级装饰构建（批次 4 自 livepreview.ts 拆分，行为不变；代码逐段原样搬移）。
import { EditorView, Decoration, type DecorationSet } from '@codemirror/view';
import { type Range, type Text } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { decodeMarkdownEntity } from './preview';
import { markdownIt } from './md';
import { splitTableRow } from './table-model';
import { inlineFormatField } from './writing';
import { renderBlockAt } from './render-model';
import { currentPosition, normalizeLabel, linkUrlOfNode, referenceIndex, referenceField, referenceUrls, emojiField, mdTouchedField, VIEWPORT_MARGIN, type ReferenceIndex } from './live-state';
import { TextWidget, ImgWidget, TaskWidget, FootnoteWidget, RenderWidget, TableWidget, codeContainer, editingFence, renderContextOf, cellAlign } from './live-widgets';
import { irWorkStart, recordIrWork } from './ir-perf';

// ── 装饰构建 ──

/** 空光标沿用闭区间；非空选区按半开区间相交，包含被选区完整覆盖的中间块。 */
export function makeActiveProbe(ranges: readonly { from: number; to: number }[]): (from: number, to: number) => boolean {
  return (from, to) => ranges.some(r => r.from === r.to
    ? r.from >= from && r.from <= to
    : r.from < to && r.to > from);
}

/** childAfter 跳过视口前的兄弟子树；超长列表/段落也不逐项扫到文末。 */
export function visitVisible(node: SyntaxNode, from: number, to: number, enter: (n: SyntaxNode) => boolean | void): void {
  if (node.to <= from || node.from >= to || enter(node) === false) return;
  for (let c = node.childAfter(from); c && c.from < to; c = c.nextSibling) visitVisible(c, from, to, enter);
}

/** 隐藏一段源文本（Decoration.replace；零长保护；range 须双端显传——行内 replace 的
 *  spec.from/to 不参与定位（仅块级件读 spec），单传 from 会构成非法零宽替换区间） */
function hide(out: Range<Decoration>[], from: number, to: number): void {
  if (to > from) out.push(Decoration.replace({}).range(from, to));
}

/** 行内装饰：强调/删除线/行内代码/链接/图片/自动链接，活动元素保留标记。 */
function inlineDecos(
  node: SyntaxNode,
  doc: { sliceString(from: number, to?: number): string; lineAt(pos: number): { from: number; to: number } },
  baseDir: string | null,
  out: Range<Decoration>[],
  remoteResolve?: (url: string) => Promise<string | null>,
  from = node.from,
  to = node.to,
  refs?: () => ReadonlyMap<string, string>,
  active: (from: number, to: number) => boolean = () => false
): void {
  visitVisible(node, from, to, n => {
    // 闭合元素边界已经完成输入；只有元素内部或非空选区相交才展开源码。
    if (['Emphasis', 'StrongEmphasis', 'Strikethrough', 'InlineCode', 'Link', 'Autolink', 'Image', 'Highlight', 'Subscript', 'Superscript', 'Escape', 'Entity', 'HardBreak'].includes(n.name)
      && active(n.from, n.to)) return false;
    switch (n.name) {
      case 'LinkReference':
        return false;
      case 'Escape':
        hide(out, n.from, n.from + 1);
        return false;
      case 'Entity': {
        const source = doc.sliceString(n.from, n.to), decoded = decodeMarkdownEntity(source);
        if (decoded !== source) out.push(Decoration.replace({ widget: new TextWidget(decoded, 'mdir-entity') }).range(n.from, n.to));
        return false;
      }
      case 'HardBreak':
        // 保留换行本身，行内插件只折叠同一行的尾标记。
        hide(out, n.from, n.to - 1);
        return false;
      case 'Highlight':
        out.push(Decoration.mark({ class: 'mdir-highlight' }).range(n.from, n.to));
        break;
      case 'HighlightMark':
      case 'SubscriptMark':
      case 'SuperscriptMark':
        hide(out, n.from, n.to);
        break;
      case 'Subscript':
        out.push(Decoration.mark({ class: 'mdir-sub' }).range(n.from, n.to));
        break;
      case 'Superscript':
        out.push(Decoration.mark({ class: 'mdir-sup' }).range(n.from, n.to));
        break;
      case 'Emphasis':
        out.push(Decoration.mark({ class: 'mdir-em' }).range(n.from, n.to));
        break;
      case 'StrongEmphasis':
        out.push(Decoration.mark({ class: 'mdir-strong' }).range(n.from, n.to));
        break;
      case 'Strikethrough':
        out.push(Decoration.mark({ class: 'mdir-strike' }).range(n.from, n.to));
        break;
      case 'InlineCode':
        out.push(Decoration.mark({ class: 'mdir-icode' }).range(n.from, n.to));
        break;
      case 'Link':
      case 'Autolink': {
        const href = linkUrlOfNode(n, doc, refs);
        if (!href || !markdownIt().validateLink(href)) return false;
        out.push(Decoration.mark({ tagName: 'a', class: 'mdir-link', attributes: { href } }).range(n.from, n.to));
        break;
      }
      case 'Image': {
        // 整体替换为图片件：alt 文本在树里无节点覆盖（Image 子节点只有 LinkMark/URL/LinkTitle），
        // 从源文本正则取；![alt](url) 中 ]( 也是 LinkMark，按子节点区间取会混入定界符
        const raw = doc.sliceString(n.from, n.to);
        const alt = /^!\[([\s\S]*?)\]/.exec(raw)?.[1] ?? '';
        const url = linkUrlOfNode(n, doc, refs);
        if (!url) return false; // 未定义引用保留源码，不能替换成空图片。
        out.push(Decoration.replace({
          widget: new ImgWidget(url, alt.trim(), remoteResolve, n.from, baseDir),
        }).range(n.from, n.to));
        return false; // 子节点不再走（Mark/URL 已整体替换）
      }
      case 'EmphasisMark': // 强调/加粗定界符（** *）隐藏
      case 'StrikethroughMark': // GFM 删除线有独立标记节点（~~）。
        hide(out, n.from, n.to);
        break;
      case 'CodeMark': // 行内代码反引号隐藏（围栏的 CodeMark 在块级处理）
        hide(out, n.from, n.to);
        break;
      case 'LinkMark': // [ ] 与引用定义的 [ref] 隐藏
      case 'LinkLabel':
        hide(out, n.from, n.to);
        break;
      case 'URL':
        if (n.parent?.name === 'Link' || n.parent?.name === 'Image') hide(out, n.from, n.to);
        else if (n.parent?.name !== 'Autolink') out.push(Decoration.mark({ class: 'mdir-link' }).range(n.from, n.to));
        return false;
      case 'LinkTitle':
        hide(out, n.from, n.to);
        break;
      default:
        break;
    }
    return undefined;
  });
}

/** ATX 标题：# 定界符隐藏（开标记吞随行空格，闭标记吞前置空格；行定级由调用方按行装饰统一落） */
function headingDecos(node: SyntaxNode, doc: { sliceString(from: number, to?: number): string; lineAt(pos: number): { from: number; to: number } }, out: Range<Decoration>[]): void {
  const lineEnd = doc.lineAt(node.from).to;
  let seenText = false;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name !== 'HeaderMark') { seenText = true; continue; }
    if (!seenText) {
      // 开标记：# 与其后空格一并隐藏
      const after = doc.sliceString(c.to, Math.min(lineEnd, c.to + 8));
      const sp = after.length - after.replace(/^ +/, '').length;
      hide(out, c.from, c.to + sp);
    } else {
      // 闭标记：前置空格 + 标记
      const before = doc.sliceString(Math.max(node.from, c.from - 8), c.from);
      const sp = before.length - before.replace(/ +$/, '').length;
      hide(out, c.from - sp, c.to);
    }
  }
}

export function fenceLines(node: SyntaxNode, doc: Text) {
  const marks = node.getChildren('CodeMark'), open = doc.lineAt(node.from);
  const close = marks.length > 1 ? doc.lineAt(marks[marks.length - 1]!.from) : null;
  return { open, close, first: open.number + 1,
    last: close ? close.number - 1 : doc.lineAt(Math.max(node.from, node.to - 1)).number };
}

/** GFM 表格：整块网格渲染（块级替换件；调用方为 liveBlockField） */
export interface TableData { header: string[]; align: ('left' | 'center' | 'right')[]; rows: string[][]; to?: number }
export function tableDecos(node: SyntaxNode, doc: Text, out: Range<Decoration>[], references: ReferenceIndex | null, tables: Map<number, TableData>, emojis: Readonly<Record<string, string>>): void {
  let data = tables.get(node.from);
  if (!data || data.to !== node.to) {
    const lines = doc.sliceString(node.from, node.to).split('\n').map(l => l.replace(/^\s*(?:>\s*)+/, '')).filter(l => l.trim());
    if (lines.length < 2) return;
    data = { header: splitTableRow(lines[0]!), align: cellAlign(splitTableRow(lines[1]!)), rows: lines.slice(2).map(splitTableRow), to: node.to };
    tables.set(node.from, data);
    if (tables.size > 32) tables.delete(tables.keys().next().value!);
  }
  // 引用前缀连同表格投影，否则会在网格前留下一个空的CM正文行。
  const line = doc.lineAt(node.from);
  const from = /^[\t >]*$/.test(doc.sliceString(line.from, node.from)) ? line.from : node.from;
  const { inset, quoted } = codeContainer(node);
  out.push(Decoration.replace({
    block: true, blockAtomic: true,
    widget: new TableWidget(data.header, data.align, data.rows, node.from, node.to,
      doc.lineAt(Math.max(node.from, node.to - 1)).number - doc.lineAt(node.from).number + 1,
      references, emojis, inset, quoted),
  }).range(from, node.to));
}

/**
 * live preview 装饰集：视口 ±VIEWPORT_MARGIN 内递归处理块排版，按行内元素判断源码展开。
 * 表格由直接状态装饰与单元格编辑器承载。
 */
export function buildLiveDeco(
  view: EditorView,
  baseDir: string | null,
  remoteResolve?: (url: string) => Promise<string | null>,
  bounds?: { from: number; to: number }
): DecorationSet {
  const started = irWorkStart();
  try { return buildLiveDecoInner(view, baseDir, remoteResolve, bounds); }
  finally { recordIrWork('liveDeco', started); }
}
function buildLiveDecoInner(
  view: EditorView,
  baseDir: string | null,
  remoteResolve?: (url: string) => Promise<string | null>,
  bounds?: { from: number; to: number }
): DecorationSet {
  const doc = view.state.doc;
  const index = view.state.field(referenceField, false) ?? referenceIndex(doc);
  const out: Range<Decoration>[] = [];
  const ranges = view.state.selection.ranges;
  const formatted = view.state.field(inlineFormatField, false);
  const active = (from: number, to: number): boolean => !(formatted && !formatted.pending && from >= formatted.from && to <= formatted.to) && ranges.some(r => r.empty
    ? r.head > from && r.head < to : r.from < to && r.to > from);
  const blockActive = makeActiveProbe(ranges);
  const selected = (from: number, to: number): boolean => ranges.some(r => !r.empty && r.from < to && r.to > from);
  const touched = view.state.field(mdTouchedField, false) === true;
  const refs = (): ReadonlyMap<string, string> => referenceUrls(view.state);
  const renderContext = renderContextOf(index);
  const from = bounds?.from ?? Math.max(0, view.viewport.from - VIEWPORT_MARGIN);
  const to = bounds?.to ?? Math.min(doc.length, view.viewport.to + VIEWPORT_MARGIN);
  const decorateLines = (node: SyntaxNode, cls: string): void => {
    const start = doc.lineAt(Math.max(node.from, from)).number;
    const end = doc.lineAt(Math.min(Math.max(node.from, node.to - 1), to)).number;
    for (let n = start; n <= end; n++) out.push(Decoration.line({ class: cls }).range(doc.line(n).from));
  };
  const inline = (node: SyntaxNode): void => inlineDecos(node, doc, baseDir, out, remoteResolve, from, to, refs, active);
  const decorate = (node: SyntaxNode): void => {
    if (node.to < from || node.from > to) return;
    if (node.name !== 'Document' && index.metadata.frontMatter && node.from < currentPosition(index, index.metadata.frontMatter.to)) {
      decorateLines(node, 'mdir-frontmatter'); return;
    }
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
    if (heading) {
      const underline = node.name.startsWith('Setext') ? node.getChild('HeaderMark') : null;
      const headingActive = touched && blockActive(node.from, node.to);
      if (underline && !selected(node.from, node.to) && !headingActive) {
        for (let n = doc.lineAt(Math.max(node.from, from)).number; n < doc.lineAt(underline.from).number; n++)
          out.push(Decoration.line({ class: 'mdir-h' + heading[1] }).range(doc.line(n).from));
      } else decorateLines(node, 'mdir-h' + heading[1]);
      const oldOffset = index.mapping?.invertedDesc.mapPos(doc.lineAt(node.from).from, -1) ?? doc.lineAt(node.from).from;
      const item = index.headings.get(oldOffset);
      if (item) out.push(Decoration.line({ attributes: { id: item.id, 'data-line': String(doc.lineAt(node.from).number - 1) } }).range(doc.lineAt(node.from).from));
      if (!selected(node.from, node.to) && !headingActive) headingDecos(node, doc, out);
      inline(node);
      return;
    }
    if (node.name === 'Table' || node.name === 'HorizontalRule' || node.name === 'TableOfContents') return;
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
      if (node.name === 'CodeBlock') {
        decorateLines(node, 'mdir-code');
        out.push(Decoration.line({ class: 'mdir-code-open' }).range(doc.lineAt(node.from).from));
        out.push(Decoration.line({ class: 'mdir-code-last' }).range(doc.lineAt(node.to - 1).from));
      } else {
        const { open, close, first, last } = fenceLines(node, doc);
        const { inset, quoted } = codeContainer(node);
        const prefixLength = node.from - open.from;
        const codeLine = (line: number, cls: string): void => {
          out.push(Decoration.line({ class: cls + (quoted ? ' mdir-code-quoted' : ''),
            attributes: { style: `--mdir-code-inset:${inset}px;--mdir-quote-depth:${quoted}` } }).range(doc.line(line).from));
        };
        const editing = editingFence(view.state, open.from);
        if (editing || first > last) {
          codeLine(open.number, 'mdir-code mdir-code-open');
        }
        for (let n = Math.max(first, doc.lineAt(from).number); n <= Math.min(last, doc.lineAt(to).number); n++) {
          codeLine(n, 'mdir-code' + (n === last ? ' mdir-code-last' : ''));
          const line = doc.line(n);
          const prefix = /^[ >\t]*/.exec(line.text)![0].length;
          hide(out, line.from, line.from + Math.min(prefixLength, prefix));
        }
        for (let child = node.childAfter(from); child && child.from <= to; child = child.nextSibling) {
          if (child.name === 'QuoteMark' && child.to > doc.lineAt(child.from).from + prefixLength)
            hide(out, child.from, child.to + (doc.sliceString(child.to, child.to + 1) === ' ' ? 1 : 0));
          // 状态块装饰在解析/视口通知后才就绪；其间也不能闪出闭合围栏。
          if (child.name === 'CodeMark' && (child.from !== node.from || (!editing && first <= last))) hide(out, child.from, child.to);
          if (child.name === 'CodeInfo' && !editing && first <= last) hide(out, child.from, child.to);
        }
        if (!close && first > last) out.push(Decoration.line({ class: 'mdir-code-last' }).range(open.from));
      }
      return;
    }
    if (node.name === 'Blockquote') {
      const depth = codeContainer(node).quoted + 1;
      const start = doc.lineAt(Math.max(node.from, from)).number;
      const end = doc.lineAt(Math.min(Math.max(node.from, node.to - 1), to)).number;
      for (let n = start; n <= end; n++) out.push(Decoration.line({ class: 'mdir-quote',
        attributes: { style: `--mdir-quote-depth:${depth}` } }).range(doc.line(n).from));
    }
    if (['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem', 'Task'].includes(node.name)) {
      for (let c = node.childAfter(from); c && c.from <= to; c = c.nextSibling) {
        if (c.name === 'QuoteMark') {
          // 前缀由可见树统一处理，避免容器内重复替换。
        } else if (c.name === 'ListMark') {
          const raw = doc.sliceString(c.from, c.to);
          if (!selected(c.from, c.to)) {
            let depth = 0;
            for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === 'ListItem') depth++;
            const line = doc.lineAt(c.from), prefix = doc.sliceString(line.from, c.from);
            // 缩进按列表层级显示，不能用比例字体中两枚空格冒充嵌套层级。
            if (/^\s*$/.test(prefix)) {
              hide(out, line.from, c.from);
              out.push(Decoration.line({ class: 'mdir-list-line', attributes: { style: `--mdir-list-depth:${depth}` } }).range(line.from));
            }
            const end = c.to + (doc.sliceString(c.to, c.to + 1) === ' ' ? 1 : 0);
            const task = node.getChild('Task');
            if (task) hide(out, c.from, end);
            else out.push(Decoration.replace({ widget: new TextWidget((/^[-+*]$/.test(raw) ? (depth ? '◦' : '•') : raw) + ' ', 'mdir-listmark') }).range(c.from, end));
          } else out.push(Decoration.mark({ class: 'mdir-listmark' }).range(c.from, c.to));
        } else if (c.name === 'TaskMarker') {
          if (!selected(c.from, c.to)) out.push(Decoration.replace({
            widget: new TaskWidget(c.from, c.to, /\[x\]/i.test(doc.sliceString(c.from, c.to))),
          }).range(c.from, c.to));
        } else decorate(c);
      }
      return;
    }
    inline(node);
  };
  const tree = syntaxTree(view.state);
  // 只标记正文内多余的空格，不 replace，不改查找/复制/选区的源范围。
  // 按行判活动态；语法排除代码/URL/数学等字面值区域与块级件。
  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
    const line = doc.line(n);
    if (blockActive(line.from, line.to)) continue;
    for (const match of line.text.matchAll(/ {2,}/g)) {
      const start = line.from + match.index!, end = start + match[0].length;
      if (start < from || end > to || start === line.from || end === line.to) continue;
      let node: SyntaxNode | null = tree.resolveInner(start, 1);
      let prose = false, literal = false;
      for (; node; node = node.parent) {
        if (/^(?:Paragraph|ATXHeading[1-6]|SetextHeading[1-6])$/.test(node.name)) prose = true;
        if (['InlineCode', 'FencedCode', 'CodeBlock', 'InlineMath', 'MathBlock', 'Table', 'URL', 'LinkTitle', 'HTMLBlock'].includes(node.name)) literal = true;
      }
      if (prose && !literal) out.push(Decoration.mark({ class: 'md-space-fold' }).range(start + 1, end));
    }
  }
  visitVisible(tree.topNode, from, to, node => {
    if (index.metadata.frontMatter && node.from < currentPosition(index, index.metadata.frontMatter.to) && node.name !== 'Document') return false;
    if (node.name === 'InlineMath') {
      const block = renderBlockAt(node.node, (a, b) => doc.sliceString(a, b))!;
      const widget = new RenderWidget(block, doc, renderContext);
      if (active(node.from, node.to)) out.push(Decoration.widget({ widget, side: 1 }).range(node.to));
      else out.push(Decoration.replace({ widget }).range(node.from, node.to));
      return false;
    }
    if (node.name === 'MathBlock' || node.name === 'MathUnclosed' || node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') return false;
    if (node.name === 'QuoteMark' && !selected(node.from, node.to)) {
      // 表格整行已由块装饰接管，不能用跨越其边界的行内替换覆盖块件。
      let owner: SyntaxNode | null = syntaxTree(view.state).resolveInner(doc.lineAt(node.from).to, -1);
      while (owner && !['Table', 'FencedCode', 'Paragraph'].includes(owner.name) && !/Heading[1-6]$/.test(owner.name)) owner = owner.parent;
      const textLine = owner?.name === 'Paragraph' || /Heading[1-6]$/.test(owner?.name ?? '');
      const space = textLine && doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0;
      hide(out, node.from, node.to + space);
    }
    if (node.name === 'Emoji' && !active(node.from, node.to)) {
      const key = doc.sliceString(node.from + 1, node.to - 1);
      const value = view.state.field(emojiField)[key];
      if (value) out.push(Decoration.replace({ widget: new TextWidget(value, 'mdir-emoji') }).range(node.from, node.to));
    }
    if (node.name === 'FootnoteReference' && !active(node.from, node.to)) {
      const note = index.footnotes.get(normalizeLabel(doc.sliceString(node.from + 2, node.to - 1)));
      if (note?.number) {
        const occurrence = note.references.findIndex(ref => currentPosition(index, ref.from) === node.from);
        const suffix = occurrence > 0 ? ':' + (occurrence + 1) : '';
        out.push(Decoration.replace({ widget: new FootnoteWidget(String(note.number), 'mdir-footnote-ref', `footnotes-ref-${note.number}${suffix}`,
          currentPosition(index, note.from), `footnotes-def-${note.number}`) }).range(node.from, node.to));
      }
    }
    if (node.name === 'FootnoteLabel' && !blockActive(node.from, node.to)) {
      const label = /^\[\^([^\]]+)\]/.exec(doc.sliceString(node.from, node.to))?.[1] ?? '';
      const note = index.footnotes.get(normalizeLabel(label));
      if (note?.number) out.push(Decoration.replace({ widget: new TextWidget(String(note.number) + '. ', 'mdir-footnote-label', `footnotes-def-${note.number}`) }).range(node.from, node.to));
    }
    if (node.name === 'FootnoteIndent' && !blockActive(node.from, node.to)) hide(out, node.from, node.to);
    if (node.name === 'FootnoteDefinition') {
      const marker = node.node.getChild('FootnoteLabel');
      const label = marker ? /^\[\^([^\]]+)\]/.exec(doc.sliceString(marker.from, marker.to))?.[1] : null;
      const note = label ? index.footnotes.get(normalizeLabel(label)) : null;
      if (note) for (let i = 0; i < note.references.length; i++) out.push(Decoration.widget({
        widget: new FootnoteWidget('\u21a9' + (i ? String(i + 1) : ''), 'mdir-footnote-back', `footnotes-back-${note.number}-${i}`,
          currentPosition(index, note.references[i]!.from), `footnotes-ref-${note.number}${i ? ':' + (i + 1) : ''}`), side: 1,
      }).range(node.to));
    }
    if (node.name === 'Blockquote') {
      const first = doc.lineAt(node.from);
      const callout = /^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(first.text);
      if (callout && !blockActive(first.from, first.to)) {
        const marker = first.text.indexOf('[!');
        out.push(Decoration.replace({ widget: new TextWidget(callout[1]!.toUpperCase(), 'mdir-callout-title') })
          .range(first.from + marker, first.from + marker + callout[1]!.length + 3));
      }
    }
  });
  decorate(tree.topNode);
  return Decoration.set(out, true);
}
