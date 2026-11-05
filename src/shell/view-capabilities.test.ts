import { describe, expect, it } from 'vitest';
import { hasViewCapability, viewCapabilities } from './view-capabilities';

describe('视图能力是启用与执行的共同契约', () => {
  it('源码、即时渲染、流式查看分别开放真实可执行能力', () => {
    expect(hasViewCapability('edit', 'edit')).toBe(true);
    expect(hasViewCapability('ir', 'format')).toBe(true);
    expect(hasViewCapability('ir', 'sourceEdit')).toBe(false);
    expect(hasViewCapability('text', 'bookmark')).toBe(true);
    expect(hasViewCapability('image', 'edit')).toBe(false);
  });
  it('渲染预览不暴露隐藏源缓冲的编辑和书签能力', () => {
    const caps = viewCapabilities('edit', { markdown: true, preview: true });
    expect(caps.edit).toBe(false);
    expect(caps.bookmark).toBe(false);
    expect(caps.replace).toBe(false);
    expect(caps.sourceEdit).toBe(false);
    expect(caps.format).toBe(false);
    expect(caps.find).toBe(true);
  });
  it('源码 Markdown 才开放格式，普通源码不错误点亮', () => {
    expect(hasViewCapability('edit', 'format', { markdown: true })).toBe(true);
    expect(hasViewCapability('edit', 'format')).toBe(false);
  });
});
