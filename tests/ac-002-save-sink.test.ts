// @vitest-environment jsdom
// 002 保存收口验收（H-6c / BUG-V5 根修）：写盘发生在上游视图内部，收口只能挂在各自的 save() 上。
// 修前只有「脏缓冲守卫」一条路补调 shell 的 noteSaved，编辑态 Ctrl+S（CM 键位 Mod-s）与
// IR 的 Ctrl+S（host 键位）两条主路径全漏 → mtime 基线不刷新，2 秒轮询把自己刚写的 mtime
// 当成外部修改（脏则弹「外部修改」，净则白重挂一次并闪「已重新加载」）。
// 本组用例锁死契约：真实写盘成功 → 恰好回调一次 onSaved(路径)；写盘失败 → 一次都不回调。
// v0.16 起 IR 为自研 CM6 live preview（livepreview.ts），jsdom 下真实挂载 CM6（无桩）。
import { describe, expect, it, vi, beforeEach } from 'vitest';

const saveCalls: Array<{ path: string; content: string; encoding: string }> = [];
let saveImpl: () => Promise<void> = async () => {};

vi.mock('../src/common/ipc', () => ({
  textReadAll: async () => '',
  textOpen: async () => ({ content: '', encoding: 'UTF-8', newline: 'lf', mixed: false }),
  textSave: async (path: string, content: string, encoding: string) => {
    saveCalls.push({ path, content, encoding });
    await saveImpl();
  },
}));

// jsdom 无布局：Range.getClientRects 缺失会让 scrollIntoView 触发的 rAF 测量抛未捕获异常
if (!(Range.prototype as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
}

// 动态导入而非顶部静态导入：vi.mock 的工厂会被提升到 import 之前，而工厂要读下面这两个
// 收集变量——静态导入时它们尚未初始化。等变量就位再导入，工厂才拿得到引用。
const { EditView } = await import('../src/text-view/edit');
const { LivePreviewView } = await import('../src/markdown-view/livepreview');

async function makeEdit(onSaved: (p: string) => void): Promise<InstanceType<typeof EditView>> {
  let ready!: () => void;
  const gate = new Promise<void>(r => (ready = r));
  const v = new EditView(document.createElement('div'), {
    path: 'E:\\mock\\a.txt',
    language: null,
    encoding: 'UTF-8',
    initialDoc: 'hello',
    onStatus: () => {},
    onSaveAsNeeded: () => {},
    onAlert: () => {},
    onSaved,
    onReady: ready,
  });
  await gate;
  return v;
}

beforeEach(() => {
  saveCalls.length = 0;
  saveImpl = async () => {};
});

describe('AC-25 编辑缓冲保存收口（EditView.save → onSaved）', () => {
  it('改名与保存共用队列：在途写入先完成，后续保存使用新路径', async () => {
    const v = await makeEdit(() => {});
    let release!: () => void;
    saveImpl = () => new Promise<void>(resolve => { release = resolve; });
    const first = v.save();
    await vi.waitFor(() => expect(saveCalls.length).toBe(1));
    const move = vi.fn(async () => {});
    const renamed = v.relocate('E:\\mock\\renamed.txt', move);
    const next = v.save();
    expect(move).not.toHaveBeenCalled();
    saveImpl = async () => {};
    release(); await first; await renamed; await next;
    expect(saveCalls.map(call => call.path)).toEqual(['E:\\mock\\a.txt', 'E:\\mock\\renamed.txt']);
    v.destroy();
  });
  it('写盘成功回调一次 onSaved，且路径为视图自身路径', async () => {
    const seen: string[] = [];
    const v = await makeEdit(p => seen.push(p));
    await v.save();
    expect(saveCalls.length).toBe(1);
    expect(seen).toEqual(['E:\\mock\\a.txt']);
    v.destroy();
  });

  it('草稿（无路径）走另存为，不触发 onSaved（另存收口在 shell 的 saveTextAs）', async () => {
    const seen: string[] = [];
    let saveAs = 0;
    let ready!: () => void;
    const gate = new Promise<void>(r => (ready = r));
    const v = new EditView(document.createElement('div'), {
      path: null, language: null, encoding: 'UTF-8', initialDoc: 'draft',
      onStatus: () => {}, onSaveAsNeeded: () => { saveAs++; }, onSaved: p => seen.push(p), onReady: ready,
    });
    await gate;
    await v.save();
    expect(saveAs).toBe(1);
    expect(seen).toEqual([]);
    expect(saveCalls.length).toBe(0);
    v.destroy();
  });

  it('写盘失败不回调 onSaved（基线不得被写成"已保存"）', async () => {
    saveImpl = () => Promise.reject(new Error('E1002 磁盘只读'));
    const seen: string[] = [];
    const v = await makeEdit(p => seen.push(p));
    await v.save();
    expect(saveCalls.length).toBe(1);
    expect(seen).toEqual([]);
    v.destroy();
  });
});

describe('AC-25 保存收口不含编码重试路径的重复回调', () => {
  it('UNMAPPABLE 走另存为：仍不回调 onSaved（本次未写回原文件）', async () => {
    saveImpl = () => Promise.reject(new Error('UNMAPPABLE: \u0000 can not be encoded'));
    const seen: string[] = [];
    let saveAs = 0;
    let ready!: () => void;
    const gate = new Promise<void>(r => (ready = r));
    const v = new EditView(document.createElement('div'), {
      path: 'E:\\mock\\gbk.txt', language: null, encoding: 'GBK', initialDoc: 'x',
      onStatus: () => {}, onSaveAsNeeded: () => { saveAs++; }, onSaved: p => seen.push(p),
      onConfirm: () => Promise.resolve(true), onReady: ready,
    });
    await gate;
    await v.save();
    expect(saveAs).toBe(1);
    expect(seen).toEqual([]);
    v.destroy();
  });
});

describe('AC-25 IR 保存收口（LivePreviewView.save → onSaved）', () => {
  it('写盘成功回调一次 onSaved，内容即文档模型原样（007 v0.16：无序列化，AC-3 往返由构造保证）', async () => {
    const seen: string[] = [];
    let ready!: () => void;
    const gate = new Promise<void>(r => (ready = r));
    const v = new LivePreviewView(document.createElement('div'), {
      path: 'E:\\mock\\n.md',
      encoding: 'UTF-8',
      onStatus: () => {},
      onSaved: p => seen.push(p),
      onReady: ready,
    });
    await gate; // 真实挂载 CM6 后（onReady）才进入写盘分支
    v.view.dispatch({ changes: { from: 0, insert: '# 标题\n\n正文' } });
    await v.save();
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0]!.content).toBe('# 标题\n\n正文');
    expect(seen).toEqual(['E:\\mock\\n.md']);
    v.destroy();
  });

  it('未就绪（view 未挂载）直接返回，不回调 onSaved', async () => {
    const seen: string[] = [];
    const v = new LivePreviewView(document.createElement('div'), {
      path: 'E:\\mock\\n.md',
      encoding: 'UTF-8',
      onStatus: () => {},
      onSaved: p => seen.push(p),
    });
    await v.save(); // init 的首个 await（textOpen）尚未解决，view 必然未挂载
    expect(saveCalls.length).toBe(0);
    expect(seen).toEqual([]);
    v.destroy();
  });
});

