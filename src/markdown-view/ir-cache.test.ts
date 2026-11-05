import { beforeAll, describe, expect, it } from 'vitest';
import agentsDoc from '../../AGENTS.md?raw';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { liveBlockField, liveViewport, blockSliceReady, liveGeometryChanged } from './live-block-field';
import { emojiField, referenceField } from './live-state';
import { loadMarkdownIt } from './md';
import { irPerfReset, irPerfSnapshot, irWorkStart, recordIrWork } from './ir-perf';
import { clipWindows, missingWindows, decorationSliceEnd } from './deco-window';
import { BlockHeightCache, blockHeightCache } from './block-height-cache';
import { blockLayout } from './layout';

it('line alignment keeps a megabyte line bounded and makes progress to its end', () => {
  const doc=EditorState.create({doc:'intro\n'+ 'x'.repeat(1024*1024)+'\nend'}).doc;
  let from=0, slices=0;
  while(from<doc.length) {
    const to=decorationSliceEnd(doc,from,doc.length,256);
    expect(to).toBeGreaterThan(from);expect(to-from).toBeLessThanOrEqual(512);
    from=to;slices++;
  }
  expect(slices).toBeGreaterThan(2000);
});

it('scroll and settle slices preserve every nested list gap when a character boundary crosses indentation', () => {
  const positions = (layout: ReturnType<typeof blockLayout>) => {
    const out: unknown[] = [];
    for (let c=layout.iter();c.value;c.next()) out.push([c.from,c.to,c.value.spec.class,c.value.spec.attributes,
      (c.value.spec.widget as {height?:string}|undefined)?.height]);
    return out;
  };
  for (let pad=0;pad<32;pad++) {
    const doc='intro '+ 'x'.repeat(pad)+'\n\n'+Array.from({length:30},(_,i)=>
      `- parent ${i}\n    - nested a ${i}\n    - nested b ${i}\n    - nested c ${i}\n`).join('');
    let state=EditorState.create({doc,extensions:[markdown({base:markdownLanguage}),referenceField,emojiField,liveBlockField]});
    expect(ensureSyntaxTree(state,doc.length,5000)).not.toBeNull();
    // ensureSyntaxTree 推进在途解析；发布到下一状态后才能作为完整布局基线。
    state=state.update({}).state;
    const expected=positions(blockLayout(state,0,doc.length));
    state=state.update({effects:liveViewport.of({from:0,to:doc.length,scrolling:true})}).state;
    state=finishSlices(state);
    expect(positions(state.field(liveBlockField).layout),`scroll padding ${pad}`).toEqual(expected);
    state=state.update({effects:liveGeometryChanged.of(null)}).state;
    state=finishSlices(state);
    expect(positions(state.field(liveBlockField).layout),`settle padding ${pad}`).toEqual(expected);
  }
});

function finishSlices(state: EditorState): EditorState {
  for (let i = 0; state.field(liveBlockField).pending && i < 100; i++) {
    const pending = state.field(liveBlockField).pending!;
    expect(ensureSyntaxTree(state, pending.end, 5000)).not.toBeNull();
    state = state.update({ effects: blockSliceReady.of(pending.token) }).state;
  }
  expect(state.field(liveBlockField).pending).toBeUndefined();
  return state;
}

it('geometry refreshes leave dense small viewports in bounded slices and preserve existing tables', () => {
  const doc = 'intro\n\n' + Array.from({ length: 24 }, (_, i) =>
    `| head ${i} | b |\n| --- | --- |\n| value ${i} | c |\n\n`).join('');
  let state = EditorState.create({ doc, extensions: [
    markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField,
  ] });
  expect(ensureSyntaxTree(state, doc.length, 5000)).not.toBeNull();
  state = state.update({ effects: liveViewport.of({ from: 0, to: doc.length }) }).state;
  state = finishSlices(state);
  const original = state.field(liveBlockField), tables = [...original.tables];
  expect(tables).toHaveLength(24);
  state = state.update({ effects: liveGeometryChanged.of(null) }).state;
  state = state.update({ effects: blockSliceReady.of(state.field(liveBlockField).pending!.token) }).state;
  // 文档虽小，密集表格仍不能在首个几何刷新片里全部重建。
  expect(state.field(liveBlockField).pending).toBeDefined();
  expect(state.field(liveBlockField).set.size).toBe(original.set.size);
  for (const [from, table] of tables) expect(state.field(liveBlockField).tables.get(from)).toBe(table);
  state = finishSlices(state);
  expect(state.field(liveBlockField).set.size).toBe(original.set.size);
  expect(state.field(liveBlockField).layout.size).toBe(original.layout.size);
});

