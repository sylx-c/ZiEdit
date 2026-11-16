// @vitest-environment jsdom
// 最近列表右键菜单（2026-11-16 用户需求）：右键最近条目可移除该记录/清空全部。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarCtl, type SidebarOpts } from '../src/shell/sidebar';

const stubOpts = (over: Partial<SidebarOpts> = {}): SidebarOpts => ({
  outlineAvailable: () => false,
  renderOutline: () => {},
  onOpenPath: () => {},
  onHide: () => {},
  onRemoveRecents: () => {},
  onClearRecents: () => {},
  onToggleFavorite: () => {},
  onFavoriteCurrent: () => {},
  onAddGroup: () => {},
  onRemoveGroup: () => {},
  onMoveFavorite: () => {},
  showMenu: () => {},
  promptText: async () => null,
  ...over,
});

describe('最近列表右键清理', () => {
  it('右键最近条目弹出「移除该记录 / 清空」菜单，动作接 onRemoveRecents/onClearRecents', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onRemoveRecents = vi.fn();
    const onClearRecents = vi.fn();
    const showMenu = vi.fn();
    const sb = new SidebarCtl(host, stubOpts({ onRemoveRecents, onClearRecents, showMenu }));
    sb.setRecentData([{ path: 'C:\\docs\\a.md', isDir: false }]);
    sb.show('recent');
    const row = [...host.querySelectorAll('.rc-row')].find(r => r.textContent?.includes('a.md')) as HTMLElement;
    expect(row).toBeTruthy();
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    row.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(showMenu).toHaveBeenCalledTimes(1);
    const items = showMenu.mock.calls[0]![0] as Array<[string, () => void]>;
    expect(items.map(i => i[0])).toEqual(['移除该记录', '清空']);
    items[0]![1]();
    expect(onRemoveRecents).toHaveBeenCalledWith(['C:\\docs\\a.md']);
    items[1]![1]();
    expect(onClearRecents).toHaveBeenCalled();
    host.remove();
  });
});

afterEach(() => { document.body.innerHTML = ''; });
