// 大纲联动数据源（007 规则 3）—— 标题树提取纯逻辑（v0.8 自 wysiwyg.ts 迁入 preview.ts；
// v0.16 引擎重造后静态渲染与 CM6 live preview（livepreview.ts）同引此源）
import { describe, expect, it } from 'vitest';
import { extractHeadings } from './preview';

describe('extractHeadings（007-AC-2 大纲联动）', () => {
  it('提取多级标题与层级', () => {
    const md = '# 一级\n正文\n## 二级\n### 三级\n';
    const heads = extractHeadings(md);
    expect(heads.map(h => [h.level, h.text])).toEqual([
      [1, '一级'],
      [2, '二级'],
      [3, '三级'],
    ]);
  });

  it('代码围栏内的 # 不算标题', () => {
    const md = '# 真\n```\n# 假\n```\n';
    const heads = extractHeadings(md);
    expect(heads).toHaveLength(1);
    expect(heads[0].text).toBe('真');
  });

  it('行尾关闭符与空标题忽略', () => {
    const heads = extractHeadings('#标题无空格\n####  \n## 好 ##\n');
    expect(heads).toHaveLength(1);
    expect(heads[0].text).toBe('好');
  });

  it('正文加下划长划线不再是标题（Setext 全局不解析）', () => {
    const heads = extractHeadings('# 一级\n\n**Git** 分支说明\n---------------------------------\n');
    expect(heads).toHaveLength(1);
    expect(heads[0].text).toBe('一级');
  });

  it('大纲条目剥离行内标记（加粗/行内码/斜体）', () => {
    const heads = extractHeadings('## **加粗** 与 `行内码` 和 *斜体*\n');
    expect(heads).toHaveLength(1);
    expect(heads[0].text).toBe('加粗 与 行内码 和 斜体');
  });

  it('大纲条目剥离链接与图片标记，保留可读文字', () => {
    const heads = extractHeadings('## 参考 [链接文字](https://example.com) 与 ![替代文字](a.png)\n');
    expect(heads).toHaveLength(1);
    expect(heads[0].text).toBe('参考 链接文字 与 替代文字');
  });
});
