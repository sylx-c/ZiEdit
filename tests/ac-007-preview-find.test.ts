// @vitest-environment jsdom
// 渲染预览查找栏与编辑面的统一（2026-10 用户反馈）：预览复用统一 FindBar，
// ▸ 展开替换 = 带当前查找词切源码形态并展开替换行（与源码/IR 同一查找体验）。
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PreviewFind } from '../src/markdown-view/preview-find';

describe('渲染预览查找栏：▸ 替换引导', () => {
  it('传入引导回调时 ▸ 可见，点击触发回调；needle 取当前查找词', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onRequestReplace = vi.fn();
    const pf = new PreviewFind(host, onRequestReplace);

    const toggle = host.parentElement?.querySelector<HTMLElement>('.md-preview-find .fb-toggle');
    expect(toggle).toBeTruthy(); // ▸ 替换引导入口可见（FindBar：有 onRequestReplace 即显示）
    const input = host.parentElement?.querySelector<HTMLInputElement>('.md-preview-find .tv-bar-input');
    expect(input).toBeTruthy();
    input!.value = '设计';
    expect(pf.needle).toBe('设计');

    toggle!.click();
    expect(onRequestReplace).toHaveBeenCalledTimes(1); // 引导交宿主（切源码并展开替换行）
    pf.destroy();
  });

  it('接线契约：md 挂载把 ▸ 引导接到 切源码 + openReplace(当前词)', () => {
    const app = readFileSync('src/shell/app.ts', 'utf8');
    const m = app.match(/previewFind = new PreviewFind\(preview, \(\) => \{[\s\S]*?\}\);/);
    expect(m).toBeTruthy();
    expect(m![0]).toContain('setMode(tab, \'edit\')'); // 渲染预览无编辑面 → 切源码
    expect(m![0]).toContain('currentView.openReplace(seed)'); // 带词展开替换行
    expect(m![0]).toContain('previewFind?.needle'); // 查找词接力，不丢上下文
  });

  it('EditView.openReplace 支持外部带入查找词（seed 优先于选区）', () => {
    const edit = readFileSync('src/text-view/edit.ts', 'utf8');
    const m = edit.match(/openReplace\(seedText\?: string\): void \{[\s\S]*?\n  \}/);
    expect(m).toBeTruthy();
    expect(m![0]).toContain('seedText');
    expect(m![0]).toContain('findBar?.show(seed, true)');
  });
});
