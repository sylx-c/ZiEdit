// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { shell, startShell, settle } from './shell-behavior-harness';
import { fileStat, textSave } from '../src/common/ipc';
import { t } from '../src/common/i18n';
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('textSave 返回落盘大小与修改时间，并将保存参数传递给 IPC', async () => {
  const ipc = await vi.importActual<typeof import('../src/common/ipc')>('../src/common/ipc');
  shell.invoke.mockResolvedValueOnce({ len: 20, modifiedMs: 200 } as never);
  expect(await ipc.textSave('C:\\a.txt', 'hello', 'UTF-8')).toEqual({ len: 20, modifiedMs: 200 });
  expect(shell.invoke).toHaveBeenCalledWith('text_save', expect.objectContaining({ path: 'C:\\a.txt', content: 'hello', encodingName: 'UTF-8' }));
});

it.each(['edit', 'livepreview'])('%s 真实视图将 textSave 的 stat 透传给 onSaved，失败不回调', async kind => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const { EditView } = await vi.importActual<typeof import('../src/text-view/edit')>('../src/text-view/edit');
  const { LivePreviewView } = await import('../src/markdown-view/livepreview');
  const onSaved = vi.fn();
  let ready!: () => void;
  const gate = new Promise<void>(resolve => { ready = resolve; });
  const opts = { path: 'C:\\a.txt', language: null, encoding: 'UTF-8', initialDoc: 'hello', onStatus() {}, onSaveAsNeeded() {}, onAlert() {}, onSaved, onReady: ready };
  const view = kind === 'edit' ? new EditView(document.createElement('div'), opts) : new LivePreviewView(document.createElement('div'), opts);
  try {
    await gate; await view.save();
    expect(onSaved).toHaveBeenCalledExactlyOnceWith('C:\\a.txt', { len: 20, modifiedMs: 200 }, true);
    onSaved.mockClear();
    vi.mocked(textSave).mockRejectedValueOnce(new Error('disk full'));
    await view.save();
    expect(onSaved).not.toHaveBeenCalled();
  } finally { view.destroy(); }
}, 15000); // 真实视图挂载需现场加载 CM6 模块图，全量并行 worker 下会超 5s 默认限时（断言对象是 save-stat 透传，非加载速度）

it('保存回调同步刷新状态栏及轮询基线，不等待异步 stat 回填或误报外部修改', async () => {
  vi.useFakeTimers(); await startShell();
  shell.cli(['C:\\a.txt']); await settle();
  const view = shell.edit;
  // 保存后的异步元数据回填保持未完成；轮询返回新的落盘基线。
  let release!: (stat: { len: number; modifiedMs: number; isDir: boolean }) => void;
  vi.mocked(fileStat).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  view.opts.onSaved('C:\\a.txt', { len: 20, modifiedMs: 200 }, true);
  expect(document.getElementById('statusbar')?.textContent).toContain('20 B');
  vi.mocked(fileStat).mockResolvedValueOnce({ len: 20, modifiedMs: 200, isDir: false });
  await vi.advanceTimersByTimeAsync(2000); await settle();
  expect(shell.edit).toBe(view);
  expect(shell.flash).not.toHaveBeenCalledWith(t('msg.reloaded'));
  release({ len: 20, modifiedMs: 200, isDir: false }); await settle();
});
