// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { textReadAll } from '../common/ipc';
import contributing from '../../CONTRIBUTING.md?raw';

vi.mock('../common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textReadAll: vi.fn() }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

it('IR renders clickable links and routes local/external targets without WebView navigation', async () => {
  const { LivePreviewView } = await import('./livepreview');
  const host = document.createElement('div'); document.body.append(host);
  const openMarkdown = vi.fn(), openExternal = vi.fn();
  const preview = new LivePreviewView(host, {
    path: 'E:/docs/readme.md', encoding: 'UTF-8',
    initialDoc: 'intro\n\n[a](b.md) and [web](https://example.com)\n\n[bad](javascript:alert(1))',
    onStatus: () => {}, onSaved: () => {}, openMarkdown, openExternal,
  });
  try {
    await vi.waitFor(() => expect(host.querySelector('a.mdir-link[href="b.md"]')).not.toBeNull());
    const local = host.querySelector<HTMLAnchorElement>('a[href="b.md"]')!;
    expect(local.textContent).toBe('a');
    local.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(local.isConnected).toBe(true);
    expect(local.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false);
    expect(openMarkdown).toHaveBeenCalledExactlyOnceWith('E:/docs/b.md');
    host.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')!.click();
    expect(openExternal).not.toHaveBeenCalled();
    const external = host.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')!;
    external.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, ctrlKey: true }));
    external.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com');
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(preview.isDirty).toBe(false);
  } finally { preview.destroy(); host.remove(); }
});

it('assembles disk-backed IR like app.ts and decorates links after earlier document blocks', async () => {
  const { LivePreviewView } = await import('./livepreview');
  const path = 'E:/Project/ZiEdit/CONTRIBUTING.md';
  // 当前贡献指南没有链接；追加明确的链接探针，避免以零链接输入误判装配。
  const source = contributing + '\n\n[relative](README.md) and [external](https://example.com)\n';
  vi.mocked(textReadAll).mockResolvedValueOnce(source);
  const host = document.createElement('div'); host.id = 'viewarea'; document.body.append(host);
  const openMarkdown = vi.fn(), openExternal = vi.fn(), onReady = vi.fn();
  const preview = new LivePreviewView(host, {
    path, encoding: 'UTF-8', initialDoc: undefined, buffer: undefined,
    readOnly: false, startDirty: false,
    onStatus: () => {}, onSaved: () => {}, openMarkdown, openExternal, onReady,
  });
  try {
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(textReadAll).toHaveBeenCalledWith(path, 'UTF-8');
    preview.goToLine(preview.view.state.doc.lines - 1);
    await vi.waitFor(() => expect(host.querySelector('a[href="README.md"]')).not.toBeNull());
    host.querySelector<HTMLAnchorElement>('a[href="README.md"]')!.click();
    expect(openMarkdown).toHaveBeenCalledExactlyOnceWith('E:/Project/ZiEdit/README.md');
    host.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')!.click();
    expect(openExternal).not.toHaveBeenCalled();
  } finally { preview.destroy(); host.remove(); }
});

it('rebuilds reference link href after the definition index publishes an edit', async () => {
  const { LivePreviewView } = await import('./livepreview');
  const host = document.createElement('div'); document.body.append(host);
  const source = 'intro\n\n[a][ref]\n\n[ref]: old.md';
  const preview = new LivePreviewView(host, {
    path: 'E:/docs/readme.md', encoding: 'UTF-8', initialDoc: source,
    onStatus: () => {}, onSaved: () => {},
  });
  try {
    await vi.waitFor(() => expect(host.querySelector('a[href="old.md"]')).not.toBeNull());
    const from = source.indexOf('old.md');
    preview.view.dispatch({ changes: { from, to: from + 6, insert: 'new.md' } });
    await vi.waitFor(() => expect(host.querySelector('a[href="new.md"]')).not.toBeNull(), { timeout: 2500 });
    expect(host.querySelector('a[href="old.md"]')).toBeNull();
  } finally { preview.destroy(); host.remove(); }
});
