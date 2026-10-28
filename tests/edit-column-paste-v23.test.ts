// @vitest-environment jsdom
// 005 规则 5 v2.3「竖着复制、贴的还是横的」三断点根修回归锁（真建 EditorState/EditView）：
// ① 文末续行——修前 cmdPaste 单光标块粘贴 `maxOffset = min(parts.length, 文末余行)` 把超出
// 文档末行的粘贴行静默丢弃：光标在末行时只贴出第一行（用户主诉根因）；修后超出部分在
// 文末续行、新行先补空格对齐目标列位（通用编辑器口径），整块一次 dispatch 单步撤销。
// ② 剪贴板行尾归一——Windows 其他应用复制的多行文本带 CRLF，修前 text.split('\n') 不剥 \r，
// \r 混进内容导致列展开逐行错位；修后 readClipboardText 出口统一 CRLF/CR→LF，
// wasRectCopy 比对同口径归一（平台剪贴板 LF→CRLF 往返不再丢来源标记）。
// ③ 剪切补标记——修前 cmdCut（右键「列操作 ▸ 剪切列」）不像 cmCopy 调 markRectCopy，
// 剪切出的矩形块粘贴时判不出列来源；修后同补标记。
// v3.0 注（005 规则 5a）：语义矩阵判决收口 planColumnPaste，本文件裸单光标场景改走
// `{ force: true }`（右键「粘贴列」显式列意图——与既有断言同语义）；文末续行/列光标恢复
// 生成移至 rect.ts columnPasteChanges（源码契约锁随迁）。矩阵全表与 AC-19~22 见
// ac-005-column-paste-matrix.test.ts。
import { describe, expect, it, beforeEach } from 'vitest';
import { readClipboardText } from '../src/common/clipboard';
import { markRectCopy, wasRectCopy } from '../src/text-view/rect';
import { EditView } from '../src/text-view/edit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// jsdom 无布局：CM6 测量路径偶发 rAF 异步逃逸成未捕获异常（本文件不桩则时好时坏）
if (!(Range.prototype as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
}

// jsdom 环境下 import.meta.url 被改写为 http://，不能用 fileURLToPath；vitest 恒以仓库根为 cwd
const editSrc = readFileSync(join(process.cwd(), 'src', 'text-view', 'edit.ts'), 'utf8');
const rectSrc = readFileSync(join(process.cwd(), 'src', 'text-view', 'rect.ts'), 'utf8');

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

/** 剪贴板读写桩：readText 返回**未归一**的原始文本（模拟 Windows 其他应用复制的内容），
 *  writeText 捕获写出的文本（断言剪切/复制落剪贴板的内容）。 */
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

/** 光标落 (line, col)（单光标空选区——列粘贴判决的入口形态） */
function cursor(v: EditView, line: number, col: number): void {
  const l = v.view.state.doc.line(line);
  v.view.dispatch({ selection: { anchor: l.from + Math.min(col, l.length) } });
}

/** 排空 cmPaste/pasteColumnIfApplicable 的异步链（stub 全即时 resolve，宏任务一轮足够） */
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  markRectCopy(false); // rect.ts 模块级标记，逐例重置
});

describe('② readClipboardText 出口行尾归一（005 规则 5 v2.3）', () => {
  it('CRLF 与孤立 CR 统一归一为 LF', async () => {
    stubClipboard('aa\r\nbb\rc\nd');
    expect(await readClipboardText()).toBe('aa\nbb\nc\nd');
  });

  it('读失败仍返回空串（既有口径不变）', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        readText: async () => {
          throw new Error('denied');
        },
      },
      configurable: true,
    });
    expect(await readClipboardText()).toBe('');
  });
});

describe('① 文末续行：粘贴块行数超出文档末行不再截断（用户主诉根因）', () => {
  it('光标在末行（末行无尾换行）：块全部落地，续行补空格对齐目标列', async () => {
    const v = await makeView('alpha\nbeta');
    stubClipboard('X1\nY2\nZ3');
    cursor(v, 2, 2);
    await v.cmdPaste({ force: true });
    const doc = v.view.state.doc;
    expect(doc.lines).toBe(4); // 修前 2 行：Y2/Z3 被静默丢弃
    expect(doc.line(1).text).toBe('alpha');
    expect(doc.line(2).text).toBe('beX1ta');
    expect(doc.line(3).text).toBe('  Y2'); // 新行自列 0 起，补 2 空格对齐
    expect(doc.line(4).text).toBe('  Z3');
    v.destroy();
  });

  it('光标在中间行 + 后续短行补齐 + 多行续行：一次全部竖向对齐', async () => {
    const v = await makeView('aaaa\nbbbb\nc\ndd');
    stubClipboard('V\nW\nX\nY\nZ');
    cursor(v, 2, 3);
    await v.cmdPaste({ force: true });
    const doc = v.view.state.doc;
    expect(doc.lines).toBe(6);
    expect(doc.line(1).text).toBe('aaaa');
    expect(doc.line(2).text).toBe('bbbVb'); // 光标行第 3 列
    expect(doc.line(3).text).toBe('c  W'); // 短行先补 2 空格到第 3 列
    expect(doc.line(4).text).toBe('dd X');
    expect(doc.line(5).text).toBe('   Y'); // 续行对齐第 3 列
    expect(doc.line(6).text).toBe('   Z');
    v.destroy();
  });

  it('文档以换行结尾（末行为空）的边界：末空行照常落一行（补列位空格），续行接其后不加空行', async () => {
    const v = await makeView('aa\nbb\n'); // 行 3 为空（文末换行）
    stubClipboard('P\nQ\nR');
    cursor(v, 2, 1);
    await v.cmdPaste({ force: true });
    const doc = v.view.state.doc;
    expect(doc.lines).toBe(4); // 修前 3 行：R 被丢弃；续行不因末行已空而多出空行
    expect(doc.line(2).text).toBe('bPb');
    expect(doc.line(3).text).toBe(' Q'); // 末空行补 1 空格到第 1 列
    expect(doc.line(4).text).toBe(' R');
    v.destroy();
  });

  it('块行数未超文末时行为不变（回归：不新增空行）', async () => {
    const v = await makeView('aa\nbb\ncc');
    stubClipboard('X\nY');
    cursor(v, 2, 1);
    await v.cmdPaste({ force: true });
    const doc = v.view.state.doc;
    expect(doc.lines).toBe(3);
    expect(doc.line(2).text).toBe('bXb');
    expect(doc.line(3).text).toBe('cYc');
    v.destroy();
  });

  it('整块一次 dispatch = 单步撤销（005 规则 11：撤销粒度为一次列命令）', async () => {
    const v = await makeView('alpha\nbeta');
    stubClipboard('X1\nY2\nZ3');
    cursor(v, 2, 2);
    await v.cmdPaste({ force: true });
    expect(v.view.state.doc.lines).toBe(4);
    v.cmUndo();
    expect(v.view.state.doc.toString()).toBe('alpha\nbeta');
    v.cmRedo();
    expect(v.view.state.doc.line(4).text).toBe('  Z3');
    v.destroy();
  });
});

