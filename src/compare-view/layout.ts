// compare-view/layout —— 对比视图的布局判决纯函数（008 规则 8/14/15，v0.4 重设计）
// 与 DOM 无关、可单测：折叠口径、上下文铺开、差异统计、差异块序号表。
// view.ts 只负责把它们落到 DOM，判决不写第二份。
import type { CmpBlock, CmpDetailLine } from '../common/ipc';

/** 相等段折叠阈值（008 规则 15）：>CTX_MAX 行折叠为「⋯ N 行相同」，≤CTX_MAX 行且被差异夹住则铺开作上下文 */
export const CTX_MAX = 2;

export const ROW_H = 20;
export const SKIP_H = 24;

/** 字号基准：settings.fontSize 出厂 12（001 规则 31 v2.5 行距派生的锚点） */
export const CMP_BASE_FS = 12;

/** 行高随字号派生（001 规则 31 v2.5 / 002 规则 12 v2.5：对比行距派生；基准 ROW_H@fs12，取整防行高漂移） */
export function cmpRowHeight(fs: number): number {
  return Math.round((ROW_H * fs) / CMP_BASE_FS);
}

/** 折叠行（「⋯ N 行相同」）高度随字号派生（基准 SKIP_H@fs12） */
export function cmpSkipHeight(fs: number): number {
  return Math.round((SKIP_H * fs) / CMP_BASE_FS);
}

/** 滚动区正文字号：styles.css .cmp-scroller 基准 12.5px@fs12（+0.5 偏移，出厂观感不变；styles.css 不动，行内覆盖） */
export function cmpFontPx(fs: number): number {
  return fs + 0.5;
}

/** 视图块 = 原块，或「短等值段铺开成上下文行」的派生标记 */
export type ViewKind = CmpBlock['kind'] | 'context';
export interface ViewBlock extends Omit<CmpBlock, 'kind'> {
  kind: ViewKind;
}
/** 统计与行数只读块的行区间，不关心视图派生类别 */
export type BlockLike = Omit<CmpBlock, 'kind'> & { kind: ViewKind };

/** 块占的显示行数（变更块取两侧较大者，缺失侧补空行） */
export function blockRows(b: BlockLike): number {
  const a = b.aEnd - b.aStart + 1;
  const bRows = b.bEnd - b.bStart + 1;
  return b.kind === 'equal' || b.kind === 'context' ? a : Math.max(a, bRows);
}

/** 短等值段铺开判决（规则 15）：≤CTX_MAX 行 **且** 两侧都被差异夹住（首/尾段照常折叠）。
 *  修前：任何相等段一律折叠成一行「N 行相同」，两处差异之间夹的 1–2 行也折，折叠行刷屏。 */
export function toViewBlocks(blocks: CmpBlock[]): ViewBlock[] {
  return blocks.map((b, i) =>
    b.kind === 'equal' &&
    blockRows(b) <= CTX_MAX &&
    i > 0 &&
    i < blocks.length - 1
      ? { ...b, kind: 'context' as const }
      : { ...b }
  );
}

export const isEqualish = (k: ViewKind): boolean => k === 'equal' || k === 'context';

/** 折叠判决：仅「仅差异」态、等值块（非上下文）、未被展开、行数 > CTX_MAX 时折叠 */
export function folded(kind: ViewKind, rows: number, onlyDiff: boolean, expanded: boolean): boolean {
  return kind === 'equal' && onlyDiff && !expanded && rows > CTX_MAX;
}

export interface DisplayBlock {
  blk: ViewBlock;
  idx: number;
  top: number;
  /** SKIP_H（折叠）或 rows×ROW_H */
  height: number;
  /** 折叠成一行时为 1，否则为实际行数 */
  rows: number;
}

/** 前缀和布局：块绝对定位（top/height），滚动总高 = 末块 bottom。
 *  rowH/skipH 随字号派生（001 规则 31 v2.5），缺省 = 出厂基准（ROW_H/SKIP_H），旧调用点签名不变。 */
export function layoutBlocks(
  blocks: ViewBlock[],
  onlyDiff: boolean,
  expanded: Set<number>,
  rowH: number = ROW_H,
  skipH: number = SKIP_H
): DisplayBlock[] {
  const display: DisplayBlock[] = [];
  let top = 0;
  blocks.forEach((blk, idx) => {
    const rows = blockRows(blk);
    const fold = folded(blk.kind, rows, onlyDiff, expanded.has(idx));
    const height = fold ? skipH : rows * rowH;
    display.push({ blk, idx, top, height, rows: fold ? 1 : rows });
    top += height;
  });
  return display;
}

