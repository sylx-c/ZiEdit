// @vitest-environment jsdom
// 列模式根修验收（005 v2.0 / 审计 §2.6 第 1、2 层）：真建 EditorState/EditView（jsdom）。
// 核心红灯用例：allowMultipleSelections 缺失时多 range 被归并成 main range（AC-3 失效的根因）。
import { describe, expect, it, vi } from 'vitest';
import { EditorSelection } from '@codemirror/state';
import { EditView } from '../src/text-view/edit';
import { undo } from '@codemirror/commands';
import { deleteCharBackward } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { compositionChanged, compositionActive } from '../src/common/composition';
import {
  visualColOf,
  charAtVisualCol,
  rectSum,
  insertColumnChanges,
  rectPointerPlan,
  rectSelectionCleared,
  sortColumnBlock,
  dedupeColumnBlock,
  padColumnBlock,
  type RectSpan,
} from '../src/text-view/rect';

// jsdom 无布局：CM6 测量路径偶发 rAF 异步逃逸成未捕获异常（本文件不桩则时好时坏）
if (!(Range.prototype as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
}

/** 构造真 EditView（草稿路径，无 IPC 依赖）；等待 CM6 挂载完成 */
async function makeView(doc: string, opts: { prompt?: string } = {}): Promise<EditView> {
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
    onPrompt: opts.prompt != null ? () => Promise.resolve(opts.prompt!) : undefined,
    onConfirm: () => Promise.resolve(true),
    onAlert: () => {},
  });
  await gate;
  return view;
}

function range3(v: EditView, col: number): void {
  const doc = v.view.state.doc;
  v.view.dispatch({
    selection: EditorSelection.create(
      [1, 2, 3].map(n => {
        const l = doc.line(n);
        return EditorSelection.range(l.from + Math.min(col, l.length), l.from + Math.min(col, l.length));
      })
    ),
  });
}

