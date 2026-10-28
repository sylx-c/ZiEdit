// 008-AC-11/12/13 比较视图重设计回归锁（P3-23，008 v0.4）：
// 差异导航/折叠/统计三判决 + 视觉契约。
// 本文件锁三件容易漂移的判决与一整套视觉契约：
// 1) 折叠口径（规则 15）：≤2 行的等值段夹在差异之间不折叠（铺开作上下文），≥3 行折叠；
// 首/尾等值段不享受铺开（免取消折叠后又一路铺开到底）；
// 2) 差异统计（规则 8）：替换取两侧较大行数、插入数 B 侧、删除数 A 侧，受影响行数不双计；
// 3) 差异导航（规则 14）：1-based 序号环绕步进（首→退=末、末→进=首、未定位→进=首）；
// 4) 类别隐藏对象完整（规则 9 v0.4）：行级类别被隐藏时行底色与中缝徽标一并撤下；
// 5) 源码/CSS 契约锁：单一来源键位（NAV_SHORTCUTS 禁字面量回漂）、--cmp-top 头高驱动
// （修前写死 34px，三层头一上就错位）、色轨/斜纹/双通道下划线/概览视口框等视觉条款。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CTX_MAX,
  NAV_SHORTCUTS,
  ROW_H,
  SKIP_H,
  blockRows,
  chordLabel,
  diffCounts,
  diffIdxList,
  diffStat,
  lineCatClass,
  lineCatKey,
  layoutBlocks,
  lineParts,
  stepIndex,
  toViewBlocks,
  totalHeight,
  type ViewBlock,
} from '../src/compare-view/layout';
import type { CmpBlock, CmpDetailLine } from '../src/common/ipc';
import { dict, tf } from '../src/common/i18n';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

// 块构造：aEnd/aStart-1 = 该侧无行（与 Rust 侧 diff 块的表示同口径）
const eq = (aStart: number, n: number, bStart = aStart): CmpBlock => ({
  kind: 'equal',
  aStart,
  aEnd: aStart + n - 1,
  bStart,
  bEnd: bStart + n - 1,
});
const rep = (aStart: number, aN: number, bStart: number, bN: number): CmpBlock => ({
  kind: 'replace',
  aStart,
  aEnd: aStart + aN - 1,
  bStart,
  bEnd: bStart + bN - 1,
});
const del = (aStart: number, n: number): CmpBlock => ({
  kind: 'delete',
  aStart,
  aEnd: aStart + n - 1,
  bStart: 1,
  bEnd: 0,
});
const ins = (bStart: number, n: number): CmpBlock => ({
  kind: 'insert',
  aStart: 1,
  aEnd: 0,
  bStart,
  bEnd: bStart + n - 1,
});

/** 典型样例：首 5 行相同 / 改 / 夹 2 行相同 / 改 / 10 行相同 / 改 / 尾 2 行相同 + 增 + 删 + 不等长替换 */
const BLOCKS: CmpBlock[] = [
  eq(1, 5),
  rep(6, 1, 6, 1),
  eq(7, 2),
  rep(9, 1, 9, 1),
  eq(10, 10),
  rep(20, 1, 20, 1),
  eq(21, 2),
  ins(24, 4),
  del(23, 2),
  rep(40, 3, 26, 1),
];

