// @vitest-environment jsdom
// 007 v0.16 规则 23 M3 / AC-26 验收锁（UX-C5：打磨与门禁）：
// math/mermaid 未随包块降级——代码块观感、源码可见、语言标签件（规则 21 口径，不静默空白）；
// 边角回归走查——空文档 / 超长行 / 嵌套列表（列表项粒度活动块）/ 引用内代码块 /
// 任务列表嵌套 / 表格含对齐与转义竖线；
// 规则 22 结构代理——装饰仅构建可视区间（视口 ±VIEWPORT_MARGIN，源契约 + 大文档
// DOM 行数有界），毫秒级门禁（键入中位帧/滚动零长帧/挂载 ≤1.5×）留真机实测。
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let fileText = '';

vi.mock('../src/common/ipc', () => ({
  textOpen: async () => ({ content: '', encoding: 'UTF-8', newline: 'lf', mixed: false }),
  textReadAll: async () => fileText,
  textSave: async () => ({ len: 0, modifiedMs: 0 }),
}));

if (!(Range.prototype as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
}

const { LivePreviewView } = await import('../src/markdown-view/livepreview');
type LiveView = InstanceType<typeof LivePreviewView>;

interface Mount { v: LiveView; host: HTMLElement }

async function mount(): Promise<Mount> {
  const host = document.createElement('div');
  let done = false;
  const v = new LivePreviewView(host, {
    path: 'E:\\mock\\n.md',
    encoding: 'UTF-8',
    onStatus: () => {},
    onSaved: () => {},
    onReady: () => (done = true),
  });
  for (let i = 0; i < 100 && !done; i++) await new Promise(r => setTimeout(r, 10));
  if (!done) throw new Error('onReady 未交付');
  return { v, host };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`等待超时：条件在 ${ms}ms 内未成立`);
    await new Promise(r => setTimeout(r, 25));
  }
}

function text(host: HTMLElement): string {
  return (host.querySelector('.cm-content') as HTMLElement | null)?.textContent ?? '';
}

describe('M3 math/mermaid 离线渲染入口（007 v0.25）', () => {
  it('mermaid/math 围栏进入共享渲染，加载期间保留源码', async () => {
    fileText = '# 题\n\n```mermaid\ngraph TD\nA-->B\n```\n\n```math\nx^2\n```\n\n尾段\n';
    const { v, host } = await mount();
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length } }); // 光标出块（降级块非活动）
    // 源码在解析/装饰就绪前已可见，等待实际的非活动代码块呈现，避免并行运行时抢读。
    await until(() => host.querySelectorAll('.md-render-target').length === 2 && !text(host).includes('```'));
    expect(text(host)).toContain('A-->B'); // mermaid 源码可见
    expect(text(host)).toContain('x^2'); // math 源码可见
    expect(text(host)).not.toContain('```'); // 围栏标记隐藏（代码块观感）
    const labels = [...host.querySelectorAll<HTMLElement>('.md-render-target')].map(e => e.dataset.renderKind);
    expect(labels).toContain('mermaid');
    expect(labels).toContain('math');
    expect(v.getMarkdown()).toBe(fileText);
    v.destroy();
  });

  it('闭合 $$ 段进入公式渲染且不修改主文档', async () => {
    fileText = '# 题\n\n$$\nx^2\n$$\n\n尾段\n';
    const { v, host } = await mount();
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length } });
    await until(() => text(host).includes('x^2'));
    await until(() => !!host.querySelector('.md-render-target[data-render-kind="math"]'));
    expect(v.getMarkdown()).toBe(fileText);
    v.destroy();
  });
});

