// @vitest-environment jsdom
// 007 v0.16 规则 2/23 M1 验收锁（UX-C3：即时渲染引擎换自研 CM6 live preview）：
// 缓冲即文档模型（getMarkdown = doc 原样，无序列化，AC-3 往返由构造保证）；
// 非活动块装饰渲染（标记隐藏/块级件），活动块显源码（AC-1a）；
// 围栏代码围栏隐藏 + 语言标签件；任务列表勾选只读件（M1 口径）；
// GFM 表格非活动块网格渲染（表头对齐正确、点击进块转源码）；
// 图片 asset 解析 + 失败静默占位（规则 21）；分隔线件；
// Ctrl+F 就地查找（规则 20：不再切源码承载，AC-23）+ seed 回填；
// 脏标/状态上报（规则 19）、标题树上报（规则 3）、体量 O(1) 估计；
// 格式命令三上下文同一 runMdFormat 且单步撤销（规则 17 / AC-17）；
// 引擎自研契约（仅依赖自研与通用解析基建、wysiwyg.ts 已删、app 挂 LivePreviewView）。
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let fileText = '';

vi.mock('../src/common/ipc', () => ({
  textOpen: async () => ({ content: '', encoding: 'UTF-8', newline: 'lf', mixed: false }),
  textReadAll: async () => fileText,
  textSave: async () => ({ len: 0, modifiedMs: 0 }),
}));

