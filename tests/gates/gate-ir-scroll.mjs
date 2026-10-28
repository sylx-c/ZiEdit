// gate-ir-scroll.mjs — IR 面滚动帧时间门禁（补 F 门禁盲区：F 只测分屏几何，不测 IR 滚轮帧）
// 用法: node tests/gates/gate-ir-scroll.mjs <corpus.md> <out.json>
// 口径：CDP 滚轮下扫+上扫（与取证探针同构）。欢迎模态按 gate-batch1-arrow 长按门禁同口径驱散
// （Esc 与遮罩角落点击交替，最多 5 轮），未驱散即 fail-closed。
// 判据（同场对比，刷新率无关）：
// 全文档滚动期 >34ms 帧数 ≤ 去表格基线（.mdir-tablebox{display:none}）+ 2；
// 全文档 rAF p95 ≤ 去表格基线 p95 + 2ms；
// 可滚动却 scrollTop 不动、采样器缺失、语料含表但 IR 没挂出表格、不在 IR 面，一律 FAIL。
// 语料参数化：任意 markdown。含 GFM 分隔行时先把光标放到表前并滚入视口，确认表格件挂上。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RUN_DIR, EXE, PORT, GATE_ENV, GATE_BUDGET, RAF_SAMPLER, connectCDP, waitTargets, waitMounted, killTree, percentile } from './gate-lib.mjs';

const corpusArg = process.argv[2];
const outFileArg = process.argv[3];
if (!corpusArg || !outFileArg || corpusArg.startsWith('--')) {
  console.error('用法: node tests/gates/gate-ir-scroll.mjs <corpus.md> <out.json>');
  process.exit(1);
}
const corpus = path.resolve(corpusArg);
const outFile = path.resolve(outFileArg);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const webviewDir = path.join(RUN_DIR, 'profiles/ir-scroll');
const WHEELS = 24;
const WHEEL_GAP_MS = 70;
const WHEEL_DELTA = 280;
const OVER_MS = 34 * GATE_BUDGET.frameMultiplier;
const FRAME_TOLERANCE = 2;
const P95_TOLERANCE_MS = 2 * GATE_BUDGET.frameMultiplier;

const text = fs.readFileSync(corpus, 'utf8');
const tableSeps = (text.match(/^\|[-\s|]*---/gm) || []).length;
const out = {
  build: { exe: EXE, corpus, corpusBytes: Buffer.byteLength(text, 'utf8'), tableSeps, wheels: WHEELS, wheelDelta: WHEEL_DELTA, overMs: OVER_MS, frameTolerance: FRAME_TOLERANCE, p95ToleranceMs: P95_TOLERANCE_MS, port: PORT, machine: { platform: process.platform, node: process.version } },
  rounds: [],
};
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
Object.assign(out.build, { environment: GATE_ENV, budgets: GATE_BUDGET });

async function dismissWelcome(cdp) {
  // 与 gate-batch1-arrow（方向键长按）同口径：冷 profile 欢迎模态吞键盘，Esc / 遮罩角落点击交替。
  let welcomeGone = false;
  for (let i = 0; i < 5 && !welcomeGone; i++) {
    if (!(await cdp.evaluate("!!document.querySelector('.ov-mask')"))) { welcomeGone = true; break; }
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise(r => setTimeout(r, 300));
    if (!(await cdp.evaluate("!!document.querySelector('.ov-mask')"))) { welcomeGone = true; break; }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 6, y: 6, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 6, y: 6, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 300));
    welcomeGone = !(await cdp.evaluate("!!document.querySelector('.ov-mask')"));
  }
  return welcomeGone;
}

