// 批 3 启动收口：codemirror chunk 退出首屏静态模块图（源契约回归锁）。
// 唯一启动泄漏曾是 app.ts 静态 import scroll-surface（携 @codemirror syntaxTree/EditorView）。
// 修法：app.ts 仅留类型，运行期 cmScrollSurface 由 edit/IR 懒模块就位时同步取用。
// 构建图权威证据见 docs/tmp/batch3-chunk-graph-proof.txt（首屏静态闭包仅 index/core/markdown-it）。
// 本锁防回漂：若有人把 scroll-surface 改回运行期 import，codemirror 重新进入首屏图，此测试红。
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string): string => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

it('app.ts 对 scroll-surface 只保留 type-only import（运行期 import 会把 codemirror 拉进首屏静态图）', () => {
  const app = read('src/shell/app.ts');
  const ssImports = [...app.matchAll(/^import\b.*from\s+'\.\.\/common\/scroll-surface';\s*$/gm)].map(m => m[0]);
  expect(ssImports.length).toBeGreaterThan(0);
  for (const line of ssImports) expect(line).toMatch(/^import type\b/);
});

it('cmScrollSurface 为懒绑定：notLoaded 缺省 + edit/IR 两处同步取用', () => {
  const app = read('src/shell/app.ts');
  expect(app).toContain("let cmScrollSurface: typeof import('../common/scroll-surface')['cmScrollSurface'] = () => notLoaded('scroll-surface');");
  // loadEdit 与 loadLivePreview 各一处就位赋值（二者静态依赖 scroll-surface，抓取同步，锚定时序不变）
  expect(app.match(/cmScrollSurface = m\.cmScrollSurface;/g)?.length).toBe(2);
});

it('edit/IR 模块再出口 cmScrollSurface，供启动懒绑定取用', () => {
  expect(read('src/text-view/edit.ts')).toContain("export { cmScrollSurface } from '../common/scroll-surface';");
  expect(read('src/markdown-view/livepreview.ts')).toContain('export { cmScrollSurface };');
});