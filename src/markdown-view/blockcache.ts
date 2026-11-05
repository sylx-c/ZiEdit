// Markdown 阅读组件：独立预览与分屏共用固定正文、增量块提交和生命周期。
import { TreeFragment, type Tree } from '@lezer/common';
import type { ChangeSet } from '@codemirror/state';
import { renderMarkdownBlock, degradeUnsupportedBlocks, resolveLocalImages, installLinkGuard,
  applyDocumentMetadata, type LinkRouteOpts, type PreviewEngine } from './preview';
import { loadMarkdownIt } from './md';
import { staticMarkdownParser } from './static-html';
import { type MarkdownMetadata } from './headings';
import { MarkdownDocumentSession, type MarkdownBlock } from './document-model';
import { MarkdownDocumentClient, type MarkdownRenderPlan } from './document-client';
export { MarkdownDocumentClient } from './document-client';
import { ReadingSurface } from './reading-surface';
import { fillReadingBlock } from './reading-dom';
import { hydrateRenders, destroyHydratedRenders, registerReadingRenderTargets } from './render-service';
import { yieldToBrowser } from '../common/yield';
import { requestIrFrame } from './frame-work';
import { userScrolledRecently } from '../common/user-scroll';

const gfmParser = staticMarkdownParser;

/** 离开正文的块缓存上限；活动正文不参与淘汰。 */
export const BLOCK_CACHE_CAP = 4096;

/** 顶层块切分结果：from/to 为文档坐标，startLine 为 0 起行号（data-line 偏移基准） */
export interface SplitBlock {
  from: number;
  to: number;
  src: string;
  startLine: number;
}

const isListNode = (name: string): boolean => name === 'BulletList' || name === 'OrderedList';

/** 按顶层块切分（Lezer 语法树顶层节点；连续列表节点且间隙只空白时归并为一个列表块） */
export function splitTopBlocks(text: string, tree = gfmParser.parse(text)): SplitBlock[] {
  const out: SplitBlock[] = [];
  let scan = 0;
  let line = 0;
  const push = (from: number, to: number): void => {
    while (scan < from) if (text.charCodeAt(scan++) === 10) line++;
    out.push({ from, to, src: text.slice(from, to), startLine: line });
  };
  let prevName = '';
  for (let n = tree.topNode.firstChild; n; n = n.nextSibling) {
    // Lezer 的缩进代码节点从正文首字符开始；切块必须保留行首缩进，否则静态解析变成段落。
    const lineStart = text.lastIndexOf('\n', n.from - 1) + 1;
    const from = /^[ \t]*$/.test(text.slice(lineStart, n.from)) ? lineStart : n.from;
    // 连续列表归并：相邻列表节点、间隙无正文（只空白/空行）→ 并入上一块
    if (
      isListNode(n.name) && isListNode(prevName) && out.length > 0
      && text.slice(out[out.length - 1]!.to, n.from).trim() === ''
    ) {
      const last = out[out.length - 1]!;
      last.to = n.to;
      last.src = text.slice(last.from, n.to);
    } else {
      push(from, n.to);
    }
    prevName = n.name;
  }
  return out;
}

// ── 引用式定义（规则 24 前置注入）：[id]: url 与脚注 [^id]: 行集合（围栏内不算） ──

const REF_DEF_LINE = /^ {0,3}\[[^\]\r\n]+\]:/;

