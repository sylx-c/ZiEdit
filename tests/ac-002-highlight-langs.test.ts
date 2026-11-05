import { describe, expect, it } from 'vitest';
import { getParser, hasHighlight, highlightLines, HIGHLIGHT_LANGS, HIGHLIGHT_LIMIT, loadHighlightParser } from '../src/text-view/highlight';

describe('002 AC-34 lightweight language highlighting', () => {
  it.each([
    ['Go', 'var message = "return 42" // func 17', 'var', '// func 17'],
    ['Shell', 'echo "if 42" # return 17', 'echo', '# return 17'],
    ['Batch', 'echo "if 42"', 'echo', ''],
    ['PowerShell', 'return "if 42" # function 17', 'return', '# function 17'],
  ])('%s emits non-overlapping tokens', (language, line, keyword, comment) => {
    expect(HIGHLIGHT_LANGS).toContain(language);
    expect(hasHighlight(language, HIGHLIGHT_LIMIT)).toBe(true);
    expect(hasHighlight(language, HIGHLIGHT_LIMIT + 1)).toBe(false);
    const spans = highlightLines([line, '123'], language);
    expect(spans[0].some(s => s.cls === 'tok-keyword' && line.slice(s.from, s.to) === keyword)).toBe(true);
    expect(spans[0].some(s => s.cls === 'tok-string')).toBe(true);
    if (comment) expect(spans[0].some(s => s.cls === 'tok-comment' && line.slice(s.from, s.to) === comment)).toBe(true);
    expect(spans[1][0].cls).toBe('tok-number');
    for (let i = 1; i < spans[0].length; i++) expect(spans[0][i].from).toBeGreaterThanOrEqual(spans[0][i - 1].to);
  });
  it('supports Batch comments and case-insensitive keywords', () => {
    expect(highlightLines(['REM if 123', ':: comment', 'IF EXIST file'], 'Batch').map(s => s[0].cls)).toEqual(['tok-comment', 'tok-comment', 'tok-keyword']);
  });
  it.each(['key=value # comment', 'port: 123 ; comment'])('colors Config: %s', line => {
    expect(highlightLines([line], 'Config')[0].map(s => s.cls)).toEqual(['tok-propertyName', 'tok-string', 'tok-comment']);
  });
  it('does not color keywords inside identifiers', () => {
    expect(highlightLines(['myreturn'], 'Go')[0]).toEqual([]);
  });
  it('processes a long line without shifting token offsets', () => {
    const line = `${'x'.repeat(100_000)} 42`;
    expect(highlightLines([line], 'Shell')[0].at(-1)).toEqual({ from: 100_001, to: 100_003, cls: 'tok-number' });
  });
  it('loads a Lezer grammar on demand before synchronous tokenization', async () => {
    await loadHighlightParser('JavaScript');
    expect(getParser('JavaScript')).not.toBeNull();
    expect(highlightLines(['const answer = 42'], 'JavaScript')[0].length).toBeGreaterThan(0);
  });
});
