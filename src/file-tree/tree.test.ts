// 文件树纯逻辑单测（001 子 PRD 规则 25：目录跟随的路径判定）
// 多选行为（验收缺陷 D4 回归）：普通单击清多选；超额多选取最近一对
import { describe, expect, it, vi } from 'vitest';
import { FileTree, relativeToRoot, type TreeRoot } from './tree';

vi.mock('../common/ipc', () => ({
  listDir: async (path: string) =>
    path.endsWith('ws')
      ? [
          { name: 'a.txt', isDir: false, len: 1, route: 'text' as const, language: null },
          { name: 'b.txt', isDir: false, len: 1, route: 'text' as const, language: null },
          { name: 'c.txt', isDir: false, len: 1, route: 'text' as const, language: null },
        ]
      : [],
}));

// @vitest-environment jsdom
describe('FileTree 多选（Ctrl+点击，验收缺陷 D4 回归）', () => {
  const roots: TreeRoot[] = [{ path: 'C:\\ws', label: 'ws' }];
  const rowOf = (host: HTMLElement, name: string) =>
    [...host.querySelectorAll('.tr')].find(r => r.querySelector('.tr-name')?.textContent === name) as HTMLElement;
  const ctrlClick = (el: HTMLElement) =>
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));

  it('普通单击打开文件后多选态清空', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onOpenFile = vi.fn();
    const onContextFile = vi.fn();
    const tree = new FileTree(host, roots, { onOpenFile, onContextFile });
    await tree.render();
    const a = rowOf(host, 'a.txt'), b = rowOf(host, 'b.txt'), c = rowOf(host, 'c.txt');
    ctrlClick(a); ctrlClick(b);
    expect(a.classList.contains('msel') && b.classList.contains('msel')).toBe(true);
    c.dispatchEvent(new MouseEvent('click', { bubbles: true })); // 普通单击打开
    expect(onOpenFile).toHaveBeenCalled();
    expect(host.querySelectorAll('.msel').length).toBe(0); // D4：多选态随动作清空
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(onContextFile).toHaveBeenCalledWith(expect.any(String), expect.any(Number), expect.any(Number), undefined);
    host.remove();
  });

  it('多选 3 个后右键：比较对取最近加入的一对（插入序末两个）', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onContextFile = vi.fn();
    const tree = new FileTree(host, roots, { onOpenFile: () => {}, onContextFile });
    await tree.render();
    const a = rowOf(host, 'a.txt'), b = rowOf(host, 'b.txt'), c = rowOf(host, 'c.txt');
    ctrlClick(a); ctrlClick(b); ctrlClick(c);
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const sel = onContextFile.mock.calls[0]?.[3] as string[] | undefined;
    expect(sel).toEqual(['C:\\ws\\b.txt', 'C:\\ws\\c.txt']); // 末两个，非前两个
    host.remove();
  });
});

describe('relativeToRoot', () => {
  it('直接子文件', () => {
    expect(relativeToRoot('E:\\work\\editor', 'E:\\work\\editor\\package.json'))
      .toEqual(['package.json']);
  });
  it('多级嵌套', () => {
    expect(relativeToRoot('E:\\work\\editor', 'E:\\work\\editor\\src\\shell\\app.ts'))
      .toEqual(['src', 'shell', 'app.ts']);
  });
  it('正斜杠归一化为反斜杠', () => {
    expect(relativeToRoot('E:/work/editor', 'E:/work/editor/src/app.ts'))
      .toEqual(['src', 'app.ts']);
  });
  it('Windows 不区分大小写', () => {
    expect(relativeToRoot('e:\\work\\editor', 'E:\\work\\editor\\a.txt'))
      .toEqual(['a.txt']);
  });
  it('不在根下返回 null', () => {
    expect(relativeToRoot('E:\\work\\editor', 'D:\\other\\a.txt')).toBeNull();
    expect(relativeToRoot('E:\\work\\editor', 'E:\\work\\editor2\\a.txt')).toBeNull();
  });
  it('盘符根', () => {
    expect(relativeToRoot('E:\\', 'E:\\a.txt')).toEqual(['a.txt']);
  });
  it('文件即根本身返回空段', () => {
    expect(relativeToRoot('E:\\work\\editor', 'E:\\work\\editor')).toEqual([]);
  });
  it('POSIX 路径保留斜杠且区分大小写', () => {
    expect(relativeToRoot('/home/u/proj', '/home/u/proj/src/a.ts')).toEqual(['src', 'a.ts']);
    expect(relativeToRoot('/home/u/proj', '/Home/u/proj/a.ts')).toBeNull();
  });
  it('根尾部分隔符不影响判定', () => {
    expect(relativeToRoot('/home/u/proj/', '/home/u/proj/a.ts')).toEqual(['a.ts']);
  });
});
