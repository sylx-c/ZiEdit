// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { shell, startShell, settle, tabNames } from './shell-behavior-harness';
import { cliTakePending, loadSession, openFile } from '../src/common/ipc';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it('恢复会话后拉取 CLI 文件，新增文件不会被恢复覆盖', async () => {
  vi.useFakeTimers();
  vi.mocked(loadSession).mockResolvedValueOnce({ tabs: [{ path: 'C:\\old.txt', route: 'text', language: null, scroll: 0, bookmarks: [] }], activeIndex: 0 });
  vi.mocked(cliTakePending).mockResolvedValueOnce(['C:\\new.txt']);
  await startShell();
  expect(tabNames()).toEqual(['old.txt', 'new.txt']);
  expect(vi.mocked(loadSession).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(cliTakePending).mock.invocationCallOrder[0]);
});
it('单实例转发监听支持 Windows 路径的 :line 尾缀', async () => {
  vi.useFakeTimers(); await startShell();
  shell.cli(['C:\\forward.txt:42']); await settle();
  expect(openFile).toHaveBeenCalledWith('C:\\forward.txt');
  expect(tabNames()).toContain('forward.txt');
  await vi.advanceTimersByTimeAsync(350);
  expect(shell.edit.goToLine).toHaveBeenCalledWith(42);
});
