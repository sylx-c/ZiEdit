// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { shell, startShell, settle, clickText } from './shell-behavior-harness';
import { openWithDefault, revealInDir } from '../src/common/ipc';
import { t } from '../src/common/i18n';
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('用户路径的系统打开及定位经 IPC 命令，不受插件资源 scope 限制', async () => {
  const ipc = await vi.importActual<typeof import('../src/common/ipc')>('../src/common/ipc');
  await ipc.openWithDefault('D:\\用户文件.txt');
  await ipc.revealInDir('D:\\用户文件.txt');
  expect(shell.invoke).toHaveBeenCalledWith('open_with_default', { path: 'D:\\用户文件.txt' });
  expect(shell.invoke).toHaveBeenCalledWith('reveal_in_dir', { path: 'D:\\用户文件.txt' });
});
it('文件树的系统打开/定位传递原路径，失败给用户提示', async () => {
  vi.useFakeTimers(); await startShell();
  shell.cli(['C:\\a.txt']); await settle();
  shell.tree.opts.onContextFile('C:\\用户文件.txt', 0, 0);
  clickText('.ctx-menu > div', t('ctx.openWith')); await settle();
  expect(openWithDefault).toHaveBeenCalledWith('C:\\用户文件.txt');
  vi.mocked(openWithDefault).mockRejectedValueOnce(new Error('open denied'));
  shell.tree.opts.onContextFile('C:\\用户文件.txt', 0, 0);
  clickText('.ctx-menu > div', t('ctx.openWith')); await settle();
  expect(shell.flash).toHaveBeenCalledWith(expect.stringContaining('open denied'));
  vi.mocked(revealInDir).mockRejectedValueOnce(new Error('denied'));
  shell.tree.opts.onContextFile('C:\\用户文件.txt', 0, 0);
  clickText('.ctx-menu > div', t('ctx.revealInExplorer')); await settle();
  expect(revealInDir).toHaveBeenCalledWith('C:\\用户文件.txt');
  expect(shell.flash).toHaveBeenCalledWith(expect.stringContaining('denied'));
});
