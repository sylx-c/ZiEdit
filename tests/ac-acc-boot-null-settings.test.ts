// @vitest-environment jsdom
// 验收缺陷 D1 回归：settingsLoad 解析为 null（后端 settings.json 缺失时曾返回 null）
// 时启动序列不得崩溃，tabbar/工具栏照常渲染。
// 验收缺陷 D2 回归：render() 编辑分支必须兜底 currentEncoding 失败（文件被删后的
// 会话恢复/标签切换曾产生未处理 Promise 拒绝"无法确定原编码"）。
import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { shell, startShell, settle } from './shell-behavior-harness';
import { EditorState } from '@codemirror/state';
import { settingsLoad } from '../src/common/ipc';

it('settingsLoad 返回 null 不阻断启动（D1 回归）', async () => {
  (settingsLoad as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
  await startShell(); // 修复前：boot 在 loadedSettings.s3Credentials 处抛 TypeError
  expect(document.getElementById('tabbar')).toBeTruthy();
  expect(document.getElementById('toolbar')).toBeTruthy();
  expect(document.getElementById('statusbar')).toBeTruthy();
  expect(shell.actions).toBeTruthy();
  // null 不得污染合并后的设置（DEFAULT_SETTINGS 兜底）
  expect((await (settingsLoad as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value) === null).toBe(true);
});

it('render 编辑分支兜底 currentEncoding 失败（D2 回归）', () => {
  const app = readFileSync('src/shell/app.ts', 'utf8');
  expect(app).toMatch(/currentEncoding\(tab\.path\)\.catch\(\(\) => 'UTF-8'\)/);
});

it('非 Markdown 文本切标签后向重挂编辑面恢复选区与滚动', async () => {
  await startShell();
  const path = 'C:\\work\\first.txt';
  shell.store.open({ path, route: 'text', language: 'JavaScript', scroll: 0, bookmarks: [] });
  await settle();
  const state = EditorState.create({ doc: 'first\nsecond\nthird', selection: { anchor: 2, head: 9 } });
  // 编辑面替身提供真实 CM 状态；断言跨标签重挂实际收到同一状态与滚动值。
  shell.edit.view = { state, scrollDOM: { scrollTop: 237 } };
  shell.store.open({ path: 'C:\\work\\second.txt', route: 'text', language: 'JavaScript', scroll: 0, bookmarks: [] });
  await settle();
  shell.store.activate(shell.store.tabs.findIndex((tab: { path: string }) => tab.path === path));
  await settle();
  expect(shell.edit.opts.buffer.state).toBe(state);
  expect(shell.edit.opts.buffer.state.selection.main.anchor).toBe(2);
  expect(shell.edit.opts.buffer.state.selection.main.head).toBe(9);
  expect(shell.edit.opts.buffer.scrollTop).toBe(237);
});

it('重载/切码哨兵换挂不得把旧缓冲写回恢复挂起（D3+F1 回归）', () => {
  const app = readFileSync('src/shell/app.ts', 'utf8');
  // 哨兵分支（reload=丢弃重读；enc=按新编码重读，F1 同语义）必须先于缓冲保留钩子，
  // 且不调用 saveDirtyIfAny/writeSnapshot——否则旧解码缓冲复活，切码表面生效实则未换码。
  const m = app.match(/if \(currentViewKey\.startsWith\('\\u0000reload'\) \|\| currentViewKey\.startsWith\('\\u0000enc'\)\) \{\s*([\s\S]*?)\s*\} else if/);
  expect(m).toBeTruthy();
  expect(m![1]).toContain('recoveryPending.delete');
  expect(m![1]).not.toContain('saveDirtyIfAny');
  expect(m![1]).not.toContain('writeSnapshot');
});