describe('列命令独立撤销与键入矩形', () => {
  it('AC-27 稳定按列键升降整行、范围外不变且单步撤销', async () => {
    const original = 'outside\nb2 tail\na1 first\nc1 second\nend';
    const v = await makeView(original);
    const rect = { fromLine: 2, toLine: 4, colStart: 1, colEnd: 2 };
    v.applyColumnRectForTest(rect);
    v.cmdSortColumn();
    expect(v.view.state.doc.toString()).toBe('outside\na1 first\nc1 second\nb2 tail\nend');
    undo(v.view);
    expect(v.view.state.doc.toString()).toBe(original);
    v.applyColumnRectForTest(rect);
    v.cmdSortColumn(true);
    expect(v.view.state.doc.toString()).toBe(original); // already stable descending
    v.destroy();
  });
  it('AC-27 按列去重保留首次完整行并可撤销', async () => {
    const original = 'outside\na1 first\nb2 tail\nc1 second\nend';
    const v = await makeView(original);
    v.applyColumnRectForTest({ fromLine: 2, toLine: 4, colStart: 1, colEnd: 2 });
    v.cmdDedupeColumn();
    expect(v.view.state.doc.toString()).toBe('outside\na1 first\nb2 tail\nend');
    undo(v.view);
    expect(v.view.state.doc.toString()).toBe(original);
    v.destroy();
  });
  it('AC-28 固定右缘补齐含 CJK/Tab，长行保留，单步撤销', async () => {
    const original = '中\nx\n\tab\nlong text';
    const v = await makeView(original);
    v.applyColumnRectForTest({ fromLine: 1, toLine: 4, colStart: 0, colEnd: 6 });
    v.cmdPadColumn();
    expect(v.view.state.doc.toString()).toBe('中    \nx     \n\tab\nlong text');
    undo(v.view);
    expect(v.view.state.doc.toString()).toBe(original);
    v.destroy();
  });
  it('列纯函数：视觉列、空键、稳定性与非破坏输入', () => {
    const lines = ['中b tail', '中a first', '中a second', ''];
    expect(sortColumnBlock(lines, 2, 3)).toEqual(['', '中a first', '中a second', '中b tail']);
    expect(sortColumnBlock(lines, 2, 3, true)).toEqual(['中b tail', '中a first', '中a second', '']);
    expect(dedupeColumnBlock([...lines, 'x'], 2, 3)).toEqual(['中b tail', '中a first', '']);
    expect(padColumnBlock(['中', '\t', 'abcdef'], 4)).toEqual(['中  ', '\t', 'abcdef']);
    expect(lines[0]).toBe('中b tail');
  });
  it('零宽排序/去重不修改，补齐仍可执行', async () => {
    const v = await makeView('a\nb');
    v.applyColumnRectForTest({ fromLine: 1, toLine: 2, colStart: 3, colEnd: 3 });
    v.cmdSortColumn();
    v.cmdDedupeColumn();
    expect(v.view.state.doc.toString()).toBe('a\nb');
    v.cmdPadColumn();
    expect(v.view.state.doc.toString()).toBe('a  \nb  ');
    v.destroy();
  });
  it('AC-25 空列整列右移与虚拟列补齐，单步撤销', async () => {
    const v = await makeView('abcd\nx');
    v.applyColumnRectForTest({ fromLine: 1, toLine: 2, colStart: 2, colEnd: 4 });
    v.cmdInsertBlankColumn();
    expect(v.view.state.doc.toString()).toBe('ab  cd\nx   ');
    undo(v.view);
    expect(v.view.state.doc.toString()).toBe('abcd\nx');
    v.destroy();
  });
  it('AC-26 数字增减保留前导零、小数位、跨零与进位，跳过越界片段', async () => {
    const v = await makeView('009 -001 999 1.5\n123456');
    const rect = { fromLine: 1, toLine: 2, colStart: 0, colEnd: 16 };
    v.applyColumnRectForTest(rect);
    v.cmdChangeColumnNumbers(1);
    expect(v.view.state.doc.line(1).text).toBe('010 000 1000 2.5');
    undo(v.view);
    expect(v.view.state.doc.line(1).text).toBe('009 -001 999 1.5');
    v.applyColumnRectForTest({ ...rect, colEnd: 3 });
    v.cmdChangeColumnNumbers(-1);
    expect(v.view.state.doc.line(1).text).toBe('008 -001 999 1.5');
    expect(v.view.state.doc.line(2).text).toBe('123456');
    v.destroy();
  });
  it('AC-24 求和值复制并插入主光标，不替换选区，单步撤销', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const v = await makeView('12\n03');
    v.applyColumnRectForTest({ fromLine: 1, toLine: 2, colStart: 0, colEnd: 2 });
    const at = v.view.state.selection.main.head;
    await v.cmdSum(true);
    expect(writeText).toHaveBeenCalledWith('15');
    expect(v.view.state.doc.toString()).toBe('12\n03'.slice(0, at) + '15' + '12\n03'.slice(at));
    undo(v.view);
    expect(v.view.state.doc.toString()).toBe('12\n03');
    v.destroy();
  });
  it('AC-9 改写覆盖/行尾追加、退格与 IME 不冲突', async () => {
    const v = await makeView('abc');
    v.toggleOverwrite();
    const type = (text: string) => {
      const { from, to } = v.view.state.selection.main;
      return v.view.state.facet(EditorView.inputHandler).some(h => h(v.view, from, to, text, () => v.view.state.update(v.view.state.replaceSelection(text))));
    };
    expect(type('X')).toBe(true);
    expect(v.view.state.doc.toString()).toBe('Xbc');
    v.view.dispatch({ selection: { anchor: 3 } });
    type('Y');
    expect(v.view.state.doc.toString()).toBe('XbcY');
    deleteCharBackward(v.view);
    expect(v.view.state.doc.toString()).toBe('Xbc');
    v.view.dispatch({ effects: compositionChanged.of(true) });
    expect(v.view.state.field(compositionActive)).toBe(true);
    expect(type('中')).toBe(false);
    expect(v.view.state.doc.toString()).toBe('Xbc');
    v.view.dispatch({ effects: compositionChanged.of(false) });
    expect(type('Z')).toBe(true);
    v.destroy();
  });
  it('500ms 内连续列命令需要两次撤销', async () => {
    const v = await makeView('abc\ndef');
    const rect = { fromLine: 1, toLine: 2, colStart: 0, colEnd: 1 };
    v.applyColumnRectForTest(rect);
    v.cmdDelete();
    v.applyColumnRectForTest(rect);
    v.cmdDelete();
    expect(v.view.state.doc.toString()).toBe('c\nf');
    undo(v.view);
    expect(v.view.state.doc.toString()).toBe('bc\nef');
    undo(v.view);
    expect(v.view.state.doc.toString()).toBe('abc\ndef');
    v.destroy();
  });
  it('键入后保留新内容的同宽视觉矩形', async () => {
    const v = await makeView('abcd\nxy');
    v.applyColumnRectForTest({ fromLine: 1, toLine: 2, colStart: 1, colEnd: 3 });
    expect(v.typeInColumn('中')).toBe(true);
    expect(v.visualRectTextForTest()).toEqual(['中', '中']);
    expect(v.typeInColumn('Z')).toBe(true);
    expect(v.view.state.doc.toString()).toBe('aZd\nxZ');
    v.destroy();
  });
});

