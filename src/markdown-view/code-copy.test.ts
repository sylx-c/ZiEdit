// 004 US1（T004）：代码块纯文本提取契约测试（Typora parity P1）。
// 断言 data-model §2 Code Block Copy Result.text / .range / .lineEnding：
// 复制结果 == CodeText 源文本，含尾换行与否与源一致，绝不含围栏/语言/装饰。
import { describe, expect, it } from 'vitest';
import { parser } from '@lezer/markdown';
import { markdownSyntaxExtensions } from './extensions';
import { codeBlockNodeAt, copyCodeBlockText, fencedCodeText } from './code-copy';
import { CODE_COPY_CASES, TYPORA_BASELINE_DOC } from './typora-baseline';
import { convertEol } from '../common/text';

const copyParser = parser.configure(markdownSyntaxExtensions);
const docOf = (text: string): { sliceString: (from: number, to?: number) => string; length: number } => ({
  sliceString: (from, to) => text.slice(from, to),
  length: text.length,
});

describe('fencedCodeText / codeBlockNodeAt（004 FR-001..FR-003）', () => {
  it.each(CODE_COPY_CASES)('$name：完整块复制 == 源 CodeText', ({ doc: rawDoc, codeAt, expected }) => {
    // 渲染输入契约：外部文本进渲染/复制路径前归一 LF（宪法 IV；CM 编辑缓冲恒 LF）。
    const doc = convertEol(rawDoc, '\n');
    const tree = copyParser.parse(doc);
    const node = codeBlockNodeAt(tree, codeAt + 3 > doc.length ? codeAt : codeAt + 3);
    expect(node, `应在 ${codeAt} 附近找到代码块节点`).not.toBeNull();
    expect(fencedCodeText(docOf(doc), node!)).toBe(expected);
    // 静态侧同源提取：offset 主键与 IR 树坐标一致
    expect(copyCodeBlockText(doc, node!.from)).toBe(expected);
  });

  it('非代码位置返回 null 节点 / null 复制值', () => {
    const doc = '# 标题\n\n段落文字。\n';
    const tree = copyParser.parse(doc);
    expect(codeBlockNodeAt(tree, doc.indexOf('段落'))).toBeNull();
    expect(copyCodeBlockText(doc, doc.indexOf('段落'))).toBeNull();
    expect(copyCodeBlockText(doc, 999999)).toBeNull();
  });

  it('光标落在围栏内任意位置都定位到同一块（右键定位入口）', () => {
    const doc = '```\naaa\n```\n\n```\nbbb\n```\n';
    const tree = copyParser.parse(doc);
    const second = doc.indexOf('bbb');
    for (let pos = second; pos < second + 3; pos++) {
      const node = codeBlockNodeAt(tree, pos)!;
      expect(fencedCodeText(docOf(doc), node)).toBe('bbb\n');
    }
    // 第一块不受第二块影响
    expect(fencedCodeText(docOf(doc), codeBlockNodeAt(tree, doc.indexOf('aaa'))!)).toBe('aaa\n');
  });

  it('基准综合文档：每个围栏的 offset 都能取回正文', () => {
    const doc = TYPORA_BASELINE_DOC;
    const tree = copyParser.parse(doc);
    const offsets: number[] = [];
    tree.iterate({
      enter(node) {
        if (node.name === 'FencedCode') { offsets.push(node.from); return false; }
        return undefined;
      },
    });
    expect(offsets.length).toBeGreaterThanOrEqual(3); // ts 块 / 无语言块 / 空块（§代码节）
    for (const offset of offsets) {
      const text = copyCodeBlockText(doc, offset);
      expect(text).not.toBeNull();
    }
    // ts 块内容逐字一致（Typora 复制等价）
    const tsBlock = offsets.map(o => copyCodeBlockText(doc, o)).find(t => t?.includes('greet'))!;
    expect(tsBlock).toBe('const answer: number = 42;\nexport function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n');
  });

  it('重复内容两块按 offset 区分（range 语义）', () => {
    const doc = '```\nsame();\n```\n\n段落\n\n```\nsame();\n```\n';
    const second = doc.indexOf('```', doc.indexOf('段落'));
    expect(copyCodeBlockText(doc, second)).toBe('same();\n');
    expect(copyCodeBlockText(doc, 0)).toBe('same();\n');
  });
});
