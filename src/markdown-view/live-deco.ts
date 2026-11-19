// markdown-view/live-deco —— live preview 装饰入口（REQ-014 P1 起为投影器适配壳）。
// 核心投影逻辑已提取至 projector.ts（纯函数）；本文件只负责从视图状态装配 ProjectionLens
// 并计算视口余量。T010–T011 编排插件合并后本文件随旧引擎一并退役。
import { EditorView, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { inlineFormatField } from './writing';
import { referenceIndex, referenceField, referenceUrls, emojiField, mdTouchedField, VIEWPORT_MARGIN } from './live-state';
import { editingFence } from './live-widgets';
import { irWorkStart, recordIrWork } from './ir-perf';
import { projectViewport, type ProjectionLens } from './projector';

/**
 * live preview 装饰集：视口 ±VIEWPORT_MARGIN 内递归处理块排版，按行内元素判断源码展开。
 * 表格由直接状态装饰与单元格编辑器承载。
 */
export function buildLiveDeco(
  view: EditorView,
  baseDir: string | null,
  remoteResolve?: (url: string) => Promise<string | null>,
  bounds?: { from: number; to: number }
): DecorationSet {
  const started = irWorkStart();
  try {
    const state = view.state;
    const formatted = state.field(inlineFormatField, false);
    const lens: ProjectionLens = {
      ranges: state.selection.ranges,
      touched: state.field(mdTouchedField, false) === true,
      formatted: formatted ? { from: formatted.from, to: formatted.to, pending: formatted.pending } : null,
      // 惰性读取：裸 EditorState（无 emojiField 的调用方）只在正文确有 Emoji 节点时才触达该字段。
      get emojis() { return state.field(emojiField, false) ?? {}; },
      refs: () => referenceUrls(state),
      fenceEditing: pos => editingFence(state, pos),
    };
    const index = state.field(referenceField, false) ?? referenceIndex(state.doc);
    return projectViewport(state.doc, syntaxTree(state), {
      from: bounds?.from ?? Math.max(0, view.viewport.from - VIEWPORT_MARGIN),
      to: bounds?.to ?? Math.min(state.doc.length, view.viewport.to + VIEWPORT_MARGIN),
    }, index, lens, baseDir, remoteResolve);
  } finally { recordIrWork('liveDeco', started); }
}