describe('008 AC-12：相等区域折叠口径（规则 15）', () => {
  it('夹在差异之间且 ≤2 行的等值段派生为 context（铺开作上下文行）', () => {
    const vb = toViewBlocks(BLOCKS);
    expect(vb[2].kind).toBe('context'); // 2 行，两侧都是差异
    expect(vb[6].kind).toBe('context'); // 同为 2 行且后面还有增/删/改
    // 首段（5 行）不派生：首段没有上文可比，照常走折叠判决
    expect(vb[0].kind).toBe('equal');
    expect(vb[4].kind).toBe('equal'); // 10 行，超阈值
    // 尾段：1 行等值段收尾 → 不派生（尾部没有下文可比）
    const tail = toViewBlocks([rep(1, 1, 1, 1), eq(2, 1)]);
    expect(tail[1].kind).toBe('equal');
    expect(layoutBlocks(tail, true, new Set())[1].height).toBe(ROW_H);
  });

  it('折叠判决：仅差异态下 5/10 行段折叠成一行，2 行上下文段恒铺开', () => {
    const vb = toViewBlocks(BLOCKS);
    const disp = layoutBlocks(vb, true, new Set());
    const at = (i: number) => disp.find(d => d.idx === i)!;
    expect(at(0).height).toBe(SKIP_H); // 首段 5 行折叠
    expect(at(2).height).toBe(2 * ROW_H); // 上下文 2 行铺开
    expect(at(4).height).toBe(SKIP_H); // 10 行折叠
    expect(at(6).height).toBe(2 * ROW_H); // 上下文 2 行铺开
  });

  it('阈值边界：3 行（CTX_MAX+1）即折叠，恰 2 行不折', () => {
    const three = toViewBlocks([rep(1, 1, 1, 1), eq(2, 3), rep(5, 1, 5, 1)]);
    expect(three[1].kind).toBe('equal'); // 3 > CTX_MAX：不派生上下文
    const d3 = layoutBlocks(three, true, new Set());
    expect(d3[1].height).toBe(SKIP_H);
    const two = toViewBlocks([rep(1, 1, 1, 1), eq(2, CTX_MAX), rep(4, 1, 4, 1)]);
    expect(two[1].kind).toBe('context');
    expect(layoutBlocks(two, true, new Set())[1].height).toBe(CTX_MAX * ROW_H);
  });

  it('展开（expanded）与关「仅差异」都还原为逐行铺开', () => {
    const vb = toViewBlocks(BLOCKS);
    expect(layoutBlocks(vb, true, new Set([0]))[0].height).toBe(5 * ROW_H);
    expect(layoutBlocks(vb, false, new Set())[0].height).toBe(5 * ROW_H);
  });

  it('布局总高 = 末块 top + height（概览条百分比分母）', () => {
    const disp = layoutBlocks(toViewBlocks(BLOCKS), true, new Set());
    const last = disp[disp.length - 1];
    expect(totalHeight(disp)).toBe(last.top + last.height);
    expect(totalHeight([])).toBe(0);
  });
});

describe('008 AC-13 前置：差异统计（规则 8）', () => {
  it('替换取两侧较大行数、插入数 B 侧、删除数 A 侧，受影响行数不双计', () => {
    const st = diffStat(BLOCKS);
    // 三个 1:1 替换（各 1 行）+ 一个 3:1 替换（取 3） = 6
    expect(st.chg).toBe(1 + 1 + 1 + 3);
    expect(st.add).toBe(4);
    expect(st.del).toBe(2);
    expect(st.affected).toBe(st.chg + st.add + st.del);
  });

  it('计数行「N 处差异 · M 行受影响」与导航表同源', () => {
    const dc = diffCounts(BLOCKS);
    expect(dc.diffs).toBe(6); // 4 replace + 1 insert + 1 delete
    expect(dc.affected).toBe(diffStat(BLOCKS).affected);
    expect(diffIdxList(toViewBlocks(BLOCKS))).toHaveLength(dc.diffs);
    // 视图实际传入的是 ViewBlock[]（含派生 context）：上下文块不是差异处
    // （修前 diffCounts 只排 equal，头显 7 处而导航显 1/4，两处自相矛盾）
    expect(diffCounts(toViewBlocks(BLOCKS)).diffs).toBe(dc.diffs);
    expect(diffCounts(toViewBlocks(BLOCKS)).affected).toBe(dc.affected);
  });

  it('无差异文件：0 处差异 / 0 行受影响（导航显示 –/– 的数据来源）', () => {
    expect(diffCounts([eq(1, 9)])).toEqual({ diffs: 0, affected: 0 });
    expect(diffIdxList(toViewBlocks([eq(1, 9)]))).toHaveLength(0);
  });
});

