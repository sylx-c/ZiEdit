// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionRegistry, openPalette, openThemeDialog } from '../src/shell/chrome';

const css = readFileSync('src/styles.css', 'utf8');
const rule = (selector: string): string => css.match(new RegExp('(?:^|\\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]+)\\}'))?.[1] ?? '';

describe('工作台美术细节 · 保留原布局与四主题', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('美术细节不改变工具栏、侧栏、标签、状态栏和标尺几何', () => {
    expect(rule('.toolbar')).toContain('height:32px');
    expect(rule('.sidebar')).toContain('width:232px');
    expect(rule('.panel-head')).toContain('height:27px');
    expect(rule('.panel-seg')).toContain('height:19px');
    expect(rule('.st-cell')).toContain('height:19px');
    expect(rule('.st-cell')).toContain('border:1px solid var(--border)');
    expect(rule('.tab.active')).toContain('inset 0 2px 0 var(--tab-line)');
    // 2026-11 配色反馈：标签活动线不再用全局强调蓝，改为各主题中性墨线（四主题各定义 --tab-line）
    for (const th of ['paper', 'cool', 'graphite', 'black']) {
      expect(css).toMatch(new RegExp(`\\.th-${th}\\{[^}]*--tab-line:oklch\\(`));
    }
    expect(rule('.ruler')).toContain('height:19px');
    expect(rule('.editor-rail')).toContain('margin-top:-19px');
    expect(rule('.editor-rail')).toContain('height:calc(100% + 19px)');
    expect(rule('.mm-viewport')).toContain('top:29px');
  });

  it('四主题卡为 radio 组，方向键同步选中、焦点和主题回调', () => {
    let picked = '';
    openThemeDialog('paper', key => { picked = key; });
    const grid = document.querySelector('.theme-grid')!;
    const cards = [...document.querySelectorAll<HTMLElement>('.theme-card')];
    expect(grid.getAttribute('role')).toBe('radiogroup');
    expect(cards).toHaveLength(4);
    expect(cards.map(c => c.getAttribute('role'))).toEqual(Array(4).fill('radio'));
    expect(cards.map(c => c.tabIndex)).toEqual([0, -1, -1, -1]);
    cards[0].focus();
    cards[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(picked).toBe('cool');
    expect(cards[1].getAttribute('aria-checked')).toBe('true');
    expect(cards[1].tabIndex).toBe(0);
    expect(document.activeElement).toBe(cards[1]);
    cards[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(picked).toBe('black');
    expect(cards[3].getAttribute('aria-checked')).toBe('true');
    cards[2].focus();
    cards[2].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(picked).toBe('graphite');
    expect(cards[2].getAttribute('aria-checked')).toBe('true');
  });

  it('命令面板具有组合框关联，Esc 关闭后返回原焦点', () => {
    const entry = document.createElement('button');
    entry.id = 'palette-entry';
    document.body.appendChild(entry);
    entry.focus();
    const reg = new ActionRegistry();
    reg.add({ id: 'view.theme', label: 'theme.title', run: () => undefined });
    openPalette(reg);
    const input = document.querySelector<HTMLInputElement>('.cmd-input')!;
    const list = document.querySelector('.cmd-list')!;
    const option = document.querySelector('.cmd-item')!;
    expect(document.querySelector('.cmd-palette')?.getAttribute('role')).toBe('dialog');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(list.getAttribute('role')).toBe('listbox');
    expect(option.getAttribute('role')).toBe('option');
    expect(option.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(option.id);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.cmd-overlay')).toBeNull();
    expect(document.activeElement).toBe(entry);
  });
});
