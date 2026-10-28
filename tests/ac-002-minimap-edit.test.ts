// @vitest-environment jsdom
// 002 规则 23 验收补强（P3，反馈 22）：缩略图按行内语法分段着色（demo .mm-bar/.mm-seg 口径）。
// 修前缺陷——查看态 adapter 有 lineSpans（hlSpanMap），编辑态 adapter 漏了该字段，
// 而默认打开模式恰恰是编辑态：用户看到的是单色缩略图（「跟设计稿不一样」）。
// 本组用例锁两件事：①着色判决在 Minimap 内确实按 lineSpans 分段上色（有/无对比）；
// ②编辑态 adapter 必须接上 lineSpans（源码契约锁——漏掉即静默退化成单色条，无任何报错）。
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Minimap, type MinimapAdapter, type MmSpan } from '../src/text-view/minimap';

/** jsdom 无布局：clientHeight 恒 0 会让 sync() 直接返回，桩成固定高让密度条渲染 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 400;
    },
  });
});

const LINES = 120;
const text = (n: number): string => {
  if (n % 4 === 0) return '';
  if (n % 4 === 1) return 'const x = 1';
  if (n % 4 === 2) return '  return x';
  return '// note';
};

const baseAdapter = (spans?: (n: number) => MmSpan[] | undefined): MinimapAdapter => ({
  scrollTop: () => 0,
  scrollHeight: () => 2000,
  clientHeight: () => 400,
  scrollTo: () => void 0,
  totalLines: () => LINES,
  lineText: n => (n >= 1 && n <= LINES ? text(n) : undefined),
  lineSpans: spans,
  cacheVersion: () => 1,
  spansVersion: () => 1,
});

describe('002 AC（23 补强）：缩略图编辑态语法着色', () => {
  it('有 lineSpans → 行内分段着色（k/s 类段），空行无段', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const mm = new Minimap(host, baseAdapter(n => (text(n).trim() ? [{ from: 0, to: 5, cls: 'k' }, { from: 5, to: 9, cls: 's' }] : [])));
    mm.sync();
    expect(host.querySelectorAll('.mm-seg.k').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('.mm-seg.s').length).toBeGreaterThan(0);
    // 空行只是细短条，不带分段
    const bars = [...host.querySelectorAll('.mm-bar')] as HTMLElement[];
    expect(bars.length).toBeGreaterThan(0);
    mm.remove();
  });

  it('无 lineSpans → 单色条（修前编辑态的观感；防"两态同口径"再次漂移）', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const mm = new Minimap(host, baseAdapter(undefined));
    mm.sync();
    expect(host.querySelectorAll('.mm-bar').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('.mm-seg').length).toBe(0);
    mm.remove();
  });

  it('编辑态 adapter 已接 lineSpans（源码契约锁：缺字段不报错、只静默单色）', () => {
    const src = readFileSync(resolve(__dirname, '../src/text-view/edit.ts'), 'utf8');
    expect(src).toContain('lineSpans: n => this.mmLineSpans(n)');
    expect(src).toContain('highlightLines'); // 与查看态同源（Lezer token → tok-*）
    // 缓存版本随文档变化失效（否则编辑后着色滞留旧结构）
    expect(src).toContain('spansVersion: () => this.mmSpanVersion');
  });
});
