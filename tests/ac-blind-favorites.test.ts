// @vitest-environment jsdom
// IPC 契约测试：持久层由有状态模拟提供，不代替 Rust 落盘集成测试。
import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { favoritesList, favoritesToggle } from '../src/common/ipc';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    let paths: string[] = JSON.parse(localStorage.getItem('favorites') ?? '[]');
    if (cmd === 'favorites_toggle') {
      const path = (args as { path: string }).path;
      paths = paths.includes(path) ? paths.filter(p => p !== path) : [...paths, path];
      localStorage.setItem('favorites', JSON.stringify(paths));
    }
    return { items: paths.map(path => ({ path, isDir: false })), groups: [] };
  });
});
it('添加收藏发送正确命令，并能重新读取', async () => {
  await favoritesToggle('/a.txt');
  expect(invoke).toHaveBeenCalledWith('favorites_toggle', { path: '/a.txt' });
  expect((await favoritesList()).items.map(x => x.path)).toEqual(['/a.txt']);
});
it('移除收藏后重新读取为空，不伤其他收藏', async () => {
  await favoritesToggle('/a.txt');
  await favoritesToggle('/b.txt');
  await favoritesToggle('/a.txt');
  expect((await favoritesList()).items.map(x => x.path)).toEqual(['/b.txt']);
});
it('重复切换不会重复收藏，列表以持久层响应为准', async () => {
  for (let i = 0; i < 5; i++) await favoritesToggle('/a.txt');
  expect((await favoritesList()).items).toEqual([{ path: '/a.txt', isDir: false }]);
  await favoritesToggle('/a.txt');
  expect((await favoritesList()).items).toEqual([]);
});