describe('AC-3 多 range 不被归并（allowMultipleSelections 根修，R8）', () => {
  it('三行各置一个光标，ranges 数保持 3（修复前被归并成 1）', async () => {
    const v = await makeView('hello ZiEdit\nthe quick brown\nerror appears');
    range3(v, 2);
    expect(v.view.state.selection.ranges.length).toBe(3);
    v.destroy();
  });

  it('多行同步输入：三行零宽光标键入 X，三行同列插入', async () => {
    const v = await makeView('hello ZiEdit\nthe quick brown\nerror appears');
    range3(v, 2);
    v.view.dispatch(v.view.state.replaceSelection('X'));
    const doc = v.view.state.doc;
    expect(doc.line(1).text).toBe('heXllo ZiEdit');
    expect(doc.line(2).text).toBe('thXe quick brown');
    expect(doc.line(3).text).toBe('erXror appears');
    v.destroy();
  });

  it('多 range 替换输入：三行 2-7 列矩形选中后键入 X 整块替换', async () => {
    const v = await makeView('hello ZiEdit\nthe quick brown\nerror appears');
    const doc = v.view.state.doc;
    v.view.dispatch({
      selection: EditorSelection.create([1, 2, 3].map(n => {
        const l = doc.line(n);
        return EditorSelection.range(l.from + 2, l.from + 7);
      })),
    });
    v.view.dispatch(v.view.state.replaceSelection('X'));
    expect(v.view.state.doc.line(1).text).toBe('heXiEdit');
    expect(v.view.state.doc.line(2).text).toBe('thXck brown');
    v.destroy();
  });
});

