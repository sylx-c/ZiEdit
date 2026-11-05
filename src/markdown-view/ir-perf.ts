import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

export interface IrPerfSegment {
  readonly t0: number;
  readonly t1: number;
  readonly t2: number;
  readonly t3: number;
  readonly docChanged: boolean;
  readonly length: number;
}
type RebuildWindow = { readonly from: number; readonly to: number };
type RebuildCounter = { count: number; lastWindow: RebuildWindow | null };
type FullRebuildKind = 'referencesReady' | 'getLines';
type FullRebuildEvent = { readonly kind: FullRebuildKind; readonly time: number };

const CAPACITY = 2000;
class RingBuffer<Value> {
  private values: Value[] = [];
  private next = 0;
  push(value: Value): void {
    this.values[this.next] = value;
    this.next = (this.next + 1) % CAPACITY;
  }
  snapshot(): Value[] {
    return this.values.length < CAPACITY ? this.values.slice() : this.values.slice(this.next).concat(this.values.slice(0, this.next));
  }
  reset(): void { this.values = []; this.next = 0; }
}

const segments = new RingBuffer<IrPerfSegment>();
const fullRebuildEvents = new RingBuffer<FullRebuildEvent>();
type WorkKind = 'references' | 'blockField' | 'blockLayout' | 'blockDecos' | 'liveDeco';
const workSamples = new RingBuffer<{ kind: WorkKind; ms: number }>();
/** 与粗粒度事务阶段并列，避免把 CM6 解析/高亮成本误归因给引用或装饰。 */
export function recordIrWork(kind: WorkKind, start: number): void {
  if (start < 0) return;
  workSamples.push({ kind, ms: performance.now() - start });
}
export function irWorkStart(): number { return irPerfEnabled() ? performance.now() : -1; }
const counters: Record<'liveDeco' | 'blockDecos' | 'blockLayout', RebuildCounter> = {
  liveDeco: { count: 0, lastWindow: null },
  blockDecos: { count: 0, lastWindow: null },
  blockLayout: { count: 0, lastWindow: null },
};
let starts = new WeakMap<EditorState, number>();
let phases = new WeakMap<ViewUpdate, { t1: number; t2: number }>();

export function irPerfEnabled(): boolean {
  return (globalThis as { __ZIEDIT_IR_PERF__?: boolean }).__ZIEDIT_IR_PERF__ === true;
}

function exposeSnapshot(): void {
  if (!Object.prototype.hasOwnProperty.call(globalThis, '__ZIEDIT_IR_PERF_DATA__'))
    Object.defineProperty(globalThis, '__ZIEDIT_IR_PERF_DATA__', { configurable: true, get: irPerfSnapshot });
}

function recordWindow(counter: RebuildCounter, from: number, to: number): void {
  if (!irPerfEnabled()) return;
  exposeSnapshot();
  counter.count++;
  counter.lastWindow = { from, to };
}
export function recordLiveDeco(from: number, to: number): void { recordWindow(counters.liveDeco, from, to); }
export function recordBlockDecos(from: number, to: number): void { recordWindow(counters.blockDecos, from, to); }
export function recordBlockLayout(from: number, to: number): void { recordWindow(counters.blockLayout, from, to); }
export function recordFullRebuild(kind: FullRebuildKind): void {
  if (!irPerfEnabled()) return;
  exposeSnapshot();
  fullRebuildEvents.push({ kind, time: performance.now() });
}

export function irPerfSnapshot() {
  if (irPerfEnabled()) exposeSnapshot();
  const samples = segments.snapshot().map(segment => ({ ...segment }));
  const durations = samples.filter(segment => segment.docChanged).map(segment => segment.t3 - segment.t0).sort((a, b) => a - b);
  const percentile = (fraction: number): number => durations[Math.ceil(durations.length * fraction) - 1] ?? 0;
  const counterSnapshot = (counter: RebuildCounter) => ({ count: counter.count, lastWindow: counter.lastWindow && { ...counter.lastWindow } });
  const work = workSamples.snapshot();
  return {
    segments: samples,
    summary: { count: durations.length, p50: percentile(0.5), p95: percentile(0.95), max: durations[durations.length - 1] ?? 0 },
    counters: { liveDeco: counterSnapshot(counters.liveDeco), blockDecos: counterSnapshot(counters.blockDecos), blockLayout: counterSnapshot(counters.blockLayout) },
    fullRebuildEvents: fullRebuildEvents.snapshot().map(event => ({ ...event })),
    ...(irPerfEnabled() || work.length ? { workSamples: work.map(sample => ({ ...sample })) } : {}),
  };
}

export function irPerfReset(): void {
  segments.reset(); fullRebuildEvents.reset(); workSamples.reset();
  for (const counter of Object.values(counters)) { counter.count = 0; counter.lastWindow = null; }
  starts = new WeakMap(); phases = new WeakMap();
}

const transactionStart = Prec.lowest(EditorState.transactionFilter.of(tr => {
  if (irPerfEnabled()) {
    starts.set(tr.startState, performance.now());
    exposeSnapshot();
  }
  return tr;
}));
const stateFieldsDone = Prec.highest(ViewPlugin.define(() => ({
  update(update: ViewUpdate): void {
    if (!irPerfEnabled() || !update.transactions.length) return;
    const t1 = performance.now();
    phases.set(update, { t1, t2: t1 });
  },
})));
const decorationsDone = Prec.lowest(ViewPlugin.define(() => ({
  update(update: ViewUpdate): void {
    if (!irPerfEnabled()) return;
    const phase = phases.get(update);
    if (phase) phase.t2 = performance.now();
  },
})));
const domCommitted = Prec.highest(EditorView.updateListener.of(update => {
  if (!irPerfEnabled()) return;
  const phase = phases.get(update);
  if (!phase) return;
  const t3 = performance.now();
  for (const tr of update.transactions) {
    const t0 = starts.get(tr.startState);
    if (t0 === undefined) continue;
    segments.push({ t0, ...phase, t3, docChanged: tr.docChanged, length: tr.newDoc.length });
    starts.delete(tr.startState);
  }
  phases.delete(update);
}));

export function irPerfProbe(): Extension {
  if (irPerfEnabled()) exposeSnapshot();
  return [transactionStart, stateFieldsDone, decorationsDone, domCommitted];
}
