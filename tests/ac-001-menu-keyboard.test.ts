// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ActionRegistry, buildMenubar } from '../src/shell/chrome';

describe('001 菜单键盘操作', () => {
  it('上下跳过禁用项，左右进入退出子菜单，Enter 执行动作', () => {
    const root = document.createElement('div'); document.body.append(root);
    const run = vi.fn();
    const registry = new ActionRegistry();
    registry.add({ id: 'one', label: 'One', group: 'file', run });
    registry.add({ id: 'disabled', label: 'Disabled', group: 'file', run, enabled: () => false });
    const ctl = buildMenubar(root, [{ label: 'File', entries: () => [
      { action: 'one' }, { action: 'disabled' }, { label: 'Sub', children: () => [{ action: 'one' }] },
    ] }], registry);
    const key = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    ctl.open(0);
    key('ArrowDown');
    expect(document.activeElement?.classList.contains('has-sub')).toBe(true);
    key('ArrowRight');
    expect(document.activeElement?.parentElement?.classList.contains('sub')).toBe(true);
    key('ArrowLeft');
    expect(document.activeElement?.classList.contains('has-sub')).toBe(true);
    key('ArrowRight'); key('Enter');
    expect(run).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.menu-item.open')).toBeNull();
    ctl.dispose(); root.remove();
  });
  it('Escape 关闭并恢复原焦点，卸载后移除键盘拦截', () => {
    const input = document.createElement('input'); const root = document.createElement('div');
    document.body.append(input, root); input.focus();
    const ctl = buildMenubar(root, [{ label: 'File', entries: () => [] }], new ActionRegistry());
    ctl.open(0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(root.querySelector('.menu-item.open')).toBeNull(); expect(document.activeElement).toBe(input);
    ctl.dispose();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
    root.remove(); input.remove();
  });
});