async function sweep(cdp) {
  const point = await cdp.evaluate(`(() => {
    const r = document.querySelector('.cm-scroller').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(200, r.height / 2)) };
  })()`);
  await cdp.evaluate(`(() => {
    const sc = document.querySelector('.cm-scroller');
    window.__gateScroll = { min: sc.scrollTop, max: sc.scrollTop };
    if (!window.__gateScrollOn) {
      window.__gateScrollOn = true;
      sc.addEventListener('scroll', () => {
        const y = sc.scrollTop;
        if (y < window.__gateScroll.min) window.__gateScroll.min = y;
        if (y > window.__gateScroll.max) window.__gateScroll.max = y;
      }, { passive: true });
    }
    return 1;
  })()`);
  await cdp.evaluate('window.__gateFrameEvents = []; window.__gateScrollPhase = "down"; window.__rafStart()');
  const before = await cdp.evaluate('document.querySelector(".cm-scroller").scrollTop');
  for (let i = 0; i < WHEELS; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: WHEEL_DELTA });
    await new Promise(r => setTimeout(r, WHEEL_GAP_MS));
  }
  await cdp.evaluate('window.__gateScrollPhase = "up"');
  for (let i = 0; i < WHEELS; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: -WHEEL_DELTA });
    await new Promise(r => setTimeout(r, WHEEL_GAP_MS));
  }
  await new Promise(r => setTimeout(r, 250));
  const frames = await cdp.evaluate('window.__rafStop()');
  const range = await cdp.evaluate('window.__gateScroll');
  const diagnostics = await cdp.evaluate(`({
    over34Events: window.__gateFrameEvents.filter(f => f.dur > 34),
    over34EventsThresholdMs: 34,
    irPerf: window.__ZIEDIT_IR_PERF_DATA__ ?? null,
    capturedAt: performance.now()
  })`);
  const sorted = [...(frames || [])].sort((a, b) => a - b);
  return {
    point, before,
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    over34: (frames || []).filter(x => x > OVER_MS).length,
    scrollMin: range?.min ?? before,
    scrollMax: range?.max ?? before,
    moved: Math.abs((range?.max ?? before) - (range?.min ?? before)) > 40,
    ...diagnostics,
  };
}

