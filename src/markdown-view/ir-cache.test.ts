import { beforeAll, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { liveBlockField, liveViewport, blockSliceReady, liveGeometryChanged } from './live-block-field';
import { emojiField, referenceField } from './live-state';
import { loadMarkdownIt } from './md';
import { irPerfReset, irPerfSnapshot, irWorkStart, recordIrWork } from './ir-perf';
import { clipWindows, missingWindows } from './deco-window';

beforeAll(() => loadMarkdownIt());

it('non-scroll geometry refresh completes a large viewport without placeholder or pending slices', () => {
  const doc = 'intro\n\n| a |\n| --- |\n| target |\n\n' + 'paragraph\n\n'.repeat(30000);
  let state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField] });
  state = state.update({ effects: liveViewport.of({ from: 0, to: 4000, scrolling: true }) }).state;
  state = state.update({ effects: blockSliceReady.of(state.field(liveBlockField).pending!.token) }).state;
  state = state.update({ effects: liveGeometryChanged.of(null) }).state;
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
    expect(irPerfSnapshot().counters.blockDecos).toEqual({ count: 1, lastWindow: { from: 800, to: 900 } });
    expect(irPerfSnapshot().counters.blockLayout).toEqual({ count: 1, lastWindow: { from: 800, to: 900 } });
    irPerfReset();
    state.update({ effects: liveViewport.of({ from: 110, to: 590 }) });
    expect(irPerfSnapshot().counters.blockDecos.count).toBe(0);
    expect(irPerfSnapshot().counters.blockLayout.count).toBe(0);
  } finally { global.__ZIEDIT_IR_PERF__ = previous; irPerfReset(); }
});

it('continues a partially built large-document block window instead of restarting its prefix', () => {
  let state = EditorState.create({ doc: 'paragraph\n\n'.repeat(30000), extensions: [markdown({ base: markdownLanguage }), referenceField, emojiField, liveBlockField] });
  expect(ensureSyntaxTree(state, 4400, 5000)).not.toBeNull();
  state = state.update({ effects: liveViewport.of({ from: 0, to: 4000 }) }).state;
  const pending = state.field(liveBlockField).pending!;
  expect(pending.next).toBe(2048);
  state = state.update({ effects: liveViewport.of({ from: 100, to: 4100 }) }).state;
  expect(state.field(liveBlockField).pending).toEqual({ ...pending, end: 4400 });
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
