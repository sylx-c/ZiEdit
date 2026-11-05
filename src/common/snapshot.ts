// snapshot —— 从 CodeMirror 文档分段取快照，避免一次性 toString 长时间占用主线程。
// 每段在事件循环之间让出一次，快照仍保持同一份文档状态的内容顺序。
export interface SliceableDocument {
  length: number;
  sliceString(from: number, to?: number): string;
}

const SNAPSHOT_CHUNK = 64 * 1024;

import { yieldToBrowser } from './yield';
export { yieldToBrowser };

export async function snapshotDocument(doc: SliceableDocument): Promise<string> {
  if (doc.length === 0) return '';
  const chunks: string[] = [];
  for (let from = 0; from < doc.length; from += SNAPSHOT_CHUNK) {
    chunks.push(doc.sliceString(from, Math.min(doc.length, from + SNAPSHOT_CHUNK)));
    if (from + SNAPSHOT_CHUNK < doc.length) await yieldToBrowser();
  }
  return chunks.join('');
}
