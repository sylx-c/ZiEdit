// @vitest-environment jsdom
// 007-AC Markdown 深治回归锁（P2，规则 1/2/6/16/20 v2.0 + 001 规则 28 v2.1）：
// 形态正名（源码视图/分屏预览/即时渲染；v0.15 起三形态——渲染预览已删；修前 split 三种叫法）；
// 解析选项单一来源（IR 与静态预览同引，出厂全开——修「即时渲染和渲染预览效果不一样」）；
// 代码块语言补全表（hljs.langs 显式给表——修「``` 后无法选择语言」）；
// 弹层定位单一实现（顶部锚点向下弹——修「标题 ▾ 只显示 H3/H4」）；
// 分屏防跳顶（块级锚点捕获/恢复，不依赖标题——修「一编辑右侧滚回最上面」）；
// 新建文件格式下拉（dlgPromptWithFormat 返回 {name, format}——修「选 markdown 不进 markdown」）。
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CODE_HINT_LANGS, captureTopBlock, restoreTopBlock } from '../src/markdown-view/preview';
import { placePopup, placeSubmenu } from '../src/common/popup';
import { dlgPromptWithFormat } from '../src/shell/chrome';
import { dict } from '../src/common/i18n';

function mockOffset(el: HTMLElement, top: number, height: number): void {
  Object.defineProperty(el, 'offsetTop', { get: () => top, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { get: () => height, configurable: true });
  Object.defineProperty(el, 'offsetWidth', { get: () => 180, configurable: true });
}

describe('007 AC：形态正名（规则 1 v2.0；v0.15 三形态）', () => {
  it('H5/H6 三面字号递减，保留明确字重和 H6 弱化色', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
    for (const [level, ratio] of [[5, 0.875], [6, 0.85]]) {
      expect(css).toContain(`.md-preview .md-col h${level}{font-size:calc(var(--md-fs-base) * ${ratio})`);
      expect(css).toContain(`.md-ir .cm-line.mdir-h${level}{font-size:calc(var(--md-fs-base) * ${ratio})`);
    }
    expect(css).toContain('.md-ir .cm-line.mdir-h6{color:var(--muted)}');
  });
  it('格式钮按 Markdown/只读状态判决，不依赖异步挂载视图实例', () => {
    const app = readFileSync(resolve(__dirname, '../src/shell/app.ts'), 'utf8');
    const predicate = app.slice(app.indexOf('const canFormatMarkdown ='), app.indexOf('const formatMarkdown ='));
    expect(predicate).toContain('isMdActive() && !settings.readOnlyMode');
    // 走查 P 补视图 isReadOnly 判定（同步 instanceof 检查不依赖异步挂载）
    expect(app).toContain('tint, enabled: canFormatMarkdown');
    expect(app).toContain('enabled: canFormatMarkdown,');
  });
  it('zh/en 两字典 split 全部叫「分屏预览 / Split Preview」（修前 源码+预览分屏/Split View/分屏 三种叫法）', () => {
    for (const lang of ['zh-CN', 'en-US'] as const) {
      const d = dict(lang);
      const want = lang === 'zh-CN' ? '分屏预览' : 'Split Preview';
      expect(d['act.mdSplit']).toBe(want);
      expect(d['st.quick.splitTip']).toBe(want);
      expect(d['tb.mdSplit']).toBe(want);
    }
  });
});

