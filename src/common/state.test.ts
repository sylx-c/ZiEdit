// TabStore 单元测试（001-AC-2 / 001-AC-3 的逻辑层验证）
import { describe, expect, it, vi } from 'vitest';
import { TabStore } from './state';
import type { SessionState, TabState } from './ipc';

function tab(path: string, route: 'text' | 'image' = 'text'): TabState {
  return { path, route, language: route === 'text' ? 'JSON' : null, scroll: 0, bookmarks: [] };
}

describe('TabStore.open（001-AC-2 重复打开激活）', () => {
  it('首次打开新建标签并激活', () => {
    const s = new TabStore();
    expect(s.open(tab('a.txt'))).toBe('new');
    expect(s.tabs).toHaveLength(1);
    expect(s.activeIndex).toBe(0);
  });

  it('重复打开同一路径激活已有标签，不新增', () => {
    const s = new TabStore();
    s.open(tab('a.txt'));
    s.open(tab('b.txt'));
    expect(s.tabs).toHaveLength(2);
    expect(s.open(tab('a.txt'))).toBe('activated');
    expect(s.tabs).toHaveLength(2);
    expect(s.activeIndex).toBe(0);
  });
});

describe('TabStore.close', () => {
  it('关闭当前标签后激活末尾', () => {
    const s = new TabStore();
    s.open(tab('a')); s.open(tab('b')); s.open(tab('c'));
    s.close(2);
    expect(s.activeIndex).toBe(1);
  });

  it('关闭前面的标签修正活动索引', () => {
    const s = new TabStore();
    s.open(tab('a')); s.open(tab('b')); s.open(tab('c'));
    s.activate(2);
    s.close(0);
    expect(s.activeIndex).toBe(1);
    expect(s.tabs.map(t => t.path)).toEqual(['b', 'c']);
  });

  it('全部关闭后回到空状态', () => {
    const s = new TabStore();
    s.open(tab('a'));
    s.close(0);
    expect(s.tabs).toHaveLength(0);
    expect(s.active()).toBeNull();
  });
});

describe('会话序列化与恢复（001-AC-3）', () => {
  it('session → restore 往返一致', () => {
    const s1 = new TabStore();
    s1.open(tab('a')); s1.open({ ...tab('x.bin', 'image') });
    s1.activate(0);
    const snap: SessionState = s1.session();
    const s2 = new TabStore();
    expect(s2.restore(snap)).toBe(2);
    expect(s2.session()).toEqual(snap);
  });

  it('非法输入恢复 0 个且不抛错', () => {
    const s = new TabStore();
    expect(s.restore(null)).toBe(0);
    expect(s.restore({ tabs: 'x' } as unknown as SessionState)).toBe(0);
    expect(
      s.restore({ tabs: [{ path: 1, route: 'text' }] as unknown as TabState[], activeIndex: 0 })
    ).toBe(0);
  });

  it('F001-02：image 路由标签恢复不丢弃（规则 5 不挑路由）', () => {
    const s = new TabStore();
    const n = s.restore({
      tabs: [tab('a'), tab('b.log'), { ...tab('p.png'), route: 'image' }],
      activeIndex: 2,
    });
    expect(n).toBe(3);
    expect(s.tabs[2]).toMatchObject({ path: 'p.png', route: 'image' });
    expect(s.activeIndex).toBe(2);
    // 未知路由值一律按 text 收编（向前兼容：旧会话的路由值不致丢失标签）
    const s2 = new TabStore();
    expect(
      s2.restore({ tabs: [{ ...tab('z'), route: 'video' }] as unknown as TabState[], activeIndex: 0 })
    ).toBe(1);
    expect(s2.tabs[0]).toMatchObject({ path: 'z', route: 'text' });
  });

  it('变更触发持久化回调（防抖由外层负责，此处验证直调）', () => {
    const onSave = vi.fn();
    const s = new TabStore({ onSave });
    s.open(tab('a'));
    expect(onSave).toHaveBeenCalled();
  });
});

describe('P0-2/Z2-31 closeByPath：关闭守卫按 path 解索引（防对话框窗口索引漂移）', () => {
  it('按 path 关闭存在的标签并保持 active 语义', () => {
    const s = new TabStore();
    s.open(tab('a')); s.open(tab('b')); s.open(tab('c'));
    s.activate(1);
    expect(s.closeByPath('b')).toBe(true);
    expect(s.tabs.map(t => t.path)).toEqual(['a', 'c']);
    expect(s.activeIndex).toBe(1); // 关闭的是活动标签：继任者（c）占同槽——与 close() 既有语义一致
  });

  it('path 不存在返回 false 不动标签', () => {
    const s = new TabStore();
    s.open(tab('a'));
    expect(s.closeByPath('zz')).toBe(false);
    expect(s.tabs.length).toBe(1);
  });

  it('漂移场景：捕获期索引 vs 确认期按 path——按 path 关的是确认对象本身', () => {
    // 复现 Z2-31 形状：打开对话框时 b 的索引是 1；确认前 a 被移除使 b 漂到 0。
    // 旧实现 store.close(1) 会关掉 c；closeByPath('b') 关的是 b。
    const s = new TabStore();
    s.open(tab('a')); s.open(tab('b')); s.open(tab('c'));
    const staleIndex = 1;
    s.close(0); // 对话框打开期间其它标签先关
    s.close(staleIndex); // 旧实现：关掉的是 c（错）
    expect(s.tabs.map(t => t.path)).toEqual(['b']); // 旧实现留下 b——未确认者幸存、无辜者被关
    const s2 = new TabStore();
    s2.open(tab('a')); s2.open(tab('b')); s2.open(tab('c'));
    s2.close(0);
    s2.closeByPath('b');
    expect(s2.tabs.map(t => t.path)).toEqual(['c']); // 新实现：确认谁关谁
  });
});
