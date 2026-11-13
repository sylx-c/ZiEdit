// @vitest-environment jsdom
// 007 v0.16 规则 24 / AC-28 验收锁（UX-C2：分屏右栏块级渲染缓存）：
//   顶层块切分（Lezer 顶层节点 + 连续列表归并）、引用式定义行集合收集（围栏内不算）；
//   单字符编辑仅变化块重渲染（未变块 DOM 节点同一性保持、data-block-hash 不变）；
//   改引用定义只更新相关块；主题切换清空；离场 LRU 不影响活动正文；
//   引用定义前置注入每块渲染上下文（跨块引用解析 seam）；观感不变量（文档序拼接）；
//   主路径异常回退 markdown-it 整篇；app.ts 分屏挂渲染器（不再整篇 innerHTML 重建）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderStaticHtml, staticMarkdownParser } from '../src/markdown-view/static-html';
import { extractMarkdownMetadata } from '../src/markdown-view/headings';
import { applyDocumentMetadata } from '../src/markdown-view/preview';
import {
  splitTopBlocks,
  refDefLines,
  createBlockRenderer,
  BLOCK_CACHE_CAP,
  createBlockParser,
  type BlockHtmlRenderer,
} from '../src/markdown-view/blockcache';

/** 可注入的假块渲染器：记录每次渲染上下文，标题源出真 h 标签（data-line 后处理可验） */
function fakeRenderer(): { render: BlockHtmlRenderer; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    render: async ctx => {
      calls.push(ctx);
      const m = ctx.match(/^(#{1,6}) (.+)$/m);
      if (m) return `<h${m[1]!.length}>${m[2]}</h${m[1]!.length}>`;
      return `<p>${ctx.trim().slice(0, 60)}</p>`;
    },
  };
}

async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
}

describe('规则 24 顶层块切分', () => {
  it('增量树在围栏、列表、引用、定义与随机连续编辑后等同整篇解析', () => {
    const parser = createBlockParser();
    let doc = '# 题\n\n' + '重复段落\n\n'.repeat(80) + '````md\n```\n[x]: /fake\n````\n\n- a\n  - b\n\n[x]: /real\n\n[x]\n';
    let seed = 17;
    const insertions = ['\n', '`', '~', '[x]: /new\n', '> ', '- [ ] ', '文字', '|x|y|\n|---|---|\n'];
    for (let i = 0; i < 100; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const pos = seed % (doc.length + 1);
      const end = Math.min(doc.length, pos + (seed % 5));
      doc = doc.slice(0, pos) + insertions[i % insertions.length] + doc.slice(end);
      expect(splitTopBlocks(doc, parser.parse(doc))).toEqual(splitTopBlocks(doc));
    }
    parser.reset();
    expect(splitTopBlocks('', parser.parse(''))).toEqual([]);
  });
  it('标题/段落/列表/表格各成块，startLine 为文档行号', () => {
    const doc = '# A\n\npara1\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n尾\n';
    const blocks = splitTopBlocks(doc);
    expect(blocks.map(b => b.src.trim().split('\n')[0])).toEqual(['# A', 'para1', '- a', '| x | y |', '尾']);
    expect(blocks.map(b => b.startLine)).toEqual([0, 2, 4, 7, 11]);
    expect(blocks.every(b => doc.slice(b.from, b.to) === b.src)).toBe(true);
  });

  it('连续列表（异种标记相邻）归并为一个列表块；空文档无块', () => {
    expect(splitTopBlocks('')).toEqual([]);
    const blocks = splitTopBlocks('- a\n1. b\n\n尾\n');
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.src).toContain('- a');
    expect(blocks[0]!.src).toContain('1. b'); // 相邻列表节点归并
  });
});

describe('规则 24 引用式定义集合', () => {
  it('长围栏、不同围栏与内嵌短围栏不会把代码内伪定义当上下文', () => {
    expect(refDefLines('````md\n```\n[fake]: /bad\n~~~\n[also]: /bad\n````\n[real]: /good')).toEqual(['[real]: /good']);
  });
  it('[id]: url 与 [^fn]: 行收集，围栏内伪定义不算', () => {
    const doc = '[id]: http://x\n[^fn]: 注\n\n正文\n\n```\n[fake]: http://y\n```\n';
    expect(refDefLines(doc)).toEqual(['[id]: http://x', '[^fn]: 注']);
  });
});

