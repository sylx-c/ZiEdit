import { type RenderBlock } from './render-model';
import { yieldToBrowser } from '../common/yield';

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
/** 空闲让出：批处理间隙把主线程还给输入与帧调度（无 requestIdleCallback 时退化为宏任务） */
const yieldIdle = (): Promise<void> => new Promise<void>(resolve => {
  const w = window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(() => resolve(), { timeout: 250 });
  else setTimeout(resolve, 0);
});

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

function loadMath(): Promise<MathJaxApi> {
  return mathLoader ??= (async () => {
    mathWindow().MathJax = {
      loader: { paths: { mathjax: '/renderers/mathjax', 'mathjax-newcm': '/renderers/font' },
        load: ['input/tex-base', '[tex]/ams', '[tex]/newcommand', '[tex]/configmacros', '[tex]/textmacros', '[tex]/begingroup',
          'output/svg', '[mathjax-newcm]/svg'], require: localScript },
      startup: { typeset: false },
      tex: { packages: ['base', 'ams', 'newcommand', 'configmacros', 'textmacros', 'begingroup'], tags: 'ams',
        inlineMath: [['\\(', '\\)']], displayMath: [['\\[', '\\]']], maxBuffer: 256 * 1024 },
      output: { font: 'mathjax-newcm', fontPath: '/renderers/font' },
      svg: { fontCache: 'none', dynamicPrefix: '/renderers/font/svg/dynamic' },
    };
    await localScript('/renderers/mathjax/startup.js');
    const api = mathWindow().MathJax as MathJaxApi;
    await api.startup.promise; return api;
  })();
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
  const task = work().catch((error): RenderResult[] => [{ error: errorText(error) }]).then(results => {
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
      if (performance.now() - sliceStart > 24) {
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
  // 原生 module 入口使开发服务器与安装包使用相同资源路径，不经过 Vite 的 public import 改写。
  mermaidLoader ??= new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.type = 'module'; script.src = '/renderers/mermaid/loader.mjs';
    const loaded = (event: Event): void => { script.remove(); resolve((event as CustomEvent<typeof import('mermaid')['default']>).detail); };
    window.addEventListener('ZiEdit-mermaid-loaded', loaded, { once: true });
    script.onerror = () => { window.removeEventListener('ZiEdit-mermaid-loaded', loaded); script.remove(); reject(new Error('无法加载离线图表资源')); };
    document.head.append(script);
  });
  const mermaid = await mermaidLoader;
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
    const task = mathQueue
      .then(() => renderMath(math, (i, result) => resolves[i]?.(result)))
      .catch((error): RenderResult[] => math.map(() => ({ error: errorText(error) })))
      .then(results => {
        // 整批结束后未交付的槽位（异常中断）兜底交付，缓存沿用统一上限策略。
        results.forEach((result, i) => resolves[i]?.(result));
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
/** 只替换独立派生节点，调用方负责版本/位置/生命周期与组合输入守卫。 */
export function mountRender(target: HTMLElement, block: RenderBlock, context: RenderContext, dark: boolean,
  current: () => boolean = () => true, updated?: () => void, hold: () => boolean = () => false): () => void {
  observeTheme();
  let tone = dark, cancel = mountAtTheme(target, block, context, tone, current, updated, hold);
  const subscription = { refresh(next: boolean): void {
    if (tone === next || !current()) return;
    tone = next; cancel(); cancel = mountAtTheme(target, block, context, tone, current, updated, hold);
  } };
  themeMounts.set(target, subscription);
  return () => { if (themeMounts.get(target) === subscription) themeMounts.delete(target); cancel(); };
}

function mountAtTheme(target: HTMLElement, block: RenderBlock, context: RenderContext, dark: boolean,
  current: () => boolean, updated: (() => void) | undefined, hold: () => boolean): () => void {
  const version = {}; mounted.set(target, version);
  // 挂载签名只用 O(1) 拼装：公式序列部分来自世代缓存的摘要字符串，不再逐挂载重算整篇。
  const signature = JSON.stringify([block.kind, block.source, block.display, dark,
    block.kind === 'math' ? context.mathDigest : null]);
  renderSources.set(target, block.source);
  if (renderSignatures.get(target) === signature && target.dataset.renderState === 'ready') {
    target.dataset.renderDone = '1'; // 真机门禁的「水合平台」等待位（缓存复用即视为已完成）
    return () => { if (mounted.get(target) === version) mounted.delete(target); };
  }
  renderSignatures.set(target, signature);
  const source = document.createElement('code'); source.textContent = block.source;
  target.replaceChildren(source); target.classList.add('md-render-target');
  target.dataset.renderKind = block.kind; target.dataset.renderState = 'loading';
  target.dataset.renderDisplay = block.display ? '1' : '0';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deliver = (result: RenderResult): void => {
    if (mounted.get(target) !== version || !current()) return;
    if (hold()) { timer = setTimeout(() => deliver(result), 30); return; }
    if (result.error !== undefined) {
      const message = document.createElement('span'); message.className = 'md-render-error';
      message.textContent = (block.kind === 'math' ? '公式渲染失败：' : '图表渲染失败：') + result.error;
      target.replaceChildren(source, message); target.dataset.renderState = 'error';
    } else {
      target.innerHTML = result.html; target.dataset.renderState = 'ready';      if (block.kind === 'mermaid') {
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
    }
    target.dataset.renderDone = '1'; // 成功/失败均视为水合完成（平台判据只看完成，不看成败）
    updated?.();
  };
  timer = setTimeout(() => {
    if (mounted.get(target) === version && current()) void requestRender(block, context, dark).then(deliver);
  }, 80);
  return () => { clearTimeout(timer); if (mounted.get(target) === version) mounted.delete(target); };
}

/** D-T2-04：水合分片——修前 hydrateRenders 对全文档目标一次性同步派发 mountRender，万级公式
 * 文档数千个 80ms 回调同时到期、队列整链连续推进，主线程被占数分钟。现按文档序分片
 * （≤8 目标或 ≤24ms 预算，与 blockcache 分片口径一致），片间 yieldToBrowser 摊到多个宏任务；
 * 同容器重入按代际去重——新一轮派发即接管，旧队列在首个片边界自弃；容器销毁（current 失效）
 * 同路径退出。
 * D-T2-05（v0.42 规则 24）：水合按视口邻域触发——目标距滚动视口 ≤HYDRATE_SCREENS 屏才入队，
 * 远端目标置 data-render-pending；滚动容器节流 200ms 扫描 pending 补挂（滚动到哪排版到哪，
 * IR v0.33 按需分片同型）。缓存复用时已水合 DOM 原样保留（签名早退，renderDone 不重置）。 */
export const HYDRATE_SLICE_TARGETS = 8;
const HYDRATE_SLICE_MS = 24;
/** 视口邻域（屏数）：首屏 + 前后各 3 屏预水合，滚动时增量补挂 */
export const HYDRATE_SCREENS = 3;
const hydrateGenerations = new WeakMap<HTMLElement, object>();

interface HydrateLane {
  version: object;
  root: HTMLElement;
  scroller: HTMLElement;
  context: ReturnType<typeof createRenderContext>;
  dark: boolean;
  current: () => boolean;
  pending: Array<[HTMLElement, RenderBlock]>;
  timer?: ReturnType<typeof setTimeout>;
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
  const top = offsetTopIn(target, scroller);
  return top <= scroller.scrollTop + height + margin && top + target.offsetHeight >= scroller.scrollTop - margin;
}

function dispatchSlices(lane: HydrateLane, jobs: Array<[HTMLElement, RenderBlock]>): void {
  const { root, context, dark, current, version } = lane;
  const dispatch = async (): Promise<void> => {
    let deadline = performance.now() + HYDRATE_SLICE_MS;
    for (let i = 0; i < jobs.length; i++) {
      if (hydrateGenerations.get(root) !== version || !current()) return; // 重挂/销毁/新一轮即弃
      const [target, block] = jobs[i]!;
      delete target.dataset.renderPending; // 立即派发即解除待水合标记（滚动补挂与首轮共用）
      mountRender(target, block, context, dark, current);
      if (i + 1 < jobs.length && ((i + 1) % HYDRATE_SLICE_TARGETS === 0 || performance.now() >= deadline)) {
        await yieldToBrowser();
        deadline = performance.now() + HYDRATE_SLICE_MS;
      }
    }
  };
  void dispatch(); // 签名兼容：调用方无需 await（渐进回填本就是异步语义）
}

/** 滚动补挂：节流 200ms 重扫 pending，邻域内目标补入分片派发；代际失效/无剩余即卸载监听。 */
function scheduleLaneCheck(scroller: HTMLElement): void {
  const lane = hydrateLanes.get(scroller);
  if (!lane) return;
  if (lane.timer) return;
  lane.timer = setTimeout(() => {
    lane.timer = undefined;
    if (hydrateGenerations.get(lane.root) !== lane.version || !lane.current() || !lane.root.isConnected) {
      detachLane(scroller);
      return;
    }
    const ready: Array<[HTMLElement, RenderBlock]> = [];
    lane.pending = lane.pending.filter(([target, block]) => {
      if (!withinNeighborhood(target, scroller)) return true;
      delete target.dataset.renderPending;
      ready.push([target, block]);
      return false;
    });
    if (ready.length) dispatchSlices(lane, ready);
    if (!lane.pending.length) detachLane(scroller);
  }, 200);
}

function attachLane(scroller: HTMLElement): void {
  if (hydrateScrollListeners.has(scroller)) return;
  const onScroll = (): void => scheduleLaneCheck(scroller);
  hydrateScrollListeners.set(scroller, onScroll);
  scroller.addEventListener('scroll', onScroll, { passive: true });
}

function detachLane(scroller: HTMLElement): void {
  const lane = hydrateLanes.get(scroller);
  if (lane?.timer) clearTimeout(lane.timer);
  hydrateLanes.delete(scroller);
  const listener = hydrateScrollListeners.get(scroller);
  if (listener) { scroller.removeEventListener('scroll', listener); hydrateScrollListeners.delete(scroller); }
}

// ── 水合目标登记簿──
// 修前每次 hydrateRenders 全量 `root.querySelectorAll('.md-render-target')` 扫整棵渲染树
// （分屏温渲染每轮都扫，万级目标文档 O(全树) 选择器匹配）。现按「稳定作用域」维护已知
// target 集合：首轮冷扫一次登记，此后 MutationObserver 记录增量（hydrate 入口同步排空
// observer 的待处理记录，MutationObserver 回调只积压不处理，成本仍全部落在 hydrate 内）；
// 断链节点由 isConnected 检查自然淘汰。作用域取滚动容器（分屏/预览每轮换新 col/inner，
// 稳定锚是 .md-preview 宿主；无宿主时退化为按根冷扫——测试/离屏构建与修前行为一致）。

interface TargetRegistry {
  targets: Set<HTMLElement>;
  records: MutationRecord[];
  observer: MutationObserver;
}
const targetRegistries = new WeakMap<HTMLElement, TargetRegistry>();

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

export function hydrateRenders(root: HTMLElement, blocks: readonly RenderBlock[], dark: boolean, current: () => boolean): void {
  // D-T2-05：视口邻域门控（滚动容器 = .md-preview 宿主；无几何时全可见，退化为纯分片语义）。
  const scroller = (root.classList.contains('md-preview') ? root : root.closest('.md-preview')) as HTMLElement | null;
  const targets = registeredTargets(root, scroller ?? root);
  const context = createRenderContext(blocks);
  // D-T2-03（D）：修前每 target 对全部 blocks 线性 find + 逐对 trimEnd 字符串比较，
  // 数千公式文档是平方级成本；按 kind+源文本建池，同键按文档序消费等价于 find-first-unused。
  const pools = new Map<string, RenderBlock[]>();
  for (const block of blocks) {
    const poolKey = block.kind + '\u0000' + block.source.trimEnd();
    const pool = pools.get(poolKey);
    if (pool) pool.push(block);
    else pools.set(poolKey, [block]);
  }
  const jobs: Array<[HTMLElement, RenderBlock]> = [];
  const deferred: Array<[HTMLElement, RenderBlock]> = [];
  targets.forEach(target => {
    const source = (renderSources.get(target) ?? target.querySelector('code')?.textContent)?.trimEnd();
    const block = source !== undefined ? pools.get(target.dataset.renderKind + '\u0000' + source)?.shift() : undefined;
    if (!block) return;
    jobs.push([target, block]);
  });
  const version = {};
  hydrateGenerations.set(root, version); // 新一轮接管：同容器旧派发队列在片边界自弃
  const immediate: Array<[HTMLElement, RenderBlock]> = [];
  if (scroller && scroller.clientHeight) {
    for (const job of jobs) {
      if (withinNeighborhood(job[0], scroller)) immediate.push(job);
      else { job[0].dataset.renderPending = '1'; deferred.push(job); }
    }
  }
  const lane: HydrateLane = { version, root, scroller: scroller ?? root, context, dark, current, pending: deferred };
  if (deferred.length) { hydrateLanes.set(lane.scroller, lane); attachLane(lane.scroller); }
  dispatchSlices(lane, scroller?.clientHeight ? immediate : jobs);
}
