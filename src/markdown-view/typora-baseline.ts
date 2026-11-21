// markdown-view/typora-baseline —— 004 Markdown Typora parity：对比与回归共用基准语料。
// 纯数据模块：仅被测试与验收流程引用，不进入任何运行时渲染路径（生产入口不引用即不打包）。
// 实体口径见 specs/004-markdown-typora-parity/data-model.md §1（Markdown Baseline Document）：
// source / blocks / lineEndingCases / expectedHeadings / expectedCodeCopies。

/** 代码块复制案例：doc 为 LF 归一后的源文档；codeAt 为目标围栏起始偏移（``` 或 ~~~ 处）；expected 为完整块复制期望文本。 */
export interface CodeCopyCase {
  name: string;
  doc: string;
  codeAt: number;
  expected: string;
}

/** 20+ 代码块样本（spec FR-008 / SC-001；含空块、Unicode、Tab、特殊字符、CRLF 源、无尾换行、超长单行）。 */
export const CODE_COPY_CASES: CodeCopyCase[] = [
  {
    name: '基本闭合 js 块',
    doc: '# T\n\n```js\nconst x = 1;\n```\n',
    codeAt: -1,
    expected: 'const x = 1;\n',
  },
  {
    name: '空围栏',
    doc: '```\n```\n',
    codeAt: -1,
    expected: '',
  },
  {
    name: '语言标记无正文',
    doc: '```python\n```\n',
    codeAt: -1,
    expected: '',
  },
  {
    name: 'Unicode 与 emoji',
    doc: '```\n中文注释 🎉 — em-dash\nconst s = "你好";\n```\n',
    codeAt: -1,
    expected: '中文注释 🎉 — em-dash\nconst s = "你好";\n',
  },
  {
    name: 'Tab 缩进内容',
    doc: '```\ndef f():\n\treturn 1\n```\n',
    codeAt: -1,
    expected: 'def f():\n\treturn 1\n',
  },
  {
    name: 'HTML 特殊字符',
    doc: '```html\n<div a="1">&amp;</div>\n<script>if (a < b && b > c) {}</script>\n```\n',
    codeAt: -1,
    expected: '<div a="1">&amp;</div>\n<script>if (a < b && b > c) {}</script>\n',
  },
  {
    name: '引号与反引号',
    doc: '```\n"double" ' + "'single'" + ' `tick`\n```\n',
    codeAt: -1,
    expected: '"double" \'single\' `tick`\n',
  },
  {
    name: 'CRLF 源文件（渲染前归一 LF）',
    doc: '# T\r\n\r\n```js\r\nconst y = 2;\r\n```\r\n',
    codeAt: -1,
    expected: 'const y = 2;\n',
  },
  {
    name: '伪闭合栏（CommonMark：非行首 ``` 属于内容，未闭合到文档尾）',
    doc: '```js\nfoo```',
    codeAt: -1,
    expected: 'foo```',
  },
  {
    name: '超长单行',
    doc: '```\n' + 'x'.repeat(600) + '\n```\n',
    codeAt: -1,
    expected: 'x'.repeat(600) + '\n',
  },
  {
    name: '多行混合',
    doc: '```ts\nconst a = 1;\n\n// 注释\nconst b = 2;\n```\n',
    codeAt: -1,
    expected: 'const a = 1;\n\n// 注释\nconst b = 2;\n',
  },
  {
    name: '未闭合围栏（文档尾）',
    doc: '正文\n\n```js\nconst z = 3;',
    codeAt: -1,
    expected: 'const z = 3;',
  },
  {
    name: '波浪线围栏',
    doc: '~~~py\nprint(1)\n~~~\n',
    codeAt: -1,
    expected: 'print(1)\n',
  },
  {
    name: '块内容含空行',
    doc: '```\na\n\n\nb\n```\n',
    codeAt: -1,
    expected: 'a\n\n\nb\n',
  },
  {
    name: '重复内容两块（定位互不干扰）',
    doc: '```\nsame();\n```\n\n段落\n\n```\nsame();\n```\n',
    codeAt: -1,
    expected: 'same();\n',
  },
  {
    name: '引用内围栏',
    doc: '> ```js\n> const q = 1;\n> ```\n',
    codeAt: -1,
    expected: 'const q = 1;\n',
  },
  {
    name: '无语言标记多行',
    doc: '```\nplain\ncode\n```\n',
    codeAt: -1,
    expected: 'plain\ncode\n',
  },
  {
    name: '行内代码共存（不受行内 code 影响）',
    doc: '文本 `code` 与\n\n```js\nblock();\n```\n',
    codeAt: -1,
    expected: 'block();\n',
  },
  {
    name: '闭合栏多余空格',
    doc: '```js\nfoo()\n```   \n',
    codeAt: -1,
    expected: 'foo()\n',
  },
  {
    name: '语言带参数（info 全串）',
    doc: '```js title="x"\nfoo();\n```\n',
    codeAt: -1,
    expected: 'foo();\n',
  },
  {
    name: '缩进代码块（4 空格）',
    doc: '段落\n\n    indented()\n    more()\n\n尾随\n',
    codeAt: -1,
    expected: 'indented()\nmore()\n',
  },
];

