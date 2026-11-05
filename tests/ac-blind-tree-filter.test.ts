// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { FileTree } from '../src/file-tree/tree';
import { listDir } from '../src/common/ipc';
vi.mock('../src/common/ipc', () => ({ listDir: vi.fn() }));

let host: HTMLElement;
beforeEach(async () => {
  vi.clearAllMocks();
  host = document.createElement('div');
  vi.mocked(listDir).mockResolvedValue([
    { name: 'Server.LOG', isDir: false, len: 1, route: 'text', language: null },
    { name: 'notes.txt', isDir: false, len: 1, route: 'text', language: null },
    { name: 'logs', isDir: true, len: 0, route: 'text', language: null },
  ]);
  await new FileTree(host, '/root', { onOpenFile: vi.fn() }).render();
});
function filter(value: string) {
  const input = host.querySelector('input')!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}
function visible(name: string) {
  const label = [...host.querySelectorAll('.tr-name')].find(el => el.textContent === name)!;
  return (label.closest('.tr') as HTMLElement).style.display !== 'none';
}
it('关键词忽略大小写、匹配文件及目录', () => {
  filter(' LOG ');
  expect(visible('Server.LOG')).toBe(true);
  expect(visible('logs')).toBe(true);
  expect(visible('notes.txt')).toBe(false);
});
it('无匹配时隐藏所有文件', () => {
  filter('absent');
  expect(visible('Server.LOG')).toBe(false);
  expect(visible('notes.txt')).toBe(false);
});
it('清空过滤恢复文件，不重新请求磁盘', () => {
  filter('log');
  filter('');
  expect(visible('Server.LOG')).toBe(true);
  expect(visible('notes.txt')).toBe(true);
  expect(visible('logs')).toBe(true);
  expect(listDir).toHaveBeenLastCalledWith('/root');
  expect(listDir).toHaveBeenCalledTimes(1);
});
