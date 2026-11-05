import { expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ open: vi.fn(), lines: vi.fn() }));
vi.mock('../src/common/ipc', () => ({ textOpen: mock.open, textLines: mock.lines }));
import { extractSymbols } from '../src/shell/panels';

it('代码大纲跨5000/10000行边界，按实际短窗口推进且不漏符号', async () => {
  const symbols = [4999, 5000, 5001, 9999, 10000, 10001];
  mock.open.mockResolvedValue({ totalLines: 12000 });
  mock.lines.mockImplementation(async (_path, from, to) => {
    const end = Math.min(to, from + 1376);
    return Array.from({ length: end - from + 1 }, (_, i) => ({ no: from + i,
      text: symbols.includes(from + i) ? `export function symbol${from + i}() {}` : '' }));
  });
  const result = await extractSymbols('audit.ts', 'TypeScript', 'UTF-8');
  expect(result.map(s => s.line)).toEqual(symbols);
  expect(mock.lines.mock.calls.every(([, from, to]) => to - from < 5000)).toBe(true);
});