// codeAt 统一在导出后回填：以各 doc 中第一个围栏/缩进块特征定位，避免手写偏移漂移。
{
  const fences = ['```', '~~~'];
  for (const item of CODE_COPY_CASES) {
    const doc = item.doc;
    let found = -1;
    for (const f of fences) {
      const p = doc.indexOf(f);
      if (p !== -1 && (found === -1 || p < found)) found = p;
    }
    if (found === -1) {
      // 缩进代码块案例：CodeBlock.from 不含缩进前缀，定位到内容首字符（与节点坐标一致）
      const m = /\n    (\S)/.exec(doc);
      found = m ? doc.indexOf(m[1]!) : 0;
    }
    item.codeAt = found !== -1 ? found : 0;
  }
}

/** 标题结构案例（spec SC-002）：H1-H6、中英、重复、行内格式、邻接块。 */
export interface HeadingCase {
  name: string;
  doc: string;
  /** 期望标题（层级、可见文本），与 extractMarkdownMetadata 的 headings 对齐 */
  expected: Array<{ level: number; text: string }>;
}

export const HEADING_CASES: HeadingCase[] = [
  {
    name: 'H1-H6 全级别',
    doc: '# 一\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六\n',
    expected: [
      { level: 1, text: '一' }, { level: 2, text: '二' }, { level: 3, text: '三' },
      { level: 4, text: '四' }, { level: 5, text: '五' }, { level: 6, text: '六' },
    ],
  },
  {
    name: '英文标题',
    doc: '# English Title\n\nBody\n',
    expected: [{ level: 1, text: 'English Title' }],
  },
  {
    name: '重复标题',
    doc: '# 重复\n\n# 重复\n',
    expected: [{ level: 1, text: '重复' }, { level: 1, text: '重复' }],
  },
  {
    name: '标题含强调',
    doc: '# 带 **粗体** 标题\n',
    expected: [{ level: 1, text: '带 粗体 标题' }],
  },
  {
    name: '标题含行内代码',
    doc: '## 使用 `npm ci`\n',
    expected: [{ level: 2, text: '使用 npm ci' }],
  },
  {
    name: '标题紧邻代码块',
    doc: '# 代码节\n```js\nfoo();\n```\n',
    expected: [{ level: 1, text: '代码节' }],
  },
  {
    name: '标题紧邻表格',
    doc: '# 表节\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n',
    expected: [{ level: 1, text: '表节' }],
  },
  {
    name: '标题紧邻列表',
    doc: '# 列表节\n\n- 甲\n- 乙\n',
    expected: [{ level: 1, text: '列表节' }],
  },
  {
    name: '闭标记标题',
    doc: '# 对称 #\n',
    expected: [{ level: 1, text: '对称' }],
  },
  {
    name: '中文标点标题',
    doc: '### 「引号」、顿号——与空格\n',
    expected: [{ level: 3, text: '「引号」、顿号——与空格' }],
  },
  {
    name: '标题含链接文本',
    doc: '# 见 [文档](https://example.com)\n',
    expected: [{ level: 1, text: '见 文档' }],
  },
];

/** 综合基准文档：标题 + 代码块 + 段落 + 列表 + 任务 + 引用 + 表格 + 链接 + 图片（quickstart Typora 对比用）。 */
export const TYPORA_BASELINE_DOC = [
  '# 基准文档标题',
  '',
  '开头段落，含 **强调**、*斜体*、`行内代码` 与 [链接](https://example.com)。',
  '',
  '## 代码块',
  '',
  '```ts',
  'const answer: number = 42;',
  'export function greet(name: string): string {',
  '  return `Hello, ${name}!`;',
  '}',
  '```',
  '',
  '无语言块：',
  '',
  '```',
  'plain text block',
  '```',
  '',
  '空块：',
  '',
  '```',
  '```',
  '',
  '## 列表与任务',
  '',
  '- 项目一',
  '  - 嵌套项目',
  '- 项目二',
  '',
  '- [ ] 待办',
  '- [x] 已完成',
  '',
  '## 引用',
  '',
  '> 引用第一行',
  '> 引用第二行',
  '',
  '## 表格',
  '',
  '| 名称 | 值 |',
  '| --- | ---: |',
  '| 甲 | 1 |',
  '| 乙 | 2 |',
  '',
  '### 三级标题（中文）',
  '',
  '#### Level Four English',
  '',
  '##### 五级',
  '',
  '###### 六级',
  '',
  '重复标题：',
  '',
  '## 代码块',
  '',
  '![本地图片](./local.png)',
  '',
  '尾部段落。',
  '',
].join('\n');
