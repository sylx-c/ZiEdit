// 原生生命周期门：首批正文出现后立即输入或切换模式，验证迟到任务不会覆盖用户意图。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EXE, RUN_DIR, waitTargets, connectCDP, waitFor, switchMdMode, dismissOverlay, killTree, sleep, clickXY } from './gate-lib.mjs';

const corpus = path.resolve(process.argv[2] ?? path.join(RUN_DIR, 'corpus/dense-2m.md'));
const output = path.resolve(process.argv[3] ?? path.join(RUN_DIR, 'results/md-early-input.json'));
fs.mkdirSync(path.dirname(output), { recursive: true });
const out = { verdict: false, exe: EXE, sha256: crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex'), corpus, checks: [], errors: [] };
const save = () => fs.writeFileSync(output, JSON.stringify(out, null, 2));
const check = (name, pass, detail) => { out.checks.push({ name, pass, ...detail }); save(); console.log(JSON.stringify(out.checks.at(-1))); };
const child = spawn(EXE, [corpus], { stdio: 'ignore', windowsHide: true,
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: process.env.ZIEDIT_GATE_PROFILE_ROOT ? path.join(process.env.ZIEDIT_GATE_PROFILE_ROOT,'early-input') : path.join(RUN_DIR, 'profiles/md-early-' + crypto.randomUUID()) } });
let cdp, stage = '连接页面';
try {
  cdp = await connectCDP((await waitTargets(60000)).webSocketDebuggerUrl);
  stage = '等待语料打开';
  await waitFor(cdp, `document.querySelector('.tab.active')?.title.split('\\n')[0].toLowerCase() === ${JSON.stringify(corpus.toLowerCase())}`, 180000);
  await dismissOverlay(cdp);
  await cdp.evaluate(`window.__earlyErrors=[];window.addEventListener('error',e=>window.__earlyErrors.push(String(e.message)));`);
  stage = '等待初次完整渲染';
  // 标签标题先于正文挂载更新；此时 Markdown 菜单仍禁用，不能把加载窗口误判为切换失败。
  await waitFor(cdp, `!!document.querySelector('.md-col,.md-ir:not(.md-ir-loading) .cm-line')`, 180000);
  if (!await cdp.evaluate(`!!document.querySelector('.md-preview:not(.md-split-preview) .md-col')`)) await switchMdMode(cdp, '渲染预览');
  await waitFor(cdp, `!!document.querySelector('.md-preview:not(.md-split-preview) .md-col[data-render-complete="1"]')`, 180000);
  stage = '记录原阅读位置';
  const railPoint = await cdp.evaluate(`(()=>{const r=document.querySelector('.minimap').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height*.45}})()`);
  await clickXY(cdp, railPoint.x, railPoint.y);
  await sleep(500);
  const oldPosition = await cdp.evaluate(`document.querySelector('.md-preview:not(.md-split-preview)').scrollTop`);
  stage = '首次切换到源码';
  await switchMdMode(cdp, '源码视图');
  await waitFor(cdp, `!!document.querySelector('.cm-content') && !document.querySelector('.md-preview')`, 180000);
  stage = '首次切回预览';
  await switchMdMode(cdp, '渲染预览');
  await waitFor(cdp, `!!document.querySelector('.md-preview:not(.md-split-preview) .md-col[data-render-complete="0"] .md-block')`, 180000);
  stage = '早期滚动与持续观察';
  const point = await cdp.evaluate(`(()=>{const sc=document.querySelector('.md-preview:not(.md-split-preview)'),r=sc.getBoundingClientRect();
    window.__early={result:null};
    sc.addEventListener('scroll',()=>{
      if(sc.scrollTop<1||window.__early.started)return;
      window.__early.started=true;
      const rect=sc.getBoundingClientRect(),hit=document.elementFromPoint(rect.left+Math.min(70,rect.width/3),rect.top+20);
      const node=hit?.closest('p,h1,h2,h3,.md-code-chunk,td,th,pre,table,.md-block');
      if(!node){window.__early.result={missing:true};return;}
      const top=node.getBoundingClientRect().top,start=performance.now(),scrollTop=sc.scrollTop;let maxDrift=0,lost=false,completedAt;
      const tick=()=>{
        lost ||= !node.isConnected;
        if(node.isConnected)maxDrift=Math.max(maxDrift,Math.abs(node.getBoundingClientRect().top-top));
        const complete=sc.querySelector('.md-col')?.dataset.renderComplete==='1';
        if(complete && completedAt===undefined)completedAt=performance.now();
        if(completedAt!==undefined && performance.now()-completedAt>=1500 || performance.now()-start>170000){
          window.__early.result={maxDrift,lost,scrollTop,finalTop:sc.scrollTop,complete,elapsed:performance.now()-start};return;
        }
        requestAnimationFrame(tick);
      };requestAnimationFrame(tick);
    },{passive:true});return{x:r.left+r.width*.5,y:r.top+r.height*.45}})()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 350 });
  await waitFor(cdp, `!!window.__early.result`, 180000);
  const early = await cdp.evaluate('window.__early.result');
  check('首批加载后用户滚动不会被旧位置恢复覆盖', oldPosition > 1000 && early.complete && !early.lost && !early.missing && early.maxDrift <= 4,
    { oldPosition, ...early });

  stage = '再次切换源码与预览';
  await switchMdMode(cdp, '源码视图');
  await waitFor(cdp, `!!document.querySelector('.cm-content') && !document.querySelector('.md-preview')`, 180000);
  await switchMdMode(cdp, '渲染预览');
  await waitFor(cdp, `!!document.querySelector('.md-preview:not(.md-split-preview) .md-col[data-render-complete="0"] .md-block')`, 180000);
  stage = '观察销毁后的旧正文';
  await cdp.evaluate(`window.__oldReading=document.querySelector('.md-preview:not(.md-split-preview) .md-col')`);
  await switchMdMode(cdp, '源码视图');
  await waitFor(cdp, `!!document.querySelector('.cm-content') && !document.querySelector('.md-preview')`, 180000);
  await cdp.evaluate(`window.__oldMutations=0;window.__oldObserver=new MutationObserver(records=>window.__oldMutations+=records.length);
    window.__oldObserver.observe(window.__oldReading,{childList:true,subtree:true,attributes:true,characterData:true});`);
  await sleep(1800);
  const cleanup = await cdp.evaluate(`(()=>{window.__oldObserver.disconnect();return{connected:window.__oldReading.isConnected,mutations:window.__oldMutations,errors:window.__earlyErrors}})()`);
  check('切换模式后旧正文的异步任务停止', !cleanup.connected && cleanup.mutations === 0 && cleanup.errors.length === 0, cleanup);
  out.verdict = out.checks.every(item => item.pass);
} catch (error) { out.errors.push(stage + ": " + String(error.stack ?? error)); }
finally { cdp?.close(); await killTree(child.pid); save(); }
console.log(JSON.stringify({ verdict: out.verdict, errors: out.errors }));
process.exitCode = out.verdict ? 0 : 1;
