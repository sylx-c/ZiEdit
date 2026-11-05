// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ search: vi.fn(), cancel: vi.fn(), save: vi.fn(), choose: vi.fn(), unlisten: vi.fn() }));
vi.mock('../src/common/ipc', () => ({ findInFiles: mock.search, findCancel: mock.cancel, textSave: mock.save }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => mock.unlisten }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mock.choose }));
import { findInFilesPanel } from '../src/shell/panels';
import { t } from '../src/common/i18n';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
it('取消后保留部分结果与限制，导出完整状态和查询条件', async () => {
  let finish!: (value: unknown) => void;
  mock.search.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  mock.cancel.mockResolvedValue(undefined);
  mock.choose.mockResolvedValue('results.txt');
  mock.save.mockResolvedValue(undefined);
  const open = vi.fn();
  const panel = findInFilesPanel('root', open);
  panel.querySelector<HTMLInputElement>('.fif-needle')!.value = 'cat';
  panel.querySelector<HTMLInputElement>('.fif-glob')!.value = '*.txt';
  const buttons = Array.from(panel.querySelectorAll('button'));
  buttons.find(btn => btn.textContent === t('fif.search'))!.click();
  await tick();
  expect(mock.search).toHaveBeenCalledWith('root', 'cat', expect.anything(), expect.any(String), '*.txt');
  buttons.find(btn => btn.textContent === t('common.cancel'))!.click();
  expect(mock.cancel).toHaveBeenCalledWith(mock.search.mock.calls.at(-1)![3]);
  finish({ files: [{ path: 'a.txt', hits: [{ line: 3, col: 2, text: 'cat' }] }], scanned: 8, skipped: [{ path: 'b.bin', reason: 'binary' }], skippedCount: 1, cancelled: true, limits: ['hits-per-file:50'] });
  await tick();
  expect(panel.querySelector('.fif-status')!.textContent).toContain(t('fif.cancelled'));
  expect(panel.querySelector('.fif-status')!.textContent).toContain(t('fif.incomplete'));
  panel.querySelector<HTMLElement>('.fif-hit')!.click();
  expect(open).toHaveBeenCalledWith('a.txt', 3);
  buttons.find(btn => btn.textContent === t('fif.export'))!.click();
  await tick();
  expect(mock.save).toHaveBeenCalledWith('results.txt', expect.stringContaining('a.txt:3:2: cat'), 'UTF-8', 0);
  expect(mock.save.mock.calls.at(-1)![1]).toContain('*.txt');
  expect(mock.unlisten).toHaveBeenCalled();
  panel.dispose();
});

it('关闭面板后取消后台任务，迟到结果不再修改面板', async () => {
  let finish!: (value: unknown) => void;
  mock.search.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const panel = findInFilesPanel('root', () => {});
  panel.querySelector<HTMLInputElement>('.fif-needle')!.value = 'cat';
  Array.from(panel.querySelectorAll('button')).find(btn => btn.textContent === t('fif.search'))!.click();
  await tick();
  panel.dispose();
  const before = panel.querySelector('.fif-result')!.textContent;
  finish({ files: [], scanned: 8, skipped: [], skippedCount: 0, limits: [], cancelled: true });
  await tick();
  expect(panel.querySelector('.fif-result')!.textContent).toBe(before);
  expect(mock.cancel).toHaveBeenCalled();
});
