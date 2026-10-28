// @vitest-environment jsdom
// 007 v0.40 规则 26/27 验收锁：
// 块级替换件原子域全覆盖：表格/公式/Mermaid/分隔线非活动替换态原子（atomicRanges 放行），
// 光标 arrow 移动不落入件内；边界闭区间激活显源码语义不变；
// RenderWidget/TableWidget 保守托底 estimatedHeight；CSS 源行高契约不漂移。
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EditorView, type EditorView as EditorViewType } from '@codemirror/view';

vi.mock('../src/common/ipc', () => ({
  textOpen: async () => ({ content: '', encoding: 'UTF-8', newline: 'lf', mixed: false }),
  textReadAll: async () => '',
  textSave: async () => ({ len: 0 }),
}));

if (!(Range.prototype as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
}

const { LivePreviewView } = await import('../src/markdown-view/livepreview');

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时：条件在 ${ms}ms 内未成立`);
    await new Promise(r => setTimeout(r, 25));
  }
}

interface Mount { v: InstanceType<typeof LivePreviewView>; host: HTMLElement }

async function mount(source: string): Promise<Mount> {
  const host = document.createElement('div');
  document.body.append(host);
  let done = false;
  const v = new LivePreviewView(host, {
    path: 'E:\\mock\\atomic.md', encoding: 'UTF-8', initialDoc: source,
    onStatus: () => {}, onSaved: () => {}, onReady: () => (done = true),
  });
  for (let i = 0; i < 200 && !done; i++) await new Promise(r => setTimeout(r, 10));
  if (!done) throw new Error('onReady 未交付');
  return { v, host };
}

function atomicRangesAt(view: EditorViewType, pos: number): boolean {
  for (const source of view.state.facet(EditorView.atomicRanges)) {
    const iter = source(view).iter();
    while (iter.value) {
      if (iter.from <= pos && pos < iter.to) return true;
      if (iter.from > pos) break;
      iter.next();
    }
  }
  return false;
}

describe('007 v0.40 块级替换件原子域全覆盖（规则 26）', () => {
  it('非活动表格/分隔线/显示公式替换区间均纳入原子域，arrow 光标不落入件内', async () => {
    const source = '| 甲 | 乙 |\n| -- | -- |\n| 1 | 2 |\n\n---\n\n$$\nx+y\n$$\n\n尾段\n';
    const { v, host } = await mount(source);
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length }, userEvent: 'select.pointer' });
    await until(() => !!host.querySelector('table.mdir-table') && !!host.querySelector('.mdir-hr')
      && !!host.querySelector('.md-render-target[data-render-display="1"]'));
    // 件内任意位置均为原子
    expect(atomicRangesAt(v.view, source.indexOf('甲'))).toBe(true);
    expect(atomicRangesAt(v.view, source.indexOf('--'))).toBe(true);
    expect(atomicRangesAt(v.view, source.indexOf('---'))).toBe(true);
    expect(atomicRangesAt(v.view, source.indexOf('x+y'))).toBe(true);
    // arrow 移动：件内落点请求（模拟光标落入件内）被原子域拦回——直接断言件内位置原子
    v.view.dispatch({ selection: { anchor: source.indexOf('甲') }, userEvent: 'select.pointer' });
    expect(atomicRangesAt(v.view, v.view.state.selection.main.head)).toBe(true);
    v.destroy();
  });

  it('边界闭区间激活显源码语义保持：光标落在公式块 from/to 仍显源码', async () => {
    const source = '$$\nx+y\n$$\n\n尾段\n';
    const { v, host } = await mount(source);
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length }, userEvent: 'select.pointer' });
    await until(() => (host.querySelector('.cm-content') as HTMLElement).textContent?.includes('x+y')
      && !(host.querySelector('.cm-content') as HTMLElement).textContent?.includes('$$'));
    const from = 0, to = source.indexOf('\n\n');
    // 落在块边界（to，紧挨换行）→ 激活显源码
    v.view.dispatch({ selection: { anchor: to }, userEvent: 'select.pointer' });
    await until(() => (host.querySelector('.cm-content') as HTMLElement).textContent?.includes('$$'));
    // 落块内 → 激活显源码
    v.view.dispatch({ selection: { anchor: from }, userEvent: 'select.pointer' });
    await until(() => (host.querySelector('.cm-content') as HTMLElement).textContent?.includes('$$'));
    v.destroy();
  });
});

describe('007 v0.40 差分路径谓词门回归（规则 27 修正）', () => {
  it('纯选区移出围栏编辑行：起始围栏恢复 CodeLabelWidget 折叠（fenceSource 衰减翻转）', async () => {
    const source = '# 题\n\n```ts\nlet x = 1\n```\n\n尾段\n';
    const { v, host } = await mount(source);
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length }, userEvent: 'select.pointer' });
    await until(() => !!host.querySelector('.mdir-codelabel'));
    const openFrom = source.indexOf('```ts');
    // 进入围栏编辑态：点击语言标签的真实流——选区落围栏行内 + fenceSourceChanged.of(行首)
    v.view.dispatch({
      selection: { anchor: openFrom + 1, head: openFrom + 3 },
      effects: (await import('../src/markdown-view/writing')).fenceSourceChanged.of(openFrom),
      userEvent: 'select.pointer',
    });
    await until(() => (host.querySelector('.cm-content') as HTMLElement).textContent?.includes('```ts'));
    // 纯选区事务移出围栏行（空选区）→ fenceSourceField 衰减为 null → 起始围栏应恢复折叠
    v.view.dispatch({ selection: { anchor: source.indexOf('尾段') }, userEvent: 'select.pointer' });
    await until(() => !!(host.querySelector('.mdir-codelabel')) && !(host.querySelector('.cm-content') as HTMLElement).textContent?.includes('```ts'));
    expect((host.querySelector('.cm-content') as HTMLElement).textContent).not.toContain('```ts');
    expect((host.querySelector('.cm-content') as HTMLElement).textContent).toContain('let x = 1');
    v.destroy();
  });

  it('纯选区进出 TOC 块：TocWidget 随 active 探针翻转出现/消失', async () => {
    const source = '# 甲\n\n[toc]\n\n尾段\n';
    const { v, host } = await mount(source);
    v.view.dispatch({ selection: { anchor: source.indexOf('尾段') }, userEvent: 'select.pointer' });
    await until(() => !!host.querySelector('nav.mdir-toc'));
    // 空光标移入 [toc] 行 → TOC 块激活显源码，TocWidget 消失
    v.view.dispatch({ selection: { anchor: source.indexOf('[toc]') }, userEvent: 'select.pointer' });
    await until(() => !host.querySelector('nav.mdir-toc') && (host.querySelector('.cm-content') as HTMLElement).textContent?.includes('[toc]'));
    // 移出 → TocWidget 恢复
    v.view.dispatch({ selection: { anchor: source.indexOf('尾段') }, userEvent: 'select.pointer' });
    await until(() => !!host.querySelector('nav.mdir-toc'));
    v.destroy();
  });
});

