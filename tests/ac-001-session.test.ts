// @vitest-environment jsdom
// 验收测试：001 会话与标签管理（AC-1 冷启动恢复 / 001-AC-2 重复打开激活 / 001-AC-3 会话往返）
// 纯逻辑层验证，不依赖 DOM 与 Tauri runtime；跨平台一致（AC-3 的逻辑子集）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shell, startShell, settle, tabNames, clickText } from './shell-behavior-harness';
import { namedSessionsLoad, recoveryDiscard, recoveryList, recoveryRead, textSave } from '../src/common/ipc';
import { t } from '../src/common/i18n';
import { TabStore } from '../src/common/state';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
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
  it('原生保存对话框失败显示原因，保留来源草稿与快照', async () => {
    vi.useFakeTimers(); await startShell(); await draft();
    const previous = tabNames();
    shell.saveDialog.mockRejectedValueOnce(new Error('dialog unavailable'));
    await shell.edit.save(); await settle();
    expect(shell.alert).toHaveBeenCalledWith(expect.stringContaining('dialog unavailable'));
    expect(tabNames()).toEqual(previous);
    expect(textSave).not.toHaveBeenCalled();
    expect(recoveryDiscard).not.toHaveBeenCalled();
  });
  it.each(['file.openFile', 'file.openFolder'])('%s 原生对话框失败显示原因', async action => {
    vi.useFakeTimers(); await startShell();
    vi.mocked(openDialog).mockRejectedValueOnce(new Error('dialog unavailable'));
    shell.actions.run(action); await settle();
    expect(shell.alert).toHaveBeenCalledWith(expect.stringContaining('dialog unavailable'));
    expect(tabNames()).toEqual([]);
  });
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
  it('另存目标已有脏标签时在写盘前阻止，保留双方内容', async () => {
    vi.useFakeTimers(); await startShell();
    shell.cli(['C:\\saved.txt']); await settle();
    shell.edit.opts.onStatus({ dirty: true, line: 1, col: 1 });
    await draft(); shell.saveDialog.mockResolvedValueOnce('C:\\saved.txt');
    const previous = tabNames();
    await shell.edit.save(); await settle();
    expect(shell.alert).toHaveBeenCalledWith(expect.stringContaining('saved.txt'));
    expect(tabNames()).toEqual(previous);
    expect(textSave).not.toHaveBeenCalled();
    expect(recoveryDiscard).not.toHaveBeenCalled();
  });

  it('草稿在另存写入期间继续输入，保留原草稿和活动标签', async () => {
    vi.useFakeTimers(); await startShell(); await draft();
    const view = shell.edit;
    const previous = tabNames();
    shell.saveDialog.mockResolvedValueOnce('C:\\saved.txt');
    let finish!: (stat: { len: number; modifiedMs: number }) => void;
    vi.mocked(textSave).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await view.save(); await settle();
    view.opts.onDocChange({});
    finish({ len: 20, modifiedMs: 200 }); await settle();
    expect(tabNames()).toEqual(previous);
    expect(shell.edit).toBe(view);
    expect(recoveryDiscard).not.toHaveBeenCalled();
  });

  it('目标在写盘期间变脏，保留其缓冲并保留来源草稿', async () => {
    vi.useFakeTimers(); await startShell();
    shell.cli(['C:\\saved.txt']); await settle(); await draft();
    shell.saveDialog.mockResolvedValueOnce('C:\\saved.txt');
    let finish!: (stat: { len: number; modifiedMs: number }) => void;
    vi.mocked(textSave).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await shell.edit.save(); await settle();
    shell.store.activate(0); await settle();
    const targetView = shell.edit;
    targetView.opts.onStatus({ dirty: true, line: 1, col: 1 });
    finish({ len: 20, modifiedMs: 200 }); await settle();
    expect(tabNames()).toHaveLength(2);
    expect(shell.edit).toBe(targetView);
    expect(targetView.destroyed).toBe(false);
    expect(recoveryDiscard).not.toHaveBeenCalled();
  });

  it('同路径关闭再打开后，旧视图保存回调不得修改新会话', async () => {
    vi.useFakeTimers(); await startShell();
    shell.cli(['C:\\saved.txt']); await settle();
    const old = shell.edit;
    shell.store.close(0); await settle();
    shell.cli(['C:\\saved.txt']); await settle();
    shell.edit.opts.onStatus({ dirty: true, line: 1, col: 1 });
    vi.mocked(recoveryDiscard).mockClear();
    old.opts.onSaved('C:\\saved.txt', { len: 999, modifiedMs: 999 }, true);
    old.opts.onStatus({ dirty: false, line: 1, col: 1 }); await settle();
    expect(document.querySelector('.tab .tab-dot')).not.toBeNull();
    expect(recoveryDiscard).not.toHaveBeenCalled();
    expect(document.querySelector('.tab')?.getAttribute('title')).not.toContain('999');
  });
});

describe('异常恢复条目', () => {
  it.each(['missing', 'error'])('快照在恢复时失效：%s，显示失败并保留快照', async kind => {
    vi.useFakeTimers();
    vi.mocked(recoveryList).mockResolvedValueOnce({ crashed: true, items: [{ key: 'draft://bad', ts: 1, bytes: 10, draft: true }] });
    if (kind === 'missing') vi.mocked(recoveryRead).mockResolvedValueOnce(null);
    else vi.mocked(recoveryRead).mockRejectedValueOnce(new Error('Cannot decrypt'));
    await startShell();
    clickText('.dlg-btn', t('rec.restore')); await settle();
    expect(shell.alert).toHaveBeenCalledWith(expect.stringContaining(kind === 'error' ? 'Cannot decrypt' : t('rec.missing')));
    expect(shell.flash).not.toHaveBeenCalledWith(t('rec.restored'));
    expect(vi.mocked(recoveryDiscard).mock.calls.flatMap(call => call[0])).not.toContain('draft://bad');
  });
  it('损坏条目展示原因；恢复正常条目时不读取或丢弃损坏条目', async () => {
    vi.useFakeTimers();
    vi.mocked(recoveryList).mockResolvedValueOnce({ crashed: true, items: [
      { key: 'bad', ts: 1, bytes: 30, draft: false, error: 'Cannot decrypt' },
      { key: 'draft://good', ts: 2, bytes: 20, draft: true },
    ] });
    vi.mocked(recoveryRead).mockResolvedValueOnce({ key: 'draft://good', content: 'recovered', mtime: 0, len: 0, draft: true, ts: 2 });
    await startShell();
    expect(document.body.textContent).toContain('Cannot decrypt');
    expect(document.querySelector<HTMLInputElement>('input[type=checkbox]:disabled')).not.toBeNull();
    clickText('.dlg-btn', t('rec.restore')); await settle();
    expect(recoveryRead).toHaveBeenCalledWith('draft://good');
    expect(recoveryRead).not.toHaveBeenCalledWith('bad');
    expect(vi.mocked(recoveryDiscard).mock.calls.flatMap(call => call[0])).not.toContain('bad');
  });
});