/** 相邻快照的单区间差异保留前后树片段；围栏/列表上下文由 Lezer 自行重新解析。 */
export function createBlockParser() {
  let previous = '';
  let tree: Tree | null = null;
  return {
    reset(): void { previous = ''; tree = null; },
    parse(text: string): Tree {
      if (tree && text === previous) return tree;
      let fragments: readonly TreeFragment[] = [];
      if (tree) {
        let from = 0;
        const common = Math.min(previous.length, text.length);
        while (from < common && previous.charCodeAt(from) === text.charCodeAt(from)) from++;
        let toA = previous.length;
        let toB = text.length;
        while (toA > from && toB > from && previous.charCodeAt(toA - 1) === text.charCodeAt(toB - 1)) { toA--; toB--; }
        // GFM 表格/Setext 的分隔行会改变前一段的类型；最小字符差异不足以隔离块上下文。
        // 将相邻顶层块一起失效，避免复用已失效的段落边界，同时保留远处树片段。
        const left = tree.topNode.childBefore(from);
        const right = tree.topNode.childAfter(toA);
        const end = right?.nextSibling?.to ?? previous.length;
        from = left?.prevSibling?.from ?? 0;
        toB += end - toA;
        toA = end;
        fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: from, toA, fromB: from, toB }]);
      }
      tree = gfmParser.parse(text, fragments);
      previous = text;
      return tree;
    },
  };
}

/** 文档全部引用式链接/脚注定义行（trim 后按文档序；跳过围栏代码块内伪定义） */
export function refDefLines(text: string, tree = gfmParser.parse(text)): string[] {
  const out: string[] = [];
  const code: Array<{ from: number; to: number }> = [];
  tree.iterate({ enter(n) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') {
      code.push({ from: n.from, to: n.to });
      return false;
    }
    return undefined;
  } });
  let offset = 0;
  let c = 0;
  for (const l of text.split('\n')) {
    while (c < code.length && code[c]!.to <= offset) c++;
    if (!(c < code.length && code[c]!.from <= offset && offset < code[c]!.to) && REF_DEF_LINE.test(l)) out.push(l.trim());
    offset += l.length + 1;
  }
  return out;
}

/** 活动节点独立保留；上限仅约束已离开正文的缓存。 */
export const SLICE_BLOCKS = 128;
// 给同帧的尺寸交付、右轨与 CM 测量预留余量；正文构建不能独占整个 8ms 应用预算。
const SLICE_MS = 4;
export type BlockHtmlRenderer = (ctx: string) => Promise<string>;
export interface BlockCacheOpts {
  dark: boolean;
  route?: LinkRouteOpts;
  remoteImages?: (root: ParentNode, isCurrent?: () => boolean) => void;
  isCurrent?: () => boolean;
  beforeCommit?: () => void;
  onSurface?: (surface: ReadingSurface) => void;
}
export interface BlockRenderResult { engine: PreviewEngine; col: HTMLElement; committed: boolean }
interface MountedBlock { block: MarkdownBlock; element: HTMLElement; signature: string }