it('maps a tail viewport safely after replacing the document with shorter text', () => {
  let state = EditorState.create({ doc: 'paragraph\n\n'.repeat(1000), extensions: [
    markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField,
  ] });
  expect(ensureSyntaxTree(state, state.doc.length, 5000)).not.toBeNull();
  state = state.update({ effects: liveViewport.of({ from: 10000, to: state.doc.length }) }).state;
  state = finishSlices(state);
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: 'short\n\n- item' } }).state;
  state = state.update({ effects: liveGeometryChanged.of(null) }).state;
  state = finishSlices(state);
  expect(state.field(liveBlockField).from).toBeLessThanOrEqual(state.doc.length);
  expect(state.field(liveBlockField).to).toBeLessThanOrEqual(state.doc.length);
  expect(state.field(liveBlockField).layout.size).toBeGreaterThan(0);
});

it('height oracle supplies identical fractional placeholder and settled widget hints without parsing cells during scroll', () => {
  const doc = 'intro\n\n| a |\n| --- |\n| target |\n';
  const cache = new BlockHeightCache(); cache.layout('800');
  const from = doc.indexOf('|'), to = doc.lastIndexOf('|') + 1;
  cache.put(cache.identity('Table', doc.slice(from, to), 0, 0, from, to)!, 137.25);
  let state = EditorState.create({ doc, extensions: [blockHeightCache.of(cache), markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField] });
  state = state.update({ effects: liveViewport.of({ from: 0, to: doc.length, scrolling: true }) }).state;
  state = state.update({ effects: blockSliceReady.of(state.field(liveBlockField).pending!.token) }).state;
  expect(state.field(liveBlockField).tables.size).toBe(0);
  let widget = state.field(liveBlockField).set.iter().value!.spec.widget;
  expect(widget.constructor.name).toBe('BlockPlaceholder');
  expect(widget.estimatedHeight).toBe(137.25);
  state = state.update({ effects: liveGeometryChanged.of(null) }).state;
  expect(state.field(liveBlockField).pending?.budgeted).toBe(true);
  state = finishSlices(state);
  widget = state.field(liveBlockField).set.iter().value!.spec.widget;
  expect(widget.constructor.name).toBe('TableWidget');
  expect(widget.estimatedHeight).toBe(137.25);
});

beforeAll(() => loadMarkdownIt());

it('refreshing inside a huge fenced block does not duplicate its opening widget outside the slice', () => {
  const doc = '```text\n' + 'code line\n'.repeat(30000) + '```';
  let state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField] });
  expect(ensureSyntaxTree(state, doc.length, 5000)).not.toBeNull();
  state = state.update({ effects: liveViewport.of({ from: 0, to: 2000 }) }).state;
  state = finishSlices(state);
  state = state.update({ effects: liveViewport.of({ from: 20000, to: 23000, scrolling: true }) }).state;
  state = finishSlices(state);
  for (let i = 0; i < 3; i++) {
    state = state.update({ effects: liveGeometryChanged.of(null) }).state;
    state = finishSlices(state);
    let opening = 0;
    for (let c = state.field(liveBlockField).set.iter(); c.value; c.next()) if (c.value.spec.widget?.constructor.name === 'CodeLabelWidget') opening++;
    expect(opening).toBeLessThanOrEqual(1);
  }
});

it('repeated geometry slices replace existing decorations without multiplying block widgets or line layouts', () => {
  const doc = ('paragraph\n\n| a |\n| --- |\n| target |\n\n').repeat(160);
  let state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField] });
  expect(ensureSyntaxTree(state, doc.length, 5000)).not.toBeNull();
  state = state.update({ effects: liveViewport.of({ from: 0, to: doc.length }) }).state;
  state = finishSlices(state);
  const expected = state.field(liveBlockField);
  for (let i = 0; i < 3; i++) {
    state = state.update({ effects: liveGeometryChanged.of(null) }).state;
    state = finishSlices(state);
    const value = state.field(liveBlockField);
    expect(value.set.size).toBe(expected.set.size);
    expect(value.layout.size).toBe(expected.layout.size);
    const positions = new Set<number>();
    for (let c = value.set.iter(); c.value; c.next()) {
      expect(positions.has(c.from)).toBe(false); positions.add(c.from);
    }
  }
});

