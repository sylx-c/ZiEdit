// markdown-view/live-state —— live preview 引擎最底层共享状态（批次 4 自 livepreview.ts 拆分，行为不变）。
// StateEffect/StateField 因 CM6 身份语义必须单源定义：effects/fields/常量与跨文件共享的纯函数
// 集中于此，live-widgets/live-deco/live-block-field/livepreview 均可安全 import——本文件
// 不 import 任何 live-* 模块，无循环依赖。
import { EditorState, StateEffect, StateField, Facet, Transaction, type Text, type ChangeDesc } from '@codemirror/state';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { extractMarkdownMetadata, normalizeReference, automaticLinkTarget, type MarkdownReferences, type MarkdownMetadata, type FootnoteItem } from './headings';
import { decodeMarkdownEntity, type HeadingItem } from './preview';
import { irWorkStart, recordIrWork } from './ir-perf';

/** 视口外沿预装饰余量（UTF-16 偏移）：避免滚动中闪源码（规则 22）。 */
export const VIEWPORT_MARGIN = 300;

type ImageContext = { baseDir: string | null; remoteResolve?: (url: string) => Promise<string | null> };
export const imageContext = Facet.define<ImageContext, ImageContext>({
  combine: values => values[0] ?? { baseDir: null },
});
export interface ReferenceIndex {
  urls: Map<string, string>; titles: Map<string, string>; definitions: MarkdownReferences;
  metadata: MarkdownMetadata; footnotes: Map<string, FootnoteItem>;
  headings: Map<number, HeadingItem>; mapping: ChangeDesc | null; inlineKey: string;
}
function inlineIndexKey(definitions: MarkdownReferences, footnotes: ReadonlyMap<string, FootnoteItem>): string {
  return JSON.stringify([definitions, [...footnotes.values()].map(note => [note.label, note.number])]);
}
export function referenceIndex(doc: Text, metadata?: Partial<MarkdownMetadata>): ReferenceIndex {
  const value: MarkdownMetadata = { headings: [], references: {}, referenceRanges: [], footnotes: [], frontMatter: null, superscripts: [], subscriptRanges: [], highlightRanges: [], taskRanges: [], tableAligns: new Map(), renderBlocks: [], verbatimRanges: [], rawMathRanges: [], autoLinks: [], ...metadata };
  const urls = new Map<string, string>(), titles = new Map<string, string>();
  for (const [label, reference] of Object.entries(value.references)) {
    urls.set(normalizeReference(label), reference.href);
    if (reference.title) titles.set(normalizeReference(label), '"' + reference.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
  }
  const footnotes = new Map(value.footnotes.map(note => [note.label, note]));
  return { urls, titles, definitions: value.references, metadata: value, mapping: null, footnotes,
    inlineKey: inlineIndexKey(value.references, footnotes),
    headings: new Map(value.headings.map(heading => [doc.line(Math.min(doc.lines, heading.line + 1)).from, heading])) };
}
export function currentPosition(index: ReferenceIndex, position: number): number { return index.mapping?.mapPos(position, 1) ?? position; }
export const emojisReady = StateEffect.define<Readonly<Record<string, string>>>();
export const emojiField = StateField.define<Readonly<Record<string, string>>>({ create: () => ({}),
  update(value, tr) { for (const e of tr.effects) if (e.is(emojisReady)) value = e.value; return value; } });
/** 用户交互标记（007 规则 2② v0.39）：首个带 userEvent 的事务后置真——标题井号活动显隐据此区分初始挂载光标（2026-10-19 决策）。 */
export const mdTouchedField = StateField.define<boolean>({
  create: () => false,
  update: (touched, tr) => touched || tr.annotation(Transaction.userEvent) !== undefined,
});
export const referencesReady = StateEffect.define<ReferenceIndex>();
export const referenceField = StateField.define<ReferenceIndex>({
  // FC 收口 1 归类：create 内同步提取（mdLinkTools）受 CM StateField 同步契约约束，无法 await；
  // 前置条件 = LivePreviewView.init 挂载屏障（mountEditor 前 await loadMarkdownIt）或
  // 模块加载预取已完成。直接以测试桥构造 State 的调用方同样依赖预取时机成立。
  create: state => referenceIndex(state.doc, state.doc.length <= 64 * 1024
    ? extractMarkdownMetadata(state.doc.toString(), syntaxTreeAvailable(state, state.doc.length) ? syntaxTree(state) : undefined) : undefined),
  update(value, tr) {
    const started = irWorkStart();
    try {
    if (tr.docChanged) {
      let { urls, titles, definitions } = value;
      let footnotes = value.footnotes;
      const touched = (from: number, to: number): boolean => !!tr.changes.touchesRange(currentPosition(value, from), currentPosition(value, to));
      for (const definition of value.metadata.referenceRanges) if (touched(definition.from, definition.to)) {
        if (definitions === value.definitions) {
          urls = new Map(urls); titles = new Map(titles); definitions = { ...definitions };
        }
        urls.delete(definition.label); titles.delete(definition.label); delete definitions[definition.label];
      }
      for (const note of value.footnotes.values()) if (touched(note.from, note.to)) {
        if (footnotes === value.footnotes) footnotes = new Map(footnotes);
        footnotes.delete(note.label);
      }
      const inlineKey = definitions === value.definitions && footnotes === value.footnotes
        ? value.inlineKey : inlineIndexKey(definitions, footnotes);
      value = { ...value, urls, titles, definitions, footnotes, inlineKey, mapping: value.mapping?.composeDesc(tr.changes) ?? tr.changes };
    }
    for (const effect of tr.effects) if (effect.is(referencesReady)) value = effect.value;
    return value;
    } finally { recordIrWork('references', started); }
  },
});

/** 链接目标解析（Ctrl+点击路由用）：从 Link/Image 节点取 URL 子节点文本，剥 () 与 <> 包裹 */
export function referenceLabel(node: SyntaxNode, doc: { sliceString(from: number, to?: number): string }): string {
  const label = node.getChild('LinkLabel');
  const key = label ? doc.sliceString(label.from + 1, label.to - 1) : '';
  return normalizeLabel(key || /^!?\[([\s\S]*?)\]/.exec(doc.sliceString(node.from, node.to))?.[1] || '');
}

export function linkUrlOfNode(node: SyntaxNode, doc: { sliceString(from: number, to?: number): string }, refs?: () => ReadonlyMap<string, string>): string | null {
  let url: SyntaxNode | null = node.name === 'URL' ? node : null;
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === 'URL') { url = c; break; }
  if (!url) {
    return refs?.().get(referenceLabel(node, doc)) ?? null;
  }
  let raw = doc.sliceString(url.from, url.to).trim();
  if (raw.startsWith('(') && raw.endsWith(')')) raw = raw.slice(1, -1).trim();
  if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1);
  if (node.name === 'URL' || node.name === 'Autolink') return automaticLinkTarget(raw);
  raw = decodeMarkdownEntity(raw);
  return raw || null;
}

export const normalizeLabel = normalizeReference;
export function referenceUrls(state: EditorState): ReadonlyMap<string, string> {
  return state.field(referenceField, false)?.urls ?? new Map();
}