export function createBlockRenderer(renderHtml?: BlockHtmlRenderer, cap = BLOCK_CACHE_CAP, documentSession?: MarkdownDocumentClient) {
  const client = documentSession ?? new MarkdownDocumentClient();
  const local = new MarkdownDocumentSession();
  let active = new Map<string, MountedBlock>();
  const detached = new Map<string, HTMLElement[]>();
  let col: HTMLElement | null = null, surface: ReadingSurface | null = null;
  let generation = 0, destroyed = false, routeCleanup: (() => void) | undefined, route: LinkRouteOpts | undefined;
  let layoutKey = '';
  const PAGE_BLOCKS = 32;
  const pageEstimates = new WeakMap<HTMLElement, number>();
  const pageFor = (root: HTMLElement, before: HTMLElement | null): HTMLElement => {
    let page = before?.parentElement ?? root.lastElementChild as HTMLElement | null;
    if (page?.classList.contains('md-reading-page')) {
      if (page.childElementCount < PAGE_BLOCKS * 2) return page;
      if (before === page.firstElementChild) {
        const previous = page.previousElementSibling as HTMLElement | null;
        if (previous?.classList.contains('md-reading-page') && previous.childElementCount < PAGE_BLOCKS) return previous;
      }
      if (before && before !== page.firstElementChild) {
        const tail = document.createElement('div'); tail.className = 'md-reading-page';
        page.after(tail);
        for (let node: ChildNode | null = before; node;) { const next: ChildNode | null = node.nextSibling; tail.append(node); node = next; }
        return page;
      }
    }
    page = document.createElement('div'); page.className = 'md-reading-page';
    root.insertBefore(page, before?.parentElement ?? null);
    return page;
  };
  const nextBlock = (element: HTMLElement): HTMLElement | null => (element.nextElementSibling
    ?? (element.parentElement?.classList.contains('md-reading-page') ? element.parentElement.nextElementSibling?.firstElementChild : null)) as HTMLElement | null;
  const renderer = {
    get surface(): ReadingSurface | null { return surface; },
    noteChanges(changes: ChangeSet): void { client.noteChanges(changes); },
    invalidate(): void { generation++; },
    reset(): void { generation++; active.clear(); detached.clear(); local.reset(); layoutKey = ''; },
    destroy(): void { destroyed = true; renderer.reset(); if (!documentSession) client.destroy(); if (col) destroyHydratedRenders(col); surface?.destroy(); routeCleanup?.(); },
    async render(host: HTMLElement, text: string, opts: BlockCacheOpts, fallback = false): Promise<BlockRenderResult> {
      const engine: PreviewEngine = fallback ? 'fallback' : 'lezer';
      const version = ++generation;
      const current = (): boolean => !destroyed && version === generation && (opts.isCurrent?.() ?? true);
      const result = (engine: PreviewEngine, committed: boolean): BlockRenderResult => ({ engine, col: col ?? document.createElement('div'), committed });
      let metadata: MarkdownMetadata | undefined;
      try {
        let plan: MarkdownRenderPlan;
        if (renderHtml || fallback) {
          // 注入渲染器只替换序列化步骤，块身份和增量提交与生产路径一致。
          const doc = local.update(text);
          plan = { version: doc.version, blocks: doc.blocks, metadata: doc.metadata, lines: doc.lines };
        } else plan = await client.render(text);
        if (!current()) return result(engine, false);
        metadata = plan.metadata;
        const nextKey = `${opts.dark}|${opts.route?.baseDir() ?? ''}|${engine}`;
        const changedLayout = layoutKey !== nextKey;
        const cold = !col || col.parentElement !== host;
        if (cold) { col = document.createElement('div'); col.className = 'md-col'; }
        const root = col!;
        const grouped = !!root.querySelector('.md-reading-page') || (cold && plan.blocks.length > 512);
        root.classList.toggle('md-fallback', fallback);
        const defs = renderHtml && !fallback ? refDefLines(text, local.update(text).tree).join('\n') : '';
        const prefix = defs ? defs + '\n\n' : '';
        const entries: MountedBlock[] = [];
        const width = Math.max(200, host.clientWidth - 48), columns = Math.max(20, width / 7);
        // 仍以 4ms 为构建片上限，另限制节点数以约束提交布局的成本。
        // 地图合并为画布后，重内容可在同一片交付 48 块；低刷新率下不再因
        // 大量便宜段落每 24 块等待一帧而拖延整篇完成。
        const sliceBlocks = plan.metadata.renderBlocks.length || plan.blocks.some(block =>
          /List|Table|Blockquote|Code|HTML/.test(block.kind) || block.src.includes('![')) ? 48 : SLICE_BLOCKS;
        let deadline = performance.now() + SLICE_MS, count = 0, committed = false, mounted = 0, headingIndex = 0;
        const anchor = (): ReturnType<ReadingSurface['capture']> | undefined => surface?.capture();
        const commit = (): void => {
          if (!current()) return;
          opts.beforeCommit?.();
          layoutKey = nextKey;
          const keep = cold ? undefined : anchor();
          if (cold && root.parentElement !== host) {
            if (surface) destroyHydratedRenders(surface.root);
            host.replaceChildren(root); surface?.destroy(); surface = new ReadingSurface(host, root);
          }
          if (route !== opts.route) { routeCleanup?.(); route = opts.route; routeCleanup = route ? installLinkGuard(root, route) : undefined; }
          // 未变块保持原位；仅在其前插入缺失或变化的节点。
          let cursor = cold ? null : root.querySelector<HTMLElement>('.md-block');
          const added = cold ? entries.slice(mounted) : entries;
          const wanted = cold ? null : new Set(entries.map(entry => entry.element));
          const sized = new Set<HTMLElement>();
          for (const entry of added) {
            // 被替换的旧块不能挡住游标，否则后续全部未变节点都会被搬到它前面。
            while (cursor && wanted && !wanted.has(cursor)) cursor = nextBlock(cursor);
            if (entry.element !== cursor) {
              if (grouped) {
                let page = cursor?.parentElement;
                if (!page || page.childElementCount >= (cold ? PAGE_BLOCKS : PAGE_BLOCKS * 2)) page = pageFor(root, cursor);
                if (cold && page.childElementCount >= PAGE_BLOCKS) {
                  page = document.createElement('div'); page.className = 'md-reading-page'; root.append(page);
                }
                page.insertBefore(entry.element, cursor?.parentElement === page ? cursor : null);
                if (cold) {
                  pageEstimates.set(page, (pageEstimates.get(page) ?? 0) + (parseFloat(entry.element.style.containIntrinsicSize.split(' ')[1] ?? '') || 0));
                  sized.add(page);
                }
              } else root.insertBefore(entry.element, cursor);
            }
            if (!cold) cursor = nextBlock(entry.element);
            active.set(entry.block.id, entry);
          }
          for (const page of sized) page.style.containIntrinsicSize = `auto ${pageEstimates.get(page)}px`;
          surface?.update(added, plan.lines, cold);
          if (surface) opts.onSurface?.(surface);
          mounted = entries.length;
          root.dataset.renderComplete = '0';
          if (keep) surface?.restore(keep);
          committed = true;
        };
        for (const block of plan.blocks) {
          const signature = nextKey + '\0' + block.signature;
          const prior = active.get(block.id);
          let element = !changedLayout && prior?.signature === signature ? prior.element : undefined;
          if (!element) {
            const pool = detached.get(signature);
            element = pool?.pop();
            if (!element) {
              element = document.createElement('div'); element.className = 'md-block md-reset';
              // 浏览器逐帧检查 auto 块也有成本；只为大块启用离屏布局跳过。
              element.classList.toggle('md-deferred', block.src.length >= 8192 || block.endLine - block.startLine >= 64);
              if (block.htmlPending) {
                // 首批不足一个构建片时也先提交，不能为了等后续 HTML 把可读正文扣住。
                if (cold && entries.length > mounted) commit();
                await plan.htmlReady;
                if (!current()) return result(engine, false);
              }
              const html = fallback ? renderMarkdownBlock(text, block, plan.metadata) : renderHtml ? await renderHtml(prefix + block.src)
                : block.html ?? client.html.get(block.id) ?? '';
              if (!current()) return result(engine, false);
              await fillReadingBlock(element, html, current);
              if (!current()) return result(engine, false);
              degradeUnsupportedBlocks(element);
            }
            resolveLocalImages(element, opts.route?.baseDir() ?? null, current);
          }
          if (element !== prior?.element || prior.block.from !== block.from || prior.block.to !== block.to || prior.signature !== signature) {
            element.dataset.blockHash = block.id + ':' + block.signature;
            element.dataset.blockId = block.id;
            element.dataset.line = String(block.startLine);
            element.dataset.endLine = String(block.endLine);
            element.dataset.sourceFrom = String(block.from);
            element.dataset.sourceTo = String(block.to);
            element.dataset.kind = block.kind;
            element.hidden = !element.firstChild;
            element.firstElementChild?.setAttribute('data-line', String(block.startLine));
          }
          // 文档级显示信息在各自块的构建片中交付，不能在尾部再扫描整棵正文。
          const headings: MarkdownMetadata['headings'] = [];
          if (block.kind !== 'Footnotes') while (headingIndex < metadata.headings.length && metadata.headings[headingIndex]!.line < block.endLine) {
            const heading = metadata.headings[headingIndex++]!;
            if (heading.line >= block.startLine) headings.push(heading);
          }
          const toc = block.kind === 'TableOfContents' || /^\[toc\]$/i.test(block.src.trim());
          if (headings.length || toc || block.kind === 'Footnotes' || block.src.includes('[^')) {
            applyDocumentMetadata(element, text, { ...metadata, frontMatter: null, headings: toc ? metadata.headings : headings });
          }
          registerReadingRenderTargets(root, element);
          opts.remoteImages?.(element, current);
          if (cold) {
            const lines = block.src.split('\n');
            const rows = lines.reduce((n, line) => n + Math.max(1, Math.ceil(line.length / columns)), 0);
            const estimate = /Heading/.test(block.kind) ? 56 : block.kind === 'Table' ? lines.length * 32
              : block.kind === 'HorizontalRule' ? 34 : /Code/.test(block.kind) ? rows * 20 + 32 : rows * 24 + 16;
            element.style.containIntrinsicSize = `auto ${estimate}px`;
          }
          entries.push({ block, element, signature }); count++;
          if (count >= sliceBlocks || performance.now() >= deadline) {
            if (cold) commit();
            if (host.isConnected) {
              // 已有足够前方正文时，连续输入期间让出远端追加及其高度/地图更新。
              // 靠近已构建边界仍继续生产，停手后下一片接续，完整 DOM 不卸载。
              do {
                await new Promise<void>(resolve => { requestIrFrame(resolve, true); });
                if (!current()) return result(engine, false);
              } while (cold && userScrolledRecently(host, 80)
                && host.scrollHeight - host.scrollTop - host.clientHeight > host.clientHeight * 3);
            } else await yieldToBrowser();
            if (!current()) return result(engine, false);
            deadline = performance.now() + SLICE_MS; count = 0;
          }
        }
        if (!current()) return result(engine, false);
        commit();
        const used = new Set(entries.map(entry => entry.element));
        for (const entry of active.values()) if (!used.has(entry.element)) {
          entry.element.remove();
          const pool = detached.get(entry.signature) ?? [];
          pool.push(entry.element); detached.delete(entry.signature); detached.set(entry.signature, pool);
        }
        // 清理上轮未完成的尾部节点，以及被替换的旧块。
        for (const child of root.querySelectorAll<HTMLElement>('.md-block')) if (!used.has(child)) child.remove();
        for (const page of root.querySelectorAll('.md-reading-page')) if (!page.firstChild) page.remove();
        active = new Map(entries.map(entry => [entry.block.id, entry]));
        let cached = 0;
        for (const [key, pool] of [...detached].reverse()) { cached += pool.length; if (cached > cap) detached.delete(key); }
        const alive = new Set(plan.blocks.map(block => block.id));
        for (const id of client.html.keys()) if (!alive.has(id)) client.html.delete(id);
        // commit 已登记全部块。重复全量登记/恢复会覆盖用户的文字锚，还会把
        // 全文几何与公式扫描合并成一个不可抢占的尾部任务。
        await hydrateRenders(root, metadata.renderBlocks, opts.dark, current, () => surface?.contentChanged());
        if (!current()) return result(engine, false);
        root.dataset.documentVersion = String(plan.version);
        root.dataset.renderComplete = '1';
        return result(engine, committed);
      } catch {
        if (!current()) return result('fallback', false);
        if (fallback) return result('fallback', false);
        await loadMarkdownIt();
        if (!current()) return result('fallback', false);
        return renderer.render(host, text, opts, true);
      }
    },
  };
  return renderer;
}
