import { describe, expect, it } from 'vitest';
import { convertEol, nlSaveName, NL_PRESETS } from './text';

describe('convertEol（002 规则 21：换行统一）', () => {
  it('混合行尾归一为 LF', () => {
    expect(convertEol('a\r\nb\rc\nd', '\n')).toBe('a\nb\nc\nd');
  });
  it('归一为 CRLF', () => {
    expect(convertEol('a\nb\r\nc', '\r\n')).toBe('a\r\nb\r\nc');
  });
  it('空串与无行尾串不受影响', () => {
    expect(convertEol('', '\n')).toBe('');
    expect(convertEol('abc', '\n')).toBe('abc');
  });
});

describe('nlSaveName（后缀插在扩展名前）', () => {
  it('常规扩展名：a.md → a.crlf.md', () => {
    expect(nlSaveName('dir/a.md', 'CRLF')).toBe('a.crlf.md');
  });
  it('无扩展名：README → README.lf', () => {
    expect(nlSaveName('README', 'LF')).toBe('README.lf');
  });
  it('点开头文件（钉住现行为）：.gitignore → .lf.gitignore', () => {
    expect(nlSaveName('.gitignore', 'LF')).toBe('.lf.gitignore');
  });
  it('Windows 路径只取文件名', () => {
    expect(nlSaveName('C:\\x\\y\\b.txt', 'CR')).toBe('b.cr.txt');
  });
});

describe('NL_PRESETS', () => {
  it('三种目标齐全且后缀互异', () => {
    expect(NL_PRESETS.map(p => p.id)).toEqual(['CRLF', 'LF', 'CR']);
    expect(new Set(NL_PRESETS.map(p => p.suffix)).size).toBe(3);
  });
});
