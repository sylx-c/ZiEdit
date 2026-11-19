// markdown-view/md-view-plugin —— REQ-014 P1：即时渲染单一编排引擎（统一投影器架构）。
// 组成（承载机制按 contracts/rendering-seams.md §2 的实证修正）：
//   ① projectionHost —— 薄 StateField 宿主：事务内同步消费重建，存储行内/块级/间距三组装饰，
//      经 EditorView.decorations.from **直接提供**（CM6 规定经函数提供的装饰不得含块级件）；
//   ② mdViewOrchestrator —— 单一编排 ViewPlugin：吸收原 viewportReporter（视口报告/几何观察/
//      用户滚动判别/停稳）与分片续跑调度；不含自己的投影逻辑。
// 五级 needsRebuild 分级（data-model.md §3）：
//   视口内文档变更 → 整视口一次同步纯函数投影（键入路径，不再需要旧快路）；
//   视口变化 → 新视口重建（用户滚动走增量边缘 + 延迟分片；程序跳转完整同步）；
//   ActiveBlocks 变化 → 只重建变化前后涉及的活动块（行内）+ 受追踪块级件翻转集；
//   同块内纯选区变化 → 只更新该块行内装饰；
//   纯滚动 → 对新进视口区间增量投影，不动已挂载装饰（scrollReplaceCount=0 的机制基础）。
// 行为基线：本文件为 updateLiveBlocks（live-block-field）与 liveDeco 插件（livepreview 内联）
// 的保持式合并；块高预言机（block-height-cache/layout/spacing）调用点原样保留，P3 统一删除。
import { EditorView, ViewPlugin, Decoration, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { StateEffect, StateField, type EditorState, type Extension, type Range, type Transaction, type Text } from '@codemirror/state';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { compositionActive } from '../common/composition';
import { notifyCmRestoreLayout } from '../common/scroll-anchor';
import { trackUserScroll, userScrolledRecently, clearUserScroll } from '../common/user-scroll';
import { buildNeedleRe } from '../text-view/findbar';
import type { FindOptions } from '../common/ipc';
import { fenceSourceChanged, inlineFormatField } from './writing';
import { blockLayout, SOURCE_LINE_HEIGHT_PX, TABLE_ROW_ESTIMATE_PX } from './layout';
import { irPerfEnabled, recordBlockDecos, recordBlockLayout, recordLiveDeco, irWorkStart, recordIrWork } from './ir-perf';
import { referenceField, emojiField, referencesReady, emojisReady, currentPosition, imageContext, mdTouchedField, VIEWPORT_MARGIN } from './live-state';
import { projectViewport, makeActiveProbe, visitVisible, fenceLines, tableDecos, type TableData, type ProjectionLens } from './projector';
import { RenderWidget, CodeLabelWidget, TocWidget, HrWidget, codeContainer, editingFence, renderContextOf } from './live-widgets';
import { renderBlockAt } from './render-model';
import { blockHeightCache, heightMeasurements } from './block-height-cache';
import { dispatchIrLayout } from './ir-layout';
import { requestIrFrame, cancelIrFrame, measureAfterRender } from './frame-work';
import { activeBlocks } from './active-block';

// ── 窗口数学（自 deco-window.ts 内联；原文件随 T012 删除） ──

interface DecoWindow { from: number; to: number }

/** 普通行完整归属一片；超长行仍分片，最多多处理 256 字符，不能因对齐变成整条巨行。 */
function decorationSliceEnd(doc: Text, from: number, end: number, budget: number): number {
  const target = Math.min(end, from + budget), line = doc.lineAt(target);
  return Math.min(end, line.to - target <= 256 ? line.to : line.from > from ? line.from : target);
}

/** 从目标视口减去已完成的片段；未完成的计划不算覆盖，滚动中断不会留下永久空洞。 */
function missingWindows(target: DecoWindow, covered: readonly DecoWindow[]): DecoWindow[] {
  const missing: DecoWindow[] = [];
  let from = target.from;
  for (const range of [...covered].sort((a, b) => a.from - b.from)) {
    if (range.to <= from || range.from >= target.to) continue;
    if (range.from > from) missing.push({ from, to: range.from });
    from = Math.max(from, range.to);
  }
  if (from < target.to) missing.push({ from, to: target.to });
  return missing;
}

function clipWindows(target: DecoWindow, covered: readonly DecoWindow[]): DecoWindow[] {
  const result: DecoWindow[] = [];
  for (const range of [...covered].sort((a, b) => a.from - b.from)) {
    const from = Math.max(target.from, range.from), to = Math.min(target.to, range.to);
    if (from >= to) continue;
    const last = result[result.length - 1];
    if (last && last.to >= from) last.to = Math.max(last.to, to);
    else result.push({ from, to });
  }
  return result;
}

// ── 效果与宿主状态 ──

export const liveViewport = StateEffect.define<{ from: number; to: number; scrolling?: boolean }>();
export const blockSliceReady = StateEffect.define<object>();
/** 外观/容器几何失效：与其他派生工作共用帧预算，逐片替换当前视口。 */
export const liveGeometryChanged = StateEffect.define<null>();
const BLOCK_SLICE_CHARS = 2048;

interface PendingSlices { next: number; end: number; token: object; first?: boolean; remaining?: DecoWindow[]; budgeted?: boolean }

export interface ProjectionState {
  /** 行内/行类装饰（原 liveDeco 插件输出；函数通道合规——不含块级件）。 */
  inline: DecorationSet;
  /** 块级件装饰（表格/分隔线/显示公式/围栏标签；经宿主直接提供满足 CM6 块级约束）。 */
  block: DecorationSet;
  /** 块间空行行高装饰（mdir-gap；P3 删除 JS 间距模型时移除）。 */
  layout: DecorationSet;
  from: number; to: number;
  /** 行内已覆盖窗口（滚动增量投影的覆盖记账）。 */
  covered: DecoWindow[];
  tables: Map<number, TableData>;
  pending?: PendingSlices;
  deferred?: boolean;
}

class BlockPlaceholder extends WidgetType {
  constructor(private height: number, private provideHeight?: () => number | undefined) { super(); }
  get estimatedHeight(): number {
    if (this.provideHeight) { this.height = this.provideHeight() ?? this.height; this.provideHeight = undefined; }
    return this.height;
  }
  eq(other: BlockPlaceholder): boolean { return this.estimatedHeight === other.estimatedHeight; }
  toDOM(): HTMLElement {
    const dom = document.createElement('div'); dom.className = 'mdir-block-placeholder';
    dom.style.height = this.estimatedHeight + 'px'; dom.setAttribute('aria-hidden', 'true'); return dom;
  }
}

/** 边界归属按装饰起点去重；首片允许包含跨入视口的完整块级件。 */
function appendSlice(kept: DecorationSet, built: DecorationSet, from: number, to: number, first: boolean, last: boolean): DecorationSet {
  const add: Range<Decoration>[] = [];
  for (let c = built.iter(); c.value; c.next()) {
    if ((c.from >= from || (first && c.to >= from)) && (c.from < to || (last && c.from === to))) add.push(c.value.range(c.from, c.to));
  }
  return kept.update({ add, sort: true });
}

// ── 块级件构建（自 live-block-field 原样搬移；P3 删除高度预言机时收缩） ──

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
    // Setext 标题已全局不解析（noSetextHeading）：下划线行按 HorizontalRule 走 HrWidget。
    // 公式/图表滚动中也直接上实件（挂载只建 DOM，重活在渲染队列空闲时做；已渲染过的同步出图）。
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
      const editingClose = close !== null && editingFence(state, close.from);
      if (first <= last || close) {
        if (!editingFence(state, open.from)) {
          const info = node.node.getChild('CodeInfo'), mark = node.node.getChild('CodeMark')!;
          const { inset, quoted } = codeContainer(node.node);
          out.push(Decoration.replace({ block: true, inclusiveEnd: false, fence: true,
            widget: new CodeLabelWidget(info ? doc.sliceString(info.from, info.to).trim() : '', info?.from ?? mark.to, info?.to ?? mark.to, inset, quoted, state.readOnly, first > last && !editingClose),
          }).range(open.from, first > last ? (editingClose ? close!.from : close!.to) : doc.line(first).from));
        }
        if (close && !editingClose && (first <= last || editingFence(state, open.from)))
          out.push(Decoration.replace({ block: true, fence: true }).range(close.from, close.to));
      }
      return false;
    }
    if (node.name === 'Table') {
      if (!selected) {
        const cache = state.facet(blockHeightCache);
        const lines = doc.lineAt(Math.max(node.from, node.to - 1)).number - doc.lineAt(node.from).number + 1;
        const container = codeContainer(node.node);
        const bound = cache?.bound('Table', container.inset, container.quoted, node.from, node.to);
        const tableFrom = node.from, tableTo = node.to;
        const provideIdentity = !bound && cache && lines <= 161 && tableTo - tableFrom <= 32768 ? () => {
          const existing = cache.bound('Table', container.inset, container.quoted, tableFrom, tableTo);
          if (existing) return existing;
          const source = doc.sliceString(tableFrom, tableTo);
          return !/!\[|\$|<img\b|<svg\b/i.test(source)
            ? cache.identity('Table', source, container.inset, container.quoted, tableFrom, tableTo) : undefined;
        } : undefined;
        const identity = bound;
        if (!deferred && provideIdentity) cache!.defer(tableFrom, provideIdentity);
        const height = cache?.get(identity);
        if (deferred) {
          // 滚动只延迟首次渲染，已有实表不能降级，否则会销毁编辑器并重复水合。
          if (tables.has(node.from)) {
            tableDecos(node, doc, out, state.field(referenceField), tables, state.field(emojiField), identity, height, provideIdentity);
            return false;
          }
          const line = doc.lineAt(node.from);
          const start = /^[\t >]*$/.test(doc.sliceString(line.from, node.from)) ? line.from : node.from;
          out.push(Decoration.replace({ block: true, blockAtomic: true, widget: new BlockPlaceholder(height ?? Math.max(lines * SOURCE_LINE_HEIGHT_PX, (lines - 1) * TABLE_ROW_ESTIMATE_PX),
            provideIdentity ? () => cache?.get(provideIdentity()) : undefined) }).range(start, node.to));
        } else tableDecos(node, doc, out, state.field(referenceField), tables, state.field(emojiField), identity, height, provideIdentity);
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

// ── 行内投影（lens 装配 + 视口窗口） ──

function lensOf(state: EditorState): ProjectionLens {
  const formatted = state.field(inlineFormatField, false);
  return {
    ranges: state.selection.ranges,
    touched: state.field(mdTouchedField, false) === true,
    formatted: formatted ? { from: formatted.from, to: formatted.to, pending: formatted.pending } : null,
    get emojis() { return state.field(emojiField, false) ?? {}; },
    refs: () => state.field(referenceField, false)?.urls ?? new Map(),
    fenceEditing: pos => editingFence(state, pos),
  };
}

function buildInline(state: EditorState, from: number, to: number): DecorationSet {
  const started = irWorkStart();
  try {
    const index = state.field(referenceField, false);
    if (!index) return Decoration.none;
    return projectViewport(state.doc, syntaxTree(state), { from, to }, index, lensOf(state),
      state.facet(imageContext).baseDir, state.facet(imageContext).remoteResolve);
  } finally { recordIrWork('liveDeco', started); }
}

/** 行内区间合并：替换窗口内旧装饰，保留窗外（与旧 appendSlice 同口径）。 */
function mergeInlineWindow(kept: DecorationSet, built: DecorationSet, from: number, to: number, docLength: number): DecorationSet {
  const add: Range<Decoration>[] = [];
  for (let c = built.iter(); c.value; c.next()) {
    if (c.from >= from && (c.from < to || (to === docLength && c.from === to))) add.push(c.value.range(c.from, c.to));
  }
  return kept.update({ filter: f => f < from || (f >= to && !(to === docLength && f === to)), add, sort: true });
}

// ── 宿主 update：五级 needsRebuild 分级（事务内同步） ──

function advanceSlices(state: EditorState, value: ProjectionState, pending: PendingSlices, first: boolean): ProjectionState {
  const from = pending.next;
  // 行/间距装饰位于 line.from，语法节点可从缩进之后开始。字符边界截在两者之间会先删旧装饰、
  // 又把它排除在相邻两片之外，造成停滚时补回间距。
  const to = decorationSliceEnd(state.doc, from, pending.end, pending.budgeted || value.deferred ? 256 : BLOCK_SLICE_CHARS);
  // 解析未就绪保留原分片进度，待语法树推进后继续。
  if (!syntaxTreeAvailable(state, to)) return { ...value, pending };
  if (irPerfEnabled()) { recordBlockLayout(from, to); recordBlockDecos(from, to); }
  const keep = (set: DecorationSet): DecorationSet => set.update({
    filter: (start, end) => (first ? end < from : start < from) || (start >= to && !(to === state.doc.length && start === to)),
  });
  const next = pending.remaining?.[0];
  const covered = clipWindows({ from: 0, to: state.doc.length }, [...value.covered, { from, to }]);
  return { ...value,
    inline: mergeInlineWindow(value.inline, buildInline(state, from, to), from, to, state.doc.length),
    block: appendSlice(keep(value.block), buildBlockDecos(state, from, to, value.tables, value.deferred), from, to, first, to === state.doc.length),
    layout: appendSlice(keep(value.layout), blockLayout(state, from, to), from, to, first, to === state.doc.length),
    covered,
    pending: to < pending.end ? { ...pending, next: to, first: false }
      : next ? { ...pending, next: next.from, end: next.to, first: false, remaining: pending.remaining!.slice(1) } : undefined,
  };
}

function updateProjection(prev: ProjectionState, tr: Transaction): ProjectionState {
  const started = irWorkStart();
  try {
    let from = tr.changes.mapPos(Math.min(prev.from, tr.startState.doc.length));
    let to = tr.changes.mapPos(Math.min(prev.to, tr.startState.doc.length));
    const inline = prev.inline.map(tr.changes);
    const block = prev.block.map(tr.changes);
    const vp = tr.effects.find(e => e.is(liveViewport));
    const geometryChanged = tr.effects.some(e => e.is(liveGeometryChanged));
    const heightCache = tr.state.facet(blockHeightCache);
    if (tr.docChanged) heightCache?.map(tr.changes);
    if (tr.startState.field(referenceField).inlineKey !== tr.state.field(referenceField).inlineKey
      || tr.startState.field(emojiField) !== tr.state.field(emojiField)) heightCache?.clear();
    if (vp) { from = Math.min(tr.newDoc.length, vp.value.from); to = Math.min(tr.newDoc.length, vp.value.to); }
    const sliceFrom = tr.newDoc.lineAt(Math.max(0, Math.min(tr.newDoc.length, from - VIEWPORT_MARGIN))).from;
    const sliceTo = tr.newDoc.lineAt(Math.min(tr.newDoc.length, to + VIEWPORT_MARGIN)).to;
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
    const mapped: ProjectionState = { inline, block, layout: prev.layout.map(tr.changes), from, to, covered: prev.covered, tables, deferred, pending: tr.docChanged ? undefined : prev.pending };
    if (tr.state.field(compositionActive, false)) return mapped;
    // 几何变化与停滚补齐走共享帧队列，不能绕过预算同步重建整个视口。
    if (geometryChanged) {
      return { ...mapped, covered: [], pending: { next: sliceFrom, end: sliceTo, token: {}, first: true, budgeted: true } };
    }
    const continuation = tr.effects.find(e => e.is(blockSliceReady));
    if (continuation && !tr.docChanged && prev.pending?.token === continuation.value)
      return advanceSlices(tr.state, mapped, prev.pending, prev.pending.first === true);
    // 解析推进信号（树快照换代等）与强制条件同旧口径。
    const forced = tr.selection != null || vp != null || tr.effects.some(e => e.is(referencesReady) || e.is(emojisReady) || e.is(fenceSourceChanged))
      || tr.startState.readOnly !== tr.state.readOnly
      || tr.startState.field(compositionActive, false) !== tr.state.field(compositionActive, false)
      || syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (!forced && !tr.docChanged) return mapped;
    const pureCursor = !tr.docChanged && tr.selection != null && vp == null
      && tr.effects.length === 0 && syntaxTree(tr.startState) === syntaxTree(tr.state)
      && tr.startState.readOnly === tr.state.readOnly
      && tr.startState.field(compositionActive, false) === tr.state.field(compositionActive, false)
      && tr.startState.selection.ranges.every(r => r.empty) && tr.state.selection.ranges.every(r => r.empty);
    // 纯视口事务：重叠部分不重建。跨边界的块整块保留，新增边缘只扫描一次。
    const pureViewport = vp != null && !tr.docChanged && tr.selection == null
      && !!prev.deferred === !!deferred
      && tr.effects.every(e => e.is(liveViewport))
      && syntaxTree(tr.startState) === syntaxTree(tr.state)
      && tr.startState.readOnly === tr.state.readOnly
      && tr.startState.field(compositionActive, false) === tr.state.field(compositionActive, false);
    const oldFrom = tr.newDoc.lineAt(Math.max(0, Math.min(tr.newDoc.length, prev.from - VIEWPORT_MARGIN))).from;
    const oldTo = tr.newDoc.lineAt(Math.min(tr.newDoc.length, prev.to + VIEWPORT_MARGIN)).to;
    // 向下滚动时已交付前缀仍有效，延续下一片而非从新视口头重来。
    if (pureViewport && prev.pending && !prev.pending.remaining?.length && sliceFrom >= oldFrom && sliceFrom < prev.pending.next && sliceTo >= prev.pending.next) {
      const coveredEnd = Math.min(prev.pending.end, sliceTo);
      const mergeLayoutNow = (kept: DecorationSet, mFrom: number, mTo: number): DecorationSet => {
        if (mTo <= mFrom || !syntaxTreeAvailable(tr.state, mTo)) return kept;
        const add: Range<Decoration>[] = [], starts = new Set<number>();
        for (let c = blockLayout(tr.state, mFrom, mTo).iter(); c.value; c.next()) { add.push(c.value.range(c.from, c.to)); starts.add(c.from); }
        return kept.update({ filter: f => !starts.has(f), add, sort: true });
      };
      return { ...mapped,
        inline: mergeInlineWindow(inline, buildInline(tr.state, sliceFrom, sliceTo), sliceFrom, sliceTo, tr.newDoc.length),
        block: block.update({ filter: (f, t) => t >= sliceFrom && f <= sliceTo }),
        layout: mergeLayoutNow(mapped.layout.update({ filter: (f, t) => t >= sliceFrom && f <= sliceTo }), coveredEnd, sliceTo),
        pending: prev.pending.next < sliceTo ? { ...prev.pending, end: sliceTo } : undefined,
      };
    }
    if (pureViewport && !prev.pending && sliceFrom < oldTo && sliceTo > oldFrom && prev.to > prev.from
      && syntaxTreeAvailable(tr.startState, prev.to) && syntaxTreeAvailable(tr.state, to)) {
      const edges = missingWindows({ from: sliceFrom, to: sliceTo }, [{ from: oldFrom, to: oldTo }]);
      const keptInline = inline.update({ filter: (f, t) => t >= sliceFrom && f <= sliceTo });
      const merge = (kept: DecorationSet, built: DecorationSet): DecorationSet => {
        const add: Range<Decoration>[] = [], starts = new Set<number>();
        for (let c = built.iter(); c.value; c.next()) { add.push(c.value.range(c.from, c.to)); starts.add(c.from); }
        return kept.update({ filter: f => !starts.has(f), add, sort: true });
      };
      if (deferred) {
        const mergeLayoutNow = (kept: DecorationSet, mFrom: number, mTo: number): DecorationSet => {
          if (mTo <= mFrom || !syntaxTreeAvailable(tr.state, mTo)) return kept;
          const add: Range<Decoration>[] = [], starts = new Set<number>();
          for (let c = blockLayout(tr.state, mFrom, mTo).iter(); c.value; c.next()) { add.push(c.value.range(c.from, c.to)); starts.add(c.from); }
          return kept.update({ filter: f => !starts.has(f), add, sort: true });
        };
        let nextLayout = mapped.layout.update({ filter: (f, t) => t >= sliceFrom && f <= sliceTo });
        const edge = edges[0];
        for (const uncovered of edges) nextLayout = mergeLayoutNow(nextLayout, uncovered.from, uncovered.to);
        return { ...mapped, inline: keptInline, block: block.update({ filter: (f, t) => t >= sliceFrom && f <= sliceTo }), layout: nextLayout, pending: edge
          ? { next: edge.from, end: edge.to, token: {}, remaining: edges.slice(1), budgeted: true } : undefined };
      }
      let nextBlock = block.update({ filter: (f, t) => t >= sliceFrom && f <= sliceTo });
      let nextLayout = mapped.layout.update({ filter: (f, t) => t >= sliceFrom && f <= sliceTo });
      for (const edge of edges) {
        if (irPerfEnabled()) { recordBlockDecos(edge.from, edge.to); recordBlockLayout(edge.from, edge.to); }
        nextBlock = merge(nextBlock, buildBlockDecos(tr.state, edge.from, edge.to, tables, deferred));
        nextLayout = merge(nextLayout, blockLayout(tr.state, edge.from, edge.to));
      }
      return { ...mapped, inline: keptInline, block: nextBlock, layout: nextLayout, pending: undefined };
    }
    if (vp?.value.scrolling && forced && !pureCursor)
      return { ...mapped,
        inline: mergeInlineWindow(inline, buildInline(tr.state, sliceFrom, sliceTo), sliceFrom, sliceTo, tr.newDoc.length),
        covered: [{ from: sliceFrom, to: sliceTo }],
        pending: { next: sliceFrom, end: sliceTo, token: {}, first: true, budgeted: true } };
    if (forced && !pureCursor && tr.newDoc.length >= 256 * 1024 && sliceTo - sliceFrom > BLOCK_SLICE_CHARS && !tr.docChanged)
      return advanceSlices(tr.state, mapped, { next: sliceFrom, end: sliceTo, token: {},
        ...(!tr.docChanged && vp && prev.deferred ? { budgeted: true } : {}) }, true);
    // ── 纯光标差分（五级口径：ActiveBlocks 变化 / 同块纯选区） ──
    if (pureCursor) {
      const prevBlocks = activeBlocks(tr.startState);
      const currBlocks = activeBlocks(tr.state);
      // 变化涉及的行内重建区间：变化块并集（同块移动时为该块本身——行内标记随光标翻转）。
      let inlineFrom = -1, inlineTo = -1;
      const union: { from: number; to: number }[] = [];
      for (const b of prevBlocks) if (!currBlocks.some(c => c.from === b.from && c.to === b.to)) union.push(b);
      for (const b of currBlocks) if (!prevBlocks.some(c => c.from === b.from && c.to === b.to)) union.push(b);
      if (!union.length && currBlocks.length) union.push(...currBlocks.map(b => ({ from: b.from, to: b.to })));
      for (const b of union) {
        if (inlineFrom < 0 || b.from < inlineFrom) inlineFrom = b.from;
        if (inlineTo < 0 || b.to > inlineTo) inlineTo = b.to;
      }
      // 受追踪块级件翻转集（块级装饰随空光标移动可翻转的节点：HR/TOC/显示渲染块/围栏折叠态）。
      let dirtyFrom = -1, dirtyTo = -1;
      visitVisible(syntaxTree(tr.state).topNode, Math.max(0, from - VIEWPORT_MARGIN), Math.min(tr.state.doc.length, to + VIEWPORT_MARGIN), node => {
        const name = node.name;
        const isDisplayRender = renderBlockAt(node.node, (a, b) => tr.state.doc.sliceString(a, b))?.display === true;
        const tracked = name === 'HorizontalRule' || name === 'TableOfContents' || isDisplayRender;
        const isFence = name === 'FencedCode';
        if (!tracked && !isFence) return name === 'Document' || name === 'Blockquote' || name === 'BulletList' || name === 'OrderedList' || name === 'ListItem';
        let was: boolean | number, is: boolean | number;
        if (isFence) {
          const { open, close } = fenceLines(node.node, tr.state.doc);
          const fenceEditing = (state: EditorState): number => Number(editingFence(state, open.from))
            + (close !== null && editingFence(state, close.from) ? 2 : 0);
          was = fenceEditing(tr.startState);
          is = fenceEditing(tr.state);
        } else {
          was = makeActiveProbe(tr.startState.selection.ranges)(node.from, node.to);
          is = makeActiveProbe(tr.state.selection.ranges)(node.from, node.to);
        }
        if (was !== is) {
          if (dirtyFrom < 0) { dirtyFrom = node.from; dirtyTo = node.to; }
          else { dirtyFrom = Math.min(dirtyFrom, node.from); dirtyTo = Math.max(dirtyTo, node.to); }
        }
        return false;
      });
      if (irPerfEnabled()) recordBlockLayout(sliceFrom, sliceTo);
      const layout = blockLayout(tr.state, sliceFrom, sliceTo);
      if (dirtyFrom < 0 && inlineFrom < 0) return { ...mapped, layout, pending: prev.pending };
      const nextInline = inlineFrom < 0 ? inline
        : mergeInlineWindow(inline, buildInline(tr.state, Math.max(inlineFrom, sliceFrom), Math.min(inlineTo, sliceTo)), Math.max(inlineFrom, sliceFrom), Math.min(inlineTo, sliceTo), tr.newDoc.length);
      if (dirtyFrom < 0) return { ...mapped, inline: nextInline, layout, pending: prev.pending };
      if (irPerfEnabled()) recordBlockDecos(dirtyFrom, dirtyTo);
      const kept = block.update({ filter: (f, t) => t < dirtyFrom || f > dirtyTo });
      const rebuilt = buildBlockDecos(tr.state, dirtyFrom, dirtyTo, tables);
      const additions: Range<Decoration>[] = [];
      const cursor = rebuilt.iter();
      while (cursor.value) { additions.push(cursor.value.range(cursor.from, cursor.to)); cursor.next(); }
      return { ...mapped, inline: nextInline, block: kept.update({ filter: () => true, add: additions }), layout, pending: prev.pending };
    }
    // ── 全量重建（文档变更/挂载/树推进/引用与表情更新/非空选区） ──
    // 行内投影不被解析可用性拦截（旧 liveDeco 口径：部分树也按可见区间投影，键入即时反馈）；
    // 块级/间距在解析未及界内时保留旧件，待树推进事务再建（闪源码优于错位件）。
    // 键入的 liveDeco 探针记录由编排插件按实时 view.viewport 完成（见 mdViewOrchestrator.update）。
    if (!syntaxTreeAvailable(tr.state, Math.min(tr.state.doc.length, to))) {
      return { ...mapped, inline: mergeInlineWindow(inline, buildInline(tr.state, sliceFrom, sliceTo), sliceFrom, sliceTo, tr.newDoc.length), covered: [{ from: sliceFrom, to: sliceTo }] };
    }
    if (irPerfEnabled()) recordBlockLayout(sliceFrom, sliceTo);
    const layout = blockLayout(tr.state, sliceFrom, sliceTo);
    if (irPerfEnabled()) {
      recordBlockDecos(sliceFrom, sliceTo);
    }
    if (tr.newDoc.length >= 256 * 1024 && sliceTo - sliceFrom > BLOCK_SLICE_CHARS) {
      if (tr.docChanged) {
        // 大文档键入：光标锚定首片同步交付（±1k 字符即时反馈），其余视口预算分片续跑；
        // 锚前区域保留映射旧装饰，不闪源码（冷启动密集语料下整视口同步重建实测会击穿 50ms 事务硬线）。
        const anchor = Math.max(sliceFrom, Math.min(tr.state.selection.main.head, sliceTo) - 1024);
        return advanceSlices(tr.state, mapped, { next: anchor, end: sliceTo, token: {}, first: false }, false);
      }
      const inlineBuilt = mergeInlineWindow(inline, buildInline(tr.state, sliceFrom, sliceTo), sliceFrom, sliceTo, tr.newDoc.length);
      return advanceSlices(tr.state, { ...mapped, inline: inlineBuilt, layout }, { next: sliceFrom, end: sliceTo, token: {}, first: true,
        ...(!tr.docChanged && vp && prev.deferred ? { budgeted: true } : {}) }, true);
    }
    const inlineBuilt = mergeInlineWindow(inline, buildInline(tr.state, sliceFrom, sliceTo), sliceFrom, sliceTo, tr.newDoc.length);
    const blockBuilt = buildBlockDecos(tr.state, sliceFrom, sliceTo, tables, deferred);
    return { inline: inlineBuilt,
      block: blockBuilt, layout, from, to, covered: [{ from: sliceFrom, to: sliceTo }], tables, deferred };
  } finally { recordIrWork('blockField', started); }
}

export const projectionField = StateField.define<ProjectionState>({
  create: (): ProjectionState => ({ inline: Decoration.none, block: Decoration.none, layout: Decoration.none, from: 0, to: 0, covered: [], tables: new Map() }),
  provide: f => [
    EditorView.decorations.from(f, s => s.inline),
    EditorView.decorations.from(f, s => s.block),
    EditorView.decorations.from(f, s => s.layout),
  ],
  update: updateProjection,
});

/** 目标视口已解析并交付全部块级装饰，CM 可以按实际替换块恢复块内位置（P3 前保留）。 */
export function liveAnchorReady(view: EditorView, line: number): boolean {
  const state = view.state, doc = state.doc, blocks = state.field(projectionField);
  const pos = doc.line(Math.min(doc.lines, Math.max(1, Math.floor(line)))).from;
  if (pos < blocks.from || pos > blocks.to || blocks.pending || blocks.deferred
    || !syntaxTreeAvailable(state, Math.min(doc.length, blocks.to + VIEWPORT_MARGIN))) return false;
  let expected = false;
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent!) {
    const selected = state.selection.ranges.some(r => !r.empty && r.from < node.to && r.to > node.from
      && (r.from < node.from || r.to > node.to));
    const info = node.name === 'FencedCode' ? node.getChild('CodeInfo') : null;
    const language = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : '';
    const rendered = node.name === 'MathBlock' || (node.name === 'FencedCode'
      && (language === 'math' || language === 'mermaid') && node.getChildren('CodeMark').length >= 2);
    if (node.name === 'Table' && !selected || rendered && !selected && !makeActiveProbe(state.selection.ranges)(node.from, node.to)) {
      expected = true; break;
    }
  }
  let replacement: { from: number; to: number } | undefined;
  blocks.block.between(pos, pos, (from, to, decoration) => {
    if (decoration.spec.blockAtomic && from <= pos && to >= pos) replacement = { from, to };
  });
  if (!replacement) return !expected;
  const measured = view.lineBlockAt(pos);
  return measured.from <= replacement.from && measured.to >= replacement.to;
}

// ── 编排插件（吸收 viewportReporter + 分片续跑；不含投影逻辑） ──

export const mdViewOrchestrator = ViewPlugin.fromClass(
  class {
    private dead = false;
    private pending = false;
    private reportFrame = 0;
    private frame = 0;
    private scrolling = false;
    private lastScrollTop = 0;
    private lastScrollLeft = 0;
    private untrackUser: () => void;
    private lastEdit = -Infinity;
    private ignoreScrollUntil = -Infinity;
    private geometryDirty = true;
    private settleDirty = false;
    private themeObserver?: MutationObserver;
    private resizeObserver?: ResizeObserver;
    private settleTimer: ReturnType<typeof setTimeout> | undefined;
    constructor(private view: EditorView) {
      this.ignoreScrollUntil = performance.now() + 100;
      this.lastScrollTop = view.scrollDOM.scrollTop;
      this.lastScrollLeft = view.scrollDOM.scrollLeft;
      this.untrackUser = trackUserScroll(view.scrollDOM);
      this.report(view);
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
      window.addEventListener('resize', this.geometryChanged);
      document.fonts?.addEventListener('loadingdone', this.geometryChanged);
      if (typeof MutationObserver !== 'undefined') {
        const root = document.documentElement;
        const theme = () => `${root.className}:${root.dataset.tone ?? ''}:${root.style.cssText}`;
        let previous = theme();
        this.themeObserver = new MutationObserver(() => {
          const current = theme();
          if (current !== previous) { previous = current; this.geometryChanged(); }
        });
        this.themeObserver.observe(root, { attributes: true, attributeFilter: ['class', 'data-tone', 'style'] });
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
      this.view.state.facet(blockHeightCache)?.invalidateLayout();
      heightMeasurements(this.view)?.measure();
      this.geometryDirty = true;
      this.scrolling = false;
      clearUserScroll(this.view.scrollDOM);
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
      // 只有用户发起的滚动才进入滚动占位模式；程序跳转/滚动锚补偿直接完整渲染。
      if (!userScrolledRecently(this.view.scrollDOM)) { this.report(this.view); return; }
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
      clearUserScroll(this.view.scrollDOM);
      this.ignoreScrollUntil = performance.now() + 100;
      this.settleDirty = true;
      this.report(this.view);
      this.view.scrollDOM.dispatchEvent(new Event('mdir-scroll-settle'));
    }
    update(u: ViewUpdate): void {
      notifyCmRestoreLayout(u.view);
      if (u.docChanged || u.geometryChanged) u.view.scrollDOM.dispatchEvent(new Event('md-layout'));
      if (u.docChanged) {
        this.lastEdit = performance.now(); this.scrolling = false; clearTimeout(this.settleTimer);
        // 键入探针按实时视口记录（旧 liveDeco ViewPlugin 口径：状态层读不到 view.viewport）。
        if (irPerfEnabled()) recordLiveDeco(Math.max(0, u.view.viewport.from - VIEWPORT_MARGIN), Math.min(u.view.state.doc.length, u.view.viewport.to + VIEWPORT_MARGIN));
      }
      if (u.viewportChanged) this.report(u.view);
      this.cancelFrame();
      const pending = u.state.field(projectionField).pending;
      if (pending && !u.state.field(compositionActive, false)) {
        const next = () => {
          this.frame = 0;
          if (!this.dead && u.view.state.field(projectionField).pending?.token === pending.token) {
            dispatchIrLayout(u.view, blockSliceReady.of(pending.token));
            measureAfterRender(u.view, () => { if (!this.dead) { u.view.lineBlockAtHeight(0); notifyCmRestoreLayout(u.view); } });
          }
        };
        this.frame = requestIrFrame(next, false, u.view);
      }
    }
    private cancelFrame(): void {
      cancelIrFrame(this.frame);
      this.frame = 0;
    }
    destroy(): void {
      this.dead = true; this.cancelFrame(); cancelIrFrame(this.reportFrame); clearTimeout(this.settleTimer); this.untrackUser();
      heightMeasurements(this.view)?.destroy();
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
      window.removeEventListener('resize', this.geometryChanged);
      document.fonts?.removeEventListener('loadingdone', this.geometryChanged);
      this.themeObserver?.disconnect(); this.resizeObserver?.disconnect();
    }
    private report(view: EditorView): void {
      if (this.pending) return;
      this.pending = true;
      this.reportFrame = requestIrFrame(() => {
        this.reportFrame = 0;
        this.pending = false;
        if (this.dead) return;
        const { from, to } = view.viewport, previous = view.state.field(projectionField);
        const geometryChanged = this.geometryDirty;
        const complete = geometryChanged || this.settleDirty;
        this.geometryDirty = false;
        this.settleDirty = false;
        if (complete || previous.from !== from || previous.to !== to || !!previous.deferred !== this.scrolling) {
          dispatchIrLayout(view, complete
            ? [liveViewport.of({ from, to, scrolling: false }), liveGeometryChanged.of(null)]
            : liveViewport.of({ from, to, scrolling: this.scrolling }));
          measureAfterRender(view, () => { if (!this.dead) { view.lineBlockAtHeight(0); notifyCmRestoreLayout(view); } });
        }
        if (complete) {
          if (geometryChanged) view.scrollDOM.dispatchEvent(new Event('mdir-layout-refresh'));
          view.requestMeasure();
        }
      }, false, view);
    }
  }
);

/** 即时渲染统一引擎装配（livepreview 以此替换 liveBlockField + viewportReporter + liveDeco 三件）。 */
export function mdViewEngine(): Extension {
  return [
    projectionField,
    EditorView.atomicRanges.of(view => view.state.field(projectionField).block.update({ filter: (_from, _to, value) => !!(value.spec.fence || value.spec.blockAtomic || (value as unknown as { widget?: WidgetType & { fence?: boolean } }).widget?.fence) })),
    mdViewOrchestrator,
  ];
}

// ── 查找高亮（FindBar「全部高亮」视口承载，自 live-block-field 搬移） ──

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
