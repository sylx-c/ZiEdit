// markdown-view —— Markdown 统一渲染（007 v0.42 规则 16 RenderEngine，决策 011）
// 主路径：Lezer 单源静态序列化（renderStaticHtml，与分屏块缓存/IR 同一语法树配置）；
// 序列化或高亮资产异常回退自研 markdown-it（可读可用，md-fallback 降级标记）。
// markdown-it 代码块复用 Lezer 高亮；标题 data-line 锚点（大纲点击/滚动联动）两路径均提供。
// 007 v0.11（R1）：外链一律拦截——Ctrl+点击经系统浏览器打开、普通点击不导航、
// .md 相对链接新标签、#锚点页内跳转；本地相对路径图片经 asset 协议解析。
// v0.42（D-T2-05）：旧第三方组件 退出渲染路径、资产不随包；观感一致由共享排版令牌与
// 后处理管线（applyDocumentMetadata/degrade/resolveLocalImages/hydrateRenders）保证。
import { convertFileSrc } from '@tauri-apps/api/core';
import { t } from '../common/i18n';
import { allowAssetFile } from '../common/ipc';
import { extractMarkdownMetadata, previewSource, type MarkdownMetadata, type FootnoteItem } from './headings';
import { renderStaticHtml, staticMarkdownParser } from './static-html';
import { prepareStaticCode } from './static-code';
import emojiTable from './unicode-emojis.json';
import { renderPlaceholder } from './render-model';
import { hydrateRenders } from './render-service';
import { loadMarkdownIt, markdownIt } from './md';
export { extractHeadings, extractHeadingsReady, type HeadingItem } from './headings';

/** Unicode 表情别名表（随包 JSON，v0.42 起不再经旧引擎自举）；md 行内规则与 IR 共用默认值。 */
const unicodeEmojiValues: Readonly<Record<string, string>> = emojiTable;
export function loadUnicodeEmojis(): Promise<Readonly<Record<string, string>>> {
  return Promise.resolve(unicodeEmojiValues);
}

// markdown-it 实例与行内规则/标题锚点/代码高亮配置已收编为共享惰性单例（./md，
//）：preview（回退渲染/行内投影）与 static-html（链接校验/实体
// 解码）共用同一实例，规则只注册一次。

/** 渲染 Markdown 文本为预览 HTML（markdown-it 回退路径用） */
export function renderMarkdown(text: string): string {
  const metadata = extractMarkdownMetadata(text);
  let source = previewSource(text, metadata), prefix = 'ZiEditRENDERTOKEN';
  while (source.includes(prefix)) prefix += 'X';
  for (let i = metadata.renderBlocks.length - 1; i >= 0; i--) {
    const block = metadata.renderBlocks[i]!;
    source = source.slice(0, block.from) + prefix + i + 'END' + '\n'.repeat((source.slice(block.from, block.to).match(/\n/g) ?? []).length)
      + source.slice(block.to);
  }
  let html = markdownIt().render(source);
  metadata.renderBlocks.forEach((block, index) => {
    const token = prefix + index + 'END', placeholder = renderPlaceholder(block);
    html = block.display ? html.replace('<p>' + token + '</p>', placeholder) : html;
    html = html.replace(token, placeholder);
  });
  if (typeof document === 'undefined') return html;
  const host = document.createElement('div'); host.innerHTML = html;
  applyDocumentMetadata(host, text, metadata); return host.innerHTML;
}

/** 预览区中不大于源码行 line 的最近标题锚点（预览/分屏模式下大纲点击与滚动联动用） */
export function previewAnchorBefore(host: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestLine = -1;
  for (const el of host.querySelectorAll<HTMLElement>('[data-line]')) {
    const l = parseInt(el.dataset.line ?? '', 10);
    if (Number.isFinite(l) && l <= line && l > bestLine) {
      best = el;
      bestLine = l;
    }
  }
  return best;
}

// ── 标题提取（自 wysiwyg.ts 迁入，v0.8 补 line 字段：预览路径 data-line 注入与大纲共用一源） ──

/** 行内语法沿用静态回退解析器，HTML 禁用与链接校验保持同一策略。 */
export function renderMarkdownInline(text: string, references?: Record<string, { href: string; title: string }>, emojis = unicodeEmojiValues,
  footnotes?: ReadonlyMap<string, FootnoteItem>): string {
  return markdownIt().renderInline(text, { references, emojis, footnotes });
}

/** 复用解析器的实体规则；调用方只能把解码结果作为文字投影。 */
export function decodeMarkdownEntity(source: string): string {
  return markdownIt().utils.unescapeAll(source);
}

