import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { clipboardImageOf, imageIngestPlan, localImageName, imageMarkdown, readImageFile } from '../src/markdown-view/imagehost';

describe('Markdown clipboard image local fallback', () => {
  it('未配置图床直接本地保存；配置图床按偏好直连', () => {
    expect(imageIngestPlan({ enabled: false })).toBe('local');
    expect(imageIngestPlan({ enabled: false, pasteAction: 'local' })).toBe('local');
    expect(imageIngestPlan({ enabled: false, pasteAction: 'upload' })).toBe('local');
    expect(imageIngestPlan({ enabled: true, pasteAction: 'upload' })).toBe('upload');
  });
  it('image/* 文件 → 字节 → hash+时间戳 → 相对引用', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'screenshot.png', { type: 'image/png' });
    const dt = { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } as unknown as DataTransfer;
    expect(clipboardImageOf(dt)).toBe(file);
    const src = await readImageFile(clipboardImageOf(dt)!);
    const name = await localImageName(src.bytes, src.mime, 123456);
    expect(name).toBe('039058c6f2c0.png');
    expect(imageMarkdown('screenshot', name)).toBe('![screenshot](039058c6f2c0.png)');
    // 走查 M：去时间戳后同图同名去重（不再 -N 后缀）
    expect(await localImageName(src.bytes, src.mime, 123457)).toBe(name);
    expect(clipboardImageOf({ items: [{ kind: 'string', type: 'text/plain' }] } as unknown as DataTransfer)).toBeNull();
  });
  it('接线：捕获粘贴、本地选项、草稿提示与 Rust 写入', () => {
    const app = readFileSync(new URL('../src/shell/app.ts', import.meta.url), 'utf8');
    const paste = app.slice(app.indexOf("document.addEventListener('paste'"), app.indexOf('// 拖放（001'));
    expect(paste).not.toContain('ihEnabled()');
    expect(paste).toContain('e.preventDefault()');
    expect(paste).toContain('e.stopPropagation()');
    expect(paste).toContain('}, true)');
    expect(app).toContain("flash($t('ih.saveMdFirst'))");
    expect(app).toContain('await imageWrite(`${dir}/${rel}`, bytesToBase64(bytes))');
    expect(app).toContain("if (ihEnabled()) mk($t('ih.upload')");
  });
  it('渲染预览形态粘贴/拖入同样入稿（2026-10-29 回归锁：默认形态改渲染预览后的连带缺口）', () => {
    const app = readFileSync(new URL('../src/shell/app.ts', import.meta.url), 'utf8');
    expect(app).toContain('function mdImageIngestContext');
    // 粘贴：非编辑器焦点（预览面）按标签级判定接管
    expect(app).toContain('editorFocused ? mdEditableContext(t) : mdImageIngestContext(t)');
    // 拖放拦截同口径；'md' 形态插入点=文档末尾+预览刷新+只读守卫
    expect(app).toContain('if (!mdImageIngestContext(t)) return false;');
    expect(app).toContain("modeOf(t) === 'md' && view");
    expect(app).toContain("flash($t('ih.insertedAtEnd'))");
    expect(app).toContain("flash($t('ih.readonlyTab'))");
  });
});