async function runRound() {
  const rec = { round: 0, kind: 'persistent-profile' };
  out.rounds.push(rec); save();
  const child = spawn(EXE, [corpus], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: webviewDir },
  });
  child.unref();
  try {
    const target = await waitTargets(60000);
    const cdp = await connectCDP(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__ZIEDIT_IR_PERF__ = true;' });
    await cdp.evaluate('window.__ZIEDIT_IR_PERF__ = true');
    await waitMounted(cdp, 180000);
    // 保留共享采样器原 frames/启停语义，仅在同一 tick 记录时间与当前位置。
    await cdp.evaluate(RAF_SAMPLER.replace('last = t;', `
      const sc = document.querySelector('.cm-scroller');
      const maxTop = sc ? Math.max(0, sc.scrollHeight - sc.clientHeight) : 0;
      window.__gateFrameEvents.push({ start: last, end: t, dur: window.__raf.frames[window.__raf.frames.length - 1], phase: window.__gateScrollPhase, scrollTop: sc?.scrollTop ?? null, progress: sc ? (maxTop > 0 ? sc.scrollTop / maxTop : 0) : null });
      last = t;
    `));
    await new Promise(r => setTimeout(r, 1500));
    const welcomeGone = await dismissWelcome(cdp);
    rec.welcome = { dismissed: welcomeGone }; save();
    if (!welcomeGone) throw new Error('welcome/overlay modal not dismissible — input cannot land (fail-closed)');

    const face = await cdp.evaluate(`document.querySelector('.md-ir .cm-scroller') ? 'ir' : 'other'`);
    if (face !== 'ir') throw new Error('not on IR surface (.md-ir .cm-scroller missing, fail-closed)');
    const samplerOk = await cdp.evaluate('typeof window.__rafStart === "function" && typeof window.__rafStop === "function"');
    if (!samplerOk) throw new Error('rAF sampler missing (fail-closed)');

    if (tableSeps > 0) {
      const landed = await cdp.evaluate(`(() => {
        const v = document.querySelector('.cm-content').cmTile.view;
        const doc = v.state.doc;
        for (let n = 1; n <= doc.lines; n++) {
          const line = doc.line(n);
          if (/^\\|[\\-\\s|]*---/.test(line.text)) {
            v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
            v.focus();
            return line.number;
          }
        }
        return 0;
      })()`);
      if (!landed) throw new Error('corpus has table separators but none found in the open document (fail-closed)');
      const t0 = Date.now();
      let tables = 0;
      while (Date.now() - t0 < 8000) {
        tables = await cdp.evaluate("document.querySelectorAll('.mdir-tablebox').length");
        if (tables > 0) break;
        await new Promise(r => setTimeout(r, 100));
      }
      rec.tablesMounted = tables;
      if (!tables) throw new Error('corpus has tables but IR mounted none (fail-closed)');
    }

    const geom = await cdp.evaluate(`(() => { const sc = document.querySelector('.cm-scroller'); return { scrollH: sc.scrollHeight, clientH: sc.clientHeight }; })()`);
    rec.full = await sweep(cdp);
    rec.full.canScroll = geom.scrollH - geom.clientH > 80;
    if (rec.full.canScroll && !rec.full.moved) throw new Error('wheel did not move scrollTop (fail-closed)');
    if (rec.full.n < 20) throw new Error(`rAF frames missing (${rec.full.n}, fail-closed)`);

    await cdp.evaluate(`(() => { let s = document.getElementById('gate-ir-hide-tables'); if (!s) { s = document.createElement('style'); s.id = 'gate-ir-hide-tables'; document.head.appendChild(s); } s.textContent = '.mdir-tablebox{display:none!important}'; return 1; })()`);
    await new Promise(r => setTimeout(r, 200));
    const hiddenGeom = await cdp.evaluate(`(() => {
      const sc = document.querySelector('.cm-scroller'); sc.scrollTop = 0;
      const box = document.querySelector('.mdir-tablebox');
      return { scrollH: sc.scrollHeight, clientH: sc.clientHeight, display: box ? getComputedStyle(box).display : null, rule: document.getElementById('gate-ir-hide-tables')?.textContent || '' };
    })()`);
    rec.baseline = await sweep(cdp);
    rec.baseline.canScroll = hiddenGeom.scrollH - hiddenGeom.clientH > 80;
    rec.baseline.display = hiddenGeom.display;
    if (!hiddenGeom.rule.includes('display:none')) throw new Error('table hide rule missing (fail-closed)');
    if (hiddenGeom.display && hiddenGeom.display !== 'none') throw new Error('table hide did not apply (fail-closed)');
    if (rec.baseline.canScroll && !rec.baseline.moved) throw new Error('baseline wheel did not move scrollTop (fail-closed)');
    if (rec.baseline.n < 20) throw new Error(`baseline rAF frames missing (${rec.baseline.n}, fail-closed)`);

    const reasons = [];
    if (rec.full.over34 > rec.baseline.over34 + FRAME_TOLERANCE) {
      reasons.push(`>34ms frames ${rec.full.over34} > no-table baseline ${rec.baseline.over34}+${FRAME_TOLERANCE}`);
    }
    if (rec.full.p95 > rec.baseline.p95 + P95_TOLERANCE_MS) {
      reasons.push(`p95 ${rec.full.p95} > no-table baseline ${rec.baseline.p95}+${P95_TOLERANCE_MS}ms`);
    }
    rec.failReasons = reasons;
    rec.verdict = reasons.length === 0;
    save();
    await cdp.close();
  } finally {
    await killTree(child.pid);
  }
  return rec;
}

try {
  const rec = await runRound();
  out.verdict = rec.verdict === true;
  out.summary = {
    full: rec.full && { p50: rec.full.p50, p95: rec.full.p95, max: rec.full.max, over34: rec.full.over34, n: rec.full.n },
    baseline: rec.baseline && { p50: rec.baseline.p50, p95: rec.baseline.p95, max: rec.baseline.max, over34: rec.baseline.over34, n: rec.baseline.n },
  };
  save();
  console.log(JSON.stringify({ verdict: out.verdict, failReasons: rec.failReasons ?? [], summary: out.summary }, null, 2));
  process.exitCode = out.verdict ? 0 : 1;
} catch (e) {
  out.fatal = String(e.stack || e);
  out.verdict = false;
  save();
  console.error(e);
  process.exit(1);
}
