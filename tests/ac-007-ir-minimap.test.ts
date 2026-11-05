// @vitest-environment jsdom
// 007 规则 13 v0.16：IR 缩略图管线随引擎重造——onReady 交付 scrollEl/getLines/linesVersion 三键。
// 历史根因（v0.14）：滚动容器靠宽泛 CSS 选择器查询，旧渲染器 initUI 会把隐藏的模式容器一并挂上，
// querySelector 首个命中 DOM 序在前的隐藏 pre（display:none、scrollHeight=0），滚动监听挂到
// 永不滚动的元素上，拖滚动条缩略图不跟随。自研引擎下滚动容器即 view.scrollDOM（.cm-scroller），
// 由构造直接交付，无选择器查询面。本文件锁：scrollEl 为宿主内唯一 .cm-scroller 且与
// view.scrollDOM 同一引用；getLines 为源文本行数组（编辑后缓存失效）；linesVersion 编辑递增
// （缩略图脏检查依据）；读取失败不交付（onReady 不回调、宿主呈现错误占位、无编辑器残留）。
import { describe, expect, it, vi } from 'vitest';

let fileText = '# 一级\n\n正文甲\n\n## 二级\n\n正文乙\n';
let readFail = false;

vi.mock('../src/common/ipc', () => ({
  textOpen: async () => ({ content: '', encoding: 'UTF-8', newline: 'lf', mixed: false }),
  textReadAll: async () => {
    if (readFail) throw new Error('E1001');
    return fileText;
  },
  textSave: async () => ({ len: 0, modifiedMs: 0 }),
}));

// jsdom 无布局：Range.getClientRects 缺失会让 scrollIntoView 触发的 rAF 测量抛未捕获异常
if (!(Range.prototype as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
}

interface ReadyApi { scrollEl: HTMLElement | null; getLines: () => string[]; linesVersion: () => number }

const { LivePreviewView } = await import('../src/markdown-view/livepreview');

type LiveView = InstanceType<typeof LivePreviewView>;

async function mount(): Promise<{ v: LiveView; host: HTMLElement; api: ReadyApi }> {
  const host = document.createElement('div');
  let api: ReadyApi | null = null;
  const v = new LivePreviewView(host, {
    path: 'E:\\mock\\n.md',
    encoding: 'UTF-8',
    onStatus: () => {},
    onSaved: () => {},
    onReady: a => (api = a),
  });
  for (let i = 0; i < 100 && !api; i++) await new Promise(r => setTimeout(r, 10));
  if (!api) throw new Error('onReady 未交付');
  return { v, host, api };
}

describe('AC-12 IR 缩略图接线（规则 13 v0.16：onReady 交付）', () => {
  it('跳转到行定位源行并钳制越界，不修改文档', async () => {
    const { v } = await mount();
    const text = v.getMarkdown();
    v.goToLine(3); expect(v.view.state.selection.main.head).toBe(v.view.state.doc.line(3).from);
    v.goToLine(10000); expect(v.view.state.selection.main.head).toBe(v.view.state.doc.line(v.view.state.doc.lines).from);
    expect(v.getMarkdown()).toBe(text); v.destroy();
  });
  it('scrollEl 是宿主内唯一 .cm-scroller，且与 view.scrollDOM 同一引用（不再有选择器错挂面）', async () => {
    const { v, host, api } = await mount();
    const scrollers = host.querySelectorAll('.cm-scroller');
    expect(scrollers.length).toBe(1);
    expect(api.scrollEl).toBe(scrollers[0]);
    expect(api.scrollEl).toBe(v.view.scrollDOM);
    v.destroy();
  });

  it('getLines 返回打开文本的行数组；编辑后 linesVersion 递增、getLines 反映新文本', async () => {
    const { v, api } = await mount();
    expect(api.getLines()).toEqual(['# 一级', '', '正文甲', '', '## 二级', '', '正文乙', '']);
    const v0 = api.linesVersion();
    v.view.dispatch({ changes: { from: 0, insert: 'X' } });
    expect(api.linesVersion()).toBe(v0 + 1);
    expect(api.getLines()[0]).toBe('X# 一级');
    v.destroy();
  });

  it('destroy 清宿主：md-ir 类移除、无残留 DOM', async () => {
    const { v, host } = await mount();
    expect(host.classList.contains('md-ir')).toBe(true);
    v.destroy();
    expect(host.classList.contains('md-ir')).toBe(false);
    expect(host.children.length).toBe(0);
  });

  it('读取失败不交付 onReady：宿主呈现错误占位，无编辑器挂载', async () => {
    readFail = true;
    const host = document.createElement('div');
    let delivered = false;
    const v = new LivePreviewView(host, {
      path: 'E:\\mock\\n.md',
      encoding: 'UTF-8',
      onStatus: () => {},
      onSaved: () => {},
      onReady: () => (delivered = true),
    });
    await new Promise(r => setTimeout(r, 50));
    expect(delivered).toBe(false);
    expect(host.querySelector('.cm-editor')).toBeNull();
    expect(host.textContent).not.toBe('');
    v.destroy();
    readFail = false;
  });
});
