// markdown-view —— 分屏右栏块级渲染缓存（007 v0.16 规则 24 / AC-28，UX-C2）。
// 防抖重渲不再整篇重建：按顶层块切分（Lezer 语法树顶层节点，连续列表归并），
// 块渲染结果以「源文本哈希 + 引用式定义集合 + 解析选项 + 主题」为键缓存（data-block-hash
// 标记），重渲时仅对源文本变化的块同步 Lezer 序列化并替换 DOM，未变块 DOM 原样保留
// （节点同一性保持——防跳顶锚机制随块级替换天然成立：锚块未变 offsetTop 不动）。
// 引用式定义由全文 metadata 提供（测试 seam 仍接前置定义）；定义集合参与每块键，
// 集合变化自然全量失效（等效清空，不静默复用旧解析）。
// 失效与上限：挂载新实例（文档切换）/主题或解析选项变更清空；上限 4096 块 LRU 淘汰。
// 观感不变量：分块与整篇渲染拼接顺序一致（按文档序 append，未变块复用原节点）。
import { TreeFragment, type Tree } from '@lezer/common';
import {
  renderMarkdown,
  degradeUnsupportedBlocks,
  resolveLocalImages,
  installLinkGuard,
  type LinkRouteOpts,
  type PreviewEngine,
} from './preview';
import { loadMarkdownIt } from './md';
import { extractMarkdownMetadata, type MarkdownMetadata, type SourceRange } from './headings';
import { renderStaticHtml, staticMarkdownParser } from './static-html';
import { prepareStaticCode } from './static-code';
import { applyDocumentMetadata } from './preview';
import { hydrateRenders } from './render-service';
import { yieldToBrowser } from '../common/yield';

const gfmParser = staticMarkdownParser;

/** 块缓存上限（规则 24：4096 块 LRU 淘汰） */
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

/** 64 位双哈希 + 长度指纹（块键用；个人工具档碰撞概率可忽略不计）。
 *   ：多段入参逐段喂入——修前每块拼 `sig+\0+defs+\0+src` 整串再哈希，
 *  分屏重渲每轮产生 O(文档) 的临时串分配与复制；逐段等价哈希消除该复制，指纹值不变。 */
function hash(...parts: string[]): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  let length = 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const c = part.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x85ebca6b);
    }
    length += part.length;
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36) + ':' + length;
}

// ── 分片让出（D-T2-01 第二层）：首渲不再整批一口气跑 ──
// 修前全部顶层块的渲染（旧引擎往返 + DOM 构建）在无宏任务让出的循环里连续执行（块间 await 只是
// 微任务让出，不给浏览器输入/绘制机会）：~29k 块规模把主线程钉死数分钟，右栏在渲染完成前恒空。
// 对齐 parse-warmup/snapshot 的既有分片范式：片内同步工作超时或片内块数触顶即让出一次主线程。

/** 单片时间预算（ms）：与 parse-warmup ≤25ms 口径对齐，长任务保持 ≤100ms 量级 */
const SLICE_MS = 24;
/** 单片块数上限：小快块高频时时间预算不触顶，按块数兜底保证每宏任务块数有界 */
export const SLICE_BLOCKS = 64;
/** 未命中块数超过该阈值走渐进挂载（冷渲染/大批失效）：空列先上 DOM、已渲块按文档序即时追加；
 *  少量未命中（温渲染/局部编辑）维持整批原子交接——滚动锚与「无中间空白帧」不变量不变 */
const PROGRESSIVE_MISSES = 32;

/** 块内标题相对行号（缓存件复用不再逐块重解析；源前插删行只平移 startLine） */
const headingLines = new WeakMap<HTMLElement, number[]>();

/** 每块标题相对行号：整树一次线性扫描（替换逐块 extractHeadings 的独立重解析——29k 块级
 *  文档逐块起解析器是填充期可见的每块成本；新块与复用块共用同一份结果）。 */
