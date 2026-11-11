// 实际 WebView2 格式往返与 20 标签 × 20 轮资源释放；不操作真实用户文件。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { releaseFixtures } from './release-fixtures.mjs';
import { EXE, RUN_DIR, waitTargets, connectCDP, waitFor, dismissOverlay, killTree, pressKey, sleep, switchMdMode, clickXY } from './gate-lib.mjs';
const output = path.resolve(process.argv[2]);
const resources = process.argv.includes('--resources');
const dir = path.join(RUN_DIR, 'files', resources ? 'release-resources' : 'release-formats');
const files = releaseFixtures(dir), report = { verdict: false, checks: [], rounds: [], errors: [] };
const child = spawn(EXE, [files.txt], { stdio: 'ignore', windowsHide: true,
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(RUN_DIR, 'profiles', resources ? 'resources' : 'formats') } });
let cdp;
const save = () => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); };
const check = (name, pass, detail) => { report.checks.push({ name, pass, detail }); save(); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); if (!pass) throw new Error(name + ': ' + JSON.stringify(detail)); };
const active = file => `document.querySelector('.tab.active')?.title.split('\\n')[0].toLowerCase()===${JSON.stringify(file.toLowerCase())}`;
const selectors = { txt: '.cm-content', md: '.md-col,.md-ir:not(.md-ir-loading) .cm-content,.cm-content', csv: '.csv-cell', png: '.img-canvas', pdf: '.pdf-view canvas', docx: '.tv-tx', xlsx: '.csv-cell' };
async function open(file, type) {
  const opener = spawn(EXE, [file], { stdio: 'ignore', windowsHide: true }); opener.unref();
  await waitFor(cdp, active(file), 30000);
  await waitFor(cdp, `[...document.querySelectorAll(${JSON.stringify(selectors[type])})].some(el=>el.offsetParent!==null${type === 'png' ? '&&el.complete&&el.naturalWidth>0' : ''})`, 60000);
}
async function closeAll() {
  await cdp.send('Page.bringToFront');
  await cdp.evaluate(`[...document.querySelectorAll('.cm-content')].find(e=>e.offsetParent!==null)?.cmTile?.view.focus()`);
  const point = await cdp.evaluate(`(() => {const e=[...document.querySelectorAll('.cm-content')].find(e=>e.offsetParent!==null);if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+10,y:r.top+8}})()`);
  if (point) await clickXY(cdp, point.x, point.y);
  await pressKey(cdp, 'w', 'KeyW', 87, 10);
  await waitFor(cdp, `document.querySelectorAll('.tab').length===0`, 30000);
}
try {
  cdp = await connectCDP((await waitTargets(60000)).webSocketDebuggerUrl);
  await cdp.send('Performance.enable');
  await cdp.evaluate(`window.__releaseKeys=[];document.addEventListener('keydown',e=>{const x={key:e.key,ctrl:e.ctrlKey,shift:e.shiftKey,composing:e.isComposing};window.__releaseKeys.push(x);queueMicrotask(()=>Object.assign(x,{prevented:e.defaultPrevented,tabs:document.querySelectorAll('.tab').length,overlay:!!document.querySelector('.ov-mask')}))},true)`);
  await waitFor(cdp, `!!document.querySelector('.cm-content')`, 60000); await dismissOverlay(cdp);
  await closeAll();
  // 只在验收页安装观测器，不向生产应用增加调试 IPC。
  await cdp.evaluate(`window.__releaseWorkers=new Map();window.__releaseErrors=[];
    window.addEventListener('error',e=>window.__releaseErrors.push(e.message));
    const NativeWorker=window.Worker;window.Worker=new Proxy(NativeWorker,{construct(Target,args){
      const worker=new Target(...args),url=String(args[0]);window.__releaseWorkers.set(worker,url);
      const terminate=worker.terminate.bind(worker);worker.terminate=()=>{window.__releaseWorkers.delete(worker);return terminate()};return worker;}});`);
  if (resources) {
    const twenty = [];
    for (let i = 0; i < 20; i++) { const type = ['txt', 'md', 'pdf', 'png', 'csv'][i % 5], file = path.join(dir, `round-file-${i}.${type}`); fs.copyFileSync(files[type], file); twenty.push({ file, type }); }
    for (let round = 0; round < 20; round++) {
      for (const { file, type } of twenty) await open(file, type);
      check(`第 ${round + 1} 轮打开 20 个混合标签`, await cdp.evaluate(`document.querySelectorAll('.tab').length===20`));
      for (let i = 19; i >= 0; i--) {
        await cdp.evaluate(`document.querySelectorAll('.tab')[${i}].click()`);
        await waitFor(cdp, active(twenty[i].file));
      }
      await closeAll(); await sleep(750);
      const state = await cdp.evaluate(`({workers:[...window.__releaseWorkers.values()],hosts:document.querySelectorAll('.view-host').length,canvases:document.querySelectorAll('.pdf-view canvas').length,errors:window.__releaseErrors})`);
      const metrics = await cdp.send('Performance.getMetrics');
      const memory = await promisify(execFile)('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).WorkingSet64`], { windowsHide: true });
      report.rounds.push({ round: round + 1, ...state, rssBytes: Number(memory.stdout.trim()),
        jsHeapBytes: metrics.metrics.find(item => item.name === 'JSHeapUsedSize')?.value });
      check(`第 ${round + 1} 轮关闭释放专属 Worker、宿主与 canvas`, state.workers.length === 0 && state.hosts === 0 && state.canvases === 0 && state.errors.length === 0, state);
    }
  } else {
    for (const [type, file] of Object.entries(files)) {
      await open(file, type);
      const detail = await cdp.evaluate(`({text:document.querySelector('#viewarea')?.textContent,image:document.querySelector('.img-canvas')?.naturalWidth,canvas:document.querySelector('canvas')?.width})`);
      check(`${type} 中文空格路径真实渲染`, type === 'png' ? detail.image > 0 : type === 'pdf' ? detail.canvas > 0 : type === 'md' || detail.text.includes('中文'), detail);
      // md 夹具为 CRLF：表格必须真实渲染，渲染面不得出现竖线原文（2026-11-11 CRLF 展示缺陷的发布侧防线）。
      if (type === 'md') check('md CRLF 表格真实渲染', await cdp.evaluate(`(() => { const root = [...document.querySelectorAll('.md-preview')].find(e => e.offsetParent !== null && !e.closest('.md-split')); return !!root && !!root.querySelector('table') && !(root.textContent || '').includes('| A |'); })()`));
    }
    await open(files.md, 'md');
    for (const [mode, signature] of [['源码视图', '.view-host:not(.parked) .cm-content'], ['渲染预览', '.md-preview:not(.md-split-preview) .md-col'], ['分屏预览', '.md-split-preview .md-col'], ['即时渲染', '.md-ir:not(.md-ir-loading) .cm-content']]) {
      await switchMdMode(cdp, mode);
      await waitFor(cdp, `[...document.querySelectorAll(${JSON.stringify(signature)})].some(el=>el.offsetParent!==null)`, 60000);
      check('Markdown 形态切换 ' + mode, true);
    }
    await closeAll();
    const empty = path.join(dir, 'empty.txt'); fs.writeFileSync(empty, ''); await open(empty, 'txt'); check('空文本可打开', true);
    const readonly = path.join(dir, 'readonly.txt'); fs.writeFileSync(readonly, 'original readonly\n'); fs.chmodSync(readonly, 0o444);
    try {
      await open(readonly, 'txt');
      await cdp.evaluate(`[...document.querySelectorAll('.cm-content')].find(e=>e.offsetParent!==null)?.cmTile.view.focus()`);
      await cdp.send('Input.insertText', { text: '__READONLY_EDIT__' });
      await pressKey(cdp, 's', 'KeyS', 83, 2);
      await waitFor(cdp, `!!document.querySelector('.ov-mask')`, 10000);
      check('磁盘只读保存失败可见且保留脏内容', fs.readFileSync(readonly, 'utf8') === 'original readonly\n'
        && await cdp.evaluate(`!!document.querySelector('.tab.active .tab-dot')`));
      await dismissOverlay(cdp);
    } finally { fs.chmodSync(readonly, 0o666); }
    await pressKey(cdp, 's', 'KeyS', 83, 2);
    for (let i = 0; i < 40 && !fs.readFileSync(readonly, 'utf8').includes('__READONLY_EDIT__'); i++) await sleep(100);
    check('解除磁盘只读后原缓冲仍可保存', fs.readFileSync(readonly, 'utf8').includes('__READONLY_EDIT__'));
    const large = path.join(dir, 'oversize.txt'); fs.writeFileSync(large, 'large text\n'.repeat(1100000));
    const opener = spawn(EXE, [large], { stdio: 'ignore', windowsHide: true }); opener.unref();
    await waitFor(cdp, active(large)); await waitFor(cdp, `!!document.querySelector('.tv-row')`, 60000); check('超编辑上限降级流式查看', true);
    const broken = path.join(dir, 'broken.pdf'); fs.writeFileSync(broken, '%PDF-invalid');
    const bad = spawn(EXE, [broken], { stdio: 'ignore', windowsHide: true }); bad.unref();
    await waitFor(cdp, active(broken)); await waitFor(cdp, `!!document.querySelector('.pdf-err')`, 60000); check('损坏 PDF 显示错误及回退', true);
    await closeAll();
    // CLI 按既有契约过滤不存在路径；从最近打开记录重开被外部删除的文件。
    fs.unlinkSync(empty);
    await pressKey(cdp, 'p', 'KeyP', 80, 10);
    await waitFor(cdp, `!!document.querySelector('.cmd-input')`, 10000);
    await cdp.send('Input.insertText', { text: 'empty.txt' });
    await waitFor(cdp, `[...document.querySelectorAll('.cmd-item')].some(el=>el.textContent.includes('empty.txt'))`, 10000);
    await cdp.evaluate(`[...document.querySelectorAll('.cmd-item')].find(el=>el.textContent.includes('empty.txt')).click()`);
    await waitFor(cdp, `!!document.querySelector('.ov-mask')`, 30000);
    check('不存在路径错误可见且不留空标签', await cdp.evaluate(`document.querySelectorAll('.tab').length===0`));
    await dismissOverlay(cdp);
  }
  report.verdict = report.checks.length > 0 && report.checks.every(item => item.pass);
} catch (error) {
  report.errors.push(String(error.stack ?? error));
  if (cdp) report.debug = await cdp.evaluate(`({body:document.body.innerText.slice(-6000),active:document.activeElement?.tagName,keys:window.__releaseKeys,tabs:[...document.querySelectorAll('.tab')].map(e=>e.title)})`).catch(String);
}
finally { cdp?.close(); await killTree(child.pid); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ verdict: report.verdict, checks: report.checks.length, errors: report.errors })); process.exitCode = report.verdict ? 0 : 1;
