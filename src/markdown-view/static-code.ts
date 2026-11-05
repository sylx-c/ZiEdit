import type { Tree } from '@lezer/common';
import { codeLanguage } from './code-tokens';
import { hasHighlight, loadHighlightParser } from '../text-view/highlight';

export function staticCodeLanguage(language: string): string {
  const aliases: Record<string, string> = { js: 'JavaScript', ts: 'TypeScript', json: 'JSON', yaml: 'YAML', yml: 'YAML', md: 'Markdown', cpp: 'C++', c: 'C', xml: 'XML', html: 'HTML', css: 'CSS', sql: 'SQL' };
  return aliases[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
}

interface OfflineHighlighter {
  getLanguage(name: string): unknown;
  highlight(source: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
}
export const staticHighlighter = (): OfflineHighlighter | undefined =>
  workerHighlighter ?? (globalThis as unknown as { hljs?: OfflineHighlighter }).hljs;

let ready: Promise<void> | undefined;
let workerHighlighter: OfflineHighlighter | undefined;
let codeWorker: Worker | MessagePort | undefined;
let workerSerial = 0;
const workerCode = new Map<string, string>();
const workerPending = new Map<number, { source: string; key: string; resolve: () => void; timer: ReturnType<typeof setTimeout> }>();
let codeWorkerFailed = false;
function stopCodeWorker(): void {
  codeWorkerFailed = true;
  if (codeWorker) { if ('terminate' in codeWorker) codeWorker.terminate(); else codeWorker.close(); }
  codeWorker = undefined;
  for (const job of workerPending.values()) { clearTimeout(job.timer); job.resolve(); }
  workerPending.clear();
}

async function prepareWorkerCode(text: string, tree: Tree, connect?: () => Promise<MessagePort>): Promise<void> {
  const jobs: Promise<void>[] = [];
  const active = new Set<string>();
  const missing: Array<{ source: string; language: string; key: string }> = [];
  tree.iterate({ enter(node) {
    if (node.name !== 'FencedCode' && node.name !== 'CodeBlock') return;
    const info = node.node.getChild('CodeInfo');
    const language = info ? codeLanguage(text.slice(info.from, info.to)) : '';
    if (!language || ['text', 'txt', 'plaintext', 'math', 'mermaid'].includes(language)) return false;
    let source = node.node.getChildren('CodeText').map(part => text.slice(part.from, part.to)).join('\n');
    if (source && !source.endsWith('\n')) source += '\n';
    const key = language + '\0' + source;
    if (active.has(key)) return false;
    active.add(key);
    if (workerCode.has(key) || codeWorkerFailed) return false;
    missing.push({ source, language, key });
    return false;
  } });
  if (missing.length && !codeWorkerFailed) {
    try {
      if (!codeWorker) {
        // 避免依赖原生随包协议下会失效的嵌套 Worker。
        // 页面只负责连接两个后台服务；高亮结果通过端口直达文档 Worker。
        codeWorker = connect ? await connect() : new Worker(new URL('./code-worker.ts', import.meta.url));
        codeWorker.onmessage = (event: MessageEvent<{ id: number; tokens?: import('./code-tokens').CodeToken[] }>) => {
          const job = workerPending.get(event.data.id); if (!job) return;
          workerPending.delete(event.data.id); clearTimeout(job.timer);
          const esc = (value: string): string => value.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
          let html = '', offset = 0;
          for (const token of event.data.tokens ?? []) {
            html += esc(job.source.slice(offset, token.from)) + '<span class="' + token.classes + '">' + esc(job.source.slice(token.from, token.to)) + '</span>';
            offset = token.to;
          }
          workerCode.set(job.key, html + esc(job.source.slice(offset))); job.resolve();
        };
        if ('terminate' in codeWorker) codeWorker.onerror = stopCodeWorker;
        else { codeWorker.onmessageerror = stopCodeWorker; codeWorker.start(); }
      }
      for (const { source, language, key } of missing) {
        const id = ++workerSerial;
        jobs.push(new Promise(resolve => workerPending.set(id, { source, key, resolve, timer: setTimeout(stopCodeWorker, 2500) })));
        codeWorker.postMessage({ id, language, source });
      }
    } catch { stopCodeWorker(); }
  }
  await Promise.all(jobs);
  workerHighlighter = { getLanguage: () => true, highlight: (source, opts) => ({ value: workerCode.get(opts.language + '\0' + source)
    ?? source.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!) }) };
  // 当前序列化尚需读取的产物不能被缓存预算淘汰；下一文档不再使用时再释放。
  // 这与活动正文 DOM 相同，缓存上限只约束可回收的历史项。
  let bytes = 0;
  for (const [key, value] of [...workerCode].reverse()) {
    bytes += key.length + value.length;
    if (bytes > 4 * 1024 * 1024 && !active.has(key)) workerCode.delete(key);
  }
}
/** 随包 hljs 资产（v0.42 迁自旧组件资产目录，其后独立承载） */
const HLJS_ASSETS = ['/renderers/highlight/highlight.min.js', '/renderers/highlight/third-languages.js'];
/** 一轮冷渲染至多预热一次；每块序列化仍为同步。只加载固定随包资产，零网络。 */
export function prepareStaticCode(text: string, tree: Tree, connect?: () => Promise<MessagePort>): Promise<void> {
  if (typeof document === 'undefined') return prepareWorkerCode(text, tree, connect);
  let needsCode = false;
  const parserLanguages = new Set<string>();
  tree.iterate({ enter(node) {
    if (node.name !== 'FencedCode') return;
    const info = node.node.getChild('CodeInfo');
    const language = info ? codeLanguage(text.slice(info.from, info.to)) : '';
    if (language && !['text', 'txt', 'plaintext', 'math', 'mermaid'].includes(language)) {
      const syntaxLanguage = staticCodeLanguage(language);
      const offline = staticHighlighter();
      if (offline?.getLanguage(codeLanguage(language))) return false;
      const parts = node.node.getChildren('CodeText');
      const sourceLength = parts.reduce((length, part) => length + part.to - part.from, Math.max(0, parts.length - 1));
      if (hasHighlight(syntaxLanguage, sourceLength)) parserLanguages.add(syntaxLanguage);
      else needsCode = true;
    }
    return false;
  } });
  const parsersReady = Promise.all([...parserLanguages].map(loadHighlightParser)).then(() => undefined);
  if (!needsCode || staticHighlighter()) return parsersReady;
  return parsersReady.then(() => ready ??= (async () => {
    for (const src of HLJS_ASSETS) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        const finish = (error?: Error): void => {
          clearTimeout(timer); script.onload = script.onerror = null;
          if (error) { script.remove(); reject(error); } else resolve();
        };
        const timer = setTimeout(() => finish(new Error('Offline code highlight timeout')), 4000);
        script.onload = () => finish(); script.onerror = () => finish(new Error('Offline code highlight unavailable'));
        script.src = src; document.head.appendChild(script);
      });
    }
  })().catch(error => { ready = undefined; throw error; }));
}
