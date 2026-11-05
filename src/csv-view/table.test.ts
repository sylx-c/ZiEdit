// CSV 纯逻辑单测（007 子 PRD）
import { describe, expect, it } from 'vitest';
import { parseCsvLine, sniffDelim } from './table';

describe('parseCsvLine', () => {
  it('基本逗号分隔', () => {
    expect(parseCsvLine('a,b,c', ',')).toEqual(['a', 'b', 'c']);
  });
  it('引号内的分隔符不拆分', () => {
    expect(parseCsvLine('"a,1",b', ',')).toEqual(['a,1', 'b']);
  });
  it('双引号转义', () => {
    expect(parseCsvLine('"x""y",z', ',')).toEqual(['x"y', 'z']);
  });
  it('尾随空单元格', () => {
    expect(parseCsvLine('a,,c', ',')).toEqual(['a', '', 'c']);
  });
  it('制表符分隔', () => {
    expect(parseCsvLine('a\tb', '\t')).toEqual(['a', 'b']);
  });
});

describe('sniffDelim', () => {
  it('逗号最多则选逗号', () => {
    expect(sniffDelim('a,b,c,d')).toBe(',');
  });
  it('分号胜出', () => {
    expect(sniffDelim('a;b;c')).toBe(';');
  });
  it('无分隔符回退逗号', () => {
    expect(sniffDelim('abc')).toBe(',');
  });
});
