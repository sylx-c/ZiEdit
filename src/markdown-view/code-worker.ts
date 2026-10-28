// 不使用顶层 import/export，确保开发服务器也能以 classic Worker 执行 importScripts。
type CodeToken = import('./code-tokens').CodeToken;

function codeTokens(html: string, source: string): CodeToken[] {
  const result: CodeToken[] = [], stack: string[] = [];
  let plain = '';
  for (const part of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (part === '</span>') {
      if (!stack.length) throw new Error('Unexpected highlight closing span');
      stack.pop();
    } else if (part.startsWith('<')) {
      const span = /^<span class="([\w -]+)">$/.exec(part);
      if (!span) throw new Error('Unexpected highlight markup');
      stack.push(span[1]!);
    } else {
      const text = part.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, entity: string) =>
        ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" })[entity]!);
      const from = plain.length;
      plain += text;
      // 内层 token（如字符串内变量）优先，不把父类带到同一节点上覆盖变量颜色。
      const classes = stack[stack.length - 1];
      if (classes && text.length) {
        const previous = result[result.length - 1];
        if (previous?.to === from && previous.classes === classes) previous.to = plain.length;
        else result.push({ from, to: plain.length, classes });
      }
    }
  }
  if (stack.length || plain !== source) throw new Error('Highlight text differs from source');
  return result;
}

// classic Worker 的固定同源资产；不接受文档提供的脚本路径，不使用 eval/CDN。
const scope = self as unknown as {
  importScripts(...urls: string[]): void;
  hljs?: { getLanguage(name: string): unknown; highlight(source: string, options: { language: string; ignoreIllegals: boolean }): { value: string } };
};
self.onmessage = (event: MessageEvent<{ id: number; language: string; source: string }>) => {
  const { id, language, source } = event.data;
  try {
    if (!scope.hljs) scope.importScripts('/renderers/highlight/highlight.min.js', '/renderers/highlight/third-languages.js');
    const hljs = scope.hljs!;
    const tokens = hljs.getLanguage(language)
      ? codeTokens(hljs.highlight(source, { language, ignoreIllegals: true }).value, source) : [];
    self.postMessage({ id, tokens });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