describe('复审 D01/D02/D34 内容保护', () => {
  for (const kind of ['source', 'ir'] as const) {
    it(`${kind} 写盘期间新输入保持脏，下一次保存串行写入最新内容`, async () => {
      let dirty = false;
      const clean: Array<boolean | undefined> = [];
      let ready!: () => void;
      const mounted = new Promise<void>(r => { ready = r; });
      const host = document.createElement('div');
      const opts = {
        path: 'E:\\mock\\race.md', encoding: 'UTF-8', initialDoc: 'base',
        onStatus: (s: { dirty: boolean }) => { dirty = s.dirty; },
        onSaved: (_p: string, _s: unknown, savedClean?: boolean) => clean.push(savedClean),
        onReady: ready, onSaveAsNeeded: () => {}, language: 'Markdown',
      };
      const v = kind === 'ir' ? new LivePreviewView(host, opts) : new EditView(host, opts);
      await mounted;
      v.view.dispatch({ changes: { from: 4, insert: 'A' } });
      expect(dirty).toBe(true); // 不能等待防抖才通知关闭/切形态守卫。
      let release!: () => void;
      saveImpl = () => new Promise<void>(r => { release = r; });
      const first = v.save();
      await vi.waitFor(() => expect(saveCalls.length).toBe(1));
      v.view.dispatch({ changes: { from: 5, insert: 'B' } });
      const second = v.save();
      expect(saveCalls.length).toBe(1);
      saveImpl = async () => {};
      release();
      await first;
      expect(clean[0]).toBe(false);
      await second;
      expect(saveCalls.map(x => x.content)).toEqual(['baseA', 'baseAB']);
      expect(clean).toEqual([false, true]);
      expect(dirty).toBe(false);
      v.destroy();
    });

    it(`${kind} 恢复空文档不会重新读入磁盘旧内容`, async () => {
      let ready!: () => void;
      const mounted = new Promise<void>(r => { ready = r; });
      let dirty = false;
      const opts = {
        path: 'E:\\mock\\empty.md', encoding: 'UTF-8', initialDoc: '', startDirty: true,
        onStatus: (s: { dirty: boolean }) => { dirty = s.dirty; }, onSaved: () => {},
        onReady: ready, onSaveAsNeeded: () => {}, language: 'Markdown',
      };
      const host = document.createElement('div');
      const v = kind === 'ir' ? new LivePreviewView(host, opts) : new EditView(host, opts);
      await mounted;
      expect(v.view.state.doc.toString()).toBe('');
      expect(dirty).toBe(true);
      v.destroy();
    });
  }
});
