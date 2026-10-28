// @vitest-environment jsdom
// 002-AC 查找替换重设计回归锁（P1-2，规则 7 v2.4 / 规则 22 v2.5）：
// ↑/↓ 步进钮存在且与 Enter 同一 go 通道；F3/Shift+F3 在输入框内也步进（stopPropagation 拦了全局派发）；
// Esc 任意焦点位置可关（document 捕获，修前只挂在两个输入框上）；
// ▸ 替换行打开形态（v2.5）：查找入口（Ctrl+F，无 withReplace）恒收起、替换入口（withReplace）
// 恒展开，▸ 手动折叠/展开仅本次栏打开内有效（废止"折叠跨会话记忆"）；查看态交 onRequestReplace 引导；
// 替换语义：宿主拿到「当前选区起」的替换请求（edit.ts 侧替换当前并前进——本文件锁 FindBar 契约）。
// 三色高亮的类名分派锁在 renderLineHtml（本文件一并覆盖）。
import { describe, expect, it, vi } from 'vitest';
import { FindBar, type FindBarCfg } from '../src/text-view/findbar';
import { renderLineHtml } from '../src/text-view/view';

function makeCfg(over: Partial<FindBarCfg> = {}): FindBarCfg {
  return {
    run: vi.fn(async () => ({ hit: { line: 1, col: 1 }, counts: { total: 3, before: 0 } })),
    onClosed: vi.fn(),
    ...over,
  };
}

function mount(cfg: FindBarCfg): { bar: FindBar; host: HTMLElement } {
  const bar = new FindBar(cfg);
  const host = document.createElement('div');
  host.appendChild(bar.el);
  document.body.appendChild(host);
  return { bar, host };
}

describe('002 AC：FindBar 导航与 Esc（规则 7 v2.4）', () => {
  it('↑/↓ 步进钮存在且派发 go(±1)（与 Enter 同通道）', async () => {
    const cfg = makeCfg();
    const { bar } = mount(cfg);
    bar.show('x');
    const btns = bar.el.querySelectorAll('.fb-step');
    expect(btns.length).toBe(2);
    (btns[1] as HTMLElement).click(); // ▾ = 下一个
    await new Promise(r => setTimeout(r, 0));
    expect(cfg.run).toHaveBeenCalledWith('x', expect.anything(), 1, expect.any(Boolean), true);
    (btns[0] as HTMLElement).click(); // ▴ = 上一个
    await new Promise(r => setTimeout(r, 0));
    expect(cfg.run).toHaveBeenLastCalledWith('x', expect.anything(), -1, expect.any(Boolean), true);
  });

  it('F3/Shift+F3 在查找输入框内直接步进（输入框 stopPropagation 拦全局派发，须本地处理）', async () => {
    const cfg = makeCfg();
    const { bar } = mount(cfg);
    bar.show('x');
    bar.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    expect(cfg.run).toHaveBeenCalledWith('x', expect.anything(), 1, expect.any(Boolean), true);
    bar.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', shiftKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    expect(cfg.run).toHaveBeenLastCalledWith('x', expect.anything(), -1, expect.any(Boolean), true);
  });

  it('Esc 焦点在查找栏外也能关闭（document 捕获；修前只挂输入框 keydown）', () => {
    const cfg = makeCfg();
    const { bar } = mount(cfg);
    bar.show('x');
    expect(bar.visible).toBe(true);
    document.body.focus(); // 焦点离开输入框
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(bar.visible).toBe(false);
    expect(cfg.onClosed).toHaveBeenCalled();
  });

  it('stepNext/stepPrev：栏可见时步进、隐藏时不动作（F3 全局动作语义）', async () => {
    const cfg = makeCfg();
    const { bar } = mount(cfg);
    bar.stepNext();
    expect(cfg.run).not.toHaveBeenCalled(); // 未显示不派发
    bar.show('x');
    bar.stepPrev();
    await new Promise(r => setTimeout(r, 0));
    expect(cfg.run).toHaveBeenCalledWith('x', expect.anything(), -1, expect.any(Boolean), true);
  });
});

