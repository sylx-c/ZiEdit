// markdown-view/live-reporter —— LivePreviewView 的统计/大纲/引用上报机构
// （批次 4 自 livepreview.ts 拆分，行为不变；方法体逐段原样搬移）。
// 字数口径、行缓存增量补丁、元数据 worker 联动、引用指纹门控 referencesReady 派发收拢于此；
// 视图晚绑定与销毁位经访问器注入（livepreview.ts 不被本模块 import，无循环依赖）。
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { type Text } from '@codemirror/state';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { extractMarkdownMetadata, type MarkdownMetadata } from './headings';
import { loadMarkdownIt } from './md';
import { metadataFingerprint, type MarkdownMetadataReport } from './metadata-fingerprint';
import { snapshotDocument } from '../common/snapshot';
import { irPerfEnabled, recordFullRebuild } from './ir-perf';
import { referenceField, referenceIndex, referencesReady } from './live-state';
import type { HeadingItem } from './preview';

/** 保留既有字数口径（UTF-16 非空白码元），直接迭代 CM 文档，不复制整篇字符串。 */
function countChars(doc: Text, from = 0, to = doc.length): number {
  let count = 0;
  for (const chunk of doc.iterRange(from, to)) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (c !== 32 && (c < 9 || c > 13)) count++;
    }
  }
  return count;
}

/** 统计/行缓存/大纲上报的共享载体：字段与方法逐段搬自 LivePreviewView（行为不变）。 */
export class LiveDocTracker {
  stats = { chars: 0, lines: 0 };
  headings: HeadingItem[] = [];
  linesVer = 0;
  private statsDoc: Text | null = null;
  private lastHeadingsJson = '';
  private lastMetadataFingerprint: string | null = null;
  private linesCache: string[] | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private headingsTimer: ReturnType<typeof setTimeout> | undefined;
  private headingsWorker: Worker | null = null;
  private headingsBusy = false;
  private headingsWanted = false;
  private headingsWorkerFailed = false;
  /** 最近一次文档变更时间戳：元数据快照/上报只在键入静默期发起，断 3.9MiB 快照-上报反馈鞭打。 */
  private lastEditAt = 0;

  constructor(
    private viewAt: () => EditorView | undefined,
    private isDestroyed: () => boolean,
    private onHeadings?: (headings: HeadingItem[]) => void
  ) {}

  /** 挂载期首屏指纹直灌（小文档复用首屏索引，避免重复解析后又被 worker 结果覆盖）。 */
  prime(view: EditorView): void {
    if (view.state.doc.length <= 64 * 1024)
      this.lastMetadataFingerprint = metadataFingerprint(view.state.field(referenceField).metadata, view.state.doc.toString());
  }

