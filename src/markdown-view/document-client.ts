import { type ChangeSet, type Text } from '@codemirror/state';
import { toLf } from '../common/text';
import { snapshotDocument } from '../common/snapshot';
import { MarkdownDocumentSession, documentChange, blockHtml, type MarkdownBlock, type MarkdownChange } from './document-model';
import type { MarkdownMetadata } from './headings';
import { loadMarkdownIt } from './md';
import { prepareStaticCode } from './static-code';
import { metadataFingerprint } from './metadata-fingerprint';

export interface MarkdownRenderPlan {
  version: number;
  blocks: Array<MarkdownBlock & { html?: string; htmlPending?: boolean }>;
  metadata: MarkdownMetadata;
  lines: number;
  fingerprint?: string;
  /** 首批正文可先显示；后续序列化分批交付，不阻塞首屏或单次消息回调。 */
  htmlReady?: Promise<void>;
}

/** Worker 是派生数据服务；编辑缓冲仍是唯一可写文档。 */
export class MarkdownDocumentClient {
  private worker: Worker | null = null;
  private codeWorker: Worker | null = null;
  private failed = false;
  private version = 0;
  private sent: string | Text = '';
  private initialized = false;
  private pendingChanges: ChangeSet | null = null;
  private disposed = false;
  private pending = new Map<number, { resolve: (plan: MarkdownRenderPlan) => void; reject: (error: Error) => void; metadataOnly: boolean;
    finish?: () => void; fail?: (error: Error) => void }>();
  private local = new MarkdownDocumentSession();
  private localInitialized = false;
  private queue: Promise<void> = Promise.resolve();
  readonly html = new Map<string, string>();

  noteChanges(changes: ChangeSet): void {
    this.pendingChanges = this.pendingChanges ? this.pendingChanges.compose(changes) : changes;
  }

  render(text: string | Text, metadataOnly = false): Promise<MarkdownRenderPlan> {
    // 渲染输入契约：先归一再参与 sent/diff 记账。首份快照可能来自 textReadAll 原样读盘（CRLF），
    // 后续文本来自编辑器缓冲（CM 恒 LF）；不先归一会让差分偏移按 \r 数目漂移，增量语法树错位。
    if (typeof text === 'string') text = toLf(text);
    const version = ++this.version, pendingChanges = this.pendingChanges;
    this.pendingChanges = null;
    const result = this.queue.then(() => this.renderVersion(text, metadataOnly, version, pendingChanges));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async renderVersion(text: string | Text, metadataOnly: boolean, version: number, pendingChanges: ChangeSet | null): Promise<MarkdownRenderPlan> {
    if (this.disposed) throw new Error('Markdown document closed');
    let changes: MarkdownChange[] | undefined;
    if (this.initialized) {
      changes = [];
      if (pendingChanges && pendingChanges.length === this.sent.length) {
        pendingChanges.iterChanges((from, to, _fromB, _toB, insert) => changes!.push({ from, to, insert: insert.toString() }));
      } else changes.push(documentChange(typeof this.sent === 'string' ? this.sent : this.sent.toString(), typeof text === 'string' ? text : text.toString()));
    }
    if (typeof Worker !== 'undefined' && !this.failed) {
      try {
        if (!this.worker) {
          this.worker = new Worker(new URL('./document-worker.ts', import.meta.url), { type: 'module' });
          this.worker.onmessage = (event: MessageEvent<MarkdownRenderPlan & { error?: string; streaming?: boolean;
            htmlChunk?: Array<{ id: string; html: string }>; complete?: boolean; codePortRequested?: boolean }>) => {
            const result = event.data;
            if (result.codePortRequested) {
              if (this.disposed || !this.worker) return;
              try {
                const channel = new MessageChannel();
                this.codeWorker ??= new Worker(new URL('./code-worker.ts', import.meta.url));
                this.codeWorker.postMessage({ port: channel.port1 }, [channel.port1]);
                this.worker.postMessage({ codePort: channel.port2 }, [channel.port2]);
              } catch { this.codeWorker?.terminate(); this.codeWorker = null; }
              return;
            }
            const job = this.pending.get(result.version);
            if (!job || this.disposed) return;
            if (result.error) {
              this.pending.delete(result.version);
              const error = new Error(result.error); job.fail?.(error); job.reject(error); return;
            }
            if (result.htmlChunk) {
              for (const block of result.htmlChunk) this.html.set(block.id, block.html);
              if (result.complete) { this.pending.delete(result.version); job.finish?.(); }
              return;
            }
            for (const block of result.blocks) if (block.html !== undefined) this.html.set(block.id, block.html);
            if (!job.metadataOnly) this.pruneHtml(result.blocks);
            if (result.streaming) {
              result.htmlReady = new Promise<void>((resolve, reject) => { job.finish = resolve; job.fail = reject; });
              // 挂载已经作废时消费者可能不再等待；失败仍由有效正文的 await 传播。
              void result.htmlReady.catch(() => {});
            } else this.pending.delete(result.version);
            job.resolve(result);
          };
          this.worker.onerror = () => this.stopWorker();
        }
        const result = new Promise<MarkdownRenderPlan>((resolve, reject) => this.pending.set(version, { resolve, reject, metadataOnly }));
        const source = changes ? undefined : typeof text === 'string' ? text : await snapshotDocument(text);
        if (this.disposed) throw new Error('Markdown document closed');
        this.worker.postMessage(changes ? { version, changes, metadataOnly } : { version, text: source, metadataOnly });
        this.sent = text; this.initialized = true;
        return await result;
      } catch { this.stopWorker(); }
    }
    if (this.disposed) throw new Error('Markdown document closed');
    await loadMarkdownIt();
    const source = typeof text === 'string' ? text : await snapshotDocument(text);
    if (this.disposed) throw new Error('Markdown document closed');
    const doc = this.local.update(source, this.localInitialized ? changes : undefined);
    this.localInitialized = true;
    if (!metadataOnly) await prepareStaticCode(source, doc.tree);
    if (this.disposed) throw new Error('Markdown document closed');
    const blocks = doc.blocks.map(block => ({ ...block, html: metadataOnly ? undefined : blockHtml(doc, block) }));
    for (const block of blocks) if (block.html !== undefined) this.html.set(block.id, block.html);
    if (!metadataOnly) this.pruneHtml(blocks);
    this.sent = text; this.initialized = true;
    return { version, blocks: metadataOnly ? [] : blocks, metadata: doc.metadata, lines: doc.lines, fingerprint: metadataFingerprint(doc.metadata, source) };
  }

  private pruneHtml(blocks: MarkdownBlock[]): void {
    const alive = new Set(blocks.map(block => block.id));
    for (const id of this.html.keys()) if (!alive.has(id)) this.html.delete(id);
  }

  private stopWorker(): void {
    this.failed = true; this.worker?.terminate(); this.worker = null;
    this.codeWorker?.terminate(); this.codeWorker = null;
    for (const job of this.pending.values()) {
      const error = new Error('Markdown worker unavailable'); job.fail?.(error); job.reject(error);
    }
    this.pending.clear();
  }
  destroy(): void { this.disposed = true; this.stopWorker(); this.html.clear(); }
}
