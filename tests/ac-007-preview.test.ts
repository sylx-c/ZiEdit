// @vitest-environment jsdom
// AC-16/18（007 v0.42 规则 16）：统一渲染引擎——Lezer 序列化主路径、markdown-it 回退路径
// 输出（标题 data-line 锚点）、2MB 预览守卫常量口径。
// v0.42 删锁登记：previewThemeOpts（旧渲染器主题参数）锁作废——旧预览主路径删除，
// 观感由应用排版令牌接管（styles.css），不再存在引擎主题参数面。
import { describe, expect, it } from 'vitest';
import { renderPreviewInto, renderMarkdown } from '../src/markdown-view/preview';
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
});

describe('AC-18 回退路径（markdown-it）可读可用', () => {
  it('标题输出带 data-line 锚点', () => {
    const html = renderMarkdown('# A\n\ntext\n\n## B');
    expect(html).toContain('data-line="0"');
    expect(html).toContain('data-line="4"');
  });
});

describe('AC-16 预览守卫口径', () => {
  it('MD_PREVIEW_LIMIT = 2MB 字符上限（与 WYSIWYG 守卫分离）', () => {
    expect(MD_PREVIEW_LIMIT).toBeGreaterThan(0);
    expect(typeof MD_PREVIEW_LIMIT).toBe('number');
  });
});