it('non-scroll geometry refresh budgets a large viewport and completes with the same table height', () => {
  const doc = 'intro\n\n| a |\n| --- |\n| target |\n\n' + 'paragraph\n\n'.repeat(30000);
  let state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField] });
  state = state.update({ effects: liveViewport.of({ from: 0, to: 4000, scrolling: true }) }).state;
  state = state.update({ effects: blockSliceReady.of(state.field(liveBlockField).pending!.token) }).state;
  state = state.update({ effects: liveGeometryChanged.of(null) }).state;
  expect(state.field(liveBlockField).pending?.budgeted).toBe(true);
  state = finishSlices(state);
  const value = state.field(liveBlockField);
  expect(value.deferred).toBe(false);
  expect(value.pending).toBeUndefined();
  const widgets: string[] = [];
  for (let c = value.set.iter(); c.value; c.next()) if (c.value.spec.widget) widgets.push(c.value.spec.widget.constructor.name);
  expect(widgets).toContain('TableWidget');
  expect(widgets).not.toContain('BlockPlaceholder');
});

it('fast scrolling defers table construction, then replaces estimated placeholders after settling', () => {
  const global = globalThis as typeof globalThis & { __ZIEDIT_IR_PERF__?: boolean };
  const previous = global.__ZIEDIT_IR_PERF__;
  try {
    global.__ZIEDIT_IR_PERF__ = true;
    let state = EditorState.create({ doc: 'intro\n\n| a |\n| --- |\n| target |\n', extensions: [markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField] });
    irPerfReset();
    state = state.update({ effects: liveViewport.of({ from: 0, to: state.doc.length, scrolling: true }) }).state;
    expect(irPerfSnapshot().counters.blockDecos.count).toBe(0);
    expect(irPerfSnapshot().counters.blockLayout.count).toBe(0);
    state = state.update({ effects: blockSliceReady.of(state.field(liveBlockField).pending!.token) }).state;
    const widgets = (value: typeof state) => {
      const names: string[] = [];
      for (let c = value.field(liveBlockField).set.iter(); c.value; c.next()) if (c.value.spec.widget) names.push(c.value.spec.widget.constructor.name);
      return names;
    };
    expect(widgets(state)).toContain('BlockPlaceholder');
    state = state.update({ effects: liveViewport.of({ from: 0, to: state.doc.length, scrolling: false }) }).state;
    expect(widgets(state)).toContain('TableWidget');
    expect(widgets(state)).not.toContain('BlockPlaceholder');
  } finally { global.__ZIEDIT_IR_PERF__ = previous; irPerfReset(); }
});

it('retains completed slices across scroll interruptions and only plans missing edges', () => {
  const covered = clipWindows({ from: 100, to: 900 }, [{ from: 0, to: 300 }, { from: 300, to: 500 }]);
  expect(covered).toEqual([{ from: 100, to: 500 }]);
  expect(missingWindows({ from: 100, to: 900 }, covered)).toEqual([{ from: 500, to: 900 }]);
  expect(missingWindows({ from: 50, to: 950 }, covered)).toEqual([{ from: 50, to: 100 }, { from: 500, to: 950 }]);
  expect(missingWindows({ from: 200, to: 400 }, covered)).toEqual([]);
});

it('rebuilds only the newly exposed block/layout edge on an overlapping viewport effect', () => {
  const global = globalThis as typeof globalThis & { __ZIEDIT_IR_PERF__?: boolean };
  const previous = global.__ZIEDIT_IR_PERF__;
  try {
    global.__ZIEDIT_IR_PERF__ = true;
    let state = EditorState.create({ doc: 'paragraph\n\n'.repeat(200), extensions: [markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField] });
    // 裸状态没有视图解析工作器；显式推进，避免依赖事务内的墙钟预算。
    expect(ensureSyntaxTree(state, 900, 5000)).not.toBeNull();
    state = state.update({ effects: liveViewport.of({ from: 0, to: 500 }) }).state;
    irPerfReset();
    state = state.update({ effects: liveViewport.of({ from: 100, to: 600 }) }).state;
    const edge = { from: state.doc.lineAt(800).to, to: state.doc.lineAt(900).to };
    expect(irPerfSnapshot().counters.blockDecos).toEqual({ count: 1, lastWindow: edge });
    expect(irPerfSnapshot().counters.blockLayout).toEqual({ count: 1, lastWindow: edge });
    irPerfReset();
    state.update({ effects: liveViewport.of({ from: 110, to: 590 }) });
    expect(irPerfSnapshot().counters.blockDecos.count).toBe(0);
    expect(irPerfSnapshot().counters.blockLayout.count).toBe(0);
  } finally { global.__ZIEDIT_IR_PERF__ = previous; irPerfReset(); }
});

