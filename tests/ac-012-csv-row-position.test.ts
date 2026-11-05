// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { CsvView, CSV_ROW_HEIGHT, type TableRecordProvider } from '../src/csv-view/table';

it.each([true, false])('行按窗口内偏移定位，滚动复用时重设 top（firstRowHeader=%s）', async firstRowHeader => {
  const records = Array.from({ length: 20 }, (_, i) => ({ no: i + 1, cells: [`row-${i + 1}`] }));
  const provider: TableRecordProvider = {
    supportsDelimiter: true,
    supportsSource: true,
    firstRowHeader,
    records: async (_path, from, to) => ({
      records: records.filter(r => r.no >= from && r.no <= to),
      total: records.length,
      delimiter: ',',
    }),
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new CsvView(host, 'small.csv', 'UTF-8', () => {}, undefined, provider);
  try {
    await view.mount();
    const rows = () => Array.from(host.querySelectorAll<HTMLDivElement>('.csv-row'));
    const expectOffsets = () => {
      expect(rows().length).toBeGreaterThan(2);
      expect(rows().map(row => row.style.top)).toEqual(rows().map((_, i) => `${i * CSV_ROW_HEIGHT}px`));
    };
    expectOffsets();
    const firstRecord = firstRowHeader ? 2 : 1;
    const reused = rows().find(row => row.textContent === 'row-5')!;
    expect(reused.style.top).toBe(`${(5 - firstRecord) * CSV_ROW_HEIGHT}px`);
    const body = reused.parentElement!;
    expect(body.style.transform).toBe('translateY(0px)');

    const scroller = host.querySelector<HTMLDivElement>('.csv-scroller')!;
    scroller.scrollTop = 5 * CSV_ROW_HEIGHT;
    scroller.dispatchEvent(new Event('scroll'));
    expectOffsets();
    expect(rows()[0]).toBe(reused);
    expect(reused.style.top).toBe('0px');
    expect(body.style.transform).toBe(`translateY(${(5 - firstRecord) * CSV_ROW_HEIGHT}px)`);
  } finally {
    view.destroy();
    host.remove();
  }
});
