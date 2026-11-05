// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { shell, startShell, settle } from './shell-behavior-harness';
import { t, tf, setLang } from '../src/common/i18n';

describe('草稿格式与标签编辑锁', () => {
  it('Markdown 草稿切换即时渲染，并按 md 扩展名另存', async () => {
    await startShell();
    shell.actions.run('file.newDraft');
    await settle();
    await vi.waitFor(() => expect(shell.edit).not.toBeNull(), { timeout: 10000 });
    const path = shell.store.active().path;
    shell.actions.run('view.tabLock');
    expect(shell.tabLock.has(path)).toBe(true);
    expect(shell.edit.setReadOnly).toHaveBeenCalledWith(true);
    expect(shell.actions.availability('file.save')).toEqual({ enabled: false, reasonKey: 'action.readOnly' });
    expect(shell.actions.run('file.save')).toBe(false);
    expect(shell.actions.run('edit.paste')).toBe(false);
    shell.setSettings({ ...shell.getSettings(), readOnlyMode: true });
    expect(shell.actions.get('view.tabEdit').enabled()).toBe(false);
    expect(shell.actions.get('view.tabLock').enabled()).toBe(false);
    shell.setSettings({ ...shell.getSettings(), readOnlyMode: false });
    shell.actions.run('view.tabEdit');
    expect(shell.tabLock.has(path)).toBe(false);

    const lang = [...document.querySelectorAll<HTMLElement>('.st-cell')].find(el => el.title === t('st.tip.lang'))!;
    lang.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    [...document.querySelectorAll<HTMLElement>('.ctx-menu div')].find(el => el.textContent?.includes('Markdown'))!.click();
    await settle();
    expect(shell.store.active()!.language).toBe('Markdown');
    expect(shell.getMode()).toBe('wysiwyg');

    shell.saveDialog.mockReset();
    shell.saveDialog.mockResolvedValueOnce(null);
    await shell.edit.save(); // Ctrl+S 路径（EditView → onSaveAsNeeded → saveDraftAs）
    await settle();
    expect(shell.saveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: expect.stringContaining(`${tf('draft.saveName', path.slice(8))}.md`) }));

    shell.saveDialog.mockReset();
    shell.saveDialog.mockResolvedValueOnce(null);
    await vi.waitFor(() => expect(shell.actions.isEnabled('file.saveAs')).toBe(true), { timeout: 10000 });
    await shell.actions.run('file.saveAs'); // Ctrl+Shift+S 路径（草稿与 Ctrl+S 同一收口）
    await settle();
    expect(shell.actions.get('file.saveAs').enabled()).toBe(true);
    expect(shell.saveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: expect.stringContaining(`${tf('draft.saveName', path.slice(8))}.md`) }));
  }, 15000);

  it('渲染预览形态点「编辑」切回源码视图', async () => {
    await startShell();
    shell.actions.run('file.newDraft');
    await settle();
    const lang = [...document.querySelectorAll<HTMLElement>('.st-cell')].find(el => el.title === t('st.tip.lang'))!;
    lang.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    [...document.querySelectorAll<HTMLElement>('.ctx-menu div')].find(el => el.textContent?.includes('Markdown'))!.click();
    await settle();
    shell.actions.run('view.mdPreview');
    await settle();
    expect(shell.getMode()).toBe('md');
    shell.actions.run('view.tabEdit');
    await settle();
    expect(shell.getMode()).toBe('edit');
  });

  it('编辑|只读 段随 Markdown 形态走：渲染预览=只读亮，点编辑切源码，点只读回渲染预览', async () => {
    await startShell();
    shell.actions.run('file.newDraft');
    await settle();
    const lang = [...document.querySelectorAll<HTMLElement>('.st-cell')].find(el => el.title === t('st.tip.lang'))!;
    lang.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    [...document.querySelectorAll<HTMLElement>('.ctx-menu div')].find(el => el.textContent?.includes('Markdown'))!.click();
    await settle();
    // 即时渲染（出厂默认形态）= 编辑亮
    expect(shell.getMode()).toBe('wysiwyg');
    expect(shell.actions.get('view.tabEdit').checked!()).toBe(true);
    expect(shell.actions.get('view.tabLock').checked!()).toBe(false);
    // 切渲染预览 → 只读亮（隐藏源承载 EditView 不得点亮「编辑」）
    shell.actions.run('view.mdPreview');
    await settle();
    expect(shell.getMode()).toBe('md');
    expect(shell.actions.get('view.tabEdit').checked!()).toBe(false);
    expect(shell.actions.get('view.tabLock').checked!()).toBe(true);
    // 点「编辑」→ 源码视图，编辑亮
    shell.actions.run('view.tabEdit');
    await settle();
    expect(shell.getMode()).toBe('edit');
    expect(shell.actions.get('view.tabEdit').checked!()).toBe(true);
    expect(shell.actions.get('view.tabLock').checked!()).toBe(false);
    // 点「只读」→ 切回渲染预览（不再原地加锁不动）
    shell.actions.run('view.tabLock');
    await settle();
    expect(shell.getMode()).toBe('md');
    expect(shell.actions.get('view.tabLock').checked!()).toBe(true);
  });

  it('纯文本（非 Markdown）点「只读」仍为会话级锁，不切形态', async () => {
    await startShell();
    shell.actions.run('file.newDraft');
    await settle();
    expect(shell.actions.get('view.tabEdit').checked!()).toBe(true);
    shell.actions.run('view.tabLock');
    await settle();
    expect(shell.tabLock.has(shell.store.active()!.path)).toBe(true);
    expect(shell.getMode()).toBe('edit'); // 形态不变，锁编辑
    expect(shell.actions.get('view.tabLock').checked!()).toBe(true);
    shell.actions.run('view.tabEdit');
    await settle();
    expect(shell.tabLock.has(shell.store.active()!.path)).toBe(false);
    expect(shell.actions.get('view.tabEdit').checked!()).toBe(true);
  });

  it('纯文本草稿另存为默认「文本N.txt」（序号与标签同号）', async () => {
    await startShell();
    shell.actions.run('file.newDraft');
    await settle();
    const no = shell.store.active()!.path.slice(8);
    expect(shell.edit).not.toBeNull();
    shell.saveDialog.mockReset();
    shell.saveDialog.mockResolvedValueOnce(null);
    await shell.actions.run('file.saveAs');
    await settle();
    expect(shell.saveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: `${tf('draft.saveName', no)}.txt` }));
  });

  it('草稿另存默认名随界面语言：中文「文本N.txt」/英文「TextN.txt」', async () => {
    await startShell();
    shell.actions.run('file.newDraft');
    await settle();
    const no = shell.store.active()!.path.slice(8);
    setLang('en-US');
    shell.saveDialog.mockReset();
    shell.saveDialog.mockResolvedValueOnce(null);
    await shell.actions.run('file.saveAs');
    await settle();
    expect(shell.saveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: `Text${no}.txt` }));
    setLang('zh-CN');
    shell.actions.run('file.newDraft');
    await settle();
    const no2 = shell.store.active()!.path.slice(8);
    shell.saveDialog.mockReset();
    shell.saveDialog.mockResolvedValueOnce(null);
    await shell.actions.run('file.saveAs');
    await settle();
    expect(shell.saveDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: `文本${no2}.txt` }));
  });
});
