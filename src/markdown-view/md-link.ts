// markdown-view —— markdown-it 链接/实体工具的同步接缝。
// headings.ts 的元数据提取（主线程 + worker 双入口共用）需要 unescapeAll/normalizeLink/
// validateLink 三个同步入口——三者均为与构造选项无关的原型/静态行为，实例无关。
// 修前 headings.ts 顶部 `import MarkdownIt` 使 markdown-it 被静态打进主 chunk，而主线程
// 只消费这三个函数。现 headings.ts 改经本接缝取工具：
// - 主线程：md.ts 共享单例预取完成后注入（模块加载即预取，见 md.ts）；
// - worker：headings-worker.ts 作为入口自带实例注入（其副本进 worker chunk，属正常）。
// 本模块保持零依赖（不 import markdown-it、不 import 主线程模块），避免把 md.ts 的
// 高亮/渲染依赖拖进 worker chunk。
export interface MdLinkTools {
  readonly utils: { unescapeAll(source: string): string };
  normalizeLink(url: string): string;
  validateLink(url: string): boolean;
}

let tools: MdLinkTools | null = null;

/** 注入工具集（每个执行环境至多一个注入方；先注入者生效，重复注入为空操作）。 */
export function bindMdLinkTools(instance: MdLinkTools): void {
  tools ??= instance;
}

/** 同步取工具集。前置条件（FC 收口 1 就绪屏障约定）：调用发生前本环境已完成注入——
 *  主线程经 md.ts 模块加载预取 + 各异步入口（renderPreviewInto/blockcache.render/
 *  LivePreviewView.init/extractHeadingsReady/LiveDocTracker.reportHeadings）显式
 *  await loadMarkdownIt()；worker 由 headings-worker 入口静态绑定（无等待窗口）。
 *  纯同步调用方（CM StateField.create、测试桥）依赖上述屏障/预取时机成立。 */
export function mdLinkTools(): MdLinkTools {
  if (!tools) throw new Error('markdown-it 链接工具未注入：主线程需 md.ts 预取完成，worker 需入口先绑定');
  return tools;
}

/** 测试 seam：解除注入以模拟冷启动（仅 src 内测试使用，运行时代码不得调用）。 */
export function __unbindMdLinkToolsForTest(): void {
  tools = null;
}
