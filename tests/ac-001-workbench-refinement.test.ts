// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shell, startShell, settle } from './shell-behavior-harness';
import { t } from '../src/common/i18n';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); });
const key = (target: Element, value: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));

describe('工作台键盘反馈', () => {
  it('左右/Home/End切换实际标签并同步焦点，Delete关闭后保留其它标签', async () => {
    vi.useFakeTimers(); await startShell();
    shell.actions.run('file.newDraft'); await settle();
    shell.actions.run('file.newDraft'); await settle();
    expect(document.querySelectorAll('[role=tab]')).toHaveLength(2);
    let current = document.querySelector<HTMLElement>('.tab.active')!; current.focus();
    key(current, 'Home'); await settle();
    current = document.querySelector<HTMLElement>('.tab.active')!;
    expect(current.getAttribute('aria-selected')).toBe('true');
    expect(current).toBe(document.querySelector('[role=tab]')); expect(document.activeElement).toBe(current);
    key(current, 'ArrowRight'); await settle();
    expect(shell.store.activeIndex).toBe(1);
    current = document.querySelector<HTMLElement>('.tab.active')!;
    expect(current.querySelector('button.tab-close')?.getAttribute('aria-label')).toBeTruthy();
    key(current, 'Delete'); await settle();
    expect(document.querySelectorAll('[role=tab]')).toHaveLength(1);
  });
  it('状态格可通过Enter/Space打开同一菜单，菜单焦点阻止快捷键漏到背景', async () => {
    vi.useFakeTimers(); await startShell(); shell.actions.run('file.newDraft'); await settle();
    const mode = [...document.querySelectorAll<HTMLElement>('.st-cell.combo')].find(cell => cell.title === t('st.tip.lang'))!;
    expect(mode.getAttribute('role')).toBe('button'); expect(mode.tabIndex).toBe(0);
    mode.focus(); key(mode, 'Enter');
    expect(document.querySelector('.ctx-menu')).not.toBeNull();
    expect(document.activeElement?.classList.contains('ctx-menu')).toBe(true);
    const before = shell.store.tabs.length;
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
    expect(shell.store.tabs).toHaveLength(before);
    key(document.activeElement!, 'Escape');
    expect(document.querySelector('.ctx-menu')).toBeNull(); expect(document.activeElement).toBe(mode);
    key(mode, ' '); expect(document.querySelector('.ctx-menu')).not.toBeNull();
    key(document.activeElement!, 'Escape');
  });
});
