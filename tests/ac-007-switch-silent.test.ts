// 007 R5 v0.46：TabStore 行为 + shell 接线契约，关闭守卫不得回漂到切换链路。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TabStore } from '../src/common/state';
import { WYSIWYG_LIMIT } from '../src/common/mode';

const app = readFileSync(new URL('../src/shell/app.ts', import.meta.url), 'utf8');
const section = (start: string, end: string) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));

describe('AC-007 切换免打扰', () => {
  it('activate / open / setRoute 同步直通且原标签仍在', () => {
    const store = new TabStore();
    const tab = (path: string) => ({ path, route: 'text' as const, language: 'Markdown', scroll: 0, bookmarks: [] });
    expect(store.open(tab('/a.md'))).toBe('new');
    const original = store.active();
    expect(store.open(tab('/b.md'))).toBe('new');
    store.activate(0);
    expect(store.active()).toBe(original);
    expect(store.open(tab('/a.md'))).toBe('activated');
    store.setRoute('/a.md', 'image');
    expect(store.active()?.route).toBe('image');
    expect(store.tabs).toHaveLength(2);
  });

  it('五个挂口均无切换守卫，打开与草稿直接执行', () => {
    expect(app).not.toMatch(/gateLeaveWysiwyg|confirmWysiwygSwitch/);
    expect(app).not.toMatch(/store\.(open|activate|setRoute)\s*=/);
    expect(section('async function openPath(', 'async function openFileIntoTab(')).toContain('await openFileIntoTab(path, line, opts)');
    expect(section('function newDraft(', 'const draftContent')).toContain('store.open(');
    expect(section('function setMode(', 'const activeTab')).not.toMatch(/confirm|discard|save\(/);
  });

  it('切走先保留 EditorBuffer 与脏标并写快照，关闭仍查 dirtyPaths', () => {
    const mount = section('function maybeRenderView(', 'function restoreSwitchAnchor(');
    expect(mount).toContain('editorBuffers.set(path, { state: currentView.view.state, dirty, scrollTop, anchor })');
    expect(mount.indexOf('editorBuffers.set(')).toBeLessThan(mount.indexOf('destroyView()'));
    expect(mount).toContain('if (dirty) writeSnapshot(');
    const close = section('function closeTabGuarded(', 'async function saveTextAs(');
    expect(close).toContain('dirtyPaths.get(t0.path) === true');
    expect(close).toContain("mk($t('common.cancel')");
    expect(close).toContain('saveDirtyTab(t0!.path).then(ok =>');
    expect(app).toContain('const dirtyTabList = () => store.tabs.filter(t => dirtyPaths.get(t.path) === true)');
    expect(app).toContain('await saveDirtyTab(tab.path)');
    expect(section('async function saveDirtyTab(', 'async function mountView(')).toContain('if (editorBuffers.has(path)) return saveBufferedTab(path)');
    expect(section('async function saveBufferedTab(', 'function noteSaved(')).toContain('state.sliceDoc()');
  });

  it('IR 菜单使用 4MiB 闸，未知体量乐观放行（与分屏/modeOf/挂载守卫同源），9MiB 禁入', () => {
    expect(WYSIWYG_LIMIT).toBe(4 * 1024 * 1024);
    expect(9 * 1024 * 1024 <= WYSIWYG_LIMIT).toBe(false);
    // 批1c：体量判决收口 mode.ts（menuWysiwygEligible）。未知 size 按 0 乐观放行——修 v53
    // 会话恢复异步窗口内 IR 菜单项被禁用（旧 ?? Infinity 与分屏 ?? 0 不对称，且与 modeOf、
    // IR 挂载守卫、disabled 原因键三处 ?? 0 口径不一）。超限由挂载守卫（textOpen 复核 +
    // WYSIWYG_LIMIT）权威拦截；真实文件默认形态恒为渲染预览（preview 阶梯），IR 从不是默认，
    // 故乐观放行只影响手动切换、不改默认。未知体量乐观口径的纯函数回归锁在 mode.test.ts。
    expect(section('const wysiwygEligible', 'const mdSplitEligible')).toContain('menuWysiwygEligible(tab.language, fileSizes.get(tab.path))');
    expect(section('function mdModeMenuItems(', '\n  function ')).toContain('wysiwygEligible(tab)');
    expect(app).toContain('enabled: () => isMdActive() && wysiwygEligible(activeTab()!)');
  });

  it('打开与恢复真实 Markdown 均等待非递归目录授权后渲染', () => {
    expect(section('async function openFileIntoTab(', '// ---- 目录跟随')).toContain('await zassetAllow(dirOf(info.path))');
    expect(section('function ensureFileMeta(', '// ---- 草稿标签')).toContain('await zassetAllow(dirOf(info.path))');
    expect(section('function ensureFileMeta(', '// ---- 草稿标签')).toContain('if (activeTab()?.path === path) render()');
  });
});
