import { TreeFragment, type Tree } from '@lezer/common';
import { staticMarkdownParser, renderStaticHtml, renderFootnotesHtml } from './static-html';
import { extractMarkdownMetadata, normalizeReference, type MarkdownMetadata } from './headings';

export interface MarkdownChange { from: number; to: number; insert: string }
export interface MarkdownBlock {
  id: string;
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  kind: string;
  src: string;
  signature: string;
  /** 文档级依赖键；定义改变只使实际引用它的块失效。 */
  dependencies?: string[];
  /** 生成内容的独立源码区间；脚注按显示编号排序，源码位置可不连续。 */
  sourceRanges?: Array<{ key: string; target: string; from: number; to: number; startLine: number; endLine: number }>;
}
export interface MarkdownDocument {
  version: number;
  text: string;
  tree: Tree;
  metadata: MarkdownMetadata;
  blocks: MarkdownBlock[];
  lines: number;
}

function fingerprint(value: string): string {
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193); second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return (first >>> 0).toString(36) + ':' + (second >>> 0).toString(36) + ':' + value.length;
}

export function documentChange(before: string, after: string): MarkdownChange {
  let from = 0, to = before.length, end = after.length;
  while (from < Math.min(to, end) && before.charCodeAt(from) === after.charCodeAt(from)) from++;
  while (to > from && end > from && before.charCodeAt(to - 1) === after.charCodeAt(end - 1)) { to--; end--; }
  return { from, to, insert: after.slice(from, end) };
}

/** 文档级派生数据：解析树、元数据与块身份只在版本变化时更新。 */
export class MarkdownDocumentSession {
  private doc: MarkdownDocument | null = null;
  private serial = 0;
  reset(): void { this.doc = null; }

