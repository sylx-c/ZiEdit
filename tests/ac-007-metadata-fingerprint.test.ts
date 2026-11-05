// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LivePreviewView, referenceField, type LivePreviewOpts } from '../src/markdown-view/livepreview';
import { extractMarkdownMetadata, type MarkdownMetadata } from '../src/markdown-view/headings';
import { irPerfReset, irPerfSnapshot } from '../src/markdown-view/ir-perf';
import { metadataFingerprint } from '../src/markdown-view/metadata-fingerprint';
import { renderContextCounters, resetRenderContextCounters } from '../src/markdown-view/render-service';

vi.mock('../src/common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textReadAll: async () => '', textSave: async () => ({ len: 0 }) }));
vi.mock('../src/markdown-view/preview', async original => ({ ...await original<object>(), loadUnicodeEmojis: async () => ({}) }));
Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
Range.prototype.getBoundingClientRect = () => new DOMRect();
const previews: LivePreviewView[] = [];
afterEach(() => {
  for (const preview of previews.splice(0)) preview.destroy();
  document.body.replaceChildren();
  irPerfReset(); resetRenderContextCounters(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, '__ZIEDIT_IR_PERF_DATA__');
});

type Request = { text: string; version: number };
type Response = MarkdownMetadata & { version: number; fingerprint: string };
class MetadataWorker {
  static current: MetadataWorker;
  onmessage: ((event: MessageEvent<Response>) => void) | null = null;
  pending: Request | null = null;
  posts = 0;
  maxPending = 0;
  terminated = false;
  constructor() { MetadataWorker.current = this; }
  postMessage(request: Request): void {
    this.maxPending = Math.max(this.maxPending, this.pending ? 2 : 1);
    this.pending = request; this.posts++;
  }
  respond(response: Response): void {
    this.pending = null;
    this.onmessage?.(new MessageEvent('message', { data: response }));
  }
  terminate(): void { this.terminated = true; this.pending = null; }
}

function responseOf(worker: MetadataWorker): Response {
  const request = worker.pending;
  if (!request) throw new Error('Missing metadata request');
  const metadata = extractMarkdownMetadata(request.text);
  return { ...metadata, version: request.version, fingerprint: metadataFingerprint(metadata, request.text) };
}

async function mount(source: string) {
  vi.stubGlobal('Worker', MetadataWorker);
  const host = document.createElement('div'); document.body.append(host);
  const ready = vi.fn<NonNullable<LivePreviewOpts['onReady']>>();
  const preview = new LivePreviewView(host, { path: 'E:/fingerprint.md', encoding: 'UTF-8', initialDoc: source,
    onStatus: () => {}, onSaved: () => {}, onReady: ready });
  previews.push(preview);
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(MetadataWorker.current.pending).not.toBeNull());
  const worker = MetadataWorker.current;
  worker.respond(responseOf(worker));
  vi.stubGlobal('__ZIEDIT_IR_PERF__', true); irPerfReset();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  return { preview, view: preview.view, worker, host, api: ready.mock.calls[0]?.[0] };
}

