// @vitest-environment jsdom
// 002-AC-29 崩溃恢复回归锁（P3-25 灾备补强，规则 29 v2.4）：
// AC-29 的完整链路（杀进程→重启→恢复对话框→脏恢复）需真机跑，自动化锁住其中可判决的部分：
// 1) 提示判决纯函数 snapshotHint：超限只提示一次（心跳式快照不刷屏）、写成功复位、
// 淘汰如实提示——修前超限是「静默 return Ok(())」，用户以为有保护实际没有；
// 2) Rust 契约锁：上限常量（64 份 / 10MB）与 SnapshotOutcome 回报结构、sweep_tmp 清扫
// 残留临时文件且被 lib.rs 启动序列调用（"看着没引用"最易被当死代码删——与 P0 的
// allow-destroy 同族教训）；
// 3) i18n 两语键齐（中文界面下的提示不得回退成 key 文本）。
import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { shell, startShell, settle, clickText } from './shell-behavior-harness';
import { recoveryList, recoveryRead } from '../src/common/ipc';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { snapshotHint, INITIAL_SNAP_HINTS, type SnapHintState } from '../src/shell/recovery-hints';
import { dict, tf, t } from '../src/common/i18n';

const rustSrc = (): string =>
  readFileSync(resolve(__dirname, '../src-tauri/src/commands/recovery.rs'), 'utf8');

describe('002 AC-29：非 Markdown 所选快照应用到编辑缓冲', () => {
  it.each([false, true])('旧文本已挂载（后台缓存=%s）时，快照覆盖旧缓冲并标脏', async background => {
    const path = 'C:\\work\\recover.txt';
    const content = '磁盘基础文本\n崩溃前尚未保存的文字';
    vi.mocked(recoveryList).mockResolvedValueOnce({ crashed: true, items: [{ key: path, ts: 100, bytes: 38, draft: false }] });
    vi.mocked(recoveryRead).mockResolvedValueOnce({ key: path, content, mtime: 100, len: 10, draft: false, ts: 100 });
    await startShell();
    shell.store.open({ path, route: 'text', language: null, scroll: 0, bookmarks: [] });
    await settle();
    shell.edit.view = { state: EditorState.create({ doc: '磁盘基础文本' }), scrollDOM: { scrollTop: 0 } };
    if (background) {
      shell.store.open({ path: 'C:\\work\\other.txt', route: 'text', language: null, scroll: 0, bookmarks: [] });
      await settle();
    }
    clickText('.dlg-btn', t('rec.restore'));
    await settle();
    expect(shell.edit.filePath).toBe(path);
    expect(shell.edit.opts.initialDoc).toBe(content);
    expect(shell.edit.opts.buffer).toBeUndefined(); // 旧 CM 状态不能优先于恢复内容
    expect(shell.edit.opts.startDirty).toBe(true);
    // 模拟真实编辑面的状态回报，标签必须显示脏标。
    shell.edit.opts.onStatus({ dirty: true, line: 1, col: 1 });
    await settle();
    expect(document.querySelector('.tab.active .tab-dot')).toBeTruthy();
  });
});

describe('002 AC-29：崩溃恢复快照提示判决（P3-25）', () => {
  it('首次超限提示一次，其后同状态不再提示（心跳 15s 不得刷屏）', () => {
    const over = { skipped: true, evicted: 0 };
    const first = snapshotHint(over, INITIAL_SNAP_HINTS);
    expect(first.key).toBe('msg.snapSkip');
    expect(first.state.skipNotified).toBe(true);
    // 后续同状态心跳：静默
    let st: SnapHintState = first.state;
    for (let i = 0; i < 5; i++) {
      const h = snapshotHint(over, st);
      expect(h.key).toBeNull();
      st = h.state;
    }
  });

  it('超限恢复（文件缩小后写入成功）复位，再次超限可再次提示', () => {
    const s1 = snapshotHint({ skipped: true, evicted: 0 }, INITIAL_SNAP_HINTS).state;
    expect(s1.skipNotified).toBe(true);
    const ok = snapshotHint({ skipped: false, evicted: 0 }, s1);
    expect(ok.key).toBeNull();
    expect(ok.state.skipNotified).toBe(false); // 复位
    expect(snapshotHint({ skipped: true, evicted: 0 }, ok.state).key).toBe('msg.snapSkip');
  });

  it('总量淘汰如实提示并把淘汰份数作插值参数（不整片静默丢保护）', () => {
    const h = snapshotHint({ skipped: false, evicted: 3 }, INITIAL_SNAP_HINTS);
    expect(h.key).toBe('msg.snapEvict');
    expect(h.arg).toBe(3);
  });

  it('纯函数不改传入状态（同一初始对象可跨调用复用）', () => {
    const base: SnapHintState = { skipNotified: false };
    snapshotHint({ skipped: true, evicted: 0 }, base);
    expect(base.skipNotified).toBe(false);
  });

  it('Rust 契约锁：上限常量、回报结构、sweep_tmp 与 lib.rs 调用点', () => {
    const src = rustSrc();
    expect(src).toContain('const SNAP_MAX_FILES: usize = 64');
    expect(src).toContain('const SNAP_MAX_BYTES: usize = 10 * 1024 * 1024');
    // 回报结构（前端提示的数据来源）
    expect(src).toContain('pub struct SnapshotOutcome');
    expect(src).toMatch(/pub skipped: bool/);
    expect(src).toMatch(/pub evicted: u64/);
    // 启动清扫/清理/淘汰只认本应用快照命名（含 .tmp 中间态；不碰快照本体与用户文件，F2 安全修复）
    expect(src).toContain('fn owned_snapshot_name');
    expect(src).toMatch(/owned_snapshot_name\(&name\)/);
    const lib = readFileSync(resolve(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
    expect(lib).toContain('recovery::sweep_tmp('); // 未被调用即残留永久滞留
    expect(lib).toContain('recovery::write_marker(');
  });

  it('i18n 两语键齐：中文界面下提示不回退成 key 文本', () => {
    for (const key of ['msg.snapSkip', 'msg.snapEvict']) {
      expect(dict('zh-CN')[key]).toBeTruthy();
      expect(dict('en-US')[key]).toBeTruthy();
    }
    expect(tf('msg.snapEvict', 3)).toContain('3'); // 插值生效
    expect(tf('msg.snapEvict', 3)).not.toContain('{0}');
    expect(t('msg.snapSkip')).not.toBe('msg.snapSkip');
  });
});
