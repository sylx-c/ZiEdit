import { type RenderBlock } from './render-model';
import { requestIrFrame, cancelIrFrame } from '../common/render-queue';
import { userScrolledRecently, userScrollVersion } from '../common/user-scroll';

export type RenderResult = { html: string; error?: undefined } | { html?: undefined; error: string };
interface MathJaxApi {
  startup: { promise: Promise<void> };
  texReset(): void;
  tex2svgPromise(source: string): Promise<HTMLElement>;
  typesetPromise(elements: HTMLElement[]): Promise<void>;
  typesetClear(elements: HTMLElement[]): void;
}
type MathWindow = Window & { MathJax?: MathJaxApi | Record<string, unknown> };
const mathWindow = (): MathWindow => window as MathWindow;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);
const unsafeCss = (text: string): boolean => /@import|expression\(/i.test(text)
  || [...text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].some(match => !match[2]!.trim().startsWith('#'));
let mathLoader: Promise<MathJaxApi> | undefined;
let mermaidLoader: Promise<typeof import('mermaid')['default']> | undefined;
let mathQueue = Promise.resolve(), diagramQueue = Promise.resolve();
let nextId = 0;
/** 公式分片大小：无编号文档按片 typeset + 空闲让出主线程（007 规则 22 残余长任务整改） */
const MATH_SLICE = 4;
/** 需要整批语义的公式特征：编号/引用/AMS 编号环境/宏定义（跨公式状态，处理顺序影响结果） */
const MATH_BATCH_FEATURE = /\\(?:eq)?ref\s*\{|\\label\s*\{|\\begin\{(?:equation|align|gather|multline|flalign|alignat)\*?\}|\\(?:newcommand|renewcommand|providecommand|def|DeclareMathOperator)\b/;
/** 公式与阅读面水合也经应用队列，让当前视口装饰先提交。 */
const yieldIdle = (): Promise<void> => new Promise(resolve => { requestIrFrame(resolve, true); });

function localScript(path: string): Promise<void> {
  const url = new URL(path, location.href);
  if (url.origin !== location.origin || !/^\/renderers\/(?:mathjax|font)\/[\w/.-]+\.js$/.test(url.pathname)
    || url.search || url.hash) return Promise.reject(new Error('公式扩展只允许随包本地资源'));
  return new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = url.href;
    script.onload = () => { script.remove(); resolve(); };
    script.onerror = () => { script.remove(); reject(new Error('无法加载离线公式资源：' + url.pathname)); };
    document.head.append(script);
  });
}

/** 加载失败不缓存：清空记忆让下次挂载重试（修前一次失败即永久拒绝，公式/图表到重启前都不出来）。 */
function retryable<T>(task: Promise<T>, reset: () => void): Promise<T> {
  return task.catch((error: unknown) => { reset(); throw error; });
}

function loadMath(): Promise<MathJaxApi> {
  return mathLoader ??= retryable((async () => {
    mathWindow().MathJax = {
      loader: { paths: { mathjax: '/renderers/mathjax', 'mathjax-stix2': '/renderers/font' },
        load: ['input/tex-base', '[tex]/ams', '[tex]/newcommand', '[tex]/configmacros', '[tex]/textmacros', '[tex]/begingroup',
          'output/svg'], require: localScript },
      startup: { typeset: false },
      tex: { packages: ['base', 'ams', 'newcommand', 'configmacros', 'textmacros', 'begingroup'], tags: 'ams',
        inlineMath: [['\\(', '\\)']], displayMath: [['\\[', '\\]']], maxBuffer: 256 * 1024 },
      output: { font: 'mathjax-stix2', fontPath: '/renderers/font' },
      svg: { fontCache: 'none', dynamicPrefix: '/renderers/font/svg/dynamic' },
    };
    await localScript('/renderers/mathjax/startup.js');
    const api = mathWindow().MathJax as MathJaxApi;
    await api.startup.promise;
    // 初始化字体/输出器可能已用掉整片时间，首批公式不能在同一微任务链继续排版。
    await yieldIdle();
    return api;
  })(), () => { mathLoader = undefined; });
}

function loadMermaid(): Promise<typeof import('mermaid')['default']> {
  // 原生 module 入口使开发服务器与安装包使用相同资源路径，不经过 Vite 的 public import 改写。
  return mermaidLoader ??= retryable(new Promise<typeof import('mermaid')['default']>((resolve, reject) => {
    const script = document.createElement('script'); script.type = 'module'; script.src = '/renderers/mermaid/loader.mjs';
    const loaded = (event: Event): void => { script.remove(); resolve((event as CustomEvent<typeof import('mermaid')['default']>).detail); };
    window.addEventListener('ZiEdit-mermaid-loaded', loaded, { once: true });
    script.onerror = () => { window.removeEventListener('ZiEdit-mermaid-loaded', loaded); script.remove(); reject(new Error('无法加载离线图表资源')); };
    document.head.append(script);
  }), () => { mermaidLoader = undefined; });
}

/** 渲染库就绪（超时计时只从库可用后开始：库加载耗时不算渲染超时）。 */
function libraryReady(kind: RenderBlock['kind']): Promise<unknown> {
  return kind === 'mermaid' ? loadMermaid() : loadMath();
}

/** 产物不含可执行节点、外部资源或事件处理器；保留 SVG 的局部字形和标记引用。 */
export function cleanRenderHtml(html: string): string {
  const root = document.createElement('template'); root.innerHTML = html;
  root.content.querySelectorAll('script,foreignObject,iframe,object,embed,image,img,audio,video,link,style,animate,animateMotion,set')
    .forEach(node => node.remove());
  for (const element of root.content.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase(), value = attribute.value.trim();
      if (name.startsWith('on') || name === 'src' || name === 'srcset' || name === 'formaction'
        || ((name === 'href' || name === 'xlink:href') && !value.startsWith('#'))
        || unsafeCss(value)) element.removeAttribute(attribute.name);
    }
  }
  return root.innerHTML;
}

