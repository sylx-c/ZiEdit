// REQ-014 P1（T008）：活动块集合计算单元测试——空光标、块边界与跨块选区三类场景
// （口径见 specs/001-markdown-ir-rewrite/data-model.md §1）。
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { editorMarkdown } from './editor-language';
import { activeBlocks, activeBlocksChanged } from './active-block';

const DOC = '# 标题\n\n段落一\n\n段落二\n';
// 索引：0'#' 1' ' 2'标' 3'题' 4'\n' 5'\n' 6'段' 7'落' 8'一' 9'\n' 10'\n' 11'段' 12'落' 13'二' 14'\n'
const HEADING = { from: 0, to: 4 };
const PARA1 = { from: 6, to: 9 };

function stateOf(doc: string, anchor: number, head = anchor) {
  let state = EditorState.create({ doc, extensions: [editorMarkdown()] });
  state = state.update({ selection: { anchor, head } }).state;
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

describe('REQ-014 T008：activeBlocks 计算', () => {
  it('空文档返回空集合', () => {
    expect(activeBlocks(stateOf('', 0))).toEqual([]);
  });

  it('空光标在标题内部：返回标题块（单元素，含 from/to/kind）', () => {
    const [block] = activeBlocks(stateOf(DOC, 2));
    expect(block).toBeDefined();
    expect(block!.from).toBe(HEADING.from);
    expect(block!.to).toBe(HEADING.to);
    expect(block!.kind).toBe('ATXHeading1');
  });

  it('空光标在段落内部：返回该段落块', () => {
    const [block] = activeBlocks(stateOf(DOC, 7));
    expect(block!.from).toBe(PARA1.from);
    expect(block!.to).toBe(PARA1.to);
    expect(block!.kind).toBe('Paragraph');
  });

  it('空光标在块边界（标题行尾）：恰返回一个块，区间为相邻直接子节点之一', () => {
    const blocks = activeBlocks(stateOf(DOC, HEADING.to));
    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(
      (block!.from === HEADING.from && block!.to === HEADING.to)
      || (block!.from === PARA1.from && block!.to === PARA1.to),
    ).toBe(true);
  });

  it('非空选区整体在单段内：返回该段一个块', () => {
    const blocks = activeBlocks(stateOf(DOC, 6, 9));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.from).toBe(PARA1.from);
    expect(blocks[0]!.to).toBe(PARA1.to);
  });

  it('非空选区跨标题与段落：按文档序返回全部相交块（跨块选区多块表达）', () => {
    const blocks = activeBlocks(stateOf(DOC, 2, 7));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.from).toBe(HEADING.from);
    expect(blocks[0]!.to).toBe(HEADING.to);
    expect(blocks[1]!.from).toBe(PARA1.from);
    expect(blocks[1]!.to).toBe(PARA1.to);
  });

  it('嵌套结构（列表）：空光标取最小包含的 Document 直接子节点（整个列表），非列表内部项', () => {
    const doc = '- 甲\n- 乙\n\n正文\n';
    const state = stateOf(doc, 2);
    const [block] = activeBlocks(state);
    expect(block!.kind).toBe('BulletList');
    expect(block!.from).toBe(0);
  });

  it('activeBlocksChanged：同块内光标移动不变化；跨块移动或选区扩展为变化', () => {
    const sameA = activeBlocks(stateOf(DOC, 6));
    const sameB = activeBlocks(stateOf(DOC, 8));
    expect(activeBlocksChanged(sameA, sameB)).toBe(false);
    const cross = activeBlocks(stateOf(DOC, 11));
    expect(activeBlocksChanged(sameA, cross)).toBe(true);
    const expanded = activeBlocks(stateOf(DOC, 2, 7));
    expect(activeBlocksChanged(sameA, expanded)).toBe(true);
    expect(activeBlocksChanged(expanded, expanded)).toBe(false);
  });
});
