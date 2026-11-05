// 不可见字符高亮（002 规则 25）—— renderLineHtml 标记路径（与 008 同一判定口径）
import { describe, expect, it } from 'vitest';
import { renderLineHtml } from './view';

describe('renderLineHtml 不可见字符标记（002 规则 25）', () => {
  it('零宽空格被标出并给替代符', () => {
    const html = renderLineHtml('ab\u{200B}c', undefined, undefined, true);
    expect(html).toContain('tv-invisible');
    expect(html).toContain('·');
  });

  it('关闭开关时零宽字符不标记', () => {
    const html = renderLineHtml('ab\u{200B}c', undefined, undefined, false);
    expect(html).not.toContain('tv-invisible');
  });

  it('控制符与 RTL 控制符标记', () => {
    expect(renderLineHtml('a\u{0001}b', undefined, undefined, true)).toContain('tv-invisible');
    expect(renderLineHtml('a\u{202E}b', undefined, undefined, true)).toContain('tv-invisible');
  });

  it('普通文本不受影响', () => {
    expect(renderLineHtml('abc', undefined, undefined, true)).toBe('abc');
  });

  it('与查找命中共存', () => {
    const html = renderLineHtml('ab\u{200B}c', undefined, [{ from: 0, to: 2 }], true);
    expect(html).toContain('tv-hit-c');
    expect(html).toContain('tv-invisible');
  });
});
