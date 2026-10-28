// @vitest-environment jsdom
// 002-AC 退出链路回归锁（P0-1，规则 29 v2.2 关闭链路工程契约）：
// 修前根因——capabilities 缺 core:window:allow-destroy：@tauri-apps/api 的 onCloseRequested
// 在未 preventDefault（无脏放行）时由 JS 自行 destroy()，被权限拒绝 → 「点 × 无反应（无脏也不关）、
// 放弃/保存并退出点了没效」。权限看起来"没被引用"，最容易被当成死配置删掉——本组用例把
// 配置与对话框收口语义一起锁死：
// 1) capabilities 必含 allow-destroy（配置回归锁）；
// 2) overlayDialog 返回句柄 close()：移除遮罩、onClosed 恰一次、幂等；
// 3) 多弹窗叠放时持句柄关闭只关自己的（querySelector('.ov-mask') 直删会删错——修前缺陷）；
// 4) 句柄关闭后 document 捕获阶段的 Escape 监听随之下卸（再按 Esc 不再触发 onClose）。
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { overlayDialog } from '../src/shell/chrome';

describe('002 AC：退出链路（P0-1 关闭救急）', () => {
  it('capabilities/default.json 必含 core:window:allow-destroy（缺失即点 × 关不掉）', () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, '../src-tauri/capabilities/default.json'), 'utf8'));
    const perms: unknown[] = raw.permissions;
    expect(Array.isArray(perms)).toBe(true);
    expect(perms).toContain('core:window:allow-destroy');
  });

  it('overlayDialog 句柄 close()：移除遮罩、onClose 恰一次、幂等', () => {
    const onClose = vi.fn();
    const mask = overlayDialog('t', document.createElement('div'), onClose);
    document.body.appendChild(mask);
    expect(document.querySelector('.ov-mask')).toBe(mask);
    mask.close();
    expect(mask.isConnected).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    mask.close(); // 幂等：按钮回调与 Esc/遮罩点击可能竞态双触发
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('多弹窗叠放：持句柄关闭只关自己的（修前 querySelector 直删会删错遮罩）', () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    const a = overlayDialog('A', document.createElement('div'), onCloseA);
    const b = overlayDialog('B', document.createElement('div'), onCloseB);
    document.body.append(a, b);
    b.close(); // 关掉顶层 B
    expect(b.isConnected).toBe(false);
    expect(a.isConnected).toBe(true); // 底层 A 不受影响
    expect(onCloseB).toHaveBeenCalledTimes(1);
    expect(onCloseA).not.toHaveBeenCalled();
    a.close();
    expect(document.querySelectorAll('.ov-mask').length).toBe(0);
  });

  it('句柄关闭后 Escape 文档监听已卸载（P0-1：不再依赖「下一次按键自愈」兜底）', () => {
    const onClose = vi.fn();
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const mask = overlayDialog('t', document.createElement('div'), onClose);
    document.body.appendChild(mask);
    // 捕获 overlayDialog 挂上的捕获阶段 keydown 监听（注册形参是布尔 true，非 {capture} 对象）
    const isCapture = (opts: unknown): boolean => opts === true || (opts as AddEventListenerOptions | undefined)?.capture === true;
    const added = addSpy.mock.calls.filter(([ev, , opts]) => ev === 'keydown' && isCapture(opts));
    expect(added.length).toBeGreaterThan(0);
    const [, listener] = added[added.length - 1];
    mask.close();
    const removed = removeSpy.mock.calls.filter(([ev, , opts]) => ev === 'keydown' && isCapture(opts));
    expect(removed.some(([, fn]) => fn === listener)).toBe(true);
    removeSpy.mockRestore();
    addSpy.mockRestore();
  });
});
