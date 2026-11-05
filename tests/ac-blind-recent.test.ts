// @vitest-environment jsdom
// IPC 契约测试：50 条上限由模拟后端提供，不代替 Rust recent_add 测试。
import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { recentAdd, recentList } from '../src/common/ipc';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    let paths: string[] = JSON.parse(localStorage.getItem('recent') ?? '[]');
    if (cmd === 'recent_add') {
      const path = (args as { path: string }).path;
      paths = [path, ...paths.filter(p => p !== path)].slice(0, 50);
      localStorage.setItem('recent', JSON.stringify(paths));
      return;
    }
    return paths.map(path => ({ path, isDir: false }));
  });
});
it('recent_add 参数正确，recent_list 保留新条目在前的响应顺序', async () => {
  await recentAdd('/old');
  await recentAdd('/new');
  expect(invoke).toHaveBeenCalledWith('recent_add', { path: '/new' });
  expect((await recentList()).map(x => x.path)).toEqual(['/new', '/old']);
});
it('前端完整返回后端截断后的 50 条记录', async () => {
  for (let i = 0; i < 55; i++) await recentAdd(`/file-${i}`);
  expect((await recentList()).map(x => x.path)).toEqual(
    Array.from({ length: 50 }, (_, i) => `/file-${54 - i}`),
  );
});
it('重新打开旧文件后仅返回一个条目且排在最前', async () => {
  await recentAdd('/a');
  await recentAdd('/b');
  await recentAdd('/a');
  expect((await recentList()).map(x => x.path)).toEqual(['/a', '/b']);
});
