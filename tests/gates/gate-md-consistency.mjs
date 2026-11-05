// gate-md-consistency.mjs — 渲染预览 / 即时渲染 同文档观感一致性真机门（2026-10-30 体验整改阶段 3）
// 两种形态是两套渲染（预览：Lezer→HTML；即时渲染：CM6 装饰），样式各写一份，修一边漏一边是
// 「Markdown 小毛病修一个冒一个」的结构性来源。本门用一份含全部常用元素的样例文档，在同一窗口里
// 先后进两种形态，逐元素比对计算样式（字号/字重/字形/行高/颜色/底色/装饰线/字体族）与几何
// （正文起点相对阅读栏的横向位置；表格/引用/分隔线的宽度），亮暗两种主题各比一轮。
// 判据：除已登记的实现差异（ALLOWED）外，所有比对项一致（数值容差 1.5px）。
// 用法: node tests/gates/gate-md-consistency.mjs   （仅 Windows；结果 RUN_DIR/results/gate-md-consistency.json）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RUN_DIR, EXE, waitTargets, connectCDP, waitMounted, killTree, sleep, waitFor, dismissOverlay, switchMdMode } from './gate-lib.mjs';

const fixture = path.join(RUN_DIR, 'corpus', 'md-consistency.md');
fs.mkdirSync(path.dirname(fixture), { recursive: true });
fs.writeFileSync(fixture, `# Heading One
## Heading Two
### Heading Three
#### Heading Four
##### Heading Five
###### Heading Six

Paragraph sample with **bold text**, *italic text*, ~~struck text~~, \`inline code\`, [a link](https://example.com), ==marked text== and the end.

> Quote sample line

- List item one
- List item two
  - Nested item

1. Ordered one

- [ ] Task open

\`\`\`js
const codeSample = 1;
\`\`\`

| Head A | Head B |
| --- | --- |
| cell one | cell two |
| cell three | cell four |

---

Footnote ref[^1] here.

[^1]: Footnote text.

Final paragraph.
`);
const outFile = path.join(RUN_DIR, 'results', 'gate-md-consistency.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const webviewDir = path.join(RUN_DIR, 'profiles', 'md-consistency');

const PROPS = ['fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'color', 'backgroundColor', 'textDecorationLine', 'fontFamily'];
// [名称, 预览选择器, 即时渲染选择器, 文本匹配]
const PAIRS = [
  ['h1', 'h1', '.cm-line.mdir-h1'], ['h2', 'h2', '.cm-line.mdir-h2'], ['h3', 'h3', '.cm-line.mdir-h3'],
  ['h4', 'h4', '.cm-line.mdir-h4'], ['h5', 'h5', '.cm-line.mdir-h5'], ['h6', 'h6', '.cm-line.mdir-h6'],
  ['p', 'p', '.cm-line', 'Paragraph sample'], ['strong', 'strong', '.mdir-strong'], ['em', 'em', '.mdir-em'],
  ['strike', 'del,s', '.mdir-strike'], ['icode', 'p code', '.mdir-icode'], ['link', 'p a', '.mdir-link'], ['mark', 'mark', '.mdir-highlight'],
  ['quote', 'blockquote', '.cm-line.mdir-quote', 'Quote sample'], ['li', 'li', '.cm-line', 'List item one'],
  ['nested', 'li li', '.cm-line', 'Nested'], ['ol', 'ol li', '.cm-line', 'Ordered'], ['task', 'li', '.cm-line', 'Task open'],
  ['code', 'pre', '.cm-line.mdir-code'], ['table', 'table', 'table.mdir-table'], ['th', 'th', '.mdir-table th', 'Head A'],
  ['td', 'td', '.mdir-table td', 'cell one'], ['hr', 'hr', '.mdir-hr'], ['fnref', 'sup a', '.mdir-footnote-ref'],
];
// 已登记的实现差异：观感等价、计算样式不同（不计失败）
const ALLOWED = {
  quote: ['lineHeight'], // 预览为块元素、即时渲染为逐行；竖条一边 border 一边渐变，正文起点已比对
  code: ['lineHeight', 'y'], // 预览 pre 是单一边框盒；IR 是逐行盒+独立间距件，盒起点不同，代码正文行高已比对
  task: ['textX'], // 复选框盒宽不同（预览 UA 默认盒 + 负外边距，即时渲染 1.6em 件），正文差约 3px
};
const GEOMETRY = { width: ['table', 'hr'], textX: ['p', 'quote', 'li', 'nested', 'ol', 'task', 'th', 'td', 'h1'], y: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'quote', 'li', 'ol', 'task', 'table', 'hr'] };

const collect = side => `(() => {
  const root = [...document.querySelectorAll(${JSON.stringify(side === 'ir' ? '.md-ir' : '.md-preview')})].find(e => e.offsetParent !== null);
  const col = root.querySelector(${JSON.stringify(side === 'ir' ? '.cm-content' : '.md-col')});
  const cr = col.getBoundingClientRect(), pad = parseFloat(getComputedStyle(col).paddingLeft);
  const out = {};
  for (const [name, pre, ir, text] of ${JSON.stringify(PAIRS)}) {
    const el = [...root.querySelectorAll(${side === 'ir' ? 'ir' : 'pre'})].find(e => !text || e.textContent.includes(text));
    if (!el) { out[name] = null; continue; }
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node, textX = null;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim() || (text && !node.textContent.includes(text))) continue;
      const i = node.textContent.length - node.textContent.trimStart().length, range = document.createRange();
      range.setStart(node, i); range.setEnd(node, i + 1); textX = Math.round((range.getBoundingClientRect().left - cr.left - pad) * 10) / 10; break;
    }
    const contentRange = document.createRange(); contentRange.selectNodeContents(el);
    const contentY = contentRange.getBoundingClientRect().top;
    out[name] = { ...Object.fromEntries(${JSON.stringify(PROPS)}.map(p => [p, cs[p]])), width: Math.round(r.width), y: Math.round(((name === 'code' ? contentY - parseFloat(cs.paddingTop) - parseFloat(cs.borderTopWidth) : r.top) - cr.top - parseFloat(getComputedStyle(col).paddingTop)) * 10) / 10, textX };
  }
  return out; })()`;

const TONES = { paper: 'light', graphite: 'dark' };
const out = { exe: EXE, fixture, started: new Date().toISOString(), rounds: [] };
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

function compare(pre, ir) {
  const diffs = [];
  for (const [name] of PAIRS) {
    const a = pre[name], b = ir[name];
    if (!a || !b) { diffs.push({ name, missing: !a ? 'preview' : 'ir' }); continue; }
    const keys = [...PROPS, ...Object.keys(GEOMETRY).filter(k => GEOMETRY[k].includes(name))];
    for (const k of keys) {
      if (ALLOWED[name]?.includes(k)) continue;
      let x = a[k], y = b[k];
      if (k === 'fontFamily') { x = String(x).split(',')[0]; y = String(y).split(',')[0]; }
      const same = typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) <= 1.5 : x === y;
      if (!same) diffs.push({ name, prop: k, preview: x, ir: y });
    }
  }
  return diffs;
}