const originalFootnoteAttributes = new WeakMap<Element, Map<string, string>>();

/** 旧引擎按定义顺序编号，三面统一到索引的首次引用顺序；缓存节点重用时仍从原ID映射。 */
function alignFootnotes(root: HTMLElement, metadata: MarkdownMetadata): void {
  const numbers = new Map([...metadata.footnotes].sort((a, b) => a.from - b.from).map((note, i) => [i + 1, note.number]));
  for (const element of root.querySelectorAll('[id^="footnotes-"],a[href^="#footnotes-"]')) {
    let original = originalFootnoteAttributes.get(element);
    if (!original) { original = new Map(); originalFootnoteAttributes.set(element, original); }
    for (const attribute of ['id', 'href']) {
      const value = original.get(attribute) ?? element.getAttribute(attribute);
      if (!value) continue;
      original.set(attribute, value);
      element.setAttribute(attribute, value.replace(/^(#?footnotes-(?:ref|def)-)(\d+)/, (all, prefix: string, number: string) => {
        const mapped = numbers.get(Number(number)); return mapped ? prefix + mapped : all;
      }));
    }
    if (element.matches('.footnotes-ref a')) element.textContent = element.getAttribute('href')?.match(/-(\d+)$/)?.[1] ?? element.textContent;
  }
  for (const list of root.querySelectorAll('.footnotes-defs-ol')) {
    const definitions = [...list.children].sort((a, b) => Number(a.id.match(/\d+$/)?.[0]) - Number(b.id.match(/\d+$/)?.[0]));
    list.append(...definitions);
  }
}

/** 全文预览与分屏共用标题、目录和 Front Matter；不依赖旧引擎私有标题ID。 */
export function applyDocumentMetadata(root: HTMLElement, source: string, metadata: MarkdownMetadata): void {
  alignFootnotes(root, metadata);
  const heads = root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6');
  for (let i = 0; i < Math.min(heads.length, metadata.headings.length); i++) {
    heads[i]!.id = metadata.headings[i]!.id; heads[i]!.dataset.line = String(metadata.headings[i]!.line);
  }
  if (metadata.frontMatter) {
    root.querySelectorAll('.md-frontmatter').forEach(el => el.remove());
    const pre = document.createElement('pre'); pre.className = 'md-frontmatter'; pre.textContent = source.slice(0, metadata.frontMatter.to).trimEnd();
    root.prepend(pre);
  }
  const placeholders = [...root.querySelectorAll<HTMLElement>('p,.md-toc')].filter(el => /^\[toc\]$/i.test(el.textContent?.trim() ?? '') || el.classList.contains('md-toc'));
  for (const placeholder of placeholders) {
    const nav = document.createElement('nav'); nav.className = 'md-toc'; nav.setAttribute('aria-label', t('md.toc'));
    for (const heading of metadata.headings) {
      const a = document.createElement('a'); a.href = '#' + heading.id; a.textContent = heading.text;
      a.style.paddingInlineStart = (heading.level - 1) * 16 + 'px'; nav.append(a);
    }
    placeholder.replaceWith(nav);
  }
}

export function decodeLocalRef(ref: string): string {
  try { return decodeURIComponent(ref); } catch { return ref; }
}

// ── 静态渲染（007 v0.42 规则 16）：Lezer 单源序列化主路径 + markdown-it 异常回退 ──

/** 代码块语言补全表（P2；覆盖随包 hljs 核心包 + third-languages 的常用集，手选排序） */
export const CODE_HINT_LANGS: string[] = [
  'javascript', 'typescript', 'python', 'rust', 'go', 'java', 'c', 'cpp', 'csharp',
  'json', 'yaml', 'xml', 'html', 'css', 'scss', 'less', 'sql', 'bash', 'shell',
  'powershell', 'kotlin', 'swift', 'ruby', 'php', 'lua', 'perl', 'r', 'markdown',
  'diff', 'makefile', 'dockerfile', 'ini', 'toml', 'latex', 'matlab', 'protobuf',
  'graphql', 'cmake', 'dart', 'elixir', 'clojure', 'haskell', 'fortran', 'tcl',
  'plaintext',
];

/** 分屏跟随锚（P2，007 规则 6 v2.0）：重渲前记「视口顶部块」——任意块级元素都算（标题块带
 *  data-line 用行号，其余用文本前缀），不依赖标题。修前只按标题 [data-line] 重对齐：文档上方
 *  无标题时 anchor=null，重渲后 scrollTop 归零停顶部（用户反馈「一编辑右侧滚回最上面」）。 */