describe('007 AC：渲染单源与语言表（规则 16/2 v2.0；v0.42 Lezer 单源）', () => {
  // v0.42 删锁登记：previewParseOpts 出厂全开锁作废——该函数服务于旧预览 API 解析选项，
  // Lezer 语法配置为编译期常量（static-html.ts staticMarkdownParser，IR 扩展同源），不再存在
  // 「运行时解析选项漂移」的面；原「两形态同口径」由三面共用同一解析器保证。

  it('CODE_HINT_LANGS 覆盖常用语言且无重复（``` 围栏语言行补全数据源）', () => {
    expect(CODE_HINT_LANGS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(CODE_HINT_LANGS).size).toBe(CODE_HINT_LANGS.length);
    for (const must of ['javascript', 'typescript', 'python', 'rust', 'go', 'json', 'yaml', 'sql', 'bash', 'markdown']) {
      expect(CODE_HINT_LANGS).toContain(must);
    }
  });

  it('引擎契约（规则 2 v0.16/16 v0.42）：IR 为自研 CM6 live preview；静态面（预览/分屏）单引 renderStaticHtml，无旧渲染器依赖', () => {
    const lp = readFileSync(resolve(__dirname, '../src/markdown-view/livepreview.ts'), 'utf8');
    const pv = readFileSync(resolve(__dirname, '../src/markdown-view/preview.ts'), 'utf8');
    expect(existsSync(resolve(__dirname, '../src/markdown-view/wysiwyg.ts'))).toBe(false); // 旧 IR 路径已删
    expect(lp).not.toMatch(/(?:from\s*|import\s*\(\s*)['"](?!\.|@codemirror\/|@lezer\/)[^'"]+['"]/);
    expect(pv).not.toMatch(/import\s*\(\s*['"](?!\.)[^'"]+['"]/); // 动态渲染依赖只能来自本地模块
    expect(lp).toMatch(/from '@codemirror\/lang-markdown'/);
    expect(lp).toContain('runMdFormat'); // 规则 17：三上下文同一实现
    expect(pv).toContain('renderStaticHtml'); // 静态渲染（预览整篇）单源不回漂
  });
});

describe('001/007 AC：弹层定位单一实现（placePopup）', () => {
  it('右下角子菜单向左并上移，所有命令留在视口内', () => {
    const anchor = document.createElement('div');
    anchor.getBoundingClientRect = () => ({ left: window.innerWidth - 140, right: window.innerWidth - 20,
      top: window.innerHeight - 50, bottom: window.innerHeight - 22 } as DOMRect);
    const sub = document.createElement('div');
    mockOffset(sub, 0, 318);
    placeSubmenu(anchor, sub);
    const left = parseInt(sub.style.left, 10), top = parseInt(sub.style.top, 10);
    expect(left).toBeLessThan(anchor.getBoundingClientRect().left);
    expect(left + sub.offsetWidth).toBeLessThanOrEqual(window.innerWidth - 4);
    expect(top + sub.offsetHeight).toBeLessThanOrEqual(window.innerHeight - 4);
    expect(top).toBeGreaterThanOrEqual(4);
    expect(sub.style.overflowY).toBe('auto');
  });
  it('顶部锚点（下方空间大）向下弹；底部锚点（上方空间大）向上弹——修「标题 ▾ 被顶出视口只显 H3/H4」', () => {
    // 顶部工具栏锚点：rect.top=90/bottom=120，菜单高 140 → 向下弹 top=122
    const anchor = document.createElement('button');
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      value: () => ({ top: 90, bottom: 120, left: 200, right: 260, width: 60, height: 30, x: 200, y: 90, toJSON: () => ({}) }),
      configurable: true,
    });
    const m = document.createElement('div');
    mockOffset(m, 0, 140);
    m.style.position = 'fixed';
    document.body.append(anchor, m);
    placePopup(anchor, m);
    expect(m.style.top).toBe('122px'); // 120 + gap 2
    expect(m.style.bottom).toBe('');

    // 底部状态栏锚点：rect.top=900（视口 960）→ 上方空间 900 远大于下方 36 → 向上弹
    const anchor2 = document.createElement('div');
    Object.defineProperty(anchor2, 'getBoundingClientRect', {
      value: () => ({ top: 900, bottom: 930, left: 200, right: 260, width: 60, height: 30, x: 200, y: 900, toJSON: () => ({}) }),
      configurable: true,
    });
    placePopup(anchor2, m);
    expect(m.style.top).toBe(`${900 - 140 - 2}px`);
  });

  it('水平双侧钳制（右缘越界钳回）', () => {
    const anchor = document.createElement('button');
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      value: () => ({ top: 90, bottom: 120, left: 1900, right: 1960, width: 60, height: 30, x: 1900, y: 90, toJSON: () => ({}) }),
      configurable: true,
    });
    const m = document.createElement('div');
    mockOffset(m, 0, 140);
    document.body.append(anchor, m);
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 960, configurable: true, writable: true });
    placePopup(anchor, m);
    expect(parseInt(m.style.left, 10)).toBeLessThanOrEqual(1920 - 180 - 4 + 1);
  });
});

