// markdown-view/live-block-field —— 块级件装饰（表格/分隔线）与查找高亮承载
// （批次 4 自 livepreview.ts 拆分，行为不变；liveBlockField 含 v0.40 纯选区差集重建路径，整块原样搬移）。
import { EditorView, ViewPlugin, Decoration, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { compositionActive } from '../common/composition';
import { buildNeedleRe } from '../text-view/findbar';
import type { FindOptions } from '../common/ipc';
import { fenceSourceChanged } from './writing';
import { blockLayout, SOURCE_LINE_HEIGHT_PX } from './layout';
import { irPerfEnabled, recordBlockDecos, recordBlockLayout, irWorkStart, recordIrWork } from './ir-perf';
import { referenceField, emojiField, mdTouchedField, referencesReady, emojisReady, currentPosition, VIEWPORT_MARGIN } from './live-state';
import { makeActiveProbe, visitVisible, fenceLines, tableDecos, type TableData } from './live-deco';
import { RenderWidget, CodeLabelWidget, TocWidget, HrWidget, codeContainer, editingFence, renderContextOf } from './live-widgets';
import { renderBlockAt } from './render-model';
import { missingWindows } from './deco-window';
import { paragraphTypingWindow } from './typing-window';
import { requestIrFrame, cancelIrFrame } from './frame-work';

// ── 块级件装饰（表格/分隔线）：liveBlockField（StateField）承载 ──
// CM6 约束：ViewPlugin 提供的装饰不得为块级/跨行替换（块级件参与高度测量，须由状态层产出）。
// 视口不在事务里：viewportReporter 以 effect 报界。纯文本变更先映射保旧件（键入期解析未完成，
// 立即重建会让表格件闪源码）；选区/视口/解析推进（树快照变化）且树已解析到界内时才重建。

export const liveViewport = StateEffect.define<{ from: number; to: number; scrolling?: boolean }>();
export const blockSliceReady = StateEffect.define<object>();
/** 外观/容器几何失效，不是用户滚动；必须立即移除占位并完整交付当前视口。 */
export const liveGeometryChanged = StateEffect.define<null>();
const BLOCK_SLICE_CHARS = 2048;

interface PendingBlocks { next: number; end: number; token: object; first?: boolean; remaining?: { from: number; to: number }[]; budgeted?: boolean }
class BlockPlaceholder extends WidgetType {
  constructor(private height: number) { super(); }
  get estimatedHeight(): number { return this.height; }
  eq(other: BlockPlaceholder): boolean { return this.height === other.height; }
  toDOM(): HTMLElement {
    const dom = document.createElement('div'); dom.className = 'mdir-block-placeholder';
    dom.style.height = this.height + 'px'; dom.setAttribute('aria-hidden', 'true'); return dom;
  }
}
/** 边界归属按装饰起点去重；首片允许包含跨入视口的完整块级件。 */
function appendBlockSlice(kept: DecorationSet, built: DecorationSet, from: number, to: number, first: boolean, last: boolean): DecorationSet {
  const add: Range<Decoration>[] = [];
  for (let c = built.iter(); c.value; c.next()) {
    if ((first || c.from >= from) && (c.from < to || (last && c.from === to))) add.push(c.value.range(c.from, c.to));
  }
  return kept.update({ add, sort: true });
}
function advanceBlocks(state: EditorState, value: LiveBlockState, pending: PendingBlocks, first: boolean): LiveBlockState {
  const from = pending.next, to = Math.min(pending.end, from + (value.deferred ? 512 : BLOCK_SLICE_CHARS));
  // 解析未就绪保留原分片进度，待语法树推进后继续，不能把计划窗口当作已完成。
  if (!syntaxTreeAvailable(state, to)) return { ...value, pending };
  if (irPerfEnabled()) { recordBlockLayout(from, to); recordBlockDecos(from, to); }
  const next = pending.remaining?.[0];
  return { ...value,
    set: appendBlockSlice(first ? Decoration.none : value.set, buildBlockDecos(state, from, to, value.tables, value.deferred), from, to, first, to === pending.end),
    layout: appendBlockSlice(first ? Decoration.none : value.layout, blockLayout(state, from, to), from, to, first, to === pending.end),
    pending: to < pending.end ? { ...pending, next: to, first: false }
      : next ? { ...pending, next: next.from, end: next.to, first: false, remaining: pending.remaining!.slice(1) } : undefined,
  };
}

function buildBlockDecos(state: EditorState, from: number, to: number, tables: Map<number, TableData>, deferred = false): DecorationSet {
  const started = irWorkStart();
  try { return buildBlockDecosInner(state, from, to, tables, deferred); }
  finally { recordIrWork('blockDecos', started); }
}
function buildBlockDecosInner(state: EditorState, from: number, to: number, tables: Map<number, TableData>, deferred: boolean): DecorationSet {
  const doc = state.doc;
  const active = makeActiveProbe(state.selection.ranges);
  const out: Range<Decoration>[] = [];
  const index = state.field(referenceField);
  const renderContext = renderContextOf(index);
  visitVisible(syntaxTree(state).topNode, Math.max(0, from), to, node => {
    if (index.metadata.frontMatter && node.name !== 'Document' && node.from < currentPosition(index, index.metadata.frontMatter.to)) return false;
    const selected = state.selection.ranges.some(r => !r.empty && r.from < node.to && r.to > node.from
      && (r.from < node.from || r.to > node.to));
    if (node.name.startsWith('SetextHeading') && !state.selection.ranges.some(r => !r.empty && r.from < node.to && r.to > node.from)
      && !(state.field(mdTouchedField, false) === true && active(node.from, node.to))) {
      const underline = node.node.getChild('HeaderMark');
      if (underline) {
        const line = doc.lineAt(underline.from);
        out.push(Decoration.replace({ block: true }).range(line.from, line.to));
      }
      return false;
    }
    const info = deferred && node.name === 'FencedCode' ? node.node.getChild('CodeInfo') : null;
    const deferredDisplay = deferred && (node.name === 'MathBlock' || (info
      && /^(?:math|mermaid)$/i.test(doc.sliceString(info.from, info.to).trim()) && node.node.getChildren('CodeMark').length > 1));
    if (deferredDisplay && !selected && !active(node.from, node.to)) {
      out.push(Decoration.replace({ block: true, blockAtomic: true, widget: new BlockPlaceholder(Math.max(40,
        (doc.lineAt(Math.max(node.from, node.to - 1)).number - doc.lineAt(node.from).number + 1) * SOURCE_LINE_HEIGHT_PX)) }).range(node.from, node.to));
      return false;
    }
    const rendered = renderBlockAt(node.node, (a, b) => doc.sliceString(a, b));
    if (rendered?.display) {
      if (!selected) {
        const widget = new RenderWidget(rendered, doc, renderContext);
        if (active(node.from, node.to)) out.push(Decoration.widget({ block: true, widget, side: 1 }).range(node.to));
        else out.push(Decoration.replace({ block: true, blockAtomic: true, widget }).range(node.from, node.to));
      }
      return false;
    }
    if (node.name === 'FencedCode') {
      const { open, close, first, last } = fenceLines(node.node, doc);
      if (first <= last || close) {
        if (!editingFence(state, open.from)) {
          const info = node.node.getChild('CodeInfo'), mark = node.node.getChild('CodeMark')!;
          const { inset, quoted } = codeContainer(node.node);
          out.push(Decoration.replace({ block: true, inclusiveEnd: false, fence: true,
            widget: new CodeLabelWidget(info ? doc.sliceString(info.from, info.to).trim() : '', info?.from ?? mark.to, info?.to ?? mark.to, inset, quoted, state.readOnly, first > last),
          }).range(open.from, first > last ? close!.to : doc.line(first).from));
        }
        if (close && (first <= last || editingFence(state, open.from)))
          out.push(Decoration.replace({ block: true, fence: true }).range(close.from, close.to));
      }
      return false;
    }
    if (node.name === 'Table') {
      if (!selected) {
        if (deferred) {
          const lines = doc.lineAt(Math.max(node.from, node.to - 1)).number - doc.lineAt(node.from).number + 1;
          const line = doc.lineAt(node.from);
          const start = /^[\t >]*$/.test(doc.sliceString(line.from, node.from)) ? line.from : node.from;
          out.push(Decoration.replace({ block: true, blockAtomic: true, widget: new BlockPlaceholder(Math.max(lines * SOURCE_LINE_HEIGHT_PX, (lines - 1) * 32)) }).range(start, node.to));
        } else tableDecos(node, doc, out, state.field(referenceField), tables, state.field(emojiField));
      }
      return false;
    }
    if (node.name === 'TableOfContents' && !active(node.from, node.to)) {
      const entries = [...index.headings].map(([offset, heading]) => ({ heading, position: currentPosition(index, offset) }));
      out.push(Decoration.replace({ block: true, widget: new TocWidget(entries) }).range(node.from, node.to)); return false;
    }
    if (node.name === 'HorizontalRule' && !active(node.from, node.to)) {
      out.push(Decoration.replace({ block: true, blockAtomic: true, widget: new HrWidget() }).range(node.from, node.to));
      return false;
    }
    return ['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem'].includes(node.name);
  });
  return out.length ? Decoration.set(out, true) : Decoration.none;
}

interface LiveBlockState { set: DecorationSet; layout: DecorationSet; from: number; to: number; tables: Map<number, TableData>; pending?: PendingBlocks; deferred?: boolean }

export const liveBlockField = StateField.define<LiveBlockState>({
  create: (): LiveBlockState => ({ set: Decoration.none, layout: Decoration.none, from: 0, to: 0, tables: new Map() }),
  provide: f => [EditorView.decorations.from(f, s => s.set), EditorView.decorations.from(f, s => s.layout)],
  update(prev, tr): LiveBlockState {
    const started = irWorkStart();
    try {
    let from = tr.changes.mapPos(Math.min(prev.from, tr.startState.doc.length));
    let to = tr.changes.mapPos(Math.min(prev.to, tr.startState.doc.length));
    const set = prev.set.map(tr.changes);
    const vp = tr.effects.find(e => e.is(liveViewport));
    const geometryChanged = tr.effects.some(e => e.is(liveGeometryChanged));
    if (vp) { from = Math.min(tr.newDoc.length, vp.value.from); to = Math.min(tr.newDoc.length, vp.value.to); }
    // 解析树换代不代表表格源码变化。只淘汰触及的表格，其余映射坐标并复用单元格数组，
    // 使滚动/表格外键入后的 widget.eq 能走引用相等而不是逐格比较。
    const tables = tr.docChanged ? new Map<number, TableData>() : prev.tables;
    if (tr.docChanged) for (const [start, data] of prev.tables) {
      if (data.to === undefined) continue;
      let touched = false;
      tr.changes.iterChangedRanges((from, to) => { if (from <= data.to! && to >= start) touched = true; });
      if (touched) continue;
      const end = tr.changes.mapPos(data.to, -1);
      tables.set(tr.changes.mapPos(start, 1), end === data.to ? data : { ...data, to: end });
    }
    const deferred = geometryChanged || tr.docChanged ? false : vp ? vp.value.scrolling === true : prev.deferred;
    const mapped: LiveBlockState = { set, layout: prev.layout.map(tr.changes), from, to, tables, deferred, pending: tr.docChanged ? undefined : prev.pending };
    if (tr.state.field(compositionActive, false)) return mapped;
    if (geometryChanged) {
      const lo = Math.max(0, from - VIEWPORT_MARGIN), hi = Math.min(tr.newDoc.length, to + VIEWPORT_MARGIN);
      if (irPerfEnabled()) { recordBlockDecos(lo, hi); recordBlockLayout(lo, hi); }
      return { ...mapped, set: buildBlockDecos(tr.state, lo, hi, tables), layout: blockLayout(tr.state, lo, hi), pending: undefined };
    }
    if (tr.docChanged && !prev.pending && !prev.set.size && !tr.effects.length
      && tr.startState.readOnly === tr.state.readOnly
      && tr.startState.field(referenceField).inlineKey === tr.state.field(referenceField).inlineKey
      && tr.startState.field(compositionActive, false) === tr.state.field(compositionActive, false)
      && paragraphTypingWindow(tr.startState, tr.state, tr.changes)) return mapped;
    const continuation = tr.effects.find(e => e.is(blockSliceReady));
    if (continuation && !tr.docChanged && prev.pending?.token === continuation.value)
      return advanceBlocks(tr.state, mapped, prev.pending, prev.pending.first === true);
    // 解析推进信号：Language.setState 事务使树快照换代（syntaxTree 按状态读 LanguageState；
    // 该静态 effect 本版 .d.ts 未声明，树快照比对为同一信号的公开面）
    const forced = tr.selection != null || vp != null || tr.effects.some(e => e.is(referencesReady) || e.is(emojisReady) || e.is(fenceSourceChanged))
      || tr.startState.readOnly !== tr.state.readOnly
      || tr.startState.field(compositionActive, false) !== tr.state.field(compositionActive, false)
      || syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (!forced && !tr.docChanged) return mapped;
    const sliceFrom = Math.max(0, from - VIEWPORT_MARGIN), sliceTo = Math.min(tr.newDoc.length, to + VIEWPORT_MARGIN);
    // 大文档 forced 全视口重建（挂载/滚动/解析/非空选区）先交付首片；
    // 空光标纯移动仍走下方 v0.40 差集路径，绝不退化为全量重建。
    const pureCursor = !tr.docChanged && tr.selection != null && vp == null
      && tr.effects.length === 0 && syntaxTree(tr.startState) === syntaxTree(tr.state)
      && tr.startState.readOnly === tr.state.readOnly
      && tr.startState.field(compositionActive, false) === tr.state.field(compositionActive, false)
      && tr.startState.selection.ranges.every(r => r.empty) && tr.state.selection.ranges.every(r => r.empty);
    // 纯视口事务：重叠部分不重建。跨边界的块整块保留，新增边缘只扫描一次。
    // 分片尚未完成时不把计划区间误当作已完成覆盖，仍由原分片路径补齐。
    const pureViewport = vp != null && !tr.docChanged && tr.selection == null
      && !!prev.deferred === !!deferred
      && tr.effects.every(e => e.is(liveViewport))
      && syntaxTree(tr.startState) === syntaxTree(tr.state)
      && tr.startState.readOnly === tr.state.readOnly
      && tr.startState.field(compositionActive, false) === tr.state.field(compositionActive, false);
    const oldFrom = Math.max(0, prev.from - VIEWPORT_MARGIN), oldTo = Math.min(tr.newDoc.length, prev.to + VIEWPORT_MARGIN);
    // 向下滚动时已交付前缀仍有效，延续下一片而非从新视口头重来。
    if (pureViewport && prev.pending && !prev.pending.remaining?.length && sliceFrom >= oldFrom && sliceFrom < prev.pending.next && sliceTo >= prev.pending.next) {
      return { ...mapped,
        set: set.update({ filter: (f, t) => t >= sliceFrom && f <= sliceTo }),
        layout: mapped.layout.update({ filter: (f, t) => t >= sliceFrom && f <= sliceTo }),
        pending: prev.pending.next < sliceTo ? { ...prev.pending, end: sliceTo } : undefined,
      };
    }
    if (pureViewport && !prev.pending && sliceFrom < oldTo && sliceTo > oldFrom && prev.to > prev.from
      && syntaxTreeAvailable(tr.startState, prev.to) && syntaxTreeAvailable(tr.state, to)) {
      let nextSet = set.update({ filter: (f, t) => t >= sliceFrom && f <= sliceTo });
      let nextLayout = mapped.layout.update({ filter: (f, t) => t >= sliceFrom && f <= sliceTo });
      const edges = missingWindows({ from: sliceFrom, to: sliceTo }, [{ from: oldFrom, to: oldTo }]);
      if (deferred) {
        const edge = edges[0];
        return { ...mapped, set: nextSet, layout: nextLayout, pending: edge
          ? { next: edge.from, end: edge.to, token: {}, remaining: edges.slice(1), budgeted: true } : undefined };
      }
      const merge = (kept: DecorationSet, built: DecorationSet): DecorationSet => {
        const add: Range<Decoration>[] = [], starts = new Set<number>();
        for (let c = built.iter(); c.value; c.next()) { add.push(c.value.range(c.from, c.to)); starts.add(c.from); }
        return kept.update({ filter: f => !starts.has(f), add, sort: true });
      };
      for (const edge of edges) {
        if (irPerfEnabled()) { recordBlockDecos(edge.from, edge.to); recordBlockLayout(edge.from, edge.to); }
        nextSet = merge(nextSet, buildBlockDecos(tr.state, edge.from, edge.to, tables, deferred));
        nextLayout = merge(nextLayout, blockLayout(tr.state, edge.from, edge.to));
      }
      return { ...mapped, set: nextSet, layout: nextLayout, pending: undefined };
    }
    if (vp?.value.scrolling && forced && !pureCursor)
      return { ...mapped, pending: { next: sliceFrom, end: sliceTo, token: {}, first: true, budgeted: true } };
    if (forced && !pureCursor && tr.newDoc.length >= 256 * 1024 && sliceTo - sliceFrom > BLOCK_SLICE_CHARS)
      return advanceBlocks(tr.state, mapped, { next: sliceFrom, end: sliceTo, token: {},
        ...(!tr.docChanged && vp && prev.deferred ? { budgeted: true } : {}) }, true);
    // 解析未及界内：留待解析推进事务再建（闪源码优于错位件）
    if (!syntaxTreeAvailable(tr.state, Math.min(tr.state.doc.length, to))) return mapped;
    // 排版与网格分开更新：空行键入后立即恢复行高，不必重建活动表格。
    if (irPerfEnabled()) recordBlockLayout(Math.max(0, from - VIEWPORT_MARGIN), Math.min(tr.newDoc.length, to + VIEWPORT_MARGIN));
    const layout = blockLayout(tr.state, Math.max(0, from - VIEWPORT_MARGIN), Math.min(tr.newDoc.length, to + VIEWPORT_MARGIN));
    // 纯选区差分重建（v0.40 规则 27）：forced 仅由选区驱动、无文档变更且前后选区均空时，
    // 只对块级装饰随活动态翻转的块做窄区间重建；其余 forced 源（含非空选区事务）维持全视口重建。
    // 空选区限定使 :1035/:1071 的 selected 外延谓词在差分路径内恒 false。
    if (forced && !tr.docChanged && vp == null
      && !tr.effects.some(e => e.is(referencesReady) || e.is(emojisReady) || e.is(fenceSourceChanged))
      && tr.startState.readOnly === tr.state.readOnly
      && tr.startState.field(compositionActive, false) === tr.state.field(compositionActive, false)
      && syntaxTree(tr.startState) === syntaxTree(tr.state)
      && tr.startState.selection.ranges.every(r => r.empty) && tr.state.selection.ranges.every(r => r.empty)) {
      const prevProbe = makeActiveProbe(tr.startState.selection.ranges);
      const currProbe = makeActiveProbe(tr.state.selection.ranges);
      const prevTouched = tr.startState.field(mdTouchedField, false) === true;
      const currTouched = tr.state.field(mdTouchedField, false) === true;
      // 翻转集（块级装饰随空光标移动可翻转的节点）：
      // - HorizontalRule / TableOfContents / 显示 RenderBlock：active 探针翻转（1056/1060/1030）；
      // - FencedCode：editingFence 位随光标离开围栏行衰减（writing.ts:71）→ 起始围栏折叠态翻转；
      // - SetextHeading：下划线隐藏谓词镜像（1019，overlap 在空选区下恒 false，保留无损）；
      // - Table：空↔空下 selected 恒 false 且 tableDecos 无 active 门 → 装饰不变，不入翻转集。
      let dirtyFrom = -1, dirtyTo = -1;
      visitVisible(syntaxTree(tr.state).topNode, Math.max(0, from - VIEWPORT_MARGIN), Math.min(tr.state.doc.length, to + VIEWPORT_MARGIN), node => {
        const name = node.name;
        const isDisplayRender = renderBlockAt(node.node, (a, b) => tr.state.doc.sliceString(a, b))?.display === true;
        const tracked = name === 'HorizontalRule' || name === 'TableOfContents' || isDisplayRender;
        const isSetext = name.startsWith('SetextHeading');
        const isFence = name === 'FencedCode';
        if (!tracked && !isSetext && !isFence) return name === 'Document' || name === 'Blockquote' || name === 'BulletList' || name === 'OrderedList' || name === 'ListItem';
        let was: boolean, is: boolean;
        if (isSetext) {
          was = prevTouched && prevProbe(node.from, node.to);
          is = currTouched && currProbe(node.from, node.to);
        } else if (isFence) {
          const openFrom = tr.state.doc.lineAt(node.from).from;
          was = editingFence(tr.startState, openFrom);
          is = editingFence(tr.state, openFrom);
        } else {
          was = prevProbe(node.from, node.to);
          is = currProbe(node.from, node.to);
        }
        if (was !== is) {
          if (dirtyFrom < 0) { dirtyFrom = node.from; dirtyTo = node.to; }
          else { dirtyFrom = Math.min(dirtyFrom, node.from); dirtyTo = Math.max(dirtyTo, node.to); }
        }
        return false;
      });
      if (dirtyFrom < 0) return { ...mapped, layout, pending: tr.docChanged ? undefined : prev.pending };
      if (irPerfEnabled()) recordBlockDecos(dirtyFrom, dirtyTo);
      const kept = set.update({ filter: (f, t) => t < dirtyFrom || f > dirtyTo });
      const rebuilt = buildBlockDecos(tr.state, dirtyFrom, dirtyTo, tables);
      const additions: Range<Decoration>[] = [];
      const cursor = rebuilt.iter();
      while (cursor.value) { additions.push(cursor.value.range(cursor.from, cursor.to)); cursor.next(); }
      return { ...mapped, set: kept.update({ filter: () => true, add: additions }), layout, pending: prev.pending };
    }
    if (irPerfEnabled() && forced) recordBlockDecos(from - VIEWPORT_MARGIN, to + VIEWPORT_MARGIN);
    return { set: forced ? buildBlockDecos(tr.state, from - VIEWPORT_MARGIN, to + VIEWPORT_MARGIN, tables, deferred) : set, layout, from, to, tables, deferred };
    } finally { recordIrWork('blockField', started); }
  },
});

/** 视口变化 → effect 报给 liveBlockField（StateField 拿不到 ViewUpdate.viewport）。微任务派发
 *  避开构造/更新进行中重入；dead 位挡销毁后残留微任务（本版无 isDestroyed 可查）。 */
export const viewportReporter = ViewPlugin.fromClass(
  class {
    private dead = false;
    private pending = false;
    private frame = 0;
    private sharedFrame = false;
    private scrolling = false;
    private lastScrollTop = 0;
    private lastScrollLeft = 0;
    private lastEdit = -Infinity;
    private ignoreScrollUntil = -Infinity;
    private geometryDirty = true;
    private themeObserver?: MutationObserver;
    private resizeObserver?: ResizeObserver;
    private settleTimer: ReturnType<typeof setTimeout> | undefined;
    constructor(private view: EditorView) {
      this.ignoreScrollUntil = performance.now() + 100;
      this.lastScrollTop = view.scrollDOM.scrollTop;
      this.lastScrollLeft = view.scrollDOM.scrollLeft;
      this.report(view);
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
      window.addEventListener('resize', this.geometryChanged);
      document.fonts?.addEventListener('loadingdone', this.geometryChanged);
      if (typeof MutationObserver !== 'undefined') {
        const root = document.documentElement;
        const theme = () => `${[...root.classList].filter(name => name.startsWith('th-')).sort().join(' ')}:${root.dataset.tone ?? ''}`;
        let previous = theme();
        this.themeObserver = new MutationObserver(() => {
          const current = theme();
          if (current !== previous) { previous = current; this.geometryChanged(); }
        });
        this.themeObserver.observe(root, { attributes: true, attributeFilter: ['class', 'data-tone'] });
      }
      if (typeof ResizeObserver !== 'undefined') {
        let width = view.scrollDOM.clientWidth, height = view.scrollDOM.clientHeight;
        this.resizeObserver = new ResizeObserver(entries => {
          const rect = entries[0]?.contentRect;
          if (rect && (rect.width !== width || rect.height !== height)) {
            width = rect.width; height = rect.height; this.geometryChanged();
          }
        });
        this.resizeObserver.observe(view.scrollDOM);
      }
    }
    private geometryChanged = (): void => {
      if (this.dead) return;
      this.geometryDirty = true;
      this.scrolling = false;
      this.ignoreScrollUntil = performance.now() + 100;
      clearTimeout(this.settleTimer);
      this.cancelFrame();
      this.report(this.view);
    };
    private onScroll = (): void => {
      const { scrollTop, scrollLeft } = this.view.scrollDOM;
      const moved = scrollTop !== this.lastScrollTop || scrollLeft !== this.lastScrollLeft;
      this.lastScrollTop = scrollTop; this.lastScrollLeft = scrollLeft;
      if (!moved) return;
      if (performance.now() - this.lastEdit < 100 || performance.now() < this.ignoreScrollUntil || this.geometryDirty) return;
      this.scrolling = true;
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.settleTimer = undefined;
        this.scrolling = false;
        this.restoreSettledAnchor();
      }, 100);
      this.report(this.view);
    };
    private restoreSettledAnchor(): void {
      if (this.dead) return;
      const view = this.view, top = view.scrollDOM.scrollTop;
      const anchor = view.lineBlockAtHeight(view.scrollDOM.getBoundingClientRect().top - view.documentTop);
      const position = anchor.from, oldTop = anchor.top;
      // 占位到实块必须同一事务交付；逐片恢复会把高度变化放大为往返滚动。
      this.ignoreScrollUntil = performance.now() + 100;
      const { from, to } = view.viewport;
      view.dispatch({ effects: [liveViewport.of({ from, to, scrolling: false }), liveGeometryChanged.of(null)] });
      view.scrollDOM.dispatchEvent(new Event('mdir-scroll-settle'));
      view.requestMeasure({ key: this,
        read: () => view.lineBlockAt(Math.min(position, view.state.doc.length)).top - oldTop,
        write: delta => {
          // 测量等待期间若用户已移动，旧锚点失效；只允许一次有效像素补偿。
          if (this.dead || view.scrollDOM.scrollTop !== top || Math.abs(delta) < 1) return;
          this.ignoreScrollUntil = performance.now() + 100;
          view.scrollDOM.scrollTop = top + delta;
          this.lastScrollTop = view.scrollDOM.scrollTop;
          view.scrollDOM.dispatchEvent(new Event('mdir-scroll-settle'));
        },
      });
    }
    update(u: ViewUpdate): void {
      if (u.docChanged) { this.lastEdit = performance.now(); this.scrolling = false; clearTimeout(this.settleTimer); }
      if (u.viewportChanged) this.report(u.view);
      this.cancelFrame();
      const pending = u.state.field(liveBlockField).pending;
      if (pending && !u.state.field(compositionActive, false)) {
        // 停稳后补齐仍属于滚动工作；只有恢复的非滚动 A2 分片使用独立 rAF。
        this.sharedFrame = u.state.field(liveBlockField).deferred === true || pending.budgeted === true;
        const next = () => {
          this.frame = 0;
          if (!this.dead && u.view.state.field(liveBlockField).pending?.token === pending.token)
            u.view.dispatch({ effects: blockSliceReady.of(pending.token) });
        };
        this.frame = this.sharedFrame ? requestIrFrame(next) : requestAnimationFrame(next);
      }
    }
    private cancelFrame(): void {
      if (this.sharedFrame) cancelIrFrame(this.frame); else cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    destroy(): void {
      this.dead = true; this.cancelFrame(); clearTimeout(this.settleTimer);
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
      window.removeEventListener('resize', this.geometryChanged);
      document.fonts?.removeEventListener('loadingdone', this.geometryChanged);
      this.themeObserver?.disconnect(); this.resizeObserver?.disconnect();
    }
    private report(view: EditorView): void {
      if (this.pending) return;
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        // 期间可能撤销/缩短文档，必须取派发时视口，不能回灌旧坐标。
        if (this.dead) return;
        const { from, to } = view.viewport, previous = view.state.field(liveBlockField);
        const complete = this.geometryDirty;
        this.geometryDirty = false;
        if (complete || previous.from !== from || previous.to !== to || !!previous.deferred !== this.scrolling)
          view.dispatch({ effects: complete
            ? [liveViewport.of({ from, to, scrolling: false }), liveGeometryChanged.of(null)]
            : liveViewport.of({ from, to, scrolling: this.scrolling }) });
        if (complete) {
          view.scrollDOM.dispatchEvent(new Event('mdir-layout-refresh'));
          view.requestMeasure();
        }
      });
    }
  }
);

