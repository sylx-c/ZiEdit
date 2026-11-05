// AC-17（007 v0.8 规则 17）：CM6 格式命令语义——包裹 toggle / 行前缀逐行 toggle + ol 重编号 /
// 模板插入 / 多 range 偏移 / 单次变更集合（单步撤销的前提）。
// 另覆盖 extractHeadings 行号与围栏跳过（预览 data-line 注入的数据源，AC-16）。
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { applyFormat } from '../src/markdown-view/mdformat';
import { extractHeadings } from '../src/markdown-view/preview';

function fmt(doc: string, sel: [number, number][], cmd: Parameters<typeof applyFormat>[2]): string {
  const state = EditorState.create({ doc });
  const r = applyFormat(state.doc, sel.map(([from, to]) => ({ from, to })), cmd);
  return state.update({ changes: r.changes }).state.doc.toString();
}

describe('AC-17 包裹类 toggle', () => {
  it('反复命令识别选区外定界符，不累计星号', () => {
    let state = EditorState.create({ doc: 'word' });
    for (const expected of ['**word**', 'word', '**word**', 'word']) {
      const sel = state.selection.main;
      const ranges = state.doc.length === 4 ? [{ from: 0, to: 4 }] : [{ from: sel.from, to: sel.to }];
      const result = applyFormat(state.doc, ranges, 'bold');
      state = state.update({ changes: result.changes, selection: result.selection[0] }).state;
      expect(state.doc.toString()).toBe(expected);
    }
  });
  it('有选区：加粗包裹', () => {
    expect(fmt('abc', [[1, 3]], 'bold')).toBe('a**bc**');
  });
  it('已包裹：再按去除并保留选区语义', () => {
    expect(fmt('a**bc**d', [[1, 7]], 'bold')).toBe('abcd');
  });
  it('空选区：成对定界符（inlineCode 例）', () => {
    expect(fmt('ab', [[1, 1]], 'inlineCode')).toBe('a``b');
    expect(fmt('ab', [[1, 1]], 'bold')).toBe('a****b');
  });
  it('多 range（列模式）：偏移按序累计', () => {
    expect(fmt('axb ayc', [[1, 2], [5, 6]], 'bold')).toBe('a**x**b a**y**c');
  });
});

describe('AC-17 行前缀类', () => {
  it.each([['h1', '# '], ['ul', '- '], ['ol', '1. '], ['quote', '> '], ['task', '- [ ] ']] as const)('行首取消%s时光标钳制到正文', (cmd, prefix) => {
    const state = EditorState.create({ doc: prefix + 'body' });
    const result = applyFormat(state.doc, [{ from: 0, to: 0 }], cmd);
    const next = state.update({ changes: result.changes, selection: result.selection[0] }).state;
    expect(next.doc.toString()).toBe('body'); expect(next.selection.main.head).toBe(0);
  });
  it.each(['ul', 'ol', 'task'] as const)('普通段落后建立空%s保持独立块', cmd => {
    expect(fmt('Title\n', [[6, 6]], cmd)).toMatch(/^Title\n\n/);
  });
  it('标题：加前缀', () => {
    expect(fmt('hello', [[0, 5]], 'h1')).toBe('# hello');
  });
  it('标题：同级再按取消', () => {
    expect(fmt('## hello', [[0, 8]], 'h2')).toBe('hello');
  });
  it('标题：升降级（h1 → h3 互斥替换）', () => {
    expect(fmt('# hello', [[0, 7]], 'h3')).toBe('### hello');
  });
  it('引用与列表互斥：引用行按无序列表先剥引用', () => {
    expect(fmt('> hello', [[0, 7]], 'ul')).toBe('- hello');
  });
  it('无序列表再按取消', () => {
    expect(fmt('- hello', [[0, 7]], 'ul')).toBe('hello');
  });
  it('任务列表再按取消', () => {
    expect(fmt('- [x] hello', [[0, 11]], 'task')).toBe('hello');
  });
  it('有序列表：多行重编号 1..n', () => {
    expect(fmt('a\nb\nc', [[0, 5]], 'ol')).toBe('1. a\n2. b\n3. c');
  });
  it('跨行选区只影响覆盖行', () => {
    expect(fmt('a\nb\nc', [[2, 5]], 'quote')).toBe('a\n> b\n> c');
  });
  it('缩进列表项取消/切换保留层级缩进，缩进不被剥掉', () => {
    expect(fmt('  - hello', [[0, 9]], 'ul')).toBe('  hello');
    expect(fmt('  - hello', [[0, 9]], 'ol')).toBe('  1. hello');
    expect(fmt('  > hi', [[0, 6]], 'quote')).toBe('  hi');
    expect(fmt('  # 题', [[0, 5]], 'h1')).toBe('  题');
    expect(fmt('    code', [[0, 8]], 'ul')).toBe('-     code');
  });
});

