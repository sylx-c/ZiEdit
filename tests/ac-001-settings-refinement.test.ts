// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLang, t } from '../src/common/i18n';
import { DEFAULT_SETTINGS, type Settings } from '../src/common/ipc';
import { openSettingsDialog } from '../src/shell/settings';
import type { OverlayMask } from '../src/shell/chrome';

const masks: OverlayMask[] = [];
afterEach(() => {
  for (const mask of masks.splice(0).reverse()) mask.close();
  document.body.replaceChildren(); setLang('zh-CN');
});
function fixture(initial: Settings = {}) {
  let current: Settings = { ...DEFAULT_SETTINGS, ...initial };
  const save = vi.fn((next: Settings) => { current = next; });
  const switchLanguage = vi.fn();
  const clearRemembered = vi.fn(() => { current = { ...current, rememberedCloseAction: undefined }; });
  const browseSnapshot = vi.fn<(path?: string) => Promise<string | null>>().mockResolvedValue(null);
  const mask = openSettingsDialog({ getSettings: () => current, save, switchLanguage, clearRemembered, browseSnapshot });
  masks.push(mask);
  const input = (name: string) => mask.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const select = (name: string) => mask.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
  const button = (key: string) => [...mask.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === t(key))!;
  return { mask, input, select, button, save, switchLanguage, clearRemembered, browseSnapshot, current: () => current };
}
function change(el: HTMLInputElement | HTMLSelectElement, value: string | boolean) {
  if (typeof value === 'boolean') (el as HTMLInputElement).checked = value;
  else el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('设置结构与状态', () => {
  it.each(['zh-CN', 'en-US'] as const)('所有字段与分组均有可访问标签，操作栏不随正文滚动（%s）', lang => {
    setLang(lang);
    const f = fixture();
    expect(f.mask.querySelectorAll('fieldset')).toHaveLength(7);
    for (const control of f.mask.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) {
      expect(control.getAttribute('aria-label') || control.labels?.[0]?.textContent).toBeTruthy();
    }
    expect(f.mask.textContent).not.toMatch(/set\.(intro|hint\w+)/);
    expect(f.mask.querySelector('.settings-scroll .settings-footer')).toBeNull();
    const submit = f.mask.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(submit.form).toBe(f.mask.querySelector('form'));
    expect([...f.select('theme').options].map(o => o.value)).toEqual(['paper', 'cool', 'graphite', 'black']);
    expect(f.mask.querySelector('[role=region]')?.getAttribute('tabindex')).toBe('0');
  });

  it('编辑暂存，取消不保存；保存限制数值并保留无关设置', () => {
    const cancel = fixture({ imageHostEnabled: true, s3Region: 'existing' });
    change(cancel.select('theme'), 'black');
    expect(cancel.save).not.toHaveBeenCalled();
    cancel.button('common.cancel').click();
    expect(cancel.mask.isConnected).toBe(false);
    expect(cancel.save).not.toHaveBeenCalled();
    const f = fixture({ imageHostEnabled: true, s3Region: 'existing' });
    change(f.select('theme'), 'graphite');
    change(f.input('readOnlyMode'), true);
    change(f.input('fontSize'), '99');
    change(f.input('autoSaveSec'), '-5');
    change(f.input('backupKeep'), '27');
    change(f.input('columnMarkers'), '80,bad,-1,120,1,2,3,4,5,6,7,8,9,10,11');
    change(f.select('autoSaveTarget'), 'file');
    change(f.select('mdDefaultMode'), 'preview');
    f.button('ed.save').click();
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.current()).toMatchObject({ theme: 'graphite', readOnlyMode: true, fontSize: 18,
      autoSaveSec: 0, backupKeep: 10, autoSaveTarget: 'file', mdDefaultMode: 'preview', imageHostEnabled: true, s3Region: 'existing' });
    expect(f.current().columnMarkers).toEqual([80, 120, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(f.mask.isConnected).toBe(false);
  });

  it('颜色和备份开关初始禁用正确，重置颜色同步禁用并保存主题回退', () => {
    const f = fixture({ diffColors: { add: '#123456' }, backupEnabled: false });
    expect(f.input('diff-add').disabled).toBe(false);
    expect(f.input('diff-del').disabled).toBe(true);
    expect(f.input('lineHl').disabled).toBe(true);
    expect(f.input('outlineCur').disabled).toBe(true);
    expect(f.input('backupKeep').disabled).toBe(true);
    change(f.input('backupEnabled'), true);
    expect(f.input('backupKeep').disabled).toBe(false);
    change(f.input('lineHlEnabled'), true);
    change(f.input('lineHl'), '#654321');
    expect(f.input('lineHl').disabled).toBe(false);
    f.button('set.diffReset').click();
    for (const key of ['add', 'del', 'chg']) {
      expect(f.input(`diff-${key}`).disabled).toBe(true);
      expect(f.input(`diff-${key}Enabled`).checked).toBe(false);
    }
    f.button('ed.save').click();
    expect(f.current().diffColors).toBeUndefined();
    expect(f.current().lineHl).toBe('#654321');
  });

  it('目录选择只暂存，取消选择保留路径，恢复默认与关闭后迟到结果安全', async () => {
    const f = fixture({ snapshotDir: '/old' });
    f.browseSnapshot.mockResolvedValueOnce('/chosen');
    f.button('set.snapDirBrowse').click();
    await vi.waitFor(() => expect(f.mask.querySelector('output')?.textContent).toBe('/chosen'));
    expect(f.browseSnapshot).toHaveBeenCalledWith('/old');
    expect(f.save).not.toHaveBeenCalled();
    f.button('set.snapDirBrowse').click();
    await vi.waitFor(() => expect(f.button('set.snapDirBrowse').disabled).toBe(false));
    expect(f.mask.querySelector('output')?.textContent).toBe('/chosen');
    f.button('set.snapDirDefault').click();
    f.button('ed.save').click();
    expect(f.current().snapshotDir).toBeUndefined();
    const late = fixture({ snapshotDir: '/old' });
    let resolve!: (value: string) => void;
    late.browseSnapshot.mockReturnValue(new Promise(done => { resolve = done; }));
    late.button('set.snapDirBrowse').click();
    late.mask.close(); resolve('/late');
    await Promise.resolve();
    expect(late.mask.querySelector('output')?.textContent).toBe('/old');
    expect(late.save).not.toHaveBeenCalled();
  });

  it('语言与关闭记忆立即生效，关闭行为仍需保存', () => {
    const f = fixture({ rememberedCloseAction: 'tray' });
    const clear = f.button('set.clearRemembered');
    expect(clear.hidden).toBe(false);
    change(f.select('closeBehavior'), 'exit');
    expect(clear.hidden).toBe(true);
    change(f.select('closeBehavior'), 'ask');
    expect(clear.hidden).toBe(false);
    clear.click();
    expect(f.clearRemembered).toHaveBeenCalledOnce();
    expect(clear.hidden).toBe(true);
    expect(f.save).not.toHaveBeenCalled();
    change(f.select('language'), 'en-US');
    expect(f.switchLanguage).toHaveBeenCalledWith('en-US');
    expect(f.save).not.toHaveBeenCalled();
    f.button('ed.save').click();
    expect(f.current().rememberedCloseAction).toBeUndefined();
  });

  it('Escape取消暂存并恢复原焦点', async () => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    const f = fixture();
    await new Promise(done => setTimeout(done, 1));
    f.input('fontSize').focus();
    f.input('fontSize').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(f.mask.isConnected).toBe(false);
    expect(f.save).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });
});
