// @vitest-environment jsdom
// 005-AC-19~22（规则 5a v3.0 列粘贴语义矩阵）：判决单一函数 planColumnPaste（rect.ts 纯函数
// 全表遍历）+ 执行器 columnPasteChanges（覆盖/列插入两义、文末续行、块少于目标行不追加、
// EOL 缓冲恒 LF、粘贴后列光标恢复同事务）+ EditView 全链路（cmdPaste/cmPaste/续列键入/一步撤销）
// + 零宽矩形三义（粘贴列插入、复制按普通光标、删除无操作）。
import { describe, expect, it, beforeEach } from 'vitest';
import {
  markRectCopy,
  planColumnPaste,
  columnPasteChanges,
  type RectSpan,
} from '../src/text-view/rect';
import { EditView } from '../src/text-view/edit';

// jsdom 无布局：Range.getClientRects 缺失会让 scrollIntoView 触发的 rAF 测量抛未捕获异常
// （本文件用例跨多次 await，视图存活期内 rAF 得以触发）。补空列表桩走 CM6 自带降级路径。
if (!(Range.prototype as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
}

/** 构造真 EditView（草稿路径，无 IPC 依赖）；等待 CM6 挂载完成 */
async function makeView(doc: string): Promise<EditView> {
  let ready!: () => void;
  const gate = new Promise<void>(r => (ready = r));
  const view = new EditView(document.createElement('div'), {
    path: null,
    language: null,
    encoding: 'UTF-8',
    initialDoc: doc,
    onStatus: () => {},
    onSaveAsNeeded: () => {},
    onSaved: () => {},
    onReady: ready,
    onConfirm: () => Promise.resolve(true),
    onAlert: () => {},
  });
  await gate;
  return view;
}

function stubClipboard(readRaw: string): { written: string[] } {
  const written: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      readText: async () => readRaw,
      writeText: async (t: string) => {
        written.push(t);
      },
    },
    configurable: true,
  });
  return { written };
}

function cursor(v: EditView, line: number, col: number): void {
  const l = v.view.state.doc.line(line);
  v.view.dispatch({ selection: { anchor: l.from + Math.min(col, l.length) } });
}

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  markRectCopy(false);
});

// ── AC-22：判决矩阵全表（planColumnPaste 纯函数） ──

describe('005-AC-22 planColumnPaste 判决矩阵全表', () => {
  const wide: RectSpan = { fromLine: 1, toLine: 3, colStart: 2, colEnd: 5 };
  const zero: RectSpan = { fromLine: 1, toLine: 3, colStart: 4, colEnd: 4 };
  const base = { columnMode: false, cursor: { line: 2, col: 3 } };

  it('矩形活动（有宽）恒覆盖——矩形块/普通多行/单行三来源同判（单行=一行块）', () => {
    for (const clip of ['ab\ncd', 'ab\ncd', 'ab']) {
      const p = planColumnPaste({ ...base, rect: wide, clipText: clip, clipIsRect: clip.includes('\n') });
      expect(p.kind).toBe('overwrite');
      if (p.kind === 'overwrite') expect(p.rect).toBe(wide);
    }
  });

  it('零宽矩形：多行列插入（来源不敏感）、单行列位普通插入', () => {
    expect(planColumnPaste({ ...base, rect: zero, clipText: 'ab\ncd', clipIsRect: true }).kind).toBe('columnInsert');
    expect(planColumnPaste({ ...base, rect: zero, clipText: 'ab\ncd', clipIsRect: false }).kind).toBe('columnInsert');
    const p = planColumnPaste({ ...base, rect: zero, clipText: 'ab', clipIsRect: false });
    expect(p).toEqual({ kind: 'plainAtCol', line: 1, col: 4, text: 'ab' });
  });

  it('单光标：列模式开或来源标记命中且多行 → 列插入；单行与其余 → 普通粘贴', () => {
    expect(planColumnPaste({ ...base, rect: null, clipText: 'a\nb', clipIsRect: false, columnMode: true }).kind).toBe('columnInsert');
    expect(planColumnPaste({ ...base, rect: null, clipText: 'a\nb', clipIsRect: true }).kind).toBe('columnInsert');
    expect(planColumnPaste({ ...base, rect: null, clipText: 'a', clipIsRect: true, columnMode: true }).kind).toBe('normal'); // 单行恒普通
    expect(planColumnPaste({ ...base, rect: null, clipText: 'a\nb', clipIsRect: false }).kind).toBe('normal');
  });

  it('来源标记中途失效（他copy覆盖剪贴板）→ 普通粘贴；force（显式粘贴列）免判决直列插入', () => {
    expect(planColumnPaste({ ...base, rect: null, clipText: '别的\n内容', clipIsRect: false }).kind).toBe('normal');
    expect(planColumnPaste({ ...base, rect: null, clipText: 'a\nb', clipIsRect: false, force: true }).kind).toBe('columnInsert');
  });

  it('多选区（无矩形）恒普通粘贴（交回 CM 原生逐行分发），列模式开也不列展开', () => {
    expect(planColumnPaste({ rect: null, columnMode: true, cursor: null, clipText: 'a\nb', clipIsRect: true }).kind).toBe('normal');
  });
});

