// 002 规则 30 v2.6 伪标签适用矩阵回归锁（P0-2；状态栏属 001 域故落 ac-001 命名）：
// 修前缺陷——状态栏模式格/COL 格对 tail://、compare:// 伪标签不设防，点击经旧 enterEditMode
// 把伪路径当文件打开（Windows ERROR_INVALID_NAME → os error 123 → E1001「打开失败」）。
// 判决收口于 src/common/paths.ts 的 isVirtualTab（自 app.ts 顶层迁出，全入口共用）：
// withEdit / onModeCellClick / colRelevant（COL 灯显示）/ autosave activeInfo
// （v2.6 起 enterEditMode/toggleEditMode/view.editToggle 已随双模式删除）。
// 本组锁死判决语义与迁移后 app.ts 不再自带第二份实现（防漂移回两套口径）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isVirtualTab, isRealFilePath, dirOf, normLocal } from '../src/common/paths';

describe('001/002 AC：伪标签不适用编辑入口（P0-2）', () => {
  it('isVirtualTab：对比与尾随台是伪标签，真实路径与草稿不是', () => {
    expect(isVirtualTab('compare://E:\\a.txt|E:\\b.txt')).toBe(true);
    expect(isVirtualTab('tail://')).toBe(true);
    expect(isVirtualTab('E:\\work\\editor\\AGENTS.md')).toBe(false);
    expect(isVirtualTab('draft://scratch-1')).toBe(false); // 草稿可编辑，非虚标签
    expect(isVirtualTab('')).toBe(false);
  });

  it('isRealFilePath：草稿/对比/尾随台都非真实文件（与 isVirtualTab 互补且多排除草稿）', () => {
    expect(isRealFilePath('E:\\a\\b.txt')).toBe(true);
    expect(isRealFilePath('draft://scratch-1')).toBe(false);
    expect(isRealFilePath('compare://a|b')).toBe(false);
    expect(isRealFilePath('tail://')).toBe(false);
  });

  it('dirOf/normLocal：迁移后语义不变（树根/另存默认目录依赖）', () => {
    expect(dirOf('E:\\work\\editor\\a.md')).toBe('E:\\work\\editor');
    expect(dirOf('E:\\a.md')).toBe('E:\\');
    expect(normLocal('E:/a/b.txt')).toBe('E:\\a\\b.txt');
    expect(normLocal('draft://x')).toBe('draft://x');
  });

  it('app.ts 不再自带第二份路径判决（防两套口径漂移）', () => {
    const src = readFileSync(resolve(__dirname, '../src/shell/app.ts'), 'utf8');
    expect(src).toMatch(/from '\.\.\/common\/paths'/);
    expect(src).not.toMatch(/function isRealFilePath/);
    expect(src).not.toMatch(/function isVirtualTab/);
  });
});