const cache = new Map<string, { results: RenderResult[]; bytes: number }>();
const pending = new Map<string, Promise<RenderResult[]>>();
let cachedBytes = 0;
const CACHE_BYTES = 4 * 1024 * 1024, CACHE_ENTRIES = 128;
function memo(key: string, work: () => Promise<RenderResult[]>): Promise<RenderResult[]> {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return Promise.resolve(hit.results); }
  const running = pending.get(key); if (running) return running;
  let transient = false;
  const task = work().catch((error): RenderResult[] => { transient = true; return [{ error: errorText(error) }]; }).then(results => {
    // 抛错（库加载失败等）属瞬时失败，不入缓存——否则同一公式在淘汰前一直显示错误；语法错误是确定结果，照常缓存。
    if (transient) { pending.delete(key); return results; }
    const bytes = 2 * (key.length + results.reduce((size, result) => size + (result.html?.length ?? result.error?.length ?? 0), 0));
    if (bytes <= CACHE_BYTES) {
      cache.set(key, { results, bytes }); cachedBytes += bytes;
      while (cache.size > CACHE_ENTRIES || cachedBytes > CACHE_BYTES) {
        const oldest = cache.keys().next().value!; cachedBytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
      }
    }
    pending.delete(key); return results;
  });
  pending.set(key, task); return task;
}

async function renderMath(blocks: readonly RenderBlock[], deliver?: (index: number, result: RenderResult) => void): Promise<RenderResult[]> {
  const api = await loadMath();
  const stage = document.createElement('div'); stage.className = 'md-render-stage';
  const slots = blocks.map(block => {
    const slot = document.createElement('span');
    slot.textContent = (block.display ? '\\[' : '\\(') + block.source + (block.display ? '\\]' : '\\)');
    stage.append(slot); return slot;
  });
  document.body.append(stage);
  const read = (slot: HTMLElement): RenderResult => {
    const error = slot.querySelector('[data-mml-node="merror"]');
    if (error) return { error: error.getAttribute('data-mjx-error') ?? error.textContent ?? '公式语法错误' };
    if (!slot.querySelector('svg')) return { error: '公式未能完成解析' };
    return { html: cleanRenderHtml(slot.innerHTML) };
  };
  try {
    // Sandbox 同时隔离宏与标签；含编号/引用/宏的文档整批 typeset，让前向引用参与 MathJax 的重编译。
    api.texReset(); await api.tex2svgPromise('\\begingroupSandbox');
    if (slots.length <= MATH_SLICE) {
      await api.typesetPromise([stage]);
      const results = slots.map(read);
      results.forEach((result, index) => deliver?.(index, result));
      return results;
    }
    // 无编号/引用/宏的普通文档：按时间预算分片处理并逐槽交付，空闲让出主线程——
    // 公式密集文档不再冻结输入（无跨公式状态时公式外观与处理顺序无关）。
    const results: RenderResult[] = new Array(slots.length);
    let sliceStart = performance.now();
    for (let i = 0; i < slots.length; i += MATH_SLICE) {
      const part = slots.slice(i, i + MATH_SLICE);
      await api.typesetPromise(part);
      for (let j = 0; j < part.length; j++) {
        results[i + j] = read(part[j]!);
        deliver?.(i + j, results[i + j]!);
      }
      if (performance.now() - sliceStart >= 8) {
        await yieldIdle();
        sliceStart = performance.now();
      }
    }
    return results;
  } finally { api.typesetClear([stage]); stage.remove(); }
}

