// @vitest-environment jsdom
// 001-AC-31 扩面（001 规则 31 v2.5 / 002 规则 12 v2.5）：字号接线 文件对比 / CSV 两视图。
// 修前缺陷：app.ts applyFontSize 只调 TextView/EditView 的 setFontSize，Compare/Csv 的
// 构造与生命周期零字号消费端——行高是模块常量（ROW_H 20 / CSV_ROW_HEIGHT 24）。
// 修后契约：两视图各实现 setFontSize(fs: number): void（幂等、钳 10–18），
// 行高/滚动数学随 fs 派生重排。
// 本文件锁两层：
// ① 行高派生纯函数数值锁——基准锚 = 出厂观感（fs12 时派生值与 CSS 基准相等，观感不变）；
// ② setFontSize 后布局参数的最小行为锁（行内行高、sizer 总高、字号落容器、幂等、跳转定位）。
import { describe, expect, it, vi } from 'vitest';

// ---- 依赖打桩：两视图运行时只消费这些（type 导入已擦除） ----
vi.mock('../src/common/ipc', () => ({
  textLines: async () => [{ no: 1, text: 'id,name,score' }],
  csvRecords: async (_p: string, from: number, to: number, delim: string) => {
    const lines = 'id,name,score\n1,alice,90\n2,bob,85'.split('\n');
    const records = lines.map((l, i) => ({ no: i + 1, cells: l.split(delim) }));
    return { records: records.slice(Math.max(0, from - 1), to), total: records.length };
  },
  compareOpen: async () => ({
    blocks: [
      { kind: 'replace', aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 },
      { kind: 'equal', aStart: 3, aEnd: 12, bStart: 2, bEnd: 11 },
      { kind: 'replace', aStart: 13, aEnd: 13, bStart: 12, bEnd: 12 },
    ],
    metaA: { path: '/mock/a.txt', encoding: 'UTF-8', bom: '', lines: 13, len: 100 },
    metaB: { path: '/mock/b.txt', encoding: 'UTF-8', bom: '', lines: 12, len: 90 },
    encMarksA: [],
    encMarksB: [],
    degraded: false,
  }),
  compareDetail: async () => [[], []],
}));
vi.mock('../src/shell/chrome', () => ({ overlayDialog: () => document.createElement('div') }));
vi.mock('../src/shell/panels', () => ({ normalizeSaveDialog: () => {} }));

import {
  ROW_H,
  SKIP_H,
  cmpFontPx,
  cmpRowHeight,
  cmpSkipHeight,
  layoutBlocks,
  toViewBlocks,
} from '../src/compare-view/layout';
import { CompareView } from '../src/compare-view/view';
import { CSV_ROW_HEIGHT, CsvView, csvFontPx, csvRowHeight } from '../src/csv-view/table';

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

/** CsvView 的 sizer 无 className（scroller 唯一子元素，body 挂其内） */
const csvSizerOf = (host: HTMLElement): HTMLElement =>
  (host.querySelector('.csv-scroller') as HTMLElement).firstElementChild as HTMLElement;

/** jsdom 无布局：给滚动容器钉住视口高与 scrollTop 存储，虚拟滚动数学才可断言 */
function pinViewport(el: HTMLElement, clientHeight: number): void {
  let st = 0;
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', { get: () => st, set: (v: number) => (st = v), configurable: true });
}

// ─────────────── ① 行高派生纯函数数值锁 ───────────────

describe('行高派生纯函数（001 规则 31 v2.5：基准锚 = 出厂观感）', () => {
  it('Compare：行高/折叠行高随字号派生，fs12 与 ROW_H/SKIP_H 相等；正文 +0.5px 偏移', () => {
    expect(cmpRowHeight(12)).toBe(ROW_H);
    expect(cmpSkipHeight(12)).toBe(SKIP_H);
    expect(cmpRowHeight(18)).toBe(30);
    expect(cmpSkipHeight(18)).toBe(36);
    expect(cmpFontPx(12)).toBe(12.5); // styles.css .cmp-scroller 基准 12.5px@fs12
    expect(cmpFontPx(16)).toBe(16.5);
  });

  it('Compare layoutBlocks 接受派生行高：块高按新行高重排，缺省口径不漂', () => {
    const vb = toViewBlocks([
      { kind: 'equal', aStart: 1, aEnd: 5, bStart: 1, bEnd: 5 },
      { kind: 'replace', aStart: 6, aEnd: 7, bStart: 6, bEnd: 6 },
      { kind: 'equal', aStart: 8, aEnd: 17, bStart: 7, bEnd: 16 },
      { kind: 'replace', aStart: 18, aEnd: 18, bStart: 17, bEnd: 17 },
    ]);
    // 仅差异态：首段 5 行折叠、替换 2 行铺开、10 行折叠、尾替换 1 行
    expect(layoutBlocks(vb, true, new Set()).map(d => d.height)).toEqual([SKIP_H, 2 * ROW_H, SKIP_H, ROW_H]);
    expect(layoutBlocks(vb, true, new Set(), cmpRowHeight(16), cmpSkipHeight(16)).map(d => d.height)).toEqual([
      cmpSkipHeight(16),
      2 * cmpRowHeight(16),
      cmpSkipHeight(16),
      cmpRowHeight(16),
    ]);
  });

  it('CSV：行高 2×fs 派生（fs12=24 基准），正文 +1px 偏移（body 13px 基准）', () => {
    expect(csvRowHeight(12)).toBe(CSV_ROW_HEIGHT);
    expect(csvRowHeight(10)).toBe(20);
    expect(csvRowHeight(18)).toBe(36);
    expect(csvFontPx(12)).toBe(13);
    expect(csvFontPx(16)).toBe(17);
  });
});