describe('AC-13 键盘扩展矩形（Alt+Shift+↓ 不再复制行）', () => {
  it('growColumnRect 向下两次：三行零宽矩形，键入同步三行；不复制行', async () => {
    const v = await makeView('hello ZiEdit\nthe quick brown\nerror appears\nfourth line');
    // 光标放第 1 行第 2 列（Alt+Shift+↓ 键位与 growColumnRect(1) 同一处理函数；
    // jsdom 不派发可信键盘事件，真机键位走查在 harness 复验）
    const l1 = v.view.state.doc.line(1);
    v.view.dispatch({ selection: { anchor: l1.from + 2 } });
    v.growColumnRect(1); // 首按：行 1-2 零宽
    v.growColumnRect(1); // 次按：行 1-3
    expect(v.view.state.selection.ranges.length).toBe(3);
    v.view.dispatch(v.view.state.replaceSelection('X'));
    const doc = v.view.state.doc;
    expect(doc.line(1).text).toBe('heXllo ZiEdit');
    expect(doc.line(3).text).toBe('erXror appears');
    // 第 4 行未被复制（Alt+Shift+↓ 曾触发 copyLineDown 把行复制三遍）
    expect(doc.line(4).text).toBe('fourth line');
    expect(doc.lines).toBe(4);
    v.destroy();
  });

  it('Escape 清矩形回单光标', async () => {
    const v = await makeView('aa\nbb\ncc');
    const l1 = v.view.state.doc.line(1);
    v.view.dispatch({ selection: { anchor: l1.from + 1 } });
    v.growColumnRect(1);
    v.growColumnRect(1);
    expect(v.view.state.selection.ranges.length).toBe(3);
    expect(v.escapeColumnRect()).toBe(true);
    expect(v.view.state.selection.ranges.length).toBe(1);
    expect(v.escapeColumnRect()).toBe(false); // 无矩形时放行默认行为
    v.destroy();
  });
});

describe('AC-14 视觉列（CJK 占 2 格）', () => {
  it('visualColOf / charAtVisualCol 互逆', () => {
    expect(visualColOf('中文a', 0)).toBe(0);
    expect(visualColOf('中文a', 1)).toBe(2);
    expect(visualColOf('中文a', 2)).toBe(4);
    expect(visualColOf('中文a', 3)).toBe(5);
    expect(charAtVisualCol('中文a', 0)).toBe(0);
    expect(charAtVisualCol('中文a', 1)).toBe(0); // 半格归左字符
    expect(charAtVisualCol('中文a', 2)).toBe(1);
    expect(charAtVisualCol('中文a', 4)).toBe(2);
    expect(charAtVisualCol('中文a', 99)).toBe(3); // 超行尾钳到末尾
  });

  it('applyColumnRect 用视觉列：中文行与英文行同视觉列对齐', async () => {
    const v = await makeView('abcdef\n中文行\nxy');
    // 矩形：行 1-3，视觉列 4-7（字符列口径下中文行会错位，视觉列口径应对齐）
    v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: 4, colEnd: 7 });
    v.typeInColumn('X');
    const doc = v.view.state.doc;
    // 英文行：视觉 [4,7) = 字符 [4,7) 'ef' → abcdX
    expect(doc.line(1).text).toBe('abcdX');
    // 中文行：视觉列 4 = 「中文」之后（中2格+文2格）；视觉列 7 超行宽 6 → 钳到行尾 → 中文X
    expect(doc.line(2).text).toBe('中文X');
    // 短行 xy：视觉列 4 超行尾 → 虚拟空格补齐（2 格）后插入
    expect(doc.line(3).text).toBe('xy  X');
    v.destroy();
  });
});

describe('AC-15 求和与对齐', () => {
  it('rectSum 忽略非数字片段', () => {
    expect(rectSum(['12 ab', 'x 3.5', '-7'])).toBe(8.5);
    expect(rectSum(['abc', 'def'])).toBe(null);
  });

  it('cmdSum：矩形内数字求和（经 flash 通道输出）', async () => {
    const flashes: string[] = [];
    let ready!: () => void;
    const gate = new Promise<void>(r => (ready = r));
    const v = new EditView(document.createElement('div'), {
      path: null, language: null, encoding: 'UTF-8', initialDoc: '12 ab\nx 3.5\n-7\n',
      onStatus: () => {}, onSaveAsNeeded: () => {}, onSaved: () => {}, onReady: ready,
      onFlash: m => flashes.push(m),
    });
    await gate;
    v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: 0, colEnd: 8 });
    await v.cmdSum();
    expect(flashes.length).toBe(1);
    expect(flashes[0]).toContain('8.5');
    v.destroy();
  });

  it('cmdAlign 右对齐：块内文本按最宽单元对齐', async () => {
    const v = await makeView('ab  \n  cd\nlong1');
    v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: 0, colEnd: 5 });
    v.cmdAlign('right');
    const doc = v.view.state.doc;
    expect(doc.line(1).text).toBe('   ab');
    expect(doc.line(2).text).toBe('   cd');
    expect(doc.line(3).text).toBe('long1');
    v.destroy();
  });
});

