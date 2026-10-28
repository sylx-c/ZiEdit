import type { SyntaxNode, Tree } from '@lezer/common';
import { parser, GFM, Superscript, Subscript, Emoji } from '@lezer/markdown';
import { liveMarkdownExtensions } from './extensions';
import { automaticLinkTarget, extractMarkdownMetadata, normalizeReference, type MarkdownMetadata } from './headings';
import { renderBlockAt, renderPlaceholder, escapeRenderText as esc } from './render-model';
import { hasHighlight, highlightLines } from '../text-view/highlight';
import emojis from './unicode-emojis.json';
import { staticHighlighter, staticCodeLanguage } from './static-code';
import { codeLanguage } from './code-tokens';
import { markdownIt } from './md';

/** 与 IR 同一语法配置；不经过 Markdown→Markdown 投影或第二次语义解析。 */
export const staticMarkdownParser = parser.configure([GFM, Superscript, Subscript, Emoji, liveMarkdownExtensions]);
// 链接校验/实体解码走主线程共享 markdown-it 单例：normalizeLink/
// validateLink/unescapeAll 均为与构造选项无关的原型/静态行为，共享实例输出不变。
const decode = (s: string): string => markdownIt().utils.unescapeAll(s);
const vocabulary: Record<string, string> = { Emphasis: 'em', StrongEmphasis: 'strong', Strikethrough: 'del', Highlight: 'mark', Superscript: 'sup', Subscript: 'sub' };
const emojiTable: Readonly<Record<string, string>> = emojis;

