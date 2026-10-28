// @vitest-environment jsdom
// 验收测试：001 会话与标签管理（AC-1 冷启动恢复 / 001-AC-2 重复打开激活 / 001-AC-3 会话往返）
// 纯逻辑层验证，不依赖 DOM 与 Tauri runtime；跨平台一致（AC-3 的逻辑子集）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shell, startShell, settle, tabNames, clickText } from './shell-behavior-harness';
import { namedSessionsLoad, recoveryDiscard, textSave } from '../src/common/ipc';
import { t } from '../src/common/i18n';
import { TabStore } from '../src/common/state';
import type { SessionState, TabState } from '../src/common/ipc';

function tab(path: string, route: 'text' | 'image' = 'text'): TabState {
  return { path, route, language: route === 'text' ? 'JSON' : null, scroll: 0, bookmarks: [] };
}

describe('AC-1 冷启动恢复（001 规则：会话记忆标签与状态）', () => {
  it('上次打开的多个标签可完整恢复并激活原活动项', () => {
    const prev = new TabStore();
    prev.open(tab('src/main.rs', 'text'));
    prev.open(tab('logs/app.log', 'text'));
    prev.open({ ...tab('assets/icon.png', 'image') });
    prev.activate(1); // 上次活动 = logs/app.log
    const snapshot: SessionState = prev.session();

    const booted = new TabStore();
    expect(booted.restore(snapshot)).toBe(3);
    expect(booted.tabs.map(t => t.path)).toEqual(['src/main.rs', 'logs/app.log', 'assets/icon.png']);
    expect(booted.activeIndex).toBe(1);
  });

  it('损坏/非法会话恢复为 0 个且不抛错（空态降级）', () => {
    const s = new TabStore();
    expect(s.restore(null)).toBe(0);
    expect(s.restore({ tabs: 'x' } as unknown as SessionState)).toBe(0);
    expect(s.tabs).toHaveLength(0);
  });

  it('会话变更触发持久化回调（供外层防抖保存）', () => {
    const onSave = vi.fn();
    const s = new TabStore({ onSave });
    s.open(tab('a.txt'));
    expect(onSave).toHaveBeenCalled();
  });
});

describe('001-AC-2 重复打开同一文件激活已有标签', () => {
  it('重复打开不新增标签，仅激活', () => {
    const s = new TabStore();
    s.open(tab('a.txt'));
    s.open(tab('b.txt'));
    expect(s.open(tab('a.txt'))).toBe('activated');
    expect(s.tabs).toHaveLength(2);
    expect(s.activeIndex).toBe(0);
  });
});

describe('001-AC-3 会话序列化往返一致', () => {
  it('拖动非活动标签跨过活动标签不切换内容身份', () => {
    const s = new TabStore();
    for (const p of ['a.txt', 'b.txt', 'c.txt']) s.open(tab(p));
    s.activate(1);
    s.move(0, 2);
    expect(s.active()?.path).toBe('b.txt');
    s.move(2, 0);
    expect(s.active()?.path).toBe('b.txt');
  });

  it('目录改名迁移子标签且保留状态，不误迁同前缀目录', () => {
    const s = new TabStore();
    s.open({ ...tab('E:\\old\\a.txt'), scroll: 12, bookmarks: [3] });
    s.open(tab('E:\\old2\\b.txt'));
    s.activate(0);
    s.renamePath('E:\\old', 'E:\\new');
    expect(s.active()).toMatchObject({ path: 'E:\\new\\a.txt', scroll: 12, bookmarks: [3] });
    expect(s.tabs[1].path).toBe('E:\\old2\\b.txt');
  });
  it('session → restore → session 完全一致', () => {
    const s1 = new TabStore();
    s1.open(tab('a.rs')); s1.open(tab('b.bin', 'image'));
    s1.activate(0);
    const snap = s1.session();
    const s2 = new TabStore();
    s2.restore(snap);
    expect(s2.session()).toEqual(snap);
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
async function draft() {
  shell.actions.run('file.newDraft'); await settle();
  shell.edit.opts.onStatus({ dirty: true, line: 1, col: 1 });
}
describe('F001-01 命名会话恢复脏守卫', () => {
  it.each(['cancel', 'failure', 'success', 'discard'])('脏草稿恢复：%s', async outcome => {
    vi.useFakeTimers();
    vi.mocked(namedSessionsLoad).mockResolvedValueOnce({ work: { tabs: [tab('C:\\restored.txt')], activeIndex: 0 } });
    await startShell(); await draft();
    const previous = tabNames();
    shell.actions.run('file.session:work');
    expect(tabNames()).toEqual(previous);
    shell.saveDialog.mockResolvedValueOnce(outcome === 'cancel' ? null : 'C:\\saved.txt');
    if (outcome === 'failure') vi.mocked(textSave).mockRejectedValueOnce(new Error('disk full'));
    clickText('.dlg-btn', t(outcome === 'discard' ? 'exit.discardExit' : 'exit.saveExit'));
    await settle();
    expect(tabNames()).toEqual(outcome === 'success' || outcome === 'discard' ? ['restored.txt'] : previous);
    if (outcome === 'success') expect(textSave).toHaveBeenCalledWith('C:\\saved.txt', 'edited', 'UTF-8');
    if (outcome === 'failure') expect(shell.alert).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});
describe('F001-04 草稿另存后关联文件', () => {
  it.each(['cancel', 'failure', 'success'])('另存：%s', async outcome => {
    vi.useFakeTimers(); await startShell(); await draft();
    const previous = tabNames();
    shell.saveDialog.mockResolvedValueOnce(outcome === 'cancel' ? null : 'C:\\saved.txt');
    if (outcome === 'failure') vi.mocked(textSave).mockRejectedValueOnce(new Error('disk full'));
    await shell.edit.save(); await settle();
    expect(tabNames()).toEqual(outcome === 'success' ? ['saved.txt'] : previous);
    if (outcome === 'success') {
      expect(recoveryDiscard).toHaveBeenCalledWith([expect.stringMatching(/^draft:\/\//)]);
      await shell.edit.save(); await settle();
      expect(textSave).toHaveBeenLastCalledWith('C:\\saved.txt', 'edited', 'UTF-8');
      expect(shell.saveDialog).toHaveBeenCalledTimes(1);
    } else expect(recoveryDiscard).not.toHaveBeenCalled();
  });
  it('另存目标已有脏标签时明示，最终只保留目标文件标签', async () => {
    vi.useFakeTimers(); await startShell();
    shell.cli(['C:\\saved.txt']); await settle();
    shell.edit.opts.onStatus({ dirty: true, line: 1, col: 1 });
    await draft(); shell.saveDialog.mockResolvedValueOnce('C:\\saved.txt');
    await shell.edit.save(); await settle();
    expect(shell.alert).toHaveBeenCalledWith(expect.stringContaining('saved.txt'));
    expect(tabNames()).toEqual(['saved.txt']);
  });
});
