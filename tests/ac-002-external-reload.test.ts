// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { shell, startShell, settle } from './shell-behavior-harness';
import { fileStat } from '../src/common/ipc';
import { t } from '../src/common/i18n';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('保存后的延迟 stat 不得消费外部版本；两个轮询周期内必须重载', async () => {
  vi.useFakeTimers(); await startShell();
  shell.cli(['C:\\a.md']); await settle();
  const view = shell.edit;
  let release!: (stat: { len: number; modifiedMs: number; isDir: boolean }) => void;
  vi.mocked(fileStat).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  view.opts.onSaved('C:\\a.md', { len: 20, modifiedMs: 200 }, true);
  // 外部重写发生在保存收口的异步请求完成前。
  release?.({ len: 30, modifiedMs: 300, isDir: false }); await settle();
  vi.mocked(fileStat).mockResolvedValue({ len: 30, modifiedMs: 300, isDir: false });
  await vi.advanceTimersByTimeAsync(4000); await settle();
  expect(shell.edit).not.toBe(view);
  expect(shell.flash).toHaveBeenCalledWith(t('msg.reloaded'));
});

it('在途轮询切换标签不消费原标签基线，切回后仍能重载', async () => {
  vi.useFakeTimers(); await startShell();
  vi.mocked(fileStat).mockResolvedValue({ len: 10, modifiedMs: 100, isDir: false });
  shell.cli(['C:\\a.md']); await settle();
  let release!: (stat: { len: number; modifiedMs: number; isDir: boolean }) => void;
  vi.mocked(fileStat).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await vi.advanceTimersByTimeAsync(2000);
  shell.cli(['C:\\b.txt']); await settle();
  const other = shell.edit;
  release({ len: 30, modifiedMs: 300, isDir: false }); await settle();
  expect(shell.edit).toBe(other);
  shell.store.activeIndex = 0;
  vi.mocked(fileStat).mockResolvedValue({ len: 30, modifiedMs: 300, isDir: false });
  await vi.advanceTimersByTimeAsync(4000); await settle();
  expect(shell.edit.filePath).toBe('C:\\a.md');
  expect(shell.flash).toHaveBeenCalledWith(t('msg.reloaded'));
});