/** 同步、源坐标窗口化；顶层定位由 Lezer 子节点索引完成，避免每块遍历全文。 */
export function renderStaticHtml(text: string, tree: Tree, metadata: MarkdownMetadata, from = 0, to = text.length): string {
  const raw = (node: SyntaxNode): string => text.slice(node.from, node.to);
  const inList = (node: SyntaxNode): boolean => {
    for (let p = node.parent; p; p = p.parent) if (p.name === 'ListItem') return true;
    return false;
  };
  const literal = (s: string, list = false): string => esc(s.replace(/\n[ \t]*/g, '\n')).replace(/\n/g, list ? '<br />\n' : '\n');
  const inline = (node: SyntaxNode, start = node.from, end = node.to): string => {
    let result = '', offset = start;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.from < start || child.to > end) continue;
      result += literal(text.slice(offset, child.from), inList(node));
      result += render(child);
      offset = child.to;
      // 容器前缀不是正文；只移除标记后该行的缩进。
      if (child.name === 'QuoteMark' || child.name === 'TaskMarker') while (offset < end && /[ \t]/.test(text[offset]!)) offset++;
    }
    return result + literal(text.slice(offset, end), inList(node));
  };
  const children = (node: SyntaxNode): string => {
    let result = '';
    for (let child = node.firstChild; child; child = child.nextSibling) result += render(child);
    return result;
  };
  const link = (node: SyntaxNode): string => {
    const marks = node.getChildren('LinkMark'), opening = marks[0];
    const closing = marks.find(mark => raw(mark) === ']');
    if (!opening || !closing) return esc(raw(node));
    const label = inline(node, opening.to, closing.from);
    const url = node.getChild('URL'), title = node.getChild('LinkTitle'), ref = node.getChild('LinkLabel');
    const key = normalizeReference(ref && raw(ref) !== '[]' ? raw(ref).slice(1, -1) : text.slice(opening.to, closing.from));
    const definition = Object.prototype.hasOwnProperty.call(metadata.references, key) ? metadata.references[key] : undefined;
    const href = url ? markdownIt().normalizeLink(decode(raw(url).replace(/^<|>$/g, ''))) : definition?.href;
    const caption = title ? decode(raw(title).slice(1, -1)) : definition?.title;
    if (!href || !markdownIt().validateLink(href)) return esc(raw(node));
    const titleAttr = caption ? ' title="' + esc(caption) + '"' : '';
    if (node.name === 'Image') {
      // alt 只写文字，不把标签/实体解码结果拼成活动 HTML。
      const alt = label.replace(/<[^>]*>/g, '');
      return '<img src="' + esc(href) + '" alt="' + alt.replace(/"/g, '&quot;') + '"' + titleAttr + ' />';
    }
    return '<a href="' + esc(href) + '"' + titleAttr + '>' + label + '</a>';
  };
  const code = (node: SyntaxNode): string => {
    const info = node.getChild('CodeInfo');
    const language = info ? raw(info).trim().split(/\s/)[0]!.toLowerCase() : '';
    const parts = node.getChildren('CodeText');
    let source = '';
    for (let i = 0; i < parts.length; i++) {
      if (i && !source.endsWith('\n')) source += '\n';
      source += raw(parts[i]!);
    }
    if (source && !source.endsWith('\n')) source += '\n';
    let html = esc(source);
    const lang = staticCodeLanguage(language);
    const highlighter = staticHighlighter(), offlineLanguage = codeLanguage(language);
    if (highlighter?.getLanguage(offlineLanguage)) {
      html = highlighter.highlight(source, { language: offlineLanguage, ignoreIllegals: true }).value;
    } else if (language && hasHighlight(lang, source.length)) {
      const lines = source.split('\n'), spans = highlightLines(lines, lang);
      html = lines.map((line, index) => {
        let out = '', offset = 0;
        for (const span of spans[index] ?? []) {
          out += esc(line.slice(offset, span.from)) + '<span class="' + esc(span.cls) + '">' + esc(line.slice(span.from, span.to)) + '</span>';
          offset = span.to;
        }
        return out + esc(line.slice(offset));
      }).join('\n');
    }
    // 语言 class 用归一化名（sh/shell/zsh→bash，与 code-worker/写作候选同口径）
    return '<pre><code class="hljs' + (language ? ' language-' + esc(offlineLanguage) : '') + '">' + html + '</code></pre>';
  };
  const render = (node: SyntaxNode): string => {
    if (metadata.frontMatter && node.from < metadata.frontMatter.to) return '';
    const rendered = renderBlockAt(node, (a, b) => text.slice(a, b));
    if (rendered) return renderPlaceholder(rendered);
    const name = node.name, tag = vocabulary[name];
    if (tag) return '<' + tag + '>' + inline(node) + '</' + tag + '>';
    if (/(?:Mark|Delimiter|LinkTitle|LinkLabel|CodeInfo|FootnoteIndent)$/.test(name)) return '';
    const heading = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(name);
    if (heading) {
      let start = node.from, end = node.to;
      for (const mark of node.getChildren('HeaderMark')) if (mark.from === node.from) start = mark.to; else end = mark.from;
      while (start < end && /\s/.test(text[start]!)) start++;
      while (end > start && /\s/.test(text[end - 1]!)) end--;
      return '<h' + heading[1] + '>' + inline(node, start, end) + '</h' + heading[1] + '>';
    }
    switch (name) {
      case 'Document': return children(node);
      case 'Paragraph': {
        const parent = node.parent;
        // CommonMark 紧列表无 p；空行分隔的松列表保留段落壳。
        const tight = parent?.name === 'ListItem' && !/\n[ \t>]*\n/.test(raw(parent.parent!));
        const body = inline(node);
        return tight ? body : '<p>' + body + '</p>';
      }
      case 'Task': return inline(node);
      case 'TaskMarker': return '';
      case 'BulletList': return '<ul>' + children(node) + '</ul>';
      case 'OrderedList': {
        const start = /^\d+/.exec(raw(node))?.[0] ?? '1';
        return '<ol' + (start !== '1' ? ' start="' + start + '"' : '') + '>' + children(node) + '</ol>';
      }
      case 'ListItem': {
        const marker = node.getChild('Task')?.getChild('TaskMarker');
        const checked = marker ? /x/i.test(raw(marker)) : false;
        return '<li' + (marker ? ' class="md-task-item' + (checked ? ' md-task-item--done' : '') + '"' : '') + '>'
          + (marker ? '<input disabled type="checkbox"' + (checked ? ' checked' : '') + ' />' : '') + children(node) + '</li>';
      }
      case 'Blockquote': return '<blockquote>' + children(node) + '</blockquote>';
      case 'HorizontalRule': return '<hr />';
      case 'FencedCode': case 'CodeBlock': return code(node);
      case 'InlineCode': {
        const marks = node.getChildren('CodeMark');
        let value = text.slice(marks[0]?.to ?? node.from, marks[1]?.from ?? node.to).replace(/\n/g, ' ');
        if (/^ .* $/.test(value) && /\S/.test(value)) value = value.slice(1, -1);
        return '<code>' + esc(value) + '</code>';
      }
      case 'Link': case 'Image': return link(node);
      case 'Autolink': case 'URL': {
        const href = automaticLinkTarget(raw(node));
        return href ? '<a href="' + esc(href) + '">' + esc(raw(node).replace(/^<|>$/g, '')) + '</a>' : esc(raw(node));
      }
      case 'Escape': case 'Entity': return esc(decode(raw(node)));
      case 'HardBreak': return '<br />\n';
      case 'Emoji': return esc(emojiTable[raw(node).slice(1, -1)] ?? raw(node));
      case 'FootnoteReference': {
        const note = metadata.footnotes.find(item => item.label === normalizeReference(raw(node).slice(2, -1)));
        if (!note) return esc(raw(node));
        // 后处理沿用 旧引擎定义序→首次引用序映射。
        const number = [...metadata.footnotes].sort((a, b) => a.from - b.from).indexOf(note) + 1;
        const occurrence = note.references.findIndex(range => range.from === node.from);
        const suffix = occurrence > 0 ? ':' + (occurrence + 1) : '';
        return '<sup class="footnotes-ref" id="footnotes-ref-' + number + suffix + '"><a href="#footnotes-def-' + number + '">' + number + '</a></sup>';
      }
      case 'FootnoteDefinition': case 'LinkReference': return '';
      case 'TableOfContents': return '<p>[toc]</p>';
      case 'MathUnclosed': return '<pre><code>' + esc(raw(node)) + '</code></pre>';
      case 'Table': {
        const aligns = metadata.tableAligns.get(node.from) ?? [];
        const width = node.getChild('TableHeader')?.getChildren('TableCell').length ?? 0;
        const row = (item: SyntaxNode, header: boolean): string => '<tr>' + Array.from({ length: width }, (_, i) => {
          const cell = item.getChildren('TableCell')[i];
          const tag = header ? 'th' : 'td';
          return '<' + tag + (aligns[i] ? ' align="' + aligns[i] + '"' : '') + '>' + (cell ? inline(cell) : '') + '</' + tag + '>';
        }).join('') + '</tr>';
        const header = node.getChild('TableHeader');
        return '<table><thead>' + (header ? row(header, true) : '') + '</thead><tbody>' + node.getChildren('TableRow').map(item => row(item, false)).join('') + '</tbody></table>';
      }
      default: return esc(raw(node)); // 禁用原始 HTML，未知语法保留字面内容。
    }
  };
  let html = '';
  for (let node = tree.topNode.childAfter(from); node && node.from < to; node = node.nextSibling) {
    if (node.from >= from && node.to <= to) html += render(node);
  }
  if (to === text.length && metadata.footnotes.length) {
    const notes = [...metadata.footnotes].sort((a, b) => a.from - b.from);
    html += '<ol class="footnotes-defs-ol">' + notes.map((note, i) => {
      const bodyTree = staticMarkdownParser.parse(note.body);
      // 定义正文只递归块/行内序列化，绝不递归追加定义集合。
      const bodyMetadata = { ...extractMarkdownMetadata(note.body, bodyTree), references: metadata.references, footnotes: [] };
      const body = renderStaticHtml(note.body, bodyTree, bodyMetadata);
      return '<li id="footnotes-def-' + (i + 1) + '">' + body + '<a class="md-footnotes-goto" href="#footnotes-ref-' + (i + 1) + '">↩</a></li>';
    }).join('') + '</ol>';
  }
  return html;
}
