// @vitest-environment jsdom
// D-T2-01 回归锁：~2MiB 级 Markdown 分屏渲染（007 规则 6/24）。
// 历史根因：逐块 projectMarkdownSource 的全文投影导致 O(n²)/70s+；两层修复的分片与代际锁保留。
// 本批改锁同一 Lezer 树上的同步静态序列化预算，不再运行旧引擎投影。
import { describe, expect, it } from 'vitest';
import { parser as cmParser, GFM } from '@lezer/markdown';
import { liveMarkdownExtensions } from '../src/markdown-view/extensions';
import { extractMarkdownMetadata } from '../src/markdown-view/headings';
import { renderStaticHtml } from '../src/markdown-view/static-html';
import { splitTopBlocks, createBlockRenderer } from '../src/markdown-view/blockcache';

const gfmParser = cmParser.configure([GFM, liveMarkdownExtensions]);

/** 合成 dense 语料（D-T2-01 取证形态）：中文密集段落 + 公式/表格/围栏/任务列表/行内公式 */
function buildDenseDoc(targetChars: number): string {
  const parts: string[] = [];
  let total = 0;
  let i = 0;
  while (total < targetChars) {
    switch (i % 8) {
      case 0: parts.push(`## 第${i}节 基准\n\n`); break;
      case 1: parts.push(`这是第${i}段中文正文，用于模拟密集语料的段落块。`.repeat(3) + '\n\n'); break;
      case 2: parts.push(`$$E_${i} = mc^2 + \\frac{a}{b}$$\n\n`); break;
      case 3: parts.push(`| 列甲${i} | 列乙 |\n|---|---|\n| 数据${i} | 值 |\n\n`); break;
      case 4: parts.push('```js\nconst x' + i + ' = ' + i * 7 + ';\n```\n\n'); break;
      case 5: parts.push(`- [ ] 任务${i}\n- [x] 完成${i}\n`); break;
      case 6: parts.push(`行内公式 $a^2+b^2=c^2$ 与 \`code${i}\` 及 **粗体${i}**。\n\n`); break;
      default: parts.push(`> 引用块第${i}条\n\n`); break;
    }
    total += parts[parts.length - 1]!.length;
    i++;
  }
  return parts.join('');
}

describe('D-T2-01 大文档分屏渲染（1.3M 字符级）', () => {
  const DOC = buildDenseDoc(1_302_503);
  const tree = gfmParser.parse(DOC);
  const blocks = splitTopBlocks(DOC, tree);
  const metadata = extractMarkdownMetadata(DOC);

  it('合成语料规模与取证一致（1.3M 字符 / 数万块 / 数千公式与围栏）', () => {
    expect(DOC.length).toBeGreaterThan(1_200_000);
    expect(blocks.length).toBeGreaterThan(10_000);
    expect(metadata.renderBlocks.length + metadata.verbatimRanges.length).toBeGreaterThan(10_000);
  });

  it('逐块 static-html 在时限内完成且公式块均为渲染占位', () => {
    const budgetMs = 5_000;
    const t0 = Date.now();
    let placeholderBlocks = 0;
    for (const b of blocks) {
      const out = renderStaticHtml(DOC, tree, metadata, b.from, b.to);
      expect(out.length).toBeGreaterThan(0);
      if (out.includes('md-render-target')) placeholderBlocks++;
    }
    expect(Date.now() - t0).toBeLessThan(budgetMs);
    expect(placeholderBlocks).toBeGreaterThan(1_000);
  }, 20_000);

  it('front matter 文档：块窗口跳过元数据，整篇语义不变', () => {
    const doc = '---\ntitle: t\n---\n\n正文 $x^2$ 起\n\n```js\ncode()\n```\n\n后文\n';
    const meta = extractMarkdownMetadata(doc);
    const parsed = gfmParser.parse(doc);
    for (const b of splitTopBlocks(doc, parsed)) {
      if (b.from < meta.frontMatter!.to) continue;
      expect(renderStaticHtml(doc, parsed, meta, b.from, b.to).length).toBeGreaterThan(0);
    }
    const whole = renderStaticHtml(doc, parsed, meta);
    expect(whole).not.toContain('title: t');
    expect(whole).toContain('md-render-target');
  });

  it('分屏块级渲染器：1.3M 字符语料提交非空 .md-col（注入渲染器；修前 70s+ 空产出→进程崩溃）', async () => {
    const renderer = createBlockRenderer(async src => `<p>${src.trim().slice(0, 40)}</p>`);
    const host = document.createElement('div');
    const res = await renderer.render(host, DOC, { dark: false });
    expect(res.committed).toBe(true);
    expect(res.engine).toBe('lezer');
    const col = host.firstElementChild as HTMLElement;
    expect(col.className).toBe('md-col');
    expect(col.children.length).toBe(blocks.length); // 每个顶层块一件
    expect(col.textContent?.length ?? 0).toBeGreaterThan(10_000);
  }, 120_000);
});
