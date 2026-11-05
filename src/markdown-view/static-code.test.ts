import { afterEach, expect, it, vi } from 'vitest';
import { staticMarkdownParser } from './static-html';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('文档 Worker 使用页面连接的端口，不创建嵌套 Worker；纯文字不请求端口', async () => {
  vi.stubGlobal('Worker', class { constructor() { throw new Error('Nested Worker unavailable'); } });
  const channel = new MessageChannel();
  const connect = vi.fn(async () => channel.port1);
  const requests = vi.fn((event: MessageEvent) => channel.port2.postMessage({ id: event.data.id,
    tokens: [{ from: 0, to: 5, classes: 'hljs-keyword' }, { from: 10, to: 18, classes: 'hljs-string' }] }));
  channel.port2.onmessage = requests;
  const { prepareStaticCode, staticHighlighter } = await import('./static-code');
  try {
    await prepareStaticCode('ordinary paragraph', staticMarkdownParser.parse('ordinary paragraph'), connect);
    expect(connect).not.toHaveBeenCalled();
    const source = 'const x = "中文<&😀";\n', text = ('```javascript\n' + source + '```\n\n').repeat(20);
    await prepareStaticCode(text, staticMarkdownParser.parse(text), connect);
    const html = staticHighlighter()!.highlight(source, { language: 'javascript', ignoreIllegals: true }).value;
    expect(connect).toHaveBeenCalledOnce();
    expect(requests).toHaveBeenCalledOnce();
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('<span class="hljs-string">"中文&lt;&amp;😀"</span>');
    expect(html.replace(/<[^>]+>/g, '')).toBe('const x = "中文&lt;&amp;😀";\n');
  } finally { channel.port1.close(); channel.port2.close(); }
});

it('当前文档的高亮产物超过缓存预算仍可序列化，下一文档释放旧产物', async () => {
  class CodeWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(request: { id: number; source: string }): void {
      // 模拟大量短 token 的合法 Worker 产物；主线程不创建正文 DOM。
      const tokens = Array.from({ length: request.source.trimEnd().length }, (_, from) => ({ from, to: from + 1, classes: 'hljs-keyword' }));
      queueMicrotask(() => this.onmessage?.({ data: { id: request.id, tokens } }));
    }
    terminate(): void {}
  }
  vi.stubGlobal('Worker', CodeWorker);
  const { prepareStaticCode, staticHighlighter } = await import('./static-code');
  const code = 'x'.repeat(140000) + '\n', text = '```javascript\n' + code + '```';
  await prepareStaticCode(text, staticMarkdownParser.parse(text));
  const first = staticHighlighter()!.highlight(code, { language: 'javascript', ignoreIllegals: true }).value;
  expect(first.length).toBeGreaterThan(4 * 1024 * 1024);
  expect(first.startsWith('<span class="hljs-keyword">x</span>')).toBe(true);
  const next = '```javascript\ny\n```';
  await prepareStaticCode(next, staticMarkdownParser.parse(next));
  expect(staticHighlighter()!.highlight('y\n', { language: 'javascript', ignoreIllegals: true }).value.includes('hljs-keyword')).toBe(true);
  expect(staticHighlighter()!.highlight(code, { language: 'javascript', ignoreIllegals: true }).value === code).toBe(true);
});
