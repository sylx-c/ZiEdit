import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TabStore } from '../src/common/state';

const app = readFileSync(new URL('../src/shell/app.ts', import.meta.url), 'utf8');

describe('草稿会话持久化', () => {
  it.each(['正文\n第二行 中文', ''])('保存并恢复草稿正文 %j', content => {
    const source = new TabStore();
    source.open({ path: 'draft://1', route: 'text', language: null, scroll: 0, draftContent: content });
    const restored = new TabStore();
    expect(restored.restore(JSON.parse(JSON.stringify(source.session())))).toBe(1);
    expect(restored.active()?.draftContent).toBe(content);
    expect(typeof restored.active()?.draftContent === 'string').toBe(true);
  });

  it('旧会话兼容，真实文件不恢复内嵌正文', () => {
    const restored = new TabStore();
    restored.restore({ tabs: [
      { path: 'draft://1', route: 'text', language: null, scroll: 0 },
      { path: 'C:\\file.txt', route: 'text', language: null, scroll: 0, draftContent: 'not a draft' },
    ], activeIndex: 0 });
    expect(restored.tabs.every(tab => tab.draftContent === undefined)).toBe(true);
  });

  it('恢复接入正文与脏标，定期保存、命名会话和退出捕获最新正文', () => {
    expect(app).toContain('draftContent.set(t.path, t.draftContent)');
    expect(app).toContain('dirtyPaths.set(t.path, true)');
    expect(app).toContain("startDirty: !!recovered || (tab.path.startsWith('draft://') && typeof tab.draftContent === 'string')");
    expect(app).toContain('saveSession(captureDrafts(s))');
    expect(app).toContain('[name]: captureDrafts(store.session())');
    expect(app).toContain('const session = captureDrafts(store.session())');
    expect(app).toContain('void saveSession(session).then(() => getCurrentWindow().destroy())');
  });

  it('设置保存刷新工具栏，不可见字符切换接入编辑面而非 IR', () => {
    expect(app).toMatch(/if \(lang !== getLang\(\)\) switchLanguage\(lang\);\s+toolbarCtl\?\.refresh\(\)/);
    const invisible = app.slice(app.indexOf("id: 'view.invisible', label:"), app.indexOf("id: 'view.wrap', label:"));
    expect(invisible).toContain('currentView instanceof EditView) currentView.setInvisibleVisible(settings.showInvisible === true)');
    expect(invisible).not.toContain('LivePreviewView');
  });
});
