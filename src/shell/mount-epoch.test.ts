import { describe, expect, it } from 'vitest';
import { MountEpoch } from './mount-epoch';

describe('挂载代次', () => {
  it('新代次作废旧异步挂载', () => {
    const epoch = new MountEpoch();
    const old = epoch.next();
    expect(epoch.isCurrent(old)).toBe(true);
    epoch.next();
    expect(epoch.isCurrent(old)).toBe(false);
  });
  it('路径锁独立，不影响其他文件挂载', () => {
    const epoch = new MountEpoch();
    epoch.lock('a'); epoch.lock('b');
    epoch.unlock('a');
    expect(epoch.locked('a')).toBe(false);
    expect(epoch.locked('b')).toBe(true);
  });
});
