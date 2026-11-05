// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { setLang, t } from '../src/common/i18n';
import { ActionRegistry, type OverlayMask } from '../src/shell/chrome';
import { openShortcuts, openUserGuide, shortcutKeys } from '../src/shell/help';

const masks: OverlayMask[] = [];
afterEach(() => {
  for (const mask of masks.splice(0).reverse()) mask.close();
  document.body.replaceChildren();
  setLang('zh-CN');
});
function registry() {
  const reg = new ActionRegistry();
  reg.add({ id: 'save', label: 'act.save', group: 'file', shortcut: 'Ctrl+S', run() {} });
  reg.add({ id: 'find', label: 'act.find', group: 'find', shortcut: 'Ctrl+F', run() {} });
  reg.add({ id: 'no-key', label: 'No shortcut', group: 'view', run() {} });
  return reg;
}

describe('帮助中心查阅交互', () => {
  it('搜索实际命令和键位，可清空无结果状态；分类与搜索同时生效', () => {
    setLang('zh-CN');
    const mask = openShortcuts(registry()); masks.push(mask);
    const input = mask.querySelector<HTMLInputElement>('input[type=search]')!;
    const search = (value: string) => { input.value = value; input.dispatchEvent(new Event('input')); };
    expect(mask.querySelectorAll('tbody tr')).toHaveLength(2);
    search('ctrl+s');
    expect(mask.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(mask.querySelector('tbody tr')?.textContent).toContain(t('act.save'));
    mask.querySelectorAll<HTMLButtonElement>('.help-filter')[2]!.click();
    expect(mask.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(mask.querySelector('.help-empty')?.textContent).toBe(t('help.noResults'));
    mask.querySelector<HTMLButtonElement>('.help-search-clear')!.click();
    expect(input.value).toBe('');
    expect(mask.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(mask.querySelector('tbody tr')?.textContent).toContain(t('act.find'));
    expect(document.activeElement).toBe(input);
    expect(mask.querySelector('.help-search-clear')?.hasAttribute('hidden')).toBe(true);
  });

  it('键帽保留+键和方向键的原快捷键语义', () => {
    expect(shortcutKeys('Ctrl++')).toEqual(['Ctrl', '+']);
    expect(shortcutKeys('Ctrl+Shift+P')).toEqual(['Ctrl', 'Shift', 'P']);
    expect(shortcutKeys('Alt+ArrowLeft')).toEqual(['Alt', '←']);
  });

  it('说明的12章可用鼠标和键盘查阅，中英文显示完整文案', () => {
    for (const lang of ['zh-CN', 'en-US'] as const) {
      setLang(lang);
      const mask = openUserGuide(); masks.push(mask);
      const chapters = [...mask.querySelectorAll<HTMLButtonElement>('.guide-chapter')];
      expect(chapters).toHaveLength(12);
      for (const chapter of chapters) {
        chapter.click();
        expect(chapter.getAttribute('aria-current')).toBe('true');
        expect(mask.querySelector('.guide-title')?.textContent).toBe(t(`help.h.${chapter.dataset.chapter}`));
        expect(mask.querySelectorAll('.guide-paragraph').length).toBeGreaterThanOrEqual(2);
        expect(mask.textContent).not.toMatch(/help\.[hb]\./);
      }
      chapters[0]!.focus();
      chapters[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      expect(document.activeElement).toBe(chapters.at(-1));
      expect(chapters.at(-1)!.hasAttribute('aria-current')).toBe(true);
      mask.close();
    }
  });

  it('Esc关闭后恢复原焦点，不触发背景动作', async () => {
    const original = document.createElement('button'); document.body.append(original); original.focus();
    const mask = openShortcuts(registry()); masks.push(mask);
    await new Promise(resolve => setTimeout(resolve, 1));
    const input = mask.querySelector<HTMLInputElement>('input')!;
    expect(document.activeElement).toBe(input);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(mask.isConnected).toBe(false);
    expect(document.activeElement).toBe(original);
    expect(original.hasAttribute('inert')).toBe(false);
  });
});