describe('AC-16 编号扩展（十六进制 / 末空行不编号）', () => {
  it.each([
    { doc: 'a\nb\nc', col: 0, prompt: '1,1,2', expected: '01a\n02b\n03c' },
    { doc: 'a\nb\nc', col: 6, prompt: '1,1,2', expected: 'a     01\nb     02\nc     03' },
    { doc: 'a\nb\nc', col: 0, prompt: '14,1,3,hex', expected: '00ea\n00fb\n010c' },
  ])('真实矩形编号分别保留前导零与虚拟列补齐：$prompt/$col', async ({ doc, col, prompt, expected }) => {
    const v = await makeView(doc, { prompt });
    try {
      v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: col, colEnd: col });
      await v.cmdNumbering();
      expect(v.view.state.doc.toString()).toBe(expected);
      v.cmUndo();
      expect(v.view.state.doc.toString()).toBe(doc);
    } finally { v.destroy(); }
  });
  it('cmdNumbering 十六进制 + pad', async () => {
    const v = await makeView('aaaa\nbbbb\ncccc', { prompt: '254,1,2,hex' });
    v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: 0, colEnd: 4 });
    await v.cmdNumbering();
    const doc = v.view.state.doc;
    expect(doc.line(1).text).toBe('fe');
    expect(doc.line(2).text).toBe('ff');
    expect(doc.line(3).text).toBe('100');
    v.destroy();
  });

  it('末空行不编号（其余行正常）', async () => {
    const v = await makeView('aaaa\nbbbb\n  ', { prompt: '1,1,1' });
    v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: 0, colEnd: 4 });
    await v.cmdNumbering();
    const doc = v.view.state.doc;
    expect(doc.line(1).text).toBe('1');
    expect(doc.line(2).text).toBe('2');
    expect(doc.line(3).text).toBe('  ');
    v.destroy();
  });
});

describe('AC-17 无矩形时插入/填充列（光标列到文末）', () => {
  it('insertColumnChanges：从起始行到文末，按光标列插入（短行补空格）', () => {
    const lines = ['ab', '', 'abcdef'];
    const ch = insertColumnChanges(2, 3, n => ({ from: n === 2 ? 3 : 4, text: lines[n - 1]! }), 'X', 3);
    // 行 2（空）补 3 空格 + X；行 3 在第 3 列前插入 X
    expect(ch).toEqual([
      { from: 3, to: 3, insert: '   X' },
      { from: 7, to: 7, insert: 'X' },
    ]);
  });
});

describe('AC-18 短行虚拟空格（矩形填充补齐）', () => {
  it('cmdFill 短行按 colStart 补空格后写入', async () => {
    const v = await makeView('ab\n\nabcd', { prompt: 'X' });
    v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: 4, colEnd: 7 });
    await v.cmdFill();
    const doc = v.view.state.doc;
    expect(doc.line(1).text).toBe('ab  X');
    expect(doc.line(2).text).toBe('    X');
    expect(doc.line(3).text).toBe('abcdX');
    v.destroy();
  });
});

