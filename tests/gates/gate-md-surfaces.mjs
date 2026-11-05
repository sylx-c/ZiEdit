// Markdown 三个渲染面：原生输入、滚动全过程、停手漂移与右轨一致性。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EXE, RUN_DIR, connectCDP, waitTargets, waitFor, switchMdMode, dismissOverlay, killTree,
  INIT_OBSERVERS, RAF_SAMPLER, percentile, setNativeWindowSize } from './gate-lib.mjs';

const corpus = path.resolve(process.argv[2] ?? path.join(RUN_DIR, 'corpus/mixed-100k.md'));
const output = path.resolve(process.argv[3] ?? path.join(RUN_DIR, 'results/md-surfaces.json'));
const singleBlock = /^single-(?:code|js|table)-/.test(path.basename(corpus));
const modes = [
  ['preview', '渲染预览', '.md-preview:not(.md-split-preview) .md-col'],
  ['split', '分屏预览', '.md-split-preview .md-col'],
  ['ir', '即时渲染', '.md-ir:not(.md-ir-loading) .cm-scroller'],
].filter(([mode]) => fs.statSync(corpus).size <= 2 * 1024 * 1024 || mode === 'ir');
fs.mkdirSync(path.dirname(output), { recursive: true });
const out = { verdict: false, exe: EXE, sha256: crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex'),
  corpus, bytes: fs.statSync(corpus).size, modes: [], errors: [] };
