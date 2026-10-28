// gate-batch1-scroll.mjs — batch1 门禁：公式/表格语料快速滚动（estimatedHeight 回填塌陷 jump 检测）
// 迁移自 docs/tmp/audit-r2/gate-batch1-scroll.mjs（只读源）。整备：profile 落 RUN_DIR/profiles/b1scroll；
// verdict=false 时退出码置 1（供 run-all.mjs 汇总）。
// 用法: node tests/gates/gate-batch1-scroll.mjs <corpus.md> <out.json> [sweepMs=30000]
// 判据（batch1 键入/选区路径增量化，滚动面）:
// 语料校验：$$ 出现 ≥10 且 |--- 出现 ≥10，不足即 FAIL（可用 gen-corpus.mjs 重生成密集语料）；
// 扫档期（下扫+上扫全程）零 >100ms 长任务（fail-closed：observer 未注册即 FAIL）；
// jump 检测：连续帧 scrollTop 未变但 .cm-content getBoundingClientRect().top 突变 >80px 记一次 jump；
// jump 计数/时间点入 JSON——首轮基线与修后对比由运行时判读，脚本只如实出数 + 基础上限阈值 jumpSoftMax=20；
// rAF 帧时间全序列 p50/p95/max 上报。
// 注：不改动语料原文件。若语料不足可用 gen-corpus.mjs（已含公式/表格）；--enrich 开关为脚本内副本富化。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RUN_DIR, EXE, PORT, GATE_ENV, GATE_BUDGET, INIT_OBSERVERS, RAF_SAMPLER, connectCDP, waitTargets, waitMounted, clickFocus, killTree, percentile } from './gate-lib.mjs';

const corpusArg = process.argv[2];
const outFileArg = process.argv[3];
const SWEEP_MS = Math.max(5000, parseInt(process.argv[4] || '30000', 10));
if (!corpusArg || !outFileArg) { console.error('用法: node tests/gates/gate-batch1-scroll.mjs <corpus.md> <out.json> [sweepMs=30000]'); process.exit(1); }
const outFile = path.resolve(outFileArg);
const webviewDir = path.join(RUN_DIR, 'profiles/b1scroll');

// —— 语料校验 + --enrich 副本富化（写 os 临时目录，不覆盖原文件）——
function loadCorpus(rawPath) {
  const src = path.resolve(rawPath);
  const text = fs.readFileSync(src, 'utf8');
  const count = (re) => (text.match(re) || []).length;
  const stats = { src, bytes: Buffer.byteLength(text, 'utf8'), dollars: count(/\$\$/g), tables: count(/^\|[-\s|]*---/gm) };
  if (stats.dollars >= 10 && stats.tables >= 10) return { path: src, ...stats, enriched: false };
  if (!process.argv.includes('--enrich')) {
    throw new Error(`语料公式/表格不足（$$=${stats.dollars}, |---=${stats.tables}，各需 ≥10）。用 gen-corpus.mjs 生成密集语料，或加 --enrich 让脚本写临时副本富化。`);
  }
  // 富化：按段落注入 $$ 公式块 + GFM 表格（散布全文，不动原文内容）
  const paragraphs = text.split(/\n\n+/);
  const total = paragraphs.length;
  const step = Math.max(1, Math.floor(total / 60)); // ~60 处注入点
  let n = 0;
  const injected = paragraphs.map((p, i) => {
    if (i % step !== 0 || i === 0) return p;
    n++;
    const math = `$$\n\\int_{0}^{${i}} x^2 \\,dx = \\frac{${i}^3}{3} + \\sum_{k=1}^{${i}} k\n$$`;
    const table = `| 列A${i} | 列B | 列C |\n|---|---|---|\n| ${i} | 加粗${i} | $z_{${i}}$ |`;
    return n % 2 === 0 ? p + '\n\n' + math : p + '\n\n' + table;
  }).join('\n\n');
  const tmp = path.join(os.tmpdir(), `ZiEdit-b1scroll-enriched-${Date.now()}.md`);
  fs.writeFileSync(tmp, injected);
  const en = { dollars: (injected.match(/\$\$/g) || []).length, tables: (injected.match(/^\|[-\s|]*---/gm) || []).length };
  return { path: tmp, bytes: Buffer.byteLength(injected, 'utf8'), dollars: en.dollars, tables: en.tables, enriched: true, enrichedFrom: src };
}

let corpus;
try { corpus = loadCorpus(corpusArg); }
catch (e) {
  fs.writeFileSync(outFile, JSON.stringify({ verdict: false, fatal: String(e.message || e), corpus: corpusArg }, null, 2));
  console.error(e.message || e); process.exit(1);
}