function blockHeadingLines(text: string, tree: Tree, blocks: SplitBlock[], frontMatter: SourceRange | null): number[][] {
  const headings: number[] = [];
  tree.iterate({ enter(node) {
    if (/^(?:ATXHeading|SetextHeading)[1-6]$/.test(node.name)
      && (!frontMatter || node.from >= frontMatter.to)) headings.push(node.from);
    return undefined;
  } });
  headings.sort((a, b) => a - b);
  const out: number[][] = [];
  let cursor = 0, line = 0, index = 0;
  const advance = (to: number): void => { while (cursor < to) if (text.charCodeAt(cursor++) === 10) line++; };
  for (const block of blocks) {
    advance(block.from);
    const list: number[] = [];
    while (index < headings.length && headings[index]! < block.to) {
      advance(headings[index]!);
      list.push(line - block.startLine);
      index++;
    }
    out.push(list);
  }
  return out;
}

/** 测试注入口（异步 seam）；缺省直接同步调用 renderStaticHtml，不逐块 await。 */
export type BlockHtmlRenderer = (ctx: string) => Promise<string>;

export interface BlockCacheOpts {
  dark: boolean;
  route?: LinkRouteOpts;
  /** 图床远程图回填钩子（009 规则 10；与 renderPreviewInto 同口径，未配置不传） */
  remoteImages?: (root: ParentNode, isCurrent?: () => boolean) => void;
  /** 宿主文档/标签代际守卫，在提交 DOM 前再次检查。 */
  isCurrent?: () => boolean;
  /** 在最后一个异步任务之后、搬动旧DOM之前读取宿主的最新阅读位置。 */
  beforeCommit?: () => void;
}

export interface BlockRenderResult {
  engine: PreviewEngine;
  col: HTMLElement;
  committed: boolean;
}

/**
 * 分屏右栏块级渲染器（一次分屏挂载一个实例——文档切换即换实例=缓存清空）。
 * render() 自管列容器交接：新 col 组装完再移除旧 col（未变块 DOM 节点原样搬入新 col）。
 */