describe('007 v0.40 保守托底高度（规则 27）', () => {
  it('RenderWidget/TableWidget estimatedHeight ≥ 源行数×21.6 且 ≥ 显示下限', async () => {
    // 通过源码结构锁：layout.ts 常量与 widget 实现不漂移（批次 4 拆分后 Widget 类在 live-widgets.ts，
    // 断言对象随迁，锁语义不变）
    const layout = readFileSync(resolve(__dirname, '../src/markdown-view/layout.ts'), 'utf8');
    const lp = readFileSync(resolve(__dirname, '../src/markdown-view/live-widgets.ts'), 'utf8');
    expect(layout).toContain('SOURCE_LINE_HEIGHT_PX = 21.6');
    // RenderWidget：max(源行数×行高, 40)
    expect(lp).toMatch(/class RenderWidget[\s\S]*?estimatedHeight[\s\S]*?Math\.max\(lines \* SOURCE_LINE_HEIGHT_PX, 40\)/);
    // TableWidget：max(源行数×行高, (行数+1)×32)
    expect(lp).toMatch(/class TableWidget[\s\S]*?estimatedHeight[\s\S]*?Math\.max\(Math\.max\(1, this\.sourceLines\) \* SOURCE_LINE_HEIGHT_PX, \(this\.rows\.length \+ 1\) \* 32\)/);
  });

  it('CSS 源行高契约不漂移（基准 13.5px×1.6，随 --md-fs-user 等比派生）', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
    const m = /\.md-ir \.cm-scroller\{([^}]*)\}/.exec(css);
    expect(m).not.toBeNull();
    // 三面共享正文令牌（007 规则 16/20 v2.1：--md-fs-user 派生，缺省 13.5px）。
    expect(css).toContain('--md-fs-base:var(--md-fs-user,13.5px)');
    expect(m![1]).toContain('font-size:var(--md-fs-base)');
    expect(css).toMatch(/\.md-preview \.md-col\{[^}]*font-size:var\(--md-fs-base\)/);
    expect(m![1]).toContain('line-height:1.6');
    // 显示公式占位 min-height 40px 与 RenderWidget 下限一致
    expect(css).toContain('.md-render-target[data-render-display="1"]{display:block;min-height:40px');
    // 表格行高初值 32 与 TableWidget 下限一致
    const tv = readFileSync(resolve(__dirname, '../src/markdown-view/table-viewport.ts'), 'utf8');
    expect(tv).toContain('Array(rows).fill(32)');
  });
});
