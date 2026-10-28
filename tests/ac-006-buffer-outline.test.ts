// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mountOutlineRows, parseOutlineHeadings } from '../src/shell/outline';
import { symbolsFromText } from '../src/shell/panels';

vi.mock('../src/common/ipc', () => ({
  checksum: async () => '',
  findInFiles: async () => ({ files: [], scanned: 0, skipped: [], skippedCount: 0, limits: [], cancelled: false }),
  findCancel: async () => {},
  textSave: async () => ({ len: 0 }),
  normalizeSave: async () => 0,
  textLines: async () => [],
  textOpen: async () => ({ totalLines: 0 }),
}));

afterEach(() => vi.unstubAllGlobals());
it('编辑面大纲解析当前未保存的标题与Setext', async () => {
  const parse = parseOutlineHeadings('# Changed\n\nSecond\n---\n');
  expect((await parse.result).map(h => [h.text, h.line])).toEqual([['Changed', 0], ['Second', 2]]);
});

it('大缓冲走Worker，取消后终止并丢弃迟到标题', async () => {
  let worker!: { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; onmessage: ((e: unknown) => void) | null };
  vi.stubGlobal('Worker', class {
    postMessage = vi.fn(); terminate = vi.fn(); onmessage = null; onerror = null;
    constructor() { worker = this; }
  });
  const parse = parseOutlineHeadings('x'.repeat(300000));
  expect(worker.postMessage).toHaveBeenCalled();
  parse.cancel();
  expect(worker.terminate).toHaveBeenCalledOnce();
  worker.onmessage?.({ data: { headings: [{ text: 'stale' }] } });
  expect(await parse.result).toEqual([]);
});

it('侧栏外层滚动时标题DOM数量有界，滚动后正确定位并释放监听', () => {
  const scroller = document.createElement('div');
  scroller.className = 'sidebar-body';
  Object.defineProperty(scroller, 'clientHeight', { value: 600 });
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientHeight', { value: 120000 * 24 });
  scroller.append(host);
  const open = vi.fn();
  const list = mountOutlineRows(host, Array.from({ length: 120000 }, (_, i) => ({ line: i + 1, name: `H${i}` })), open);
  expect(host.querySelectorAll('.sym-item').length).toBeLessThan(40);
  scroller.scrollTop = 24000;
  scroller.dispatchEvent(new Event('scroll'));
  const first = host.querySelector<HTMLElement>('.sym-item')!;
  expect(first.dataset.line).toBe('995');
  first.click();
  expect(open).toHaveBeenCalledWith(994);
  list.dispose();
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event('scroll'));
  expect(host.querySelector<HTMLElement>('.sym-item')!.dataset.line).toBe('995');
});

it('代码大纲从缓冲文本提取符号（Lezer JS 与正则 Python 路径）', async () => {
  const { loadHighlightParser } = await import('../src/text-view/highlight');
  await loadHighlightParser('JavaScript');
  const js = symbolsFromText('function alpha() {}\nclass Beta {}\n', 'JavaScript');
  expect(js.map(s => s.name)).toEqual(expect.arrayContaining(['alpha', 'Beta']));
  expect(js).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'alpha', line: 1 }),
    expect.objectContaining({ name: 'Beta', line: 2 }),
  ]));
  const py = symbolsFromText('def foo():\n    pass\n\nclass Bar:\n    pass\n', 'Python');
  expect(py.map(s => s.name)).toEqual(['foo', 'Bar']);
  expect(py[0]!.line).toBe(1);
});
