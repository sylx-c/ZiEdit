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
type WorkKind = 'references' | 'blockField' | 'blockDecos' | 'liveDeco';
const workSamples = new RingBuffer<{ kind: WorkKind; ms: number }>();
/** 与粗粒度事务阶段并列，避免把 CM6 解析/高亮成本误归因给引用或装饰。 */
export function recordIrWork(kind: WorkKind, start: number): void {
  if (start < 0) return;
  workSamples.push({ kind, ms: performance.now() - start });
}
export function irWorkStart(): number { return irPerfEnabled() ? performance.now() : -1; }
// REQ-014 P6：blockLayout 计数器随 JS 间距模型（P3）退役删除；liveDeco/blockDecos
// 保留（AC-36 门禁与探针测试读取）。
const counters: Record<'liveDeco' | 'blockDecos', RebuildCounter> = {
  liveDeco: { count: 0, lastWindow: null },
  blockDecos: { count: 0, lastWindow: null },
};
// —— REQ-014 P0 计数探针（语义见 specs/001-markdown-ir-rewrite）——
// typingRebuildMs：input.type 文档变更事务的 t0→t3 总耗时（事务起点到 DOM 提交）；
// cursorWidthChange：同一行内纯选区移动导致该行渲染内容宽度变化的次数（>0.5px 视为变化）；
// scrollReplaceCount：纯滚动（无文档/选区变更）期间，先前已挂载且源码位置仍在视口 ±300 内的
//   异步块根（.md-render-target / .mdir-tablebox / img）被卸载替换的次数；
// decoRebuild：recordWindow 调用口径的装饰重建窗口统计（calls / lastFrom / lastTo / maxSpan）。
const typingSamples = new RingBuffer<number>();
let cursorWidthChanges = 0;
let scrollReplacements = 0;
const decoRangeStats = { calls: 0, lastFrom: null as number | null, lastTo: null as number | null, maxSpan: 0 };
type WidthBaseline = { width: number; line: number };
const widthBaselines = new WeakMap<EditorView, WidthBaseline | null>();
const asyncRoots = new WeakMap<EditorView, Map<Element, number>>();
const req014HasData = (): boolean =>
  typingSamples.snapshot().length > 0 || cursorWidthChanges > 0 || scrollReplacements > 0 || decoRangeStats.calls > 0;
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
  decoRangeStats.calls++;
  decoRangeStats.lastFrom = from;
  decoRangeStats.lastTo = to;
  decoRangeStats.maxSpan = Math.max(decoRangeStats.maxSpan, to - from);
}
export function recordLiveDeco(from: number, to: number): void { recordWindow(counters.liveDeco, from, to); }
export function recordBlockDecos(from: number, to: number): void { recordWindow(counters.blockDecos, from, to); }
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
    counters: { liveDeco: counterSnapshot(counters.liveDeco), blockDecos: counterSnapshot(counters.blockDecos) },
    fullRebuildEvents: fullRebuildEvents.snapshot().map(event => ({ ...event })),
    ...(irPerfEnabled() || work.length ? { workSamples: work.map(sample => ({ ...sample })) } : {}),
    ...(irPerfEnabled() || req014HasData() ? {
      req014: {
        typingRebuildMs: (() => {
          const sorted = typingSamples.snapshot().slice().sort((a, b) => a - b);
          return {
            count: sorted.length,
            p50: percentileOf(sorted, 0.5), p95: percentileOf(sorted, 0.95), max: sorted[sorted.length - 1] ?? 0,
          };
        })(),
        cursorWidthChange: cursorWidthChanges,
        scrollReplaceCount: scrollReplacements,
        decoRebuild: { ...decoRangeStats },
      },
    } : {}),
  };
}

function percentileOf(sorted: readonly number[], fraction: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : 0;
}

export function irPerfReset(): void {
  segments.reset(); fullRebuildEvents.reset(); workSamples.reset(); typingSamples.reset();
  cursorWidthChanges = 0; scrollReplacements = 0;
  decoRangeStats.calls = 0; decoRangeStats.lastFrom = null; decoRangeStats.lastTo = null; decoRangeStats.maxSpan = 0;
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
    if (tr.docChanged && tr.isUserEvent('input.type')) typingSamples.push(t3 - t0);
    starts.delete(tr.startState);
  }
  phases.delete(update);
}));

// REQ-014 P0：行宽稳定性与纯滚动替换探针。探针只读 DOM 状态、全程 try 守护，
// 不承担正确性职责；jsdom 下 Range/几何为桩值，测量自然归零（不影响单测口径）。
const req014GeometryProbe = EditorView.updateListener.of(update => {
  if (!irPerfEnabled()) return;
  const view = update.view;
  if (update.docChanged) {
    widthBaselines.set(view, null);
  } else if (update.selectionSet) {
    try {
      const head = update.state.selection.main.head;
      const lineNo = update.state.doc.lineAt(head).number;
      const spot = view.domAtPos(head);
      const lineEl = (spot.node instanceof Element ? spot.node : spot.node.parentElement)?.closest('.cm-line') ?? null;
      if (lineEl) {
        const range = document.createRange();
        range.selectNodeContents(lineEl);
        const width = range.getBoundingClientRect().width;
        const baseline = widthBaselines.get(view) ?? null;
        if (baseline && baseline.line === lineNo && Math.abs(width - baseline.width) > 0.5) cursorWidthChanges++;
        widthBaselines.set(view, { width, line: lineNo });
      } else widthBaselines.set(view, null);
    } catch { widthBaselines.set(view, null); }
  }
  try {
    const live = new Map<Element, number>();
    for (const el of [...view.dom.querySelectorAll('.md-render-target, .mdir-tablebox, img')] as HTMLElement[]) {
      try { live.set(el, view.posAtDOM(el, 0)); } catch { /* 无法定位的根不入册 */ }
    }
    if (update.viewportChanged && !update.docChanged && !update.selectionSet) {
      const previous = asyncRoots.get(view);
      if (previous) for (const [el, pos] of previous) {
        if (!live.has(el) && !el.isConnected
          && pos >= view.viewport.from - 300 && pos <= view.viewport.to + 300) scrollReplacements++;
      }
    }
    asyncRoots.set(view, live);
  } catch { /* 探针不承担正确性 */ }
});

export function irPerfProbe(): Extension {
  if (irPerfEnabled()) exposeSnapshot();
  return [transactionStart, stateFieldsDone, decorationsDone, domCommitted, req014GeometryProbe];
}
