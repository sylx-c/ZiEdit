import type { EditorBuffer } from '../common/editor-buffer';
import type { MarkdownDocumentClient } from '../markdown-view/document-client';

interface DocumentFields {
  buffer: EditorBuffer;
  markdown: MarkdownDocumentClient;
  recovery: { content: string; diskChanged: boolean };
  draft: string;
  dirty: boolean;
  encoding: string;
  size: number;
  mtime: number;
  saveEpoch: number;
  readonly: true;
  binary: true;
  deleted: true;
  discarded: true;
}

export interface DocumentSession {
  path: string;
  revision: number;
  readonly fields: Partial<DocumentFields>;
}
export interface DocumentTicket {
  readonly session: DocumentSession;
  readonly revision: number;
}

/** 兼容装配层的按字段访问；数据只存放在文档记录中，不维护第二组 Map。 */
class SessionField<K extends keyof DocumentFields> {
  constructor(private owner: DocumentSessionStore, private key: K) {}
  get(path: string): DocumentFields[K] | undefined { return this.owner.get(path)?.fields[this.key]; }
  has(path: string): boolean { return this.get(path) !== undefined; }
  set(path: string, value: DocumentFields[K]): this { this.owner.ensure(path).fields[this.key] = value; return this; }
  delete(path: string): boolean {
    const session = this.owner.get(path);
    if (!session || !this.has(path)) return false;
    delete session.fields[this.key];
    return true;
  }
  *entries(): IterableIterator<[string, DocumentFields[K]]> {
    for (const session of this.owner.values()) {
      const value = session.fields[this.key];
      if (value !== undefined) yield [session.path, value];
    }
  }
  *keys(): IterableIterator<string> { for (const [path] of this.entries()) yield path; }
  [Symbol.iterator](): IterableIterator<[string, DocumentFields[K]]> { return this.entries(); }
  clear(): void { for (const path of this.keys()) this.delete(path); }
}

class SessionFlag {
  constructor(private field: SessionField<'readonly' | 'binary' | 'deleted' | 'discarded'>) {}
  has(path: string): boolean { return this.field.has(path); }
  add(path: string): this { this.field.set(path, true); return this; }
  delete(path: string): boolean { return this.field.delete(path); }
  clear(): void { this.field.clear(); }
  [Symbol.iterator](): IterableIterator<string> { return this.field.keys(); }
}

/** 文档生命周期独立于挂载/停放的 DOM；会话身份使关闭前的异步结果失效。 */
export class DocumentSessionStore {
  private readonly sessions = new Map<string, DocumentSession>();
  readonly buffers = new SessionField(this, 'buffer');
  readonly markdown = new SessionField(this, 'markdown');
  readonly recovery = new SessionField(this, 'recovery');
  readonly drafts = new SessionField(this, 'draft');
  readonly dirty = new SessionField(this, 'dirty');
  readonly encoding = new SessionField(this, 'encoding');
  readonly sizes = new SessionField(this, 'size');
  readonly mtimes = new SessionField(this, 'mtime');
  readonly saveEpochs = new SessionField(this, 'saveEpoch');
  readonly readonly = new SessionFlag(new SessionField(this, 'readonly'));
  readonly binary = new SessionFlag(new SessionField(this, 'binary'));
  readonly deleted = new SessionFlag(new SessionField(this, 'deleted'));
  readonly discarded = new SessionFlag(new SessionField(this, 'discarded'));

  get(path: string): DocumentSession | undefined { return this.sessions.get(path); }
  ensure(path: string): DocumentSession {
    let session = this.get(path);
    if (!session) {
      session = { path, revision: 0, fields: {} };
      this.sessions.set(path, session);
    }
    return session;
  }
  values(): IterableIterator<DocumentSession> { return this.sessions.values(); }
  isCurrent(session: DocumentSession): boolean { return this.get(session.path) === session; }
  capture(path: string): DocumentTicket { const session = this.ensure(path); return { session, revision: session.revision }; }
  unchanged(ticket: DocumentTicket): boolean { return this.isCurrent(ticket.session) && ticket.session.revision === ticket.revision; }
  changed(session: DocumentSession): void { if (this.isCurrent(session)) session.revision++; }
  markdownFor(path: string, create: () => MarkdownDocumentClient): MarkdownDocumentClient {
    const session = this.ensure(path);
    return session.fields.markdown ??= create();
  }
  rename(from: string, to: string): void {
    if (from === to) return;
    const session = this.get(from);
    if (!session) return;
    this.dispose(to);
    this.sessions.delete(from);
    session.path = to;
    this.sessions.set(to, session);
  }
  dispose(path: string): void {
    const session = this.get(path);
    if (!session) return;
    this.sessions.delete(path); // 先失效，资源销毁触发的回调也不能复活它。
    session.fields.markdown?.destroy();
    for (const key of Object.keys(session.fields) as Array<keyof DocumentFields>) delete session.fields[key];
  }
  retain(paths: ReadonlySet<string>): void {
    for (const path of this.sessions.keys()) if (!paths.has(path)) this.dispose(path);
  }
}
