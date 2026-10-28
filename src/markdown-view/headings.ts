import { parser as baseParser, GFM, Superscript, Subscript, Emoji } from '@lezer/markdown';
import { liveMarkdownExtensions } from './extensions';
import type { Tree, SyntaxNode } from '@lezer/common';
import { renderBlockAt, renderPlaceholder, escapeRenderText, type RenderBlock } from './render-model';
import { mdLinkTools } from './md-link';

export interface HeadingItem {
  level: number;
  text: string;
  id: string;
  line: number;
}
export type MarkdownReferences = Record<string, { href: string; title: string }>;
export interface SourceRange { from: number; to: number }
export interface FootnoteItem extends SourceRange { label: string; number: number; body: string; references: SourceRange[] }
export interface ReferenceDefinition extends SourceRange { label: string }
export interface TaskRange extends SourceRange { checked: boolean; itemFrom: number; itemTo: number }
export interface MarkdownMetadata {
  headings: HeadingItem[];
  references: MarkdownReferences;
  referenceRanges: ReferenceDefinition[];
  footnotes: FootnoteItem[];
  frontMatter: SourceRange | null;
  superscripts: SourceRange[];
  subscriptRanges: SourceRange[];
  highlightRanges: SourceRange[];
  taskRanges: TaskRange[];
  /** 键固定为 Table 节点的 from（文档 UTF-16 坐标）。 */
  tableAligns: Map<number, ('left' | 'center' | 'right' | null)[]>;
  renderBlocks: RenderBlock[];
  verbatimRanges: SourceRange[];
  rawMathRanges: SourceRange[];
  autoLinks: SourceRange[];
}

// markdown-it 链接/实体工具经同步接缝获取（./md-link）：
// 主线程由 md.ts 共享单例注入、worker 由 headings-worker 入口注入——本文件不再静态
// import markdown-it，主 chunk 首屏体积随之解除该依赖。
const indexParser = baseParser.configure([GFM, Superscript, Subscript, Emoji, liveMarkdownExtensions]);
export const normalizeReference = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();

/** 输入必须来自已解析的URL或Autolink节点，不能把任意正文猜成地址。 */
export function automaticLinkTarget(source: string): string | null {
  let target = source.replace(/^<|>$/g, '');
  if (/^[^\s@:]+@[^\s@]+$/.test(target)) target = 'mailto:' + target;
  else if (/^www\./i.test(target)) target = 'http://' + target;
  const md = mdLinkTools();
  return md.validateLink(target) ? md.normalizeLink(target) : null;
}

/** 三种渲染面共用稳定的可读锚点，重复标题按文档顺序消歧。 */
function headingId(plain: string, used: Set<string>, counters: Map<string, number>): string {
  const base = plain.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
  let count = counters.get(base) ?? 0, id = count ? base + '-' + count : base;
  while (used.has(id)) id = base + '-' + ++count;
  counters.set(base, count + 1); used.add(id); return id;
}

export function previewSource(text: string, metadata: MarkdownMetadata): string {
  return metadata.frontMatter ? text.slice(0, metadata.frontMatter.to).replace(/[^\n]/g, ' ') + text.slice(metadata.frontMatter.to) : text;
}

/** 旧引擎的脚注与上标共用 ^ 分隔状态；按语法源范围投影，避免脚注吃掉后续上标。 */
/** D-T2-01：按窗口投影的预处理范围（html 只依赖范围自身，与调用窗口无关，按 metadata 缓存一次） */
interface ProjectedRange extends SourceRange { html: string }
const projectedCache = new WeakMap<MarkdownMetadata, ProjectedRange[]>();

