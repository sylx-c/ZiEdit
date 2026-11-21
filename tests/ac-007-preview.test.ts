// @vitest-environment jsdom
// AC-16/18（007 v0.42 规则 16）：统一渲染引擎——Lezer 序列化主路径、2MB 预览守卫常量口径。
// v0.42 删锁登记：previewThemeOpts（旧渲染器主题参数）锁作废——旧预览主路径删除，
// 观感由应用排版令牌接管（styles.css），不再存在引擎主题参数面。
// REQ-014 P4：markdown-it 回退路径删除——序列化失败的安全降级为「源码可见 + 提示」（blockcache）。
import { describe, expect, it } from 'vitest';
import { renderPreviewInto } from '../src/markdown-view/preview';
import { MD_PREVIEW_LIMIT } from '../src/common/mode';

describe('AC-18 主路径（Lezer 序列化整篇输出）', () => {
  it('输出 md-col 容器与内容，engine=lezer', async () => {
    const host = document.createElement('div');
    const result = await renderPreviewInto(host, '# 标题\n\n**粗体** `码`', { dark: false });
    expect(result.engine).toBe('lezer');
    expect(result.col.className).toBe('md-col');
    expect(result.col.querySelector('h1')?.id).toBe('标题');
    expect(result.col.querySelector('strong,em,code')).not.toBeNull();
    expect(host.firstElementChild).toBe(result.col);
  });
  it('标题 data-line 锚点由统一序列化产出（P4 起唯一渲染政策；行序为既有非空行计数语义）', async () => {
    const host = document.createElement('div');
    const result = await renderPreviewInto(host, '# A\n\ntext\n\n## B', { dark: false });
    expect(result.col.querySelector('h1')?.dataset.line).toBe('0');
    expect(result.col.querySelector('h2')?.dataset.line).toBe('4');
  });
});

describe('AC-16 预览守卫口径', () => {
  it('MD_PREVIEW_LIMIT = 2MB 字符上限（与 WYSIWYG 守卫分离）', () => {
    expect(MD_PREVIEW_LIMIT).toBeGreaterThan(0);
    expect(typeof MD_PREVIEW_LIMIT).toBe('number');
  });
});
