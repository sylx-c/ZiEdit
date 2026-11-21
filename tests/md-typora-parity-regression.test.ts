// 004 US3（T016）：跨视图与契约回归（Typora parity P2）。
// 覆盖 spec FR-010/FR-011/FR-012 与 SC-004：共享剪贴板契约兼容、非 Markdown 视图零改动、
// app 两处预览菜单接线、execCommand 退场、大文档复制取值时限。
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const read = (p: string): string => readFileSync(resolve(__dirname, p), 'utf8');

describe('共享剪贴板契约（004 FR-004 / 宪法 IV 兼容）', () => {
  it('writeClipboardTextChecked：成功 true / 拒绝 false，不抛异常', async () => {
    const { writeClipboardTextChecked } = await import('../src/common/clipboard');
    const original = navigator.clipboard;
    const ok = vi.fn().mockResolvedValue(undefined);
    const bad = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: ok }, configurable: true });
    expect(await writeClipboardTextChecked('a')).toBe(true);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: bad }, configurable: true });
    expect(await writeClipboardTextChecked('a')).toBe(false);
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    expect(await writeClipboardTextChecked('a')).toBe(false);
    Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
  });

  it('writeClipboardText：既有静默契约不变（失败不抛、返回 void）', async () => {
    const { writeClipboardText } = await import('../src/common/clipboard');
    const original = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('x')) }, configurable: true });
    await expect(writeClipboardText('a')).resolves.toBeUndefined();
    Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
  });

  it('readClipboardText：出口 LF 归一口径保持（CRLF/CR→LF）', async () => {
    const { readClipboardText } = await import('../src/common/clipboard');
    const original = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => 'a\r\nb\rc' }, configurable: true });
    expect(await readClipboardText()).toBe('a\nb\nc');
    Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
  });
});

describe('非 Markdown 视图零改动（004 FR-010）', () => {
  it('text-view/edit.ts 与 shell/panels.ts 的剪贴板调用面未变（仍走静默 write 通道）', () => {
    const edit = read('../src/text-view/edit.ts');
    expect(edit).toContain("from '../common/clipboard'");
    expect(edit).not.toContain('navigator.clipboard');
    expect(edit).not.toContain('writeClipboardTextChecked');
    const panels = read('../src/shell/panels.ts');
    expect(panels).toContain("from '../common/clipboard'");
    expect(panels).not.toContain('writeClipboardTextChecked');
  });
});

describe('视图接线源码契约（004 FR-001；仓库既有源码断言口径）', () => {
  it('app.ts：阅读与分屏两处预览右键均接入「复制代码块」并经源偏移取值', () => {
    const app = read('../src/shell/app.ts');
    const hits = app.match(/closest\?\.\('pre\[data-md-code-from\]'\)/g) ?? [];
    expect(hits.length).toBe(2);
    expect(app).toContain("import('../markdown-view/code-copy')");
    expect(app).toContain('writeClipboardTextChecked');
    expect(app).toContain("mdRenderedText");
    expect(app).toContain("mdSplitRenderedText = renderInput");
  });

  it('livepreview.ts：execCommand 复制通道退场，代码块复制走源坐标提取', () => {
    const lp = read('../src/markdown-view/livepreview.ts');
    expect(lp).not.toContain("execCommand('copy')");
    expect(lp).toContain("from './code-copy'");
    expect(lp).toContain('fencedCodeText(this.view.state.doc, node)');
  });

  it('static-html.ts：pre 携带源偏移主键且正文取值与复制同源', () => {
    const sh = read('../src/markdown-view/static-html.ts');
    expect(sh).toContain('data-md-code-from');
    expect(sh).toContain('fencedCodeText(');
  });
});

describe('大文档与冷启动路径（004 FR-011 / SC-005 时限）', () => {
  it('1MB 文档的代码块定位+取值在 1s 内完成（右键低频一次性成本）', async () => {
    const { copyCodeBlockText } = await import('../src/markdown-view/code-copy');
    const filler = ('段落文字填充。\n\n').repeat(30000); // ~600KB 中文 ≈ 1MB+ UTF-16
    const doc = filler + '```js\nbig();\n```\n';
    const offset = doc.indexOf('```');
    const t0 = performance.now();
    const text = copyCodeBlockText(doc, offset);
    const cost = performance.now() - t0;
    expect(text).toBe('big();\n');
    expect(cost).toBeLessThan(1000);
  });
});
