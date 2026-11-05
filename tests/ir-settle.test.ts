// @vitest-environment jsdom
// 即时渲染「停稳不弹」整改回归锁（2026-10-30 阶段 2；真机判据见 tests/gates/gate-ir-settle.mjs）。
// 修前三处叠加：①CM6 滚动锚补偿引起的 scroll 被当成用户滚动→进占位→高度变→再补偿，往复回弹；
// ②公式滚动中换占位、停稳换回，三种高度（占位/加载态/成图）互不相同；③表格行高初值沿用旧紧凑样式 32px。
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markUserScroll, trackUserScroll, userScrolledRecently } from '../src/common/user-scroll';
import { RenderWidget } from '../src/markdown-view/live-widgets';
import { createRenderContext, rememberRenderHeight } from '../src/markdown-view/render-service';
import { Minimap } from '../src/text-view/minimap';
import { TABLE_ROW_ESTIMATE_PX } from '../src/markdown-view/layout';

afterEach(() => document.body.replaceChildren());

describe('用户滚动意图', () => {
  it('只有输入事件或显式登记才算用户滚动；纯 scroll 事件不算', () => {
    const el = document.createElement('div');
    const untrack = trackUserScroll(el);
    el.dispatchEvent(new Event('scroll'));
    expect(userScrolledRecently(el)).toBe(false); // 滚动锚补偿/程序跳转的 scroll
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 40 }));
    expect(userScrolledRecently(el)).toBe(true);
    untrack();
    const other = document.createElement('div');
    other.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(userScrolledRecently(other)).toBe(false);
    markUserScroll(other); // 缩略图拖动/自绘滚动条登记
    expect(userScrolledRecently(other)).toBe(true);
    expect(userScrolledRecently(other, -1)).toBe(false);
  });

  it('导航键算用户滚动，普通字符键不算', () => {
    const el = document.createElement('div');
    const untrack = trackUserScroll(el);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    expect(userScrolledRecently(el)).toBe(false);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
    expect(userScrolledRecently(el)).toBe(true);
    untrack();
  });

  it('缩略图单击不算拖动（孤立跳转按程序跳转完整渲染），按住移动才算', () => {
    const parent = document.createElement('div'); document.body.append(parent);
    const mm = new Minimap(parent, { scrollTop: () => 0, scrollHeight: () => 1000, clientHeight: () => 100, scrollTo: () => {},
      totalLines: () => 10, lineText: () => 'x', scrollToLine: () => {} });
    mm.root.dispatchEvent(new MouseEvent('mousedown', { clientY: 10 }));
    expect(mm.isDragging).toBe(false);
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 20 }));
    expect(mm.isDragging).toBe(true);
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(mm.isDragging).toBe(false);
    mm.remove();
  });
});

describe('块高度估计', () => {
  it('公式渲染过一次后，估计高度用实测值（换件/滚回/离屏估计零跳变）', () => {
    const doc = EditorState.create({ doc: 'a\n\n$$\nx^2\n$$\n' }).doc;
    const from = doc.line(3).from, to = doc.line(5).to;
    const block = { kind: 'math' as const, source: 'x^2', display: true, from, to };
    const context = createRenderContext([block]);
    const widget = new RenderWidget(block, doc, context);
    expect(widget.estimatedHeight).toBeCloseTo(3 * 21.6); // 保守托底：源行数×源行高
    rememberRenderHeight(block, context, 47.5);
    expect(new RenderWidget(block, doc, context).estimatedHeight).toBe(47.5);
    // 行内公式不记高度（随行排版）
    const inline = { ...block, display: false };
    rememberRenderHeight(inline, context, 99);
    expect(new RenderWidget(inline, doc, context).estimatedHeight).toBeCloseTo(3 * 21.6);
  });

  it('表格行高初值对齐当前表格样式（单元格 13px×2 内边距 + 20px 行高 + 边框）', () => {
    expect(TABLE_ROW_ESTIMATE_PX).toBeGreaterThanOrEqual(46);
    expect(TABLE_ROW_ESTIMATE_PX).toBeLessThanOrEqual(50);
  });
});
