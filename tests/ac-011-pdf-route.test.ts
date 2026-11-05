// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { shell, startShell, settle } from './shell-behavior-harness';
import { zassetAllow, loadSession, openFile } from '../src/common/ipc';
import { TabStore } from '../src/common/state';
const pdf = vi.hoisted(() => ({ mount: vi.fn(async () => {}), destroy: vi.fn(), fallback: undefined as undefined | ((path: string) => void), text: vi.fn() }));
vi.mock('../src/pdf-view/view', () => ({ PdfView: class {
  constructor(_host: HTMLElement, _path: string, fallback: (path: string) => void) { pdf.fallback = fallback; }
  mount = pdf.mount; destroy = pdf.destroy;
} }));
vi.mock('../src/text-view/view', () => ({ TextView: class {
  constructor(_host: HTMLElement, path: string, options: unknown) { pdf.text(path, options); }
  async mount() {} destroy() {} setInvisibleVisible() {} setHighlight() {} setFontSize() {}
} }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it('PDF 标签会话往返不变，回退不重检测且语言保持 Pdf', () => {
  const store = new TabStore(); store.open({ path: 'C:\\a.pdf', route: 'pdf', language: 'Pdf', scroll: 0 });
  const restored = new TabStore(); restored.restore(store.session());
  expect(restored.active()?.route).toBe('pdf'); restored.setRoute('C:\\a.pdf', 'text');
  expect(restored.active()?.language).toBe('Pdf');
});
it('恢复 PDF 先授权后 mount，隐藏尺子/右轨；回退走 TextView 且不重检测', async () => {
  vi.useFakeTimers();
  vi.mocked(loadSession).mockResolvedValueOnce({ tabs: [{ path: 'C:\\a.pdf', route: 'pdf', language: 'Pdf', scroll: 0 }], activeIndex: 0 });
  await startShell(); await settle();
  expect(zassetAllow).toHaveBeenCalledWith('C:\\a.pdf');
  expect(pdf.mount).toHaveBeenCalled();
  expect(pdf.text).not.toHaveBeenCalled();
  expect(vi.mocked(zassetAllow).mock.invocationCallOrder[0]).toBeLessThan(pdf.mount.mock.invocationCallOrder[0]!);
  const ruler = document.createElement('div'); ruler.className = 'ruler'; document.body.append(ruler);
  const rail = document.createElement('div'); rail.id = 'editorRail'; document.body.append(rail);
  shell.actions.run('view.toggleRuler'); await settle();
  expect(ruler.style.display).toBe('none'); expect(rail.style.display).toBe('none');
  const detected = vi.mocked(openFile).mock.calls.length;
  pdf.fallback!('C:\\a.pdf'); await settle();
  expect(pdf.destroy).toHaveBeenCalled(); expect(shell.store.active().route).toBe('text');
  expect(pdf.text).toHaveBeenCalledWith('C:\\a.pdf', expect.objectContaining({ language: 'Pdf' }));
  expect(openFile).toHaveBeenCalledTimes(detected); expect(rail.style.display).toBe('');
});
it('授权 promise 未完成时不开始 PDF mount，完成后才进入加载', async () => {
  vi.useFakeTimers();
  let authorize!: () => void;
  vi.mocked(zassetAllow).mockImplementationOnce(() => new Promise(resolve => { authorize = () => resolve(null); }));
  vi.mocked(loadSession).mockResolvedValueOnce({ tabs: [{ path: 'C:\\wait.pdf', route: 'pdf', language: 'Pdf', scroll: 0 }], activeIndex: 0 });
  await startShell(); expect(pdf.mount).not.toHaveBeenCalled(); authorize(); await settle(); expect(pdf.mount).toHaveBeenCalledTimes(1);
});
