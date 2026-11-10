// markdown-view —— Markdown 统一渲染（007 v0.42 规则 16 RenderEngine，决策 011）
// 主路径：Lezer 单源静态序列化（renderStaticHtml，与分屏块缓存/IR 同一语法树配置）；
// 序列化或高亮资产异常回退自研 markdown-it（可读可用，md-fallback 降级标记）。
// markdown-it 代码块复用 Lezer 高亮；标题 data-line 锚点（大纲点击/滚动联动）两路径均提供。
// 007 v0.11（R1）：外链一律拦截——Ctrl+点击经系统浏览器打开、普通点击不导航、
// .md 相对链接新标签、#锚点页内跳转；本地相对路径图片经 asset 协议解析。
// v0.42（D-T2-05）：旧第三方组件 退出渲染路径、资产不随包；观感一致由共享排版令牌与
// 后处理管线（applyDocumentMetadata/degrade/resolveLocalImages/hydrateRenders）保证。
import { zassetUrl } from '../common/ipc';
import { t } from '../common/i18n';
import { zassetAllow } from '../common/ipc';
import { extractMarkdownMetadata, previewSource, type MarkdownMetadata, type FootnoteItem } from './headings';
import emojiTable from './unicode-emojis.json';
import { renderPlaceholder } from './render-model';
import { markdownIt } from './md';
import { readingSurface } from './reading-surface';
import type { MarkdownBlock } from './document-model';
import { renderFootnotesHtml } from './static-html';
export { extractHeadings, extractHeadingsReady, type HeadingItem } from './headings';

/** Unicode 表情别名表（随包 JSON，v0.42 起不再经旧引擎自举）；md 行内规则与 IR 共用默认值。 */
const unicodeEmojiValues: Readonly<Record<string, string>> = emojiTable;
export function loadUnicodeEmojis(): Promise<Readonly<Record<string, string>>> {
  return Promise.resolve(unicodeEmojiValues);
}

// markdown-it 实例与行内规则/标题锚点/代码高亮配置已收编为共享惰性单例（./md，
// perf-silk Pass 1 FC①）：preview（回退渲染/行内投影）与 static-html（链接校验/实体
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

/** 安全降级也按原文块更新，文档级引用与脚注编号继续使用同一份元数据。 */
export function renderMarkdownBlock(text: string, block: MarkdownBlock, metadata: MarkdownMetadata): string {
  if (block.kind === 'FootnoteDefinition' || block.kind === 'LinkReference') return '';
  if (block.kind === 'Footnotes') return renderFootnotesHtml(metadata);
  if (block.kind === 'FrontMatter') return '<pre class="md-frontmatter">' + block.src.trimEnd().replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' })[c]!) + '</pre>';
  let source = block.src, prefix = 'ZiEditRENDERTOKEN';
  while (source.includes(prefix)) prefix += 'X';
  const renders = metadata.renderBlocks.filter(item => item.from >= block.from && item.to <= block.to);
  for (let i = renders.length - 1; i >= 0; i--) {
    const item = renders[i]!, from = item.from - block.from, to = item.to - block.from;
    source = source.slice(0, from) + prefix + i + 'END' + '\n'.repeat((text.slice(item.from, item.to).match(/\n/g) ?? []).length) + source.slice(to);
  }
  let html = markdownIt().render(source, { references: metadata.references, footnotes: new Map(metadata.footnotes.map(note => [note.label, note])) });
  renders.forEach((item, i) => {
    const token = prefix + i + 'END', placeholder = renderPlaceholder(item);
    if (item.display) html = html.replace('<p>' + token + '</p>', placeholder);
    html = html.replace(token, placeholder);
  });
  return html;
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
    if (definitions.some((element, index) => element !== list.children[index])) list.append(...definitions);
  }
}

