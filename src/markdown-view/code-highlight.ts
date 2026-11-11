import { StateEffect, type Range } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { syntaxTree, type LanguageDescription } from '@codemirror/language';
import { compositionActive } from '../common/composition';
import { codeLanguage, visibleCodeSource, visibleCodeTokens, type CodeToken } from './code-tokens';

interface CodeBlock {
  language: string; source: string; key: string;
  segments: { from: number; to: number; offset: number }[];
  coverFrom: number; coverTo: number;
  tokens?: CodeToken[];
}
const highlighted = StateEffect.define<void>();
const CACHE_CHARS = 1024 * 1024;

/** CM6 未提供解析器的语言复用离线 hljs；主线程仅提交可见块并映射 token 源范围。 */
export function codeHighlight(languages: readonly LanguageDescription[]) {
  const native = new Set(languages.flatMap(language => [language.name.toLowerCase(), ...language.alias]));
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    private worker: Worker | null = null;
    private failed = false;
    private destroyed = false;
    private sequence = 0;
    private pending: { id: number; block: CodeBlock } | null = null;
    private blocks: CodeBlock[] = [];
    private cache = new Map<string, CodeToken[]>();
    private cacheSize = 0;
    private sources = new Map<string, CodeBlock>();
    private sourceSize = 0;
    private spans = new Map<string, { from: number; to: number }[]>();
    private notify: ReturnType<typeof setTimeout> | undefined;

    constructor(private view: EditorView) { this.refresh(); }
    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.decorations = this.decorations.map(update.changes);
        this.sources.clear(); this.sourceSize = 0; this.spans.clear();
      }
      if (update.state.field(compositionActive, false)) return;
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)
        || update.startState.field(compositionActive, false) !== update.state.field(compositionActive, false)
        || update.transactions.some(tr => tr.effects.some(effect => effect.is(highlighted)))) this.refresh();
    }
    private refresh() {
      const view = this.view, blocks: CodeBlock[] = [], seen = new Set<number>();
      const previous = new Map(this.blocks.map(block => [block.key, block.tokens]));
      const tree = syntaxTree(view.state);
      for (const visible of view.visibleRanges) tree.iterate({ from: visible.from, to: visible.to, enter: ref => {
        if (ref.name !== 'FencedCode') return;
        if (seen.has(ref.from)) return false;
        seen.add(ref.from);
        const info = ref.node.getChild('CodeInfo');
        const language = codeLanguage(info ? view.state.sliceDoc(info.from, info.to) : '');
        if (!language || native.has(language) || ['text', 'txt', 'plaintext', 'mermaid', 'math'].includes(language)) return false;
        const sourceKey = ref.from + ':' + ref.to + ':' + language;
        const parts = this.spans.get(sourceKey) ?? ref.node.getChildren('CodeText').map(text => ({ from: text.from, to: text.to }));
        this.spans.set(sourceKey, parts);
        let viewportFrom = Infinity, viewportTo = -1;
        for (const range of view.visibleRanges) { viewportFrom = Math.min(viewportFrom, range.from); viewportTo = Math.max(viewportTo, range.to); }
        const known = this.sources.get(sourceKey);
        if (known && (viewportFrom === Infinity || known.coverFrom <= viewportFrom && known.coverTo >= viewportTo)) {
          known.tokens = previous.get(known.key) ?? known.tokens ?? this.cache.get(known.key);
          blocks.push(known); return false;
        }
        const windowed = visibleCodeSource(parts, view.visibleRanges, (from, to) => view.state.sliceDoc(from, to));
        if (windowed.source) {
          const { source, segments, coverFrom, coverTo } = windowed;
          const key = language + '\0' + coverFrom + '\0' + coverTo + '\0' + source;
          const block = { language, source, key, segments, coverFrom, coverTo, tokens: previous.get(key) ?? this.cache.get(key) };
          blocks.push(block); this.sources.set(sourceKey, block); this.sourceSize += source.length;
          while (this.sources.size > 32 || this.sourceSize > CACHE_CHARS * 2) {
            const oldest = this.sources.keys().next().value!;
            this.sourceSize -= this.sources.get(oldest)!.source.length; this.sources.delete(oldest);
          }
        }
        return false;
      } });
      this.blocks = blocks;
      const marks: Range<Decoration>[] = [];
      for (const block of blocks) {
        const tokens = block.tokens;
        if (!tokens) continue;
        for (const token of visibleCodeTokens(tokens, block.segments, view.visibleRanges))
          marks.push(Decoration.mark({ class: token.classes }).range(token.from, token.to));
      }
      this.decorations = Decoration.set(marks, true);
      this.request();
    }
    private request() {
      if (this.pending || this.failed || this.destroyed || typeof Worker === 'undefined') return;
      const block = this.blocks.find(block => !block.tokens);
      if (!block) return;
      try {
        if (!this.worker) {
          this.worker = new Worker(new URL('./code-worker.ts', import.meta.url));
          this.worker.onmessage = (event: MessageEvent<{ id: number; tokens?: CodeToken[]; error?: string }>) => {
            if (this.destroyed || event.data.id !== this.pending?.id) return;
            const done = this.pending.block;
            this.pending = null;
            if (event.data.error) { this.fail(event.data.error); return; }
            // 结果只按语言和内容缓存；装饰始终重取当前语法树坐标，不复用请求时的旧位置。
            const tokens = event.data.tokens ?? [];
            for (const active of this.blocks) if (active.key === done.key) active.tokens = tokens;
            this.cache.set(done.key, tokens);
            this.cacheSize += done.key.length + tokens.length * 24;
            while (this.cache.size > 32 || this.cacheSize > CACHE_CHARS) {
              const oldest = this.cache.keys().next().value!;
              this.cacheSize -= oldest.length + this.cache.get(oldest)!.length * 24; this.cache.delete(oldest);
            }
            clearTimeout(this.notify);
            this.notify = setTimeout(() => {
              if (!this.destroyed) this.view.dispatch({ effects: highlighted.of() });
            }, 0);
          };
          this.worker.onerror = () => this.fail('Offline code highlighter failed to load');
        }
        this.pending = { id: ++this.sequence, block };
        this.worker.postMessage({ id: this.sequence, language: block.language, source: block.source });
      } catch (error) { this.fail(error); }
    }
    private fail(error: unknown) {
      this.failed = true; this.pending = null; this.worker?.terminate(); this.worker = null;
      console.warn('Markdown code highlight unavailable', error);
    }
    destroy() {
      this.destroyed = true; clearTimeout(this.notify); this.worker?.terminate();
      this.cache.clear(); this.sources.clear(); this.spans.clear(); this.blocks = []; this.pending = null;
    }
  }, { decorations: plugin => plugin.decorations });
}
