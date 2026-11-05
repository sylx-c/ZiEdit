// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { shell, startShell, settle } from './shell-behavior-harness';
import { openFile, settingsLoad, textReadAll, textSave } from '../src/common/ipc';
const live = vi.hoisted(() => ({ instance: null as any }));
vi.mock('../src/markdown-view/livepreview', () => ({ LivePreviewView: class {
  opts: any; constructor(_host: unknown, opts: any) { this.opts = opts; live.instance = this; }
  get path() { return this.opts.path; }
  getContent() { return '# 当前未保存的即时编辑内容'; }
  setFontSize() {} setReadOnly() {} destroy() {} focus() {}
} }));
// 提前完成模块加载；虚拟计时器不能用来计量构建工具的真实 I/O。
await Promise.all([import('../src/markdown-view/preview'), import('../src/markdown-view/blockcache'), import('../src/markdown-view/livepreview')]);
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it.each(['cancel', 'failure', 'success'])('即时编辑另存 %s，使用缓冲且保留来源', async outcome => {
  vi.useFakeTimers();
  vi.mocked(settingsLoad).mockResolvedValueOnce({ mdDefaultMode: 'ir' });
  await startShell();
  vi.mocked(openFile).mockResolvedValueOnce({ path: 'C:\\work.md', route: 'text', language: 'Markdown', len: 10, modifiedMs: 100, readonly: false, binary: false });
  shell.cli(['C:\\work.md']); await settle(); await settle();
  await vi.waitFor(() => expect(live.instance?.path).toBe('C:\\work.md'), { timeout: 10000 });
  await vi.waitFor(() => expect(shell.actions.isEnabled('file.saveAs')).toBe(true), { timeout: 10000 });
  live.instance.opts.onStatus({ dirty: true, line: 1, col: 1, chars: 15, lines: 1 });
  vi.mocked(textSave).mockClear(); vi.mocked(textReadAll).mockClear();
  shell.saveDialog.mockResolvedValueOnce(outcome === 'cancel' ? null : 'C:\\copy.md');
  if (outcome === 'failure') vi.mocked(textSave).mockRejectedValueOnce(new Error('disk full'));
  expect(shell.actions.run('file.saveAs')).toBe(true); await settle();
  expect(textReadAll).not.toHaveBeenCalled();
  if (outcome === 'cancel') expect(textSave).not.toHaveBeenCalled();
  else expect(textSave).toHaveBeenCalledWith('C:\\copy.md', '# 当前未保存的即时编辑内容', 'UTF-8');
  expect(shell.store.active().path).toBe('C:\\work.md');
  expect(document.querySelector('.tab-dot')).not.toBeNull();
  if (outcome === 'failure') expect(shell.alert).toHaveBeenCalledWith(expect.stringContaining('disk full'));
}, 15000);