/** 全文预览与分屏共用标题、目录和 Front Matter；不依赖旧引擎私有标题ID。 */
export function applyDocumentMetadata(root: HTMLElement, source: string, metadata: MarkdownMetadata): void {
  alignFootnotes(root, metadata);
  const heads = root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6');
  for (let i = 0; i < Math.min(heads.length, metadata.headings.length); i++) {
    heads[i]!.id = metadata.headings[i]!.id; heads[i]!.dataset.line = String(metadata.headings[i]!.line);
  }
  if (metadata.frontMatter && !root.querySelector('[data-kind="FrontMatter"]')) {
    root.querySelectorAll('.md-frontmatter').forEach(el => el.remove());
    const pre = document.createElement('pre'); pre.className = 'md-frontmatter'; pre.textContent = source.slice(0, metadata.frontMatter.to).trimEnd();
    root.prepend(pre);
  }
  const placeholders = [...root.querySelectorAll<HTMLElement>('p,.md-toc')].filter(el => /^\[toc\]$/i.test(el.textContent?.trim() ?? '') || el.classList.contains('md-toc'));
  for (const placeholder of placeholders) {
    const signature = JSON.stringify(metadata.headings.map(heading => [heading.level, heading.id, heading.text]));
    if (placeholder.dataset.toc === signature) continue;
    const nav = document.createElement('nav'); nav.className = 'md-toc'; nav.setAttribute('aria-label', t('md.toc'));
    nav.dataset.toc = signature;
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

/** 阅读面的位置均来自完整块索引；未挂载的正文没有有效布局。 */
export function previewTopLine(scroller: HTMLElement): number | null {
  return readingSurface(scroller)?.capture().line ?? null;
}
export function previewVisibleLines(scroller: HTMLElement): { first: number; last: number } | null {
  return readingSurface(scroller)?.visibleLines() ?? null;
}
export function previewScrollToLine(scroller: HTMLElement, line: number, align: 'start' | 'center' = 'start'): boolean {
  const surface = readingSurface(scroller);
  if (!surface) return false;
  surface.restore({ line, surface: 'preview' }, align);
  scroller.dispatchEvent(new Event('md-navigate'));
  return true;
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
 * 与分屏共用固定正文与增量块提交；Worker 负责派生数据，正文节点保留供选择与查找。
 */
const previewRenderers = new WeakMap<HTMLElement, ReturnType<typeof import('./blockcache')['createBlockRenderer']>>();

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
  let renderer = previewRenderers.get(host);
  if (!renderer) {
    const { createBlockRenderer } = await import('./blockcache');
    renderer = previewRenderers.get(host) ?? createBlockRenderer();
    previewRenderers.set(host, renderer);
  }
  return renderer.render(host, text, opts);
}

/** 独立阅读宿主卸载时结束 Worker、观察器与在途提交。 */
export function destroyPreview(host: HTMLElement): void {
  previewRenderers.get(host)?.destroy(); previewRenderers.delete(host);
}

// ── 链接守卫（007 v0.11 规则 R1：预览/即时渲染统一拦截链接点击，WebView 永不离开应用） ──
// 静态面 capture 阶段 a[href] 守卫与 CM6 IR 共用 routeLinkHref，禁止默认 WebView 导航。

const EXTERNAL_HREF = /^(https?:|mailto:|tel:)/i;
const MD_HREF = /\.md(?:[?#].*)?$/i;

export function isExternalHref(href: string): boolean { return EXTERNAL_HREF.test(href); }

/** UNC 主机（`\\server\share` 或 `//server/share`）。盘符路径返回 null。 */
export function uncHost(path: string): string | null {
  const normalized = path.replace(/\\/g, '/');
  const match = /^\/\/([^/]+)/.exec(normalized);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * 本地图片的授权路径。http(s)、data、asset 等不在这里处理。
 * 文档所在共享以外的 UNC 返回 null：打开 Markdown 不得去访问任意主机。
 * 盘符绝对路径保留，草稿贴图和显式本地图仍走 zasset。
 */
export function localImagePath(src: string, baseDir: string | null): string | null {
  if (!src || !baseDir || /^(https?:|data:|asset:|blob:|tauri:|\/\/)/i.test(src)) return null;
  const path = joinRelPath(baseDir, decodeLocalRef(src.split(/[?#]/)[0]!));
  const imageHost = uncHost(path);
  if (imageHost && imageHost !== uncHost(baseDir)) return null;
  return path;
}

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
    const target = scope.querySelector(`[id="${CSS.escape(id)}"]`);
    const host = target?.closest<HTMLElement>('.md-preview');
    const surface = host && readingSurface(host);
    if (target && surface) surface.reveal(target);
    else target?.scrollIntoView({ block: 'start' });
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
  const internals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  const assetAvailable = !!internals;
  for (const img of root.querySelectorAll<HTMLImageElement>('img[src]')) {
    const src = img.getAttribute('src') ?? '';
    if (!src || /^(https?:|data:|asset:|blob:|tauri:|\/\/)/i.test(src)) continue;
    img.dataset.mdSrc = src;
    const path = localImagePath(src, baseDir);
    if (!path) {
      img.dataset.mdBroken = '1';
      img.removeAttribute('src');
      continue;
    }
    if (!assetAvailable) {
      console.warn(t('md.localImageUnavailable'));
      img.dataset.mdBroken = '1';
      img.title = t('md.localImageUnavailable');
      img.alt ||= img.title;
      continue;
    }
    const pending = localRequests.get(img);
    if (pending?.src === src && pending.path === path && pending.current()) continue;
    const request = { src, path, current: isCurrent };
    localRequests.set(img, request);
    void zassetAllow(path).then(() => {
      if (localRequests.get(img) !== request) return;
      localRequests.delete(img);
      if (!isCurrent() || img.getAttribute('src') !== src) return;
      delete img.dataset.mdBroken;
      img.src = zassetUrl(path);
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