describe('007 AC-36 metadata publication fingerprint', () => {
  it('skips main-thread metadata serialization and preserves the mapped index on worker prose reports', async () => {
    const { view, worker } = await mount('Plain\n\n# Heading\n\n[ref]: /old.md\n\n' + 'ordinary paragraph\n\n'.repeat(4000));
    view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
    const mapped = view.state.field(referenceField);
    await vi.advanceTimersByTimeAsync(910);
    const response = responseOf(worker);
    const stringify = vi.spyOn(JSON, 'stringify');

    worker.respond(response);

    expect(stringify.mock.calls.filter(([value]) => value !== null && typeof value === 'object' && 'referenceRanges' in value)).toHaveLength(0);
    expect(stringify.mock.calls.filter(([value]) => value !== response.headings)).toHaveLength(0);
    expect(view.state.field(referenceField)).toBe(mapped);
    expect(irPerfSnapshot().fullRebuildEvents).toEqual([]);
  });

  it('keeps the mapped index when a worker report only moves headings and source ranges', async () => {
    const { view, worker } = await mount('Plain\n\n# Heading\n\nA[^1] x^2^ <https://example.test>\n\n[^1]: note\n\n' + 'ordinary paragraph\n\n'.repeat(4000));
    view.dispatch({ changes: { from: 0, insert: 'Before\n\n' }, userEvent: 'input.type' });
    const mapped = view.state.field(referenceField);
    await vi.advanceTimersByTimeAsync(910);

    worker.respond(responseOf(worker));

    expect(view.state.field(referenceField)).toBe(mapped);
    expect(irPerfSnapshot().fullRebuildEvents).toEqual([]);
  });

  it.each([
    { name: 'link definition', head: '[caption][ref]\n\n[ref]: /old.md', before: '/old.md', after: '/new.md' },
    { name: 'footnote body', head: 'A[^1]\n\n[^1]: old note', before: 'old note', after: 'new note' },
    { name: 'image definition', head: '![caption][ref]\n\n[ref]: https://images.test/old.png', before: 'old.png', after: 'new.png' },
  ])('dispatches fresh worker metadata after a $name edit', async ({ head, before, after }) => {
    const { view, worker } = await mount('Plain\n\n' + head + '\n\n' + 'ordinary paragraph\n\n'.repeat(4000));
    const from = view.state.doc.toString().indexOf(before);
    view.dispatch({ changes: { from, to: from + before.length, insert: after }, userEvent: 'input.type' });
    const mapped = view.state.field(referenceField);
    await vi.advanceTimersByTimeAsync(910);

    worker.respond(responseOf(worker));

    expect(view.state.field(referenceField)).not.toBe(mapped);
    expect(irPerfSnapshot().fullRebuildEvents.map(event => event.kind)).toEqual(['referencesReady']);
    expect(view.state.field(referenceField).metadata).toMatchObject(extractMarkdownMetadata(view.state.doc.toString()));
  });

  it.each([
    { name: 'reference', head: '[caption][ref]\n\n[ref]: /old.md', before: '/old.md' },
    { name: 'footnote', head: 'A[^1]\n\n[^1]: old note', before: 'old note' },
  ])('repairs an invalidated $name when edits restore the last published semantics', async ({ head, before }) => {
    const { view, worker } = await mount('Plain\n\n' + head + '\n\n' + 'ordinary paragraph\n\n'.repeat(4000));
    const from = view.state.doc.toString().indexOf(before);
    view.dispatch({ changes: { from, to: from + before.length, insert: 'temporary' } });
    view.dispatch({ changes: { from, to: from + 9, insert: before } });
    await vi.advanceTimersByTimeAsync(910);

    worker.respond(responseOf(worker));

    expect(irPerfSnapshot().fullRebuildEvents.map(event => event.kind)).toEqual(['referencesReady']);
    const index = view.state.field(referenceField);
    expect(index.definitions).toEqual(index.metadata.references);
    expect([...index.footnotes.values()]).toEqual(index.metadata.footnotes);
  });

  it('coalesces typing bursts behind one outstanding worker round and discards its stale fingerprint', async () => {
    const { view, worker } = await mount('Plain\n\n[ref]: /old.md\n\n' + 'ordinary paragraph\n\n'.repeat(4000));
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    await vi.advanceTimersByTimeAsync(910);
    const stale = responseOf(worker);
    for (let burst = 0; burst < 10; burst++) {
      view.dispatch({ changes: { from: 0, insert: 'x' } });
      await vi.advanceTimersByTimeAsync(910);
    }
    expect(worker.posts).toBe(2);

    worker.respond({ ...stale, fingerprint: 'stale-must-not-publish' });
    await vi.advanceTimersByTimeAsync(50);
    worker.respond(responseOf(worker));

    expect(worker.posts).toBe(3);
    expect(worker.maxPending).toBe(1);
    expect(irPerfSnapshot().fullRebuildEvents).toEqual([]);
  });
});