describe('008 AC-11：差异导航环绕步进（规则 14）', () => {
  it('前进：未定位→首处，末处→首处（环绕）', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(1, 3, 1)).toBe(2);
    expect(stepIndex(3, 3, 1)).toBe(1);
  });

  it('后退：未定位→末处，首处→末处（环绕）', () => {
    expect(stepIndex(0, 3, -1)).toBe(3);
    expect(stepIndex(1, 3, -1)).toBe(3);
    expect(stepIndex(2, 3, -1)).toBe(1);
  });

  it('无差异时恒 0（不越界、计数显示 –/–）', () => {
    expect(stepIndex(0, 0, 1)).toBe(0);
    expect(stepIndex(0, 0, -1)).toBe(0);
  });

  it('导航表跳过等值与上下文块（上下文不是差异处）', () => {
    expect(diffIdxList(toViewBlocks(BLOCKS))).toEqual([1, 3, 5, 7, 8, 9]);
  });
});

describe('行级类别映射（规则 9 v0.4：隐藏该类别时三处对象一并撤下）', () => {
  it('EOL 归入「行尾空白」类：绿底 + 行尾徽标；编码类走蓝', () => {
    expect(lineCatKey('eol')).toBe('whitespace');
    expect(lineCatKey('encoding')).toBe('encoding');
    expect(lineCatKey(null)).toBeNull();
    expect(lineCatClass('eol')).toBe('cat-whitespace');
    expect(lineCatClass('encoding')).toBe('cat-encoding');
    expect(lineCatClass(null)).toBeNull();
  });
});

describe('行渲染分段（lineParts：单侧行不空白，harness 实测抓出）', () => {
  const line = (over: Partial<CmpDetailLine>): CmpDetailLine => ({
    no: 15, text: 'only in a line', lineCat: null, spans: [], ...over,
  });

  it('空 spans（删除块 A 侧 / 插入块 B 侧 / 不等长替换的多出行）回退整行文本', () => {
    // 修前视图只遍历 spans：这些行整行空白，删除/插入块看不到内容
    expect(lineParts(line({}), 'a')).toEqual([{ text: 'only in a line', cat: null }]);
    expect(lineParts(line({ text: 'inserted in b' }), 'b')).toEqual([{ text: 'inserted in b', cat: null }]);
  });

  it('配对行按 spans 分段：等值段 cat=null（纯文本），差异段带类别', () => {
    const paired = line({
      text: 'user аdmin',
      spans: [
        { textA: 'user ', textB: 'user ', cat: 'content', eq: true },
        { textA: 'а', textB: 'a', cat: 'homoglyph' },
        { textA: 'dmin', textB: 'dmin', cat: 'content', eq: true },
      ],
    });
    expect(lineParts(paired, 'a')).toEqual([
      { text: 'user ', cat: null },
      { text: 'а', cat: 'homoglyph' },
      { text: 'dmin', cat: null },
    ]);
    expect(lineParts(paired, 'b')[1]).toEqual({ text: 'a', cat: 'homoglyph' });
  });

  it('视图只落 DOM 不写第二份判决（renderSpans 引 lineParts）', () => {
    const viewSrc = read('src/compare-view/view.ts');
    const fn = viewSrc.slice(viewSrc.indexOf('private renderSpans'));
    expect(fn.slice(0, 500)).toContain('lineParts(line, side)');
    expect(fn).not.toContain('line.spans');
  });
});

