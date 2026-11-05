// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { pasteTable, safeCell, tableModel, limitTablePaste, parseTablePaste, TABLE_PASTE_LIMIT } from '../src/markdown-view/table-model';
import { cellRange } from '../src/markdown-view/table-editor';

it('同形状单行粘贴不改写其他行的原始空白', () => {
  const source = '|a| b  |\n|---|:---:|\n|c|d|\n| e  |f|';
  const view = new EditorView({ state: EditorState.create({ doc: source, extensions: [markdown({ extensions: GFM })] }) });
  try {
    expect(pasteTable(view, 0, 1, 0, [['changed']])).toBe(true);
    expect(view.state.doc.toString()).toBe('|a| b  |\n|---|:---:|\n| changed | d |\n| e  |f|');
  } finally { view.destroy(); }
});

it('表格粘贴按 UTF-8 预算截断且保留完整字符', () => {
  const limited = limitTablePaste('😀'.repeat(TABLE_PASTE_LIMIT / 4 + 1));
  expect(new TextEncoder().encode(limited).length).toBe(TABLE_PASTE_LIMIT);
  expect(limited.endsWith('😀')).toBe(true);
  expect(parseTablePaste('a\t' + 'x'.repeat(TABLE_PASTE_LIMIT))?.[0]?.[1]?.length).toBe(TABLE_PASTE_LIMIT - 2);
  expect(safeCell('one\r\ntwo')).toBe('one<br>two');
  expect(parseTablePaste('one\r\ntwo')).toEqual([['one<br>two']]);
});

for (const prefixes of [['- ', '  ', '  '], ['>>> ', '>>> ', '>>> '], ['> - ', '>   ', '>   ']]) {
  it(`保留容器前缀并逐字撤销 ${prefixes[0]}`, () => {
    const source = prefixes.map((p, i) => p + ['| a | b |', '|---|---|', '| c | d |'][i]).join('\n');
    const view = new EditorView({ state: EditorState.create({ doc: source, extensions: [markdown({ extensions: GFM }), history()] }) });
    try {
      const pos = source.indexOf('|');
      expect(tableModel(view.state, pos)?.rows[0]).toEqual(['a', 'b']);
      expect(pasteTable(view, pos, 1, 0, [['changed']])).toBe(true);
      expect(view.state.doc.toString().split('\n').map(l => l.slice(0, l.indexOf('|')))).toEqual(prefixes);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(source);
    } finally { view.destroy(); }
  });
}

it('按真实分隔符映射转义 pipe、非等宽空白与换行序列化后的格', () => {
  const view = new EditorView({ state: EditorState.create({ doc: '> - | a | b |\n>   |---|---|\n>   | x\\|y | z |', extensions: [markdown({ extensions: GFM }), history()] }) });
  const box = document.createElement('div'); box.dataset.mdTableFrom = '4';
  try {
    const text = (row: number, col: number) => { const r = cellRange(view, box, row, col)!; return view.state.doc.sliceString(r.from, r.to); };
    expect(text(1, 0)).toBe('x\\|y');
    expect(text(1, 1)).toBe('z');
    expect(pasteTable(view, 4, 1, 0, [[safeCell('one\ntwo|three')]])).toBe(true);
    expect(text(1, 0)).toBe('one<br>two\\|three');
    expect(text(1, 1)).toBe('z');
    const r = cellRange(view, box, 1, 0)!;
    view.dispatch({ changes: { ...r, insert: 'a | b' } });
    expect(text(1, 0)).toBe('a');
    expect(text(1, 1)).toBe('b');
  } finally { view.destroy(); }
});