// jsdom 无布局：Range.getClientRects 缺失会让 scrollIntoView 触发的 rAF 测量抛未捕获异常
if (!(Range.prototype as { getClientRects?: unknown }).getClientRects) {
  (Range.prototype as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
}

const { LivePreviewView } = await import('../src/markdown-view/livepreview');
type LiveView = InstanceType<typeof LivePreviewView>;

interface Mount { v: LiveView; host: HTMLElement }

/** 挂载并等待 onReady（装饰经 Lezer 异步解析后落 DOM，断言一律用 until 轮询等稳） */
async function mount(openExternal?: (href: string) => void): Promise<Mount> {
  const host = document.createElement('div');
  let done = false;
  const v = new LivePreviewView(host, {
    path: 'E:\\mock\\doc\\n.md',
    encoding: 'UTF-8',
    onStatus: () => {},
    onSaved: () => {},
    onReady: () => (done = true),
    openExternal,
  });
  for (let i = 0; i < 100 && !done; i++) await new Promise(r => setTimeout(r, 10));
  if (!done) throw new Error('onReady 未交付');
  return { v, host };
}

/** 轮询等待条件成立（Lezer 解析 → 装饰重建为异步链，固定 sleep 会闪断） */
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

describe('M1 引擎自研契约（规则 2 v0.16；wysiwyg.ts 删除）', () => {
  it('livepreview 仅依赖自研与通用解析基建、以 lang-markdown 为解析器；app 挂 LivePreviewView 无 WysiwygView 残留', () => {
    const lp = readFileSync(resolve(__dirname, '../src/markdown-view/livepreview.ts'), 'utf8');
    const app = readFileSync(resolve(__dirname, '../src/shell/app.ts'), 'utf8');
    expect(existsSync(resolve(__dirname, '../src/markdown-view/wysiwyg.ts'))).toBe(false);
    expect(lp).not.toMatch(/(?:from\s*|import\s*\(\s*)['"](?!\.|@codemirror\/|@lezer\/)[^'"]+['"]/);
    expect(lp).toMatch(/from '@codemirror\/lang-markdown'/);
    expect(app).toContain("import { LivePreviewView } from '../markdown-view/livepreview'");
    expect(app).not.toMatch(/\bWysiwygView\b/);
  });

  it('保存与查找键位挂引擎内（Mod-s 收口 save / Mod-f·Mod-h 就地查找，AC-23）', () => {
    const lp = readFileSync(resolve(__dirname, '../src/markdown-view/livepreview.ts'), 'utf8');
    expect(lp).toContain("key: 'Mod-s'");
    expect(lp).toContain("key: 'Mod-f'");
    expect(lp).toContain("key: 'Mod-h'");
  });
});

describe('AC-1a 活动块显源码 / 非活动块装饰（规则 2 v0.16）', () => {
  it('已闭合元素之后继续同段输入保持渲染；移入只展开当前元素', async () => {
    fileText = '# 标题\n\n**粗**甲段\n\n**粗**乙段\n';
    const { v, host } = await mount();
    const at = fileText.indexOf('乙段');
    v.view.dispatch({ selection: { anchor: at } });
    await until(() => host.querySelectorAll('.mdir-strong').length === 2);
    expect(text(host)).not.toContain('**');
    v.view.dispatch({ selection: { anchor: fileText.lastIndexOf('**粗**') + 2 } });
    await until(() => text(host).includes('**粗**乙段'));
    expect(text(host)).not.toContain('**粗**甲段');
    expect(host.querySelector('.cm-line.mdir-h1')).not.toBeNull();
    v.destroy();
  });

  it('围栏代码块：围栏隐藏、语言标签件、行级 mdir-code 观感类', async () => {
    fileText = '# 题\n\n```ts\nlet x = 1\n```\n\n尾段\n';
    const { v, host } = await mount();
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length } });
    await until(() => !text(host).includes('```') && !!host.querySelector('.mdir-codelabel'));
    expect(text(host)).toContain('let x = 1'); // 代码体保留
    const label = host.querySelector('.mdir-codelabel');
    expect(label?.textContent).toBe('ts');
    expect(host.querySelector('.cm-line.mdir-code')).not.toBeNull();
    v.destroy();
  });

  it('编辑任务正文时所有任务框继续显示', async () => {
    fileText = '- [ ] 甲\n- [x] 乙\n';
    const { v, host } = await mount();
    v.view.dispatch({ selection: { anchor: fileText.indexOf('甲') } });
    await until(() => host.querySelectorAll('input.mdir-task').length === 2);
    expect(text(host)).not.toContain('[ ]');
    expect((host.querySelectorAll('input.mdir-task')[1] as HTMLInputElement).checked).toBe(true);
    v.destroy();
  });

  it('GFM 表格点击后保留网格并打开目标单元格编辑器', async () => {
    fileText = '| 甲 | 乙 |\n|:--:|--:|\n| 1 | 2 |\n\n尾段\n';
    const { v, host } = await mount();
    await until(() => !!host.querySelector('table.mdir-table'));
    const table = host.querySelector('table.mdir-table');
    const ths = host.querySelectorAll('.mdir-table th');
    expect([...ths].map(e => e.textContent)).toEqual(['甲', '乙']);
    expect((ths[0] as HTMLElement).style.textAlign).toBe('center');
    expect((ths[1] as HTMLElement).style.textAlign).toBe('right');
    host.querySelector('td')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await until(() => !!host.querySelector('td .cm-editor'));
    expect(host.querySelector('table.mdir-table')).toBe(table);
    expect(v.getMarkdown()).toBe(fileText);
    v.destroy();
  });

  it('分割线件 + 图片件：--- 成横线件；相对路径图片渲染 img；加载失败静默占位（规则 21）', async () => {
    fileText = '---\n\n![替代文本](./no.png)\n\n尾段\n';
    const { v, host } = await mount();
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length } });
    await until(() => host.querySelector('.mdir-hr') !== null && host.querySelector('img.mdir-img') !== null);
    expect(text(host)).not.toContain('---');
    const img = host.querySelector('img.mdir-img') as HTMLImageElement;
    expect(img.alt).toBe('替代文本');
    const box = host.querySelector('.mdir-imgbox') as HTMLElement;
    img.dispatchEvent(new Event('error')); // 失败：静默占位，不抛错不空白
    expect(box.classList.contains('is-broken')).toBe(true);
    const ph = box.querySelector('.mdir-img-broken');
    expect(ph?.textContent).toBe('替代文本');
    v.destroy();
  });
});

