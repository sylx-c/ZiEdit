import type { SyntaxNode } from '@lezer/common';

export interface RenderBlock {
  kind: 'math' | 'mermaid';
  source: string;
  display: boolean;
  from: number;
  to: number;
}

/** 从已解析节点提取源码，代码、转义和未闭合结构不走渲染服务。 */
export function renderBlockAt(node: SyntaxNode, slice: (from: number, to: number) => string): RenderBlock | null {
  if (node.name === 'InlineMath' || node.name === 'MathBlock') {
    return { kind: 'math', source: node.getChildren('MathContent').map(part => slice(part.from, part.to)).join('\n'),
      display: node.name === 'MathBlock', from: node.from, to: node.to };
  }
  if (node.name !== 'FencedCode') return null;
  const info = node.getChild('CodeInfo'), marks = node.getChildren('CodeMark');
  const kind = info ? slice(info.from, info.to).trim().toLowerCase() : '';
  if ((kind !== 'math' && kind !== 'mermaid') || marks.length < 2) return null;
  const code = node.getChild('CodeText');
  let source = code ? slice(code.from, code.to) : '';
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === 'Blockquote') source = source.replace(/(^|\n) {0,3}> ?/g, '$1');
  }
  return { kind, source, display: true, from: node.from, to: node.to };
}

export const escapeRenderText = (text: string): string => text.replace(/[&<>"]/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);

export function renderPlaceholder(block: Pick<RenderBlock, 'kind' | 'source' | 'display'>): string {
  const tag = block.display ? 'div' : 'span';
  return `<${tag} class="md-render-target" data-render-kind="${block.kind}" data-render-display="${block.display ? '1' : '0'}"><code>${escapeRenderText(block.source)}</code></${tag}>`;
}
