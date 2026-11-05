// @vitest-environment jsdom
// 解析预热（007 规则 22 滚动零长帧口径）：大文档挂载后小片推进全文解析，
// 消除首次跳转未解析区域的 ~100ms 补解析长帧；小文档/无语言/超上限不调度。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { startParseWarmup } from '../src/common/parse-warmup';
import { markUserScroll, clearUserScroll } from '../src/common/user-scroll';

vi.mock('../src/common/render-queue', () => ({
  requestIrFrame: (callback: () => void) => { warmups.push(callback); pending.push(callback); return pending.length; },
  cancelIrFrame: () => {},
  remainingRenderBudget: () => 8,
}));

const pending: (() => void)[] = [];
const warmups: (() => void)[] = [];
const ricStub = vi.fn((cb: () => void) => {
  pending.push(cb);
  return pending.length;
});
// 批 3（IR 深水）：预热调度链为 rAF→idle 双层，pump 需同时驱动 rAF 队列
const rafStub = vi.fn((cb: () => void) => {
  pending.push(cb);
  return pending.length;
});

function pump(limit = 2000): void {
  let guard = 0;
  while (pending.length && guard++ < limit) pending.shift()!();
}

const views: EditorView[] = [];
function makeView(doc: string, withLang: boolean): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: withLang ? [markdown()] : [] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

describe('parse-warmup', () => {
  vi.stubGlobal('requestIdleCallback', ricStub);
  vi.stubGlobal('requestAnimationFrame', rafStub);

  afterEach(() => {
    pending.length = 0;
    warmups.length = 0;
    ricStub.mockClear();
    for (const v of views.splice(0)) v.destroy();
  });

  it('大文档（256KiB–4MiB）小片推进至全文解析完成', () => {
    const doc = '段落标题\n======\n\n正文重复内容，用于填充体量。\n\n'.repeat(12000); // ≈600KB
    const view = makeView(doc, true);
    expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(false);
    const stop = startParseWarmup(view, () => true);
    pump();
    expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
    stop();
  });

  it('小文档不调度', () => {
    const view = makeView('# 小文档\n\n正文。\n', true);
    startParseWarmup(view, () => true);
    expect(ricStub).not.toHaveBeenCalled();
  });

  it('64KiB 以上的混合文档也使用分片预热，不留下默认后台长片', () => {
    const view = makeView(('paragraph with *emphasis*\n\n| A | B |\n| --- | --- |\n| x | y |\n\n').repeat(1400), true);
    const stop = startParseWarmup(view, () => true);
    expect(pending.length).toBeGreaterThan(0);
    pump();
    expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
    stop();
  });

  it('视口前瞻就绪后为连续滚动让出全文预热，停手后接续完成', () => {
    const view = makeView('paragraph *emphasis* and `code`\n\n'.repeat(40000), true);
    const stop = startParseWarmup(view, () => true);
    const ahead = Math.min(view.state.doc.length, view.viewport.to + 100_000);
    // 单独驱动应用队列，CM 的默认 idle 解析不参与这个调度检查。
    for (let i = 0; i < 1000 && !syntaxTreeAvailable(view.state, ahead); i++) warmups.shift()!();
    expect(syntaxTreeAvailable(view.state, ahead)).toBe(true);
    expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(false);
    markUserScroll(view.scrollDOM);
    for (let i = 0; i < 10; i++) warmups.shift()!();
    expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(false);
    clearUserScroll(view.scrollDOM);
    for (let i = 0; i < 2000 && warmups.length; i++) warmups.shift()!();
    expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
    stop();
  });

  it('连续滚动中视口因块解析扩展时，补齐新的前瞻范围再暂停全文预热', () => {
    const view = makeView('paragraph *emphasis* and `code`\n\n'.repeat(40000), true);
    const stop = startParseWarmup(view, () => true);
    let viewport: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const initialAhead = Math.min(view.state.doc.length, view.viewport.to + 100_000);
      for (let i = 0; i < 1000 && !syntaxTreeAvailable(view.state, initialAhead); i++) warmups.shift()!();
      const nextViewport = initialAhead + 160_000, nextAhead = nextViewport + 100_000;
      expect(syntaxTreeAvailable(view.state, nextAhead)).toBe(false);
      viewport = vi.spyOn(view, 'viewport', 'get').mockReturnValue({ from: 0, to: nextViewport });
      markUserScroll(view.scrollDOM);
      for (let i = 0; i < 1000 && !syntaxTreeAvailable(view.state, nextAhead); i++) warmups.shift()!();
      expect(syntaxTreeAvailable(view.state, nextAhead)).toBe(true);
      expect(syntaxTree(view.state).length).toBeGreaterThanOrEqual(nextAhead);
      expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(false);
    } finally { clearUserScroll(view.scrollDOM); viewport?.mockRestore(); stop(); }
  });

  it('无语言不调度（纯文本兜底，防空转）', () => {
    const doc = 'x'.repeat(300 * 1024);
    const view = makeView(doc, false);
    startParseWarmup(view, () => true);
    expect(ricStub).not.toHaveBeenCalled();
  });

  it('超上限文档不做全文预热', () => {
    const doc = 'y'.repeat(10 * 1024 * 1024 + 8);
    const view = makeView(doc, true);
    startParseWarmup(view, () => true);
    expect(ricStub).not.toHaveBeenCalled();
  });

  it('停止后不推进、不抛错；视图销毁后 isAlive 拦截', () => {
    const doc = '段落\n\n'.repeat(80000); // ≈480KB
    const view = makeView(doc, true);
    const stop = startParseWarmup(view, () => true);
    stop();
    pump();
    expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(false);
    const view2 = makeView(doc, true);
    startParseWarmup(view2, () => false); // 视同已销毁
    pump();
    expect(syntaxTreeAvailable(view2.state, view2.state.doc.length)).toBe(false);
  });
});
