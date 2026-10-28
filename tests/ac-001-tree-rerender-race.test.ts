// @vitest-environment jsdom
// 001 目录跟随高亮竞态根修回归（阶段一面4 走查 F1/F2 实锤）。
// 修前缺陷：boot 序列 store.restore 同步通知 render() → syncTreeRootToActive 的 void rebuildTree()（A）
// 与启动 5242 的 await rebuildTree()（B）并发；B 的 refresh 清空 allRows 重渲后，A 迟到的 expandInto
// 续体仍把行追加到已脱离 DOM 的锚点并推入 allRows（影子行排前）——此后 setActive/reveal 的
// allRows.find 命中游离行，.active 落在不可见元素上（可见树永不高亮，AC-20/21 断裂）。
// 修后契约：expandInto 按渲染代际弃置迟到续体；并发 render+refresh 后无影子行，setActive 命中可见行。
import { describe, expect, it, vi } from 'vitest';

const ENTRIES = [
  { name: 'a.txt', isDir: false, path: 'E:\\t\\a.txt' },
  { name: 'sub', isDir: true, path: 'E:\\t\\sub' },
];

vi.mock('../src/common/ipc', () => ({
  listDir: async () => {
    await new Promise(r => setTimeout(r, 25));
    return ENTRIES.map(e => ({ ...e }));
  },
}));

const { FileTree } = await import('../src/file-tree/tree');

describe('001 文件树并发重建竞态', () => {
  it('render 与 refresh 并发：无影子行，setActive 高亮可见行', async () => {
    const host = document.createElement('div');
    const tree = new FileTree(host, 'E:\\t', { onOpenFile: () => {} });
    const a = tree.render();   // A：挂起于 listDir（同构 boot 479 的 void rebuildTree）
    const b = tree.refresh();  // B：清 allRows 重渲（同构 boot 5242 的 await rebuildTree）
    await Promise.all([a, b]);
    const rows = [...host.querySelectorAll('.tr')];
    expect(rows.length).toBe(3); // 根 + a.txt + sub（无重复、无游离）
    tree.setActive('E:\\t\\a.txt');
    const aRow = rows.find(r => r.title === 'E:\\t\\a.txt');
    expect(aRow?.classList.contains('active')).toBe(true); // 修前 .active 落在游离行，此处为 false
    expect(host.querySelectorAll('.tr.active').length).toBe(1);
  });
});