// ── 查找高亮（FindBar「全部高亮」视口承载，规则 20） ──

export interface LiveFindQuery { needle: string; opts: FindOptions }
export const findQueryChanged = StateEffect.define<null>();

export function findHighlighter(getQuery: () => LiveFindQuery | null) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = this.build(view); }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged || u.transactions.some(tr => tr.effects.some(e => e.is(findQueryChanged)))) {
          this.decorations = this.build(u.view);
        }
      }
      private build(view: EditorView): DecorationSet {
        const q = getQuery();
        if (!q || !q.needle) return Decoration.none;
        const base = (() => {
          try {
            return buildNeedleRe(q.needle, q.opts);
          } catch { return null; }
        })();
        if (!base) return Decoration.none;
        const out: Range<Decoration>[] = [];
        // 滚动只扫描可见范围，避免每帧序列化并扫描整个 10MiB 文档。
        const g = new RegExp(base.source, base.flags.includes('g') ? base.flags : base.flags + 'g');
        for (const range of view.visibleRanges) {
          const text = view.state.doc.sliceString(range.from, range.to);
          g.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = g.exec(text)) != null) {
            if (m[0].length) out.push(Decoration.mark({ class: 'mdir-findhit' }).range(range.from + m.index, range.from + m.index + m[0].length));
            if (m.index === g.lastIndex) g.lastIndex++;
            if (out.length > 5000) break;
          }
        }
        return Decoration.set(out, true);
      }
    },
    { decorations: v => v.decorations }
  );
}
