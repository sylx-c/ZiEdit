// REQ-014 P1（T010）：统一编排引擎五级 needsRebuild 调度单元测试（data-model.md §3）。
// 裸 EditorState 驱动 projectionField（同 height-oracle 口径）；挂载态零替换经 LivePreviewView 验证。
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { editorMarkdown } from './editor-language';
import { referenceField, emojiField } from './live-state';
import { projectionField, liveViewport } from './md-view-plugin';
import { TableEditWidget } from './table-widget';
import { loadMarkdownIt } from './md';

beforeAll(async () => { await loadMarkdownIt(); });

const DOC = '前文**粗体**段落\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后文*斜体*段落\n';
// 前文段落 0..4；表格 6..37；后文段落 39..43
const TABLE_FROM = DOC.indexOf('| a |');

function stateOf(doc = DOC) {
  let state = EditorState.create({ doc, extensions: [editorMarkdown(), referenceField, emojiField, projectionField] });
  state = state.update({ effects: liveViewport.of({ from: 0, to: doc.length }) }).state;
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function tableWidgetOf(state: ReturnType<typeof stateOf>): TableEditWidget | null {
  let widget: TableEditWidget | null = null;
  state.field(projectionField).block.between(0, state.doc.length, (_from, _to, deco) => {
    const w = deco.spec.widget;
    if (w instanceof TableEditWidget && widget === null) widget = w;
  });
  return widget;
}

describe('REQ-014 T010：五级 needsRebuild 调度', () => {
  it('级①视口内文档变更：同笔事务内同步完成整片重建（块级表格立即在场）', () => {
    const state = stateOf();
    const next = state.update({ changes: { from: 1, insert: '字' }, userEvent: 'input.type' }).state;
    const widget = tableWidgetOf(next);
    expect(widget).not.toBeNull();
    // 行内装饰同步在场（标题井号隐藏等价物：加粗 mark 在同事务后即可读）。
    expect(next.field(projectionField).inline.size).toBeGreaterThan(0);
  });

  it('级②视口变化：新视口重建，界外装饰收缩', () => {
    const state = stateOf();
    const next = state.update({ effects: liveViewport.of({ from: 0, to: DOC.indexOf('| 1 |') }) }).state;
    // 新界覆盖前半（表头在内）；表格装饰仍在（跨边界块整块保留口径）。
    expect(tableWidgetOf(next)).not.toBeNull();
    expect(next.field(projectionField).to).toBe(DOC.indexOf('| 1 |'));
  });

  it('级③ActiveBlocks 变化（空光标进表格）：表格装饰零替换（eq 相等，实例数据复用）', () => {
    const state = stateOf();
    const before = tableWidgetOf(state)!;
    // 空光标从后文段落移入表格块：Table 不在受追踪翻转集 → 块级零重建。
    const next = state.update({ selection: { anchor: TABLE_FROM + 2 } }).state;
    const after = tableWidgetOf(next)!;
    expect(after.eq(before)).toBe(true);
    expect(after).toBe(before); // 未重建时沿用同一实例（tables map 复用的直接证据）
  });

  it('级④同块内纯选区移动：行内更新、块级集合原样保留', () => {
    const state = stateOf();
    const before = tableWidgetOf(state)!;
    const next = state.update({ selection: { anchor: 1 } }).state; // 前文段内移动
    expect(tableWidgetOf(next)).toBe(before);
    expect(next.field(projectionField).inline.size).toBeGreaterThan(0);
  });

  it('级⑤纯滚动：已挂载表格保留（eq 相等 + 实例复用），不降级为占位', () => {
    const state = stateOf();
    const before = tableWidgetOf(state)!;
    const next = state.update({ effects: liveViewport.of({ from: 0, to: DOC.length, scrolling: true }) }).state;
    expect(tableWidgetOf(next)).toBe(before);
  });

  it('组合与回归：非空选区完整落在表格内时表格保留（eq 相等），覆盖式选区显源码（既有 selected 门）', () => {
    const state = stateOf();
    const before = tableWidgetOf(state)!;
    // 非空选区完整在表格内部：不触发 selected 外延门，表格照常渲染。
    const inside = state.update({ selection: { anchor: TABLE_FROM + 3, head: TABLE_FROM + 10 } }).state;
    const widget = tableWidgetOf(inside);
    expect(widget).not.toBeNull();
    expect(widget!.eq(before)).toBe(true);
    // 覆盖式选区（自表外跨到表外）：既有 selected 门显源码（与旧引擎同口径）。
    const covering = state.update({ selection: { anchor: 0, head: DOC.length } }).state;
    expect(tableWidgetOf(covering)).toBeNull();
  });
});
