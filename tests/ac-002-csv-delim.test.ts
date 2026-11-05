// @vitest-environment jsdom
// 002 CSV 表格态「分隔符▾」验收（H-6h 根修）：用户显式选择的分隔符必须在重挂载后仍然生效。
// 修前缺陷：setDelim 只写 this.delim 就调 mount()，而 mount() 开头无条件
// `this.delim = sniffDelim(首行)` 把它盖回去——点「分号（;）」后表格原样弹回逗号口径，
// 表头/列数纹丝不动（harness 实测复现：header 仍 id,name,score、info 仍「分隔符 "," · 3 列」）。
// 修后契约：显式选择记入 delimOverride，mount 以 override ?? 嗅探 取值。
import { describe, expect, it, vi } from 'vitest';

const CSV = 'id,name,score\n1,alice,90\n2,bob,85\n';

vi.mock('../src/common/ipc', () => ({
  textLines: async () => [{ no: 1, text: CSV.split('\n')[0] }],
  csvRecords: async (_p: string, from: number, to: number, delim: string) => {
    delim ||= ',';
    const lines = CSV.split('\n').filter(l => l !== '');
    // 契约：记录号 1-based 含端点，记录 1 = 表头物理行（与 Rust csv_records 对齐）
    const records = lines.map((l, i) => ({ no: i + 1, cells: l.split(delim) }));
    return { records: records.slice(Math.max(0, from - 1), to), total: records.length, delimiter: delim };
  },
  xlsxRecords: async (_p: string, sheet: number) => ({ records: [{ no: 1, cells: [`sheet-${sheet}`, '42'] }], total: 1 }),
}));

const { CsvView, xlsxRecordProvider } = await import('../src/csv-view/table');

async function mountedView(): Promise<InstanceType<typeof CsvView>> {
  const v = new CsvView(document.createElement('div'), '/mock/a.csv', 'UTF-8', () => {});
  await v.mount();
  return v;
}

describe('002 CSV 表格态分隔符', () => {
  it('xlsx 提供器保留首行数据，隐藏源码入口且忽略分隔符', async () => {
    const host = document.createElement('div');
    const v = new CsvView(host, '/mock/a.xlsx', 'UTF-8', () => {}, undefined, xlsxRecordProvider(1));
    await v.mount();
    expect(v.supportsDelimiter).toBe(false);
    expect(host.querySelector('button')?.hidden).toBe(true);
    expect(host.querySelector('.csv-header')?.textContent).toBe('AB');
    expect(host.querySelector('.csv-row')?.textContent).toBe('sheet-142');
    v.setDelim(';');
    expect(v.delimiter).toBe('');
    v.destroy();
  });
  it('销毁后新视图可带回显式分隔符，避免标签切换后重新嗅探', async () => {
    const first = await mountedView();
    first.setDelim(';');
    await vi.waitFor(() => expect(first.delimiter).toBe(';'));
    const chosen = first.delimiter;
    first.destroy();
    const host = document.createElement('div');
    const next = new CsvView(host, '/mock/a.csv', 'UTF-8', () => {}, chosen);
    await next.mount();
    expect(next.delimiter).toBe(';');
    expect(host.querySelectorAll('.csv-header .csv-cell')).toHaveLength(1);
    expect(host.querySelector('.csv-row')?.textContent).toBe('1,alice,90');
    next.destroy();
  });
  it('初始挂载按首行嗅探（逗号文件 → 逗号口径 3 列）', async () => {
    const v = await mountedView();
    expect(v.delimiter).toBe(',');
  });

  it('setDelim 后重挂载，显式选择压过嗅探（H-6h 修复项）', async () => {
    const v = await mountedView();
    v.setDelim(';');
    await new Promise(r => setTimeout(r, 50)); // mount 是异步的
    expect(v.delimiter).toBe(';');
    // 同一缺陷家族的第二处：重挂重建 body 但 renderedKey 未失效 → 首个 render() 命中旧 key
    // 跳过，数据行全空。锁死：重挂后 DOM 里必须有数据行（此夹具按分号口径 = 每行 1 格整行）。
    const host = (v as unknown as { host: HTMLElement }).host; // private 字段，测试借道断言 DOM
    const rows = [...host.querySelectorAll('.csv-row')].map(r => [...r.querySelectorAll('.csv-cell')].map(c => c.textContent));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toEqual(['1,alice,90']);
  });

  it('选回原分隔符也生效（覆盖链 ；→ ，）', async () => {
    const v = await mountedView();
    v.setDelim('\t');
    await new Promise(r => setTimeout(r, 50));
    expect(v.delimiter).toBe('\t');
    v.setDelim(',');
    await new Promise(r => setTimeout(r, 50));
    expect(v.delimiter).toBe(',');
  });
});
