// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { shell, startShell, settle } from './shell-behavior-harness';
import { cliTakePending, fileStat, textRefresh } from '../src/common/ipc';
import { FileTree } from '../src/file-tree/tree';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
async function poll(stat: { modifiedMs: number; len: number }) {
  vi.useFakeTimers();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  Object.assign(FileTree.prototype, { render: async () => {}, setActive: () => {} });
  vi.mocked(cliTakePending).mockResolvedValueOnce(['C:\\reload.txt']);
  await startShell();
  vi.mocked(fileStat).mockResolvedValue({ ...stat, isDir: false });
  vi.mocked(textRefresh).mockClear();
  shell.flash.mockClear();
  await vi.advanceTimersByTimeAsync(2000);
  await settle();
}
it('mtime 与大小都不变时不重载、不显示提示', async () => {
  await poll({ modifiedMs: 100, len: 10 });
  expect(textRefresh).not.toHaveBeenCalled();
  expect(shell.flash).not.toHaveBeenCalled();
});
it('仅 mtime 变化时触发重载与提示', async () => {
  await poll({ modifiedMs: 101, len: 10 });
  expect(textRefresh).toHaveBeenCalledWith('C:\\reload.txt');
  expect(shell.flash).toHaveBeenCalled();
});
it('mtime 相同但大小变化时也触发重载与提示', async () => {
  await poll({ modifiedMs: 100, len: 11 });
  expect(textRefresh).toHaveBeenCalledWith('C:\\reload.txt');
  expect(shell.flash).toHaveBeenCalled();
});
