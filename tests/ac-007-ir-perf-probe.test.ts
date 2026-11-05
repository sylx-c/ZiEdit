// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { LivePreviewView, type LivePreviewOpts } from '../src/markdown-view/livepreview';
import { irPerfEnabled, irPerfProbe, irPerfReset, irPerfSnapshot, recordLiveDeco, recordBlockDecos, recordBlockLayout, recordFullRebuild } from '../src/markdown-view/ir-perf';

vi.mock('../src/common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textReadAll: async () => '', textSave: async () => ({ len: 0 }) }));
vi.mock('../src/markdown-view/preview', async original => ({ ...await original<object>(), loadUnicodeEmojis: async () => ({}) }));
Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
Range.prototype.getBoundingClientRect = () => new DOMRect();
const mounted: EditorView[] = [];
const previews: LivePreviewView[] = [];
afterEach(() => {
  for (const preview of previews.splice(0)) preview.destroy();
  for (const view of mounted.splice(0)) view.destroy();
  document.body.replaceChildren();
  irPerfReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, '__ZIEDIT_IR_PERF_DATA__');
});

async function mount(source: string, onReady?: LivePreviewOpts['onReady']): Promise<LivePreviewView> {
  const host = document.createElement('div'); document.body.append(host);
  const preview = new LivePreviewView(host, { path: 'E:/perf.md', encoding: 'UTF-8', initialDoc: source, onStatus: () => {}, onSaved: () => {}, onReady });
  previews.push(preview);
  await vi.waitFor(() => expect(preview.view).toBeDefined());
  await Promise.resolve();
  irPerfReset();
  return preview;
}

function type(view: EditorView, text: string): void {
  for (const char of text) {
    const range = view.state.selection.main;
    if (!view.state.facet(EditorView.inputHandler).some(handle => handle(view, range.from, range.to, char, () => view.state.update(view.state.replaceSelection(char)))))
      view.dispatch({ ...view.state.replaceSelection(char), userEvent: 'input.type' });
  }
}

