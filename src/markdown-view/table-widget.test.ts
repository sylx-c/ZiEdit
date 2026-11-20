// REQ-014 P5（T027）：TableEditWidget 单元测试——坐标、写回、阈值
// （data-model.md §4；挂载态交互已由迁移后的 ir-table/writing/ime/input-order 套件覆盖，
//  本文件锁纯函数与阈值边界）。
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { EditorState, type Range, type Text } from '@codemirror/state';
import { EditorView, Decoration } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { editorMarkdown } from './editor-language';
import { cellRange } from './table-widget';
import { tableDecos } from './projector';
import { safeCell, tableRowPrefix } from './table-model';
import { loadMarkdownIt } from './md';
import type { SyntaxNode } from '@lezer/common';

beforeAll(async () => { await loadMarkdownIt(); });

const DOC = '前文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后文\n';

function mountState(doc = DOC) {
  const state = EditorState.create({ doc, extensions: [editorMarkdown()] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function tableDecosOf(state: ReturnType<typeof mountState>): Range<Decoration>[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
  let table: SyntaxNode | null = tree.topNode.firstChild;
  while (table && table.name !== 'Table') table = table.nextSibling;
  expect(table).not.toBeNull();
  const out: Range<Decoration>[] = [];
  const node = table!;
  tableDecos(
    { get from() { return node.from; }, get to() { return node.to; }, get node() { return node; } } as never as Parameters<typeof tableDecos>[0],
    state.doc as Text,
    out,
    null,
    new Map(),
    {},
    null,
  );
  return out;
}

describe('REQ-014 T027：cellRange 坐标（data-model.md §4 TableEditWidget.data-row/data-col 语义）', () => {
  it('row=0 表头、row≥1 数据行；含转义竖线的首格', () => {
    const view = new EditorView({ state: mountState('| a \\| x | b |\n| --- | --- |\n| 1 | 2 |') });
    const box = document.createElement('div');
    box.dataset.mdTableFrom = '0';
    const r0 = cellRange(view, box, 0, 0)!;
    expect(view.state.doc.sliceString(r0.from, r0.to)).toBe('a \\| x');
    const r1 = cellRange(view, box, 0, 1)!;
    expect(view.state.doc.sliceString(r1.from, r1.to)).toBe('b');
    const r2 = cellRange(view, box, 1, 1)!;
    expect(view.state.doc.sliceString(r2.from, r2.to)).toBe('2');
    view.destroy();
  });
  it('越界返回 null（行/列超出表）', () => {
    const view = new EditorView({ state: mountState() });
    const box = document.createElement('div');
    box.dataset.mdTableFrom = String(DOC.indexOf('|'));
    expect(cellRange(view, box, 9, 0)).toBeNull();
    expect(cellRange(view, box, 0, 5)).toBeNull();
    view.destroy();
  });
});

describe('REQ-014 T027：>500 行退化（REQ-014.8 阈值）', () => {
  it('501 行数据表不产挂件（源码显示），500 行照常', () => {
    const rows500 = Array.from({ length: 500 }, (_, i) => `| a${i} | b${i} |`).join('\n');
    const rows501 = Array.from({ length: 501 }, (_, i) => `| a${i} | b${i} |`).join('\n');
    expect(tableDecosOf(mountState('| h1 | h2 |\n| --- | --- |\n' + rows501 + '\n'))).toHaveLength(0);
    const ok = tableDecosOf(mountState('| h1 | h2 |\n| --- | --- |\n' + rows500));
    expect(ok).toHaveLength(1);
    expect(ok[0]!.value.spec.widget).toBeInstanceOf(Object);
    expect((ok[0]!.value.spec.widget as { constructor: { name: string } }).constructor.name).toBe('TableEditWidget');
  });
});

describe('REQ-014 T027：safeCell 写回语义（撤销恢复单格的基础）', () => {
  it('竖线转义、换行归一（首尾空白保持源格式）', () => {
    expect(safeCell('a | b')).toBe('a \\| b');
    expect(safeCell('a\nb')).toBe('a<br>b');
  });
  it('tableRowPrefix 前缀长度与 cellRange 联动（引用表前缀不写回格）', () => {
    expect(tableRowPrefix('> | a |')).toBe('> ');
    expect(tableRowPrefix('| a |')).toBe('');
  });
});
