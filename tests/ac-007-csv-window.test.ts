// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ records: vi.fn() }));
vi.mock('../src/common/ipc', () => ({ csvRecords: mock.records }));
import { CsvView, sniffDelim } from '../src/csv-view/table';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

it('嗅探不统计引号字段里的分隔符', () => {
  expect(sniffDelim('"a,b,c,d";second')).toBe(';');
});

it('滚动读取失败显示错误并清除旧行，后续滚动可重试', async () => {
  mock.records.mockResolvedValueOnce({ records: [{ no: 1, cells: ['a', 'b'] }, { no: 2, cells: ['one', 'two'] }], total: 100, delimiter: ',' });
  mock.records.mockRejectedValueOnce(new Error('CSV_RECORD_TOO_LARGE'));
  mock.records.mockResolvedValue({ records: [{ no: 2, cells: ['one', 'two'] }], total: 100, delimiter: ',' });
  const host = document.createElement('div');
  const view = new CsvView(host, 'test.csv', 'UTF-8', () => {});
  await view.mount();
  expect(host.querySelector('.csv-bar')!.textContent).toContain('CSV_RECORD_TOO_LARGE');
  expect(host.querySelectorAll('.csv-row')).toHaveLength(0);
  host.querySelector('.csv-scroller')!.dispatchEvent(new Event('scroll'));
  await tick();
  expect(host.querySelector('.csv-row')!.textContent).toBe('onetwo');
  view.destroy();
});

it('离开标签后迟到的CSV响应不能再改写共用宿主', async () => {
  let finish!: (value: unknown) => void;
  mock.records.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const host = document.createElement('div');
  const view = new CsvView(host, 'test.csv', 'UTF-8', () => {});
  const pending = view.mount();
  view.destroy(); host.textContent = 'next document';
  await tick(); // 记录提供器懒加载 ipc 经一个微任务后才调用 csvRecords（产品打磨批 1），先让它把 finish 挂上
  finish({ records: [{ no: 1, cells: ['a', 'b'] }], total: 1, delimiter: ',' }); await pending;
  expect(host.textContent).toBe('next document');
});

it('自动识别使用后端完整表头的分隔符，显式切换继续优先', async () => {
  mock.records.mockImplementation(async (_path, _from, _to, delimiter) => ({
    records: [{ no: 1, cells: ['a\nb', 'c'] }, { no: 2, cells: ['x', 'y'] }], total: 2, delimiter: delimiter || ';',
  }));
  const host = document.createElement('div');
  const view = new CsvView(host, 'multiline.csv', 'UTF-8', () => {});
  await view.mount();
  expect(view.delimiter).toBe(';');
  expect(host.querySelector('.csv-header')!.textContent).toBe('a\nbc');
  expect(host.querySelector('.csv-row')!.textContent).toBe('xy');
  view.setDelim('\t'); await tick();
  expect(view.delimiter).toBe('\t');
  view.destroy();
});