export interface DiffStat {
  /** 替换（~）：受影响行取两侧较大者 */
  chg: number;
  /** 新增（+，仅 B 侧） */
  add: number;
  /** 删除（−，仅 A 侧） */
  del: number;
  /** 受影响总行数 = chg+add+del（同一差异块不双重计数） */
  affected: number;
}

export function diffStat(blocks: BlockLike[]): DiffStat {
  let chg = 0;
  let add = 0;
  let del = 0;
  for (const b of blocks) {
    if (b.kind === 'replace') chg += Math.max(b.aEnd - b.aStart + 1, b.bEnd - b.bStart + 1);
    else if (b.kind === 'insert') add += b.bEnd - b.bStart + 1;
    else if (b.kind === 'delete') del += b.aEnd - b.aStart + 1;
  }
  return { chg, add, del, affected: chg + add + del };
}

/** 差异块下标表（按文档顺序，索引为视图块下标）——导航 1-based 序号 ↦ 块下标 */
export function diffIdxList(blocks: ViewBlock[]): number[] {
  const out: number[] = [];
  blocks.forEach((b, i) => {
    if (!isEqualish(b.kind)) out.push(i);
  });
  return out;
}

/** 环绕步进（规则 14）：cur 为 1-based 当前序号（0=未定位），dir=±1 */
export function stepIndex(cur: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return 0;
  const base = cur || (dir > 0 ? 0 : 1);
  return (((base - 1 + dir) % total) + total) % total + 1;
}

/** 差异计数行文案数据（三层头 ①：「N 处差异 · M 行受影响」）。
 *  口径与导航表同源（isEqualish）：铺开的上下文块不是差异处——修前只排 equal，
 *  视图传入的 ViewBlock[] 里 context 会被计成差异（头显 7 / 导航显 1/4 自相矛盾）。 */
export function diffCounts(blocks: BlockLike[]): { diffs: number; affected: number } {
  return {
    diffs: blocks.filter(b => !isEqualish(b.kind)).length,
    affected: diffStat(blocks).affected,
  };
}

/** 行级类别 → 行/单元类名（编码=蓝、EOL 归「行尾空白」=绿，与 .cmp-row.cat-* / .cmp-tx.cat-* 同词汇） */
export function lineCatClass(cat: 'encoding' | 'eol' | null): string | null {
  return cat === 'encoding' ? 'cat-encoding' : cat === 'eol' ? 'cat-whitespace' : null;
}

/** 行级类别 → 过滤类别键（hiddenCats 口径；EOL 与行尾空白同类，规则 9 v0.4） */
export function lineCatKey(cat: 'encoding' | 'eol' | null): string | null {
  return cat === 'encoding' ? 'encoding' : cat === 'eol' ? 'whitespace' : null;
}

/** 行渲染分段（cat=null 渲染为纯文本；等值段与已过滤类别都走 null）。
 *  **空 spans 必须回退整行文本**：Rust 只对**配对行**跑 classify_line_pair（spans 覆盖全行），
 *  删除块 A 侧、插入块 B 侧、不等长替换的多出行都无 spans——修前视图只遍历 spans，
 *  这些行整行空白（删除/插入块看不到内容）。 */
export function lineParts(line: CmpDetailLine, side: 'a' | 'b'): { text: string; cat: string | null }[] {
  if (line.spans.length === 0) return [{ text: line.text, cat: null }];
  return line.spans.map(sp => ({
    text: side === 'a' ? sp.textA : sp.textB,
    cat: sp.eq ? null : sp.cat,
  }));
}

/** 布局总高（滚动区内容高度） */
export function totalHeight(display: DisplayBlock[]): number {
  const last = display[display.length - 1];
  return last ? last.top + last.height : 0;
}

/** 差异导航键位（单一来源：导航按钮提示与 ActionRegistry.shortcut 同引，001 规则 34 v2.4） */
export const NAV_SHORTCUTS = { prev: 'Alt+ArrowLeft', next: 'Alt+ArrowRight' } as const;

/** 和弦串 → 提示文本（'Alt+ArrowLeft' → 'Alt+←'） */
export function chordLabel(chord: string): string {
  return chord.replace('ArrowLeft', '←').replace('ArrowRight', '→');
}
