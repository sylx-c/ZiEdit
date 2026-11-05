import { describe, expect, it } from 'vitest';
import { parseError } from './errors';

describe('IPC 错误边界', () => {
  it.each(['EXISTS', 'NOT_FOUND', 'TOO_LARGE', 'INDEXING', 'EXTERNAL_CHANGED: file changed', 'UNMAPPABLE:GBK'])('兼容旧字符串 %s', value => {
    expect(parseError(value)).toMatchObject({ code: value.split(':')[0], message: value, diagnostic: value });
  });
  it('不将路径或正文里的哨兵误判为错误码', () => {
    expect(parseError('Cannot read C:/EXISTS.txt').code).toBe('UNKNOWN');
    expect(parseError('EXISTS_OTHER').code).toBe('UNKNOWN');
  });
  it('保留未知错误、Error 与结构化信息', () => {
    const error = new Error('磁盘已满');
    expect(parseError(error)).toEqual({ code: 'UNKNOWN', message: '磁盘已满', diagnostic: error });
    expect(parseError({ code: 'DENIED', message: '拒绝访问' })).toMatchObject({ code: 'DENIED', message: '拒绝访问' });
    expect(parseError({ detail: 'bad' }).message).toBe('{"detail":"bad"}');
    expect(parseError(null).message).toBe('null');
    expect(parseError('E6001:bucket').code).toBe('E6001');
  });
});