// ── AC-22：执行器 columnPasteChanges（含块行数少于/超出目标行两分支） ──

describe('005-AC-22 columnPasteChanges 生成', () => {
  /** 简易行表：行 i(1 起) 的 from 偏移按 '\n' 连接计 */
  function ctxOf(lines: string[]) {
    let off = 0;
    const froms = lines.map(_ => 0);
    lines.forEach((text, i) => {
      froms[i] = off;
      off += text.length + 1;
    });
    return {
      lineAt: (n: number) => ({ from: froms[n - 1], text: lines[n - 1] }),
      totalLines: lines.length,
      docLength: lines.join('\n').length,
    };
  }

  it('块行数少于矩形行：只动块内行（不重复末行、不追加行）', () => {
    const p = { kind: 'columnInsert' as const, fromLine: 1, col: 2, parts: ['X', 'Y'] };
    const res = columnPasteChanges(p, ctxOf(['aaaa', 'bbbb', 'cccc', 'dddd']));
    expect(res.changes).toEqual([
      { from: 0 + 2, to: 0 + 2, insert: 'X' },
      { from: 5 + 2, to: 5 + 2, insert: 'Y' },
    ]); // 行 3/4 不动
    expect(res.rectAfter).toEqual({ fromLine: 1, toLine: 2, colStart: 3, colEnd: 3, cursorCols: [3, 3] });
    // 选区为新文档坐标（dispatch 时 CM6 以变更后坐标解释 selection）：行 2 起点因行 1 多 1 字符前移
    expect(res.selection.map(r => r.from)).toEqual([3, 9]);
  });

  it('覆盖：矩形行删窗口再插，块超出矩形行的部分同列插入延伸（删除只发生在矩形内）', () => {
    const rect: RectSpan = { fromLine: 1, toLine: 2, colStart: 1, colEnd: 3 };
    const res = columnPasteChanges({ kind: 'overwrite', rect, parts: ['XY', 'ZW', 'PQ'] }, ctxOf(['abcdef', 'ghij', 'klm', 'nop']));
    // 行1: [1,3)→XY；行2: [1,3)→ZW；行3（超矩形延伸行）: 列1纯插入 PQ
    expect(res.changes).toEqual([
      { from: 1, to: 3, insert: 'XY' },
      { from: 7 + 1, to: 7 + 3, insert: 'ZW' },
      { from: 12 + 1, to: 12 + 1, insert: 'PQ' },
    ]);
  });

  it('EOL：全部插入恒 \\n（CRLF 文档由保存侧统一回写），不含 \\r', () => {
    const res = columnPasteChanges(
      { kind: 'columnInsert', fromLine: 2, col: 1, parts: ['A', 'B', 'C'] },
      ctxOf(['x', 'yy'])
    );
    const all = res.changes.map(c => c.insert).join('');
    expect(all).not.toContain('\r');
    expect(all).toContain('\n B'); // 续行前导 \n + 列位空格（列 1 → 1 空格）
  });
});

// ── AC-19/20/21：EditView 全链路 ──