function visibleBlocks(col: HTMLElement): HTMLElement[] {
  // 分屏缓存包装层display:contents没有自己的几何框，滚动锚点必须取真实正文块。
  return Array.from(col.children).flatMap(el => el.classList.contains('md-block')
    ? Array.from(el.children) as HTMLElement[] : [el as HTMLElement]);
}
export function captureTopBlock(scroller: HTMLElement): { line: number | null; text: string; offset: number } | null {
  const col = scroller.firstElementChild as HTMLElement | null;
  if (!col) return null;
  const top = scroller.scrollTop;
  const kids = visibleBlocks(col);
  // 视口顶块 = 首个「底边低于视口顶」的块（部分可见即算——编辑发生在可视块上，锚必须跟它走）
  const el = kids.find(k => k.offsetTop + k.offsetHeight > top + 4) ?? kids[0];
  if (!el) return null;
  const dl = el.getAttribute('data-line');
  const n = dl != null ? Number(dl) : NaN;
  return { line: Number.isFinite(n) ? n : null, text: (el.textContent ?? '').trim().slice(0, 48), offset: top - el.offsetTop };
}

/** 重渲后恢复到 captureTopBlock 记下的块（行号优先、文本前缀兜底、都不中回退原 scrollTop） */
export function restoreTopBlock(scroller: HTMLElement, anchor: { line: number | null; text: string; offset?: number } | null, fallbackScroll: number): HTMLElement | null {
  const col = scroller.firstElementChild as HTMLElement | null;
  if (!col) return null;
  let el: HTMLElement | null = null;
  if (anchor?.line != null) el = visibleBlocks(col).find(k => k.getAttribute('data-line') === String(anchor.line)) ?? null;
  if (!el && anchor?.text) {
    el = visibleBlocks(col).find(k => (k.textContent ?? '').trim().startsWith(anchor.text)) ?? null;
  }
  scroller.scrollTop = el ? Math.max(0, el.offsetTop + (anchor?.offset ?? -8)) : fallbackScroll;
  return el;
}

// 表情别名仅映射 Unicode 文本；来源及许可见 THIRD-PARTY-NOTICES.md。

/** 渲染结果标记：lezer=序列化主路径，fallback=markdown-it 回退（AC-18 降级标记） */
export type PreviewEngine = 'lezer' | 'fallback';

/** 渲染成功后的内容容器（滚动联动的锚点查询作用域） */
export interface PreviewResult {
  engine: PreviewEngine;
  col: HTMLElement;
}

/**
 * 把 Markdown 文本渲染进 host（.md-preview 滚动容器）。
 * v0.42 主路径：Lezer 序列化整篇输出（与分屏块缓存同一渲染函数）；每调用换新内层 div.md-col。
 * 序列化/高亮资产异常回退 markdown-it；route 提供时（R1）两路径都装 capture 守卫。
 */
const previewVersions = new WeakMap<HTMLElement, object>();

/** 等待代码高亮完成标记（hljs class）；测试与渐进高亮路径共用，超时 4s。 */
const CODE_READY_TIMEOUT = 4000;
export function waitForPreviewCode(root: HTMLElement): Promise<void> {
  const codes = [...root.querySelectorAll('pre > code')];
  const ready = () => codes.every(code => code.classList.contains('hljs'));
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(); }
    });
    const timer = setTimeout(() => {
      observer.disconnect(); reject(new Error('Offline code highlight timeout'));
    }, CODE_READY_TIMEOUT);
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
}

