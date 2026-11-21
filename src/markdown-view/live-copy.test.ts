// 004 US1（T005）：IR live preview 代码块复制集成测试（Typora parity P1）。
// 契约：无选区光标在代码块内 → 「复制代码块」只写 CodeText 源文本；
// 选区复制保持 CM 源文档语义；剪贴板失败有可见反馈；销毁/只读/IME 防护不写不闪。
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const clip = vi.hoisted(() => ({ writes: [] as string[], fail: false }));

vi.mock('../common/clipboard', () => ({
  readClipboardText: async () => '',
  writeClipboardText: async () => {},
  writeClipboardTextChecked: async (text: string) => {
    if (clip.fail) return false;
    clip.writes.push(text);
    return true;
  },
}));

vi.mock('../common/ipc', () => ({
  textOpen: async () => ({ content: '', encoding: 'UTF-8', newline: 'lf', mixed: false }),
  textReadAll: async () => '',
  textSave: async () => ({ len: 0, modifiedMs: 0 }),
}));

if (!(Range.prototype as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
}

type MenuItems = unknown[][];

async function mount(): Promise<{
  v: { view: { dispatch: (spec: unknown) => void; state: { doc: { length: number } } }; destroy: () => void } & Record<string, unknown>;
  items: () => MenuItems;
  flashes: () => string[];
}> {
  const { LivePreviewView } = await import('./livepreview');
  const host = document.createElement('div');
  let captured: MenuItems = [];
  const flashed: string[] = [];
  let ready = false;
  const v = new LivePreviewView(host, {
    path: 'E:\\mock\\doc\\copy.md',
    encoding: 'UTF-8',
    initialDoc: '# 标题\n\n```js\nconst x = 1;\n```\n\n段落。\n',
    onStatus: () => {},
    onSaved: () => {},
    onReady: () => (ready = true),
    showMenu: items => (captured = items as MenuItems),
    onFlash: msg => flashed.push(msg),
  }) as never;
  for (let i = 0; i < 100 && !ready; i++) await new Promise(r => setTimeout(r, 10));
  if (!ready) throw new Error('onReady 未交付');
  // jsdom 无布局：posAtCoords 返回 0 会绕过「右键位置缺省用光标」的 fallback，钉为 null
  vi.spyOn((v as unknown as { view: { posAtCoords: (p: { x: number; y: number }) => number | null } }).view, 'posAtCoords').mockReturnValue(null);
  return {
    v: v as never,
    items: () => captured,
    flashes: () => flashed,
  };
}

const fireContext = (v: { view: { contentDOM: HTMLElement } }): void => {
  v.view.contentDOM.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }));
};

const actionOf = (items: MenuItems, label: string): (() => void) | null => {
  for (const item of items) {
    if (String(item[0]) === label && typeof item[1] === 'function') return item[1] as () => void;
  }
  return null;
};

