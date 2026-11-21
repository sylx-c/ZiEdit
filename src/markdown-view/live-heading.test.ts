// @vitest-environment jsdom
// 标题展示行为（2026-11-19 修复锁）：
// ① 光标放在标题旁边（行首/行尾贴边、邻行）不展开井号；光标进入标题正文内部或选区相交才展开；
// ② 正文 + 下划长划线不再升级成大标题：正文行按段落渲染、下划线行按分隔线部件渲染。
import { expect, it, vi } from 'vitest';

vi.mock('../common/ipc', () => ({ textOpen: async () => ({ newline: 'lf' }), textReadAll: vi.fn() }));
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const DOC = '### 每个阶段的要求\n\n正文段落文字\n';

interface Mounted {
  host: HTMLElement;
  preview: { view: import('@codemirror/view').EditorView; destroy(): void };
  dispose(): void;
}

async function mount(doc: string): Promise<Mounted> {
  const { LivePreviewView } = await import('./livepreview');
  const host = document.createElement('div'); document.body.append(host);
  const preview = new LivePreviewView(host, { path: 'E:/docs/t.md', encoding: 'UTF-8', initialDoc: doc, onStatus: () => {}, onSaved: () => {} });
  await vi.waitFor(() => expect(host.classList.contains('md-ir-loading')).toBe(false), { timeout: 2500 });
  return { host, preview, dispose: () => { preview.destroy(); host.remove(); } };
}

/** 标题留白栏是否显示井号（REQ-014 P2：井号常隐正文，活动态经 .mdir-marks-on 在留白栏显示）。 */
const gutterMarksOn = (host: HTMLElement): boolean => !!host.querySelector('.cm-line.mdir-marks-on');

async function settle(host: HTMLElement, expectVisible: boolean): Promise<void> {
  await vi.waitFor(() => expect(gutterMarksOn(host)).toBe(expectVisible), { timeout: 2500 });
}

it('光标放标题旁边（行尾贴边/行首/邻行/未交互）不展开井号', async () => {
  const { host, preview, dispose } = await mount(DOC);
  try {
    const doc = preview.view.state.doc;
    const heading = doc.line(1); // `### 每个阶段的要求`
    const body = doc.line(3);
    // 挂载后未发生过交互事务：程序化选位即使落在正文内部也不展开（touched 门）。
    preview.view.dispatch({ selection: { anchor: heading.from + 6 } });
    await settle(host, false);
    // 行尾贴边（点标题右侧空白处即落于此）：不展开。
    preview.view.dispatch({ selection: { anchor: heading.to }, userEvent: 'select.pointer' });
    await settle(host, false);
    // 行首（Home 键落点）：不展开。
    preview.view.dispatch({ selection: { anchor: heading.from }, userEvent: 'select.keyboard' });
    await settle(host, false);
    // 邻行正文：不展开。
    preview.view.dispatch({ selection: { anchor: body.from + 1 }, userEvent: 'select.pointer' });
    await settle(host, false);
  } finally { dispose(); }
});

it('光标进入标题正文内部或选区相交时留白栏显示井号，离开后收起（REQ-014 P2：正文范围恒定）', async () => {
  const { host, preview, dispose } = await mount(DOC);
  try {
    const doc = preview.view.state.doc;
    const heading = doc.line(1);
    const interior = heading.from + DOC.indexOf('阶'); // 标题文字中间
    preview.view.dispatch({ selection: { anchor: interior }, userEvent: 'select.pointer' });
    await settle(host, true);
    // 非空选区相交（格式化/删除等编辑场景）：展开。
    preview.view.dispatch({ selection: { anchor: heading.from + 4, head: heading.to }, userEvent: 'select.pointer' });
    await settle(host, true);
    // 移回邻行：收起。
    preview.view.dispatch({ selection: { anchor: doc.line(3).from + 1 }, userEvent: 'select.pointer' });
    await settle(host, false);
  } finally { dispose(); }
});

it('正文 + 下划长划线渲染为段落 + 分隔线（不再升级标题）', async () => {
  const src = '**Git** 分支、提交、合并说明\n  -------------------------------------------------\n\n后文\n';
  const { host, dispose } = await mount(src);
  try {
    // 不出现标题行样式（修前为 mdir-h2）。
    await vi.waitFor(() => expect(host.querySelector('.mdir-hr')).not.toBeNull(), { timeout: 2500 });
    expect(host.querySelector('.cm-line[class*="mdir-h"]')).toBeNull();
    expect(host.textContent).toContain('Git 分支、提交、合并说明');
    // 下划线行被分隔线部件替换，不再露出长划线源码。
    expect(host.textContent).not.toContain('----');
    // 行内加粗仍正常投影：定界符不进 DOM。
    expect(host.textContent).not.toContain('**');
  } finally { dispose(); }
});

// REQ-014 P0 覆盖审计补缺 + P2 机制迁移：仅含单一标题的文档挂载与投影正常，留白栏显隐切换。
it('仅含单一标题的文档：挂载不抛、投影正常、留白栏标记切换', async () => {
  const { host, preview, dispose } = await mount('# 仅标题\n');
  try {
    await vi.waitFor(() => expect(host.textContent).toContain('仅标题'), { timeout: 2500 });
    const doc = preview.view.state.doc;
    const heading = doc.line(1);
    // 空光标置于标题正文内部：井号展开。
    preview.view.dispatch({ selection: { anchor: heading.from + 2 }, userEvent: 'select.pointer' });
    await settle(host, true);
    // 离开到文末：井号收起。
    preview.view.dispatch({ selection: { anchor: doc.length }, userEvent: 'select.pointer' });
    await settle(host, false);
  } finally { dispose(); }
});
