// @vitest-environment jsdom
// 渲染输入契约回归（2026-11-11）：外部文本可能带 CRLF/CR/混合行尾（Windows 保存的 .md 很常见），
// 进入 Markdown 渲染前必须归一为 LF。修前首开渲染预览走 textReadAll 原样读盘，@lezer/markdown 的
// GFM 表格分隔行判定不容忍行尾 \r，整张表退化成段落，HTML 折叠空白后显示成一行 `| 对比项 | ...`。
// 这里锁三层边界：createBlockRenderer.render（预览/分屏入口）、
// MarkdownDocumentClient.render（Worker/本地回退共用入口，sent/diff 记账）、
// MarkdownDocumentSession.update（Lezer 文档解析最后防线）。
import { beforeAll, describe, expect, it } from 'vitest';
import { createBlockRenderer } from './blockcache';
import { MarkdownDocumentClient } from './document-client';
import { MarkdownDocumentSession, blockHtml } from './document-model';
import { loadMarkdownIt } from './md';

const TABLE = [
  '| 对比项 | Docker 容器 | 虚拟机 |',
  '| --- | --- | --- |',
  '| 隔离方式 | Namespace、Cgroups 等 | Hypervisor |',
  '| 部署效率 | 高 | 相对较低 |',
].join('\n');

const DOC = [
  '# 标题',
  '',
  '正文 **粗体** 与 `行内码`。',
  '',
  TABLE,
  '',
  '- 列表一',
  '- 列表二',
  '',
  '> 引用段落',
  '',
  '结尾段落',
].join('\n');

const EOL_VARIANTS: Readonly<Record<string, string>> = {
  LF: DOC,
  CRLF: DOC.replace(/\n/g, '\r\n'),
  CR: DOC.replace(/\n/g, '\r'),
  // 三种行尾混排：首个换行 CRLF、第二个 CR、其余 LF。
  MIXED: DOC.replace('\n', '\r\n').replace('\n', '\r'),
  // 前导 BOM + CRLF：绕过文件解码层的输入（剪贴板/草稿/恢复快照）可能同时带两者。
  'BOM+CRLF': '\ufeff' + DOC.replace(/\n/g, '\r\n'),
};

beforeAll(async () => { await loadMarkdownIt(); });

describe('渲染输入契约：Markdown 渲染入口先归一 LF', () => {
  it('session.update：四种行尾产出同一文档文本、块结构与渲染 HTML', () => {
    const results = Object.entries(EOL_VARIANTS).map(([name, text]) => {
      const doc = new MarkdownDocumentSession().update(text);
      return {
        name,
        text: doc.text,
        kinds: doc.blocks.map(block => block.kind).join('|'),
        html: doc.blocks.map(block => blockHtml(doc, block)).join(''),
      };
    });
    const base = results[0]!;
    expect(base.text).not.toContain('\r');
    expect(base.html).toContain('<table>');
    for (const result of results.slice(1)) {
      expect(result.text, result.name).toBe(base.text);
      expect(result.kinds, result.name).toBe(base.kinds);
      expect(result.html, result.name).toBe(base.html);
    }
  });

  it('session.update：CRLF 表格解析为 Table 块而不是段落', () => {
    const doc = new MarkdownDocumentSession().update(TABLE.replace(/\n/g, '\r\n'));
    const table = doc.blocks.find(block => block.kind === 'Table');
    expect(table).toBeTruthy();
    const html = blockHtml(doc, table!);
    expect(html).toContain('<table>');
    expect(html).not.toContain('| 对比项');
  });

  it('client.render：CRLF 与 LF 正文产出相同块与 HTML', async () => {
    const crlfClient = new MarkdownDocumentClient();
    const crlf = await crlfClient.render(EOL_VARIANTS.CRLF!);
    const table = crlf.blocks.find(block => block.src.includes('对比项'))!;
    expect(table.kind).toBe('Table');
    expect(table.html).toContain('<table>');
    crlfClient.destroy();

    const lfClient = new MarkdownDocumentClient();
    const lf = await lfClient.render(EOL_VARIANTS.LF!);
    expect(crlf.blocks.map(block => block.kind)).toEqual(lf.blocks.map(block => block.kind));
    expect(crlf.blocks.map(block => block.html)).toEqual(lf.blocks.map(block => block.html));
    lfClient.destroy();
  });

  it('createBlockRenderer.render：预览/分屏入口收到 CRLF 正文仍渲染表格', async () => {
    const host = document.createElement('div');
    const renderer = createBlockRenderer();
    const result = await renderer.render(host, EOL_VARIANTS.CRLF!, { dark: false });
    expect(result.engine).toBe('lezer');
    expect(result.committed).toBe(true);
    expect(host.querySelector('table')).toBeTruthy();
    expect(host.textContent).not.toContain('| 对比项');
    renderer.destroy();
  });
});