export async function renderPreviewInto(
  host: HTMLElement,
  text: string,
  opts: {
    dark: boolean;
    isCurrent?: () => boolean;
    route?: LinkRouteOpts;
    /** 图床远程图回填钩子（009 规则 10：host 过滤 + data: 内联；未配置图床时不传） */
    remoteImages?: (root: ParentNode, isCurrent?: () => boolean) => void;
  }
): Promise<PreviewResult> {
  const baseDir = opts.route?.baseDir() ?? null;
  const version = {};
  previewVersions.set(host, version);
  const current = (): boolean => previewVersions.get(host) === version && (opts.isCurrent?.() ?? true);
  const inner = document.createElement('div');
  inner.className = 'md-col';
  let metadata: MarkdownMetadata | undefined;
  try {
    // FC 收口 1 就绪屏障 + 收口 2：屏障在 try 内——就绪失败也走回退（回退处的
    // loadMarkdownIt 会经 loader 重置重试）；提取/解析异常同样走既有回退不冒泡。
    await loadMarkdownIt();
    metadata = extractMarkdownMetadata(text);
    // D-T2-05（v0.42）：Lezer 单源序列化整篇输出（与分屏块缓存同一渲染函数/语法配置）。
    const tree = staticMarkdownParser.parse(text);
    await prepareStaticCode(text, tree);
    if (!current()) return { engine: 'lezer', col: inner };
    if (opts.route) installLinkGuard(inner, opts.route);
    inner.innerHTML = renderStaticHtml(text, tree, metadata);
    // data-line 锚点注入：源文本标题与渲染 DOM 标题按文档序 zip（数量不齐按 min 截断）
    applyDocumentMetadata(inner, text, metadata);
    degradeUnsupportedBlocks(inner);
    resolveLocalImages(inner, baseDir, current);
    opts.remoteImages?.(inner, current);
    host.replaceChildren(inner);
    hydrateRenders(inner, metadata.renderBlocks, opts.dark, current);
    return { engine: 'lezer', col: inner };
  } catch {
    // 回退：换新容器，markdown-it 输出自带 data-line（序列化/高亮资产异常路径）
    await loadMarkdownIt(); // 共享单例：模块加载已预取，此处通常零等待（未就绪时等待而非失败）
    const fb = document.createElement('div');
    if (!current()) return { engine: 'fallback', col: fb };
    fb.className = 'md-col md-fallback';
    fb.innerHTML = renderMarkdown(text);
    host.replaceChildren(fb);
    // 提取若在 try 内失败则无块表可水合（回退 HTML 保留占位，不冒泡）
    hydrateRenders(fb, metadata?.renderBlocks ?? [], opts.dark, current);
    if (opts.route) installLinkGuard(fb, opts.route);
    resolveLocalImages(fb, baseDir, current);
    opts.remoteImages?.(fb, current);
    return { engine: 'fallback', col: fb };
  }
}

// ── 链接守卫（007 v0.11 规则 R1：预览/即时渲染统一拦截链接点击，WebView 永不离开应用） ──
// 静态面 capture 阶段 a[href] 守卫与 CM6 IR 共用 routeLinkHref，禁止默认 WebView 导航。