describe('002 AC：▸ 替换行打开形态（规则 22 v2.5：查找恒收起/替换恒展开，废止跨会话记忆）', () => {
  it('编辑态（有替换回调）Ctrl+F 路径（无 withReplace）：打开恒收起，上一栏手动展开过也不带过来', () => {
    const cfg = makeCfg({ onReplaceNext: () => true, onReplaceAll: () => 0 });
    const { bar } = mount(cfg);
    bar.show('x');
    expect(bar.replaceOpen).toBe(false); // Ctrl+F 只出查找
    bar.toggleReplace(true); // ▸ 手动展开（仅本次栏打开内有效）
    expect(bar.replaceOpen).toBe(true);
    bar.hide();
    bar.show('x'); // Ctrl+F 重开：恒收起，无跨会话记忆
    expect(bar.replaceOpen).toBe(false);
  });

  it('withReplace（Ctrl+H/工具栏/菜单替换入口语义）：打开恒展开，此前手动折叠也不影响', () => {
    const cfg = makeCfg({ onReplaceNext: () => true, onReplaceAll: () => 0 });
    const { bar } = mount(cfg);
    bar.show('x', true);
    expect(bar.replaceOpen).toBe(true); // 替换入口展开并聚焦替换框
    bar.toggleReplace(false); // ▸ 手动折叠
    expect(bar.replaceOpen).toBe(false);
    bar.hide();
    bar.show('x', true); // Ctrl+H 重开：恒展开
    expect(bar.replaceOpen).toBe(true);
  });

  it('▸ 钮本栏内反复切换：点开保持展开（DOM 挂载 + open 类），再点收起（DOM 卸载）', () => {
    const cfg = makeCfg({ onReplaceNext: () => true, onReplaceAll: () => 0 });
    const { bar } = mount(cfg);
    bar.show('x');
    const toggle = bar.el.querySelector('.fb-toggle') as HTMLElement;
    toggle.click(); // 展开
    expect(bar.replaceOpen).toBe(true);
    expect(bar.el.querySelector('.fb-rep')).toBeTruthy();
    expect(toggle.classList.contains('open')).toBe(true);
    toggle.click(); // 收起
    expect(bar.replaceOpen).toBe(false);
    expect(bar.el.querySelector('.fb-rep')).toBeNull();
    expect(toggle.classList.contains('open')).toBe(false);
  });

  it('查看态（无替换回调）：▸ 交宿主 onRequestReplace 引导进编辑态', () => {
    const onRequestReplace = vi.fn();
    const cfg = makeCfg({ onRequestReplace });
    const { bar } = mount(cfg);
    bar.show('x');
    expect(bar.replaceOpen).toBe(false);
    const toggle = bar.el.querySelector('.fb-toggle') as HTMLElement;
    expect(toggle).toBeTruthy();
    toggle.click();
    expect(onRequestReplace).toHaveBeenCalledTimes(1);
  });

  it('替换成功后刷新计数（repCount 文案 + recount 触发）', async () => {
    vi.useFakeTimers();
    const cfg = makeCfg({ onReplaceNext: () => true });
    const { bar } = mount(cfg);
    bar.show('x', true);
    bar.el.querySelector('.fb-rep .fb-btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(bar.el.querySelector('.fb-rep .fb-count')!.textContent).toBeTruthy();
    vi.useRealTimers();
  });
});

describe('002 AC：三色高亮类名分派（renderLineHtml）', () => {
  it('命中词 tv-hit-c；当前命中段 tv-hit-c current（修前 current 是死代码）', () => {
    const html = renderLineHtml('cat catalog cat', undefined, [
      { from: 0, to: 3 },
      { from: 4, to: 7 },
      { from: 12, to: 15 },
    ], false, undefined, 4);
    expect(html).toContain('tv-hit-c current'); // from=4 的段是当前命中
    const curCount = (html.match(/tv-hit-c current/g) ?? []).length;
    const allCount = (html.match(/tv-hit-c/g) ?? []).length;
    expect(curCount).toBe(1);
    expect(allCount).toBe(3); // current 段也带 tv-hit-c 前缀类
  });

  it('无当前标记时全部命中同色（纯 recount/防抖路径）', () => {
    const html = renderLineHtml('ab ab', undefined, [{ from: 0, to: 2 }, { from: 3, to: 5 }]);
    expect(html).not.toContain('current');
    expect((html.match(/tv-hit-c/g) ?? []).length).toBe(2);
  });
});
