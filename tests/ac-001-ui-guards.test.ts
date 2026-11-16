// @vitest-environment jsdom
// ui-guards 单测（2026-11-16 用户反馈轮）：
// ① 默认右键菜单拦截——未提供自定义菜单的面不再漏出 WebView2 默认菜单；输入框保留系统编辑菜单；
// ② 统一 title 提示层——原生 title 由自定义层接管（260ms 出现、离開恢复 title 属性）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDefaultContextMenuGuard, installPointerTips, resetUiGuardsForTest } from '../src/common/ui-guards';

const fire = (el: Element, type: string, init: EventInit = {}): Event => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};

beforeEach(() => { resetUiGuardsForTest(); });
afterEach(() => { resetUiGuardsForTest(); vi.restoreAllMocks(); });

describe('默认右键菜单拦截', () => {
  it('普通元素右键被拦截（不漏 WebView2 浏览器菜单）', () => {
    installDefaultContextMenuGuard();
    const div = document.createElement('div');
    document.body.appendChild(div);
    expect(fire(div, 'contextmenu').defaultPrevented).toBe(true);
  });

  it('输入框/文本域保留系统编辑菜单（可编辑区的 isContentEditable 规则同源，jsdom 不可模拟不单测）', () => {
    installDefaultContextMenuGuard();
    const input = document.createElement('input');
    const ta = document.createElement('textarea');
    document.body.append(input, ta);
    expect(fire(input, 'contextmenu').defaultPrevented).toBe(false);
    expect(fire(ta, 'contextmenu').defaultPrevented).toBe(false);
  });
});

describe('统一 title 提示层', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('悬停后出现提示文本，原生 title 悬停期间摘下、离开恢复并隐藏', () => {
    installPointerTips();
    const btn = document.createElement('button');
    btn.title = '保存文件';
    document.body.appendChild(btn);
    fire(btn, 'pointerover');
    expect(btn.title).toBe(''); // 原生提示已摘下（避免双层）
    expect(btn.dataset.tipTitle).toBe('保存文件');
    vi.advanceTimersByTime(300);
    const tip = document.querySelector('.app-tip') as HTMLElement;
    expect(tip).not.toBeNull();
    expect(tip.textContent).toBe('保存文件');
    expect(tip.classList.contains('on')).toBe(true);
    fire(btn, 'pointerout');
    expect(btn.title).toBe('保存文件'); // 离开恢复（无障碍属性不变）
    delete btn.dataset.tipTitle;
    expect(tip.classList.contains('on')).toBe(false);
  });

  it('按下任意键鼠立即隐藏（不滞留）', () => {
    installPointerTips();
    const btn = document.createElement('button');
    btn.title = '提示';
    document.body.appendChild(btn);
    fire(btn, 'pointerover');
    vi.advanceTimersByTime(300);
    const tip = document.querySelector('.app-tip') as HTMLElement;
    expect(tip.classList.contains('on')).toBe(true);
    fire(document.body, 'pointerdown');
    expect(tip.classList.contains('on')).toBe(false);
    expect(btn.title).toBe('提示');
  });
});
