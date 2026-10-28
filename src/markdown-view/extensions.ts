import type { MarkdownConfig } from '@lezer/markdown';

/** 已有静态渲染扩展的源位置语义，编辑时仍保留原 Markdown。 */
export const liveMarkdownExtensions: MarkdownConfig = {
  defineNodes: ['FootnoteReference', 'FootnoteDefinition', 'FootnoteLabel', 'FootnoteIndent', 'Highlight', 'HighlightMark', 'TableOfContents',
    'InlineMath', 'MathBlock', 'MathUnclosed', 'MathContent', 'MathMark'],
  parseInline: [{ name: 'InlineMath', before: 'Emphasis', parse(cx, next, pos) {
    if (next !== 36 || cx.char(pos - 1) === 36 || cx.char(pos + 1) === 36 || /\s/.test(cx.slice(pos + 1, pos + 2))) return -1;
    for (let end = pos + 1; end < cx.end; end++) {
      const ch = cx.char(end);
      if (ch === 10) break;
      if (ch === 92) { end++; continue; }
      if (ch === 36 && !/\s/.test(cx.slice(end - 1, end))) return cx.addElement(cx.elt('InlineMath', pos, end + 1,
        [cx.elt('MathMark', pos, pos + 1), cx.elt('MathContent', pos + 1, end), cx.elt('MathMark', end, end + 1)]));
    }
    return -1;
  } }, { name: 'FootnoteReference', before: 'Link', parse(cx, next, pos) {
    if (next !== 91) return -1;
    const match = /^\[\^([^\]\n]+)\]/.exec(cx.slice(pos, cx.end));
    return match ? cx.addElement(cx.elt('FootnoteReference', pos, pos + match[0].length)) : -1;
  } }, { name: 'Highlight', before: 'Emphasis', parse(cx, next, pos) {
    if (next !== 61) return -1;
    const match = /^==([^=\s](?:[^\n]*?[^=\s])?)==/.exec(cx.slice(pos, cx.end));
    if (!match) return -1;
    const end = pos + match[0].length;
    return cx.addElement(cx.elt('Highlight', pos, end, [cx.elt('HighlightMark', pos, pos + 2),
      ...cx.parser.parseInline(match[1]!, pos + 2), cx.elt('HighlightMark', end - 2, end)]));
  } }],
  parseBlock: [{ name: 'MathBlock', before: 'FencedCode', parse(cx, line) {
    const single = /^\$\$(.+?)\$\$\s*$/.exec(line.text.slice(line.pos));
    if (single) {
      const from = cx.lineStart + line.pos, end = from + single[0].trimEnd().length;
      cx.addElement(cx.elt('MathBlock', from, end, [cx.elt('MathMark', from, from + 2),
        cx.elt('MathContent', from + 2, end - 2), cx.elt('MathMark', end - 2, end)]));
      cx.nextLine(); return true;
    }
    if (!/^\$\$\s*$/.test(line.text.slice(line.pos))) return false;
    const from = cx.lineStart + line.pos;
    const children = [cx.elt('MathMark', from, from + 2)];
    let end = cx.lineStart + line.text.length, closed = false;
    const baseIndent = line.baseIndent;
    while (cx.nextLine()) {
      if (line.baseIndent < baseIndent && line.text.trim()) break;
      children.push(...line.markers);
      end = cx.lineStart + line.text.length;
      if (/^\$\$\s*$/.test(line.text.slice(line.pos))) {
        children.push(cx.elt('MathMark', cx.lineStart + line.pos, cx.lineStart + line.pos + 2));
        closed = true; cx.nextLine(); break;
      }
      children.push(cx.elt('MathContent', cx.lineStart + line.basePos, end));
    }
    cx.addElement(cx.elt(closed ? 'MathBlock' : 'MathUnclosed', from, end, children)); return true;
  } }, { name: 'FootnoteDefinition', before: 'LinkReference', parse(cx, line) {
    const match = /^\[\^([^\]\n]+)\]:\s*/.exec(line.text.slice(line.pos));
    if (!match) return false;
    const from = cx.lineStart + line.pos;
    const body = from + match[0].length;
    const baseIndent = line.baseIndent;
    const markerCount = line.markers.length;
    let end = cx.lineStart + line.text.length;
    const children = [cx.elt('FootnoteLabel', from, body), ...cx.parser.parseInline(line.text.slice(line.pos + match[0].length), body)];
    let pendingMarkers: typeof line.markers = [];
    while (cx.nextLine()) {
      if (line.pos === line.text.length) { pendingMarkers.push(...line.markers); continue; }
      if (line.markers.length !== markerCount || (!markerCount && line.baseIndent < baseIndent)) break;
      if (line.indent < line.baseIndent + 4) break;
      // pos 已指向正文，按容器的列缩进取得续段范围，Tab 同样有效。
      const content = line.findColumn(line.baseIndent + 4);
      children.push(...pendingMarkers, ...line.markers, cx.elt('FootnoteIndent', cx.lineStart + line.basePos, cx.lineStart + content),
        ...cx.parser.parseInline(line.text.slice(content), cx.lineStart + content));
      pendingMarkers = [];
      end = cx.lineStart + line.text.length;
    }
    cx.addElement(cx.elt('FootnoteDefinition', from, end, children));
    return true;
  } }, { name: 'TableOfContents', before: 'LinkReference', parse(cx, line) {
    if (!/^\[toc\]\s*$/i.test(line.text.slice(line.pos))) return false;
    cx.addElement(cx.elt('TableOfContents', cx.lineStart + line.pos, cx.lineStart + line.text.length));
    cx.nextLine(); return true;
  } }],
};
