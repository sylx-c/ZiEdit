// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { shell, startShell, settle, tabNames, clickText } from './shell-behavior-harness';
import { deleteToTrash, fileStat, openFile, textSave } from '../src/common/ipc';
import { t } from '../src/common/i18n';
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function deleted() {
  vi.useFakeTimers(); await startShell();
  shell.cli(['C:\\a.txt']); await settle();
  vi.mocked(fileStat).mockRejectedValueOnce(new Error('NOT_FOUND'));
  await vi.advanceTimersByTimeAsync(2000); await settle();
}
it('外部删除显示状态格、标签划线标记与一次性提示，不重复轮询', async () => {
  await deleted();
  expect(document.querySelector('.tab-del .tab-name')?.textContent).toBe('a.txt');
  expect(document.querySelector('.ext-del')?.textContent).toBe(t('msg.fileDeleted'));
  expect(shell.flash).toHaveBeenCalledWith(t('msg.fileDeleted'));
  const calls = vi.mocked(fileStat).mock.calls.length;
  await vi.advanceTimersByTimeAsync(4000);
  expect(fileStat).toHaveBeenCalledTimes(calls);
  expect(shell.flash.mock.calls.filter(([msg]) => msg === t('msg.fileDeleted'))).toHaveLength(1);
});
it.each(['reload', 'save', 'reopen'])('%s 成功清除删除标记', async operation => {
  await deleted();
  if (operation === 'reload') shell.actions.run('file.reload');
  else if (operation === 'save') await shell.edit.save();
  else {
    // 先关闭原标签，再经标准打开入口重开，不能只是激活同一个标签。
    document.querySelector<HTMLElement>('.ext-del')!.click();
    clickText('.ctx-menu > div', t('common.close'));
    shell.cli(['C:\\a.txt']);
  }
  await settle();
  expect(document.querySelector('.ext-del')).toBeNull();
  expect(document.querySelector('.tab-del')).toBeNull();
});
it.each(['saveAs', 'close', 'ignore'])('删除状态格支持 %s', async action => {
  await deleted();
  document.querySelector<HTMLElement>('.ext-del')!.click();
  for (const key of ['msg.fileDeletedSaveAs', 'common.close', 'msg.fileChangedIgnore']) {
    expect(document.querySelector('.ctx-menu')?.textContent).toContain(t(key));
  }
  if (action === 'saveAs') {
    shell.saveDialog.mockResolvedValueOnce('C:\\recovered.txt');
    clickText('.ctx-menu > div', t('msg.fileDeletedSaveAs')); await settle();
    expect(textSave).toHaveBeenCalledWith('C:\\recovered.txt', 'edited', 'UTF-8');
  } else {
    clickText('.ctx-menu > div', t(action === 'close' ? 'common.close' : 'msg.fileChangedIgnore'));
    await settle();
    expect(document.querySelector('.ext-del')).toBeNull();
    expect(tabNames()).toEqual(action === 'close' ? [] : ['a.txt']);
  }
});
it('树删除成功关闭净标签；脏标签保留标记；精确限定目录前缀', async () => {
  vi.useFakeTimers(); await startShell();
  // 使用树文件上下文入口提交目录路径，验证删除后处置的目录边界。
  vi.mocked(openFile).mockResolvedValueOnce({ path: 'C:\\dir\\clean.txt', route: 'text', language: null, len: 10, modifiedMs: 100, readonly: false });
  shell.cli(['C:\\dir\\clean.txt', 'C:\\dir2\\safe.txt', 'C:\\dir\\dirty.txt']); await settle();
  shell.edit.opts.onStatus({ dirty: true, line: 1, col: 1 });
  shell.confirm.mockResolvedValueOnce(true);
  shell.tree.opts.onContextFile('C:\\dir', 0, 0);
  clickText('.ctx-menu > div', t('ctx.deleteTrash')); await settle();
  expect(deleteToTrash).toHaveBeenCalledWith('C:\\dir');
  expect(tabNames()).toEqual(['safe.txt', 'dirty.txt']);
  expect(document.querySelector('.tab-del .tab-name')?.textContent).toBe('dirty.txt');
});
it('树删除失败不关闭标签', async () => {
  vi.useFakeTimers(); await startShell(); shell.cli(['C:\\a.txt']); await settle();
  shell.confirm.mockResolvedValueOnce(true);
  vi.mocked(deleteToTrash).mockRejectedValueOnce(new Error('denied'));
  shell.tree.opts.onContextFile('C:\\a.txt', 0, 0);
  clickText('.ctx-menu > div', t('ctx.deleteTrash')); await settle();
  expect(tabNames()).toEqual(['a.txt']);
  expect(shell.alert).toHaveBeenCalledWith(expect.stringContaining('denied'));
});
