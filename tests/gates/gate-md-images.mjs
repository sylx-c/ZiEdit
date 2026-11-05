// gate-md-images.mjs — Markdown 本地图片真实渲染门禁（原生 WebView2，非 jsdom）。
// 覆盖：普通相对路径 / 中文与空格（原始<>与URL编码）/ %与#编码 / 绝对路径 / 引用式 /
//       表格内图片 / 文档目录外 ../ / 查询串 / SVG / 懒加载底部图 / 缺失图降级。
// 断言：除缺失图外全部 naturalWidth>0（真实解码）、无其它破图、加载地址仅走 zasset 协议。
// IR 离屏块会卸载，故逐屏滚动中持续采集并按 src 合并，而非只在静止位置取一次。
// 用法：node tests/gates/gate-md-images.mjs [output.json]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EXE, RUN_DIR, REPO_ROOT, connectCDP, waitTargets, waitFor, switchMdMode, dismissOverlay, killTree, sleep } from './gate-lib.mjs';

const corpus = path.join(RUN_DIR, 'image-corpus'), assets = path.join(corpus, 'assets');
fs.mkdirSync(assets, { recursive: true });
const copy = (from, to) => fs.copyFileSync(path.join(REPO_ROOT, 'src-tauri/icons', from), to);
copy('128x128.png', path.join(assets, 'normal.png'));
copy('128x128@2x.png', path.join(assets, '中文 空格.png'));
copy('64x64.png', path.join(assets, '100%#tag.png'));
copy('Square284x284Logo.png', path.join(assets, 'big.png'));
copy('32x32.png', path.join(RUN_DIR, 'outside.png')); // 文档目录外但存在：会话内授权放行，应可显示
fs.writeFileSync(path.join(assets, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#3a7"/></svg>');
const absolute = path.join(assets, 'normal.png').replace(/\\/g, '/');
const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: 填充行用于拉开文档高度，验证底部图片懒加载。`).join('\n\n');
const md = [
  '# 图片原生验证', '',
  '![普通](assets/normal.png)', '',
  '![中文原始](<assets/中文 空格.png>)', '', // markdown-it 在预览/分屏会规范化为编码 URL
  '![中文编码](assets/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC.png)', '',
  '![百分井号](assets/100%25%23tag.png)', '',
  `![绝对路径](${absolute})`, '',
  '![引用式][logo]', '',
  '| 列 |', '| --- |', '| ![表内](assets/normal.png) |', '',
  '![文档外](../outside.png)', '',
  '![查询串](assets/normal.png?ver=1)', '',
  '![矢量](assets/vector.svg)', '',
  '![大图](assets/big.png)', '',
  filler, '',
  '![底部](assets/normal.png)', '',
  '![missing-alt](assets/missing.png)', '',
  '[logo]: assets/normal.png', '',
].join('\n');
const mdPath = path.join(corpus, 'images.md');
fs.writeFileSync(mdPath, md, 'utf8');
// 原始中文写法与编码写法指向同一文件；编码项覆盖两种写法的加载断言，原始写法另由全局破图检查兜底。
const EXPECT = ['assets/normal.png', 'assets/%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC.png',
  'assets/100%25%23tag.png', absolute, '../outside.png', 'assets/normal.png?ver=1', 'assets/vector.svg', 'assets/big.png'];
const MISSING = 'assets/missing.png';
const MODES = [
  ['preview', '渲染预览', '.md-preview:not(.md-split-preview)', '.md-preview:not(.md-split-preview) .md-col'],
  ['split', '分屏预览', '.md-split-preview', '.md-split-preview .md-col'],
  ['ir', '即时渲染', '.md-ir:not(.md-ir-loading)', '.md-ir:not(.md-ir-loading) .cm-scroller'],
];
const norm = s => String(s || '').replace(/\\/g, '/');
const collectExpr = sel => '(() => { const root = document.querySelector(' + JSON.stringify(sel) + '); if (!root) return null;'
  + " return [...root.querySelectorAll('img')].map(img => ({ src: img.dataset.mdSrc || img.getAttribute('src') || '', current: img.currentSrc || img.src || '', complete: img.complete, w: img.naturalWidth, h: img.naturalHeight, broken: img.dataset.mdBroken || '', box: !!img.closest('.mdir-imgbox.is-broken'),"
  + " ...(img.dataset.mdSrc || img.getAttribute('src') ? {} : { html: img.outerHTML.slice(0, 200), parent: img.parentElement ? img.parentElement.className : '', line: ((img.closest('.cm-line') || {}).textContent || '').slice(0, 80) }) }))"
  + ".concat([...root.querySelectorAll('.mdir-img-broken')].map(el => ({ placeholder: el.textContent || '' }))); })()";

const output = process.argv[2] || path.join(RUN_DIR, 'results', 'md-images.json');
const child = spawn(EXE, [mdPath], { stdio: 'ignore', windowsHide: true,
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(RUN_DIR, 'profiles/md-images-' + Date.now()) } });
const report = { exe: EXE, corpus: mdPath, modes: [], extra: [], verdict: false };
let cdp;
try {
  cdp = await connectCDP((await waitTargets(60000)).webSocketDebuggerUrl);
  await waitFor(cdp, "!!document.querySelector('.md-col,.md-ir:not(.md-ir-loading) .cm-line')", 180000);
  await dismissOverlay(cdp);
  for (const [mode, label, contentSel, scrollerSel] of MODES) {
    if (!await cdp.evaluate(`!!document.querySelector(${JSON.stringify(contentSel)})`)) await switchMdMode(cdp, label);
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(contentSel)})`, 180000);
    const seen = new Map(); // key=src（或占位文本），新记录已解码/带降级标记时覆盖旧记录
    const merge = list => { for (const i of list || []) {
      const k = i.placeholder ? 'ph:' + i.placeholder : (norm(i.src) || '(empty)');
      const old = seen.get(k);
      if (!old || i.w > 0 || i.broken === '1' || i.box || (!old.complete && i.complete)) seen.set(k, i);
    } };
    const collect = async () => merge(await cdp.evaluate(collectExpr(contentSel)));
    const setTop = y => cdp.evaluate('(() => { const sc = document.querySelector(' + JSON.stringify(scrollerSel) + '); if (sc) sc.scrollTop = ' + y + '; return sc ? sc.scrollTop : -1; })()');
    const geo = await cdp.evaluate('(() => { const sc = document.querySelector(' + JSON.stringify(scrollerSel) + '); return sc ? { h: sc.scrollHeight, step: Math.max(200, sc.clientHeight * 0.8) } : null; })()');
    if (!geo) throw new Error('scroller missing: ' + mode);
    for (let y = 0; y <= geo.h + geo.step; y += geo.step) { await setTop(Math.round(y)); await sleep(100); await collect(); }
    await setTop(0); await sleep(400); await collect();
    const satisfied = () => {
      const loaded = new Set([...seen.values()].filter(i => i.w > 0).map(i => norm(i.src)));
      return EXPECT.every(e => loaded.has(norm(e)))
        && [...seen.values()].some(i => norm(i.src) === MISSING || i.placeholder === 'missing-alt');
    };
    const t0 = Date.now();
    while (!satisfied() && Date.now() - t0 < 20000) { await sleep(500); await collect(); }
    const imgs = [...seen.values()];
    const failures = [];
    for (const e of EXPECT) {
      const i = seen.get(norm(e));
      if (!i) failures.push('no img element: ' + e);
      else if (!(i.w > 0 && i.h > 0)) failures.push('not decoded: ' + e + ' ' + JSON.stringify(i));
      else if (!/^http:\/\/zasset\.localhost\//.test(i.current)) failures.push('unexpected protocol: ' + e + ' -> ' + i.current);
    }
    for (const i of imgs) { // 全局破图检查：任何非缺失图源码加载完成却解码失败都算缺陷
      if (i.src && norm(i.src) !== MISSING && i.complete && i.w === 0) failures.push('broken image: ' + i.src + ' ' + JSON.stringify(i));
    }
    const missing = seen.get(MISSING);
    if (missing && missing.w > 0) failures.push('missing image unexpectedly decoded');
    const missingMarked = (missing && (missing.broken === '1' || missing.box || (missing.complete && missing.w === 0))) || seen.has('ph:missing-alt');
    if (!missingMarked) failures.push('missing image has no broken/fallback marker: ' + JSON.stringify(missing));
    report.modes.push({ mode, verdict: failures.length === 0, failures, imgs });
    console.log(mode, failures.length === 0 ? 'PASS' : 'FAIL', failures.join(' | '));
  }
  // 回归 1：IR 下真实键入后，已挂载内容图片不应破图（增量重渲染不能把图片洗成空 src）
  await cdp.evaluate("(() => { const el = document.querySelector('.md-ir .cm-content'); if (el) el.focus(); return !!el; })()");
  await cdp.send('Input.insertText', { text: 'Z' });
  await sleep(800);
  const afterEdit = await cdp.evaluate(collectExpr('.md-ir:not(.md-ir-loading)')) || [];
  const editBad = afterEdit.filter(i => i.src && norm(i.src) !== MISSING && i.complete && i.w === 0 && !/cm-widgetBuffer/.test(i.html || ''));
  const editOk = editBad.length === 0 && afterEdit.some(i => norm(i.src) === 'assets/normal.png' && i.w > 0);
  report.extra.push({ check: 'ir-edit-images', pass: editOk, bad: editBad });
  console.log('ir-edit-images', editOk ? 'PASS' : 'FAIL', JSON.stringify(editBad));
  // 回归 2：IR → 渲染预览往返后，全部图片重新解析并加载
  await switchMdMode(cdp, '渲染预览');
  await waitFor(cdp, "!!document.querySelector('.md-preview:not(.md-split-preview) .md-col')", 180000);
  await sleep(1000);
  const back = await cdp.evaluate(collectExpr('.md-preview:not(.md-split-preview)')) || [];
  const backMissing = EXPECT.filter(e => !back.some(i => norm(i.src) === norm(e) && i.w > 0));
  report.extra.push({ check: 'roundtrip-preview', pass: backMissing.length === 0, notLoaded: backMissing });
  console.log('roundtrip-preview', backMissing.length === 0 ? 'PASS' : 'FAIL', backMissing.join(','));
  report.verdict = report.modes.every(m => m.verdict) && report.extra.every(x => x.pass);
} catch (e) { report.error = String(e); console.error(e); }
finally { await cdp?.close(); await killTree(child.pid); }
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ verdict: report.verdict, output }));
if (!report.verdict) process.exit(1);
