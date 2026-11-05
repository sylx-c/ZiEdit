import { afterEach, expect, it, vi } from 'vitest';
import { extractMarkdownMetadata } from '../src/markdown-view/headings';
import { metadataFingerprint } from '../src/markdown-view/metadata-fingerprint';

afterEach(() => { vi.unstubAllGlobals(); });

it('returns the shared semantic fingerprint alongside the actual worker metadata and request version', async () => {
  const scope: { onmessage: ((event: MessageEvent<{ text: string; version: number }>) => void) | null;
    postMessage: ReturnType<typeof vi.fn> } = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal('self', scope);
  await import('../src/markdown-view/headings-worker');
  const text = '# Heading\n\n[caption][ref]\n\n[ref]: /target.md\n\n$a+b$';
  const metadata = extractMarkdownMetadata(text);
  if (!scope.onmessage) throw new Error('Worker handler was not installed');

  scope.onmessage(new MessageEvent('message', { data: { text, version: 7 } }));

  expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({ ...metadata, version: 7, fingerprint: metadataFingerprint(metadata, text) });
});
