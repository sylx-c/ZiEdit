// @vitest-environment jsdom
// 003 方向键跨原子块导航验收锁（specs/003 contracts/arrow-atomic-navigation.md）：
//   渲染态表格（blockAtomic 原子域）边界驻留 → 方向键直接跳越对侧；
//   基底钉死（注入模拟：声明已处理但不移动，即门禁实证的两引擎形态）→ 逐键逐块推进、落点永不落域内；
//   Up 对称；Shift+方向保锚点；翻页命令钉死（返回 false）不降级为纯滚动；IME 组合期放行；
//   无原子域文档与基底行为一致（透传/原样保留）。
// jsdom 几何退化（coordsAtPos→null、content rect 全零）无法复现真实钉死的几何成因，
// 故基底命令采用注入口径；几何级端到端由原生门禁 gate-batch1-arrow 承载（SC-001）。
import { describe, expect, it, vi } from 'vitest';
import { EditorView, type EditorView as EditorViewType, type Command } from '@codemirror/view';

vi.mock('../src/common/ipc', () => ({
  textOpen: async () => ({ content: '', encoding: 'UTF-8', newline: 'lf', mixed: false }),
  textReadAll: async () => '',
  textSave: async () => ({ len: 0 }),
}));

if (!(Range.prototype as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
}

const { LivePreviewView } = await import('../src/markdown-view/livepreview');
const { makeVerticalSkip } = await import('../src/markdown-view/block-interactions');
const { compositionChanged } = await import('../src/common/composition');

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
    path: 'E:\\mock\\arrow-nav.md', encoding: 'UTF-8', initialDoc: source,
    onStatus: () => {}, onSaved: () => {}, onReady: () => (done = true),
  });
  for (let i = 0; i < 200 && !done; i++) await new Promise(r => setTimeout(r, 10));
  if (!done) throw new Error('onReady 未交付');
  return { v, host };
}

interface Span { from: number; to: number }

function blockAtomicSpans(view: EditorViewType): Span[] {
  const out: Span[] = [];
  for (const source of view.state.facet(EditorView.atomicRanges)) {
    source(view).between(0, view.state.doc.length, (from, to, value) => {
      if (to > from && value.spec.blockAtomic) out.push({ from, to });
    });
  }
  return out.sort((a, b) => a.from - b.from);
}

const insideAny = (spans: Span[], pos: number): boolean => spans.some(r => pos > r.from && pos < r.to);

/** 两张渲染态表格夹普通段落（相邻表场景：表一后紧跟表二，中间仅空行）。 */
const DOC = '段落甲第一行\n\n| 甲 | 乙 |\n| -- | -- |\n| 1 | 2 |\n\n| 丙 | 丁 |\n| -- | -- |\n| 3 | 4 |\n\n段落乙收尾\n';

/** 门禁钉死形态的注入基底：声明已处理、头端不动。 */
const pinnedHandled: Command = () => true;
/** 翻页命令钉死形态的注入基底：返回 false（未处理）。 */
const pinnedUnhandled: Command = () => false;

const press = (view: EditorViewType, key: string): void => {
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};

async function mountWithTables(): Promise<{ m: Mount; spans: Span[] }> {
  const m = await mount(DOC);
  m.v.view.dispatch({ selection: { anchor: m.v.view.state.doc.length }, userEvent: 'select.pointer' });
  await until(() => m.host.querySelectorAll('table.mdir-table').length >= 2);
  const spans = blockAtomicSpans(m.v.view);
  expect(spans.length).toBeGreaterThanOrEqual(2);
  return { m, spans: [spans[0]!, spans[1]!] };
}

