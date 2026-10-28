// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { LivePreviewView, type LivePreviewOpts } from '../src/markdown-view/livepreview';
import { createRenderContext, renderContextCounters, resetRenderContextCounters } from '../src/markdown-view/render-service';
vi.mock('../src/common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textReadAll: async () => '', textSave: async () => ({ len: 0 }) }));
vi.mock('../src/markdown-view/preview', async original => ({ ...await original<object>(), loadUnicodeEmojis: async () => ({}) }));
Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
Range.prototype.getBoundingClientRect = () => new DOMRect();
const previews: LivePreviewView[] = [];
afterEach(() => {
  for (const preview of previews.splice(0)) preview.destroy();
  document.body.replaceChildren();
  resetRenderContextCounters();
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
});

/** 整篇公式序列的序列化入参形状：顶层数组内仍嵌套数组（[[source, display], ...] 或含公式表的签名）。 */
const mathListShape = (value: unknown): boolean => Array.isArray(value) && value.some(element => Array.isArray(element));

async function mount(source: string): Promise<{ preview: LivePreviewView; view: EditorView }> {
  const host = document.createElement('div'); document.body.append(host);
  const ready = vi.fn<NonNullable<LivePreviewOpts['onReady']>>();
  const preview = new LivePreviewView(host, { path: 'E:/render-context.md', encoding: 'UTF-8', initialDoc: source,
    onStatus: () => {}, onSaved: () => {}, onReady: ready });
  previews.push(preview);
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  await Promise.resolve();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return { preview, view: preview.view };
}

function type(view: EditorView, text: string): void {
  const range = view.state.selection.main;
  if (!view.state.facet(EditorView.inputHandler).some(handle => handle(view, range.from, range.to, text, () => view.state.update(view.state.replaceSelection(text)))))
    view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input.type' });
}

describe('007-AC-36 渲染上下文热路径', () => {
  it('纯文本键入不再为每个视口公式件序列化整篇公式序列', async () => {
    const source = 'type here\n\n'
      + Array.from({ length: 8 }, (_, i) => `$a_${i}^2+b$ tail ${i}\n\n`).join('')
      + Array.from({ length: 4 }, (_, i) => `$$\nd_${i}+e_${i}\n$$\n\n`).join('');
    const { view } = await mount(source);
    view.dispatch({ selection: { anchor: 0 } });
    const stringify = vi.spyOn(JSON, 'stringify');

    type(view, 'x');

    expect(stringify.mock.calls.filter(([value]) => mathListShape(value))).toHaveLength(0);
  });

  it('纯文本键入零摘要重算且不物化上下文块表', async () => {
    const source = 'type here\n\n'
      + Array.from({ length: 24 }, (_, i) => `$a_${i}^2+b$ tail ${i}\n\n`).join('');
    const { view } = await mount(source);
    expect(renderContextCounters.digestComputations).toBeGreaterThan(0);
    resetRenderContextCounters();
    view.dispatch({ selection: { anchor: 0 } });

    type(view, 'x');

    expect(renderContextCounters.digestComputations).toBe(0);
    expect(renderContextCounters.materializations).toBe(0);
  });

  it('同一块表引用的多个上下文共享世代摘要，物化按需且记忆化', () => {
    const blocks = Array.from({ length: 50 }, (_, i) =>
      ({ kind: 'math' as const, source: `a_${i}+b`, display: i % 2 === 0, from: i * 20, to: i * 20 + 12 }));
    resetRenderContextCounters();
    const first = createRenderContext(blocks, position => position + 10);
    const second = createRenderContext(blocks, position => position + 10);

    expect(renderContextCounters.digestComputations).toBe(1);
    expect(first.mathDigest).toBe(second.mathDigest);
    expect(first.mathBatch).toBe(false);

    const resolved = first.resolve();
    expect(first.resolve()).toBe(resolved);
    expect(second.resolve()).toBe(second.resolve());
    expect(renderContextCounters.materializations).toBeLessThanOrEqual(2);
    expect(resolved[3]).toEqual({ ...blocks[3]!, from: blocks[3]!.from + 10, to: blocks[3]!.to + 10 });

    const batched = createRenderContext([{ kind: 'math', source: '\\label{e}x', display: true, from: 0, to: 12 }]);
    expect(batched.mathBatch).toBe(true);
    expect(renderContextCounters.digestComputations).toBe(2);
  });
});

/** 行为锁用真实定时器挂载：MathJax 在 jsdom 中不加载，目标停在 loading 且源码可见即可观察。 */
async function mountLive(source: string): Promise<{ view: EditorView; host: HTMLElement }> {
  const host = document.createElement('div'); document.body.append(host);
  const preview = new LivePreviewView(host, { path: 'E:/render-live.md', encoding: 'UTF-8', initialDoc: source,
    onStatus: () => {}, onSaved: () => {} });
  previews.push(preview);
  await vi.waitFor(() => expect(preview.view && !!host.querySelector('.md-render-target')).toBeTruthy());
  await Promise.resolve();
  return { view: preview.view, host };
}

describe('007-AC-36 渲染上下文行为锁（优化不改变渲染语义）', () => {
  it('公式上方键入正文：件 DOM 复用不重挂，源码与位置随文档更新', async () => {
    const source = '前\n\n$a+b$\n\n中间\n\n$c_2$\n\n尾';
    const { view, host } = await mountLive(source);
    const targets = () => [...host.querySelectorAll<HTMLElement>('.md-render-target')];
    view.dispatch({ selection: { anchor: 0 } });
    await vi.waitFor(() => expect(targets()).toHaveLength(2));
    const before = targets();
    expect(before.map(target => target.textContent)).toEqual(['a+b', 'c_2']);

    view.dispatch({ changes: { from: 0, insert: '插入\n\n' }, userEvent: 'input' });

    const after = targets();
    expect(after[0]).toBe(before[0]); // updateDOM 复用同一节点
    expect(after[1]).toBe(before[1]);
    const doc = view.state.doc.toString();
    expect(after.map(target => target.dataset.renderFrom)).toEqual([String(doc.indexOf('$a+b$')), String(doc.indexOf('$c_2$'))]);
    expect(after.map(target => target.textContent)).toEqual(['a+b', 'c_2']); // 未重挂：源码节点原样
  });

  it('公式内容变更换签名重新挂载，其余公式不受牵连', async () => {
    const source = '前\n\n$a+b$\n\n中间\n\n$c_2$\n\n尾';
    const { view, host } = await mountLive(source);
    const targets = () => [...host.querySelectorAll<HTMLElement>('.md-render-target')];
    view.dispatch({ selection: { anchor: 0 } });
    await vi.waitFor(() => expect(targets()).toHaveLength(2));

    const doc = view.state.doc.toString();
    view.dispatch({ changes: { from: doc.indexOf('a+b') + 1, insert: 'x' } }); // → $ax+b$

    await vi.waitFor(() => expect(targets()[0]?.textContent).toBe('ax+b'));
    expect(view.state.doc.toString()).toContain('$ax+b$');
    expect(targets()[1]?.textContent).toBe('c_2');
  });

  it('跨公式状态文档：公式上方键入不触发整篇公式序列化', async () => {
    const source = '引 $\\eqref{e}$\n\n$$\n\\begin{equation}E=mc^2\\label{e}\\end{equation}\n$$\n\n尾';
    const { view, host } = await mountLive(source);
    view.dispatch({ selection: { anchor: 0 } });
    await vi.waitFor(() => expect(host.querySelectorAll('.md-render-target').length).toBeGreaterThan(0));
    const stringify = vi.spyOn(JSON, 'stringify');
    view.dispatch({ changes: { from: 0, insert: '插入\n\n' }, userEvent: 'input' });
    // 上方键入：件相等与挂载签名都凭世代摘要比较，无任何整篇公式序列化
    expect(stringify.mock.calls.filter(([value]) => mathListShape(value))).toHaveLength(0);
    stringify.mockRestore();
  });
});

