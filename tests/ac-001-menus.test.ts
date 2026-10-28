// 001-AC-14 菜单结构（六个菜单）+ 2026-10-14 整改收敛断言：
// 远程全链路删除、Markdown ▸ / 最近打开 ▸ 子菜单、行批处理不在编辑菜单、全屏改为窗口最大化（无菜单项）、
// 换行转换另存单入口、侦察图移除、字号组、帮助 = 关于 + 使用说明 + 快捷键参考。
import { describe, expect, it } from 'vitest';
import { buildMenus } from '../src/shell/app';
import type { MenuEntry } from '../src/shell/chrome';

const menus = buildMenus(
  () => ['排障', 'ZiEdit 开发'],
  () => [
    { path: 'C:\\a\\b.md', isDir: false },
    { path: 'C:\\a\\c.txt', isDir: false },
  ]
);

const labels = () => menus.map(m => m.label);
const entriesOf = (label: string) => menus.find(m => m.label === label)!.entries();

/** 递归展开全部 action id（含子菜单） */
function allActions(entries: MenuEntry[]): string[] {
  const out: string[] = [];
  for (const en of entries) {
    if (en.action) out.push(en.action);
    if (en.children) out.push(...allActions(en.children()));
  }
  return out;
}

describe('001-AC-14 菜单结构', () => {
  it('恰好六个菜单', () => {
    expect(labels()).toEqual(['menu.fileF', 'menu.editF', 'menu.searchF', 'menu.viewF', 'menu.toolsF', 'menu.helpF']);
  });

  it('全菜单（含子菜单）无远程残留（004 移除）', () => {
    for (const m of menus) {
      for (const id of allActions(m.entries())) {
        expect(id.toLowerCase()).not.toContain('remote');
      }
    }
  });

  it('文件菜单：最近打开 ▸ 动态子菜单（≤10）+ 重新加载 + 会话子菜单（含动态项）+ 转换另存收拢', () => {
    const es = entriesOf('menu.fileF');
    const recent = es.find(e => e.label === 'menu.recent');
    expect(recent?.children).toBeTruthy();
    expect(recent!.children!().map(c => c.action)).toEqual([
      'file.recent:C:\\a\\b.md',
      'file.recent:C:\\a\\c.txt',
    ]);
    expect(allActions(es)).toContain('file.reload');
    // 命名会话收进「会话 ▸」：不再随数量平铺文件菜单
    const sessions = es.find(e => e.label === 'menu.sessions');
    expect(sessions?.children).toBeTruthy();
    expect(allActions(es)).toContain('file.session:排障');
    expect(allActions(es)).toContain('file.session:ZiEdit 开发');
    // 转换类另存（规范化/编码/换行）收进「转换另存 ▸」子菜单
    const convert = es.find(e => e.label === 'menu.convertSave');
    expect(convert!.children!().map(c => c.action)).toEqual(['edit.normalize', 'edit.encSave', 'edit.nlSave']);
  });

  it('编辑菜单：只留文本修改与编辑开关；换行/编码/规范化另存已移入文件「转换另存 ▸」（全菜单恰一个入口）', () => {
    const ids = allActions(entriesOf('menu.editF'));
    expect(ids.filter(id => id.startsWith('edit.nlSave'))).toEqual([]);
    expect(ids.filter(id => id.startsWith('edit.encSave'))).toEqual([]);
    expect(ids.filter(id => id.startsWith('edit.normalize'))).toEqual([]);
    expect(ids).toContain('view.readOnly'); // 全局只读=编辑开关，归编辑
    expect(ids.filter(id => id.startsWith('edit.lineBatch'))).toEqual([]);
    expect(entriesOf('menu.editF').some(e => e.label === 'menu.lineBatch')).toBe(false);
    const every = menus.flatMap(m => allActions(m.entries()));
    expect(every.filter(id => id.startsWith('edit.nlSave'))).toEqual(['edit.nlSave']);
  });

  it('视图菜单：Markdown ▸ 四项有序；外观 ▸ 统一主题/文字大小/字体（字号组不再平铺顶层）；尾随台移至工具', () => {
    const es = entriesOf('menu.viewF');
    const md = es.find(e => e.label === 'menu.markdown');
    expect(md?.children!().map(c => c.action)).toEqual([
      'view.mdSource',
      'view.mdSplit',
      'view.mdPreview',
      'view.mdWysiwyg',
    ]);
    const ids = allActions(es);
    expect(ids).not.toContain('view.recon');
    expect(ids).not.toContain('view.fullscreen');
    expect(ids).not.toContain('view.editToggle');
    // 外观 ▸ 收口（2026-10 菜单梳理）：主题/字号/字体同层归置，字号组嵌套其内
    const appearance = es.find(e => e.label === 'menu.appearance');
    expect(appearance?.children).toBeTruthy();
    const zoom = appearance!.children!().find(e => e.label === 'menu.zoomGroup');
    expect(zoom?.children).toBeTruthy();
    expect(zoom!.children!().map(c => c.action)).toEqual(['view.zoomIn', 'view.zoomOut', 'view.zoomReset']);
    const fonts = appearance!.children!().find(e => e.label === 'menu.fontGroup');
    expect(fonts!.children!().map(c => c.action)).toEqual(['tools.importFont', 'tools.fontReset']);
    expect(es.some(e => e.action === 'view.zoomIn')).toBe(false);
    expect(es.some(e => e.action === 'view.zoomOut')).toBe(false);
    expect(es.some(e => e.action === 'view.zoomReset')).toBe(false);
    expect(ids).not.toContain('view.tailboard'); // 尾随台开独立标签，属工具
  });

  it('工具菜单：面板 + 独立工作流（比较/尾随/图床/备份）+ 设置置底', () => {
    const ids = allActions(entriesOf('menu.toolsF'));
    expect(ids[0]).toBe('tools.palette');
    expect(ids).toContain('file.compare');
    expect(ids).toContain('view.tailboard');
    expect(ids).toContain('tools.imageHost');
    expect(ids).toContain('tools.openBackup');
    expect(ids).toEqual([...ids.slice(0, -1), 'tools.settings']);
    expect(ids.filter(id => id.startsWith('tools.importFont'))).toEqual([]); // 字体已归视图「外观 ▸」
  });

  it('帮助菜单 = 使用说明 + 快捷键参考 + 关于（关于在最后）', () => {
    expect(allActions(entriesOf('menu.helpF'))).toEqual(['help.manual', 'help.shortcuts', 'help.about']);
  });
});