it('retains existing block widgets while starting a deferred viewport slice', () => {
  const doc = agentsDoc;
  let state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField] });
  state = state.update({ effects: liveViewport.of({ from: 0, to: 1483, scrolling: false }) }).state;
  state = state.update({ effects: liveGeometryChanged.of(null) }).state;
  expect(state.field(liveBlockField).pending?.budgeted).toBe(true);
  state = finishSlices(state);
  expect(state.field(liveBlockField).set.size).toBeGreaterThan(0);
  expect(state.field(liveBlockField).pending).toBeUndefined();
  state = state.update({ effects: liveViewport.of({ from: 0, to: 1483, scrolling: true }) }).state;
  expect(state.field(liveBlockField).deferred).toBe(true);
  expect(state.field(liveBlockField).pending).toBeDefined();
  expect(state.field(liveBlockField).set.size).toBeGreaterThan(0);
  state = state.update({ effects: blockSliceReady.of(state.field(liveBlockField).pending!.token) }).state;
  expect(state.field(liveBlockField).set.size).toBeGreaterThan(0);
  const widgets: string[] = [];
  for (let c = state.field(liveBlockField).set.iter(); c.value; c.next()) if (c.value.spec.widget) widgets.push(c.value.spec.widget.constructor.name);
  expect(widgets).toContain('TableWidget');
});

it('continues a partially built large-document block window instead of restarting its prefix', () => {
  let state = EditorState.create({ doc: 'paragraph\n\n'.repeat(30000), extensions: [markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField] });
  expect(ensureSyntaxTree(state, 4400, 5000)).not.toBeNull();
  state = state.update({ effects: liveViewport.of({ from: 0, to: 4000 }) }).state;
  const pending = state.field(liveBlockField).pending!;
  expect(pending.next).toBe(state.doc.lineAt(2048).to);
  state = state.update({ effects: liveViewport.of({ from: 100, to: 4100 }) }).state;
  expect(state.field(liveBlockField).pending).toEqual({ ...pending, end: state.doc.lineAt(4400).to });
});

describe('IR table cache mapping', () => {
  function fixture() {
    const doc = 'intro\n\n| a |\n| - |\n| b |\n\nafter';
    const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField] });
    const from = doc.indexOf('|'), to = doc.lastIndexOf('|') + 1;
    const data = { header: ['a'], align: ['left' as const], rows: [['b']], to };
    state.field(liveBlockField).tables.set(from, data);
    return { state, from, to, data };
  }
  it('maps untouched tables without copying cell arrays', () => {
    const { state, from, to, data } = fixture();
    const next = state.update({ changes: { from: 0, insert: 'x' } }).state;
    const mapped = next.field(liveBlockField).tables.get(from + 1)!;
    expect(mapped.to).toBe(to + 1);
    expect(mapped.rows).toBe(data.rows);
    expect(mapped.header).toBe(data.header);
    expect(next.update({ changes: { from: next.doc.length, insert: '!' } }).state.field(liveBlockField).tables.get(from + 1)).toBe(mapped);
  });
  it('invalidates a touched table, including insertion at its boundary', () => {
    for (const boundary of [false, true]) {
      const { state, from, to, data } = fixture();
      const next = state.update({ changes: { from: boundary ? to : from + 2, insert: 'x' } }).state;
      // 界内解析可能已经重建；不可复用的是旧数据，而不是禁止合法的新缓存。
      expect(next.field(liveBlockField).tables.get(from)?.rows).not.toBe(data.rows);
    }
  });
});

it('records bounded opt-in work timings and resets them', () => {
  const global = globalThis as typeof globalThis & { __ZIEDIT_IR_PERF__?: boolean };
  const previous = global.__ZIEDIT_IR_PERF__;
  try {
    global.__ZIEDIT_IR_PERF__ = false; irPerfReset();
    recordIrWork('references', irWorkStart());
    expect(irPerfSnapshot().workSamples).toBeUndefined();
    global.__ZIEDIT_IR_PERF__ = true;
    for (let i = 0; i < 2100; i++) recordIrWork('references', irWorkStart());
    expect(irPerfSnapshot().workSamples).toHaveLength(2000);
    expect(irPerfSnapshot().workSamples!.every(sample => sample.ms >= 0)).toBe(true);
    irPerfReset();
    expect(irPerfSnapshot().workSamples).toEqual([]);
  } finally { global.__ZIEDIT_IR_PERF__ = previous; irPerfReset(); }
});
