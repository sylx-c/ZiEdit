// @vitest-environment jsdom
// FC 收口回归锁：冷启动（单例未预取、链接工具未注入）时，含实体与引用式链接的文档——
// ① markdownIt()/mdLinkTools() 确实处于未就绪态（冷启动模拟有效）；
// ② 源码大纲异步入口（extractHeadingsReady）不抛同步错误，实体解码正确；
// ③ 静态预览/分屏块渲染入口经就绪屏障正常渲染（不依赖预取恰好在场）；
// ④ 提取/资产异常时走既有 markdown-it 回退而不是冒泡。
import { afterEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ fail: false }));
vi.mock('./static-code', async original => {
  const real = await original<{ prepareStaticCode: (text: string, tree: unknown) => Promise<void> }>();
  return {
    ...real,
    prepareStaticCode: async (text: string, tree: unknown) => {
      if (gate.fail) throw new Error('asset fail');
      return real.prepareStaticCode(text, tree);
    },
  };
});

import { __coldStartForTest, markdownIt } from './md';
import { mdLinkTools } from './md-link';
import { extractHeadingsReady } from './headings';
import { renderPreviewInto } from './preview';
import { createBlockRenderer } from './blockcache';

// 实体（unescapeAll）+ 引用式链接（normalizeLink/validateLink）+ Autolink（automaticLinkTarget）
// 三类同步工具消费齐备的语料。
const DOC = '# T&#65;&#38;B\n\n[link][ref]\n\n[ref]: /t.md\n\n<https://e.x>\n';
afterEach(() => { gate.fail = false; });

describe('FC 收口：冷启动就绪屏障', () => {
  it('__coldStartForTest 后同步入口确实未就绪（模拟有效）', () => {
    __coldStartForTest();
    expect(() => markdownIt()).toThrow();
    expect(() => mdLinkTools()).toThrow();
  });

  it('源码大纲：extractHeadingsReady 冷启动含实体/引用文档不抛错且解码正确', async () => {
    __coldStartForTest();
    const heads = await extractHeadingsReady(DOC);
    expect(heads[0]!.text).toBe('T&#65;&#38;B'); // text 沿用源码（既有口径）
    expect(heads[0]!.id).toBe('tab'); // id 基于实体解码后的标题文本（需 unescapeAll）
    expect(heads[0]!.level).toBe(1);
  });

  it('静态预览：renderPreviewInto 冷启动渲染实体/引用/自动链接文档不抛错', async () => {
    __coldStartForTest();
    const host = document.createElement('div');
    const result = await renderPreviewInto(host, DOC, { dark: false });
    expect(result.engine).toBe('lezer');
    expect(host.querySelector('h1')!.id).toBe('tab'); // headingId 基于解码后的标题文本
    expect(host.innerHTML).toContain('href="/t.md"'); // 引用式链接（validateLink/normalizeLink）
    expect(host.innerHTML).toContain('https://e.x'); // Autolink（automaticLinkTarget）
  });

  it('静态预览回退：冷启动 + 资产异常走 markdown-it 回退，不冒泡', async () => {
    gate.fail = true;
    __coldStartForTest();
    const host = document.createElement('div');
    const result = await renderPreviewInto(host, DOC, { dark: false });
    expect(result.engine).toBe('fallback');
    expect(host.querySelector('.md-fallback')).toBeTruthy();
    expect(host.innerHTML).toContain('href="/t.md"'); // 回退路径同样完成引用式链接解析
  });

  it('分屏块渲染：createBlockRenderer 冷启动不抛错并正常提交', async () => {
    __coldStartForTest();
    const host = document.createElement('div');
    const result = await createBlockRenderer().render(host, DOC, { dark: false });
    expect(result.engine).toBe('lezer');
    expect(result.committed).toBe(true);
    expect(host.innerHTML).toContain('href="/t.md"');
  });

  it('分屏块渲染回退：冷启动 + 资产异常走 markdown-it 回退，不冒泡', async () => {
    gate.fail = true;
    __coldStartForTest();
    const host = document.createElement('div');
    const result = await createBlockRenderer().render(host, DOC, { dark: false });
    expect(result.engine).toBe('fallback');
    expect(result.committed).toBe(true);
    expect(host.querySelector('.md-fallback')).toBeTruthy();
  });
});