// ---------------------------------------------------------------------------
// AC-11 右键不得清除矩形（v1.3 规则的根修，2026-10-16 H-6b）
// 缺陷：编辑态右键清矩形（浏览器把原生选区重置到点击点，CM 的 DOMObserver 异步回灌这条
// 选区变更——落地时 preserveRect 已被 mouseup/contextmenu 复位，矩形被当成"用户新选择"清掉；
// 实测「列操作 ▸ 求和选区」报"选区内没有可求和的数字"、对齐/填充静默无效）；
// 查看态右键同步清矩形（mousedown 分支不区分按键），「复制矩形选区」入口因此永不出现。
// ---------------------------------------------------------------------------
describe('AC-11 指针按下时的矩形处置（rectPointerPlan，005 规则 2/13 单一判决）', () => {
  it('右键：置保留位；矩形活动时阻止浏览器默认（避免原生选区被点击点重置后异步回灌）', () => {
    expect(rectPointerPlan(2, false, false, true)).toEqual({ drag: false, preserve: true, preventDefault: true, clear: false });
    expect(rectPointerPlan(2, true, false, false)).toEqual({ drag: false, preserve: true, preventDefault: false, clear: false });
  });
  it('左键 + 列模式/Alt：开始列拖拽（不清矩形）', () => {
    expect(rectPointerPlan(0, true, false, true)).toEqual({ drag: true, preserve: false, preventDefault: false, clear: false });
    expect(rectPointerPlan(0, false, true, false)).toEqual({ drag: true, preserve: false, preventDefault: false, clear: false });
  });
  it('左键普通点击：立即作废矩形（规则 13「单击清除」）', () => {
    expect(rectPointerPlan(0, false, false, true)).toEqual({ drag: false, preserve: false, preventDefault: false, clear: true });
  });
  it('中键：什么都不做（既不清矩形也不拖拽）', () => {
    expect(rectPointerPlan(1, true, false, true)).toEqual({ drag: false, preserve: false, preventDefault: false, clear: false });
  });
  it('选区变更作废判定：拖拽中/保留窗口内不作废', () => {
    expect(rectSelectionCleared(false, false)).toBe(true);
    expect(rectSelectionCleared(true, false)).toBe(false);
    expect(rectSelectionCleared(false, true)).toBe(false);
    expect(rectSelectionCleared(true, true)).toBe(false);
  });
});

describe('AC-11 EditView 实机口径：右键不清矩形', () => {
  async function withRect(): Promise<EditView> {
    const v = await makeView('hello ZiEdit\nthe quick brown\nerror appears\nfourth line');
    v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: 0, colEnd: 2 });
    return v;
  }
  const content = (v: EditView): HTMLElement => v.host.querySelector('.cm-content') as HTMLElement;
  const down = (v: EditView, button: number, altKey = false): MouseEvent => {
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button, altKey });
    content(v).dispatchEvent(e);
    return e;
  };

  it('矩形活动时右键：矩形仍在，且浏览器默认被阻止（不再把原生选区挪到点击点）', async () => {
    const v = await withRect();
    const e = down(v, 2);
    expect(v.hasColumnRect()).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(v.view.state.selection.ranges.length).toBe(3);
    v.destroy();
  });

  it('右键后矩形内容仍可求和/对齐（列命令读到的是记下的列宽，不是右键光标）', async () => {
    const v = await makeView('12 ab\nx 3.5\n-7 yy', { prompt: 'X' });
    v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: 0, colEnd: 2 });
    down(v, 2);
    const cells = v.visualRectTextForTest();
    expect(cells.map(s => s.trim())).toEqual(['12', 'x', '-7']);
    expect(rectSum(cells)).toBe(5); // 12 + (-7)：行 2 的 "x " 无数字片段（3.5 在矩形外）
    v.destroy();
  });

  it('左键普通点击：矩形作废（规则 13「单击清除」；默认行为交回 CM 常规选区）', async () => {
    const v = await withRect();
    down(v, 0);
    expect(v.hasColumnRect()).toBe(false);
    v.destroy();
  });

  it('中键：矩形不受影响', async () => {
    const v = await withRect();
    down(v, 1);
    expect(v.hasColumnRect()).toBe(true);
    v.destroy();
  });
});
