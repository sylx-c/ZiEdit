// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release, entered: false };
});
vi.mock('../src/markdown-view/md', async importOriginal => ({
  ...await importOriginal<object>(),
  loadMarkdownIt: () => { gate.entered = true; return gate.ready; },
}));
vi.mock('../src/common/ipc', () => ({
  textOpen: async () => ({ newline: 'lf' }),
  textReadAll: async () => '# old tab',
  textSave: vi.fn(),
}));

it('切标签销毁后，迟到的语言加载不得写入复用宿主', async () => {
  const { LivePreviewView } = await import('../src/markdown-view/livepreview');
  const host = document.createElement('div');
  const onReady = vi.fn();
  const view = new LivePreviewView(host, {
    path: 'old.md', encoding: 'UTF-8', onStatus: vi.fn(), onSaved: vi.fn(), onReady,
  });
  await vi.waitFor(() => expect(gate.entered).toBe(true));
  view.destroy();
  host.textContent = 'new tab';
  gate.release();
  await gate.ready;
  await Promise.resolve();
  expect(host.textContent).toBe('new tab');
  expect(host.querySelector('.cm-editor')).toBeNull();
  expect(onReady).not.toHaveBeenCalled();
});
