// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dlgPrompt, dlgPromptWithFormat, overlayDialog, type OverlayMask } from '../src/shell/chrome';

const masks: OverlayMask[] = [];
afterEach(() => { for (const mask of masks.splice(0).reverse()) mask.close(); document.body.replaceChildren(); });
async function open() {
  const body = document.createElement('div'); body.className = 'ov-body'; body.style.overflowY = 'auto';
  body.innerHTML = '<input aria-label="first"><button>last</button>';
  const close = vi.fn(); const mask = overlayDialog('设置', body, close); masks.push(mask); document.body.append(mask);
  await new Promise(r => setTimeout(r, 1));
  return { mask, body, close, box: mask.querySelector<HTMLElement>('.ov-box')! };
}
const key = (value: string, shiftKey = false) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }));

describe('001 公共弹窗隔离', () => {
  it('背景不可聚焦，Tab双向循环，关闭恢复原焦点及已有inert状态', async () => {
    const input = document.createElement('input'), disabled = document.createElement('div'); disabled.setAttribute('inert', '');
    document.body.append(input, disabled); input.focus();
    const { mask, body, box, close } = await open();
    expect(box.getAttribute('role')).toBe('dialog'); expect(input.hasAttribute('inert')).toBe(true);
    input.focus(); expect(document.activeElement).toBe(box);
    key('Tab', true); expect(document.activeElement).toBe(body.lastElementChild);
    key('Tab'); expect(document.activeElement).toBe(mask.querySelector('.ov-close'));
    key('Tab', true); expect(document.activeElement).toBe(body.lastElementChild);
    mask.close(); mask.close(); expect(close).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input); expect(input.hasAttribute('inert')).toBe(false);
    expect(disabled.hasAttribute('inert')).toBe(true);
  });
  it('嵌套Esc只关最上层，父弹窗继续隔离背景', async () => {
    const input = document.createElement('input'); document.body.append(input); input.focus();
    const parent = await open(); parent.body.querySelector('input')!.focus();
    const child = await open(); expect(parent.mask.hasAttribute('inert')).toBe(true);
    key('Escape'); expect(child.close).toHaveBeenCalledTimes(1); expect(parent.close).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(parent.body.querySelector('input'));
    expect(parent.mask.hasAttribute('inert')).toBe(false); expect(input.hasAttribute('inert')).toBe(true);
    key('Escape'); expect(document.activeElement).toBe(input);
  });
  it('遮罩和滚动边界阻止滚轮穿透，面板内部仍可滚动', async () => {
    const { mask, body } = await open();
    Object.defineProperties(body, { scrollHeight: { value: 500 }, clientHeight: { value: 200 } });
    const wheel = (target: HTMLElement, deltaY: number) => {
      const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }); target.dispatchEvent(e); return e.defaultPrevented;
    };
    expect(wheel(mask, 100)).toBe(true);
    expect(wheel(body, -100)).toBe(true); expect(wheel(body, 100)).toBe(false);
    body.scrollTop = 300; expect(wheel(body, 100)).toBe(true); expect(wheel(body, -100)).toBe(false);
  });
});

// E1 回归（走查面1 发现）：Ctrl+G 跳行对话框按 Enter，换行曾泄漏进编辑器（docLen +1、光标错位）。
// 机理：done() 微任务里焦点已移交 CM，同一按键随后的 keypress/beforeinput 落进编辑器插入换行。
// 修复：两个提示框的 Enter 处理器先 preventDefault 再 done。本测试锁死 defaultPrevented 与 resolve 值。
describe('001 提示框按键隔离（E1 回归）', () => {
  it('dlgPrompt 的 Enter 先 preventDefault 再 resolve', async () => {
    const p = dlgPrompt('跳转到行');
    const input = document.querySelector<HTMLInputElement>('input.dlg-input')!;
    input.value = '5';
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await expect(p).resolves.toBe('5');
  });
  it('dlgPromptWithFormat 的 Enter 同样 preventDefault，resolve 带格式', async () => {
    const p = dlgPromptWithFormat('新建文件', [{ id: 'txt', label: '纯文本' }]);
    const input = document.querySelector<HTMLInputElement>('input.dlg-input')!;
    input.value = 'a.txt';
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await expect(p).resolves.toEqual({ name: 'a.txt', format: 'txt' });
  });
});