  update(text: string, changes?: readonly MarkdownChange[]): MarkdownDocument {
    const previous = this.doc;
    if (previous?.text === text) return previous;
    const edits = previous ? changes ?? [documentChange(previous.text, text)] : [];
    let fragments: readonly TreeFragment[] = [];
    if (previous && edits.length) {
      let delta = 0;
      fragments = TreeFragment.applyChanges(TreeFragment.addTree(previous.tree), edits.map(edit => {
        const fromB = edit.from + delta;
        delta += edit.insert.length - (edit.to - edit.from);
        return { fromA: edit.from, toA: edit.to, fromB, toB: fromB + edit.insert.length };
      }));
    }
    const tree = staticMarkdownParser.parse(text, fragments);
    const metadata = extractMarkdownMetadata(text, tree);
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    const lineAt = (pos: number): number => {
      let lo = 0, hi = starts.length;
      while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (starts[mid]! <= pos) lo = mid; else hi = mid; }
      return lo;
    };
    const old = new Map<string, MarkdownBlock>();
    if (previous) for (const block of previous.blocks) {
      let delta = 0, touched = false;
      for (const edit of edits) {
        if (edit.to <= block.from) delta += edit.insert.length - (edit.to - edit.from);
        else if (edit.from < block.to) { touched = true; break; }
      }
      if (!touched) old.set(`${block.from + delta}:${block.to + delta}:${block.kind}`, block);
    }
    const referenceSignatures = new Map(Object.entries(metadata.references).map(([key, value]) => [key, fingerprint(JSON.stringify(value))]));
    const notesByLabel = new Map(metadata.footnotes.map(note => [note.label, note]));
    const noteOrder = new Map([...metadata.footnotes].sort((a,b)=>a.from-b.from).map((note,index)=>[note.label,index]));
    const notes = fingerprint(JSON.stringify([...metadata.footnotes].sort((a,b)=>a.from-b.from).map(note => [note.label, note.number, note.body, note.references.length])));
    const headings = fingerprint(JSON.stringify(metadata.headings.map(h => [h.level, h.text, h.id])));
    const blocks: MarkdownBlock[] = [];
    const push = (from: number, to: number, kind: string): void => {
      const src = text.slice(from, to);
      const generated = kind === 'Footnotes';
      const prior = generated ? previous?.blocks.find(block => block.kind === kind) : old.get(`${from}:${to}:${kind}`);
      const dependencies = new Map<string, string>();
      if (src.includes('[') && kind !== 'FrontMatter' && kind !== 'LinkReference' && kind !== 'FootnoteDefinition') {
        const ranges = generated ? metadata.footnotes : [{from,to}];
        for (const range of ranges) tree.iterate({ from:range.from, to:range.to, enter(ref) {
          if (/^(?:FencedCode|CodeBlock|InlineCode|LinkReference)$/.test(ref.name) || !generated && ref.name === 'FootnoteDefinition') return false;
          const node = ref.node;
          if ((ref.name === 'Link' || ref.name === 'Image') && !node.getChild('URL')) {
            const marks = node.getChildren('LinkMark'), opening = marks[0], closing = marks.find(mark => text.slice(mark.from,mark.to) === ']');
            if (opening && closing) {
              const label = node.getChild('LinkLabel'), raw = label ? text.slice(label.from,label.to) : '[]';
              const key = normalizeReference(raw !== '[]' ? raw.slice(1,-1) : text.slice(opening.to,closing.from));
              dependencies.set('reference:' + key, referenceSignatures.get(key) ?? 'missing');
            }
          } else if (ref.name === 'FootnoteReference' && !generated) {
            const key = normalizeReference(text.slice(ref.from+2,ref.to-1)), note = notesByLabel.get(key);
            dependencies.set('footnote:' + key + ':' + ref.from, JSON.stringify([note?.number, noteOrder.get(key), note?.references.findIndex(range=>range.from===ref.from)]));
          }
          return undefined;
        } });
      }
      // 引用位置以块内偏移入键，前文仅插行时不使原块的依赖摘要失效。
      const dependencyEntries = [...dependencies].map(([key,value])=>[key.replace(/^(footnote:.*:)(\d+)$/,(_match,prefix:string,position:string)=>prefix+(Number(position)-from)),value]);
      const signature = (generated ? notes : fingerprint(src)) + fingerprint(JSON.stringify(dependencyEntries)) + (kind === 'TableOfContents' ? headings : '');
      blocks.push({ id: prior && (generated || prior.src === src) ? prior.id : 'md-' + ++this.serial, from, to,
        startLine: lineAt(from), endLine: lineAt(Math.max(from, to - 1)) + 1, kind, src, signature, dependencies:dependencyEntries.map(([key])=>key!) });
      if (generated) blocks[blocks.length - 1]!.sourceRanges = metadata.footnotes.map(note => ({ key:note.label, target:'footnotes-def-' + note.number,
        from:note.from, to:note.to, startLine:lineAt(note.from), endLine:lineAt(Math.max(note.from, note.to-1))+1 }));
    };
    if (metadata.frontMatter) push(0, metadata.frontMatter.to, 'FrontMatter');
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
      if (metadata.frontMatter && node.from < metadata.frontMatter.to) continue;
      const lineStart = text.lastIndexOf('\n', node.from - 1) + 1;
      push(/^[ \t]*$/.test(text.slice(lineStart, node.from)) ? lineStart : node.from, node.to, node.name);
    }
    if (metadata.footnotes.length) push(Math.min(...metadata.footnotes.map(note => note.from)), Math.max(...metadata.footnotes.map(note => note.to)), 'Footnotes');
    return this.doc = { text, tree, metadata, blocks, lines: starts.length, version: (previous?.version ?? 0) + 1 };
  }
}

export function blockHtml(doc: MarkdownDocument, block: MarkdownBlock): string {
  if (block.kind === 'FrontMatter') return '<pre class="md-frontmatter">' + block.src.trimEnd().replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!) + '</pre>';
  if (block.kind === 'Footnotes') return renderFootnotesHtml(doc.metadata);
  return renderStaticHtml(doc.text, doc.tree, doc.metadata, block.from, block.to, false);
}
