import MarkdownIt from 'markdown-it';
import { bindMdLinkTools } from './md-link';
import { MarkdownDocumentSession, blockHtml, type MarkdownChange, type MarkdownBlock } from './document-model';
import { prepareStaticCode } from './static-code';
import { metadataFingerprint } from './metadata-fingerprint';

bindMdLinkTools(new MarkdownIt());
const session = new MarkdownDocumentSession();
let text = '', queue = Promise.resolve();
const html = new Map<string, { signature: string; html: string }>();
let codePort: Promise<MessagePort> | undefined;
let acceptCodePort: ((port: MessagePort) => void) | undefined;
const connectCode = (): Promise<MessagePort> => codePort ??= new Promise((resolve, reject) => {
  const timer = setTimeout(() => { acceptCodePort = undefined; reject(new Error('Offline code channel timeout')); }, 2500);
  acceptCodePort = port => { clearTimeout(timer); acceptCodePort = undefined; resolve(port); };
  self.postMessage({ codePortRequested: true });
});
self.onmessage = (event: MessageEvent<{ version: number; text?: string; changes?: MarkdownChange[]; metadataOnly?: boolean; codePort?: MessagePort }>) => {
  if (event.data.codePort) { if (acceptCodePort) acceptCodePort(event.data.codePort); else event.data.codePort.close(); return; }
  const request = event.data;
  queue = queue.then(async () => {
    try {
      if (request.text !== undefined) text = request.text;
      else for (const change of [...request.changes ?? []].reverse()) text = text.slice(0, change.from) + change.insert + text.slice(change.to);
      const doc = session.update(text, request.changes);
      if (!request.metadataOnly) await prepareStaticCode(text, doc.tree, connectCode);
      const alive = new Set<string>();
      const deferred: MarkdownBlock[] = [];
      const serialize = (block: MarkdownBlock): string => {
        const value = blockHtml(doc, block); html.set(block.id, { signature: block.signature, html: value }); return value;
      };
      const blocks = doc.blocks.map((block, index) => {
        alive.add(block.id);
        if (request.metadataOnly) return { ...block, html: undefined };
        const cached = html.get(block.id);
        if (cached?.signature === block.signature) return { ...block, html: undefined };
        if (index < 32) return { ...block, html: serialize(block) };
        deferred.push(block);
        return { ...block, htmlPending: true };
      });
      for (const id of html.keys()) if (!alive.has(id)) html.delete(id);
      self.postMessage({ version: request.version, blocks: request.metadataOnly ? [] : blocks, metadata: doc.metadata, lines: doc.lines,
        fingerprint: metadataFingerprint(doc.metadata, text), streaming: deferred.length > 0 });
      // 不将整篇 HTML 塞进单个消息。首批可读后继续在 Worker 序列化，主线程
      // 每次只接收有界批次，避免大消息反序列化与缓存登记落在开头几次交互中。
      let chunk: Array<{ id: string; html: string }> = [];
      for (const block of deferred) {
        chunk.push({ id: block.id, html: serialize(block) });
        if (chunk.length >= 128) { self.postMessage({ version: request.version, htmlChunk: chunk }); chunk = []; }
      }
      if (deferred.length) self.postMessage({ version: request.version, htmlChunk: chunk, complete: true });
    } catch (error) {
      self.postMessage({ version: request.version, error: error instanceof Error ? error.message : String(error) });
    }
  });
};