  /** 文档变更的字数增量补丁（原 updateListener 内联段，statsDoc 命中才累加）。 */
  patchStats(update: ViewUpdate): void {
    if (this.statsDoc === update.startState.doc) {
      let delta = 0;
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        delta += countChars(inserted) - countChars(update.startState.doc, fromA, toA);
      });
      this.stats = { chars: this.stats.chars + delta, lines: update.state.doc.lines };
      this.statsDoc = update.state.doc;
    }
  }

  /** 行版本推进 + 行缓存增量补丁（patchLines 自带空缓存守卫）。 */
  noteChange(update: ViewUpdate): void {
    this.linesVer++;
    this.patchLines(update);
  }

  /** 字数统计防抖（200ms；完成后回调视图侧 reportStatus）。 */
  scheduleStats(then: () => void): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      void this.refreshStats().then(then);
    }, 200);
  }

  /** 大纲上报防抖（300ms；静默闸门在 reportHeadingsLater 内二次收口）。 */
  scheduleHeadings(): void {
    if (this.headingsTimer) clearTimeout(this.headingsTimer);
    this.lastEditAt = Date.now();
    this.headingsTimer = setTimeout(() => {
      this.reportHeadingsLater();
    }, 300);
  }

  async refreshStats(): Promise<void> {
    const view = this.viewAt();
    if (!view) return;
    const doc = view.state.doc;
    if (this.statsDoc === doc) return;
    const version = this.linesVer;
    let chars = 0;
    for (let from = 0; from < doc.length; from += 64 * 1024) {
      chars += countChars(doc, from, Math.min(doc.length, from + 64 * 1024));
      if (from + 64 * 1024 < doc.length) await new Promise<void>(r => setTimeout(r, 0));
      if (this.isDestroyed() || version !== this.linesVer) return;
    }
    this.stats = { chars, lines: doc.lines };
    this.statsDoc = doc;
  }

  /** 元数据上报静默闸门（批次 0，修正 1）：距最近键入不足静默窗则延迟到静默后再触发，
   *  避免 3.9MiB 快照（60 片 × setTimeout ~4ms）与持续键入互相喂新工作形成反馈鞭打。 */
  private reportHeadingsLater(): void {
    const QUIET_MS = 600;
    const idle = Date.now() - this.lastEditAt;
    if (idle < QUIET_MS) {
      if (this.headingsTimer) clearTimeout(this.headingsTimer);
      this.headingsTimer = setTimeout(() => this.reportHeadingsLater(), QUIET_MS - idle);
      return;
    }
    void this.reportHeadings();
  }

  async reportHeadings(): Promise<void> {
    const view = this.viewAt();
    if (!view) return;
    const index = view.state.field(referenceField);
    // 小文档首屏已经建立完整索引，复用同一结果，避免挂载后再解析一遍。
    if (view.state.doc.length <= 64 * 1024 && index.mapping === null) {
      this.publishHeadings(index.metadata.headings); return;
    }
    // 超过首屏同步索引预算即交给已有Worker，避免64–256KiB文件又在主线程完整解析。
    if (view.state.doc.length > 64 * 1024 && typeof Worker !== 'undefined' && !this.headingsWorkerFailed) {
      this.headingsWanted = true;
      if (this.headingsBusy) return;
      if (!this.headingsWorker) {
        this.headingsWorker = new Worker(new URL('./headings-worker.ts', import.meta.url), { type: 'module' });
        this.headingsWorker.onmessage = (event: MessageEvent<MarkdownMetadataReport>) => {
          if (this.isDestroyed()) return;
          this.headingsBusy = false;
          if (event.data.version === this.linesVer) {
            const { version: _version, fingerprint, ...metadata } = event.data;
            this.publishHeadings(metadata.headings);
            this.publishReferences(metadata, fingerprint);
          }
          if (this.headingsWanted) this.reportHeadingsLater();
        };
        this.headingsWorker.onerror = () => {
          this.headingsWorker?.terminate();
          this.headingsWorker = null;
          this.headingsBusy = false;
          this.headingsWorkerFailed = true;
          if (!this.isDestroyed()) this.reportHeadingsLater();
        };
      }
      this.headingsWanted = false;
      this.headingsBusy = true;
      const version = this.linesVer;
      // Worker 已承担全文解析；快照仍在主线程分段序列化，原生长任务门禁继续测量这项成本。
      const text = await snapshotDocument(view.state.doc);
      if (this.isDestroyed() || version !== this.linesVer) {
        // 快照期间又有键入：不立即重排（那会与键入互相喂工作），挂起等下一次静默节拍。
        this.headingsBusy = false;
        this.headingsWanted = true;
        if (!this.isDestroyed()) this.reportHeadingsLater();
        return;
      }
      this.headingsWorker.postMessage({ text, version });
      return;
    }
    // FC 收口 1 就绪屏障：仅主线程提取路径需要——下方 extractMarkdownMetadata 走
    // mdLinkTools；worker 路径（上方分支）自带静态绑定，且 Worker 构造必须保持同步
    // （调用方在挂载拍即读取 workers[0]，屏障不得前移到函数顶部）。
    await loadMarkdownIt();
    const version = this.linesVer;
    const text = await snapshotDocument(view.state.doc);
    // 快照期间又有键入：不丢弃（元数据会永久滞后），挂起等下一次静默节拍重取。
    if (this.isDestroyed()) return;
    if (version !== this.linesVer) { this.headingsWanted = true; this.reportHeadingsLater(); return; }
    const state = view.state;
    const metadata = extractMarkdownMetadata(text, syntaxTreeAvailable(state, state.doc.length) ? syntaxTree(state) : undefined);
    this.publishHeadings(metadata.headings);
    this.publishReferences(metadata, metadataFingerprint(metadata, text));
  }

  private publishReferences(metadata: MarkdownMetadata, fingerprint: string): void {
    const view = this.viewAt()!;
    const current = view.state.field(referenceField);
    if (fingerprint === this.lastMetadataFingerprint && current.definitions === current.metadata.references
      && current.footnotes.size === current.metadata.footnotes.length) return;
    const next = referenceIndex(view.state.doc, metadata);
    if (irPerfEnabled()) recordFullRebuild('referencesReady');
    view.dispatch({ effects: referencesReady.of(next) });
    this.lastMetadataFingerprint = fingerprint;
  }

  private publishHeadings(heads: HeadingItem[]): void {
    const json = JSON.stringify(heads);
    if (json === this.lastHeadingsJson) return; // 无变化不上报（防抖降噪）
    this.lastHeadingsJson = json;
    this.headings = heads;
    this.onHeadings?.(heads);
  }

  private patchLines(update: ViewUpdate): void {
    let cache = this.linesCache;
    if (!cache) return;
    const before = update.startState.doc, after = update.state.doc;
    const patches: { from: number; to: number; start: number; end: number }[] = [];
    update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      const from = before.lineAt(fromA).number, to = before.lineAt(toA).number;
      const start = after.lineAt(fromB).number, end = after.lineAt(toB).number;
      const previous = patches[patches.length - 1];
      if (previous && from <= previous.to) { previous.to = to; previous.end = end; }
      else patches.push({ from, to, start, end });
    });
    for (const patch of patches.reverse()) {
      const replacement = Array.from(after.iterLines(patch.start, patch.end + 1));
      if (replacement.length === patch.to - patch.from + 1) {
        for (const [index, line] of replacement.entries()) cache[patch.from - 1 + index] = line;
      } else cache = cache.slice(0, patch.from - 1).concat(replacement, cache.slice(patch.to));
    }
    this.linesCache = cache;
  }

  getLines(): string[] {
    if (irPerfEnabled() && !this.linesCache) recordFullRebuild('getLines');
    if (!this.linesCache) this.linesCache = this.viewAt()!.state.doc.toString().split('\n');
    return this.linesCache;
  }

  dispose(): void {
    this.headingsWorker?.terminate();
    this.headingsWorker = null;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (this.headingsTimer) clearTimeout(this.headingsTimer);
  }
}
