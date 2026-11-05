// @vitest-environment jsdom
import { expect, it } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { BlockHeightCache } from './block-height-cache';
import { TableViewport } from './table-viewport';
import { TABLE_ROW_ESTIMATE_PX } from './layout';

it('restores offsets before the first draw and rejects changed content, columns and width', () => {
  const cache = new BlockHeightCache(); cache.layout('layout');
  const identity = cache.identity('table', 'source', 0, 0, 0, 6)!;
  cache.putRows(identity, { cols: 1, width: 800, heights: Array(300).fill(64), measured: Array(300).fill(true) });
  const contentDOM = document.createElement('div'), scrollDOM = document.createElement('div');
  contentDOM.getBoundingClientRect = () => ({ width: 800 }) as DOMRect;
  const view = { contentDOM, scrollDOM, state: { facet: () => cache }, requestMeasure: () => {} } as unknown as EditorView;
  const box = document.createElement('div'), table = document.createElement('table'); box.append(table);
  const viewport = new TableViewport(view, box, table, 300, 1, row => {
    const tr = document.createElement('tr'); tr.dataset.mdRow = String(row); tr.insertCell(); return tr;
  }, () => null, () => {}, identity);
  expect(box.querySelector<HTMLTableCellElement>('.mdir-table-spacer td')!.style.height).toBe(`${267 * 64}px`);
  expect(viewport.snapshot().heights[299]).toBe(64);
  expect(cache.rows(identity, 2, 800)).toBeUndefined();
  expect(cache.rows(identity, 1, 799)).toBeUndefined();
  const changed = cache.identity('table', 'edited', 0, 0, 0, 6)!;
  expect(cache.rows(changed, 1, 800)).toBeUndefined();
  const activeRow = table.tBodies[0]!.querySelector('tr[data-md-row="1"]')!;
  const editor = document.createElement('div'); editor.className = 'cm-editor'; activeRow.firstElementChild!.append(editor);
  viewport.update(300, 1, (_row, existing) => {
    if (existing) return existing;
    const tr = document.createElement('tr'); tr.insertCell(); return tr;
  }, changed);
  expect(table.tBodies[0]!.querySelector('tr[data-md-row="1"]')).toBe(activeRow);
  expect(table.contains(editor)).toBe(true);
  expect(viewport.snapshot().heights.every(height => height === TABLE_ROW_ESTIMATE_PX)).toBe(true);
  viewport.destroy();
});

it('drops both snapshot and measured block height on budget overflow or layout change', () => {
  const cache = new BlockHeightCache(); cache.layout('layout');
  const identity = cache.identity('table', 'source', 0, 0, 0, 6)!;
  cache.put(identity, 100);
  cache.putRows(identity, { cols: 1, width: 800, heights: Array(140000).fill(64), measured: Array(140000).fill(true) });
  expect(cache.rows(identity, 1, 800)).toBeUndefined(); expect(cache.get(identity)).toBeUndefined();
  cache.putRows(identity, { cols: 1, width: 800, heights: [64], measured: [true] });
  expect(cache.get(identity)).toBeUndefined();
  cache.layout('changed'); expect(cache.rows(identity, 1, 800)).toBeUndefined();
});

it('keeps visible cells while parsed table rows grow and only removes rows outside the new table', () => {
  const scrollDOM = document.createElement('div'), box = document.createElement('div'), table = document.createElement('table');
  box.append(table);
  const view = { scrollDOM, requestMeasure: () => {} } as unknown as EditorView;
  let columns = 1;
  const render = (row: number, existing?: HTMLTableRowElement): HTMLTableRowElement => {
    const tr = existing ?? document.createElement('tr'); tr.dataset.mdRow = String(row);
    for (let col = 0; col < columns; col++) (tr.cells[col] ?? tr.insertCell()).textContent = `${row}:${col}`;
    return tr;
  };
  const viewport = new TableViewport(view, box, table, 300, columns, render, () => null, () => {});
  try {
    const row = table.querySelector<HTMLTableRowElement>('tr[data-md-row="29"]')!, cell = row.cells[0]!;
    const head = table.tHead!.firstElementChild;
    for (const rows of [4558, 6501]) {
      viewport.update(rows, columns, render);
      expect(table.querySelector('tr[data-md-row="29"]')).toBe(row);
      expect(row.cells[0]).toBe(cell);
      expect(table.tHead!.firstElementChild).toBe(head);
      expect(cell.textContent).toBe('29:0');
      expect(viewport.snapshot().heights).toHaveLength(rows);
    }
    const kept = table.querySelector('tr[data-md-row="10"]');
    viewport.update(20, columns, render);
    expect(table.querySelector('tr[data-md-row="10"]')).toBe(kept);
    expect(table.contains(row)).toBe(false);
    columns = 2;
    viewport.update(20, columns, render);
    expect(table.querySelector<HTMLTableRowElement>('tr[data-md-row="10"]')!.cells).toHaveLength(2);
    expect(table.contains(kept)).toBe(false);
  } finally { viewport.destroy(); }
});

it('keeps measured row offsets when an unchanged parsed prefix grows', () => {
  const scrollDOM = document.createElement('div'), contentDOM = document.createElement('div');
  const box = document.createElement('div'), table = document.createElement('table'); box.append(table); document.body.append(box);
  let measure: any;
  contentDOM.getBoundingClientRect = () => ({ width: 800 }) as DOMRect;
  table.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  scrollDOM.getBoundingClientRect = () => ({ top: 0, height: 200 }) as DOMRect;
  const view = { contentDOM, scrollDOM, requestMeasure: (request: unknown) => { measure = request; } } as unknown as EditorView;
  const render = (row: number, existing?: HTMLTableRowElement) => {
    const tr = existing ?? document.createElement('tr'); tr.dataset.mdRow = String(row);
    if (!tr.cells.length) tr.insertCell();
    tr.getBoundingClientRect = () => ({ height: 64 }) as DOMRect; return tr;
  };
  const viewport = new TableViewport(view, box, table, 300, 1, render, () => null, () => {});
  try {
    measure.write(measure.read());
    const measured = viewport.snapshot();
    expect(measured.measured[0]).toBe(true);
    viewport.update(6501, 1, render, undefined, undefined, 300);
    expect(viewport.snapshot().heights.slice(0, measured.heights.length)).toEqual(measured.heights);
    expect(viewport.snapshot().measured.slice(0, measured.measured.length)).toEqual(measured.measured);
    expect(viewport.snapshot().heights[6500]).toBe(TABLE_ROW_ESTIMATE_PX);
    // 实际编辑只保留经调用方验证未变的前缀，其余行重新估计。
    viewport.update(6501, 1, render, undefined, undefined, 2);
    expect(viewport.snapshot().heights.slice(0, 3)).toEqual([64, 64, TABLE_ROW_ESTIMATE_PX]);
  } finally { viewport.destroy(); box.remove(); }
});