describe('003 垂直移动跨原子块跳越', () => {
  it('头端驻留表格块首边界：ArrowDown 免基底直接跳到块尾之外', async () => {
    const { m, spans } = await mountWithTables();
    m.v.view.dispatch({ selection: { anchor: spans[0].from } });
    press(m.v.view, 'ArrowDown');
    expect(m.v.view.state.selection.main.head).toBe(spans[0].to);
    expect(insideAny(blockAtomicSpans(m.v.view), m.v.view.state.selection.main.head)).toBe(false);
    m.v.destroy();
  });

  it('头端驻留表格块尾边界：ArrowUp 跳到块首（对称）', async () => {
    const { m, spans } = await mountWithTables();
    m.v.view.dispatch({ selection: { anchor: spans[0].to } });
    press(m.v.view, 'ArrowUp');
    expect(m.v.view.state.selection.main.head).toBe(spans[0].from);
    m.v.destroy();
  });

  it('基底钉死（已处理不动）：ArrowDown 逐键逐块推进、落点永不落域内、无下块后驻留', async () => {
    const { m, spans } = await mountWithTables();
    const down = makeVerticalSkip(pinnedHandled, 1);
    m.v.view.dispatch({ selection: { anchor: 0 } });
    const trace: number[] = [];
    for (let i = 0; i < 8; i++) {
      expect(down(m.v.view)).toBe(true);
      const head = m.v.view.state.selection.main.head;
      trace.push(head);
      expect(insideAny(blockAtomicSpans(m.v.view), head)).toBe(false);
    }
    // 0 → 表一尾 → 表二尾 → 驻留（相邻表逐块跳越，不落空档死循环）
    expect(trace.slice(0, 2)).toEqual([spans[0].to, spans[1].to]);
    expect(trace[2]).toBe(spans[1].to);
    expect(trace[7]).toBe(spans[1].to);
    m.v.destroy();
  });

  it('基底钉死：ArrowUp 对称逐块上推，可达文档首并驻留', async () => {
    const { m, spans } = await mountWithTables();
    const up = makeVerticalSkip(pinnedHandled, -1);
    m.v.view.dispatch({ selection: { anchor: m.v.view.state.doc.length } });
    const trace: number[] = [];
    for (let i = 0; i < 8; i++) {
      expect(up(m.v.view)).toBe(true);
      const head = m.v.view.state.selection.main.head;
      trace.push(head);
      expect(insideAny(blockAtomicSpans(m.v.view), head)).toBe(false);
    }
    expect(trace.slice(0, 2)).toEqual([spans[1].from, spans[0].from]);
    expect(trace[2]).toBe(spans[0].from);
    expect(trace[7]).toBe(spans[0].from);
    m.v.destroy();
  });

  it('非空选区（Shift 语义）：跳越保锚点只移头端', async () => {
    const { m, spans } = await mountWithTables();
    const shiftDown = makeVerticalSkip(pinnedHandled, 1);
    m.v.view.dispatch({ selection: { anchor: 0, head: 4 } });
    expect(shiftDown(m.v.view)).toBe(true);
    const sel = m.v.view.state.selection.main;
    expect(sel.anchor).toBe(0);
    expect(sel.head).toBe(spans[0].to);
    m.v.destroy();
  });

  it('翻页命令钉死（返回 false）：前方有原子域仍跳越，不降级为纯滚动；无候选透传 false', async () => {
    const { m, spans } = await mountWithTables();
    const pageDown = makeVerticalSkip(pinnedUnhandled, 1);
    m.v.view.dispatch({ selection: { anchor: 0 } });
    expect(pageDown(m.v.view)).toBe(true);
    expect(m.v.view.state.selection.main.head).toBe(spans[0].to);
    // 表二之后无更下方的原子域 → 透传 false（文档边界合法驻留）
    m.v.view.dispatch({ selection: { anchor: spans[1].to } });
    expect(pageDown(m.v.view)).toBe(false);
    expect(m.v.view.state.selection.main.head).toBe(spans[1].to);
    m.v.destroy();
  });

  it('IME 组合期：不拦截（返回 false、头端不动），交回默认处理', async () => {
    const { m } = await mountWithTables();
    const down = makeVerticalSkip(pinnedHandled, 1);
    m.v.view.dispatch({ selection: { anchor: 0 }, effects: compositionChanged.of(true) });
    expect(down(m.v.view)).toBe(false);
    expect(m.v.view.state.selection.main.head).toBe(0);
    m.v.view.dispatch({ effects: compositionChanged.of(false) });
    m.v.destroy();
  });

  it('无原子域文档：与基底行为一致（基底 false 透传；基底 true 原样保留、不异动）', async () => {
    const m = await mount('# 题\n\n正文一\n正文二\n');
    const view: EditorViewType = m.v.view;
    const down = makeVerticalSkip(pinnedUnhandled, 1);
    view.dispatch({ selection: { anchor: 0 } });
    expect(down(view)).toBe(false);
    expect(view.state.selection.main.head).toBe(0);
    const noop = makeVerticalSkip(pinnedHandled, 1);
    expect(noop(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(0);
    m.v.destroy();
  });
});