describe('005-AC-19 粘贴后列光标恢复（同事务一步撤销）', () => {
  it('覆盖粘贴后：零宽列光标于各行粘贴内容末尾；undo 单步回退；续键入仍按列', async () => {
    const v = await makeView('alpha\nbeta\ngamma');
    v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: 1, colEnd: 3 });
    stubClipboard('XY\nZW\nPQ');
    markRectCopy(true, 'XY\nZW\nPQ');
    await v.cmdPaste();
    let doc = v.view.state.doc;
    expect(doc.line(1).text).toBe('aXYha');
    expect(doc.line(2).text).toBe('bZWa'); // 'beta' 窗口 [1,3)='et' → 'b'+'ZW'+'a'
    expect(doc.line(3).text).toBe('gPQma');
    // 列光标：3 个零宽 range（= 块行数），各行落在粘贴内容末尾（列 3）
    const sel = v.view.state.selection;
    expect(sel.ranges).toHaveLength(3);
    sel.ranges.forEach((r, i) => {
      expect(r.from).toBe(r.to);
      expect(r.from).toBe(doc.line(i + 1).from + 3);
    });
    // 续列键入（typeInColumn 与 inputHandler 同源）：粘贴后列光标已恢复（rectAfter + preserveRect），仍按列生效
    expect(v.typeInColumn('Q')).toBe(true);
    doc = v.view.state.doc;
    expect(doc.line(1).text).toBe('aXYQha');
    expect(doc.line(2).text).toBe('bZWQa');
    expect(doc.line(3).text).toBe('gPQQma');
    // 同事务单步撤销：undo 一步回原文并还原粘贴前矩形选区（Text 不可变，重取快照）
    v.cmUndo();
    doc = v.view.state.doc;
    expect(doc.toString()).toBe('alpha\nbeta\ngamma');
    expect(
      v.view.state.selection.ranges.map(r => [r.from - doc.lineAt(r.from).from, r.to - doc.lineAt(r.from).from])
    ).toEqual([[1, 3], [1, 3], [1, 3]]); // 粘贴前的矩形选区
    v.cmRedo();
    doc = v.view.state.doc;
    // 粘贴与紧随键入在同 ms 内 dispatch 被 CM6 归并为一组：一步 undo/redo 同进同退（≤ 单步，符合 AC）
    expect(doc.line(1).text).toBe('aXYQha');
    // CM6 redo 把撤销时点的选区搬运进重放后的文档（startSelection 再基准化），不重放事务内选区
    expect(
      v.view.state.selection.ranges.map(r => [r.from - doc.lineAt(r.from).from, r.to - doc.lineAt(r.from).from])
    ).toEqual([[1, 3], [1, 3], [1, 3]]);
    v.destroy();
  });

  it('列插入粘贴后：各行光标在自身内容末尾，续键入不补空格对齐最宽行', async () => {
    const v = await makeView('aaaa\nbb\ncc');
    cursor(v, 1, 2);
    markRectCopy(true, 'XY\nW');
    stubClipboard('XY\nW');
    await v.cmdPaste();
    let doc = v.view.state.doc;
    expect(doc.line(1).text).toBe('aaXYaa');
    expect(doc.line(2).text).toBe('bbW'); // 'bb' 恰好已达列 2，无需补空格
    expect(doc.line(3).text).toBe('cc'); // 块 2 行只动前 2 行（语义②：不足目标行不外溢）
    // 右缘列 = 2 + max(2,1) = 4；range 逐行在粘贴内容末尾（列 4 / 列 3，零宽）
    const sel = v.view.state.selection;
    expect(sel.ranges).toHaveLength(2);
    expect(sel.ranges.map(r => r.from - doc.lineAt(r.from).from)).toEqual([4, 3]);
    expect(v.typeInColumn('Z')).toBe(true);
    doc = v.view.state.doc;
    expect(doc.line(1).text).toBe('aaXYZaa');
    expect(doc.line(2).text).toBe('bbWZ'); // 各行独立列位，不向最长块行补齐
    expect(doc.line(3).text).toBe('cc');
    v.destroy();
  });
});

