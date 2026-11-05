// renderLineHtml 字符级合并高亮单测（M6-3）
import { describe, expect, it } from 'vitest';
import { renderLineHtml } from './view';

describe('renderLineHtml（语法区间 + 查找命中共存）', () => {
  it('无任何区间时纯转义', () => {
    expect(renderLineHtml('a<b>&"')).toBe('a&lt;b&gt;&amp;&quot;');
  });
  it('仅语法区间', () => {
    expect(renderLineHtml('abc', [{ from: 0, to: 2, cls: 'tok-k' }])).toBe(
      '<span class="tok-k">ab</span>c'
    );
  });
  it('命中区间覆盖语法着色（优先）', () => {
    expect(renderLineHtml('abcd', [{ from: 0, to: 4, cls: 'tok-k' }], [{ from: 1, to: 3 }])).toBe(
      '<span class="tok-k">a</span><span class="tv-hit-c">bc</span><span class="tok-k">d</span>'
    );
  });
  it('多命中分段', () => {
    expect(renderLineHtml('xay axa', undefined, [{ from: 1, to: 2 }, { from: 5, to: 6 }])).toBe(
      'x<span class="tv-hit-c">a</span>y a<span class="tv-hit-c">x</span>a'
    );
  });
  it('转义与着色共存', () => {
    const out = renderLineHtml('<i>', [{ from: 0, to: 3, cls: 'tok-s' }]);
    expect(out).toBe('<span class="tok-s">&lt;i&gt;</span>');
  });
});

// ---- 日志着色（批 D-4）----
import { logLineSpans, highlightLines } from './highlight';
describe('logLineSpans（时间戳/级别轻量着色）', () => {
  it('ISO 时间戳着为数字色', () => {
    const s = logLineSpans('2026-10-15 04:20:01 INFO started');
    expect(s[0]).toEqual({ from: 0, to: 19, cls: 'tok-number' });
  });
  it('[HH:MM:SS] 方括号时间戳', () => {
    const s = logLineSpans('[12:34:56] ERROR boom');
    expect(s[0]).toEqual({ from: 0, to: 10, cls: 'tok-number' });
  });
  it('级别分级着色', () => {
    const s = logLineSpans('x ERROR FATAL WARN INFO DEBUG y');
    const cls = s.map(x => x.cls).sort();
    expect(cls).toContain('tok-keyword');
    expect(cls).toContain('tok-atom');
    expect(cls).toContain('tok-meta');
    expect(cls).toContain('tok-comment');
  });
  it('普通文本无区间', () => {
    expect(logLineSpans('just a plain line')).toEqual([]);
  });
  it('highlightLines 对 Log 走正则路径', () => {
    const rows = highlightLines(['12:00:00 WARN x', 'plain'], 'Log');
    expect(rows[0].length).toBeGreaterThan(0);
    expect(rows[1]).toEqual([]);
  });
});