describe('IR 代码块复制（004 FR-001/FR-002/FR-004）', () => {
  it('光标在代码块内右键出现「复制代码块」，执行只写 CodeText', async () => {
    clip.writes.length = 0;
    const { v, items } = await mount();
    const doc = '# 标题\n\n```js\nconst x = 1;\n```\n\n段落。\n';
    v.view.dispatch({ selection: { anchor: doc.indexOf('const') + 1 } });
    fireContext(v as never);
    const act = actionOf(items(), '复制代码块');
    expect(act, '菜单应含「复制代码块」').not.toBeNull();
    act!();
    await new Promise(r => setTimeout(r, 20));
    expect(clip.writes).toEqual(['const x = 1;\n']);
  });

  it('光标在代码块外（段落）不出现「复制代码块」', async () => {
    const { v, items } = await mount();
    const doc = '# 标题\n\n```js\nconst x = 1;\n```\n\n段落。\n';
    v.view.dispatch({ selection: { anchor: doc.indexOf('段落') + 1 } });
    fireContext(v as never);
    expect(actionOf(items(), '复制代码块')).toBeNull();
  });

  it('选区复制走共享剪贴板通道并保持源文档语义（execCommand 退场）', async () => {
    clip.writes.length = 0;
    const { v, items } = await mount();
    const doc = '# 标题\n\n```js\nconst x = 1;\n```\n\n段落。\n';
    v.view.dispatch({ selection: { anchor: doc.indexOf('const'), head: doc.indexOf('1;') + 2 } });
    fireContext(v as never);
    const act = actionOf(items(), '复制');
    expect(act).not.toBeNull();
    act!();
    await new Promise(r => setTimeout(r, 20));
    expect(clip.writes).toEqual(['const x = 1;']);
  });

  it('空选区触发复制不写剪贴板', async () => {
    clip.writes.length = 0;
    const { v, items } = await mount();
    const doc = '# 标题\n\n```js\nconst x = 1;\n```\n\n段落。\n';
    v.view.dispatch({ selection: { anchor: doc.indexOf('段落') + 1 } });
    fireContext(v as never);
    actionOf(items(), '复制')!();
    await new Promise(r => setTimeout(r, 20));
    expect(clip.writes).toEqual([]);
  });

  it('剪贴板写入失败有可见反馈（FR-004）', async () => {
    clip.fail = true;
    clip.writes.length = 0;
    try {
      const { v, items, flashes } = await mount();
      const doc = '# 标题\n\n```js\nconst x = 1;\n```\n\n段落。\n';
      v.view.dispatch({ selection: { anchor: doc.indexOf('const') + 1 } });
      fireContext(v as never);
      actionOf(items(), '复制代码块')!();
      await new Promise(r => setTimeout(r, 20));
      expect(flashes().length).toBe(1);
      expect(String(flashes()[0])).toContain('复制失败');
    } finally {
      clip.fail = false;
    }
  });

  it('视图销毁后复制动作不再写剪贴板/不再闪示', async () => {
    clip.writes.length = 0;
    const { v, items, flashes } = await mount();
    const doc = '# 标题\n\n```js\nconst x = 1;\n```\n\n段落。\n';
    v.view.dispatch({ selection: { anchor: doc.indexOf('const') + 1 } });
    fireContext(v as never);
    (v as unknown as { destroy: () => void }).destroy();
    actionOf(items(), '复制代码块')!();
    await new Promise(r => setTimeout(r, 20));
    expect(clip.writes).toEqual([]);
    expect(flashes()).toEqual([]);
  });

  it('只读视图仍可复制代码块（复制不是编辑）', async () => {
    clip.writes.length = 0;
    const { LivePreviewView } = await import('./livepreview');
    const host = document.createElement('div');
    let ready = false;
    let captured: MenuItems = [];
    const v = new LivePreviewView(host, {
      path: 'E:\\mock\\doc\\ro.md',
      encoding: 'UTF-8',
      initialDoc: '```js\nro();\n```\n',
      readOnly: true,
      onStatus: () => {},
      onSaved: () => {},
      onReady: () => (ready = true),
      showMenu: items => (captured = items as MenuItems),
    }) as never;
    for (let i = 0; i < 100 && !ready; i++) await new Promise(r => setTimeout(r, 10));
    const doc = '```js\nro();\n```\n';
    vi.spyOn((v as unknown as { view: { posAtCoords: (p: { x: number; y: number }) => number | null } }).view, 'posAtCoords').mockReturnValue(null);
    (v as unknown as { view: { dispatch: (s: unknown) => void } }).view.dispatch({ selection: { anchor: doc.indexOf('ro') + 1 } });
    (v as unknown as { view: { contentDOM: HTMLElement } }).view.contentDOM.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }));
    const act = actionOf(captured, '复制代码块');
    expect(act).not.toBeNull();
    act!();
    await new Promise(r => setTimeout(r, 20));
    expect(clip.writes).toEqual(['ro();\n']);
  });
});
