// @vitest-environment jsdom
// Markdown 正文字号跟随（007 规则 20 v2.1，2026-10 用户定稿）：
// --md-fs-user 随编辑区字号派生（12=13.5px 基准线性），--md-fs-base 消费之实现三形态整体缩放。
import { describe, expect, it } from 'vitest';
import { shell, startShell, settle } from './shell-behavior-harness';

describe('Markdown 正文字号跟随', () => {
  it('启动即注入出厂基准；缩放后按 12→13.5px 线性派生', async () => {
    await startShell();
    expect(parseFloat(document.documentElement.style.getPropertyValue('--md-fs-user'))).toBeCloseTo(13.5, 5);
    shell.actions.run('file.newDraft');
    await settle();
    shell.actions.run('view.zoomIn'); // 12 → 13
    await settle();
    expect(parseFloat(document.documentElement.style.getPropertyValue('--md-fs-user'))).toBeCloseTo((13.5 * 13) / 12, 5);
    shell.actions.run('view.zoomReset'); // 回 12
    await settle();
    expect(parseFloat(document.documentElement.style.getPropertyValue('--md-fs-user'))).toBeCloseTo(13.5, 5);
  });
});