// ─────────────── ② setFontSize 行为锁 ───────────────

describe('CompareView.setFontSize 行为锁', () => {
  async function mountCompare(): Promise<{ host: HTMLElement; v: CompareView }> {
    const host = document.createElement('div');
    const v = new CompareView(host, '/mock/a.txt', '/mock/b.txt', {
      onClose: () => {},
      onStatus: () => {},
      flash: () => {},
    });
    await tick(30); // init 异步（compareOpen + 首渲染）
    pinViewport(host.querySelector('.cmp-scroller') as HTMLDivElement, 600);
    return { host, v };
  }

  it('出厂态：正文 12.5px、行高 20px（fs12 观感不变）', async () => {
    const { host } = await mountCompare();
    expect((host.querySelector('.cmp-scroller') as HTMLElement).style.fontSize).toBe('12.5px');
    expect((host.querySelector('.cmp-row') as HTMLElement).style.height).toBe('20px');
  });

  it('setFontSize(16)：字号落滚动区，行高/折叠行高/布局总高全部按派生值重排', async () => {
    const { host, v } = await mountCompare();
    v.setFontSize(16);
    // 块序：替换 2 行(54) + 折叠 10 行(32) + 替换 1 行(27) = 113
    expect((host.querySelector('.cmp-sizer') as HTMLElement).style.height).toBe(
      `${2 * cmpRowHeight(16) + cmpSkipHeight(16) + cmpRowHeight(16)}px`
    );
    expect((host.querySelector('.cmp-scroller') as HTMLElement).style.fontSize).toBe('16.5px');
    expect((host.querySelector('.cmp-row') as HTMLElement).style.height).toBe(`${cmpRowHeight(16)}px`); // 27
    const skip = host.querySelector('.cmp-skip') as HTMLElement;
    expect(skip.style.height).toBe(`${cmpSkipHeight(16)}px`); // 32（行内覆盖 styles.css 24px）
    expect((skip.closest('.cmp-block') as HTMLElement).style.height).toBe(`${cmpSkipHeight(16)}px`);
  });

  it('幂等：重复同值调用无副作用', async () => {
    const { host, v } = await mountCompare();
    v.setFontSize(16);
    const before = (host.querySelector('.cmp-sizer') as HTMLElement).style.height;
    const rowBefore = (host.querySelector('.cmp-row') as HTMLElement).style.height;
    v.setFontSize(16);
    expect((host.querySelector('.cmp-sizer') as HTMLElement).style.height).toBe(before);
    expect((host.querySelector('.cmp-row') as HTMLElement).style.height).toBe(rowBefore);
  });
});

describe('CsvView.setFontSize 行为锁', () => {
  async function mountCsv(): Promise<{ host: HTMLElement; v: CsvView }> {
    const host = document.createElement('div');
    const v = new CsvView(host, '/mock/a.csv', 'UTF-8', () => {});
    await v.mount();
    pinViewport(host.querySelector('.csv-scroller') as HTMLDivElement, 600);
    return { host, v };
  }

  it('出厂态：行内行高 24px、正文 13px（fs12 观感不变）', async () => {
    const { host } = await mountCsv();
    expect((host.querySelector('.csv-scroller') as HTMLElement).style.fontSize).toBe('13px');
    expect((host.querySelector('.csv-header') as HTMLElement).style.fontSize).toBe('13px');
    const row = host.querySelector('.csv-row') as HTMLElement;
    expect(row.style.height).toBe('24px');
    expect(row.style.lineHeight).toBe('24px');
    expect((csvSizerOf(host)).style.height).toBe(`${(3 + 1) * 24}px`);
  });

  it('setFontSize(16)：行高/虚拟滚动（sizer 总高）随派生值重算，行内覆盖重建', async () => {
    const { host, v } = await mountCsv();
    v.setFontSize(16);
    await tick();
    expect((host.querySelector('.csv-scroller') as HTMLElement).style.fontSize).toBe('17px');
    expect((host.querySelector('.csv-header') as HTMLElement).style.fontSize).toBe('17px');
    const row = host.querySelector('.csv-row') as HTMLElement;
    expect(row.style.height).toBe(`${csvRowHeight(16)}px`); // 32
    expect(row.style.lineHeight).toBe(`${csvRowHeight(16)}px`);
    expect((csvSizerOf(host)).style.height).toBe(
      `${(3 + 1) * csvRowHeight(16)}px`
    );
  });

  it('幂等 + 越界钳制', async () => {
    const { host, v } = await mountCsv();
    v.setFontSize(16);
    await tick();
    const before = (csvSizerOf(host)).style.height;
    v.setFontSize(16); // 幂等
    await tick();
    expect((csvSizerOf(host)).style.height).toBe(before);
    v.setFontSize(99); // 钳到 18
    await tick();
    expect((host.querySelector('.csv-row') as HTMLElement).style.height).toBe(`${csvRowHeight(18)}px`);
  });
});