describe('007 AC-36 IR performance probe', () => {
  it('does not sample the clock or record when disabled by default', () => {
    const view = new EditorView({ doc: 'plain', extensions: [irPerfProbe()] });
    mounted.push(view);
    const clock = vi.spyOn(performance, 'now');
    expect(irPerfEnabled()).toBe(false);

    type(view, 'x');
    recordLiveDeco(0, 6); recordBlockDecos(0, 6); recordBlockLayout(0, 6);
    recordFullRebuild('getLines'); recordFullRebuild('referencesReady');

    expect(irPerfSnapshot()).toEqual({
      segments: [], summary: { count: 0, p50: 0, p95: 0, max: 0 },
      counters: {
        liveDeco: { count: 0, lastWindow: null }, blockDecos: { count: 0, lastWindow: null }, blockLayout: { count: 0, lastWindow: null },
      },
      fullRebuildEvents: [],
    });
    expect(Reflect.has(globalThis, '__ZIEDIT_IR_PERF_DATA__')).toBe(false);
    clock.mockClear();
    recordLiveDeco(0, 6); recordBlockDecos(0, 6); recordBlockLayout(0, 6); recordFullRebuild('getLines');
    expect(clock).not.toHaveBeenCalled();
  });

  it('records ordered transaction segments and rebuild counters for a typed character', async () => {
    vi.stubGlobal('__ZIEDIT_IR_PERF__', true);
    const preview = await mount('plain');

    type(preview.view, 'x');

    const snapshot = irPerfSnapshot();
    expect(snapshot.segments).toHaveLength(1);
    const [segment] = snapshot.segments;
    expect(segment.docChanged).toBe(true);
    expect(segment.length).toBe(6);
    expect(segment.t0).toBeLessThanOrEqual(segment.t1);
    expect(segment.t1).toBeLessThanOrEqual(segment.t2);
    expect(segment.t2).toBeLessThanOrEqual(segment.t3);
    expect(snapshot.summary.count).toBe(1);
    expect(snapshot.counters.liveDeco.count).toBe(1);
    expect(snapshot.counters.blockLayout.count).toBe(1);
    expect(snapshot.counters.blockDecos.count).toBe(1);
    expect(preview.view.contentDOM.textContent).toBe('xplain');
    expect(Reflect.get(globalThis, '__ZIEDIT_IR_PERF_DATA__')).toEqual(snapshot);
    expect(Object.getOwnPropertyDescriptor(globalThis, '__ZIEDIT_IR_PERF_DATA__')?.get).toBeTypeOf('function');
  });

  it('brackets state fields, decoration plugins and DOM commit before application listeners', () => {
    vi.stubGlobal('__ZIEDIT_IR_PERF__', true);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const view = new EditorView({ doc: 'plain', extensions: [
      StateField.define({ create: () => 0, update: () => { now = 10; return 1; } }),
      ViewPlugin.define(() => ({ update: () => { now = 20; } })),
      EditorView.updateListener.of(() => { now = 30; }),
      irPerfProbe(),
    ] });
    mounted.push(view);

    type(view, 'x');

    expect(irPerfSnapshot().segments).toEqual([{ t0: 0, t1: 10, t2: 20, t3: 20, docChanged: true, length: 6 }]);
    expect(view.contentDOM.textContent).toBe('xplain');
  });

  it('records only the viewport plus 300 characters for typing in a large document', async () => {
    vi.stubGlobal('__ZIEDIT_IR_PERF__', true);
    const preview = await mount('ordinary paragraph\n\n'.repeat(8000));
    const view = preview.view;

    type(view, 'x');

    expect(irPerfSnapshot().counters.liveDeco).toEqual({ count: 1, lastWindow: {
      from: Math.max(0, view.viewport.from - 300), to: Math.min(view.state.doc.length, view.viewport.to + 300),
    } });
    expect(irPerfSnapshot().counters.liveDeco.lastWindow?.to).toBeLessThan(view.state.doc.length);
  });

  // v0.40 规则 27 机制锁：纯选区移动走差集重建——块内移动 blockDecos 计数不增；
  // 空光标进出表格装饰不变（计数 0，selected/active 均不翻转 tableDecos）。
  it('does not recount blockDecos for selection moves inside a block (v0.40 differential)', async () => {
    vi.stubGlobal('__ZIEDIT_IR_PERF__', true);
    const preview = await mount('# 题\n\n甲段第一行\n甲段第二行\n\n尾段\n');
    const view = preview.view;
    const start = preview.view.state.doc.toString().indexOf('甲段第二行');
    view.dispatch({ selection: { anchor: start }, userEvent: 'select.pointer' });
    await vi.waitFor(() => expect(view.contentDOM.textContent).toContain('甲段第二行'));
    irPerfReset();

    view.dispatch({ selection: { anchor: start + 1 }, userEvent: 'select.pointer' });
    await vi.waitFor(() => expect(view.state.selection.main.head).toBe(start + 1));

    expect(irPerfSnapshot().counters.blockDecos.count).toBe(0);
  });

  it('keeps blockDecos silent on empty-caret table entry/exit (v0.40 flip-set exclusion)', async () => {
    vi.stubGlobal('__ZIEDIT_IR_PERF__', true);
    const table = '| 甲 | 乙 |\n| -- | -- |\n| 1 | 2 |\n';
    const source = `${table}\n尾段\n`;
    const preview = await mount(source);
    const view = preview.view;
    const tail = source.indexOf('尾段');
    view.dispatch({ selection: { anchor: tail }, userEvent: 'select.pointer' });
    await vi.waitFor(() => expect(view.contentDOM.textContent).toContain('尾段'));
    irPerfReset();

    view.dispatch({ selection: { anchor: source.indexOf('1') }, userEvent: 'select.pointer' });
    await vi.waitFor(() => expect(view.state.selection.main.head).toBe(source.indexOf('1')));
    view.dispatch({ selection: { anchor: tail }, userEvent: 'select.pointer' });
    await vi.waitFor(() => expect(view.state.selection.main.head).toBe(tail));

    expect(view.dom.querySelector('table.mdir-table')).not.toBeNull();
    expect(irPerfSnapshot().counters.blockDecos.count).toBe(0);
  });

  it('bounds blockDecos recount to the flipped block range on display-block entry/exit (v0.40)', async () => {
    vi.stubGlobal('__ZIEDIT_IR_PERF__', true);
    const math = '$$\nx+y\n$$';
    const source = `${math}\n\n尾段\n`;
    const preview = await mount(source);
    const view = preview.view;
    const tail = source.indexOf('尾段');
    view.dispatch({ selection: { anchor: tail }, userEvent: 'select.pointer' });
    await vi.waitFor(() => expect(view.contentDOM.textContent).toContain('尾段'));
    irPerfReset();

    view.dispatch({ selection: { anchor: source.indexOf('x+y') }, userEvent: 'select.pointer' });
    await vi.waitFor(() => expect(view.contentDOM.textContent).toContain('$$'));

    const counter = irPerfSnapshot().counters.blockDecos;
    expect(counter.count).toBe(1);
    expect(counter.lastWindow).not.toBeNull();
    expect(counter.lastWindow!.to - counter.lastWindow!.from).toBeLessThan(view.state.doc.length);
    expect(counter.lastWindow!.from).toBeLessThanOrEqual(0);
    expect(counter.lastWindow!.to).toBeGreaterThanOrEqual(math.length);
  });

  it('summarizes only document changes and returns detached snapshots', () => {
    vi.stubGlobal('__ZIEDIT_IR_PERF__', true);
    let now = 0, duration = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const view = new EditorView({ doc: '', extensions: [irPerfProbe(), ViewPlugin.define(() => ({ update: () => { now += duration; } }))] });
    mounted.push(view);

    for (const sample of [2, 8, 4, 16]) { duration = sample; type(view, 'x'); }
    view.dispatch({ selection: { anchor: 0 } });
    recordLiveDeco(2, 4); recordBlockDecos(1, 4); recordBlockLayout(0, 4);
    recordFullRebuild('referencesReady'); recordFullRebuild('getLines');

    const snapshot = irPerfSnapshot();
    expect(snapshot.segments).toHaveLength(5);
    expect(snapshot.summary).toEqual({ count: 4, p50: 4, p95: 16, max: 16 });
    expect(snapshot.fullRebuildEvents.map(event => event.kind)).toEqual(['referencesReady', 'getLines']);
    snapshot.segments[0].length = -1;
    snapshot.counters.liveDeco.count = -1;
    Object.assign(snapshot.counters.liveDeco.lastWindow ?? {}, { from: -1 });
    snapshot.fullRebuildEvents[0].time = -1;
    expect(irPerfSnapshot().segments[0].length).toBe(1);
    expect(irPerfSnapshot().counters.liveDeco).toEqual({ count: 1, lastWindow: { from: 2, to: 4 } });
    expect(irPerfSnapshot().fullRebuildEvents[0].time).toBeGreaterThanOrEqual(0);
  });

  it('resets segments, counters, events and pending transaction timings', () => {
    vi.stubGlobal('__ZIEDIT_IR_PERF__', true);
    const view = new EditorView({ doc: 'plain', extensions: [irPerfProbe()] });
    mounted.push(view);
    type(view, 'x'); recordLiveDeco(0, 6); recordFullRebuild('getLines');
    const pending = view.state.update({ changes: { from: 0, insert: 'y' } });

    irPerfReset(); view.dispatch(pending);

    expect(irPerfSnapshot().segments).toEqual([]);
    expect(irPerfSnapshot().summary).toEqual({ count: 0, p50: 0, p95: 0, max: 0 });
    expect(irPerfSnapshot().fullRebuildEvents).toEqual([]);
    expect(Object.values(irPerfSnapshot().counters).every(counter => counter.count === 0 && counter.lastWindow === null)).toBe(true);
    type(view, 'z');
    expect(irPerfSnapshot().segments).toHaveLength(1);
    expect(Reflect.get(globalThis, '__ZIEDIT_IR_PERF_DATA__')).toEqual(irPerfSnapshot());
  });

  it('keeps the latest 2000 segments and full rebuild events in chronological order', () => {
    vi.stubGlobal('__ZIEDIT_IR_PERF__', true);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const view = new EditorView({ state: EditorState.create({ doc: 'xy', extensions: [irPerfProbe()] }) });
    mounted.push(view);

    for (let index = 0; index < 2005; index++) {
      now = index * 10;
      view.dispatch({ selection: { anchor: (index + 1) % 2 } });
      recordFullRebuild('getLines');
    }

    const snapshot = irPerfSnapshot();
    expect(snapshot.segments).toHaveLength(2000);
    expect(snapshot.fullRebuildEvents).toHaveLength(2000);
    expect(snapshot.segments[0].t0).toBe(50);
    expect(snapshot.segments[1999].t0).toBe(20040);
    expect(snapshot.fullRebuildEvents[0].time).toBe(50);
    expect(snapshot.fullRebuildEvents[1999].time).toBe(20040);
    expect(snapshot.summary.count).toBe(0);
  });

  it('can be enabled and disabled on an already mounted IR view', async () => {
    const preview = await mount('plain');
    vi.stubGlobal('__ZIEDIT_IR_PERF__', true);
    type(preview.view, 'x');
    const snapshot = irPerfSnapshot();

    vi.stubGlobal('__ZIEDIT_IR_PERF__', false);
    type(preview.view, 'y'); recordFullRebuild('getLines');

    expect(irPerfSnapshot()).toEqual(snapshot);
    expect(preview.view.state.doc.toString()).toBe('xyplain');
  });

  it('times the resulting transaction when typing filters insert formatting markers', async () => {
    vi.stubGlobal('__ZIEDIT_IR_PERF__', true);
    const preview = await mount('');
    preview.runFormat('bold'); irPerfReset();

    type(preview.view, 'x');

    expect(preview.view.state.doc.toString()).toBe('**x**');
    expect(irPerfSnapshot().segments).toHaveLength(1);
    expect(irPerfSnapshot().segments[0].length).toBe(5);
  });

  it('records the cold serialization and reuses patched lines without redundant reference rebuilds', async () => {
    vi.stubGlobal('__ZIEDIT_IR_PERF__', true);
    const ready = vi.fn<NonNullable<LivePreviewOpts['onReady']>>();
    const preview = await mount('plain', ready);
    const api = ready.mock.calls[0][0];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    expect(api.getLines()).toEqual(['plain']);
    api.getLines();
    type(preview.view, 'x');
    expect(api.getLines()).toEqual(['xplain']);

    expect(irPerfSnapshot().fullRebuildEvents.filter(event => event.kind === 'getLines')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(irPerfSnapshot().fullRebuildEvents.filter(event => event.kind === 'referencesReady')).toHaveLength(0);
  });
});