export function createBlockRenderer(renderHtml?: BlockHtmlRenderer, cap = BLOCK_CACHE_CAP) {
  const cache = new Map<string, HTMLElement>(); // 插入序即 LRU 序（命中重插触摸）
  let sig = ''; // 主题 + 解析选项签名：变更即全量清空（规则 24）
  const parser = createBlockParser();
  let generation = 0;
  let destroyed = false;

  const renderer = {
    invalidate(): void { generation++; },
    reset(): void {
      generation++;
      cache.clear();
      parser.reset();
    },
    destroy(): void { destroyed = true; renderer.reset(); },

    async render(host: HTMLElement, text: string, opts: BlockCacheOpts): Promise<BlockRenderResult> {
      const version = ++generation;
      const current = (): boolean => !destroyed && version === generation && (opts.isCurrent?.() ?? true);
      const baseDir = opts.route?.baseDir() ?? null;
      let metadata: MarkdownMetadata | undefined;
      try {
        // FC 收口 1 就绪屏障 + 收口 2：屏障在 try 内——就绪失败也走回退（回退处的
        // loadMarkdownIt 经 loader 重置重试）；提取/解析异常同样走既有回退不冒泡
        // （修前提取在 try 之外）。注入 renderHtml 的测试 seam 不设屏障——其挂起任务
        // 作废语义要求 render() 同步进入注入 executor（await 会推迟到微任务），
        // seam 路径的就绪由模块加载预取保证（测试体在微任务后执行）。
        if (!renderHtml) await loadMarkdownIt();
        const tree = parser.parse(text);
        const defs = refDefLines(text, tree);
        metadata = extractMarkdownMetadata(text, tree);
        const documentContext = defs.some(d => /^\[\^/.test(d) || /^\[[^\]]+\]:\s*$/.test(d))
          || /^ {0,3}\[[^\]\r\n]+\]:[^\n]*\n[ \t]+\S/m.test(text)
          || !!metadata.frontMatter || /^\s*\[toc\]\s*$/im.test(text);
        const defsPrefix = !documentContext && defs.length ? defs.join('\n') + '\n\n' : '';
        const nextSig = `${opts.dark ? 'd' : 'l'}|${baseDir}`;
        // 引用/脚注依赖全文上下文（含多行定义与编号），交给渲染器一次解析。
        const blocks = documentContext
          ? [{ from: 0, to: text.length, src: text, startLine: 0 }]
          : splitTopBlocks(text, tree);
        if (!renderHtml) await prepareStaticCode(text, tree);
        if (!current()) return { engine: 'lezer', col: document.createElement('div'), committed: false };
        const col = document.createElement('div');
        col.className = 'md-col';
        // 签名变更即清空（规则 24）：提前到渲染起点——分片路径中新渲染块在循环内即入缓存，
        // 不能等整轮提交后再清；键含签名，清空语义不变（主题/解析选项变更全量失效）
        if (nextSig !== sig) { cache.clear(); sig = nextSig; }
        // 键与未命中先行一遍算清（O(文档)）：据此选渐进/原子两条提交路径（缓存语义两路一致）
        const occurrences = new Map<string, number>();
        const entries = blocks.map(b => {
          const fingerprint = hash(nextSig, '\u0000', defsPrefix, '\u0000', b.src);
          const ordinal = occurrences.get(fingerprint) ?? 0;
          occurrences.set(fingerprint, ordinal + 1);
          const key = `${fingerprint}:${ordinal}`;
          return { b, key, el: cache.get(key) };
        });
        const progressive = entries.filter(e => !e.el).length > PROGRESSIVE_MISSES;
        // 每块标题行号一次算清（新块不再逐块独立解析块源——29k 块级文档的可感每块成本）。
        const headingLinesByBlock = blockHeadingLines(text, tree, blocks, metadata.frontMatter);
        // 块件就绪处理：行锚/标题行号/图片解析/入缓存（LRU 触碰与淘汰）。
        const prepare = (el: HTMLElement, key: string, b: SplitBlock, index: number): void => {
          // 普通段落也作为同步锚，避免无标题长文或段落内写作只能定位到上一个标题。
          if (!documentContext) el.firstElementChild?.setAttribute('data-line', String(b.startLine));
          // 源码前方插删行后，复用 DOM 的定位信息也必须更新（标题行号随 startLine 平移）。
          let lines = headingLines.get(el);
          if (!lines) { lines = headingLinesByBlock[index] ?? []; headingLines.set(el, lines); }
          const els = el.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6');
          for (let i = 0; i < Math.min(lines.length, els.length); i++) {
            els[i].setAttribute('data-line', String(b.startLine + lines[i]!));
          }
          resolveLocalImages(el, baseDir, current);
          opts.remoteImages?.(el, current); // 复用 DOM 也重试此前失败的图片。
          cache.delete(key);
          cache.set(key, el);
          while (cache.size > cap) cache.delete(cache.keys().next().value as string);
        };
        if (progressive) {
          // 渐进挂载（D-T2-01 第二层）：空列先上 DOM、旧列即撤，已渲块按文档序即时追加——
          // 冷渲染用户先看到顶部内容，而不是等全部块渲完（修前主线程数分钟实心阻塞、首块永不出现）
          opts.beforeCommit?.();
          if (opts.route) installLinkGuard(col, opts.route);
          const old = host.firstElementChild;
          host.appendChild(col);
          old?.remove();
        }
        const elements: Array<{ el: HTMLElement; key: string; block: SplitBlock; i: number }> = [];
        // D-T2-03（A）：片内积累 DocumentFragment、片边界一次挂载——渐进路径修前每块一次
        // appendChild 到在档 col，29k 块 = 29k 次活布局/样式失效；批量后 64 块/次（456 次）。
        // 渐进可见性语义不变：首片仍在首个片边界（≤SLICE_MS）内上屏。
        let fragment = document.createDocumentFragment();
        const flush = (): void => { if (fragment.firstChild) col.appendChild(fragment); };
        let sliceDeadline = performance.now() + SLICE_MS;
        let sliceBlocks = 0;
        for (let i = 0; i < entries.length; i++) {
          if (!current()) return { engine: 'lezer', col, committed: false };
          const { b, key } = entries[i]!;
          let el = entries[i]!.el;
          if (!el) {
            el = document.createElement('div');
            // 块容器使用与整篇预览相同的排版类，使局部渲染保持样式一致。
            el.className = 'md-block md-reset';
            el.dataset.blockHash = key;
            el.innerHTML = renderHtml ? await renderHtml(defsPrefix + b.src) : renderStaticHtml(text, tree, metadata, b.from, b.to);
            if (!current()) return { engine: 'lezer', col, committed: false };
            degradeUnsupportedBlocks(el);
            // 渐进路径新块即时就绪入缓存：片间被作废（编辑 invalidate）时已渲进度不丢，
            // 补跑从缓存续渲；原子路径仍集中在提交时处理（口径同修前）
            if (progressive) prepare(el, key, b, i);
          } else if (progressive) prepare(el, key, b, i);
          if (progressive) fragment.appendChild(el);
          else elements.push({ el, key, block: b, i });
          // 分片让出：片内时间预算或块数任一触顶即让出主线程（宏任务），主线程保持响应；
          // 让出返回后复查代际——过期任务在片边界中止，不继续渲染也不触碰 DOM/缓存
          sliceBlocks++;
          if (i + 1 < entries.length && (sliceBlocks >= SLICE_BLOCKS || performance.now() >= sliceDeadline)) {
            if (progressive) flush(); // 片边界批量上屏（fragment 复用：appendChild 后已空）
            await yieldToBrowser();
            if (!current()) return { engine: 'lezer', col, committed: false };
            sliceDeadline = performance.now() + SLICE_MS;
            sliceBlocks = 0;
          }
        }
        if (!current()) return { engine: 'lezer', col, committed: false };
        if (progressive) flush();
        if (!progressive) {
          // 原子交接（温渲染/少量未命中）：所有 await 完成且代际仍有效，才触碰旧 DOM——
          // 过期任务不能搬走当前列的节点；未变块原样搬入新 col，无中间空白帧
          opts.beforeCommit?.();
          for (const { el, key, block: b, i } of elements) {
            prepare(el, key, b, i);
            col.appendChild(el);
          }
          const old = host.firstElementChild;
          host.appendChild(col);
          old?.remove();
          if (opts.route) installLinkGuard(col, opts.route);
        }
        // ID 必须以完整文档消歧，不能在每个缓存块中重新从零编号。
        applyDocumentMetadata(col, text, metadata);
        hydrateRenders(col, metadata.renderBlocks, opts.dark, current);
        return { engine: 'lezer', col, committed: true };
      } catch {
        // 序列化/高亮资产异常：整篇 markdown-it 回退，缓存不参与。
        await loadMarkdownIt(); // 共享单例：模块加载已预取，此处通常零等待（未就绪时等待而非失败）
        const fb = document.createElement('div');
        if (!current()) return { engine: 'fallback', col: fb, committed: false };
        fb.className = 'md-col md-fallback';
        fb.innerHTML = renderMarkdown(text);
        if (opts.route) installLinkGuard(fb, opts.route);
        resolveLocalImages(fb, baseDir, current);
        opts.remoteImages?.(fb, current);
        opts.beforeCommit?.();
        const old = host.firstElementChild;
        host.appendChild(fb);
        old?.remove();
        // 提取若在 try 内失败则无块表可水合（回退 HTML 保留占位，不冒泡）
        hydrateRenders(fb, metadata?.renderBlocks ?? [], opts.dark, current);
        return { engine: 'fallback', col: fb, committed: true };
      }
    },
  };
  return renderer;
}