const out = { build: { exe: EXE, corpus: corpus.path, corpusOriginal: corpus.enriched ? corpus.enrichedFrom : corpus.path, corpusEnriched: corpus.enriched, corpusBytes: corpus.bytes, corpusStats: { dollars: corpus.dollars, tables: corpus.tables }, sweepMs: SWEEP_MS, jumpThresholdPx: 80, port: PORT, machine: { platform: process.platform, node: process.version } }, rounds: [] };
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
Object.assign(out.build, { environment: GATE_ENV, budgets: GATE_BUDGET });

async function runRound(roundIdx) {
  const cold = roundIdx === 0;
  if (cold) fs.rmSync(webviewDir, { recursive: true, force: true });
  const rec = { round: roundIdx, kind: cold ? 'cold' : 'warm' };
  out.rounds.push(rec); save();

  const child = spawn(EXE, [corpus.path], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: webviewDir },
  });
  child.unref();
  try {
    const target = await waitTargets(30000);
    const cdp = await connectCDP(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await waitMounted(cdp);
    await cdp.evaluate(INIT_OBSERVERS);
    // 在原采样器同一回调内补时间戳，不改变原 frames 或启停逻辑。
    await cdp.evaluate(RAF_SAMPLER.replace('last = t;', 'window.__gateFrameEvents.push({ start: last, end: t, dur: window.__raf.frames[window.__raf.frames.length - 1] }); last = t;'));
    await cdp.evaluate('window.__gateFrameEvents = []');
    await new Promise(r => setTimeout(r, 3000)); // 挂载期异步（公式/图表/预热）跑完

    const base = await clickFocus(cdp, 0); // 点击聚焦 + 光标置顶（滚动从顶部开始）
    await cdp.evaluate('window.__rafStart()');

    const obsOk = await cdp.evaluate(`!!(window.__gate && Array.isArray(window.__gate.longtasks))`);
    if (!obsOk) throw new Error('observer not registered (window.__gate missing)');
    const pageStart = await cdp.evaluate('Math.round(performance.now())');
    rec.base = base; rec.pageStart = pageStart; save();

    // —— 程序化滚动：阶梯 scrollTop 下扫到底再上扫回顶，全程 ~sweepMs ——
    // 采样循环与滚动同帧执行：每步 rAF 采 scrollTop/scrollHeight/contentRect.top，jump 判据见头部。
    const scrollPlan = await cdp.evaluate(`(() => { const sc = document.querySelector('.cm-scroller'); if (!sc) throw new Error('.cm-scroller missing'); return { scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, maxTop: sc.scrollHeight - sc.clientHeight }; })()`);
    const half = Math.floor(SWEEP_MS / 2);
    const sweepResult = await cdp.evaluate(`(async () => {
      const sc = document.querySelector('.cm-scroller');
      const content = document.querySelector('.cm-content');
      const samples = [];   // { t, top, height, contentTop }
      const jumps = [];     // { t, from, to, deltaPx, top }
      let last = null;
      const raf = () => new Promise(r => requestAnimationFrame(r));
      const sample = () => {
        const s = { t: Math.round(performance.now()), top: Math.round(sc.scrollTop), height: sc.scrollHeight, contentTop: Math.round(content.getBoundingClientRect().top) };
        if (last && Math.abs(s.top - last.top) < 2 && Math.abs(s.contentTop - last.contentTop) > 80) {
          jumps.push({ t: s.t, from: last.contentTop, to: s.contentTop, deltaPx: s.contentTop - last.contentTop, top: s.top, heightChanged: s.height !== last.height });
        }
        samples.push(s); last = s;
      };
      const sweep = async (from, to, ms) => {
        const steps = Math.max(8, Math.floor(ms / 50));
        for (let i = 0; i <= steps; i++) {
          sc.scrollTop = from + (to - from) * (i / steps);
          sample();
          await raf(); sample();
        }
        sc.scrollTop = to; sample(); await raf(); sample();
      };
      const downStart = performance.now();
      await sweep(0, ${scrollPlan.maxTop}, ${half});       // 下扫
      const upStart = performance.now();
      await sweep(${scrollPlan.maxTop}, 0, ${half});       // 上扫
      const end = performance.now();
      return { samples: samples.filter((_, i) => i % 3 === 0), positionSamples: samples, phases: { down: { start: downStart, end: upStart }, up: { start: upStart, end } }, jumps, finalTop: Math.round(sc.scrollTop), finalHeight: sc.scrollHeight };
    })()`);

    const frameTimes = await cdp.evaluate('window.__rafStop()');
    const g = await cdp.evaluate('window.__gate');
    const lts = (g?.longtasks || []).filter(x => x.start > pageStart);
    const loaf = (g?.loaf || []).filter(x => x.start > pageStart);
    const ftSorted = [...frameTimes].sort((a, b) => a - b);
    const frameEvents = await cdp.evaluate('window.__gateFrameEvents');
    const phaseFor = start => Object.entries(sweepResult.phases).find(([, p]) => start >= p.start && start < p.end)?.[0] ?? null;
    const events = lts.map(l => {
      // PerformanceObserver 异步交付：使用任务开始前最近的滚动样本，而非交付时位置。
      const position = sweepResult.positionSamples.findLast(s => s.t <= l.start);
      const maxTop = position ? Math.max(0, position.height - scrollPlan.clientHeight) : 0;
      return { ...l, phase: phaseFor(l.start), position: position ? { sampledAt: position.t, scrollTop: position.top, scrollHeight: position.height, progress: maxTop > 0 ? position.top / maxTop : 0, source: 'preceding-scroll-sample' } : null };
    });
    const phases = Object.fromEntries(Object.entries(sweepResult.phases).map(([name, bounds]) => {
      const frames = frameEvents.filter(f => f.end >= bounds.start && f.end < bounds.end).map(f => f.dur).sort((a, b) => a - b);
      return [name, { ...bounds, longtaskCount: events.filter(e => e.phase === name).length, frameCount: frames.length, frameP95: percentile(frames, 0.95) }];
    }));

    rec.result = {
      scrollPlan,
      sweep: {
        samplesN: sweepResult.samples.length,
        finalTop: sweepResult.finalTop, finalHeight: sweepResult.finalHeight,
        reachedBottom: Math.abs(sweepResult.finalHeight - scrollPlan.scrollHeight) >= 0 && scrollPlan.maxTop > 0,
      },
      jumps: { count: sweepResult.jumps.length, thresholdPx: 80, events: sweepResult.jumps.slice(0, 50), byHeightChange: sweepResult.jumps.filter(j => j.heightChanged).length },
      frameTimes: { n: ftSorted.length, p50: percentile(ftSorted, 0.5), p95: percentile(ftSorted, 0.95), max: ftSorted.length ? ftSorted[ftSorted.length - 1] : 0 },
      longtasks: { count: lts.length, over100: lts.filter(l => l.dur > 100).length, maxDur: lts.length ? Math.max(...lts.map(l => l.dur)) : 0, worst: lts.filter(l => l.dur > 100).slice(-5) },
      loaf: { count: loaf.length, maxDur: loaf.length ? Math.max(...loaf.map(l => l.dur)) : 0 },
      bars: { longtaskMs: GATE_BUDGET.scrollLongtaskMs, jumpSoftMax: 20 },
    };
    rec.result.longtasks.events = events;
    rec.result.sweep.phases = phases;
    const reasons = [];
    if (!obsOk) reasons.push('observer missing');
    if (rec.result.frameTimes.n < 20) reasons.push(`rAF frames missing (${rec.result.frameTimes.n})`);
    if (rec.result.sweep.samplesN < 20) reasons.push(`scroll samples missing (${rec.result.sweep.samplesN})`);
    const overBudget = lts.filter(l => l.dur > GATE_BUDGET.scrollLongtaskMs).length;
    rec.result.longtasks.overBudget = overBudget;
    if (overBudget > 0) reasons.push(`longtask>${GATE_BUDGET.scrollLongtaskMs}ms × ${overBudget}`);
    if (rec.result.jumps.count > 20) reasons.push(`jumps ${rec.result.jumps.count} > soft max 20 (基线/修后对比由运行时判读)`);
    rec.failReasons = reasons;
    rec.verdict = reasons.length === 0;
    save();
    await cdp.close();
  } finally {
    await killTree(child.pid);
  }
  return rec;
}

(async () => {
  await runRound(0);
  const rec = out.rounds[0];
  out.summary = {
    jumps: rec.result?.jumps.count ?? null,
    longtaskOver100: rec.result?.longtasks.over100 ?? null,
    frameP95: rec.result?.frameTimes.p95 ?? null, frameMax: rec.result?.frameTimes.max ?? null,
  };
  out.verdict = rec.verdict === true;
  save();
  console.log(JSON.stringify({ verdict: out.verdict, failReasons: rec.failReasons ?? [], summary: out.summary }, null, 2));
  process.exitCode = out.verdict ? 0 : 1;
})().catch(e => { out.fatal = String(e.stack || e); out.verdict = false; save(); console.error(e); process.exit(1); });
