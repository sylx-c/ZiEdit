// @vitest-environment jsdom
// 007 v0.16 规则 23 M2 / AC-27 验收锁（UX-C4：表格交互与任务勾选）：
// Tab/Shift+Tab 单元格间导航（行内 + 跨行：末格非末行 → 下行首格）；
// 行尾（过末竖线）Tab 非末行加列（分隔行补 --- 保 GFM 有效）、末行行尾/末列 Tab 加行；
// 非活动表格右键「表格 ▸」六操作（上方/下方插行、左/右侧插列、删行、删列——
// 表头行禁上方插行与删行、删列保底 1 列），整表单 change 单步撤销；
// 任务列表勾选点击切换 [ ]/[x] 且单步撤销；表格骨架插入走 runFormat('table')（规则 17 插入类）。
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TABLE_DOC = '| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n';

let fileText = '';

vi.mock('../src/common/ipc', () => ({
  textOpen: async () => ({ content: '', encoding: 'UTF-8', newline: 'lf', mixed: false }),
  textReadAll: async () => fileText,
  textSave: async () => ({ len: 0, modifiedMs: 0 }),
}));

if (!(Range.prototype as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
}

const { LivePreviewView } = await import('../src/markdown-view/livepreview');
const { t } = await import('../src/common/i18n');
type LiveView = InstanceType<typeof LivePreviewView>;
type Item = [string, (() => void) | null, Item[]?];

interface Mount { v: LiveView; host: HTMLElement; menus: Item[][] }

async function mount(): Promise<Mount> {
  const host = document.createElement('div');
  const menus: Item[][] = [];
  let done = false;
  const v = new LivePreviewView(host, {
    path: 'E:\\mock\\n.md',
    encoding: 'UTF-8',
    onStatus: () => {},
    onSaved: () => {},
    onReady: () => (done = true),
    showMenu: items => menus.push(items as Item[]),
  });
  for (let i = 0; i < 100 && !done; i++) await new Promise(r => setTimeout(r, 10));
  if (!done) throw new Error('onReady 未交付');
  return { v, host, menus };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时：条件在 ${ms}ms 内未成立`);
    await new Promise(r => setTimeout(r, 25));
  }
}

/** 光标落指定格（导航行序 0 基——表头 0、正文 1..，分隔行不计；col 0 基） */
function cellOf(v: LiveView, row: number, col: number): void {
  const lines = v.getMarkdown().split('\n');
  const navLines: number[] = [];
  lines.forEach((l, i) => { if (l.trim() && i !== 1) navLines.push(i); }); // i===1 分隔行
  const idx = navLines[row]!;
  const target = lines[idx]!;
  let pipe = -1;
  let seen = -1;
  for (let i = 0; i < target.length; i++) {
    if (target[i] === '\\' && target[i + 1] === '|') { i++; continue; }
    if (target[i] === '|') { seen++; if (seen === col) pipe = i; }
  }
  const lineStart = idx === 0 ? 0 : lines.slice(0, idx).join('\n').length + 1;
  let at = lineStart + pipe + 1;
  while (/\s/.test(v.getMarkdown()[at] ?? '')) at++;
  v.view.dispatch({ selection: { anchor: at } });
}

function selText(v: LiveView): string {
  const s = v.view.state.selection.main;
  return v.view.state.sliceDoc(s.from, s.to || s.from) || v.view.state.sliceDoc(s.from, s.from + 1);
}

describe('AC-27 表格导航与加行加列（规则 23 M2，通行表格语义）', () => {
  it('表格前编辑复用网格DOM，漂移后点单元格仍落新源码坐标', async () => {
    fileText = 'before\n\n' + TABLE_DOC + '\nafter\n';
    const { v, host } = await mount();
    try {
      await until(() => !!host.querySelector('.mdir-table'));
      const table = host.querySelector('.mdir-table')!;
      for (let i = 0; i < 3; i++) {
        v.view.dispatch({ changes: { from: 0, insert: 'prefix\n\n' }, selection: { anchor: 0 } });
        await until(() => !!host.querySelector('.mdir-table'));
        expect(host.querySelector('.mdir-table')).toBe(table);
      }
      (table.querySelectorAll('tbody td')[2] as HTMLElement).dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      );
      expect(host.querySelector('td .cm-editor')?.textContent).toContain('3');
      expect(host.querySelector('.mdir-table')).toBe(table);
    } finally { v.destroy(); }
  });
  it('Tab 行内逐格右移、末格非末行转下行首格；Shift+Tab 反向（含跨行回退）', async () => {
    fileText = TABLE_DOC;
    const { v } = await mount();
    cellOf(v, 0, 0); // 表头「甲」
    expect(selText(v)).toBe('甲');
    expect(v.tableTab(1)).toBe(true);
    expect(selText(v)).toBe('乙'); // 行内右移
    expect(v.tableTab(1)).toBe(true);
    expect(selText(v)).toBe('1'); // 末格非末行 → 下行首格
    v.tableTab(1);
    expect(selText(v)).toBe('2');
    v.tableTab(-1);
    expect(selText(v)).toBe('1'); // Shift+Tab 行内左移
    expect(v.tableTab(-1)).toBe(true);
    expect(selText(v)).toBe('乙'); // 跨行回退到上行末格
    v.tableTab(-1);
    expect(selText(v)).toBe('甲');
    expect(v.tableTab(-1)).toBe(true); // 首行首格吞掉按键，避免插入制表符。
    v.destroy();
  });

  it('末行末格 Tab 加行（列数随表头），单步撤销整回原表', async () => {
    fileText = TABLE_DOC;
    const { v } = await mount();
    cellOf(v, 2, 1); // 末行末格「4」
    v.tableTab(1);
    expect(v.getMarkdown()).toBe('| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n|  |  |\n');
    v.cmUndo();
    expect(v.getMarkdown()).toBe(TABLE_DOC); // 单步撤销
    v.destroy();
  });

  it('行尾（过末竖线）Tab 非末行加列：每行补格、分隔行补 --- 保持 GFM 有效', async () => {
    fileText = TABLE_DOC;
    const { v } = await mount();
    const headerEnd = TABLE_DOC.indexOf('\n'); // 表头行行尾
    v.view.dispatch({ selection: { anchor: headerEnd } });
    expect(v.tableTab(1)).toBe(true);
    const want = '| 甲 | 乙 |  |\n|---|---| ---|\n| 1 | 2 |  |\n| 3 | 4 |  |\n';
    expect(v.getMarkdown()).toBe(want);
    v.cmUndo();
    expect(v.getMarkdown()).toBe(TABLE_DOC);
    v.destroy();
  });

  it('不在表格内 Tab 返回 false（交回默认缩进路径）', async () => {
    fileText = '# 题\n\n正文\n';
    const { v } = await mount();
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length - 1 } });
    expect(v.tableTab(1)).toBe(false);
    v.destroy();
  });
});

describe('AC-27 右键「表格 ▸」行列增删（单步撤销）', () => {
  function menuOf(menus: Item[][], label: string): Item {
    for (const items of menus) {
      for (const it of items) {
        if (it[0] === label) return it;
      }
    }
    throw new Error(`菜单项未捕获：${label}`);
  }

  it('正文格右键六操作可达：下方插行/右侧插列/删行/删列生效且 undo 单步回退', async () => {
    fileText = TABLE_DOC;
    const { v, host, menus } = await mount();
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length } }); // 光标出表（非活动 → 网格件在）
    await until(() => host.querySelector('table.mdir-table') !== null);
    const td = host.querySelectorAll('.mdir-table tbody tr')[1]!.querySelectorAll('td')[0]! as HTMLElement;
    td.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const sub = menuOf(menus, t('ctx.table'))[2]!;
    const op = (key: string): void => {
      sub.find(x => x[0] === t(key))![1]!();
    };
    // 下方插行（点在第 2 正文行 → 其下续空行；整表重写分隔行归一为 | --- |）
    op('tbl.rowBelow');
    expect(v.getMarkdown()).toBe('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n|  |  |\n');
    v.cmUndo();
    expect(v.getMarkdown()).toBe(TABLE_DOC);
    // 右侧插列（点在第 1 列 → 新列落第 1、2 列之间）
    op('tbl.colRight');
    expect(v.getMarkdown()).toBe('| 甲 |  | 乙 |\n| --- | --- | --- |\n| 1 |  | 2 |\n| 3 |  | 4 |\n');
    v.cmUndo();
    expect(v.getMarkdown()).toBe(TABLE_DOC);
    // 删行（点在第 2 正文行 → 删该行）
    op('tbl.delRow');
    expect(v.getMarkdown()).toBe('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n');
    v.cmUndo();
    expect(v.getMarkdown()).toBe(TABLE_DOC);
    // 删列（点在第 1 列 → 删首列）
    op('tbl.delCol');
    expect(v.getMarkdown()).toBe('| 乙 |\n| --- |\n| 2 |\n| 4 |\n');
    v.cmUndo();
    expect(v.getMarkdown()).toBe(TABLE_DOC);
    v.destroy();
  });

  it('表头格右键：上方插入行/删除行置灰（handler null），其余可达', async () => {
    fileText = TABLE_DOC;
    const { v, host, menus } = await mount();
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length } });
    await until(() => host.querySelector('table.mdir-table') !== null);
    const th = host.querySelector('.mdir-table thead th')! as HTMLElement;
    th.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    const sub = menuOf(menus, t('ctx.table'))[2]!;
    expect(sub.find(x => x[0] === t('tbl.rowAbove'))![1]).toBeNull(); // 表头行禁
    expect(sub.find(x => x[0] === t('tbl.delRow'))![1]).toBeNull();
    sub.find(x => x[0] === t('tbl.colLeft'))![1]!();
    expect(v.getMarkdown()).toBe('|  | 甲 | 乙 |\n| --- | --- | --- |\n|  | 1 | 2 |\n|  | 3 | 4 |\n');
    v.destroy();
  });

  it('表头下方插行保留分隔行位置，删除缺省列不误删短行已有格', async () => {
    fileText = '| A | B | C |\n|---|---|---|\n| 保留 | 第二格 |\n';
    const { v, host, menus } = await mount();
    try {
      await until(() => !!host.querySelector('th'));
      const header = host.querySelectorAll('th')[2]!;
      header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const sub = menuOf(menus, t('ctx.table'))[2]!;
      sub.find(x => x[0] === t('tbl.rowBelow'))![1]!();
      expect(v.getMarkdown()).toBe('| A | B | C |\n| --- | --- | --- |\n|  |  |  |\n| 保留 | 第二格 |\n');
      v.cmUndo();
      expect(v.getMarkdown()).toBe(fileText);
      sub.find(x => x[0] === t('tbl.delCol'))![1]!();
      expect(v.getMarkdown()).toBe('| A | B |\n| --- | --- |\n| 保留 | 第二格 |\n');
      v.cmUndo();
      expect(v.getMarkdown()).toBe(fileText);
      sub.find(x => x[0] === t('tbl.colRight'))![1]!();
      expect(v.getMarkdown()).toBe('| A | B | C |  |\n| --- | --- | --- | --- |\n| 保留 | 第二格 |  |  |\n');
      v.cmUndo();
      expect(v.getMarkdown()).toBe(fileText);
      v.setReadOnly(true);
      // 打开菜单后再启用只读，旧回调也不能改文档。
      sub.find(x => x[0] === t('tbl.rowBelow'))![1]!();
      expect(v.getMarkdown()).toBe(fileText);
      menus.splice(0);
      host.querySelector('th')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      for (const label of ['ctx.table', 'ctx.format', 'ctx.paragraph']) {
        expect(menuOf(menus, t(label))[2]!.every(x => x[1] === null)).toBe(true);
      }
    } finally { v.destroy(); }
  });
});

describe('AC-27 任务列表勾选与表格骨架', () => {
  it('点击非活动项勾选框翻转 [ ]/[x]，单步撤销回原样', async () => {
    fileText = '# 题\n\n- [ ] 甲\n- [x] 乙\n';
    const { v, host } = await mount();
    await until(() => host.querySelectorAll('input.mdir-task').length === 2);
    const boxes = host.querySelectorAll('input.mdir-task');
    boxes[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => v.getMarkdown().includes('- [x] 甲'));
    expect(v.getMarkdown()).toBe('# 题\n\n- [x] 甲\n- [x] 乙\n');
    const after = host.querySelectorAll('input.mdir-task');
    expect((after[0] as HTMLInputElement).checked).toBe(true); // 件随文档重渲
    v.cmUndo();
    expect(v.getMarkdown()).toBe('# 题\n\n- [ ] 甲\n- [x] 乙\n'); // 单步撤销
    v.destroy();
  });

  it('表格骨架插入走三上下文同一 runFormat（规则 17 插入类）', async () => {
    fileText = '正文\n';
    const { v } = await mount();
    v.view.dispatch({ selection: { anchor: 0 } });
    v.runFormat('table');
    const md = v.getMarkdown();
    expect(md).toContain('| 列1 | 列2 | 列3 |'); // 3×3 GFM 模板骨架（mdformat 同一实现）
    expect(md).toMatch(/^\| --- \| --- \| --- \|$/m);
    expect(md).toContain('正文');
    v.destroy();
  });

  it('引擎契约：Tab/Shift-Tab 键位挂在引擎内（keymap 先于默认缩进）', () => {
    const lp = readFileSync(resolve(__dirname, '../src/markdown-view/livepreview.ts'), 'utf8');
    expect(lp).toContain("key: 'Tab'");
    expect(lp).toContain("key: 'Shift-Tab'");
  });
});
