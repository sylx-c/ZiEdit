// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import type { ChangeSpec } from '@codemirror/state';
import { LivePreviewView, referenceField, type LivePreviewOpts } from '../src/markdown-view/livepreview';
import { irPerfReset, irPerfSnapshot } from '../src/markdown-view/ir-perf';
import { extractMarkdownMetadata, type MarkdownMetadata } from '../src/markdown-view/headings';
import { metadataFingerprint } from '../src/markdown-view/metadata-fingerprint';

vi.mock('../src/common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textReadAll: async () => '', textSave: async () => ({ len: 0 }) }));
vi.mock('../src/markdown-view/preview', async original => ({ ...await original<object>(), loadUnicodeEmojis: async () => ({ smile: '\u{1f604}' }) }));
Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
Range.prototype.getBoundingClientRect = () => new DOMRect();
const previews: LivePreviewView[] = [];
afterEach(() => {
  for (const preview of previews.splice(0)) preview.destroy();
  document.body.replaceChildren();
  irPerfReset(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, '__ZIEDIT_IR_PERF_DATA__');
});

async function mount(source: string, options: Partial<LivePreviewOpts> = {}) {
  const host = document.createElement('div'); document.body.append(host);
  const ready = vi.fn<NonNullable<LivePreviewOpts['onReady']>>();
  const preview = new LivePreviewView(host, { path: 'E:/mechanism.md', encoding: 'UTF-8', initialDoc: source,
    onStatus: () => {}, onSaved: () => {}, ...options, onReady: ready });
  previews.push(preview);
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  await Promise.resolve();
  const api = ready.mock.calls[0]?.[0];
  if (!api) throw new Error('Missing minimap API');
  vi.stubGlobal('__ZIEDIT_IR_PERF__', true); irPerfReset();
  // Date 一并 fake：元数据上报静默闸门读 Date.now()（批次 0 修正 1），只 fake setTimeout 时
  // Date.now 不随虚拟时钟推进会让闸门 idle 恒 0 无限重排。上报口径=防抖 300 + 静默窗 600。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  return { preview, view: preview.view, host, api };
}

function type(view: EditorView, text: string): void {
  const range = view.state.selection.main;
  if (!view.state.facet(EditorView.inputHandler).some(handle => handle(view, range.from, range.to, text, () => view.state.update(view.state.replaceSelection(text)))))
    view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input.type' });
}

describe('007 AC-36 typing mechanism lock', () => {
  it('keeps the mapped reference index after prose typing and the 300ms report', async () => {
    const { view, host } = await mount('Plain\n\n# Heading\n\n[caption][ref] :smile: A[^1]\n\n[ref]: /old.md "Title"\n\n[^1]: note');

    type(view, 'x');
    const mapped = view.state.field(referenceField);
    await vi.advanceTimersByTimeAsync(300);

    expect(irPerfSnapshot().fullRebuildEvents.filter(event => event.kind === 'referencesReady')).toEqual([]);
    expect(view.state.field(referenceField)).toBe(mapped);
    expect(host.querySelector('.mdir-emoji')?.textContent).toBe('\u{1f604}');
    expect(host.querySelector('.mdir-footnote-ref')?.textContent).toBe('1');
  });

  it('keeps metadata identity when inserted lines only move headings and source ranges', async () => {
    const { view } = await mount('Plain\n\n# Heading\n\nA[^1] [caption][ref] x^2^ <https://example.test>\n\n[ref]: /old.md\n\n[^1]: note\n\n```md\ncode\n```');

    type(view, 'Before\n\n');
    const mapped = view.state.field(referenceField);
    await vi.advanceTimersByTimeAsync(300);

    expect(irPerfSnapshot().fullRebuildEvents).toEqual([]);
    expect(view.state.field(referenceField)).toBe(mapped);
  });

  it('ignores worker response versions when prose leaves metadata unchanged', async () => {
    const requests: { text: string; version: number }[] = [];
    let respond = () => { throw new Error('Missing worker'); };
    class MetadataWorker {
      onmessage: ((event: MessageEvent<MarkdownMetadata & { version: number; fingerprint: string }>) => void) | null = null;
      constructor() {
        respond = () => {
          const request = requests[requests.length - 1];
          if (!request) throw new Error('Missing worker request');
          const metadata = extractMarkdownMetadata(request.text);
          this.onmessage?.(new MessageEvent('message', { data: { version: request.version, ...metadata,
            fingerprint: metadataFingerprint(metadata, request.text) } }));
        };
      }
      postMessage(request: { text: string; version: number }): void { requests.push(request); }
      terminate(): void {}
    }
    vi.stubGlobal('Worker', MetadataWorker);
    const { view } = await mount('Plain\n\n# Heading\n\n[caption][ref]\n\n[ref]: /old.md\n\n' + 'ordinary paragraph\n\n'.repeat(4000));
    await vi.advanceTimersByTimeAsync(10); respond(); irPerfReset();

    type(view, 'x');
    const mapped = view.state.field(referenceField);
    // 防抖 300 触发静默闸门：idle=300<600 再延 300 → t=600 静默窗满才快照发 worker（批次 0）。
    await vi.advanceTimersByTimeAsync(610); respond();

    expect(requests.map(request => request.version)).toEqual([0, 1]);
    expect(irPerfSnapshot().fullRebuildEvents).toEqual([]);
    expect(view.state.field(referenceField)).toBe(mapped);
  });

  it('publishes changed reference definitions and updates rendered link targets', async () => {
    const source = 'Plain\n\n[caption][ref]\n\n[ref]: /old.md "Title"';
    const openMarkdown = vi.fn();
    const { view, host } = await mount(source, { openMarkdown });
    view.dispatch({ selection: { anchor: source.indexOf('/old.md'), head: source.indexOf('/old.md') + 7 } });

    type(view, '/new.md');
    const mapped = view.state.field(referenceField);
    await vi.advanceTimersByTimeAsync(900); // 防抖 300 + 静默窗 600（批次 0 静默闸门）

    expect(irPerfSnapshot().fullRebuildEvents.map(event => event.kind)).toEqual(['referencesReady']);
    expect(view.state.field(referenceField)).not.toBe(mapped);
    host.querySelector('.mdir-link')?.dispatchEvent(new MouseEvent('mousedown', { ctrlKey: true, bubbles: true, cancelable: true }));
    expect(openMarkdown).toHaveBeenLastCalledWith('/new.md');
  });

  it('publishes edited footnote bodies and updates their rendering', async () => {
    const source = 'Plain\n\nA[^1]\n\n[^1]: old note\n\nTail';
    const { view, host } = await mount(source);
    view.dispatch({ selection: { anchor: source.indexOf('old note'), head: source.indexOf('old note') + 8 } });

    type(view, 'new note');
    await vi.advanceTimersByTimeAsync(900); // 防抖 300 + 静默窗 600

    expect(irPerfSnapshot().fullRebuildEvents.map(event => event.kind)).toEqual(['referencesReady']);
    expect(view.state.field(referenceField).footnotes.get('1')?.body).toBe('new note');
    expect(host.textContent).toContain('new note');
    expect(host.querySelector('.mdir-footnote-ref')?.textContent).toBe('1');
  });

  it('publishes image definition edits and resolves the new image target', async () => {
    const source = 'Plain\n\n![caption][ref]\n\n[ref]: https://images.test/old.png';
    const remoteImages = vi.fn(async () => 'data:image/png;base64,AA==');
    const { view, host } = await mount(source, { remoteImages });
    view.dispatch({ selection: { anchor: source.indexOf('old.png'), head: source.indexOf('old.png') + 7 } });

    type(view, 'new.png');
    await vi.advanceTimersByTimeAsync(900); // 防抖 300 + 静默窗 600

    expect(irPerfSnapshot().fullRebuildEvents.map(event => event.kind)).toEqual(['referencesReady']);
    expect(remoteImages).toHaveBeenLastCalledWith('https://images.test/new.png');
    expect(host.querySelector<HTMLImageElement>('.mdir-img')?.dataset.mdSrc).toBe('https://images.test/new.png');
  });

  it('patches cached minimap lines after a single character without full serialization', async () => {
    const { view, api } = await mount('Plain\n\nTail');
    expect(api.getLines()).toEqual(['Plain', '', 'Tail']);
    irPerfReset();

    type(view, 'x');

    expect(api.getLines()).toEqual(['xPlain', '', 'Tail']);
    expect(irPerfSnapshot().fullRebuildEvents.filter(event => event.kind === 'getLines')).toEqual([]);
  });

  describe.each([true, false])('minimap source lines with warm cache = %s', warm => {
    it.each([
      { name: 'Enter', source: 'alpha\nbeta\n', changes: { from: 2, insert: '\n' }, lines: ['al', 'pha', 'beta', ''] },
      { name: 'multiline paste', source: 'alpha\nbeta', changes: { from: 2, insert: 'X\nY\n' }, lines: ['alX', 'Y', 'pha', 'beta'] },
      { name: 'cross-line deletion', source: 'alpha\nbeta\ngamma', changes: { from: 4, to: 12 }, lines: ['alphamma'] },
      { name: 'newline deletion', source: 'alpha\nbeta\ngamma', changes: { from: 5, to: 6 }, lines: ['alphabeta', 'gamma'] },
      { name: 'whole document deletion', source: 'alpha\nbeta\n', changes: { from: 0, to: 11 }, lines: [''] },
      { name: 'empty document insertion', source: '', changes: { from: 0, insert: '\nX\n' }, lines: ['', 'X', ''] },
      { name: 'CRLF input normalization', source: 'alpha\r\nbeta\r\n', changes: { from: 2, insert: 'X\r\nY\rZ' }, lines: ['alX', 'Y', 'Zpha', 'beta', ''] },
      { name: 'CR input normalization', source: 'alpha\rbeta\r', changes: { from: 0, insert: 'x' }, lines: ['xalpha', 'beta', ''] },
      { name: 'overlapping line ranges and separated changes', source: 'abcdef\nmiddle\nlast\n',
        changes: [{ from: 1, to: 2, insert: 'X\nY' }, { from: 4, to: 5, insert: 'Z\nQ' }, { from: 15, insert: '!' }],
        lines: ['aX', 'YcdZ', 'Qf', 'middle', 'l!ast', ''] },
    ] satisfies { name: string; source: string; changes: ChangeSpec; lines: string[] }[])('$name', async ({ source, changes, lines }) => {
      const { view, api } = await mount(source);
      if (warm) api.getLines();
      irPerfReset();

      view.dispatch({ changes, userEvent: 'input' });

      expect(api.getLines()).toEqual(lines);
      expect(api.getLines()).toEqual(lines);
      expect(api.lineCount()).toBe(lines.length);
      expect(lines.map((_, index) => api.lineText(index + 1))).toEqual(lines);
      expect(irPerfSnapshot().fullRebuildEvents.filter(event => event.kind === 'getLines')).toHaveLength(warm ? 0 : 1);
    });
  });
});
