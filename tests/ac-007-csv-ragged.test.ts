// @vitest-environment jsdom
// 007 CSV 边界表「各行列数不齐：按最大列数渲染，缺位为空」验收（阶段一面2 走查 T4 根修）。
// 修前缺陷：render 循环固定 c < this.header.length——比表头宽的行右侧格子被静默截掉
// （harness 面2 走查实锤：a,b,c / 1,2 / 3,4,5,6 → 行 3 只渲染 3 格丢 '6'）。
// 修后契约：渲染列数 = max(表头列数, 当前窗口最大行列数) 且单调不缩；表头补空、窄行缺位为空串。
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/common/ipc', () => ({
  csvRecords: async (_p: string, from: number, to: number, delim: string) => {
    // 记录号 1-based 含端点，记录 1 = 表头（与 Rust csv_records 契约对齐）
    const records = [
      { no: 1, cells: ['a', 'b', 'c'] },
      { no: 2, cells: ['1', '2'] },
      { no: 3, cells: ['3', '4', '5', '6'] },
    ];
    return { records: records.slice(Math.max(0, from - 1), to), total: records.length, delimiter: delim || ',' };
  },
}));

const { CsvView } = await import('../src/csv-view/table');

async function mountRagged(): Promise<{ host: HTMLElement; view: InstanceType<typeof CsvView> }> {
  const host = document.createElement('div');
  const view = new CsvView(host, '/mock/ragged.csv', 'UTF-8', () => {});
  await view.mount();
  await new Promise(r => setTimeout(r, 50)); // mount 末尾的 render() 已 await，此处兜底异步链
  return { host, view };
}

describe('007 CSV 列数不齐渲染', () => {
  it('按窗口最大列数渲染：表头补空、宽行不丢格、窄行缺位为空', async () => {
    const { host, view } = await mountRagged();
    const headers = [...host.querySelectorAll('.csv-header .csv-cell')].map(c => c.textContent);
    const rows = [...host.querySelectorAll('.csv-row')].map(r => [...r.querySelectorAll('.csv-cell')].map(c => c.textContent));
    expect(headers).toEqual(['a', 'b', 'c', '']);   // 表头补第 4 列空位
    expect(rows[0]).toEqual(['1', '2', '', '']);    // 窄行缺位为空
    expect(rows[1]).toEqual(['3', '4', '5', '6']);  // 宽行不丢格（修前在此截断）
    view.destroy();
  });

  it('列数信息随最大列数更新（info 显示 4 列而非表头 3 列）', async () => {
    const { host, view } = await mountRagged();
    const info = host.querySelector('.csv-bar span');
    expect(info?.textContent).toContain('4 列');
    view.destroy();
  });
});