describe('② CRLF 剪贴板列展开不错位', () => {
  it('cmdPaste：CRLF 多行块按 LF 展开逐行落位，\\r 不混进内容', async () => {
    const v = await makeView('one\ntwo');
    stubClipboard('A\r\nB\r\nC');
    cursor(v, 2, 1);
    await v.cmdPaste({ force: true });
    const doc = v.view.state.doc;
    expect(doc.toString()).not.toContain('\r'); // 修前 parts=['A\r','B\r','C'] 逐行带 \r
    expect(doc.lines).toBe(4);
    expect(doc.line(2).text).toBe('tAwo');
    expect(doc.line(3).text).toBe(' B');
    expect(doc.line(4).text).toBe(' C');
    v.destroy();
  });

  it('cmPaste 全链路（Mod-v/菜单判决）：来源标记经 CRLF 往返不失守，仍按列展开', async () => {
    const v = await makeView('one\ntwo');
    stubClipboard('A\r\nB\r\nC'); // 平台把复制文本转成了 CRLF
    markRectCopy(true, 'A\nB\nC'); // 复制端记的是 LF（应用内恒 LF）
    cursor(v, 2, 1);
    v.cmPaste();
    await flush();
    await flush();
    const doc = v.view.state.doc;
    // 修前比对失配 → 回普通粘贴（整段横插 one\ntA\r\nB\r\nCwo）；修后列展开 + 文末续行
    expect(doc.toString()).not.toContain('\r');
    expect(doc.lines).toBe(4);
    expect(doc.line(2).text).toBe('tAwo');
    expect(doc.line(3).text).toBe(' B');
    expect(doc.line(4).text).toBe(' C');
    v.destroy();
  });
});

describe('③ cmdCut 剪切补来源标记（005 规则 5 v2.3）', () => {
  it('行为：矩形剪切后 wasRectCopy 判定为真（含 CRLF 剪贴板往返口径）', async () => {
    const v = await makeView('12\n34\n56');
    v.applyColumnRectForTest({ fromLine: 1, toLine: 3, colStart: 0, colEnd: 1 });
    const { written } = stubClipboard(''); // 读路径用不到；写路径捕获
    await v.cmdCut();
    expect(written).toEqual(['1\n3\n5']); // 补齐竖块（恒 LF）
    expect(wasRectCopy()).toBe(true); // 修前：cmdCut 不标记 → false，粘贴判不出列来源
    expect(wasRectCopy('1\n3\n5')).toBe(true);
    expect(wasRectCopy('1\r\n3\r\n5')).toBe(true); // 平台往返
    expect(v.view.state.doc.line(1).text).toBe('2'); // 剪切确已删列
    v.destroy();
  });

  it('行为：非矩形剪切（普通选区）不置位', async () => {
    const v = await makeView('12\n34\n56');
    const l2 = v.view.state.doc.line(2);
    v.view.dispatch({ selection: { anchor: l2.from, head: l2.from + 2 } });
    await v.cmdCut();
    expect(wasRectCopy()).toBe(false);
    v.destroy();
  });

  it('源码契约锁：cmdCut 在写剪贴板前调 markRectCopy（与 cmCopy 同款，早于 cmdDelete 清矩形）', () => {
    const m = /async cmdCut\(\): Promise<void> \{[\s\S]{0,900}?markRectCopy\(!!rect, text\);[\s\S]{0,200}?await writeClipboardText\(text\);[\s\S]{0,300}?this\.cmdDelete\(\);/.exec(editSrc);
    expect(m).toBeTruthy();
  });

  it('源码契约锁：块粘贴不再以 min 截断文末——续行以 \\n 前导追加在文档末尾且补列位空格（v3.0 生成移至 rect.ts）', () => {
    expect(editSrc).not.toMatch(/maxOffset/); // 截断变量已移除
    const m = /tailSegs = parts\.slice\(extraFrom\)\.map\(p => '\\n' \+ ' '\.repeat\(colStart\) \+ p\);[\s\S]{0,400}?changes\.push\(\{ from: ctx\.docLength, to: ctx\.docLength, insert: tailSegs\.join\(''\) \}\);/.exec(rectSrc);
    expect(m).toBeTruthy();
  });
});