export function diagramSourceError(source: string): string | null {
  // 文档配置与图标/图片可在生成 SVG 前触发资源加载，必须在进入库前拒绝。
  if (/%%\s*\{|^\s*---|^\s*click\s|\b(?:img|icon)\s*:|!\[[^\]]*\]\s*\(|<[!/]?[a-z]/im.test(source))
    return '图表不支持文档配置、点击动作、HTML、图片或外部图标';
  return null;
}

async function renderDiagram(source: string, dark: boolean): Promise<RenderResult[]> {
  const invalid = diagramSourceError(source); if (invalid) return [{ error: invalid }];
  const mermaid = await loadMermaid();
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default',
    htmlLabels: false, flowchart: { htmlLabels: false }, suppressErrorRendering: true,
    maxTextSize: 256 * 1024, maxEdges: 2000,
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart', 'theme', 'themeCSS'] });
  const stage = document.createElement('div'); stage.className = 'md-render-stage'; document.body.append(stage);
  try {
    const { svg } = await mermaid.render('ZiEdit-diagram-' + ++nextId, source, stage);
    // 保留库生成的安全样式，先过滤外部 url，再作为独立样式表随 SVG 保存。
    const template = document.createElement('template'); template.innerHTML = svg;
    const styles = [...template.content.querySelectorAll('style')].map(style => style.textContent ?? '').join('\n');
    const safeStyles = unsafeCss(styles) ? '' : styles;
    const clean = cleanRenderHtml(svg);
    const result = document.createElement('template'); result.innerHTML = clean;
    if (safeStyles) { const style = document.createElementNS('http://www.w3.org/2000/svg', 'style'); style.textContent = safeStyles;
      result.content.querySelector('svg')?.prepend(style); }
    return [{ html: result.innerHTML }];
  } finally { stage.remove(); }
}

/** 三面共享的渲染上下文：整篇公式摘要与跨公式特征按块表引用世代缓存（引用索引换代极少，
 * B2 指纹门控），块表本身懒物化——仅真正发起整批渲染时才按映射重排一次。
 * 摘要不含位置：正文键入只移动偏移不改变公式内容，件相等与挂载签名均按世代凭据比较。 */
export interface RenderContext {
  /** `[[source, display], ...]` 的 JSON 文本：挂载签名与件相等比较共用的世代凭据。 */
  readonly mathDigest: string;
  /** 块表是否含跨公式状态特征（编号/引用/宏）。 */
  readonly mathBatch: boolean;
  /** 物化映射后的上下文块表：每实例至多一次，重复消费共享同一数组。 */
  readonly resolve: () => readonly RenderBlock[];
}
const contextGenerations = new WeakMap<readonly RenderBlock[], { digest: string; batch: boolean }>();
/** 渲染上下文热路径观测（测试断言用）：摘要世代计算数 / 块表物化数。 */
export const renderContextCounters = { digestComputations: 0, materializations: 0 };
export function resetRenderContextCounters(): void {
  renderContextCounters.digestComputations = 0;
  renderContextCounters.materializations = 0;
}

export function createRenderContext(blocks: readonly RenderBlock[], mapPos: (position: number) => number = position => position): RenderContext {
  let generation = contextGenerations.get(blocks);
  if (!generation) {
    const math = blocks.filter(item => item.kind === 'math');
    generation = { digest: JSON.stringify(math.map(item => [item.source, item.display])),
      batch: math.some(item => MATH_BATCH_FEATURE.test(item.source)) };
    contextGenerations.set(blocks, generation);
    renderContextCounters.digestComputations++;
  }
  let materialized: readonly RenderBlock[] | undefined;
  return {
    mathDigest: generation.digest,
    mathBatch: generation.batch,
    resolve: () => materialized ??= (renderContextCounters.materializations++,
      blocks.map(item => ({ ...item, from: mapPos(item.from), to: mapPos(item.to) }))),
  };
}

/** 已有确定结果的同步查询（不发起渲染、不物化整批块表）：滚动经过已渲染过的公式/图表时
 *  直接出图，不再先退回源码加载态再换回（高度两次跳变）。整批语义的公式不走此路径。 */
export function cachedRender(block: RenderBlock, context: RenderContext, dark: boolean): RenderResult | undefined {
  if (block.source.length > 256 * 1024) return undefined;
  const key = block.kind === 'mermaid' ? JSON.stringify(['mermaid', dark, block.source])
    : !context.mathBatch && !MATH_BATCH_FEATURE.test(block.source) ? JSON.stringify(['math', block.source, block.display]) : null;
  // 缓存里只有确定结果（成功或语法错误）；瞬时失败不入缓存（见 memo），可放心同步交付。
  const hit = key ? cache.get(key) : undefined;
  if (!hit?.results[0]) return undefined;
  cache.delete(key!); cache.set(key!, hit);
  return hit.results[0];
}

/** 三面共享请求；公式键包含整篇公式顺序，普通正文修改不会重新计算编号。 */
export function requestRender(block: RenderBlock, context: RenderContext, dark: boolean): Promise<RenderResult> {
  if (block.source.length > 256 * 1024) return Promise.resolve({ error: '单个公式或图表超过 256KiB 渲染限制' });
  if (block.kind === 'mermaid') {
    const key = JSON.stringify(['mermaid', dark, block.source]);
    return memo(key, () => {
      const task = diagramQueue.then(() => renderDiagram(block.source, dark));
      diagramQueue = task.then(() => {}, () => {}); return task;
    }).then(results => results[0]!);
  }
  // 无跨公式状态（编号/引用/宏）时逐块渲染：特征按世代缓存加当前块即时检测，不为探测物化整表；
  // 块装饰按视口挂载，队列里只有可见公式，不存在整篇积压。含跨公式状态时保持整批语义
  // （键含整篇公式顺序，编号一致），此时才物化块表。
  if (!context.mathBatch && !MATH_BATCH_FEATURE.test(block.source)) {
    const single = JSON.stringify(['math', block.source, block.display]);
    return memo(single, () => {
      const task = mathQueue.then(() => renderMath([block]));
      // D-T2-04：队尾空闲让出——单块路径修前整链微任务连续推进（slots≤MATH_SLICE 无内部让出），
      // 数千公式的水合队列把主线程占满数分钟；每任务间让一次输入/帧机会。
      mathQueue = task.then(() => {}, () => {}).then(() => yieldIdle()); return task;
    }).then(results => results[0]!);
  }
  const math = context.resolve().filter(item => item.kind === 'math');
  let index = math.findIndex(item => item.from === block.from && item.to === block.to);
  if (index < 0) {
    // 编辑中的公式与索引映射范围不一致时，按包含关系换掉旧条目，避免整批键里出现重复公式。
    const containing = math.findIndex(item => item.from <= block.from && item.to >= block.to);
    if (containing >= 0) { math[containing] = block; index = containing; }
    else { math.push(block); math.sort((a, b) => a.from - b.from); index = math.indexOf(block); }
  }
  else math[index] = block;
  const key = JSON.stringify(['math', math.map(item => [item.source, item.display])]);
  return memoMath(key, math, index);
}

/** 进行中的公式批次：逐槽交付——可见公式不必等整篇批处理完才上屏。 */
const mathJobs = new Map<string, Promise<RenderResult>[]>();

function memoMath(key: string, math: readonly RenderBlock[], index: number): Promise<RenderResult> {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return Promise.resolve(hit.results[index] ?? hit.results[0]!); }
  let job = mathJobs.get(key);
  if (!job) {
    const resolves: Array<(result: RenderResult) => void> = [];
    job = math.map(() => new Promise<RenderResult>(resolve => { resolves.push(resolve); }));
    mathJobs.set(key, job);
    let transient = false;
    const task = mathQueue
      .then(() => renderMath(math, (i, result) => resolves[i]?.(result)))
      .catch((error): RenderResult[] => { transient = true; return math.map(() => ({ error: errorText(error) })); })
      .then(results => {
        // 整批结束后未交付的槽位（异常中断）兜底交付，缓存沿用统一上限策略；瞬时失败不入缓存。
        results.forEach((result, i) => resolves[i]?.(result));
        if (transient) { mathJobs.delete(key); return; }
        const bytes = 2 * (key.length + results.reduce((size, result) => size + (result.html?.length ?? result.error?.length ?? 0), 0));
        if (bytes <= CACHE_BYTES) {
          cache.set(key, { results, bytes }); cachedBytes += bytes;
          while (cache.size > CACHE_ENTRIES || cachedBytes > CACHE_BYTES) {
            const oldest = cache.keys().next().value!; cachedBytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
          }
        }
        mathJobs.delete(key);
      });
    mathQueue = task.then(() => {}, () => {}).then(() => yieldIdle()); // D-T2-04：队尾空闲让出（同单块路径）
  }
  return job[index]!;
}