describe('AC-1a 转义、实体与硬换行', () => {
  it('非活动正文投影字面值；代码与未知实体保留原文，解码不生成HTML', async () => {
    fileText = '转义：\\*星号\\*、\\&amp;、\\q。\n\n实体：&copy; &#169; &#x1F600; &lt;img src=x&gt; &unknown;。\n\n硬换行\\\n下一行。\n\n`\\*code\\* &amp;`\n\n```text\n\\*code\\* &amp;\n```\n\n末段';
    const { v, host } = await mount();
    v.view.dispatch({ selection: { anchor: v.view.state.doc.length } });
    await until(() => text(host).includes('实体：© © 😀 <img src=x> &unknown;。'));
    const lines = [...host.querySelectorAll('.cm-line')].map(line => line.textContent);
    expect(lines).toContain('转义：*星号*、&amp;、\\q。');
    expect(lines).toContain('硬换行');
    expect(lines).toContain('下一行。');
    expect(text(host)).toContain('\\*code\\* &amp;');
    expect(host.querySelector('.mdir-em')).toBeNull();
    expect(host.querySelector('img:not(.cm-widgetBuffer)')).toBeNull();
    expect(v.getMarkdown()).toBe(fileText);
    v.destroy();
  });

  it('移入和跨元素选取时恢复目标源码，移出后投影恢复且文档不变', async () => {
    fileText = '转义\\*和实体&amp;。\n\n末段';
    const { v, host } = await mount();
    v.view.dispatch({ selection: { anchor: fileText.length } });
    await until(() => text(host).includes('转义*和实体&。'));
    v.view.dispatch({ selection: { anchor: fileText.indexOf('\\*') + 1 } });
    await until(() => text(host).includes('转义\\*和实体&。'));
    v.view.dispatch({ selection: { anchor: fileText.indexOf('&amp;') + 2 } });
    await until(() => text(host).includes('转义*和实体&amp;。'));
    v.view.dispatch({ selection: { anchor: 0, head: fileText.indexOf('。') + 1 } });
    await until(() => text(host).includes('转义\\*和实体&amp;。'));
    v.view.dispatch({ selection: { anchor: fileText.length } });
    await until(() => text(host).includes('转义*和实体&。'));
    expect(v.getMarkdown()).toBe(fileText);
    v.destroy();
  });
});

describe('AC-1a 自动链接', () => {
  it('保留裸网址、尖括号网址和邮箱；普通链接只呈现标签', async () => {
    fileText = '<https://example.test/a?x=1&y=2>、https://example.test/b、<writer@example.test>、www.example.test、[标签](https://example.test/hidden)。\n\n末段';
    const { v, host } = await mount();
    v.view.dispatch({ selection: { anchor: fileText.length } });
    await until(() => text(host).includes('https://example.test/a?x=1&y=2'));
    expect(text(host)).toContain('https://example.test/b');
    expect(text(host)).toContain('writer@example.test');
    expect(text(host)).toContain('www.example.test');
    expect(text(host)).toContain('标签');
    expect(text(host)).not.toContain('hidden');
    expect(text(host)).not.toContain('<https:');
    expect(v.getMarkdown()).toBe(fileText);
    v.view.dispatch({ selection: { anchor: 2 } });
    await until(() => text(host).includes('<https://example.test/a?x=1&y=2>'));
    v.destroy();
  });

  it('Ctrl/Command+点击裸网址与邮箱路由到明确目标，普通点击不出站', async () => {
    fileText = '<https://example.test/a?x=1&amp;y=2>\n\nhttps://example.test/b\n\n<writer@example.test>\n\nwww.example.test\n\n<mailto:writer@example.test>\n\n[邮件](mailto:writer@example.test)\n\n末段';
    const opened: string[] = [];
    const { v, host } = await mount(href => opened.push(href));
    v.view.dispatch({ selection: { anchor: fileText.length } });
    await until(() => host.querySelectorAll('.mdir-link').length === 6);
    host.querySelector('.mdir-link')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(opened).toEqual([]);
    v.view.dispatch({ selection: { anchor: fileText.length } });
    await until(() => !text(host).includes('<https:'));
    for (const link of host.querySelectorAll('.mdir-link')) link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(opened).toEqual(['https://example.test/a?x=1&amp;y=2', 'https://example.test/b', 'mailto:writer@example.test',
      'http://www.example.test', 'mailto:writer@example.test', 'mailto:writer@example.test']);
    expect(v.getMarkdown()).toBe(fileText);
    v.destroy();
  });
});

describe('AC-23 就地查找（规则 20 v0.16：不切源码承载）', () => {
  it('openFindBar(seed) 栏在宿主内弹出并回填选词；findStep 步进选中命中', async () => {
    fileText = '第一行乙\n\n第二行\n\n第三行乙\n';
    const { v, host } = await mount();
    v.openFindBar('乙');
    const bar = host.querySelector('.tv-bar') as HTMLElement | null;
    expect(bar).not.toBeNull();
    const input = host.querySelector('.tv-bar .tv-bar-input') as HTMLInputElement;
    expect(input.value).toBe('乙');
    v.findStep(1); // go(1) → fbRun 全文扫描 → 选中首个命中
    await until(() => {
      const s = v.view.state.selection.main;
      return s.to > s.from && v.view.state.sliceDoc(s.from, s.to) === '乙';
    });
    v.destroy();
  });

  it('替换入口（withReplace=true）展开替换行', async () => {
    fileText = '正文内容\n';
    const { v, host } = await mount();
    v.openFindBar(undefined, true);
    expect(host.querySelector('.fb-rep')).not.toBeNull();
    v.destroy();
  });
});

