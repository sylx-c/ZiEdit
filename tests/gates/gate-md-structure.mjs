// gate-md-structure.mjs — Markdown 展示结构真机门（2026-11-11 CRLF 展示缺陷收口）
// 职责：回答「这些元素在实际窗口里到底渲染出来了吗」。用同一份样例的 LF / CRLF / CR /
// 混合行尾四份副本，在渲染预览里逐元素断言存在性与文本（标题/表格/任务列表/引用/代码块），
// 并断言正文里没有以竖线原样出现的表格源码；再切即时渲染断言表格件。任一缺失即 FAIL。
// 与 gate-md-consistency 的分工：本门只看结构（快、可常绿）；样式与几何一致性仍归
// gate-md-consistency（其纵向间距基线差另案收口，不影响本门判定）。
// 用法: node tests/gates/gate-md-structure.mjs [out.json]   （仅 Windows；默认 RUN_DIR/results/gate-md-structure.json）
// [out.json] 供 run-all.mjs 传入汇总目录内路径；不传时保持原默认（历史口径不变）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RUN_DIR, EXE, waitTargets, connectCDP, waitMounted, killTree, sleep, waitFor, dismissOverlay, switchMdMode } from './gate-lib.mjs';

const LINES = [
  '# 结构样例标题',
  '',
  '| Head A | Head B |',
  '| --- | --- |',
  '| cell one | cell two |',
  '',
  '- [ ] task open',
  '',
  '> quote line',
  '',
  '```js',
  'const sample = 1;',
  '```',
];
const VARIANTS = [
  { label: 'lf', text: LINES.join('\n') + '\n' },
  { label: 'crlf', text: LINES.join('\r\n') + '\r\n' },
  { label: 'cr', text: LINES.join('\r') + '\r' },
  // 混排：表头行 CRLF、分隔行 CR、其余 LF——任一行尾漏归一都会让表格退化成段落。
  { label: 'mixed', text: LINES.map((line, i) => line + (i === 2 ? '\r\n' : i === 3 ? '\r' : '\n')).join('') },
];

const corpusDir = path.join(RUN_DIR, 'corpus');
fs.mkdirSync(corpusDir, { recursive: true });
const fixtures = VARIANTS.map(variant => {
  const file = path.join(corpusDir, `md-structure-${variant.label}.md`);
  fs.writeFileSync(file, variant.text);
  return { ...variant, file };
});

const outFile = path.resolve(process.argv[2] ?? path.join(RUN_DIR, 'results', 'gate-md-structure.json'));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const out = { exe: EXE, started: new Date().toISOString(), fixtures: [] };
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

// 预览面结构采集：只取元素存在性与关键文本，不碰样式。
// rawPipes 只读预览渲染根：#viewarea 里还有隐藏源码缓冲（原文必含竖线），读它会恒误报。
const COLLECT = `(() => {
  const root = [...document.querySelectorAll('.md-preview')].find(e => e.offsetParent !== null && !e.closest('.md-split'));
  if (!root) return null;
  return {
    h1: root.querySelector('h1')?.textContent ?? null,
    tableCells: root.querySelectorAll('table th, table td').length,
    headA: [...root.querySelectorAll('th')].some(e => e.textContent.trim() === 'Head A'),
    cellOne: [...root.querySelectorAll('td')].some(e => e.textContent.trim() === 'cell one'),
    task: root.querySelectorAll('li input[type=checkbox]').length,
    quote: root.querySelector('blockquote')?.textContent ?? null,
    code: root.querySelector('pre code')?.textContent ?? null,
    rawPipes: (root.textContent || '').includes('| Head A'),
  }; })()`;

async function runFixture(item) {
  const record = { label: item.label, file: item.file, checks: [], pass: false };
  out.fixtures.push(record); save();
  const child = spawn(EXE, [item.file], { detached: true, stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(RUN_DIR, 'profiles', 'md-structure-' + item.label) } });
  child.unref();
  let cdp;
  const check = (name, pass, detail) => { record.checks.push({ name, pass, detail }); save(); console.log(`${pass ? 'PASS' : 'FAIL'} [${item.label}] ${name}${pass ? '' : ' ' + JSON.stringify(detail)}`); };
  try {
    cdp = await connectCDP((await waitTargets(30000)).webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await waitMounted(cdp); await sleep(2500);
    if (!(await dismissOverlay(cdp))) throw new Error('welcome/overlay modal not dismissible (fail-closed)');
    const previewShown = `!![...document.querySelectorAll('.md-preview')].find(e => e.offsetParent !== null && !e.closest('.md-split'))`;
    if (!(await cdp.evaluate(previewShown))) await switchMdMode(cdp, '渲染预览');
    await waitFor(cdp, previewShown); await sleep(1200);
    const structure = await cdp.evaluate(COLLECT);
    if (!structure) throw new Error('preview surface not found');
    check('标题渲染', structure.h1 === '结构样例标题', structure.h1);
    check('表格单元格齐全（2 表头 + 2 数据）', structure.tableCells === 4, structure.tableCells);
    check('表头文本', structure.headA, structure.headA);
    check('数据单元格文本', structure.cellOne, structure.cellOne);
    check('表格未退化成竖线正文', structure.rawPipes === false, structure.rawPipes);
    check('任务列表复选框', structure.task === 1, structure.task);
    check('引用块', (structure.quote ?? '').includes('quote line'), structure.quote);
    check('代码块', (structure.code ?? '').includes('const sample = 1'), structure.code);
    await switchMdMode(cdp, '即时渲染');
    await waitFor(cdp, `!![...document.querySelectorAll('.md-ir:not(.md-ir-loading) table.mdir-table')].find(e => e.offsetParent !== null)`, 30000);
    await sleep(800);
    check('即时渲染表格件', await cdp.evaluate(`!![...document.querySelectorAll('.md-ir:not(.md-ir-loading) table.mdir-table')].find(e => e.offsetParent !== null)`));
  } catch (err) {
    record.error = String(err?.stack ?? err); console.error(record.error);
  } finally {
    try { cdp?.close(); } catch {}
    await killTree(child.pid);
  }
  record.pass = !record.error && record.checks.length > 0 && record.checks.every(check => check.pass);
  save();
  console.log(`${record.pass ? 'PASS' : 'FAIL'} fixture=${item.label}`);
}

(async () => {
  for (const item of fixtures) await runFixture(item);
  out.finished = new Date().toISOString();
  out.verdict = out.fixtures.every(item => item.pass);
  save();
  console.log(`verdict: ${out.verdict ? 'PASS' : 'FAIL'} → ${outFile}`);
  process.exit(out.verdict ? 0 : 1);
})();
