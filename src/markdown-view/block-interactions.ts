import { Prec } from '@codemirror/state';
import { EditorView, keymap, type Command } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { isolateHistory, cursorLineDown, cursorLineUp, selectLineDown, selectLineUp, cursorPageDown, cursorPageUp } from '@codemirror/commands';
import { isComposing } from '../common/composition';
import { tableAt } from './live-table-actions';
import { runTableOperation } from './table-model';

function fence(view: EditorView) {
  const { state } = view, pos = state.selection.main.head;
  for (const bias of [-1, 1] as const) {
    let node = syntaxTree(state).resolveInner(pos, bias);
    while (node.parent && node.name !== 'FencedCode') node = node.parent;
    if (node.name !== 'FencedCode') continue;
    const marks = node.getChildren('CodeMark');
    if (marks.length < 2) return null;
    const open = state.doc.lineAt(node.from), close = state.doc.lineAt(marks[marks.length - 1]!.from);
    return { node, open, close, from: Math.min(open.to + 1, close.from), to: Math.max(open.to + 1, close.from - 1) };
  }
  return null;
}

// 围栏是原子块替换件，默认垂直移动无法可靠跨过隐藏末行；边界显式落到源坐标。
function escape(view: EditorView, direction: -1 | 1, exit = false): boolean {
  if (isComposing(view) || !view.state.selection.main.empty) return false;
  const block = fence(view);
  if (!block) return false;
  const { doc } = view.state, line = doc.lineAt(view.state.selection.main.head);
  if (!exit && line.number !== (direction < 0 ? block.open.number + 1 : block.close.number - 1)) return false;
  let anchor: number;
  if (direction < 0) anchor = block.open.from > 0 ? block.open.from - 1 : block.open.from;
  else if (block.close.to < doc.length) anchor = block.close.to + 1;
  else if (exit && !view.state.readOnly) {
    view.dispatch({ changes: { from: doc.length, insert: '\n' }, selection: { anchor: doc.length + 1 },
      userEvent: 'input', annotations: isolateHistory.of('full'), scrollIntoView: true });
    return true;
  } else anchor = block.close.to;
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
  return true;
}

// ── 垂直移动跨原子块跳越（specs/003 方向键跨原子块导航）──
// 门禁实证（两引擎同败基线在案）：垂直移动目标落在块级原子域（渲染态表格/公式/分隔线，
// blockAtomic）边界时，CM6 把目标映射回边界本身——每键算出原地，光标在首个原子块前永久钉死。
// 修复语义（specs/003 data-model.md D1–D6）：基底命令照跑（保持默认行为与围栏逃逸优先），
// 头端原地不动且前进方向存在原子域时，跳到最近域边界之外继续；落点永不落入域内。

interface AtomicSpan { from: number; to: number }

/** 物化当前 atomicRanges（集内只有视口投影出的块级域，个位到几十条，逐键查询成本可忽略）。 */
function atomicSpans(view: EditorView, blockAtomicOnly: boolean): AtomicSpan[] {
  const out: AtomicSpan[] = [];
  for (const source of view.state.facet(EditorView.atomicRanges)) {
    source(view).between(0, view.state.doc.length, (from, to, value) => {
      if (to > from && (!blockAtomicOnly || value.spec.blockAtomic)) out.push({ from, to });
    });
  }
  return out;
}

/** 跳越落点收敛（D4）：落点若严格落入任一原子域内，沿方向推到域外；重叠域链式处理至稳定。 */
function settleTarget(spans: AtomicSpan[], target: number, dir: 1 | -1): number {
  for (let moved = true; moved;) {
    moved = false;
    for (const r of spans) {
      if (target > r.from && target < r.to) { target = dir > 0 ? r.to : r.from; moved = true; }
    }
  }
  return target;
}

/** 头端驻留 blockAtomic 边界（D3）：免基底直接跳到对侧边界（覆盖竞态/瞬态驻留，表格边界常驻有效）。 */
function boundaryResident(view: EditorView, head: number, dir: 1 | -1): number | null {
  const spans = atomicSpans(view, true);
  let target: number | null = null;
  for (const r of spans) {
    if (dir > 0 && r.from === head && (target === null || r.to > target)) target = r.to;
    else if (dir < 0 && r.to === head && (target === null || r.from < target)) target = r.from;
  }
  return target === null ? null : settleTarget(atomicSpans(view, false), target, dir);
}

