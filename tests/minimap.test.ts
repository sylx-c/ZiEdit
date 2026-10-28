// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Minimap } from '../src/text-view/minimap';

describe('minimap 极短文档', () => {
  it('≤3 行不绘制密度条，行数增长后恢复，缩短后清除旧条目', () => {
    let total = 1;
    const lineText = vi.fn(() => 'plain text');
    const requestLines = vi.fn();
    const parent = document.createElement('div');
    const minimap = new Minimap(parent, {
      totalLines: () => total,
      scrollTop: () => 0,
      scrollHeight: () => 600,
      clientHeight: () => 600,
      scrollTo: () => {},
      lineText,
      requestLines,
      cacheVersion: () => 0,
    });
    Object.defineProperty(minimap.root, 'clientHeight', { value: 600 });
    try {
      for (total of [0, 1, 2, 3]) {
        minimap.sync();
        expect(parent.querySelectorAll('.mm-bar')).toHaveLength(0);
      }
      expect(lineText).not.toHaveBeenCalled();
      expect(requestLines).not.toHaveBeenCalled();

      total = 1000;
      minimap.sync();
      expect(parent.querySelectorAll('.mm-bar').length).toBeGreaterThan(0);

      total = 1;
      minimap.sync();
      expect(parent.querySelectorAll('.mm-bar')).toHaveLength(0);
    } finally {
      minimap.remove();
    }
  });
});