/** 全文档范围 → 最终投影项，按 from 升序（同 from 长者优先）缓存于 metadata（按约定不可变）。 */
function projectedRanges(source: string, metadata: MarkdownMetadata): ProjectedRange[] {
  let cached = projectedCache.get(metadata);
  if (!cached) {
    const supers = metadata.footnotes.length ? metadata.superscripts : [];
    cached = [
      ...metadata.renderBlocks.map(block => ({ from: block.from, to: block.to, html: renderPlaceholder(block) })),
      ...metadata.verbatimRanges.map(range => ({ ...range, html: source.slice(range.from, range.to) })),
      ...metadata.rawMathRanges.map(range => ({ ...range, html: '<pre><code>' + escapeRenderText(source.slice(range.from, range.to)) + '</code></pre>' })),
      ...metadata.autoLinks.flatMap(range => {
        const raw = source.slice(range.from, range.to), href = automaticLinkTarget(raw);
        // 旧引擎仍解析HTML标签之间的Markdown；实体保护标点，避免网址内的$、*等被再次解释。
        const label = raw.replace(/^<|>$/g, '').replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, char => '&#' + char.charCodeAt(0) + ';');
        return href ? [{ from: range.from, to: range.to, html: '<a href="' + escapeRenderText(href) + '">' + label + '</a>' }] : [];
      }),
      ...supers.map(range => ({ ...range,
        html: '<sup>' + source.slice(range.from + 1, range.to - 1) + '</sup>' })),
    ].sort((a, b) => a.from - b.from || b.to - a.to);
    projectedCache.set(metadata, cached);
  }
  return cached;
}

export function projectMarkdownSource(text: string, metadata: MarkdownMetadata, from = 0, to = text.length): string {
  const fm = metadata.frontMatter;
  // D-T2-01：front matter 掩码只改写 [0, fm.to)；窗口完全在其后的块在 [from,to) 上与掩码串逐字符
  // 相同（范围集合也不落进掩码区——元数据提取跳过 front matter 内节点），直接按原文切片，
  // 不再每块重建整篇掩码串。
  const source = fm && from < fm.to ? previewSource(text, metadata) : text;
  // 修前：每块调用都对全文档范围数组做全量 map（renderPlaceholder/整段切片）+ 全量排序，
  // O(全文)×块数 = O(n²)——1.3M 字符文档分屏首渲仅 projectMarkdownSource 合计约 70s+，右栏空渲直至
  // 渲染进程内存耗尽重启（内存态 modeMap 丢失→按默认形态重开）。窗口过滤移到投影缓存之后。
  const changes = projectedRanges(source, metadata);
  // 有序数组二分定位窗口起点，仅遍历 [from,to) 内候选（修前为全量线性过滤）。
  let lo = 0, hi = changes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (changes[mid]!.from < from) lo = mid + 1; else hi = mid;
  }
  let result = '', offset = from;
  // 闭合语法以索引为准；其余 $ 用实体保留，阻止旧引擎把转义或未闭合文本另行识别成公式。
  const literal = (part: string): string => part.replace(/(\\*)\$/g, (_match, slashes: string) =>
    (slashes.length % 2 ? slashes.slice(0, -1) : slashes) + '&#36;');
  for (let i = lo; i < changes.length && changes[i]!.from < to; i++) {
    const range = changes[i]!;
    if (range.to > to || range.from < offset) continue;
    result += literal(source.slice(offset, range.from)) + range.html; offset = range.to;
  }
  return result + literal(source.slice(offset, to));
}

/** 仅运行块解析；标题内容沿用源码，无需为全文生成行内 token。
 *  同步入口（FC 收口 1 归类）：前置条件 = md.ts 预取/挂载屏障已完成（worker 侧为入口静态绑定）。
 *  外部异步调用方（源码大纲等冷启动路径）应改走 extractHeadingsReady。 */
export function extractHeadings(markdown: string): HeadingItem[] {
  return extractMarkdownMetadata(markdown).headings;
}

/** 异步大纲入口（源码大纲冷启动用，FC 收口 1）：等待主线程共享 markdown-it 就绪后再同步提取。
 *  返回 Promise、不抛同步错误——shell/outline 等外部调用方以其作为「先就绪再提取」的屏障。
 *  动态 import ./md：headings 的静态依赖图（含 worker chunk）不引入 md 及其高亮/渲染依赖。 */
