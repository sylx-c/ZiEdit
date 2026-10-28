// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { checksumPanel } from '../src/shell/panels';
import { checksum } from '../src/common/ipc';
vi.mock('../src/common/ipc', () => ({ checksum: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it('四种算法逐一传递路径与算法，并展示各自摘要', async () => {
  vi.mocked(checksum).mockImplementation(async (_path, algo) => `digest-${algo}`);
  const body = checksumPanel('/data/a.bin');
  await vi.waitFor(() => expect(body.querySelectorAll('.clickable')).toHaveLength(4));
  expect(checksum).toHaveBeenCalledTimes(4);
  for (const algo of ['crc32', 'md5', 'sha1', 'sha256']) {
    expect(checksum).toHaveBeenCalledWith('/data/a.bin', algo);
    expect(body.textContent).toContain(`digest-${algo}`);
  }
});
it('异步完成之前展示占位符及文件路径', () => {
  vi.mocked(checksum).mockImplementation(() => new Promise(() => {}));
  const body = checksumPanel('/data/empty');
  expect(body.querySelector('.ov-path')?.textContent).toBe('/data/empty');
  expect([...body.querySelectorAll('.sum-val')].map(el => el.textContent)).toEqual(['…', '…', '…', '…']);
});
it('单算法失败显示错误，不影响其他算法结果', async () => {
  vi.mocked(checksum).mockImplementation(async (_path, algo) => {
    if (algo === 'md5') throw new Error('read failed');
    return `ok-${algo}`;
  });
  const body = checksumPanel('/data/a');
  await vi.waitFor(() => expect(body.textContent).toContain('read failed'));
  expect(body.querySelectorAll('.clickable')).toHaveLength(3);
  expect(body.textContent).toContain('ok-sha256');
});
