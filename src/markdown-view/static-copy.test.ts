// 004 US1（T006）：静态阅读/分屏预览代码块复制测试（Typora parity P1）。
// 契约：渲染 DOM 的 pre 携带源偏移主键 data-md-code-from；复制取值只经
// copyCodeBlockText（源码坐标），不从 DOM textContent；无尾换行源不被追加换行。
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { staticMarkdownParser, renderStaticHtml } from './static-html';
import { extractMarkdownMetadata } from './headings';
import { copyCodeBlockText } from './code-copy';
import { CODE_COPY_CASES } from './typora-baseline';
import { convertEol } from '../common/text';

function render(doc: string): { html: string; tree: ReturnType<typeof staticMarkdownParser.parse> } {
  const text = convertEol(doc, '\n');
  const tree = staticMarkdownParser.parse(text);
  const metadata = extractMarkdownMetadata(text, tree);
  return { html: renderStaticHtml(text, tree, metadata), tree };
}

describe('静态渲染代码块源坐标（004 FR-002/FR-003）', () => {
  it('pre 携带 data-md-code-from 源偏移主键', () => {
    const doc = '# T\n\n```js\nfoo();\n```\n';
    const { html } = render(doc);
    expect(html).toContain('<pre data-md-code-from="' + doc.indexOf('```') + '"');
  });

  it('引用内围栏也带主键且复制值已剥引用前缀', () => {
    const doc = '> ```js\n> const q = 1;\n> ```\n';
    const { html } = render(doc);
    const fenceAt = doc.indexOf('```');
    expect(html).toContain(`data-md-code-from="${fenceAt}"`);
    expect(copyCodeBlockText(convertEol(doc, '\n'), fenceAt)).toBe('const q = 1;\n');
  });

  it('无末尾换行的源不被追加换行（渲染与复制同语义）', () => {
    const doc = '```js\nfoo```'; // 未闭合（CommonMark：非行首 ``` 属于内容）
    const { html } = render(doc);
    expect(copyCodeBlockText(doc, 0)).toBe('foo```');
    // 渲染 code 元素内不再有渲染层强加的尾换行（textContent == 源）
    const code = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html)![1]!;
    expect(code).toBe('foo```');
  });

  it.each(CODE_COPY_CASES.filter(c => c.name !== 'CRLF 源文件（渲染前归一 LF）'))(
    '$name：完整块复制 == 源 CodeText（静态侧）',
    ({ doc: rawDoc, codeAt, expected }) => {
      const doc = convertEol(rawDoc, '\n');
      const text = copyCodeBlockText(doc, codeAt);
      expect(text).toBe(expected);
    },
  );

  it('高亮 span 不参与复制取值（DOM 装饰与剪贴板隔离）', () => {
    const doc = '```html\n<div>&amp;</div>\n```\n';
    const { html } = render(doc);
    expect(html).toContain('&amp;'); // HTML 转义仅存在于渲染层
    expect(copyCodeBlockText(doc, doc.indexOf('```'))).toBe('<div>&amp;</div>\n');
  });
});