/** 渲染库就绪后单个挂载的等待上限（超时仅提示，结果迟到仍会替换）。 */
const RENDER_TIMEOUT_MS = 10_000;

/** 挂载身份：决定已渲染的目标能否原样复用。无跨公式状态时公式只依赖自身源码——
 *  修前签名恒含整篇公式摘要，改任一公式会让整屏公式退回源码再重渲（闪烁）；整篇摘要只在整批语义下参与。 */
export function renderMountKey(block: RenderBlock, context: RenderContext): string {
  const batch = block.kind === 'math' && (context.mathBatch || MATH_BATCH_FEATURE.test(block.source));
  return JSON.stringify([block.kind, block.source, block.display, batch ? context.mathDigest : null]);
}

/** 已渲染块的实测高度（按挂载身份 + 正文字号）：CM6 估计离屏块高度、滚动期占位、加载期预留都用它，
 *  使「估计→实件」换件时高度不变；只记实测值，不猜。 */
const renderHeights = new Map<string, number>();
const RENDER_HEIGHT_ENTRIES = 2048;
const heightKey = (block: RenderBlock, context: RenderContext): string =>
  renderMountKey(block, context) + '|' + document.documentElement.style.getPropertyValue('--md-fs-user');
export function rememberedRenderHeight(block: RenderBlock, context: RenderContext): number | undefined {
  return block.display ? renderHeights.get(heightKey(block, context)) : undefined;
}
export function rememberRenderHeight(block: RenderBlock, context: RenderContext, height: number): void {
  if (!block.display || !(height > 0)) return;
  const key = heightKey(block, context);
  renderHeights.delete(key); renderHeights.set(key, height);
  if (renderHeights.size > RENDER_HEIGHT_ENTRIES) renderHeights.delete(renderHeights.keys().next().value!);
}