describe('AC-28 块级缓存渲染（注入假渲染器）', () => {
  it('Lezer 静态序列化中分隔线保持hr，代码正文不受影响', async () => {
    const renderer = createBlockRenderer();
    const host = document.createElement('div');
    await renderer.render(host, '前文\n\n---\n\n```text\n---\n```\n\n后文', { dark: false });
    expect(host.querySelectorAll('hr')).toHaveLength(1);
    expect(host.querySelectorAll('pre')).toHaveLength(1);
    expect(host.querySelector('pre')?.textContent?.trim()).toBe('---');
    expect(host.querySelector('.md-legacy-front-matter')).toBeNull();
  });
  it('固定 CommonMark/GFM 语料的分块与整篇语义保持一致', async () => {
    const corpus = [
      '# 一\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六\n\nSetext\n===',
      '**粗** *斜* ~~删~~ `码` \\*字面\\*\n\n---\n\n> 引用\n>\n> - 嵌套\n>   - 子项',
      '- [ ] 任务\n- [x] 完成\n\n1. 有序\n2. 第二项\n\n| A | B |\n|:---|---:|\n| a\\|b | **粗** |',
      '````md\n```\n[x]: /fake.md\n````\n\n    缩进代码\n\n[x]: /real.md\n\n[链接][x]\n\n![图](<子 目录/a.png>)',
      '<script>window.bad=1</script>\n\n[恶意](javascript:alert(1))\n\n尾',
    ];
    const canonical = (root: HTMLElement): string => [...root.children].map(el => {
      const clone = el.cloneNode(true) as HTMLElement;
      for (const n of [clone, ...clone.querySelectorAll('[data-line]')]) n.removeAttribute('data-line');
      // R1（2026-11-13）：加载期图片可能带 ReadingSurface 冻结高度的瞬态内联样式（flat 侧独有，
      // 整篇侧无 surface）。语义比对与该瞬态无关，两侧对称剥离，与 data-line 剥离同构。
      for (const img of clone.querySelectorAll('img')) img.removeAttribute('style');
      return clone.outerHTML;
    }).join('');
    for (const doc of corpus) {
      const r = createBlockRenderer();
      const host = document.createElement('div');
      const { col } = await r.render(host, doc, { dark: false });
      const flat = document.createElement('div');
      for (const block of col.children) for (const child of [...block.children]) flat.appendChild(child.cloneNode(true));
      const full = document.createElement('div');
      const tree = staticMarkdownParser.parse(doc);
      full.innerHTML = renderStaticHtml(doc, tree, extractMarkdownMetadata(doc, tree));
      applyDocumentMetadata(full, doc, extractMarkdownMetadata(doc, tree));
      expect(canonical(flat)).toBe(canonical(full));
      expect(flat.querySelector('script,a[href^="javascript:"]')).toBeNull();
    }
  });
  it('乱序完成仅最新版本提交，旧失败也不能回退覆盖', async () => {
    let release!: (value: string) => void;
    let fail!: (err: Error) => void;
    const r = createBlockRenderer(s => s === 'old' ? new Promise(resolve => { release = resolve; })
      : s === 'bad' ? new Promise((_resolve, reject) => { fail = reject; }) : Promise.resolve(`<p>${s}</p>`));
    const host = document.createElement('div');
    const old = r.render(host, 'old', { dark: false });
    await r.render(host, 'new', { dark: false });
    release('<p>old</p>');
    expect((await old).committed).toBe(false);
    expect(host.textContent).toBe('new');
    const bad = r.render(host, 'bad', { dark: false });
    await r.render(host, 'latest', { dark: false });
    fail(new Error('late failure'));
    expect((await bad).committed).toBe(false);
    expect(host.textContent).toBe('latest');
  });

  it.each(['invalidate', 'reset', 'destroy'] as const)('%s 作废挂起任务且不污染后续缓存', async action => {
    let release!: (value: string) => void;
    const r = createBlockRenderer(() => new Promise(resolve => { release = resolve; }));
    const host = document.createElement('div');
    host.textContent = 'stable';
    const pending = r.render(host, 'pending', { dark: false });
    r[action]();
    release('<p>late</p>');
    expect((await pending).committed).toBe(false);
    expect(host.textContent).toBe('stable');
  });

  it('目录变化使本地资源缓存失效；复用块也调用图片重试钩子', async () => {
    const f = fakeRenderer();
    const r = createBlockRenderer(f.render);
    const host = document.createElement('div');
    let dir = 'E:/one';
    let images = 0;
    const opts = { dark: false, route: {
      baseDir: () => dir, openMarkdown: () => {}, openExternal: () => {}, hint: () => {}, interactive: false,
    }, remoteImages: () => { images++; } };
    await r.render(host, 'same', opts);
    await r.render(host, 'same', opts);
    expect(f.calls).toHaveLength(1);
    expect(images).toBe(2);
    dir = 'E:/two';
    await r.render(host, 'same', opts);
    expect(f.calls).toHaveLength(2);
  });
  it('重复段落保留独立 DOM，复用标题随前插行更新定位', async () => {
    const r = createBlockRenderer(async s => s.startsWith('#') ? '<h1>A</h1>' : `<p>${s}</p>`);
    const host = document.createElement('div');
    const first = await r.render(host, '# A\n\nrepeat\n\nrepeat', { dark: false });
    const heading = first.col.querySelector('h1');
    expect(first.col.querySelectorAll('p')).toHaveLength(2);
    const second = await r.render(host, 'prefix\n\n# A\n\nrepeat\n\nrepeat', { dark: false });
    expect(second.col.querySelector('h1')).toBe(heading);
    expect(heading?.dataset.line).toBe('2');
    expect([...second.col.querySelectorAll('p')].map(p => p.textContent)).toEqual(['prefix', 'repeat', 'repeat']);
  });

  it('脚注与多行定义保持块级上下文，普通正文不退化为整篇单块', async () => {
    for (const doc of ['one[^x]\n\ntwo\n\n[^x]: note', '[label with space]:\n  /test.md\n\n[text][label with space]']) {
      const r = createBlockRenderer();
      const host = document.createElement('div');
      await r.render(host, doc, { dark: false });
      expect(host.querySelectorAll('.md-block').length).toBeGreaterThan(1);
      if (doc.includes('one[^x]')) {
        expect(host.querySelector('.footnotes-ref a')?.textContent).toBe('1');
        expect(host.querySelector('.footnotes-defs-ol')?.textContent).toContain('note');
        const paragraph = [...host.querySelectorAll('p')].find(p => p.textContent === 'two');
        await r.render(host, doc + '\n\nnew', { dark: false });
        expect([...host.querySelectorAll('p')].find(p => p.textContent === 'two')).toBe(paragraph);
      } else expect(host.querySelector('a')?.getAttribute('href')).toBe('/test.md');
      r.destroy();
    }
    expect(refDefLines('[label with space]: /a.md')).toEqual(['[label with space]: /a.md']);
  });
  const DOC = '[id]: http://x\n\n# 题\n\n段甲\n\n- a\n- b\n\n段乙\n';
  // 块序：defs 段落 / 标题 / 段甲 / 列表 / 段乙 —— 5 块

  it('初渲染逐块调用、定义前置注入每块上下文、块件带 data-block-hash', async () => {
    const f = fakeRenderer();
    const r = createBlockRenderer(f.render);
    const host = document.createElement('div');
    const res = await r.render(host, DOC, { dark: false });
    await flush();
    expect(res.engine).toBe('lezer');
    expect(f.calls.length).toBe(5);
    for (const c of f.calls) expect(c.startsWith('[id]: http://x\n\n')).toBe(true); // 前置注入 seam
    const kids = [...res.col.children] as HTMLElement[];
    expect(kids.length).toBe(5);
    expect(kids.every(k => k.dataset.blockHash)).toBe(true);
    expect(host.firstElementChild).toBe(res.col); // 列交接：host 内只有新 col
  });

  it('单字符编辑：仅变化块重渲染，未变块 DOM 节点同一性保持且 hash 不变', async () => {
    const f = fakeRenderer();
    const r = createBlockRenderer(f.render);
    const host = document.createElement('div');
    const first = await r.render(host, DOC, { dark: false });
    const mark = {};
    (first.col.children[1] as HTMLElement)._identity = mark; // 标题块打标记（对象同一性）
    // hash 在第二次渲染前取（复用块会被搬入新 col，旧 col.children 不再是原集合）
    const hash0Before = (first.col.children[0] as HTMLElement).dataset.blockHash;
    const hashBefore = (first.col.children[2] as HTMLElement).dataset.blockHash; // 段甲
    f.calls.length = 0;
    const second = await r.render(host, DOC.replace('段甲', '段甲2'), { dark: false });
    await flush();
    expect(f.calls.length).toBe(1); // 只有段甲块重渲
    expect(f.calls[0]).toContain('段甲2');
    const kids = [...second.col.children] as HTMLElement[];
    expect(kids.length).toBe(5);
    expect((kids[1] as HTMLElement)._identity).toBe(mark); // 未变块 = 同一 DOM 节点
    expect(kids[2]!.dataset.blockHash).not.toBe(hashBefore); // 变化块换新键
    expect(kids[0]!.dataset.blockHash).toBe(hash0Before); // 未变块 hash 原样
    expect(host.firstElementChild).toBe(second.col); // 旧 col 已撤
  });

  it('改未被正文引用的定义行时，仅定义块变化', async () => {
    const f = fakeRenderer();
    const r = createBlockRenderer(f.render);
    const host = document.createElement('div');
    await r.render(host, DOC, { dark: false });
    f.calls.length = 0;
    await r.render(host, DOC.replace('http://x', 'http://z'), { dark: false });
    await flush();
    expect(f.calls.length).toBe(1);
    expect(f.calls.every(c => c.includes('http://z'))).toBe(true);
  });

  it('主题切换（dark 翻转）清空缓存：同文档全量重渲', async () => {
    const f = fakeRenderer();
    const r = createBlockRenderer(f.render);
    const host = document.createElement('div');
    await r.render(host, DOC, { dark: false });
    f.calls.length = 0;
    await r.render(host, DOC, { dark: true });
    await flush();
    expect(f.calls.length).toBe(5);
  });

  it('活动正文不受离场缓存容量限制，超过容量后单字符编辑仍保留所有未变节点', async () => {
    const f = fakeRenderer();
    const r = createBlockRenderer(f.render, 3);
    const host = document.createElement('div');
    const doc = Array.from({ length: 8 }, (_, i) => `paragraph ${i}`).join('\n\n');
    await r.render(host, doc, { dark: false });
    const before = [...host.firstElementChild!.children];
    f.calls.length = 0;
    await r.render(host, doc + '!', { dark: false });
    expect(f.calls).toHaveLength(1);
    expect([...host.firstElementChild!.children].slice(0, 7)).toEqual(before.slice(0, 7));
    expect(BLOCK_CACHE_CAP).toBe(4096);
    r.destroy();
  });

  it('观感不变量：块件按文档序拼接（每块含自身特征文本且顺序不乱）', async () => {
    const f = fakeRenderer();
    const r = createBlockRenderer(f.render);
    const host = document.createElement('div');
    const res = await r.render(host, DOC, { dark: false });
    const texts = [...res.col.children].map(k => (k as HTMLElement).textContent ?? '');
    expect(texts.findIndex(t => t.includes('题'))).toBeLessThan(texts.findIndex(t => t.includes('段甲')));
    expect(texts.findIndex(t => t.includes('段甲'))).toBeLessThan(texts.findIndex(t => t.includes('段乙')));
    // 标题块 data-line 按块起始行偏移（defs 段落行 0 + 空行 → 标题起始行 2）
    const h = res.col.querySelector<HTMLElement>('h1');
    expect(h?.getAttribute('data-line')).toBe('2');
  });

  it('主路径异常（注入渲染器抛错）→ 回退 markdown-it 整篇渲染', async () => {
    const r = createBlockRenderer(async () => {
      throw new Error('boom');
    });
    const host = document.createElement('div');
    await r.render(host, DOC, { dark: false }); // 首渲失败 → fallback
    await r.render(host, DOC, { dark: false }); // 仍 fallback（口径同 renderPreviewInto）
    const col = host.firstElementChild as HTMLElement;
    expect(col.className).toContain('md-fallback');
    expect(col.querySelector('h1')?.textContent).toBe('题'); // markdown-it 输出
    expect(host.children.length).toBe(1); // 每轮旧 col 撤净
  });

  it('普通段落提供行锚，复用块在前文插行后更新源行', async () => {
    const renderer = createBlockRenderer(async text => `<p>${text}</p>`);
    const host = document.createElement('div');
    await renderer.render(host, 'first\n\nsecond', { dark: false });
    const second = host.querySelectorAll('p')[1]!;
    expect(second.dataset.line).toBe('2');
    await renderer.render(host, 'new\n\nfirst\n\nsecond', { dark: false });
    expect(host.querySelectorAll('p')[2]).toBe(second);
    expect(second.dataset.line).toBe('4');
  });

  it('异步渲染结束后、搬动旧DOM之前读取最新阅读位置', async () => {
    let resolve!: (html: string) => void;
    const renderer = createBlockRenderer(() => new Promise<string>(r => { resolve = r; }));
    const host = document.createElement('div'); host.innerHTML = '<div><p>old</p></div>';
    const positions: number[] = [];
    const pending = renderer.render(host, 'new', { dark: false, beforeCommit: () => {
      expect(host.textContent).toBe('old'); positions.push(host.scrollTop);
    } });
    host.scrollTop = 140; expect(positions).toEqual([]);
    resolve('<p>new</p>'); await pending;
    expect(positions).toEqual([140]); expect(host.textContent).toBe('new');
  });
});

describe('AC-28 app 接线（源契约）', () => {
  it('独立预览与分屏共用块级阅读组件和同一文档会话', () => {
    const app = readFileSync(join(process.cwd(), 'src', 'shell', 'app.ts'), 'utf8');
    expect(app.includes('createBlockRenderer(undefined, undefined, markdownDocumentFor(tab.path))')).toBe(true);
    expect(app).toContain('blockRenderer.render(prevHost');
    expect(app).not.toMatch(/prevHost\.innerHTML = ''/);
    expect(app.includes('reading.render(preview,')).toBe(true);
  });
});
