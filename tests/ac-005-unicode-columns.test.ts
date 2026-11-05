import { describe, expect, it } from 'vitest';
import { charAtVisualCol, visualColOf, visualWidth, rectText } from '../src/text-view/rect';

describe('复审 D15/D16 视觉列边界', () => {
  it('emoji、组合音标和 ZWJ 序列不会被拆开', () => {
    for (const [text, width] of [['😀', 2], ['👨‍👩‍👧‍👦', 2], ['e\u0301', 1]] as const) {
      expect(visualWidth(text)).toBe(width);
      expect(charAtVisualCol(text + 'x', width - 1)).toBe(0);
      expect(charAtVisualCol(text + 'x', width)).toBe(text.length);
      expect(visualColOf(text, 1)).toBe(0);
      const copied = rectText({ fromLine: 1, toLine: 1, colStart: 0, colEnd: width }, () => text + 'x');
      expect(copied).toEqual([text]);
    }
  });
  it('Tab 按四格停靠点计算，中文按双格', () => {
    expect(visualWidth('A\t中')).toBe(6);
    expect(visualColOf('A\t中', 2)).toBe(4);
    expect(charAtVisualCol('A\t中', 3)).toBe(1);
    expect(charAtVisualCol('A\t中', 4)).toBe(2);
    expect(visualWidth('\t', 2)).toBe(2);
  });
});
