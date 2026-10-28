import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { clipboardImageOf, imageIngestPlan, localImageName, imageMarkdown, readImageFile } from '../src/markdown-view/imagehost';

describe('Markdown clipboard image local fallback', () => {
  it('未配置图床仍询问；本地偏好直连，上传偏好退回询问', () => {
    expect(imageIngestPlan({ enabled: false })).toBe('ask');
    expect(imageIngestPlan({ enabled: false, pasteAction: 'local' })).toBe('local');
    expect(imageIngestPlan({ enabled: false, pasteAction: 'upload' })).toBe('ask');
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
});
