// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openContextMenu, type ContextMenu } from '../src/shell/context-menu';
import { placeContextPopup, placePopup, placeSubmenu } from '../src/common/popup';
import { ActionRegistry, buildMenubar, buildToolbar } from '../src/shell/chrome';
import { setLang } from '../src/common/i18n';

let menu: ContextMenu | undefined;
const cleanup: Array<() => void> = [];
afterEach(() => { menu?.close(); menu = undefined; cleanup.splice(0).forEach(fn => fn()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const key = (value: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));

describe('菜单视口与操作反馈', () => {
  it('右键菜单跳过禁用项、进入退出子菜单、执行后恢复焦点并卸载监听', () => {
    const input = document.createElement('input'); document.body.append(input); input.focus();
    const run = vi.fn();
    menu = openContextMenu([['Disabled', null], ['One', run], 'sep', ['Sub', () => {}, [['Child', run]]]], 10, 10);
    key('ArrowDown'); expect(document.activeElement?.textContent).toBe('One');
    key('ArrowDown'); expect(document.activeElement?.className).toBe('ctx-parent');
    key('ArrowRight'); expect(document.activeElement?.textContent).toBe('Child');
    key('ArrowLeft'); expect(document.activeElement?.className).toBe('ctx-parent');
    key('ArrowRight'); key('Enter');
    expect(run).toHaveBeenCalledTimes(1); expect(menu.isConnected).toBe(false); expect(document.activeElement).toBe(input);
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }); document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  it('菜单替换及外部点击/窗口变化可靠收起，不消费后续按键', () => {
    menu = openContextMenu([['One', vi.fn()]], 0, 0);
    const old = menu;
    menu = openContextMenu([['Two', vi.fn()]], 0, 0);
    expect(old.isConnected).toBe(false); expect(document.querySelectorAll('.ctx-menu')).toHaveLength(1);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); expect(menu.isConnected).toBe(false);
    menu = openContextMenu([['Three', vi.fn()]], 0, 0);
    window.dispatchEvent(new Event('resize')); expect(menu.isConnected).toBe(false);
  });
  it('真实尺寸定位钳制上下左右，子菜单靠右向左翻转，长菜单有滚动约束', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 960 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    const panel = document.createElement('div'); document.body.append(panel);
    Object.defineProperties(panel, { offsetWidth: { value: 230 }, offsetHeight: { value: 450 } });
    placeContextPopup(panel, 950, 590); expect(panel.style.left).toBe('726px'); expect(panel.style.top).toBe('146px');
    placeContextPopup(panel, -50, -20); expect(panel.style.left).toBe('4px'); expect(panel.style.top).toBe('4px');
    const anchor = document.createElement('div');
    anchor.getBoundingClientRect = () => ({ left: 800, right: 950, top: 500, bottom: 525 } as DOMRect);
    placeSubmenu(anchor, panel); expect(panel.style.left).toBe('574px'); expect(panel.style.top).toBe('146px');
    expect(panel.style.maxHeight).toBe('592px'); expect(panel.style.overflowY).toBe('auto');
    placePopup(anchor, panel); expect(panel.style.top).toBe('48px');
  });
  it('顶栏保留括号助记字母，菜单内容保留勾选语义和实际快捷键', () => {
    setLang('zh-CN');
    const root = document.createElement('div'); document.body.append(root);
    const reg = new ActionRegistry(); reg.add({ id: 'wrap', label: 'Wrap', group: 'view', shortcut: 'Alt+Z', checked: () => true, run() {} });
    const ctl = buildMenubar(root, [{ label: 'menu.viewF', entries: () => [{ action: 'wrap' }] }], reg); cleanup.push(ctl.dispose);
    expect(root.querySelector('.menu-item')?.firstChild?.textContent).toBe('视图(V)');
    ctl.open(0);
    const checked = root.querySelector('[role=menuitemcheckbox]');
    expect(checked?.getAttribute('aria-checked')).toBe('true'); expect(checked?.querySelector('.ma-shortcut')?.textContent).toBe('Alt+Z');
    expect(root.querySelector<HTMLElement>('.menu-dropdown')?.style.overflowY).toBe('auto');
  });
  it('工具栏图标有名称、切换状态会刷新，禁用动作保持提示但不会执行', () => {
    const reg = new ActionRegistry(), run = vi.fn(); let checked = false, enabled = true;
    reg.add({ id: 'wrap', label: 'Wrap', icon: 'wrap', group: 'view', checked: () => checked, enabled: () => enabled, run });
    const root = document.createElement('div'); const toolbar = buildToolbar(root, () => ({ left: [{ action: 'wrap' }], context: [{ seg: ['wrap'] }] }), reg);
    toolbar.refresh(); expect(root.querySelectorAll('[aria-label=Wrap]')).toHaveLength(2);
    checked = true; enabled = false; toolbar.refresh();
    for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
      expect(button.getAttribute('aria-pressed')).toBe('true'); expect(button.getAttribute('aria-disabled')).toBe('true'); button.click();
    }
    expect(run).not.toHaveBeenCalled();
  });
});