export async function extractHeadingsReady(markdown: string): Promise<HeadingItem[]> {
  const { loadMarkdownIt } = await import('./md');
  await loadMarkdownIt();
  return extractMarkdownMetadata(markdown).headings;
}

/** 同一次块解析同时取得引用定义，避免 IR 在视口外定义尚未解析时丢失引用式图片。 */
export function extractMarkdownMetadata(markdown: string, parsedTree?: Tree): MarkdownMetadata {
  const front = /^(?:\uFEFF)?---[ \t]*\n(?:[\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(markdown);
  const frontMatter = front ? { from: 0, to: front[0].length } : null;
  const tree = parsedTree ?? indexParser.parse(markdown);
  const definitions = new Map<string, FootnoteItem>();
  const mentions = new Map<string, SourceRange[]>();
  const referenceRanges: ReferenceDefinition[] = [];
  const superscripts: SourceRange[] = [];
  const subscriptRanges: SourceRange[] = [], highlightRanges: SourceRange[] = [];
  const taskRanges: TaskRange[] = [];
  const tableAligns: MarkdownMetadata['tableAligns'] = new Map();
  const references: MarkdownReferences = {};
  const out: HeadingItem[] = [], ids = new Set<string>(), counters = new Map<string, number>();
  let lineOffset = 0, lineNumber = 0;
  const plain = (node: SyntaxNode, from = node.from, to = node.to): string => {
    let value = '', offset = from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.from < from || child.to > to) continue;
      value += markdown.slice(offset, child.from).replace(/[ \t]*\n[ \t]*/g, '');
      if (child.name === 'Escape' || child.name === 'Entity') value += mdLinkTools().utils.unescapeAll(markdown.slice(child.from, child.to));
      else if (child.name === 'InlineCode') {
        const marks = child.getChildren('CodeMark');
        let code = markdown.slice(marks[0]?.to ?? child.from, marks[1]?.from ?? child.to).replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && /\S/.test(code)) code = code.slice(1, -1);
        value += code;
      } else if (child.name === 'Image') {
        const marks = child.getChildren('LinkMark'), close = marks.find(mark => markdown.slice(mark.from, mark.to) === ']');
        value += close ? markdown.slice(marks[0]!.to, close.from) : markdown.slice(child.from, child.to);
      } else if (child.name !== 'HardBreak' && !/(?:Mark|URL|LinkTitle|LinkLabel)$/.test(child.name)) value += plain(child);
      offset = child.to;
    }
    return value + markdown.slice(offset, to).replace(/[ \t]*\n[ \t]*/g, '');
  };
  const renderBlocks: RenderBlock[] = [];
  const verbatimRanges: SourceRange[] = [], rawMathRanges: SourceRange[] = [], autoLinks: SourceRange[] = [];
  tree.iterate({ enter(node) {
    if (frontMatter && node.from < frontMatter.to && node.name !== 'Document') return false;
    const heading = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(node.name);
    if (heading) {
      let from = node.from, to = node.to;
      for (const mark of node.node.getChildren('HeaderMark')) {
        if (mark.from === node.from) from = mark.to;
        else to = mark.from;
      }
      const text = markdown.slice(from, to).trim();
      while (lineOffset < node.from) if (markdown.charCodeAt(lineOffset++) === 10) lineNumber++;
      if (text) out.push({ level: Number(heading[1]), text, id: headingId(plain(node.node, from, to), ids, counters), line: lineNumber });
    }
    if (node.name === 'Subscript') subscriptRanges.push({ from: node.from, to: node.to });
    if (node.name === 'Highlight') highlightRanges.push({ from: node.from, to: node.to });
    if (node.name === 'TaskMarker') {
      let item = node.node.parent;
      while (item && item.name !== 'ListItem') item = item.parent;
      if (item) taskRanges.push({ from: node.from, to: node.to, checked: /x/i.test(markdown.slice(node.from, node.to)), itemFrom: item.from, itemTo: item.to });
    }
    if (node.name === 'Table') {
      const delimiter = node.node.getChild('TableDelimiter');
      const cells = delimiter ? markdown.slice(delimiter.from, delimiter.to).trim().replace(/^\||\|$/g, '').split('|') : [];
      tableAligns.set(node.from, cells.map(cell => /^\s*:.*:\s*$/.test(cell) ? 'center' : /:\s*$/.test(cell) ? 'right' : /^\s*:/.test(cell) ? 'left' : null));
    }
    const rendered = renderBlockAt(node.node, (from, to) => markdown.slice(from, to));
    if (rendered) { renderBlocks.push(rendered); return false; }
    if (node.name === 'MathUnclosed') { rawMathRanges.push({ from: node.from, to: node.to }); return false; }
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') {
      verbatimRanges.push({ from: node.from, to: node.to }); return false;
    }
    if (node.name === 'Autolink' || (node.name === 'URL' && !['Link', 'Image'].includes(node.node.parent?.name ?? ''))) {
      autoLinks.push({ from: node.from, to: node.to }); return false;
    }
    if (node.name === 'Superscript') superscripts.push({ from: node.from, to: node.to });
    if (node.name === 'LinkReference') {
      const label = node.node.getChild('LinkLabel');
      if (label) {
        const key = normalizeReference(markdown.slice(label.from + 1, label.to - 1));
        referenceRanges.push({ label: key, from: node.from, to: node.to });
        const url = node.node.getChild('URL'), title = node.node.getChild('LinkTitle');
        if (url && !Object.prototype.hasOwnProperty.call(references, key)) {
          const md = mdLinkTools();
          const href = md.normalizeLink(md.utils.unescapeAll(markdown.slice(url.from, url.to).replace(/^<|>$/g, '')));
          if (md.validateLink(href)) Object.defineProperty(references, key, { value: { href, title: title ? md.utils.unescapeAll(markdown.slice(title.from + 1, title.to - 1)) : '' }, enumerable: true });
        }
      }
      return false;
    }
    if (node.name === 'FootnoteDefinition') {
      const marker = node.node.getChild('FootnoteLabel')!;
      const label = normalizeReference(/^\[\^([^\]]+)\]/.exec(markdown.slice(marker.from, marker.to))![1]!);
      if (!definitions.has(label)) {
        const indentRanges = node.node.getChildren('FootnoteIndent');
        let body = '', offset = marker.to;
        for (const indent of indentRanges) {
          const lineStart = markdown.lastIndexOf('\n', indent.from - 1) + 1;
          body += markdown.slice(offset, lineStart).replace(/(^|\n)[ >\t]*(?=\n|$)/g, '$1'); offset = indent.to;
        }
        body += markdown.slice(offset, node.to);
        definitions.set(label, { label, number: 0, body, from: node.from, to: node.to, references: [] });
      }
      return undefined;
    }
    if (node.name === 'FootnoteReference') {
      for (let parent = node.node.parent; parent; parent = parent.parent) if (parent.name === 'FootnoteDefinition') return false;
      const label = normalizeReference(markdown.slice(node.from + 2, node.to - 1));
      const refs = mentions.get(label) ?? []; refs.push({ from: node.from, to: node.to }); mentions.set(label, refs);
    }
    return undefined;
  } });
  const footnotes: FootnoteItem[] = [];
  for (const [label, references] of mentions) {
    const definition = definitions.get(label);
    if (definition) footnotes.push({ ...definition, number: footnotes.length + 1, references });
  }
  for (const definition of definitions.values()) if (!mentions.has(definition.label)) footnotes.push({ ...definition, number: footnotes.length + 1 });
  return { headings: out, references, referenceRanges, footnotes, frontMatter, superscripts, subscriptRanges, highlightRanges, taskRanges, tableAligns, renderBlocks, verbatimRanges, rawMathRanges, autoLinks };
}
