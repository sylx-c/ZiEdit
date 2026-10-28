import { describe, expect, it } from 'vitest';
import { parsePairs, replaceDocLines, replaceInLine } from './replace';

const base = { find: 'AA', replaceWith: 'BB', caseSensitive: true, wholeWord: false, regex: false };

describe('replaceInLine 基础', () => {
  it('全行替换并计数', () => {
    const r = replaceInLine('aAAbAAc', base);
    expect(r?.text).toBe('aBBbBBc');
    expect(r?.count).toBe(2);
  });
  it('大小写不敏感折叠原文保留', () => {
    const r = replaceInLine('aAa aa AA', { ...base, caseSensitive: false, find: 'aa' });
    expect(r?.text).toBe('BBa BB BB');
    expect(r?.count).toBe(3);
  });
  it('无命中返回 null', () => {
    expect(replaceInLine('xyz', base)).toBeNull();
  });
});

describe('replaceInLine 列范围（002 规则 22）', () => {
  const line = '0123456789'; // AA 在窗口外
  it('区间内替换、区间外不动', () => {
    const r = replaceInLine('xxAAyyAAzz', { ...base, colStart: 6, colEnd: 10 });
    expect(r?.text).toBe('xxAAyyBBzz');
    expect(r?.count).toBe(1);
  });
  it('起止含端点', () => {
    const r = replaceInLine('aAbA', { ...base, find: 'Ab', replaceWith: 'X', colStart: 2, colEnd: 3 });
    expect(r?.text).toBe('aXA'); // 第 2~3 列（含）= 'Ab' 被替换
  });
  it('窗口为空/null', () => {
    expect(replaceInLine(line, { ...base, colStart: 5, colEnd: 4 })).toBeNull();
    expect(replaceInLine('', base)).toBeNull();
  });
});

describe('replaceInLine 正则与全字', () => {
  it('正则与 $1', () => {
    const r = replaceInLine('err-101 err-205', { find: 'err-(\\d+)', replaceWith: 'E$1', caseSensitive: true, wholeWord: false, regex: true });
    expect(r?.text).toBe('E101 E205');
    expect(r?.count).toBe(2);
  });
  it('全字跳过子串', () => {
    const r = replaceInLine('the theme there', { find: 'the', replaceWith: 'X', caseSensitive: true, wholeWord: true, regex: false });
    expect(r?.text).toBe('X theme there');
    expect(r?.count).toBe(1);
  });
  it('非法正则安全返回 null', () => {
    expect(replaceInLine('a', { find: '(', replaceWith: 'x', caseSensitive: true, wholeWord: false, regex: true })).toBeNull();
  });
});

describe('replaceDocLines', () => {
  it('跨行收集变更（1-based 行号）', () => {
    const { changes, count } = replaceDocLines(['AAx', 'none', 'yAA'], base);
    expect(changes.map(c => c.line)).toEqual([1, 3]);
    expect(count).toBe(2);
    expect(changes[0].text).toBe('BBx');
  });
});

describe('parsePairs（002 规则 28）', () => {
  it('TAB 成对、空行与缺 TAB 跳过', () => {
    const pairs = parsePairs('foo\tFOO\n\nbadline\nbar\tBAR\n\t前空跳过');
    expect(pairs).toEqual([
      { find: 'foo', replaceWith: 'FOO' },
      { find: 'bar', replaceWith: 'BAR' },
    ]);
  });
  it('替换串可为空（删除语义）', () => {
    const pairs = parsePairs('del\t');
    expect(pairs).toEqual([{ find: 'del', replaceWith: '' }]);
  });
  it('列表顺序替换（后对作用前对结果）', () => {
    let lines = ['foo bar'];
    for (const p of parsePairs('foo\tbar\nbar\tbaz')) {
      lines = lines.map(l => replaceInLine(l, { ...p, caseSensitive: true, wholeWord: false, regex: false })?.text ?? l);
    }
    expect(lines[0]).toBe('baz baz');
  });
});
