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
  (globalThis as unknown as { hljs?: OfflineHighlighter }).hljs;

let ready: Promise<void> | undefined;
/** 随包 hljs 资产（v0.42 迁自旧组件资产目录，其后独立承载） */
const HLJS_ASSETS = ['/renderers/highlight/highlight.min.js', '/renderers/highlight/third-languages.js'];
/** 一轮冷渲染至多预热一次；每块序列化仍为同步。只加载固定随包资产，零网络。 */
export function prepareStaticCode(text: string, tree: Tree): Promise<void> {
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