describe('AC-3/规则 19 保存与状态（文档模型即源文本）', () => {
  it('getMarkdown 即 doc 原样；编辑后脏标上报，保存后清脏并回调 onSaved', async () => {
    fileText = '# 开头\n\n正文\n';
    const statuses: Array<{ dirty: boolean }> = [];
    const saved: string[] = [];
    const host = document.createElement('div');
    let done = false;
    const v = new LivePreviewView(host, {
      path: 'E:\\mock\\doc\\n.md',
      encoding: 'UTF-8',
      onStatus: s => statuses.push({ dirty: s.dirty }),
      onSaved: p => saved.push(p),
      onReady: () => (done = true),
    });
    for (let i = 0; i < 100 && !done; i++) await new Promise(r => setTimeout(r, 10));
    expect(v.getMarkdown()).toBe(fileText);
    const n0 = statuses.length;
    v.view.dispatch({ changes: { from: v.view.state.doc.length, insert: '追加' } });
    await until(() => statuses.length > n0 && statuses[statuses.length - 1]!.dirty, 1500); // 200ms 防抖
    await v.save();
    expect(saved).toEqual(['E:\\mock\\doc\\n.md']);
    expect(statuses[statuses.length - 1]!.dirty).toBe(false);
    expect(v.getMarkdown()).toBe('# 开头\n\n正文\n追加'); // 无序列化：改的就是源文本本身
    v.destroy();
  });

  it('contentSizeHint O(1) 估计 = 文档长度（autosave 体量口径）', async () => {
    fileText = 'abcde';
    const { v } = await mount();
    expect(v.contentSizeHint()).toBe(5);
    v.view.dispatch({ changes: { from: 5, insert: 'fg' } });
    expect(v.contentSizeHint()).toBe(7);
    v.destroy();
  });
});

describe('AC-2 大纲联动（规则 3：标题树上报）', () => {
  it('挂载即上报初始标题树；编辑新增标题经 300ms 防抖后上报新树', async () => {
    fileText = '# 一级\n\n正文\n';
    const headsList: Array<Array<{ level: number; text: string }>> = [];
    const host = document.createElement('div');
    let done = false;
    const v = new LivePreviewView(host, {
      path: 'E:\\mock\\doc\\n.md',
      encoding: 'UTF-8',
      onStatus: () => {},
      onSaved: () => {},
      onHeadings: hs => headsList.push(hs.map(h => ({ level: h.level, text: h.text }))),
      onReady: () => (done = true),
    });
    for (let i = 0; i < 100 && !done; i++) await new Promise(r => setTimeout(r, 10));
    expect(headsList[headsList.length - 1]).toEqual([{ level: 1, text: '一级' }]);
    v.view.dispatch({ changes: { from: v.view.state.doc.length, insert: '\n\n### 三级\n' } });
    await until(() => headsList[headsList.length - 1]!.some(h => h.text === '三级'), 1500);
    const last = headsList[headsList.length - 1]!;
    expect(last).toEqual([{ level: 1, text: '一级' }, { level: 3, text: '三级' }]);
    v.destroy();
  });
});

describe('AC-17 格式命令与撤销（规则 17：三上下文同一 runMdFormat）', () => {
  it('runFormat(bold) 包裹选区；cmUndo 单步完整回退、cmRedo 单步复做', async () => {
    fileText = '段落甲乙丙\n';
    const { v } = await mount();
    const i = fileText.indexOf('乙');
    v.view.dispatch({ selection: { anchor: i, head: i + 1 } });
    v.runFormat('bold');
    expect(v.getMarkdown()).toBe('段落甲**乙**丙\n');
    v.cmUndo();
    expect(v.getMarkdown()).toBe('段落甲乙丙\n');
    v.cmRedo();
    expect(v.getMarkdown()).toBe('段落甲**乙**丙\n');
    v.destroy();
  });
});
