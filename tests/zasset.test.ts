import { expect, it } from 'vitest';
import { zassetUrl } from '../src/common/ipc';

it('encodes full native paths once without treating query/fragment as URL syntax', () => {
  for (const path of ['C:\\图片\\a #%.png', '/tmp/中/a?.pdf', '\\\\server\\share\\a.svg']) {
    const url = new URL(zassetUrl(path));
    expect(url.origin).toBe('http://zasset.localhost');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(decodeURIComponent(url.pathname.slice(1))).toBe(path);
  }
});