(async () => {
  const child = spawn(EXE, [fixture], { detached: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: webviewDir } });
  child.unref();
  let cdp;
  try {
    cdp = await connectCDP((await waitTargets(30000)).webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await waitMounted(cdp); await sleep(2500);
    if (!(await dismissOverlay(cdp))) throw new Error('welcome/overlay modal not dismissible (fail-closed)');
    for (const [theme, tone] of Object.entries(TONES)) {
      // 主题切换同 chrome.ts applyTheme：<html> 主题类 + data-tone
      await cdp.evaluate(`(() => { const r = document.documentElement; r.className = r.className.replace(/\\bth-\\S+/g, '').trim(); r.classList.add('th-${theme}'); r.dataset.tone = '${tone}'; })()`);
      const previewShown = `!![...document.querySelectorAll('.md-preview')].find(e => e.offsetParent !== null && !e.closest('.md-split'))`;
      if (!(await cdp.evaluate(previewShown))) await switchMdMode(cdp, '渲染预览');
      await waitFor(cdp, previewShown); await sleep(1500);
      const pre = await cdp.evaluate(collect('pre'));
      await switchMdMode(cdp, '即时渲染');
      await waitFor(cdp, `!![...document.querySelectorAll('.md-ir:not(.md-ir-loading) .cm-content')].find(e => e.offsetParent !== null)`); await sleep(1500);
      // 光标放到末段：其余块都处于非活动（渲染）态
      await cdp.evaluate(`(() => { const v = [...document.querySelectorAll('.md-ir:not(.md-ir-loading) .cm-content')].find(e => e.offsetParent !== null).cmTile.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); })()`);
      await sleep(800);
      const ir = await cdp.evaluate(collect('ir'));
      const diffs = compare(pre, ir);
      out.rounds.push({ theme, tone, pass: diffs.length === 0, diffs }); save();
      console.log(`${diffs.length ? 'FAIL' : 'PASS'} ${theme}/${tone}${diffs.length ? ' ' + JSON.stringify(diffs) : ''}`);
      await switchMdMode(cdp, '渲染预览');
    }
  } catch (err) {
    out.fatal = String(err?.stack ?? err); console.error(out.fatal);
  } finally {
    out.verdict = !out.fatal && out.rounds.length === Object.keys(TONES).length && out.rounds.every(r => r.pass);
    save();
    try { cdp?.close(); } catch {}
    await killTree(child.pid);
    console.log(`verdict: ${out.verdict ? 'PASS' : 'FAIL'} → ${outFile}`);
    process.exit(out.verdict ? 0 : 1);
  }
})();
