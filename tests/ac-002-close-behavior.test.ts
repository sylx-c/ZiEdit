// 002-AC 关闭行为三态回归锁（P1-1，ADR 015 / 规则 29 v2.3）：
// 生效判决单一出口 effectiveCloseAction：ask+记忆→记忆值；ask 无记忆→ask（弹选择框）；
// 固定值原样；记忆只在 closeBehavior='ask' 时生效（设固定值后记忆被忽略，改回 ask 又生效）。
// 配置锁：Cargo.toml 必含 tray-icon 特性（托盘构建的前提）、capabilities 必含 allow-hide
//（tray 分支的 window.hide() 权限——与 P0 的 allow-destroy 同理，"看着没引用"最易被当死配置删）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { effectiveCloseAction } from '../src/shell/close-behavior';
import { DEFAULT_SETTINGS } from '../src/common/ipc';

describe('002 AC：关闭按钮行为（ADR 015）', () => {
  it('出厂 closeBehavior=ask 且无记忆（首次点 × 弹「退出/最小化到托盘」）', () => {
    expect(DEFAULT_SETTINGS.closeBehavior).toBe('ask');
    expect(DEFAULT_SETTINGS.rememberedCloseAction).toBeUndefined();
    expect(effectiveCloseAction(DEFAULT_SETTINGS.closeBehavior, undefined)).toBe('ask');
  });

  it('ask + 记忆 → 记忆值生效（二次点 × 不再询问）', () => {
    expect(effectiveCloseAction('ask', 'exit')).toBe('exit');
    expect(effectiveCloseAction('ask', 'tray')).toBe('tray');
  });

  it('固定值优先于记忆：设 exit/tray 后记忆被忽略，非法值回落 ask', () => {
    expect(effectiveCloseAction('exit', 'tray')).toBe('exit');
    expect(effectiveCloseAction('tray', 'exit')).toBe('tray');
    expect(effectiveCloseAction(undefined, 'exit')).toBe('exit'); // 缺省=ask，记忆仍生效
    expect(effectiveCloseAction('bogus' as never, 'exit')).toBe('exit'); // 非法行为值按 ask 处理
    expect(effectiveCloseAction('bogus' as never, undefined)).toBe('ask');
  });

  it('Cargo.toml 必含 tauri tray-icon 特性（托盘前提）', () => {
    const cargo = readFileSync(resolve(__dirname, '../src-tauri/Cargo.toml'), 'utf8');
    expect(cargo).toMatch(/tauri\s*=\s*\{[^}]*"tray-icon"/);
  });

  it('capabilities 必含 allow-hide/allow-show/allow-set-focus（托盘隐藏与唤回链路）', () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, '../src-tauri/capabilities/default.json'), 'utf8'));
    for (const p of ['core:window:allow-destroy', 'core:window:allow-hide', 'core:window:allow-show', 'core:window:allow-set-focus']) {
      expect(raw.permissions).toContain(p);
    }
  });

  it('Rust 托盘「退出」只 emit 不自行退出（单一判决——防第二判决点回漂）', () => {
    const lib = readFileSync(resolve(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
    expect(lib).toMatch(/emit\("ziedit:\/\/tray-quit"\)/);
    expect(lib).not.toMatch(/app\.exit\(/); // Rust 侧绝不直接 exit（绕过脏检查/快照清理）
  });
});
