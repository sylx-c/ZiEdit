// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ICONS } from '../src/shell/chrome';

describe('视觉打磨 S1/S2/S3', () => {
  it('粗体和删除线有独立字形，且仅含直角笔画', () => {
    for (const name of ['bold', 'strike'] as const) {
      expect(ICONS[name]).not.toBe(ICONS.table);
      expect(ICONS[name]).not.toBe(ICONS.italic);
      const paths = [...ICONS[name].matchAll(/d="([^"]+)"/g)].map(m => m[1]);
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) expect(path.replace(/[MHVZmhvz\d .,-]/g, '')).toBe('');
    }
    expect(ICONS.bold).toContain('class="solid"');
    expect(ICONS.strike).toContain('M2 8h12');
  });

  it('CSV/xlsx 共用表头类保留字重并使用主题背景与底边线', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    const rule = css.match(/\.csv-header\{([^}]+)\}/)?.[1];
    expect(rule).toContain('font-weight:600');
    expect(rule).toContain('background:var(--surface-2)');
    expect(rule).toContain('border-bottom:2px solid var(--border-strong)');
    expect(readFileSync('src/csv-view/table.ts', 'utf8')).toContain("headerRow.className = 'csv-header'");
  });

  it('图片态隐藏标尺，切回文本恢复且不改全局偏好', () => {
    // 执行实际 shell 闭包，隔离 app 启动 IPC；用真实 DOM 检查显隐。
    const app = readFileSync('src/shell/app.ts', 'utf8');
    const body = app.match(/function applyRulerVisible\(\): void \{([\s\S]*?)\n  \}/)![1];
    const apply = new Function('activeTab', 'modeOf', 'settings', body);
    const ruler = document.createElement('div');
    ruler.className = 'ruler';
    document.body.appendChild(ruler);
    const settings = { showRuler: true };
    let tab = { route: 'image' };
    const update = (mode = 'view') => apply(() => tab, () => mode, settings);
    update();
    expect(ruler.style.display).toBe('none');
    tab = { route: 'text' };
    update();
    expect(ruler.style.display).toBe('');
    update('md');
    expect(ruler.style.display).toBe('none');
    settings.showRuler = false;
    update();
    expect(ruler.style.display).toBe('none');
    ruler.remove();
  });
});