describe('布局契约锁（防视觉条款回漂）', () => {
  const css = read('src/styles.css');
  const viewSrc = read('src/compare-view/view.ts');
  const appSrc = read('src/shell/app.ts');

  it('008 v0.6 三缺口清偿：行点击跳转 / 编码转换另存 / 规范化预览（源码契约）', () => {
    const panelsSrc = read('src/shell/panels.ts');
    const ipcSrc = read('src/common/ipc.ts');
    const rsSrc = read('src-tauri/src/commands/compare.rs');
    const libRs = read('src-tauri/src/lib.rs');
    // 行点击跳转（规则 11）：rowShell 接 onJump，shell 侧 openPath(anchor)/活动标签直达
    expect(viewSrc).toContain('onJump?: (path: string, line: number) => void');
    expect(viewSrc).toMatch(/cmp-jump/);
    expect(css).toContain('.cmp-row .cmp-jump{cursor:pointer}');
    expect(appSrc).toMatch(/onJump: \(path, line\)/);
    expect(appSrc).toMatch(/switchAnchor\.set\(path, line\)/);
    // 编码转换另存（规则 13 + 002 规则 21a）：命令 + 对话框 + 双入口（编辑菜单/对比头部）
    expect(rsSrc).toContain('pub fn encode_convert_impl');
    expect(rsSrc).toContain('pub async fn encode_convert_save');
    expect(libRs).toContain('commands::compare::encode_convert_save');
    expect(ipcSrc).toContain("invoke<number>('encode_convert_save'");
    expect(panelsSrc).toContain('export function encodeConvertDialog');
    expect(viewSrc).toContain("mk('button', 'cmp-btn', t('act.encSave'))");
    expect(appSrc).toContain("id: 'edit.encSave'");
    // 规范化预览（规则 12）：预览命令 + 对话框预览区
    expect(rsSrc).toContain('fn preview_summary');
    expect(rsSrc).toContain('pub async fn normalize_preview');
    expect(libRs).toContain('commands::compare::normalize_preview');
    expect(panelsSrc).toMatch(/renderPreview\(await normalizePreview/);
    expect(css).toContain('.norm-preview');
    // EOL 元信息（规则 5）
    expect(rsSrc).toContain('eol: compare::eol_of');
    expect(viewSrc).toContain('EOL:');
  });

  it('键位单一来源：app.ts 引用 NAV_SHORTCUTS，无字面量按键回漂', () => {
    expect(NAV_SHORTCUTS).toEqual({ prev: 'Alt+ArrowLeft', next: 'Alt+ArrowRight' });
    expect(appSrc).toContain("shortcut: NAV_SHORTCUTS.prev");
    expect(appSrc).toContain("shortcut: NAV_SHORTCUTS.next");
    // 修前无比较导航动作；两处若各写一份字面量，改键位必漂
    expect(appSrc).not.toContain("'Alt+ArrowLeft'");
    expect(appSrc).not.toContain("'Alt+ArrowRight'");
    // 按钮提示由同一常量派生（Alt+ArrowLeft → Alt+←）
    expect(chordLabel(NAV_SHORTCUTS.prev)).toBe('Alt+←');
    expect(viewSrc).toContain('chordLabel(NAV_SHORTCUTS.prev)');
  });

  it('滚动区/概览条起点由头高变量驱动（修前写死 34px，三层头一上即错位）', () => {
    expect(css).toContain('inset:var(--cmp-top,89px)');
    expect(css).toContain('top:var(--cmp-top,89px)');
    expect(viewSrc).toContain("setProperty('--cmp-top'");
    expect(viewSrc).toContain('measureTop');
    expect(css).not.toMatch(/\.cmp-scroller\{[^}]*inset:34px/);
  });

  it('三层头结构：headline/legend 定高 + A-B 对齐列头与行网格同列宽', () => {
    expect(css).toMatch(/\.cmp-headline\{[^}]*height:34px/);
    expect(css).toMatch(/\.cmp-legend\{[^}]*height:28px/);
    const grid = '48px minmax(0,1fr) 30px 48px minmax(0,1fr)';
    expect(css).toContain(`.cmp-cols{\n  display:grid;grid-template-columns:${grid};`);
    expect(css).toContain(`.cmp-row{\n  display:grid;grid-template-columns:${grid};`);
  });

  it('块铺色为稀洗 + 3px 类别色轨（替换/删除在 A 栏左缘，插入在 B 栏起点）', () => {
    expect(css).toContain('color-mix(in oklch,var(--diff-chg) 62%,transparent)');
    expect(css).toContain('color-mix(in oklch,var(--diff-del) 62%,transparent)');
    expect(css).toContain('color-mix(in oklch,var(--diff-add) 62%,transparent)');
    expect(css).toContain('.cmp-block.replace::before{left:0;background:var(--c-amber)}');
    expect(css).toContain('.cmp-block.delete::before{left:0;background:var(--c-red)}');
    expect(css).toContain('.cmp-block.insert::before{left:calc(126px + (100% - 126px) / 2)');
    expect(css).toMatch(/\.cmp-block\.replace::before,\.cmp-block\.delete::before,\.cmp-block\.insert::before\{\s*content:''[^}]*width:3px/);
  });

  it('行内双通道标记（淡底 + 2px 下划线）与未变文本降档、缺失侧斜纹', () => {
    expect(css).toMatch(/\.cmp-cat\{[^}]*box-shadow:inset 0 -2px 0 currentColor/);
    expect(css).toContain('.cmp-eq{color:var(--muted)}');
    expect(css).toMatch(/\.cmp-tx\.cmp-absent\{[^}]*repeating-linear-gradient/);
  });

  it('折叠行居中且 hover 显「展开」；徽标文本不再内嵌「点击展开」', () => {
    expect(css).toMatch(/\.cmp-skip\{[^}]*justify-content:center/);
    expect(css).toMatch(/\.cmp-skip \.act\{[^}]*opacity:0/);
    expect(css).toMatch(/\.cmp-skip:hover \.act\{opacity:1\}/);
    expect(tf('cmp.sameLines', 9)).not.toMatch(/点击展开|click/i);
    expect(viewSrc).toContain("mk('span', 'act', t('cmp.expand'))");
  });

  it('概览条：视口框 + 当前块标记 + 12px 宽（点击/拖动定位）', () => {
    expect(css).toContain('.cmp-ov-view{');
    expect(css).toContain('.cmp-ov-cur{');
    expect(css).toContain('var(--cmp-map-w,12px)');
    expect(viewSrc).toContain('updateOvView');
    expect(viewSrc).toContain("window.addEventListener('mousemove'");
  });

  it('类别 chip：色点 + 空心点表示已过滤 + 六类色板一一对应（v0.6：BOM 入图例、纯内容差异无图例项）', () => {
    expect(css).toMatch(/\.cmp-chip \.dot\{[^}]*background:currentColor/);
    expect(css).toMatch(/\.cmp-chip\.off \.dot\{[^}]*background:transparent;box-shadow:inset 0 0 0 1px currentColor/);
    for (const [cls, tok] of [
      ['cat-encoding', '--c-blue'],
      ['cat-homoglyph', '--c-violet'],
      ['cat-normalize', '--c-teal'],
      ['cat-invisible', '--c-amber'],
      ['cat-whitespace', '--c-green'],
      ['cat-bom', '--diff-del'],
    ] as const) {
      expect(css).toContain(`.cmp-chip.${cls}{color:var(${tok})}`);
    }
    // v0.6 口径：content chip 已除（纯内容差异非六类）；BOM 徽标规则在档
    expect(css).not.toContain('.cmp-chip.cat-content');
    expect(viewSrc).not.toContain("{ key: 'content'");
    expect(viewSrc).toContain("{ key: 'bom'");
    expect(css).toContain('.cmp-bom-badge');
    expect(viewSrc).toMatch(/metaA\?\.bom .*!== .*metaB\?\.bom/);
  });

  it('类别隐藏时行底色与徽标一并撤下（fillDetail 单点判决）', () => {
    expect(viewSrc).toContain('this.hiddenCats.has(lineCatKey(cat) ?? ');
    expect(viewSrc).toMatch(/if \(!cat \|\| this\.hiddenCats\.has\(lineCatKey\(cat\)[\s\S]{0,120}return;/);
    // 徽标只在未被隐藏时创建（不是先建后删）
    const fill = viewSrc.slice(viewSrc.indexOf('private fillDetail'));
    expect(fill.indexOf('hiddenCats.has(lineCatKey')).toBeLessThan(fill.indexOf("mk('span', 'cmp-badge'"));
  });

  it('块行数：等值块按 A 侧行数，变更块取两侧较大者', () => {
    expect(blockRows(eq(1, 4))).toBe(4);
    expect(blockRows(rep(1, 3, 1, 1))).toBe(3);
    expect(blockRows(ins(1, 5))).toBe(5);
  });
});

describe('i18n 两语齐全（中文界面下导航/统计/折叠行不得回退成 key 文本）', () => {
  it('导航/统计/折叠键两语齐全且插值可用', () => {
    for (const k of [
      'cmp.navPrev',
      'cmp.navNext',
      'cmp.legendLabel',
      'cmp.legendNote',
      'cmp.affectedRows',
      'cmp.expand',
      'cmp.navPosNone',
      'cmp.sameLines',
    ]) {
      expect(dict('zh-CN')[k], `zh ${k}`).toBeTruthy();
      expect(dict('en-US')[k], `en ${k}`).toBeTruthy();
    }
    expect(tf('cmp.affectedRows', 12)).toMatch(/12/);
    expect(tf('cmp.sameLines', 9)).toMatch(/9/);
  });
});