describe('005-AC-20 EOL 保留（缓冲恒 LF；文末无尾换行不强加）', () => {
  it('CRLF 行尾块 + 文末续行：缓冲无 \\r；末行不以换行收尾时不强加尾换行', async () => {
    const v = await makeView('alpha\nbeta'); // 末行无尾换行
    cursor(v, 2, 2);
    markRectCopy(true, 'X1\nY2\nZ3');
    stubClipboard('X1\r\nY2\r\nZ3'); // 平台往返 CRLF
    await v.cmdPaste();
    const doc = v.view.state.doc;
    expect(doc.toString()).not.toContain('\r');
    expect(doc.lines).toBe(4);
    expect(doc.line(4).text).toBe('  Z3');
    expect(doc.toString().endsWith('Z3')).toBe(true); // 不强加尾换行
    v.destroy();
  });
});

describe('005-AC-21 零宽矩形三义（粘贴列插入/复制不产列块/删除无操作）', () => {
  it('粘贴：各行列位起插入不覆盖既有字符；块行数不足文末续行', async () => {
    const v = await makeView('aaaaaaaa\nbb\ncccccc\ndd');
    v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: 4, colEnd: 4 });
    markRectCopy(true, 'XY\nZW\nPQ\nRS');
    stubClipboard('XY\nZW\nPQ\nRS');
    await v.cmdPaste();
    const doc = v.view.state.doc;
    expect(doc.line(1).text).toBe('aaaaXYaaaa'); // 列 4 纯插入
    expect(doc.line(2).text).toBe('bb  ZW'); // 短行补空格到列 4
    expect(doc.line(3).text).toBe('ccccPQcc');
    expect(doc.line(4).text).toBe('dd  RS'); // 块第 4 行文末续行（列 4 对齐）
    v.destroy();
  });

  it('单行剪贴板：列位普通单行插入（首行、矩形不保留）', async () => {
    const v = await makeView('aaaa\nbbbb');
    v.applyColumnRectForTest({ fromLine: 1, toLine: 2, colStart: 4, colEnd: 4 });
    stubClipboard('NEW');
    await v.cmdPaste();
    const doc = v.view.state.doc;
    expect(doc.line(1).text).toBe('aaaaNEW'); // 列 4=行尾，直接接上
    expect(doc.line(2).text).toBe('bbbb'); // 只动首行
    const sel = v.view.state.selection;
    expect(sel.ranges).toHaveLength(1); // 普通粘贴语义：单光标
    expect(sel.main.head).toBe(doc.line(1).from + 7);
    v.destroy();
  });

  it('复制：零宽矩形 Ctrl+C 按普通光标复制（主光标行 + 行尾换行，不产出空行块）', async () => {
    const v = await makeView('12\n34\n56');
    v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: 1, colEnd: 1 });
    const { written } = stubClipboard('');
    v.cmCopy();
    expect(written).toEqual(['12\n']);
    expect(markRectCopy(false) === undefined).toBe(true);
    expect(await import('../src/text-view/rect').then(m => m.wasRectCopy())).toBe(false); // 不置列来源标记
    v.destroy();
  });

  it('删除：零宽矩形上删除键无操作且矩形保留（后续粘贴仍按列插入）', async () => {
    const v = await makeView('12\n34\n56');
    v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: 1, colEnd: 1 });
    v.cmdDelete();
    expect(v.view.state.doc.toString()).toBe('12\n34\n56');
    markRectCopy(true, 'XY\nZW');
    stubClipboard('XY\nZW');
    await v.cmdPaste();
    expect(v.view.state.doc.line(1).text).toBe('1XY2');
    v.destroy();
  });

  it('cmPaste 全链路（Mod-v/右键粘贴判决）：零宽矩形 → 列插入', async () => {
    const v = await makeView('aaaa\nbb');
    v.applyColumnRectForTest({ fromLine: 1, toLine: 2, colStart: 2, colEnd: 2 });
    markRectCopy(true, 'XY\nZW');
    stubClipboard('XY\nZW');
    v.cmPaste();
    await flush();
    await flush();
    const doc = v.view.state.doc;
    expect(doc.line(1).text).toBe('aaXYaa');
    expect(doc.line(2).text).toBe('bbZW');
    v.destroy();
  });
});