const save = () => fs.writeFileSync(output, JSON.stringify(out, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const selector = `document.querySelector('.md-split-preview') ?? document.querySelector('.md-ir:not(.md-ir-loading) .cm-scroller') ?? document.querySelector('.md-preview')`;
const reloadToken = crypto.randomUUID();
const child = spawn(EXE, [corpus], { stdio: 'ignore', windowsHide: true,
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: process.env.ZIEDIT_GATE_PROFILE_ROOT ? path.join(process.env.ZIEDIT_GATE_PROFILE_ROOT, 'surfaces-' + path.basename(corpus)) : path.join(RUN_DIR, 'profiles/md-surfaces-' + reloadToken) } });
let cdp;
try {
  cdp = await connectCDP((await waitTargets(60000)).webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_OBSERVERS + RAF_SAMPLER + `
    window.__mdReloadToken = ${JSON.stringify(reloadToken)};
    window.__mdOpenStart = performance.now(); window.__mdFirstReadable = null; window.__mdReadableDom = null;
    window.__mdReadableObserver = new MutationObserver(() => { // 保留引用：大文档长任务期间无引用观测器可能被 GC，导致首屏观测丢失
      if (window.__mdReadableDom == null && document.querySelector('.md-col p,.md-col pre,.md-col table,.md-ir:not(.md-ir-loading) .cm-line')) {
        window.__mdReadableDom = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => window.__mdFirstReadable = performance.now()));
      }
    }).observe(document, { childList:true, subtree:true, attributes:true, attributeFilter:['class'] }); // 仅移除 md-ir-loading class 的完成路径也要触发首屏评估
  ` });
  await waitFor(cdp, `!!document.querySelector('.md-col,.md-ir:not(.md-ir-loading) .cm-line')`, 180000);
  await dismissOverlay(cdp);
  if (!await waitFor(cdp, `document.querySelector('.tab.active')?.title.split('\\n')[0].toLowerCase() === ${JSON.stringify(corpus.toLowerCase())}`, 180000)) throw new Error('requested corpus not active');
  if (fs.statSync(corpus).size <= 2 * 1024 * 1024 && !await cdp.evaluate(`!!document.querySelector('.md-preview:not(.md-split-preview) .md-col')`)) {
    await switchMdMode(cdp, '渲染预览');
    if (!await waitFor(cdp, `!!document.querySelector('.md-preview:not(.md-split-preview) .md-col')`, 180000)) throw new Error('initial preview not mounted');
  }
  await setNativeWindowSize(child.pid,1296,841);
  // 重载从页面启动开始采样，保留同一个已打开文件；库与正文状态重新初始化。
  await sleep(600);
  await cdp.evaluate('window.__mdReloadToken = null');
  await cdp.send('Page.reload');
  if (!await waitFor(cdp, `window.__mdReloadToken === ${JSON.stringify(reloadToken)} && typeof window.__mdFirstReadable === 'number' && !!document.querySelector('.md-col p,.md-col pre,.md-col table,.md-ir:not(.md-ir-loading) .cm-line')`, 180000)) throw new Error('reloaded document not readable');
  await dismissOverlay(cdp);
  out.firstReadableMs = await cdp.evaluate('window.__mdFirstReadable - window.__mdOpenStart');
  out.firstReadableDomMs = await cdp.evaluate('window.__mdReadableDom - window.__mdOpenStart');
  out.openLongtasks = await cdp.evaluate('window.__gate.longtasks');
  out.environment = await cdp.evaluate(`({ userAgent:navigator.userAgent, scale:devicePixelRatio, width:innerWidth, height:innerHeight,
    gpu:(() => { const gl=document.createElement('canvas').getContext('webgl'); const ext=gl?.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null; })() })`);
  for (const [mode, label, signature] of modes) {
    const record = { mode, failures: [], mountStarted:await cdp.evaluate('performance.now()') }; out.modes.push(record); save();
    if (process.env.ZIEDIT_MD_PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
    let timeline;
    if (process.env.ZIEDIT_MD_TIMELINE && (mode === 'ir' || process.env.ZIEDIT_MD_TIMELINE === 'all')) {
      timeline = new Promise(resolve => {
        const off = cdp.on('Tracing.tracingComplete', event => { off(); resolve(event.stream); });
      });
      await cdp.send('Tracing.start', { categories:'devtools.timeline,v8,disabled-by-default-v8.gc', transferMode:'ReturnAsStream' });
    }
    if (!await cdp.evaluate(`!!document.querySelector(${JSON.stringify(signature)})`)) await switchMdMode(cdp, label);
    if (!await waitFor(cdp, `!!document.querySelector(${JSON.stringify(signature)})`, 180000)) throw new Error('mode not mounted: ' + mode);


    // 从首次挂载起保留任务记录；交互采样不预先等待“停稳”。
    await cdp.evaluate(`(() => {
      const sc = ${selector}; sc.scrollTop = 0;
      window.__gate.longtasks = []; window.__mdWheel = null; window.__mdResponses = []; window.__mdResponseEvents = []; window.__mdScrollWrites = []; window.__mdNativeScrolls = [];
      // CM 会先派发布局锚定的 scroll，再提交原生 wheel。不能把程序回声当输入响应。
      const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      let written = sc.scrollTop, programEchoes = 0, nativeCommits = 0, setterCommits = 0;
      const committed = (top, eventAt) => {
        if (Math.abs(top-written) < .01 || window.__mdWheel == null) return;
        nativeCommits++;
        const inputAt = window.__mdWheel; window.__mdWheel = null;
        const observedAt = performance.now();
        window.__mdResponses.push(observedAt - inputAt);
        // 保留事件产生与处理时刻以定位边界延迟；通过判定仍使用原来的观察响应。
        window.__mdResponseEvents.push({inputAt, observedAt, eventAt, top});
        // CM 可能在原生 scroll 事件送达前读取新位置并补偿布局；先识别原生变化，
        // 本轮补偿完成后再建立视觉基线，不能让 setter 把原生提交一并抹掉。
        queueMicrotask(() => sc.dispatchEvent(new CustomEvent('gate-native-wheel-commit',{detail:inputAt})));
        return true;
      };
      Object.defineProperty(sc, 'scrollTop', {configurable:true,
        get() { return native.get.call(this); },
        set(value) {
          const before = native.get.call(this);
          if(committed(before)) setterCommits++;
          if (${!!process.env.ZIEDIT_MD_TRACE} && Math.abs(value-before)>.5) window.__mdScrollWrites.push({at:performance.now(),before,value,stack:new Error().stack});
          native.set.call(this,value); written = native.get.call(this);
        }
      });
      sc.addEventListener('wheel', e => { committed(native.get.call(sc)); window.__mdWheel = e.timeStamp; }, {passive:true,capture:true});
      sc.addEventListener('scroll', event => {
        const top = native.get.call(sc);
        if (Math.abs(top-written) < .01) { programEchoes++; return; }
        if (${!!process.env.ZIEDIT_MD_TRACE}) window.__mdNativeScrolls.push({at:performance.now(),eventAt:event.timeStamp,before:written,top,inputAt:window.__mdWheel});
        committed(top, event.timeStamp); written = top;
      }, {passive:true});
      window.__mdWheelMetrics = () => ({programEchoes,nativeCommits,setterCommits});
      window.__mdInteractionStarted = performance.now(); window.__rafStart();
    })()`);
    // 在最后一笔输入之前安装量具，从真正的原生提交开始留存阅读内容。
    await cdp.evaluate(`window.__mdObserveStop = (sc, inputAt) => new Promise(resolve => {
      const base = sc.getBoundingClientRect();
      const hit = document.elementFromPoint(base.left + Math.min(70, base.width/3), base.top + 15);
      let node = hit?.closest('.cm-line,p,h1,h2,h3,.md-code-chunk,td,th,pre,table,.mdir-tablebox,.md-render-target,.md-block');
      const gap = node?.matches('.cm-line') && !node.textContent.trim() ? node : null;
      if (gap) node = [...sc.querySelectorAll('.cm-line')].find(line => line.textContent.trim() && line.getBoundingClientRect().bottom > base.top + 15) ?? node;
      const initial = node?.getBoundingClientRect().top, top = sc.scrollTop, height = sc.scrollHeight;
      let maxDrift = 0, lost = false, frames = 0; const started = performance.now(), firstSampleDelayMs = started-inputAt;
      let asyncComplete = false, completionCheckedAt = -Infinity;
      const complete = now => {
        if (now-completionCheckedAt < 100) return asyncComplete;
        completionCheckedAt = now;
        const col=sc.querySelector('.md-col');
        asyncComplete=(!col || !col.hasAttribute('data-render-complete') || col.dataset.renderComplete==='1')
          && !sc.querySelector('.md-render-target[data-render-state="loading"]:not([data-render-pending])')
          && [...sc.querySelectorAll('img')].every(image=>image.complete);
        return asyncComplete;
      };
      const trace = [];
      let previousY;
      const tick = () => {
        frames++; if (node && !node.isConnected) lost = true;
        if (node?.isConnected) maxDrift = Math.max(maxDrift, Math.abs(node.getBoundingClientRect().top - initial));
        if (${!!process.env.ZIEDIT_MD_TRACE}) {
          const y = node?.getBoundingClientRect().top;
          const neighborhood = [];
          if (y !== previousY) for (let el = node, i = 0; el && i < 10; el = el.previousElementSibling, i++) {
            const rect = el.getBoundingClientRect();
            neighborhood.push({text:el.textContent?.slice(0,100),class:el.className,style:el.getAttribute('style'),y:rect.top,height:rect.height});
          }
          previousY = y;
          trace.push({t:performance.now()-inputAt,top:sc.scrollTop,height:sc.scrollHeight,y,gap:gap?.getBoundingClientRect().top,
            text:node?.textContent?.slice(0,120),previous:node?.previousElementSibling?.textContent?.slice(0,120),previousHeight:node?.previousElementSibling?.getBoundingClientRect().height,
            neighborhood});
        }
        const elapsed=performance.now()-started;
        if (elapsed < 1500 || !complete(performance.now()) && elapsed < 30000) requestAnimationFrame(tick);
        else resolve({ maxDrift, lost:lost || !node, frames, firstSampleDelayMs, observedAfterInputMs:performance.now()-inputAt,
          asyncComplete,
          topDelta:sc.scrollTop-top, heightDelta:sc.scrollHeight-height, node:node?.tagName, text:node?.textContent?.slice(0,120),
          initial, final:node?.getBoundingClientRect().top, trace });
      }; requestAnimationFrame(tick);
    })`);
    const point = await cdp.evaluate(`(() => { const r = (${selector}).getBoundingClientRect(); return {x:r.left+r.width*.45,y:r.top+r.height*.45}; })()`);
    // 最后一笔使用独特增量，避免延迟送达的倒数第二个 wheel 抢走观察器。
    const deltas = [...Array(18).fill(160), ...Array(8).fill(-160), -161];
    for (const [index, deltaY] of deltas.entries()) {
      if (index === deltas.length-1) await cdp.evaluate(`void (window.__mdStop = new Promise(resolve => {
        const sc = ${selector}; sc.addEventListener('wheel', function input(event) {
          if (event.deltaY !== ${deltaY}) return;
          sc.removeEventListener('wheel',input);
          sc.addEventListener('gate-native-wheel-commit', function committed(commit) {
            if (commit.detail !== event.timeStamp) return;
            sc.removeEventListener('gate-native-wheel-commit',committed);
            clearTimeout(commitTimeout);
            window.__mdObserveStop(sc,event.timeStamp).then(resolve);
          });
        });
        const commitTimeout = setTimeout(() => resolve({lost:true,maxDrift:0,reason:'last wheel did not commit'}), 5000);
      }))`);
      await cdp.send('Input.dispatchMouseEvent', { type:'mouseWheel', ...point, deltaX:0, deltaY });
      if (index < deltas.length-1) await sleep(45);
    }
    const interactive = await cdp.evaluate('window.__rafStop()');
    record.interactionFrames = { p95:percentile([...interactive].sort((a,b)=>a-b),.95), max:Math.max(...interactive), count:interactive.length };
    await cdp.evaluate('window.__rafStart()');
    // 紧接最后输入采集 1.5 秒，禁止先等 stable 再开始。
    record.settle = await cdp.evaluate('window.__mdStop');
    const frames = await cdp.evaluate('window.__rafStop()');
    if (process.env.ZIEDIT_MD_PROFILE) {
      const { profile } = await cdp.send('Profiler.stop');
      fs.writeFileSync(output + '.' + mode + '.cpuprofile', JSON.stringify(profile));
    }
    if (timeline) {
      await cdp.send('Tracing.end');
      const handle = await timeline, chunks = [];
      for (;;) { const chunk = await cdp.send('IO.read', { handle }); chunks.push(chunk.data); if (chunk.eof) break; }
      await cdp.send('IO.close', { handle });
      fs.writeFileSync(output + '.' + mode + '.trace.json', chunks.join(''));
    }
    record.frames = { p95: percentile([...frames].sort((a,b) => a-b), .95), max:Math.max(...frames), count:frames.length };
    record.longtasks = await cdp.evaluate('window.__gate.longtasks');
    record.interactionStarted = await cdp.evaluate('window.__mdInteractionStarted');
    record.mountLongtasks = await cdp.evaluate(`window.__gate.allLongtasks.filter(task => task.start >= ${record.mountStarted} && task.start < window.__mdInteractionStarted)`);
    record.responses = await cdp.evaluate('window.__mdResponses');
    record.responseEvents = await cdp.evaluate('window.__mdResponseEvents');
    record.wheelMetrics = await cdp.evaluate('window.__mdWheelMetrics()');
    if (process.env.ZIEDIT_MD_TRACE) {
      record.scrollWrites = await cdp.evaluate('window.__mdScrollWrites');
      record.nativeScrolls = await cdp.evaluate('window.__mdNativeScrolls');
    }
    record.renderStatus = await cdp.evaluate(`(() => { const col=(${selector}).querySelector('.md-col');
      return col ? {complete:col.dataset.renderComplete,engine:col.className,blocks:col.querySelectorAll('.md-block').length,
        loading:col.querySelectorAll('.md-render-target[data-render-state="loading"]:not([data-render-pending])').length} : null; })()`);
    record.responseP95 = percentile([...record.responses].sort((a,b) => a-b), .95);
    record.rail = await cdp.evaluate(`(() => {
      const map = document.querySelector('.mm-viewport'), thumb = document.querySelector('.vs-thumb');
      const a = map?.getBoundingClientRect(), b = thumb?.getBoundingClientRect();
      const root = document.querySelector('.minimap'), rail = root?.getBoundingClientRect();
      const last = root?.querySelector('.mm-bars')?.lastElementChild?.getBoundingClientRect();
      return a && b && rail && last ? {topError:Math.abs(a.top-b.top),heightError:Math.abs(a.height-b.height),
        clippedTail:Math.max(0,last.bottom-(rail.bottom-10))} : null;
    })()`);
    if (record.frames.p95 > 32) record.failures.push('frame p95 > 32ms');
    if (record.interactionFrames.p95 > 32) record.failures.push('interaction frame p95 > 32ms');
    if (record.responseP95 > 50) record.failures.push('wheel response p95 > 50ms');
    if (record.longtasks.some(task => task.dur >= 100)) record.failures.push('main-thread longtask >= 100ms');
    if (singleBlock && record.mountLongtasks.some(task => task.dur >= 100)) record.failures.push('single-block mount longtask >= 100ms');
    if (record.settle.maxDrift > 4 || record.settle.lost) record.failures.push('reading anchor moved/lost after last input');
    if (!record.settle.asyncComplete) record.failures.push('asynchronous rendering did not finish within observation limit');
    if (!record.rail || record.rail.topError > 1 || record.rail.heightError > 1) record.failures.push('map and scrollbar disagree');
    if (record.rail?.clippedTail > 1) record.failures.push('map tail stripes clipped');
    if (mode !== 'ir' && path.basename(corpus) === 'single-js-1m.md') {
      record.codeHighlight = await cdp.evaluate(`(() => {
        const code=document.querySelector('.md-col pre > code');
        return {keyword:code?.querySelector('.hljs-keyword')?.textContent,string:code?.querySelector('.hljs-string')?.textContent};
      })()`);
      if (record.codeHighlight.keyword !== 'const' || record.codeHighlight.string !== '"中文<&😀"') record.failures.push('large code highlighting lost');
    }
    if (mode === 'preview' && path.basename(corpus) === 'single-code-1m.md') {
      await waitFor(cdp, `!!document.querySelector('.md-col[data-render-complete="1"]')`, 180000);
      const png = await cdp.send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(output + '.png',Buffer.from(png.data,'base64'));
    }
    if (process.env.ZIEDIT_MD_SCREENSHOTS) {
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(output + '.' + mode + '.png', Buffer.from(png.data, 'base64'));
    }
    save();
  }
  out.errors = await cdp.evaluate('window.__gate.errors');
  out.allLongtasks = await cdp.evaluate('window.__gate.allLongtasks');
  out.verdict = out.modes.length === modes.length && out.modes.every(mode => !mode.failures.length) && !out.errors.length;
  if (path.basename(corpus) === 'plain-1m.md' && out.firstReadableMs > 500) { out.errors.push('1MiB plain first readable > 500ms'); out.verdict = false; }
  if (singleBlock && out.openLongtasks.some(task => task.dur >= 100)) { out.errors.push('single-block open longtask >= 100ms'); out.verdict = false; }
} catch (error) { out.errors.push(String(error.stack ?? error)); }
finally { cdp?.close(); await killTree(child.pid); save(); }
console.log(JSON.stringify({ verdict:out.verdict, firstReadableMs:out.firstReadableMs,
  modes:out.modes.map(mode => ({ mode:mode.mode, frames:mode.interactionFrames, responseP95:mode.responseP95, settle:mode.settle, rail:mode.rail, failures:mode.failures })), errors:out.errors }));
process.exitCode = out.verdict ? 0 : 1;