const EXTERNAL_HREF = /^(https?:|mailto:|tel:)/i;
const MD_HREF = /\.md(?:[?#].*)?$/i;

export function isExternalHref(href: string): boolean { return EXTERNAL_HREF.test(href); }

/** 路径拼接（相对链接/图片解析用）：base 目录 + 相对片段，容忍 ./ 前缀与混合分隔符（统一 /） */
export function joinRelPath(dir: string, rel: string): string {
  const ref = rel.replace(/\\/g, '/');
  const full = /^(?:[a-z]:\/|\/)/i.test(ref) ? ref : dir.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + ref;
  const root = full.match(/^(?:[a-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/i)?.[0] ?? '';
  const parts: string[] = [];
  for (const part of full.slice(root.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { parts.pop(); continue; }
    parts.push(part);
  }
  return root.replace(/\/?$/, '/') + parts.join('/');
}

/** 静态预览点击目标处的外链地址；非外链返回 null。 */
export function externalHrefAt(target: EventTarget | null): string | null {
  const el = target as HTMLElement | null;
  const a = el?.closest?.('a[href]');
  if (a) {
    const href = a.getAttribute('href') ?? '';
    if (EXTERNAL_HREF.test(href)) return href;
  }
  // IR 右键由 livepreview.ts 从 CM6 语法树取链接，不走静态 DOM 判定。
  return null;
}

export interface LinkRouteOpts {
  /** Markdown 文件所在目录（相对链接与图片的解析基点） */
  baseDir: () => string | null;
  /** .md 相对链接 → 新标签打开（app 侧 openPath） */
  openMarkdown: (absPath: string) => void;
  /** http(s)/mailto/tel → 系统浏览器（opener.openUrl，决策：零网络红线不破） */
  openExternal: (url: string) => void;
  /** 预览态普通点击的提示通道（IR 态不提示，普通点击即进入编辑） */
  hint: (msg: string) => void;
  /** true=即时渲染（普通点击进入编辑）；false=预览（普通点击提示） */
  interactive: boolean;
}

/** href 路由（两路径共用决策）：#锚点页内跳转 / Ctrl+外链交系统浏览器 / .md 相对新标签 */
export function routeLinkHref(href: string, ctrl: boolean, opts: LinkRouteOpts, scope: ParentNode): void {
  if (!href) return;
  if (href.startsWith('#')) {
    const id = decodeLocalRef(href.slice(1));
    scope.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (EXTERNAL_HREF.test(href)) {
    if (ctrl) opts.openExternal(href);
    else if (!opts.interactive) opts.hint(t('md.linkHint'));
    return;
  }
  if (MD_HREF.test(href)) {
    const dir = opts.baseDir();
    if (dir) opts.openMarkdown(joinRelPath(dir, decodeLocalRef(href.replace(/[?#].*$/, ''))));
    return;
  }
  // 其余相对引用（./file.zip 等）：不导航，预览态提示
  if (!opts.interactive) opts.hint(t('md.linkUnsupported'));
}

/** capture 阶段 a[href] 守卫（静态渲染容器统一入口；v0.16 起 IR 为 CM6 live preview，
 *  链接路由在 livepreview.ts 内建，不再走旧渲染器适配器） */
export function installLinkGuard(root: HTMLElement, opts: LinkRouteOpts): () => void {
  const onClick = (e: MouseEvent): void => {
    const a = (e.target as HTMLElement).closest?.('a[href]');
    if (!a) return;
    e.preventDefault();
    routeLinkHref(a.getAttribute('href') ?? '', e.ctrlKey || e.metaKey, opts, root);
  };
  root.addEventListener('click', onClick, true);
  return () => root.removeEventListener('click', onClick, true);
}

/** 本地相对路径图片 → asset 协议（007 v0.11：![](./a.png) 在预览可见；IR 侧为装饰件
 *  构建时解析，见 livepreview.ts）。非 Tauri 环境给出可见占位提示。
 *  009 规则 4：转换前把原始引用存 data-md-src（右键「上传到图床」取原始路径用）。 */
const localRequests = new WeakMap<HTMLImageElement, { src: string; path: string; current: () => boolean }>();

export function resolveLocalImages(root: HTMLElement, baseDir: string | null, isCurrent: () => boolean = () => true): void {
  if (!baseDir) return;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: unknown } }).__TAURI_INTERNALS__;
  const assetAvailable = typeof internals?.convertFileSrc === 'function';
  for (const img of root.querySelectorAll<HTMLImageElement>('img[src]')) {
    const src = img.getAttribute('src') ?? '';
    if (!src || /^(https?:|data:|asset:|blob:|tauri:|\/\/)/i.test(src)) continue;
    img.dataset.mdSrc = src;
    if (!assetAvailable) {
      console.warn(t('md.localImageUnavailable'));
      img.dataset.mdBroken = '1';
      img.title = t('md.localImageUnavailable');
      img.alt ||= img.title;
      continue;
    }
    const path = joinRelPath(baseDir, decodeLocalRef(src.split(/[?#]/)[0]!));
    const pending = localRequests.get(img);
    if (pending?.src === src && pending.path === path && pending.current()) continue;
    const request = { src, path, current: isCurrent };
    localRequests.set(img, request);
    void allowAssetFile(path).then(() => {
      if (localRequests.get(img) !== request) return;
      localRequests.delete(img);
      if (!isCurrent() || img.getAttribute('src') !== src) return;
      delete img.dataset.mdBroken;
      img.src = convertFileSrc(path);
    }).catch(() => {
      if (localRequests.get(img) !== request) return;
      localRequests.delete(img);
      if (isCurrent() && img.getAttribute('src') === src) img.dataset.mdBroken = '1';
    });
  }
}

// ── 未随包块降级（007 v0.11：mermaid/math 不再静默空白，按普通代码块呈现源码） ──
// v0.42：旧渲染器退场后 offlinePreviewHtml（其二次渲染前接管逻辑）随之删除——Lezer 序列化
// 直接产出 md-render-target 占位与普通代码块；degradeUnsupportedBlocks 保留为后处理幂等兜底。

/**
 * 渲染 DOM 中未随包引擎的块降级（实测 DOM 形态：引擎脚本 404 后旧渲染器留下
 * div.language-mermaid / div.language-math 承载裸源文本，或空 div）。
 * 标记 data-md-degraded 交 CSS 按代码块观感呈现；空块从同块源码 code 回填。幂等可重入。
 */
export function degradeUnsupportedBlocks(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('div.language-mermaid, div.language-math').forEach(el => {
    if (el.dataset.mdDegraded === '1') return;
    if (!el.textContent?.trim()) {
      const block = el.closest('[data-type]') ?? el.parentElement;
      const code = block?.querySelector('code[class*="language-"]');
      if (!code?.textContent?.trim()) return;
      el.textContent = code.textContent;
    }
    el.dataset.mdDegraded = '1';
  });
}