/** 事后跳越目标（D1/D2）：向下取最小 to>head；向上取最大 from<head；无候选返回 null（文档边界合法驻留）。 */
function nearestBeyond(view: EditorView, head: number, dir: 1 | -1): number | null {
  const spans = atomicSpans(view, false);
  let target: number | null = null;
  for (const r of spans) {
    if (dir > 0 ? r.to > head : r.from < head) {
      if (target === null || (dir > 0 ? r.to < target : r.from > target)) target = dir > 0 ? r.to : r.from;
    }
  }
  return target === null ? null : settleTarget(spans, target, dir);
}

function jumpHead(view: EditorView, target: number): void {
  const main = view.state.selection.main;
  // 纯选区事务（D5）：select 变体保持锚点只移头端；不产生文档变更、不入撤销历史。
  view.dispatch(main.empty ? { selection: { anchor: target }, scrollIntoView: true }
    : { selection: { anchor: main.anchor, head: target }, scrollIntoView: true });
}

/**
 * 垂直跳越包装器（specs/003 contracts/arrow-atomic-navigation.md）：
 * ① IME 组合期放行（D6）；② 头端驻留 blockAtomic 边界直接跳越（D3）；③ 基底未处理且头端未动、
 * 前方存在原子域时仍跳越（翻页命令钉死时返回 false，透传会把「翻页」降级成纯滚动）；
 * ④ 基底已处理但头端不动 → 跳到方向上最近域边界之外（D1/D2）。导出工厂供建测试注入基底命令。
 */
export function makeVerticalSkip(base: Command, dir: 1 | -1): Command {
  return view => {
    if (isComposing(view)) return false;
    const head = view.state.selection.main.head;
    const resident = boundaryResident(view, head, dir);
    if (resident !== null) { jumpHead(view, resident); return true; }
    if (!base(view)) {
      const after = nearestBeyond(view, view.state.selection.main.head, dir);
      if (after !== null) { jumpHead(view, after); return true; }
      return false;
    }
    if (view.state.selection.main.head !== head) return true;
    const after = nearestBeyond(view, view.state.selection.main.head, dir);
    if (after !== null) jumpHead(view, after);
    return true;
  };
}

const arrowDownSkip = makeVerticalSkip(cursorLineDown, 1);
const arrowUpSkip = makeVerticalSkip(cursorLineUp, -1);
const selectDownSkip = makeVerticalSkip(selectLineDown, 1);
const selectUpSkip = makeVerticalSkip(selectLineUp, -1);
const pageDownSkip = makeVerticalSkip(cursorPageDown, 1);
const pageUpSkip = makeVerticalSkip(cursorPageUp, -1);

export const blockInteractions = Prec.highest(keymap.of([
  // 围栏逃逸优先；其后垂直移动进入跨原子块跳越（无原子域时与默认行为逐键一致）。
  { key: 'ArrowDown', run: view => escape(view, 1) || arrowDownSkip(view) },
  { key: 'ArrowUp', run: view => escape(view, -1) || arrowUpSkip(view) },
  { key: 'Shift-ArrowDown', run: selectDownSkip },
  { key: 'Shift-ArrowUp', run: selectUpSkip },
  { key: 'PageDown', run: pageDownSkip },
  { key: 'PageUp', run: pageUpSkip },
  { key: 'Mod-Enter', run: view => {
    if (isComposing(view)) return false;
    if (escape(view, 1, true)) return true;
    const table = tableAt(view, view.state.selection.main.head);
    if (!table || view.state.readOnly) return false;
    const sourceRow = table.rows.findIndex(row => view.state.selection.main.head <= row.lineTo);
    return !!runTableOperation(view, table.nodeFrom, Math.max(0, sourceRow - 1), 0, 'rowBelow');
  } },
  { key: 'Mod-a', run: view => {
    if (isComposing(view)) return false;
    const block = fence(view);
    if (!block) return false;
    const selection = view.state.selection.main;
    if (!selection.empty && selection.from <= block.node.from && selection.to >= block.node.to) return false;
    // 第二级选中完整围栏，删除时不会遗留空代码壳；第三级交回 CM 全文选择。
    const whole = selection.from === block.from && selection.to === block.to;
    view.dispatch({ selection: { anchor: whole ? block.node.from : block.from, head: whole ? block.node.to : block.to } });
    return true;
  } },
]));
