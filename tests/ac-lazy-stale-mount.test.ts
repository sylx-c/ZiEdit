// @vitest-environment jsdom
// 性能：懒加载迟到续体不得清空新视图。
// 首开图片（模块解析挂起）期间切换标签：迟到的模块解析必须整段丢弃，
// 不得向共享 viewarea 构造/挂载视图（ImageView.mount 会清空宿主，将擦掉新视图/空态）。
import { describe, expect, it, vi } from 'vitest';
import { shell, startShell, settle } from './shell-behavior-harness';
import { openFile } from '../src/common/ipc';

vi.mock('../src/image-view/view', () => new Promise(resolve => {
  (globalThis as { __faReleaseImage?: () => void }).__faReleaseImage = () =>
    resolve({
      ImageView: class {
        host: HTMLElement;
        constructor(h: HTMLElement) { this.host = h; }
        // 模拟真实行为：mount 清空宿主再写入（image-view/view.ts:25）
        async mount(): Promise<void> { this.host.innerHTML = ''; this.host.appendChild(document.createElement('img')); }
        destroy(): void {}
      },
    });
}));

describe('懒加载迟到续体隔离', () => {
  it('首开图片期间切换标签，迟到模块解析不清掉新视图内容', async () => {
    await startShell();
    const imgInfo = { path: 'C:\\slow.png', len: 10, modifiedMs: 1, route: 'image' as const, language: null, readonly: false };
    vi.mocked(openFile).mockResolvedValueOnce(imgInfo); // 第一次：慢图片
    shell.cli(['C:\\slow.png']);
    await settle(); // 挂载启动，卡在 loadImage()（模块 Promise 未放行）

    shell.cli(['C:\\doc.txt']); // 切到文本标签：mock EditView 快速就位
    await settle();
    expect(shell.edit).not.toBeNull();

    // 新视图就位后放入哨兵节点，模拟视图 DOM
    const viewarea = document.getElementById('viewarea')!;
    const marker = document.createElement('div');
    marker.className = 'fa-sentinel';
    viewarea.appendChild(marker);

    (globalThis as { __faReleaseImage?: () => void }).__faReleaseImage!(); // 迟到的模块解析
    await settle();
    await settle();

    expect(marker.isConnected).toBe(true); // 新视图内容未被清掉
    expect(viewarea.children).toHaveLength(1); // 无迟到的图片包装层残留
    expect(viewarea.querySelector('img')).toBeNull(); // 迟到 mount 从未触碰共享宿主
  });
});
