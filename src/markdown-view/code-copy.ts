// markdown-view/code-copy —— 004 Markdown Typora parity：代码块纯文本复制契约。
// 复制结果只来自源文档语法树坐标（CodeText），绝不从渲染 DOM textContent 推导——
// 高亮 span、语言标签、装饰控件与渲染层换行都不得进入剪贴板（spec FR-002 / FR-003；
// 契约见 specs/004-markdown-typora-parity/contracts/markdown-ui-contract.md）。
import { parser } from '@lezer/markdown';
import type { SyntaxNode, Tree } from '@lezer/common';
import { markdownSyntaxExtensions } from './extensions';

/** 与静态渲染（static-html.staticMarkdownParser）同一语法配置：同一文本产出同一树坐标，
 *  data-md-code-from 偏移在两棵树间可互换。独立配置避免把渲染序列化链拖入 IR 依赖图。 */
const copyParser = parser.configure(markdownSyntaxExtensions);

/** 最小文档接口：CM6 EditorState.doc 与纯字符串测试替身共用。 */
interface DocLike {
  sliceString(from: number, to?: number): string;
  length: number;
}

/** 光标/选点向上找最近的代码块节点（FencedCode 或缩进 CodeBlock）；IR 右键「复制代码块」定位入口。 */
export function codeBlockNodeAt(tree: Tree, pos: number): SyntaxNode | null {
  let n: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (n && n.name !== 'FencedCode' && n.name !== 'CodeBlock') n = n.parent;
  return n;
}

/** 代码块正文纯文本：CodeText 源坐标拼接（多段间补行尾，与 static-html 序列化同口径）。
 *  CommonMark 语义：已终止的代码块内容恒以行尾结束——闭合栏存在（或块后还有内容）时
 *  补回 Lezer CodeText 不含的最后一个换行；未闭合块在文档尾结束且源无尾换行
 *  （`foo``` 紧贴文档尾）则不追加（data-model §2 lineEnding）。
 *  引用内围栏的每行 "> " 前缀按块首前缀宽度剥离（引用标记不属于代码内容）。 */
export function fencedCodeText(doc: DocLike, node: SyntaxNode): string {
  const parts = node.getChildren('CodeText');
  if (!parts.length) return '';
  // 引用嵌套前缀宽（projector fenceLines 同口径：首行围栏前的 "> "/空白宽度）
  const firstLine = doc.sliceString(docLineStart(doc, node.from), node.from);
  const prefixLength = /^[\t >]*/.exec(firstLine)![0].length;
  let source = '';
  for (let i = 0; i < parts.length; i++) {
    if (i && !source.endsWith('\n')) source += '\n';
    let text = doc.sliceString(parts[i]!.from, parts[i]!.to);
    if (prefixLength) {
      text = text.split('\n').map(line => {
        const lead = /^[ >\t]*/.exec(line)![0].length;
        return line.slice(Math.min(prefixLength, lead));
      }).join('\n');
    }
    source += text;
  }
  const marks = node.getChildren('CodeMark');
  // 缩进块（CodeBlock）按既有渲染基线恒补行尾（终止空行或文档尾均为完整块）；
  // 围栏块以闭合栏为准；未闭合围栏在文档尾结束且源无尾换行则不追加。
  const terminated = node.name === 'CodeBlock' || (marks.length > 1 && marks[marks.length - 1]!.to === node.to);
  if (source && !source.endsWith('\n') && (terminated || node.to < doc.length)) source += '\n';
  return source;
}

/** doc 接口无行查询：以字节回扫近似行首（CodeText 内容短，成本可忽略）。 */
function docLineStart(doc: DocLike, pos: number): number {
  const probe = doc.sliceString(Math.max(0, pos - 512), pos);
  const nl = probe.lastIndexOf('\n');
  return nl === -1 ? Math.max(0, pos - 512) : Math.max(0, pos - 512) + nl + 1;
}

/** 静态渲染侧定位：按 pre[data-md-code-from] 的源偏移在重解析树中找回代码块节点。 */
export function codeBlockAtOffset(text: string, offset: number): SyntaxNode | null {
  const tree = copyParser.parse(text);
  let found: SyntaxNode | null = null;
  tree.iterate({
    enter(node) {
      if (found || node.from > offset) return false;
      if ((node.name === 'FencedCode' || node.name === 'CodeBlock') && node.from === offset) {
        found = node.node;
        return false;
      }
      return undefined;
    },
  });
  return found;
}

/** 静态预览「复制代码块」动作取值：offset 无对应块（文档已变更/非代码块）返回 null。 */
export function copyCodeBlockText(text: string, offset: number): string | null {
  const node = codeBlockAtOffset(text, offset);
  if (!node) return null;
  const doc = { sliceString: (from: number, to?: number): string => text.slice(from, to), length: text.length };
  return fencedCodeText(doc, node);
}