const mounted = new WeakMap<HTMLElement, object>();
const renderSignatures = new WeakMap<HTMLElement, string>();
const renderSources = new WeakMap<HTMLElement, string>();
const themeMounts = new WeakMap<HTMLElement, { refresh(dark: boolean): void }>();
let themeObserver: MutationObserver | undefined;
function observeTheme(): void {
  if (themeObserver) return;
  themeObserver = new MutationObserver(() => {
    const dark = document.documentElement.dataset.tone === 'dark';
    document.querySelectorAll<HTMLElement>('.md-render-target[data-render-kind="mermaid"]').forEach(target => {
      themeMounts.get(target)?.refresh(dark);
    });
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-tone'] });
}
/** 成功产物上屏（Mermaid 副本需独立 ID）：异步交付与缓存同步出图共用。 */
function applyRenderHtml(target: HTMLElement, block: RenderBlock, html: string): void {
  target.innerHTML = html; target.dataset.renderState = 'ready';
  if (block.kind !== 'mermaid') return;
  // 同图可在文档中重复出现；缓存副本必须拥有独立的 marker、样式与可访问名称 ID。
  const ids = new Map<string, string>(), prefix = 'ZiEdit-copy-' + ++nextId + '-';
  for (const element of target.querySelectorAll('[id]')) { const id = element.id; ids.set(id, prefix + id); element.id = prefix + id; }
  const fragment = (value: string): string => value.replace(/#([\w:.-]+)/g, (match, id: string) => ids.has(id) ? '#' + ids.get(id) : match);
  for (const element of target.querySelectorAll('*')) {
    for (const attr of [...element.attributes]) if (attr.name !== 'id') element.setAttribute(attr.name,
      attr.name === 'aria-labelledby' || attr.name === 'aria-describedby'
        ? attr.value.split(/\s+/).map(id => ids.get(id) ?? id).join(' ') : fragment(attr.value));
    if (element.tagName.toLowerCase() === 'style') element.textContent = fragment(element.textContent ?? '');
  }
}

/** 只替换独立派生节点，调用方负责版本/位置/生命周期与组合输入守卫。 */
export function mountRender(target: HTMLElement, block: RenderBlock, context: RenderContext, dark: boolean,
  current: () => boolean = () => true, updated?: () => void, hold: () => boolean = () => false,
  busy: () => boolean = () => false): () => void {
  observeTheme();
  let tone = dark, cancel = mountAtTheme(target, block, context, tone, current, updated, hold, busy);
  const subscription = { refresh(next: boolean): void {
    if (tone === next || !current()) return;
    tone = next; cancel(); cancel = mountAtTheme(target, block, context, tone, current, updated, hold, busy);
  } };
  themeMounts.set(target, subscription);
  return () => { if (themeMounts.get(target) === subscription) themeMounts.delete(target); cancel(); };
}

function mountAtTheme(target: HTMLElement, block: RenderBlock, context: RenderContext, dark: boolean,
  current: () => boolean, updated: (() => void) | undefined, hold: () => boolean, busy: () => boolean): () => void {
  const version = {}; mounted.set(target, version);
  const signature = renderMountKey(block, context) + (dark ? '|dark' : '|light');
  renderSources.set(target, block.source);
  if (renderSignatures.get(target) === signature && target.dataset.renderState === 'ready') {
    target.dataset.renderDone = '1'; // 真机门禁的「水合平台」等待位（缓存复用即视为已完成）
    return () => { if (mounted.get(target) === version) mounted.delete(target); };
  }
  renderSignatures.set(target, signature);
  const source = document.createElement('code'); source.textContent = block.source;
  target.classList.add('md-render-target');
  target.dataset.renderKind = block.kind;
  target.dataset.renderDisplay = block.display ? '1' : '0';
  const ready = cachedRender(block, context, dark);
  if (ready) {
    if (ready.html !== undefined) applyRenderHtml(target, block, ready.html);
    else {
      const message = document.createElement('span'); message.className = 'md-render-error';
      message.textContent = (block.kind === 'math' ? '公式渲染失败：' : '图表渲染失败：') + ready.error;
      target.replaceChildren(source, message); target.dataset.renderState = 'error';
    }
    target.dataset.renderDone = '1';
    updated?.();
    return () => { if (mounted.get(target) === version) mounted.delete(target); };
  }
  target.replaceChildren(source); target.dataset.renderState = 'loading';
  delete target.dataset.renderDone;
  updated?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let deliveryFrame = 0;
  const live = (): boolean => mounted.get(target) === version && current();
  const showError = (error: string): void => {
    const message = document.createElement('span'); message.className = 'md-render-error';
    message.textContent = (block.kind === 'math' ? '公式渲染失败：' : '图表渲染失败：') + error;
    target.replaceChildren(source, message); target.dataset.renderState = 'error';
  };
  const deliver = (result: RenderResult): void => {
    if (settled || !live()) return;
    if (hold()) { timer = setTimeout(() => scheduleDelivery(result), 30); return; }
    settled = true;
    clearTimeout(timeout);
    if (result.error !== undefined) {
      showError(result.error);
    } else {
      applyRenderHtml(target, block, result.html);
    }
    target.dataset.renderDone = '1'; // 成功/失败均视为水合完成（平台判据只看完成，不看成败）
    updated?.();
  };
  const scheduleDelivery = (result: RenderResult): void => {
    if (!live()) return;
    // 库排版与 DOM 交付/锚定各占一个任务；相同请求的多个目标也不得在
    // 一条 Promise 链里连续写布局。真正提交时仍检查世代、输入与组合状态。
    deliveryFrame = requestIrFrame(() => { deliveryFrame = 0; deliver(result); }, true);
  };
  // busy：宿主正在被用户连续滚动——排版（MathJax 单次可达数十毫秒）推迟到停手，滚动中不出长帧；
  // 加载态已按估计高度预留，推迟不改变布局。
  const start = (): void => {
    if (!live()) return;
    if (busy()) { timer = setTimeout(start, 120); return; }
    void requestRender(block, context, dark).then(scheduleDelivery, error => scheduleDelivery({ error: errorText(error) }));
    // 超时只从渲染库就绪后计时（库冷加载在 WebView2 可达 10s+，修前挂载即计时导致排队公式全部误报超时）；
    // 超时只是提示，不终结挂载——迟到的结果照常替换提示。
    void libraryReady(block.kind).then(() => {
      if (settled || !live()) return;
      timeout = setTimeout(() => {
        if (settled || !live()) return;
        showError('渲染超时，仍在等待结果');
        target.dataset.renderDone = '1';
        updated?.();
      }, RENDER_TIMEOUT_MS);
    }, () => {});
  };
  timer = setTimeout(start, 80);
  return () => { clearTimeout(timer); clearTimeout(timeout); cancelIrFrame(deliveryFrame); if (mounted.get(target) === version) mounted.delete(target); };
}

/** D-T2-04：水合分片——修前 hydrateRenders 对全文档目标一次性同步派发 mountRender，万级公式
 * 文档数千个 80ms 回调同时到期、队列整链连续推进，主线程被占数分钟。现按文档序分片
 * （≤8 目标或 ≤8ms 预算），片间经共享帧队列让出；
 * 同容器重入按代际去重——新一轮派发即接管，旧队列在首个片边界自弃；容器销毁（current 失效）
 * 同路径退出。
 * D-T2-05（v0.42 规则 24）：水合按视口邻域触发——目标距滚动视口 ≤HYDRATE_SCREENS 屏才入队，
 * 远端目标置 data-render-pending；滚动容器节流 200ms 扫描 pending 补挂（滚动到哪排版到哪，
 * IR v0.33 按需分片同型）。缓存复用时已水合 DOM 原样保留（签名早退，renderDone 不重置）。 */
export const HYDRATE_SLICE_TARGETS = 8;
const HYDRATE_SLICE_MS = 8;
/** 视口邻域（屏数）：首屏 + 前后各 3 屏预水合，滚动时增量补挂 */
export const HYDRATE_SCREENS = 3;
const hydrateGenerations = new WeakMap<HTMLElement, object>();
const hydrateCleanups = new WeakMap<HTMLElement, Map<HTMLElement, () => void>>();
const hydrateScopes = new WeakMap<HTMLElement, HTMLElement>();

interface HydrateLane {
  version: object;
  root: HTMLElement;
  scroller: HTMLElement;
  context: ReturnType<typeof createRenderContext>;
  dark: boolean;
  current: () => boolean;
  updated?: () => void;
  pending: Array<[HTMLElement, RenderBlock]>;
  active: Map<HTMLElement, { block: RenderBlock; cancel: () => void }>;
  guarded: boolean;
  inputVersion: number;
  dispatching: number;
  timer?: ReturnType<typeof setTimeout>;
  checking?: boolean;
  recheck?: boolean;
}
const hydrateLanes = new WeakMap<HTMLElement, HydrateLane>();
const hydrateScrollListeners = new WeakMap<HTMLElement, () => void>();

/** 滚动容器内容坐标下的目标顶部（offsetParent 链累加到滚动容器；与 syncFromLeft 的 offsetTop 判据同口径）。 */
function offsetTopIn(el: HTMLElement, ancestor: HTMLElement): number {
  let top = 0, node: HTMLElement | null = el;
  while (node && node !== ancestor) { top += node.offsetTop; node = node.offsetParent as HTMLElement | null; }
  return top;
}

/** 目标是否落在滚动视口的邻域内（无滚动几何时视为可见——测试/离屏构建不丢水合语义）。 */
function withinNeighborhood(target: HTMLElement, scroller: HTMLElement): boolean {
  const height = scroller.clientHeight;
  if (!height) return true;
  const margin = HYDRATE_SCREENS * height;
  // 先查外层块盒，避免读取离屏子节点几何而强制展开整棵跳过布局的子树。
  const block = target.closest<HTMLElement>('.md-block');
  const coarse = target.closest<HTMLElement>('.md-reading-page') ?? block;
  if (coarse) {
    const top = offsetTopIn(coarse, scroller);
    if (top > scroller.scrollTop + height + margin || top + coarse.offsetHeight < scroller.scrollTop - margin) return false;
  }
  const top = offsetTopIn(target, scroller);
  return top <= scroller.scrollTop + height + margin && top + target.offsetHeight >= scroller.scrollTop - margin;
}

function dispatchSlices(lane: HydrateLane, jobs: Array<[HTMLElement, RenderBlock]>): Promise<void> {
  const { root, context, dark, current, version } = lane;
  const dispatch = async (): Promise<void> => {
    const inputVersion = lane.inputVersion;
    lane.dispatching++;
    try {
      let deadline = performance.now() + HYDRATE_SLICE_MS;
      for (let i = 0; i < jobs.length; i++) {
        if (hydrateGenerations.get(root) !== version || !current()) return; // 重挂/销毁/新一轮即弃
        if (lane.guarded && inputVersion !== lane.inputVersion) {
          for (const job of jobs.slice(i)) { job[0].dataset.renderPending = '1'; lane.pending.push(job); }
          scheduleLaneCheck(lane.scroller);
          return;
        }
        const [target, block] = jobs[i]!;
        delete target.dataset.renderPending; // 立即派发即解除待水合标记（滚动补挂与首轮共用）
        let cleanups = hydrateCleanups.get(root);
        if (!cleanups) { cleanups = new Map(); hydrateCleanups.set(root, cleanups); }
        cleanups.get(target)?.();
        const active = { block, cancel: () => {} };
        if (lane.guarded) lane.active.set(target, active);
        const updated = (): void => {
          lane.updated?.();
          if (lane.active.get(target) === active && target.dataset.renderState !== 'loading') {
            lane.active.delete(target);
            maybeDetachLane(lane);
          }
        };
        const busy = (): boolean => lane.guarded && userScrolledRecently(lane.scroller, 200);
        active.cancel = mountRender(target, block, context, dark, current, updated, busy, busy);
        cleanups.set(target, active.cancel);
        // 已完成节点可直接复用，早退路径不会触发 updated，不能留在在途集合中。
        if (lane.active.get(target) === active && target.dataset.renderState !== 'loading') lane.active.delete(target);
        if (i + 1 < jobs.length && ((i + 1) % HYDRATE_SLICE_TARGETS === 0 || performance.now() >= deadline)) {
          await yieldIdle();
          deadline = performance.now() + HYDRATE_SLICE_MS;
        }
      }
    } finally { lane.dispatching--; maybeDetachLane(lane); }
  };
  return dispatch();
}

/** 滚动补挂：节流 200ms 重扫 pending，邻域内目标补入分片派发；代际失效/无剩余即卸载监听。 */
function scheduleLaneCheck(scroller: HTMLElement): void {
  const lane = hydrateLanes.get(scroller);
  if (!lane) return;
  if (lane.checking) { lane.recheck = true; return; }
  if (lane.timer) return;
  lane.timer = setTimeout(() => { void (async () => {
    lane.timer = undefined;
    if (hydrateGenerations.get(lane.root) !== lane.version || !lane.current() || !lane.root.isConnected) {
      detachLane(scroller);
      return;
    }
    lane.checking = true;
    const ready: Array<[HTMLElement, RenderBlock]> = [];
    const pending: Array<[HTMLElement, RenderBlock]> = [];
    let deadline = performance.now() + 4, count = 0;
    for (const job of lane.pending) {
      (withinNeighborhood(job[0], scroller) ? ready : pending).push(job);
      if (++count >= 128 || performance.now() >= deadline) {
        await yieldIdle();
        if (hydrateLanes.get(scroller) !== lane || !lane.current()) return;
        deadline = performance.now() + 4; count = 0;
      }
    }
    lane.pending = pending;
    if (lane.recheck) {
      lane.pending.push(...ready); lane.recheck = false; lane.checking = false;
      scheduleLaneCheck(scroller); return;
    }
    if (ready.length) await dispatchSlices(lane, ready);
    if (hydrateLanes.get(scroller) !== lane) return;
    lane.checking = false;
    if (lane.recheck) { lane.recheck = false; scheduleLaneCheck(scroller); }
    else maybeDetachLane(lane);
  })(); }, 200);
}

function attachLane(scroller: HTMLElement): void {
  if (hydrateScrollListeners.has(scroller)) return;
  const onScroll = (): void => scheduleLaneCheck(scroller);
  const onInput = (): void => {
    const lane = hydrateLanes.get(scroller);
    if (!lane) return;
    lane.inputVersion++;
    // 已离开旧视口的公式不能在离屏子树中迟到写入。取消在途挂载，回到待派发队列，
    // 用户停手后只重新挂载当前邻域；已完成的正文节点保留不动。
    for (const [target, active] of lane.active) {
      active.cancel();
      hydrateCleanups.get(lane.root)?.delete(target);
      target.dataset.renderPending = '1';
      lane.pending.push([target, active.block]);
    }
    lane.active.clear();
    scheduleLaneCheck(scroller);
  };
  hydrateScrollListeners.set(scroller, () => {
    scroller.removeEventListener('scroll', onScroll);
    scroller.removeEventListener('md-user-input', onInput);
  });
  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('md-user-input', onInput);
}

function maybeDetachLane(lane: HydrateLane): void {
  if (lane.guarded && hydrateLanes.get(lane.scroller) === lane && !lane.pending.length
    && !lane.active.size && !lane.checking && !lane.dispatching) detachLane(lane.scroller);
}

function detachLane(scroller: HTMLElement): void {
  const lane = hydrateLanes.get(scroller);
  if (lane?.timer) clearTimeout(lane.timer);
  hydrateLanes.delete(scroller);
  hydrateScrollListeners.get(scroller)?.();
  hydrateScrollListeners.delete(scroller);
}

// ── 水合目标登记簿（perf-silk Pass 1 FC②）──
// 修前每次 hydrateRenders 全量 `root.querySelectorAll('.md-render-target')` 扫整棵渲染树
// （分屏温渲染每轮都扫，万级目标文档 O(全树) 选择器匹配）。现按「稳定作用域」维护已知
// target 集合：首轮冷扫一次登记，此后 MutationObserver 记录增量（hydrate 入口同步排空
// observer 的待处理记录，MutationObserver 回调只积压不处理，成本仍全部落在 hydrate 内）；
// 断链节点由 isConnected 检查自然淘汰。作用域取稳定的 .md-preview 宿主；
// 无宿主时按正文根冷扫，供独立组件与离屏构建使用。

interface TargetRegistry {
  targets: Set<HTMLElement>;
  records: MutationRecord[];
  observer: MutationObserver;
}
const targetRegistries = new WeakMap<HTMLElement, TargetRegistry>();
// 共享阅读组件在有界构建片里登记目标，避免完成时再 querySelectorAll 整篇正文。
const readingTargets = new WeakMap<HTMLElement, Set<HTMLElement>>();
const blockTargets = new WeakMap<HTMLElement, HTMLElement[]>();
export function registerReadingRenderTargets(root: HTMLElement, block: HTMLElement): void {
  let targets = readingTargets.get(root);
  if (!targets) { targets = new Set(); readingTargets.set(root, targets); }
  let local = blockTargets.get(block);
  if (!local) { local = [...block.querySelectorAll<HTMLElement>('.md-render-target')]; blockTargets.set(block, local); }
  for (const target of local) targets.add(target);
}

/** 登记一个新增节点及其子树内的全部水合目标。 */
function adoptTargets(node: Node, into: Set<HTMLElement>): void {
  if (node.nodeType !== 1) return;
  const el = node as HTMLElement;
  if (el.classList.contains('md-render-target')) into.add(el);
  if (el.childElementCount) el.querySelectorAll<HTMLElement>('.md-render-target').forEach(target => into.add(target));
}

/** 把观察记录积压到登记簿（回调只积压不处理：扫描成本全部落在 hydrate 入口）。 */
function stashRecords(registry: TargetRegistry, records: MutationRecord[]): void {
  for (const record of records) registry.records.push(record);
}

/** 当前轮次应匹配的目标集合：排空增量记录 + 断链淘汰（根未挂载时不做 isConnected 淘汰——
 *  测试/离屏构建的整棵树都是 disconnected，语义等同修前的即时查询）。 */
function registeredTargets(root: HTMLElement, scope: HTMLElement): HTMLElement[] {
  let registry = targetRegistries.get(scope);
  if (!registry) {
    registry = {
      targets: new Set(),
      records: [],
      observer: new MutationObserver(records => stashRecords(registry!, records)),
    };
    targetRegistries.set(scope, registry);
    registry.observer.observe(scope, { childList: true, subtree: true });
    adoptTargets(scope, registry.targets); // 首轮冷扫：登记作用域下既有目标
  }
  stashRecords(registry, registry.observer.takeRecords());
  const records = registry.records;
  registry.records = [];
  for (const record of records) for (const node of record.addedNodes) adoptTargets(node, registry.targets);
  const live: HTMLElement[] = [];
  for (const target of registry.targets) {
    if (scope.isConnected && !target.isConnected) { registry.targets.delete(target); continue; } // 移除节点自然淘汰
    if (root.contains(target)) live.push(target); // 登记簿按作用域共享，匹配仍限定本轮根
  }
  return live;
}

export async function hydrateRenders(root: HTMLElement, blocks: readonly RenderBlock[], dark: boolean, current: () => boolean,
  updated?: () => void): Promise<void> {
  // D-T2-05：视口邻域门控（滚动容器 = .md-preview 宿主；无几何时全可见，退化为纯分片语义）。
  const scroller = (root.classList.contains('md-preview') ? root : root.closest('.md-preview')) as HTMLElement | null;
  const initialInput = scroller ? userScrollVersion(scroller) : 0;
  hydrateScopes.set(root, scroller ?? root);
  const previous = hydrateCleanups.get(root);
  if (previous) { for (const cleanup of previous.values()) cleanup(); previous.clear(); }
  if (scroller) detachLane(scroller);
  const version = {};
  hydrateGenerations.set(root, version);
  if (!blocks.length) { readingTargets.get(root)?.clear(); return; }
  const live = (): boolean => hydrateGenerations.get(root) === version && current();
  const known = readingTargets.get(root);
  const targets = known ? [...known] : registeredTargets(root, scroller ?? root);
  const context = createRenderContext(blocks);
  // D-T2-03（D）：修前每 target 对全部 blocks 线性 find + 逐对 trimEnd 字符串比较，
  // 数千公式文档是平方级成本；按 kind+源文本建池，同键按文档序消费等价于 find-first-unused。
  const pools = new Map<string, { blocks: RenderBlock[]; next: number }>();
  let deadline = performance.now() + 4, count = 0;
  const nextSlice = async (): Promise<void> => { await yieldIdle(); deadline = performance.now() + 4; count = 0; };
  for (const block of blocks) {
    const poolKey = block.kind + '\u0000' + block.source.trimEnd();
    const pool = pools.get(poolKey);
    if (pool) pool.blocks.push(block);
    else pools.set(poolKey, { blocks: [block], next: 0 });
    if (++count >= 256 || performance.now() >= deadline) { await nextSlice(); if (!live()) return; }
  }
  const jobs: Array<[HTMLElement, RenderBlock]> = [];
  const deferred: Array<[HTMLElement, RenderBlock]> = [];
  for (const target of targets) {
    if (root.isConnected && !target.isConnected || !root.contains(target)) { known?.delete(target); continue; }
    const source = (renderSources.get(target) ?? target.querySelector('code')?.textContent)?.trimEnd();
    const pool = source !== undefined ? pools.get(target.dataset.renderKind + '\u0000' + source) : undefined;
    const block = pool?.blocks[pool.next++];
    if (block) jobs.push([target, block]);
    if (++count >= 128 || performance.now() >= deadline) { await nextSlice(); if (!live()) return; }
  }
  const immediate: Array<[HTMLElement, RenderBlock]> = [];
  if (scroller && scroller.clientHeight) {
    for (const job of jobs) {
      if (withinNeighborhood(job[0], scroller)) immediate.push(job);
      else deferred.push(job);
      if (++count >= 128 || performance.now() >= deadline) { await nextSlice(); if (!live()) return; }
    }
    // 布局读取与属性写入分开，避免每个目标的写入影响下一次几何读取。
    for (const [target] of deferred) {
      target.dataset.renderPending = '1';
      if (++count >= 128 || performance.now() >= deadline) { await nextSlice(); if (!live()) return; }
    }
  }
  // 匹配与几何分类可能跨越多帧；期间若发生用户导航，原先的邻域结果已过期。
  const staleLayout = !!scroller && userScrollVersion(scroller) !== initialInput;
  if (staleLayout) {
    for (const job of immediate) {
      job[0].dataset.renderPending = '1'; deferred.push(job);
      if (++count >= 128 || performance.now() >= deadline) { await nextSlice(); if (!live()) return; }
    }
    immediate.length = 0;
  }
  const guarded = !!scroller?.clientHeight;
  const lane: HydrateLane = { version, root, scroller: scroller ?? root, context, dark, current, updated,
    pending: deferred, active: new Map(), guarded, inputVersion: 0, dispatching: 0 };
  if (guarded) {
    hydrateLanes.set(lane.scroller, lane); attachLane(lane.scroller);
    if (staleLayout) scheduleLaneCheck(lane.scroller);
  }
  await dispatchSlices(lane, guarded ? immediate : jobs);
  maybeDetachLane(lane);
}

/** 阅读组件销毁时停止观察、派发与迟到回填；暂存同一组件不走销毁。 */
export function destroyHydratedRenders(root: HTMLElement): void {
  hydrateGenerations.delete(root);
  const cleanups = hydrateCleanups.get(root);
  if (cleanups) for (const cleanup of cleanups.values()) cleanup();
  hydrateCleanups.delete(root);
  const scope = hydrateScopes.get(root);
  if (scope) {
    detachLane(scope);
    targetRegistries.get(scope)?.observer.disconnect();
    targetRegistries.delete(scope);
  }
  hydrateScopes.delete(root);
  readingTargets.delete(root);
}