describe('007 AC：分屏防跳顶（规则 6 v2.0）', () => {
  function buildDoc(): { scroller: HTMLElement; blocks: HTMLElement[] } {
    const scroller = document.createElement('div');
    const col = document.createElement('div');
    scroller.appendChild(col);
    const blocks: HTMLElement[] = [];
    const texts = ['第一段引言没有标题', '## 标题 A', '标题 A 下的正文', '## 标题 B', '结尾段'];
    texts.forEach((tx, i) => {
      const b = document.createElement(i % 2 === 1 ? 'h2' : 'p');
      b.textContent = tx;
      mockOffset(b, i * 100, 90);
      col.appendChild(b);
      blocks.push(b);
    });
    mockOffset(col, 0, 500);
    return { scroller, blocks };
  }

  it('分屏缓存包装层没有几何框时，以真实正文块捕获和恢复滚动锚点', () => {
    const scroller = document.createElement('div');
    scroller.innerHTML = '<div class="md-col"><div class="md-block"><p>第一段</p></div><div class="md-block"><p>当前段落</p></div></div>';
    const blocks = scroller.querySelectorAll('p');
    Object.defineProperties(blocks[0]!, { offsetTop: { value: 20 }, offsetHeight: { value: 100 } });
    Object.defineProperties(blocks[1]!, { offsetTop: { value: 140 }, offsetHeight: { value: 100 } });
    scroller.scrollTop = 160;
    const anchor = captureTopBlock(scroller);
    expect(anchor?.text).toBe('当前段落');
    expect(restoreTopBlock(scroller, anchor, 160)).toBe(blocks[1]);
    expect(scroller.scrollTop).toBe(160);
  });
  it('captureTopBlock：视口顶部的任意块都成锚（含无 data-line 的正文段）', () => {
    const { scroller, blocks } = buildDoc();
    scroller.scrollTop = 210; // 顶部是第 3 块（offsetTop 200，「标题 A 下的正文」）
    const anchor = captureTopBlock(scroller);
    expect(anchor).not.toBeNull();
    expect(anchor!.line).toBeNull(); // 正文段没有 data-line —— 修前此场景锚为 null 跳顶
    expect(anchor!.text).toBe('标题 A 下的正文');
    expect(blocks[2].textContent).toBe('标题 A 下的正文');
  });

  it('行号锚忽略无几何框的包装层，前文高度变化仍保留块内偏移', () => {
    const scroller = document.createElement('div');
    scroller.innerHTML = '<div><div class="md-block" data-line="3"><p data-line="3">当前段</p></div></div>';
    const block = scroller.querySelector('p')!;
    Object.defineProperties(block, { offsetTop: { value: 140, configurable: true }, offsetHeight: { value: 100 } });
    scroller.scrollTop = 160;
    const anchor = captureTopBlock(scroller);
    Object.defineProperty(block, 'offsetTop', { value: 180 });
    expect(restoreTopBlock(scroller, anchor, 160)).toBe(block);
    expect(scroller.scrollTop).toBe(200);
  });

  it('restoreTopBlock：按文本前缀回到同一块；都不中回退原 scrollTop', () => {
    const { scroller } = buildDoc();
    scroller.scrollTop = 210;
    const anchor = captureTopBlock(scroller);
    // 模拟重渲：同结构新 DOM
    const { scroller: sc2 } = buildDoc();
    const el = restoreTopBlock(sc2, anchor, 210);
    expect(el).not.toBeNull();
    expect(sc2.scrollTop).toBe(210); // 保留块内10px偏移
    // 锚全不中：回退
    const el2 = restoreTopBlock(sc2, { line: null, text: '不存在的内容###' }, 333);
    expect(el2).toBeNull();
    expect(sc2.scrollTop).toBe(333);
  });
});

describe('001 AC：新建文件格式下拉（规则 28 v2.1）', () => {
  it('dlgPromptWithFormat：确定返回 {name, format}，取消返回 null', async () => {
    const p = dlgPromptWithFormat('新建文件', [
      { id: 'txt', label: '纯文本' },
      { id: 'md', label: 'Markdown' },
    ], 'md');
    await new Promise(r => setTimeout(r, 20));
    const input = document.querySelector('.ov-mask .dlg-input:not(select)') as HTMLInputElement;
    const sel = document.querySelector('.ov-mask select') as HTMLSelectElement;
    input.value = '笔记';
    sel.value = 'md';
    const ok = document.querySelector('.ov-mask .dlg-btn.primary') as HTMLButtonElement;
    ok.click();
    const r = await p;
    expect(r).toEqual({ name: '笔记', format: 'md' });
  });
});
