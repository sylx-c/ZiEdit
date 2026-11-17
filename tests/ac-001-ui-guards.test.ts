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

  it('悬停 260ms 后出现提示并摘下原生 title，离开时恢复并隐藏', () => {
    installPointerTips();
    const btn = document.createElement('button');
    btn.title = '保存文件';
    document.body.appendChild(btn);
    fire(btn, 'pointerover');
    expect(btn.title).toBe('保存文件'); // 260ms 窗口内原生 title 保持（快速点击不受扰）
    expect(btn.dataset.tipTitle).toBe('保存文件');
    vi.advanceTimersByTime(300);
    const tip = document.querySelector('.app-tip') as HTMLElement;
    expect(tip).not.toBeNull();
    expect(tip.textContent).toBe('保存文件');
    expect(tip.classList.contains('on')).toBe(true);
    expect(btn.title).toBe(''); // 提示可见期间摘下（避免双层）
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

  it('回归（真机 position 门禁）：260ms 内快速点击，title 全程未被摘下', () => {
    installPointerTips();
    const btn = document.createElement('button');
    btn.title = 'E:\\corpus\\note-small.md';
    document.body.appendChild(btn);
    fire(btn, 'pointerover');
    fire(document.body, 'pointerdown'); // 快速点击：悬停 <260ms 即按下
    vi.advanceTimersByTime(50);
    expect(btn.title).toBe('E:\\corpus\\note-small.md'); // 从未被摘下，无需恢复
    const tip = document.querySelector('.app-tip') as HTMLElement | null;
    expect(tip === null || !tip.classList.contains('on')).toBe(true);
  });

  it('回归（标签栏全量重建）：悬停中元素被替换，新元素 title 不残留为空', () => {
    installPointerTips();
    const btn = document.createElement('button');
    btn.title = 'E:\\corpus\\mixed-100k.md';
    document.body.appendChild(btn);
    fire(btn, 'pointerover');
    // 模拟 renderTabs 全量重建：旧元素移除、同位置新元素；Chromium 对新元素补发 pointerover
    btn.remove();
    const btn2 = document.createElement('button');
    btn2.title = 'E:\\corpus\\mixed-100k.md';
    document.body.appendChild(btn2);
    fire(btn, 'pointerout'); // Chromium 移除节点时补发的离场事件
    fire(btn2, 'pointerover');
    expect(btn2.title).toBe('E:\\corpus\\mixed-100k.md'); // 260ms 窗口内保持完整
    vi.advanceTimersByTime(300);
    expect(btn2.title).toBe(''); // 停驻不动 → 提示可见期间摘下（与旧行为一致）
    fire(btn2, 'pointerout');
    expect(btn2.title).toBe('E:\\corpus\\mixed-100k.md'); // 离开恢复
  });

  it('悬停期间元素被移除（未替换）：不出提示、不摘 title', () => {
    installPointerTips();
    const btn = document.createElement('button');
    btn.title = '临时元素';
    document.body.appendChild(btn);
    fire(btn, 'pointerover');
    btn.remove();
    vi.advanceTimersByTime(300);
    const tip = document.querySelector('.app-tip') as HTMLElement | null;
    expect(tip === null || !tip.classList.contains('on')).toBe(true);
  });
});
