import { afterEach, expect, it, vi } from 'vitest';
import { safeSyntaxLanguage, safeSyntaxText, JSON_MAX_LINE_CHARS } from '../src/text-view/language-guard';
import { highlightLines, extractTreeSymbols } from '../src/text-view/highlight';
import { CSV_COLUMN_BATCH, renderColumnBatches } from '../src/csv-view/table';

afterEach(() => vi.unstubAllGlobals());

it('超长 JSON 在构建解析器前降级，多行 JSON 保持语法', () => {
  const long = JSON.stringify({ value: 'x'.repeat(JSON_MAX_LINE_CHARS) });
  expect(safeSyntaxLanguage('JSON', [long])).toBeNull();
  expect(highlightLines([long], 'JSON')).toEqual([[]]);
  expect(extractTreeSymbols(long, 'JSON')).toEqual([]);
  expect(safeSyntaxText('JSON', long)).toBeNull();
  expect(safeSyntaxLanguage('JSON', ['{', '  "value": 1', '}'])).toBe('JSON');
  expect(safeSyntaxText('JSON', '{\n  "value": 1\n}')).toBe('JSON');
});

it('300 列 × 50 行首批立即返回，其余分帧完成且无丢列', () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  const rows = Array.from({ length: 50 }, () => [] as number[]);
  renderColumnBatches(300, (from, to) => {
    for (const row of rows) for (let c = from; c < to; c++) row.push(c);
  });
  expect(rows.every(row => row.length === CSV_COLUMN_BATCH)).toBe(true);
  while (frames.length) frames.shift()!(0);
  for (const row of rows) expect(row).toEqual(Array.from({ length: 300 }, (_, i) => i));
});

it('失效任务不再补列', () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  let active = true;
  const render = vi.fn();
  renderColumnBatches(300, render, () => active);
  active = false;
  frames.shift()!(0);
  expect(render).toHaveBeenCalledTimes(1);
});
