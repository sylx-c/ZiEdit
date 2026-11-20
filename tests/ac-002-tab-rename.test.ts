// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shell, startShell, settle, clickText } from './shell-behavior-harness';
import { fileRename, fileStat, pathsRenameRecords } from '../src/common/ipc';
import { t } from '../src/common/i18n';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function openTab(path: string, route: 'text' | 'image' = 'text', language: string | null = 'Text'): Promise<void> {
  const { openFile } = await import('../src/common/ipc');
  vi.mocked(openFile).mockResolvedValueOnce({ path, len: 10, modifiedMs: 100, route, language, readonly: false, binary: false });
  shell.cli([path]);
  await settle();
}

function tabEl(name: string): HTMLElement {
  const el = [...document.querySelectorAll('.tab')].find(node => node.querySelector('.tab-name')?.textContent === name);
  if (!(el instanceof HTMLElement)) throw new Error(`Missing tab ${name}`);
  return el;
}

function menuLabels(): string[] {
  return [...document.querySelectorAll('.ctx-menu > div')].map(el => el.textContent ?? '');
}

async function confirmRename(value: string): Promise<void> {
  await vi.waitFor(() => expect(document.querySelector('.dlg-input')).toBeTruthy());
  document.querySelector<HTMLInputElement>('.dlg-input')!.value = value;
  clickText('.dlg-btn', t('common.ok'));
  await settle();
}

describe('标签右键重命名', () => {
  it('真实文件可从标签改名，未保存脏标记留在新路径', async () => {
    vi.useFakeTimers();
    await startShell();
    await openTab('C:\\work\\note.txt');
    tabEl('note.txt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(menuLabels().some(label => label.includes(t('ctx.rename')))).toBe(true);
    clickText('.ctx-menu > div', t('ctx.rename'));
    await confirmRename('renamed.txt');
    expect(fileRename).toHaveBeenCalledWith('C:\\work\\note.txt', 'C:\\work\\renamed.txt');
    expect(shell.store.tabs.map((tab: { path: string }) => tab.path)).toContain('C:\\work\\renamed.txt');
  });

  it('空名称、同名和斜杠不调用改名；失败不改标签', async () => {
    vi.useFakeTimers();
    await startShell();
    await openTab('C:\\work\\note.txt');
    shell.dirtyPaths?.set?.('C:\\work\\note.txt', true);
    for (const value of ['', 'note.txt', 'a/b.txt', 'a\\b.txt']) {
      tabEl('note.txt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      clickText('.ctx-menu > div', t('ctx.rename'));
      await confirmRename(value);
    }
    expect(fileRename).not.toHaveBeenCalled();
    vi.mocked(fileRename).mockRejectedValueOnce(new Error('EXISTS'));
    tabEl('note.txt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    clickText('.ctx-menu > div', t('ctx.rename'));
    await confirmRename('same.txt');
    expect(shell.store.active().path).toBe('C:\\work\\note.txt');
    expect(shell.alert).toHaveBeenCalledWith(t('msg.nameExists'));
  });

  it('文件已不在时不迁移标签', async () => {
    vi.useFakeTimers();
    await startShell();
    await openTab('C:\\work\\note.txt');
    vi.mocked(fileRename).mockRejectedValueOnce(new Error('NOT_FOUND'));
    tabEl('note.txt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    clickText('.ctx-menu > div', t('ctx.rename'));
    await confirmRename('gone.txt');
    expect(shell.store.active().path).toBe('C:\\work\\note.txt');
    expect(shell.alert).toHaveBeenCalledWith(t('err.renameMissing'));
  });

  it('草稿、对比和尾随台没有重命名；图片可以改名', async () => {
    vi.useFakeTimers();
    await startShell();
    for (const path of ['draft://1', 'compare://a|b', 'tail://']) {
      document.querySelector('.ctx-menu')?.remove();
      shell.store.open({ path, route: 'text', language: null, scroll: 0, bookmarks: [] });
      await settle();
      const el = [...document.querySelectorAll('.tab')].find(node => node.classList.contains('active'));
      if (!(el instanceof HTMLElement)) throw new Error(`Missing virtual tab ${path}`);
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      expect(menuLabels().some(label => label.includes(t('ctx.rename')))).toBe(false);
    }
    await openTab('C:\\work\\pic.png', 'image', null);
    tabEl('pic.png').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(menuLabels().some(label => label.includes(t('ctx.rename')))).toBe(true);
  });

  it('单文件改名不改同前缀子路径', async () => {
    vi.useFakeTimers();
    await startShell();
    await openTab('C:\\notes');
    shell.store.open({ path: 'C:\\notes\\child.txt', route: 'text', language: 'Text', scroll: 0, bookmarks: [] });
    await settle();
    tabEl('notes').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    clickText('.ctx-menu > div', t('ctx.rename'));
    await confirmRename('notes-old');
    expect(shell.store.tabs.map((tab: { path: string }) => tab.path)).toEqual(['C:\\notes-old', 'C:\\notes\\child.txt']);
  });

  it('扩展名变化更新路由，锁定路由保持不变', async () => {
    vi.useFakeTimers();
    await startShell();
    await openTab('C:\\work\\note.txt');
    tabEl('note.txt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    clickText('.ctx-menu > div', t('ctx.rename'));
    await confirmRename('note.md');
    expect(shell.store.active()).toMatchObject({ path: 'C:\\work\\note.md', route: 'text', language: 'Markdown' });
    expect(pathsRenameRecords).toHaveBeenCalledWith('C:\\work\\note.txt', 'C:\\work\\note.md');

    shell.store.active().routeLocked = true;
    tabEl('note.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    clickText('.ctx-menu > div', t('ctx.rename'));
    await confirmRename('note.png');
    expect(shell.store.active()).toMatchObject({ path: 'C:\\work\\note.png', route: 'text', language: 'Markdown', routeLocked: true });
  });

  it('改名期间旧路径探测失败不会把新路径标成已删除', async () => {
    vi.useFakeTimers();
    await startShell();
    await openTab('C:\\work\\note.txt');
    let rejectStat!: (err: Error) => void;
    vi.mocked(fileStat).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStat = reject; }));
    await vi.advanceTimersByTimeAsync(2000);
    tabEl('note.txt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    clickText('.ctx-menu > div', t('ctx.rename'));
    await confirmRename('renamed.txt');
    rejectStat(new Error('NOT_FOUND'));
    await settle();
    expect(shell.store.active().path).toBe('C:\\work\\renamed.txt');
    expect(document.querySelector('.ext-del')).toBeNull();
  });

  it('代码扩展名改名后保留对应语言', async () => {
    vi.useFakeTimers();
    await startShell();
    await openTab('C:\\work\\note.txt');
    tabEl('note.txt').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    clickText('.ctx-menu > div', t('ctx.rename'));
    await confirmRename('note.py');
    expect(shell.store.active()).toMatchObject({ path: 'C:\\work\\note.py', route: 'text', language: 'Python' });
  });
});
