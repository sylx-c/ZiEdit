// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ActionRegistry, buildToolbar, buildMenubar } from './chrome';
import { t } from '../common/i18n';

describe('操作状态与执行共用守卫', () => {
  it('菜单、按钮、快捷键都受实时可用性保护，显示原因', () => {
    const reg = new ActionRegistry(), run = vi.fn();
    let locked = true;
    reg.add({ id: 'save', label: 'act.save', shortcut: 'Ctrl+S', group: 'file', run,
      availability: () => ({ enabled: !locked, reasonKey: locked ? 'action.readOnly' : undefined }) });
    const root = document.createElement('div');
    const toolbar = buildToolbar(root, () => ({ left: [{ action: 'save' }] }), reg);
    toolbar.refresh();
    const button = root.querySelector('button')!;
    expect(button.title).toContain(t('action.readOnly'));
    button.click();
    expect(reg.dispatch(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))).toBe(false);
    const menuRoot = document.createElement('div');
    const menu = buildMenubar(menuRoot, [{ label: 'menu.file', entries: () => [{ action: 'save' }] }], reg);
    menu.open(0);
    expect(menuRoot.querySelector('.menu-action')?.getAttribute('aria-disabled')).toBe('true');
    expect(run).not.toHaveBeenCalled();
    locked = false; toolbar.refresh();
    button.click();
    expect(reg.dispatch(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    menu.dispose();
  });
  it('布尔接口继续生效；动态注册后快捷键索引更新', () => {
    const reg = new ActionRegistry(), run = vi.fn();
    reg.dispatch(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
    reg.add({ id: 'save', label: 'save', group: 'file', shortcut: 'Ctrl+S', run, enabled: () => false });
    expect(reg.isEnabled('save')).toBe(false);
    expect(reg.run('save')).toBe(false);
    reg.add({ id: 'save', label: 'save', group: 'file', shortcut: 'Ctrl+S', run });
    expect(reg.dispatch(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });
});
