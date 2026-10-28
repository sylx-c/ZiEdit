import type { MarkdownMetadata, SourceRange } from './headings';

export type MarkdownMetadataReport = MarkdownMetadata & { readonly version: number; readonly fingerprint: string };

export function metadataFingerprint(metadata: MarkdownMetadata, source: string): string {
  let first = 0x811c9dc5, second = 0x9e3779b9;
  const word = (code: number): void => {
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second = second << 13 | second >>> 19;
  };
  const add = (value: string | number | boolean): void => {
    const text = String(value);
    word(text.length);
    for (let offset = 0; offset < text.length; offset++) word(text.charCodeAt(offset));
  };
  const ranges = (items: readonly SourceRange[]): void => {
    add(items.length);
    for (const item of items) add(source.slice(item.from, item.to));
  };
  const references = Object.entries(metadata.references).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  add(references.length);
  for (const [label, reference] of references) { add(label); add(reference.href); add(reference.title); }
  add(metadata.headings.length);
  for (const heading of metadata.headings) { add(heading.level); add(heading.text); add(heading.id); }
  add(metadata.footnotes.length);
  for (const note of metadata.footnotes) { add(note.label); add(note.number); add(note.body); add(note.references.length); }
  add(metadata.renderBlocks.length);
  for (const block of metadata.renderBlocks) { add(block.kind); add(block.source); add(block.display); }
  add(metadata.referenceRanges.length);
  for (const definition of metadata.referenceRanges) { add(definition.label); add(source.slice(definition.from, definition.to)); }
  ranges(metadata.superscripts);
  ranges(metadata.subscriptRanges);
  ranges(metadata.highlightRanges);
  ranges(metadata.taskRanges);
  for (const task of metadata.taskRanges) add(task.checked);
  add(metadata.tableAligns.size);
  for (const aligns of metadata.tableAligns.values()) for (const align of aligns) add(align ?? '');
  ranges(metadata.verbatimRanges);
  ranges(metadata.rawMathRanges);
  ranges(metadata.autoLinks);
  add(metadata.frontMatter !== null);
  if (metadata.frontMatter) add(source.slice(metadata.frontMatter.from, metadata.frontMatter.to));
  return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0');
}