describe('AC-17 插入类', () => {
  it('段落中建代码块保持前后正文，选区含围栏时加长定界符', () => {
    expect(fmt('prefix suffix', [[6, 6]], 'codeBlock')).toBe('prefix\n```\n\n```\n suffix');
    expect(fmt('```', [[0, 3]], 'codeBlock')).toBe('````\n```\n````');
  });
  it('代码块：空选区模板光标在块内', () => {
    const state = EditorState.create({ doc: '' });
    const r = applyFormat(state.doc, [{ from: 0, to: 0 }], 'codeBlock');
    expect(state.update({ changes: r.changes }).state.doc.toString()).toBe('```\n\n```');
    expect(r.selection[0].anchor).toBe(4);
  });
  it('链接：选区作锚文本并选中 url 占位符', () => {
    const state = EditorState.create({ doc: 'example' });
    const r = applyFormat(state.doc, [{ from: 0, to: 7 }], 'link');
    expect(state.update({ changes: r.changes }).state.doc.toString()).toBe('[example](url)');
    expect(r.selection[0].anchor).toBe(10);
    expect(r.selection[0].head).toBe(13);
  });
  it('表格：GFM 3×3 模板，光标落首格待填位置', () => {
    const state = EditorState.create({ doc: '' });
    const r = applyFormat(state.doc, [{ from: 0, to: 0 }], 'table');
    const out = state.update({ changes: r.changes }).state.doc.toString();
    expect(out).toContain('| --- | --- | --- |');
    expect((out.match(/\n/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(r.selection[0]).toEqual({ anchor: 2, head: 2 });
    expect(out.slice(0, 6)).toBe('| 列1 |');
  });
  it('表格：段落中间插入时空行分隔，后文不被并入表格', () => {
    const state = EditorState.create({ doc: '**原文**' });
    const r = applyFormat(state.doc, [{ from: 3, to: 3 }], 'table');
    const out = state.update({ changes: r.changes }).state.doc.toString();
    expect(out.startsWith('**原\n\n| 列1 |')).toBe(true);
    expect(out.endsWith('|\n\n文**')).toBe(true);
    expect(r.selection[0]).toEqual({ anchor: 3 + 2 + 2, head: 3 + 2 + 2 }); // 前缀\n\n后首格起点
  });
  it('表格：行尾插入且下行非空时上下各补空行', () => {
    const state = EditorState.create({ doc: '上文\n下文' });
    const r = applyFormat(state.doc, [{ from: 2, to: 2 }], 'table'); // 「上文」行尾
    const out = state.update({ changes: r.changes }).state.doc.toString();
    expect(out.startsWith('上文\n\n| 列1 |')).toBe(true);
    expect(out.endsWith('|\n\n下文')).toBe(true); // after补一个\n，与原换行合成空行
  });
  it('表格：行首插入且上行为空行时不重复补空行', () => {
    const state = EditorState.create({ doc: '上文\n\n下文' });
    const r = applyFormat(state.doc, [{ from: 4, to: 4 }], 'table'); // 「下文」行首
    const out = state.update({ changes: r.changes }).state.doc.toString();
    expect(out.startsWith('上文\n\n| 列1 |')).toBe(true);
    expect(out.endsWith('|\n\n下文')).toBe(true);
  });
});

describe('AC-17 单次变更集合', () => {
  it('多行行前缀输出为一个 changes 数组（单 dispatch 单步撤销前提）', () => {
    const state = EditorState.create({ doc: 'a\nb\nc' });
    const r = applyFormat(state.doc, [{ from: 0, to: 5 }], 'ul');
    expect(r.changes.length).toBe(3);
  });
});

describe('AC-16 extractHeadings（迁 preview.ts，带行号）', () => {
  it('Setext 标题和嵌套引用标题可提取，围栏内伪 Setext 不算', () => {
    const hs = extractHeadings('Title\n=====\n\nSub\n---\n\n> ## Quote\n\n```\nFake\n===\n```');
    expect(hs.map(h => [h.level, h.text, h.line])).toEqual([[1,'Title',0],[2,'Sub',3],[2,'Quote',6]]);
  });
  it('行号字段与围栏跳过', () => {
    const mdText = '# A\n\ntext\n```md\n# fake\n```\n## B';
    const hs = extractHeadings(mdText);
    expect(hs.map(h => [h.text, h.line])).toEqual([['A', 0], ['B', 6]]);
  });
});
