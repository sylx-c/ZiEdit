// gate-scroll-position.mjs — 真机滚动位置回归门（2026-10-30 滚动整改）
// 锁四件事（jsdom 无布局测不出，必须真 WebView2）：
//   A 形态往返保位：渲染预览 → 源码 → 即时渲染 → 渲染预览，视口顶源码行不漂（修前按像素还原，三形态行高不同）
//   B 切标签保位：同形态切走再切回，源码面像素级还原、预览面行级还原（修前预览面切回即回顶）
//   C 缩略图只导航：软换行关 + 横向已滚动时点击地图，横向位置与光标都不变（修前光标被设到行首、横向回第 0 列）
//   D 渲染地图、视口框和滑块共用当前排版高度，顶底边界一致。
// 用法: node tests/gates/gate-scroll-position.mjs   （先 prepare-gate-build.mjs --build，经 Tauri CLI 构建；仅 Windows）
// 结果: RUN_DIR/results/gate-scroll-position.json；全部判据通过退出码 0
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RUN_DIR, EXE, waitTargets, connectCDP, waitMounted, killTree, sleep, clickXY, waitFor, dismissOverlay, switchMdMode as switchMode } from './gate-lib.mjs';

const corpusDir = path.join(RUN_DIR, 'corpus');
const mdCorpus = path.join(corpusDir, 'mixed-100k.md');
if (!fs.existsSync(mdCorpus)) { console.error('缺语料 ' + mdCorpus + '（gen-corpus.mjs 生成）'); process.exit(1); }
const sideMd = path.join(corpusDir, 'note-small.md');
if (!fs.existsSync(sideMd)) fs.writeFileSync(sideMd, '# note\n\nsmall side file\n');
// 长行纯文本：软换行关时产生横向滚动（C 判据）
const wideTxt = path.join(corpusDir, 'wide-lines.txt');
if (!fs.existsSync(wideTxt)) {
  fs.writeFileSync(wideTxt, Array.from({ length: 1200 }, (_, i) => `${String(i + 1).padStart(5, '0')} ` + 'abcdefghij'.repeat(40)).join('\n') + '\n');
}
const outFile = path.join(RUN_DIR, 'results', 'gate-scroll-position.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const webviewDir = process.env.ZIEDIT_GATE_PROFILE_ROOT ? path.join(process.env.ZIEDIT_GATE_PROFILE_ROOT,'position') : path.join(RUN_DIR, 'profiles', 'scroll-position');
// 发布冷/热验收禁止清理共享 profile；普通诊断也采用新目录以保留失败证据。

const out = { exe: EXE, corpus: mdCorpus, started: new Date().toISOString(), checks: [] };
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
const check = (name, pass, detail) => { out.checks.push({ name, pass, ...detail }); save(); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`); };

const WAIT_STABLE = `new Promise(resolve => { const t0 = performance.now(); let streak = 0, last = t0;
  const tick = t => { streak = t - last < 32 ? streak + 1 : 0; last = t; if (streak >= 12 || t - t0 > 1500) return resolve(1); requestAnimationFrame(tick); };
  requestAnimationFrame(tick); })`;

// 页内量具（独立于被测实现）：可见编辑面 / 预览面的视口顶源码行（1 起，块内按像素插值）
const PROBE = `window.__pos = {
  visibleCm() { return [...document.querySelectorAll('.cm-content')].find(e => e.offsetParent !== null)?.cmTile?.view ?? null; },
  preview() { return [...document.querySelectorAll('.md-preview')].find(e => e.offsetParent !== null && !e.closest('.md-split')) ?? null; },
  cmTop(v) { const h = v.scrollDOM.getBoundingClientRect().top - v.documentTop; const b = v.lineBlockAtHeight(Math.max(0, h));
    const a = v.state.doc.lineAt(b.from).number, z = v.state.doc.lineAt(Math.max(b.from, b.to)).number;
    return a + (b.height > 0 ? Math.min(1, Math.max(0, (h - b.top) / b.height)) : 0) * (z - a + 1); },
  previewTop(s) { const rect=s.getBoundingClientRect(), y=s.scrollTop;
    const at=nodes=>{let lo=0,hi=nodes.length;while(lo+1<hi){const mid=(lo+hi)>>>1;if(nodes[mid].getBoundingClientRect().top<=rect.top+2)lo=mid;else hi=mid;}return nodes[lo]};
    const root=s.querySelector('.md-col'),outer=at([...root.children].filter(e=>!e.hidden));
    const hit=outer?.classList.contains('md-reading-page')?at([...outer.children].filter(e=>!e.hidden)):outer;
    const top=hit?hit.getBoundingClientRect().top-rect.top+y:0;
    return hit ? +hit.dataset.line + 1 + Math.min(1,Math.max(0,(y-top)/Math.max(1,hit.offsetHeight))) * (+hit.dataset.endLine - +hit.dataset.line) : null; },
  top() { const p = this.preview(); if (p) return { surface: 'preview', line: this.previewTop(p), px: p.scrollTop };
    const v = this.visibleCm(); return v ? { surface: v.dom.closest('.md-ir') ? 'ir' : 'source', line: this.cmTop(v), px: v.scrollDOM.scrollTop, left: v.scrollDOM.scrollLeft, head: v.state.selection.main.head, lines: v.state.doc.lines } : null; },
};`;

async function settle(cdp, ms = 1200) { await sleep(ms); await cdp.evaluate(WAIT_STABLE); }
// 只认可见的面：切标签暂存的视图仍在 DOM 里（宿主 hidden）
const SURFACE = {
  preview: "!!window.__pos.preview()",
  source: "!!window.__pos.visibleCm() && !window.__pos.visibleCm().dom.closest('.md-ir') && !window.__pos.preview() && !document.querySelector('.md-split')",
  ir: "!!window.__pos.visibleCm()?.dom.closest('.md-ir')",
};
const tabAt = file => `[...document.querySelectorAll('.tab')].find(t => t.title.split('\\n')[0].toLowerCase() === ${JSON.stringify(file.toLowerCase())})`;
async function clickTab(cdp, file) {
  const r = await cdp.evaluate(`(() => { const el = ${tabAt(file)}; if (!el) return null; el.scrollIntoView({block:'nearest',inline:'center'}); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!r) throw new Error('tab not found: ' + file);
  await clickXY(cdp, r.x, r.y);
  await waitFor(cdp, `${tabAt(file)}?.classList.contains('active')`);
}
function openInRunning(file) {
  const c = spawn(EXE, [file], { detached: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: webviewDir } });
  c.unref();
}

(async () => {
  // 不按进程名清场：门禁 exe 与正式安装同名 ziedit.exe，按名杀会误伤用户正在用的 ZiEdit
  const child = spawn(EXE, [mdCorpus], { detached: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: webviewDir } });
  child.unref();
  let cdp;
  try {
    const target = await waitTargets(30000);
    cdp = await connectCDP(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await waitMounted(cdp);
    await sleep(2500);
    if (!(await dismissOverlay(cdp))) throw new Error('welcome/overlay modal not dismissible (fail-closed)');
    await cdp.evaluate(PROBE);
    // 会话可能记着上轮的形态：不是渲染预览就先切过去
    if (!(await cdp.evaluate(SURFACE.preview))) await switchMode(cdp, '渲染预览');
    await waitFor(cdp, SURFACE.preview);
    await settle(cdp, 2000);

    // ── A 形态往返保位 ──
    await cdp.evaluate(`(() => { const p = window.__pos.preview(); p.scrollTop = p.scrollHeight * 0.45; })()`);
    await settle(cdp, 1500);
    const a0 = await cdp.evaluate('window.__pos.top()');
    const trip = [['源码视图', 'source'], ['即时渲染', 'ir'], ['渲染预览', 'preview']];
    const seen = [a0];
    for (const [label, surface] of trip) {
      await switchMode(cdp, label);
      await waitFor(cdp, SURFACE[surface]);
      await settle(cdp, 2000);
      seen.push(await cdp.evaluate('window.__pos.top()'));
    }
    // 表格进入高度图后也应保持块内源码位置；允许不足一行的测量误差。
    for (let i = 1; i < seen.length; i++) {
      const drift = Math.abs(seen[i].line - a0.line);
      check(`A 形态往返 ${seen[i - 1].surface}→${seen[i].surface}`, drift <= 1, { fromLine: +a0.line.toFixed(2), line: +seen[i].line.toFixed(2), drift: +drift.toFixed(2) });
    }

    // ── B 切标签保位 ──
    const b0 = await cdp.evaluate('window.__pos.top()');
    const visualBefore = await cdp.evaluate(`(() => { const p=window.__pos.preview(),r=p.getBoundingClientRect();
      const block=document.elementFromPoint(r.left+70,r.top+24)?.closest('.md-block');
      const text=block?.querySelector('p,h1,h2,h3,h4,h5,h6,pre,table')??block;
      return block&&text?{id:block.dataset.blockId,line:block.dataset.line,text:text.textContent,y:text.getBoundingClientRect().top-r.top}:null; })()`);
    openInRunning(sideMd);
    await waitFor(cdp, `${tabAt(sideMd)}?.classList.contains('active')`);
    await settle(cdp, 800);
    await cdp.evaluate(PROBE);
    await clickTab(cdp, mdCorpus);
    await waitFor(cdp, SURFACE.preview);
    await settle(cdp, 2000);
    const b1 = await cdp.evaluate('window.__pos.top()');
    const visualAfter = await cdp.evaluate(`(() => { const p=window.__pos.preview(),block=p.querySelector('[data-block-id="${visualBefore?.id}"]');
      const text=block?.querySelector('p,h1,h2,h3,h4,h5,h6,pre,table')??block;
      return text?{text:text.textContent,y:text.getBoundingClientRect().top-p.getBoundingClientRect().top}:null; })()`);
    check('B 切标签回来（渲染预览）', Math.abs(b1.line - b0.line) <= 1.5, { before: +b0.line.toFixed(2), after: +b1.line.toFixed(2), pxBefore: b0.px, pxAfter: b1.px,
      visualBefore,visualAfter,visualDrift:visualBefore&&visualAfter?Math.abs(visualAfter.y-visualBefore.y):null });

    // 原缺陷落在标题上边距，前面还有延迟失败的图片，必须单独覆盖这个边界。
    const headingKey = await cdp.evaluate(`(() => { const p=window.__pos.preview(),head=p.querySelector('h2[data-line="1532"]')??p.querySelector('h2,h1');
      const block=head?.closest('.md-block'); if(!block)return null;
      p.scrollTop+=block.getBoundingClientRect().top-p.getBoundingClientRect().top+2;
      return block.dataset.blockId; })()`);
    if (headingKey) {
      await settle(cdp,400);
      const headingY = () => cdp.evaluate(`(() => { const p=window.__pos.preview(),h=p.querySelector('[data-block-id="${headingKey}"] h2,[data-block-id="${headingKey}"] h1');
        return h?h.getBoundingClientRect().top-p.getBoundingClientRect().top:null; })()`);
      const before=await headingY(); await clickTab(cdp,sideMd); await settle(cdp,600);
      await clickTab(cdp,mdCorpus); await settle(cdp,2000); const after=await headingY();
      check('B 标题边距切标签保位',before!=null&&after!=null&&Math.abs(after-before)<=4,{before,after,drift:Math.abs(after-before)});
    }

    await switchMode(cdp, '源码视图');
    await waitFor(cdp, SURFACE.source);
    await settle(cdp);
    await cdp.evaluate(`(() => { const v = window.__pos.visibleCm(); v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight * 0.3; })()`);
    await settle(cdp);
    const s0 = await cdp.evaluate('window.__pos.top()');
    await clickTab(cdp, sideMd);
    await settle(cdp, 800);
    await clickTab(cdp, mdCorpus);
    await waitFor(cdp, SURFACE.source);
    await settle(cdp, 1500);
    const s1 = await cdp.evaluate('window.__pos.top()');
    check('B 切标签回来（源码，像素级快照）', Math.abs(s1.px - s0.px) <= 2, { pxBefore: s0.px, pxAfter: s1.px, lineBefore: +s0.line.toFixed(2), lineAfter: +s1.line.toFixed(2) });

    // ── D 缩略图视口框与条纹同坐标（即时渲染） ──
    await switchMode(cdp, '即时渲染');
    await waitFor(cdp, SURFACE.ir);
    await settle(cdp, 2000);
    const d = await cdp.evaluate(`(() => { const v = window.__pos.visibleCm(); const box = document.querySelector('.editor-rail .mm-viewport'); const mm = document.querySelector('.editor-rail .minimap');
      if (!box || !mm || mm.offsetParent === null) return null;
      const rail = document.querySelector('.editor-rail .vscroll').clientHeight || mm.clientHeight; const inset = document.querySelector('.editor-rail').classList.contains('no-ruler') ? 10 : 29;
      const inner = Math.max(40, rail - inset - 10), sc=v.scrollDOM, h=Math.max(18,sc.clientHeight/sc.scrollHeight*inner);
      const expected=inset+sc.scrollTop/Math.max(1,sc.scrollHeight-sc.clientHeight)*(inner-h);
      const thumb=document.querySelector('.editor-rail .vs-thumb');
      return { boxTop:box.offsetTop,expected,boxHeight:box.offsetHeight,height:h,thumbTop:thumb.offsetTop,thumbHeight:thumb.offsetHeight }; })()`);
    if (d) check('D 即时渲染地图与滑块按同一排版几何', Math.abs(d.boxTop-d.expected)<=2 && Math.abs(d.boxHeight-d.height)<=2 && Math.abs(d.boxTop-d.thumbTop)<=1 && Math.abs(d.boxHeight-d.thumbHeight)<=1, d);
    else check('D 即时渲染地图与滑块按同一排版几何', false, { reason: 'minimap hidden or missing' });

    // ── F 切标签复用视图（即时渲染）：切走再切回是同一份 DOM（不重建不重渲染），位置不变，切回即可见 ──
    const f0 = await cdp.evaluate(`(() => { const v = window.__pos.visibleCm(); v.dom.dataset.gateMark = 'keep'; return window.__pos.top(); })()`);
    await clickTab(cdp, sideMd);
    await settle(cdp, 600);
    await cdp.evaluate(PROBE);
    const tClick = await cdp.evaluate('performance.now()');
    await clickTab(cdp, mdCorpus);
    const shownAfter = await cdp.evaluate(`new Promise(resolve => { const t0 = ${tClick}; const tick = () => {
      const v = [...document.querySelectorAll('.md-ir:not(.md-ir-loading) .cm-content')].find(e => e.offsetParent !== null)?.cmTile?.view;
      if (v) resolve(Math.round(performance.now() - t0)); else if (performance.now() - t0 > 5000) resolve(-1); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick); })`);
    await settle(cdp, 800);
    const f1 = await cdp.evaluate(`(() => { const v = window.__pos.visibleCm(); return { reused: v?.dom.dataset.gateMark === 'keep', top: window.__pos.top() }; })()`);
    check('F 切标签复用即时渲染视图', f1.reused && shownAfter >= 0 && shownAfter < 200 && Math.abs(f1.top.line - f0.line) <= 0.5,
      { reused: f1.reused, visibleAfterMs: shownAfter, lineBefore: +f0.line.toFixed(2), lineAfter: +f1.top.line.toFixed(2) });

    // ── C 缩略图只导航（纯文本、软换行关、横向已滚动） ──
    openInRunning(wideTxt);
    await waitFor(cdp, `${tabAt(wideTxt)}?.classList.contains('active')`);
    await cdp.evaluate(PROBE);
    await waitFor(cdp, SURFACE.source);
    await settle(cdp, 1500);
    const c0 = await cdp.evaluate(`(() => { const v = window.__pos.visibleCm(); v.dispatch({ selection: { anchor: v.state.doc.line(3).from + 5 } });
      v.scrollDOM.scrollLeft = 300; return { left: v.scrollDOM.scrollLeft, overflow: v.scrollDOM.scrollWidth > v.scrollDOM.clientWidth + 10, head: v.state.selection.main.head }; })()`);
    await settle(cdp, 400);
    if (!c0.overflow) check('C 缩略图点击不动横向/光标', false, { reason: '软换行开启或无横向溢出，前置条件不成立', ...c0 });
    else {
      const mm = await cdp.evaluate(`(() => { const m = document.querySelector('.editor-rail .minimap'); if (!m || m.offsetParent === null) return null; const r = m.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.7 }; })()`);
      if (!mm) check('C 缩略图点击不动横向/光标', false, { reason: 'minimap hidden' });
      else {
        await clickXY(cdp, mm.x, mm.y);
        await settle(cdp, 800);
        const c1 = await cdp.evaluate('window.__pos.top()');
        check('C 缩略图点击不动横向/光标', c1.left === c0.left && c1.head === c0.head && c1.line > 600,
          { leftBefore: c0.left, leftAfter: c1.left, headBefore: c0.head, headAfter: c1.head, topLineAfter: +c1.line.toFixed(1) });
      }
    }
    out.errors = await cdp.evaluate('window.__gate?.errors ?? []').catch(() => []);
  } catch (err) {
    out.fatal = String(err?.stack ?? err);
    console.error(out.fatal);
  } finally {
    out.verdict = !out.fatal && out.checks.length > 0 && out.checks.every(c => c.pass);
    save();
    try { cdp?.close(); } catch {}
    await killTree(child.pid);
    console.log(`verdict: ${out.verdict ? 'PASS' : 'FAIL'} → ${outFile}`);
    process.exit(out.verdict ? 0 : 1);
  }
})();