describe('007 AC-36 position-independent metadata semantics', () => {
  const fingerprint = (source: string): string => metadataFingerprint(extractMarkdownMetadata(source), source);
  const source = 'Plain\n\n# Heading\n\n[caption][ref] A[^1] x^2^ <https://example.test>\n\n'
    + '[ref]: /old.md "Title"\n\n[^1]: note\n\n$a+b$\n\n```md\ncode\n```';

  it.each(['prefix', 'prefix\n\n'])('ignores prose and position changes from %j', prefix => {
    expect(fingerprint(prefix + source)).toBe(fingerprint(source));
  });

  it.each([
    ['# Heading', '## Heading'], ['Heading', 'Changed'], ['/old.md', '/new.md'], ['"Title"', '"Changed"'],
    ['[^1]: note', '[^1]: changed'], ['A[^1]', 'A[^1] B[^1]'], ['a+b', 'a-b'], ['x^2^', 'x^3^'],
    ['https://example.test', 'https://other.test'], ['code\n```', 'changed\n```'],
    ['```md\ncode\n```', '$$\nunclosed'],
  ])('detects semantic edits from %j to %j', (before, after) => {
    expect(fingerprint(source.replace(before, after))).not.toBe(fingerprint(source));
  });

  it('includes front matter presence and content', () => {
    const first = '---\ntitle: First\n---\n\n' + source;
    expect(fingerprint(first)).not.toBe(fingerprint(source));
    expect(fingerprint(first.replace('First', 'Other'))).not.toBe(fingerprint(first));
  });

  it.each([
    ['$$\nunclosed', '$$\nchanged'],
    ['```mermaid\ngraph TD; A-->B\n```', '```mermaid\ngraph TD; A-->C\n```'],
    ['$a+b$', '$$\na+b\n$$'],
  ])('detects raw math, diagram and display changes from %j', (before, after) => {
    expect(fingerprint(before)).not.toBe(fingerprint(after));
  });

  it('normalizes reference object order while retaining document order of semantic arrays', () => {
    const metadata = extractMarkdownMetadata(source);
    const references = { A: { href: '/a', title: '' }, B: { href: '/b', title: '' } };
    expect(metadataFingerprint({ ...metadata, references }, source)).toBe(metadataFingerprint({ ...metadata,
      references: { B: references.B, A: references.A } }, source));
    const reordered = '# One\n\n# Two';
    expect(fingerprint(reordered)).not.toBe(fingerprint('# Two\n\n# One'));
    expect(fingerprint(reordered)).toHaveLength(16);
  });
});

describe('007 AC-36 large-document typing lifetime', () => {
  it('keeps metadata collections, render generations and the worker queue bounded across two typing rounds', async () => {
    const source = 'Plain\n\n# Heading\n\n[caption][ref] A[^1]\n\n[ref]: /old.md\n\n[^1]: note\n\n'
      + '$a+b$\n\n'.repeat(8) + ('ordinary paragraph '.repeat(12) + '\n\n').repeat(5000);
    expect(source.length).toBeGreaterThan(1_000_000);
    const { view, worker, preview, api, host } = await mount(source);
    if (!api) throw new Error('Missing minimap API');
    const initial = view.state.field(referenceField);
    const lines = api.getLines();
    resetRenderContextCounters();

    for (let round = 0; round < 2; round++) {
      for (let sentence = 0; sentence < 6; sentence++) {
        for (let key = 0; key < 10; key++) view.dispatch({ changes: { from: key, insert: 'x' }, userEvent: 'input.type' });
        await vi.advanceTimersByTimeAsync(910);
        worker.respond(responseOf(worker));
        const index = view.state.field(referenceField);
        expect(index.metadata).toBe(initial.metadata);
        expect(index.urls.size).toBe(1);
        expect(index.titles.size).toBe(0);
        expect(index.footnotes.size).toBe(1);
        expect(index.headings.size).toBe(1);
        expect(index.mapping?.toJSON().length).toBeLessThanOrEqual(6);
        expect(api.getLines()).toBe(lines);
        expect(lines.length).toBe(view.state.doc.lines);
        expect(lines[0]).toBe('x'.repeat((round * 6 + sentence + 1) * 10) + 'Plain');
        expect(host.querySelectorAll('.md-render-target').length).toBeLessThanOrEqual(8);
      }
    }

    expect(worker.posts).toBe(13);
    expect(worker.maxPending).toBe(1);
    expect(worker.pending).toBeNull();
    expect(renderContextCounters).toEqual({ digestComputations: 0, materializations: 0 });
    expect(irPerfSnapshot().fullRebuildEvents.filter(event => event.kind === 'referencesReady')).toEqual([]);
    preview.destroy();
    expect(worker.terminated).toBe(true);
    const posts = worker.posts;
    await vi.advanceTimersByTimeAsync(1000);
    expect(worker.posts).toBe(posts);
  }, 20000);
});
