import { expect, it, vi } from 'vitest';
const call = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: call }));
import { recoveryDiscard, recoverySnapshot } from '../src/common/ipc';

it('在途快照完成后再弃快照，失败不阻断下一次操作', async () => {
  let finish!: () => void;
  call.mockImplementation((command: string) => command === 'recovery_snapshot' ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve());
  const snapshot = recoverySnapshot('a.txt', 'dirty', 0, 0, false);
  const discard = recoveryDiscard(['a.txt']);
  await Promise.resolve();
  expect(call.mock.calls.map(args => args[0])).toEqual(['recovery_snapshot']);
  finish();
  await Promise.all([snapshot, discard]);
  expect(call.mock.calls.map(args => args[0])).toEqual(['recovery_snapshot', 'recovery_discard']);
  call.mockRejectedValueOnce(new Error('controlled failure'));
  await expect(recoverySnapshot('a.txt', 'new', 0, 0, false)).rejects.toThrow('controlled failure');
  await expect(recoveryDiscard(['a.txt'])).resolves.toBeUndefined();
});