describe('M3 边角回归走查', () => {
  it('空文档：挂载不抛、文档模型为空、状态上报', async () => {
    fileText = '';
    const { v, host } = await mount();
    expect(v.getMarkdown()).toBe('');
    expect(v.contentSizeHint()).toBe(0);
    v.view.dispatch({ changes: { from: 0, insert: '# 新\n' } }); // 空文档首键
    expect(v.getMarkdown()).toBe('# 新\n');
    v.destroy();
  });

  it('超长行（120KB 单行含标记）：挂载/键入不抛，文本原样', async () => {
    fileText = '**头**' + '长'.repeat(120_000) + '**尾**\n';
    const { v, host } = await mount();
    expect(v.getMarkdown().length).toBe(fileText.length);
    const end = v.view.state.doc.length - 1;
    v.view.dispatch({ changes: { from: end, insert: '补' }, selection: { anchor: end + 1 } });
    expect(v.getMarkdown().endsWith('**尾**补\n')).toBe(true);
    void host;
    v.destroy();
  });

  it('编辑嵌套列表正文时兄弟项与父项均保留项目符号', async () => {
    fileText = '- 甲\n  - 乙\n    - 丙\n- 丁\n';
    const { v, host } = await mount();
    v.view.dispatch({ selection: { anchor: fileText.indexOf('丙') } });
    await until(() => host.querySelectorAll('.mdir-listmark').length === 4);
    expect(text(host)).not.toContain('- 丙');
    expect(text(host)).toContain('◦ 丙');
    const sibling = [...host.querySelectorAll<HTMLElement>('.mdir-list-line')].find(line => line.textContent?.includes('丙'))!;
    expect(sibling.style.getPropertyValue('--mdir-list-depth')).toBe('2');
    expect(v.getMarkdown()).toBe(fileText);
    v.destroy();
  });

  it('引用内代码块：围栏隐藏、代码体保留、引用行观感类', async () => {
    fileText = '> 引文\n>\n> ```ts\n> let x = 1\n> ```\n';
    const { v, host } = await mount();
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length } }); // 引用块非活动
    await until(() => text(host).includes('let x = 1'));
    expect(text(host)).not.toContain('```');
    expect(text(host)).toContain('引文');
    expect(host.querySelector('.cm-line.mdir-quote')).not.toBeNull();
    v.destroy();
  });

  it('编辑父任务正文不展开嵌套任务语法', async () => {
    fileText = '- [ ] 父\n  - [x] 子\n- [x] 兄\n';
    const { v, host } = await mount();
    v.view.dispatch({ selection: { anchor: fileText.indexOf('父') } });
    await until(() => host.querySelectorAll('input.mdir-task').length === 3);
    expect(text(host)).not.toContain('[x]');
    expect(text(host)).not.toContain('[ ]');
    v.destroy();
  });

  it('表格含对齐与转义竖线：三向对齐落 th，格内 \\| 按展示口径去转义', async () => {
    fileText = '| 左 | 中 | 右 |\n|:--|:-:|--:|\n| a\\|b | c | d |\n\n尾段\n';
    const { v, host } = await mount();
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length } });
    await until(() => host.querySelector('table.mdir-table') !== null);
    const ths = [...host.querySelectorAll('.mdir-table th')] as HTMLElement[];
    expect(ths.map(e => e.textContent)).toEqual(['左', '中', '右']);
    expect(ths[0]!.style.textAlign).toBe('left');
    expect(ths[1]!.style.textAlign).toBe('center');
    expect(ths[2]!.style.textAlign).toBe('right');
    const td = host.querySelector('.mdir-table tbody td')!;
    expect(td.textContent).toBe('a|b'); // \| 转义竖线按 GFM 展示口径还原
    v.destroy();
  });
});

describe('AC-26 规则 22 结构代理（装饰仅构建可视区间；毫秒门禁留真机）', () => {
  it('源契约：装饰窗按 view.viewport ± VIEWPORT_MARGIN 截取', () => {
    const lp = readFileSync(resolve(__dirname, '../src/markdown-view/livepreview.ts'), 'utf8');
    expect(lp).toContain('VIEWPORT_MARGIN');
    expect(lp).toMatch(/view\.viewport\.from - VIEWPORT_MARGIN/);
    expect(lp).toMatch(/view\.viewport\.to \+ VIEWPORT_MARGIN/);
  });

  it('大文档（1500 块）：挂载后 DOM 行数有界（视口承载，非整篇入 DOM）', async () => {
    fileText = Array.from({ length: 1500 }, (_, i) => `## 题${i}\n\n**粗**段${i}\n`).join('');
    const { v, host } = await mount();
    await until(() => host.querySelector('.cm-line.mdir-h2') !== null);
    const lines = host.querySelectorAll('.cm-line').length;
    expect(lines).toBeLessThan(120); // 1500 块 ≈ 4500 行——DOM 仅承载视口（CM6 虚拟化 + 装饰视口窗）
    const heads = host.querySelectorAll('.cm-line.mdir-h2').length;
    expect(heads).toBeGreaterThan(0);
    expect(heads).toBeLessThan(60); // 装饰只覆盖视口 ±300 字符，非全量标题
    v.destroy();
  });
});
