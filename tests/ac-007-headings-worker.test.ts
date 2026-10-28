// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { LivePreviewView } from '../src/markdown-view/livepreview';
import { mountOutlineRows } from '../src/shell/outline';

vi.mock('../src/common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textReadAll: async () => '', textSave: async () => {} }));
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

describe('007 大文档标题处理', () => {
  it.each([20000, 60000])('%i行文档的异步旧结果不覆盖新文档，忙时合并最新请求，销毁回收 Worker', async count => {
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage?: (event: MessageEvent) => void;
      onerror?: () => void;
      requests: { text: string; version: number }[] = [];
      terminated = false;
      constructor() { workers.push(this); }
      postMessage(request: { text: string; version: number }) { this.requests.push(request); }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakeWorker);
    let ready!: () => void;
    const gate = new Promise<void>(resolve => { ready = resolve; });
    const onHeadings = vi.fn();
    const remoteImages = vi.fn(async () => 'data:image/png;base64,AA==');
    const view = new LivePreviewView(document.createElement('div'), {
      path: 'large.md', encoding: 'UTF-8', initialDoc: '# A\n\n![图][asset]\n\n' + 'text\n'.repeat(count) + '\n[asset]: https://images.test/current.png',
      onStatus: () => {}, onSaved: () => {}, onHeadings, onReady: ready, remoteImages,
    });
    try {
      await gate;
      const worker = workers[0]!;
      // 大文档标题输入现在分段取文档后再投递，不能把 onReady 时刻当成 postMessage 已完成。
      await vi.waitFor(() => expect(worker.requests).toHaveLength(1));
      view.view.dispatch({ changes: { from: 0, to: 3, insert: '# B' } });
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(worker.requests).toHaveLength(1);
      worker.onmessage!({ data: { version: 0, headings: [{ level: 1, text: 'A', id: 'h-0', line: 0 }], references: { ASSET: { href: 'https://images.test/stale.png', title: '' } } } } as MessageEvent);
      expect(onHeadings).not.toHaveBeenCalled();
      expect(remoteImages).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(worker.requests).toHaveLength(2));
      worker.onmessage!({ data: { version: 1, headings: [{ level: 1, text: 'B', id: 'h-0', line: 0 }], references: { ASSET: { href: 'https://images.test/current.png', title: '' } } } } as MessageEvent);
      expect(onHeadings.mock.calls[0]![0][0].text).toBe('B');
      await vi.waitFor(() => expect(remoteImages).toHaveBeenCalledWith('https://images.test/current.png'));
      view.destroy();
      expect(worker.terminated).toBe(true);
    } finally { view.destroy(); vi.unstubAllGlobals(); }
  });

  it('十万标题的大纲 DOM 有界，深处点击与当前项仍对应源码行', () => {
    const host = document.createElement('div');
    const open = vi.fn();
    const rows = Array.from({ length: 100000 }, (_, i) => ({ name: `H${i}`, line: i * 3 + 1, level: 1 }));
    const list = mountOutlineRows(host, rows, open);
    expect(host.querySelectorAll('.sym-item').length).toBeLessThan(50);
    host.scrollTop = 40000 * 24; host.dispatchEvent(new Event('scroll'));
    list.setCurrent(rows[40000]!.line);
    const active = host.querySelector<HTMLElement>('.sym-item.cur')!;
    expect(active.dataset.line).toBe(String(rows[40000]!.line));
    active.click(); expect(open).toHaveBeenCalledWith(40000);
    expect(host.querySelectorAll('.sym-item').length).toBeLessThan(50);
    list.dispose();
  });
});
