// native-gate-ac36.mjs — AC-36 键入跟手度门禁（5 分钟持续键入 + IR 探针事务分段）
// 迁移自 docs/tmp/audit-r2/native-gate-ac36.mjs（只读源）。整备：CDP/清理改用 ./gate-lib.mjs（同口径抽取源），
// exe 走 ZIEDIT_GATE_EXE/RUN_DIR 约定；verdict=false 时退出码置 1（供 run-all.mjs 汇总）。
// 用法: node tests/gates/native-gate-ac36.mjs <corpus.md> <out.json> [rounds=3]
// 判据（007 v0.36 AC-36，release 构建，冷热 rounds 轮取中位）:
// 键入事务分段（t3-t0，docChanged）p95 ≤ 16ms；单尾 max ≤ 50ms；输入期无 >100ms 长任务；
// 机制锁观察：纯散文键入期 fullRebuildEvents 应为 0（B2 根修后；referencesReady/getLines）。
// 依赖：B1 探针（globalThis.__ZIEDIT_IR_PERF__ 开关 + __ZIEDIT_IR_PERF_DATA__ 快照 getter）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RUN_DIR, EXE, INIT_OBSERVERS, connectCDP, waitTargets, waitMounted, clickFocus, killTree, percentile, median } from './gate-lib.mjs';

const corpusArg = process.argv[2];
const outFileArg = process.argv[3];
const ROUNDS = Math.max(1, parseInt(process.argv[4] || '3', 10));
const TYPING_MS = 5 * 60 * 1000;
if (!corpusArg || !outFileArg) { console.error('用法: node tests/gates/native-gate-ac36.mjs <corpus.md> <out.json> [rounds]'); process.exit(1); }
const outFile = path.resolve(outFileArg);
const corpus = path.resolve(corpusArg);
const webviewDir = path.join(RUN_DIR, 'profiles/ac36');

const out = { build: { exe: EXE, corpus, corpusBytes: fs.statSync(corpus).size, typingMs: TYPING_MS, rounds: ROUNDS, machine: { platform: process.platform, node: process.version } }, rounds: [] };
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

const key = async (cdp, ch) => {
  const code = ch.length === 1 && /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : 'Unidentified';
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code });
};
const enterKey = async (cdp) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};

async function runRound(roundIdx) {
  const cold = roundIdx === 0;
  if (cold) fs.rmSync(webviewDir, { recursive: true, force: true });
  const rec = { round: roundIdx, kind: cold ? 'cold' : 'warm' };
  out.rounds.push(rec); save();

  const child = spawn(EXE, [corpus], {
    detached: true, stdio: 'ignore', // 可见窗口：隐藏窗 getBoundingClientRect 归零会破坏 CM6 视口测量（实测每事务膨胀到 ~75ms），且焦点不可靠
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: webviewDir },
  });
  child.unref();
  try {
    const target = await waitTargets(30000);
    const cdp = await connectCDP(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    // 免 reload 挂载：僵尸会话（前台 NULL）下 Page.reload 在受限渲染器中不完成（2026-10-21 实证：
    // 免 reload 时 .cm-content 3s 挂载、130 万字符全量在档）。等自动挂载后在活文档上注入 INIT——
    // 观测等价：longtask/loaf 只统计 pageStart 之后的条目，挂载期事件本就不入结果。
    await waitMounted(cdp);
    await cdp.evaluate(INIT_OBSERVERS);
    await new Promise(r => setTimeout(r, 3000)); // 挂载期异步（公式/图表/预热）跑完

    // 真实鼠标点击 + DOM 聚焦 + 光标置文档末（native-writing-20min 已验证口径）
    const base = await clickFocus(cdp, null);

    // 启用 IR 探针（B1：挂载后开启，开启前零记录）
    // 在探针开启/首字符注入前定界；不用 round（可能向未来进位，严格 > 会漏掉边界样本）。
    const pageStart = await cdp.evaluate('(() => { const start = Math.floor(performance.now()) - 1; globalThis.__ZIEDIT_IR_PERF__ = true; return start; })()');
    rec.base = base; rec.pageStart = pageStart; save();

    // —— 5 分钟持续键入（拟真节奏：字符间 90–150ms，句间 ~1.4s>300ms 防抖，逐句触发 reportHeadings 路径）——
    const segMap = new Map(); const evtMap = new Map(); const ltMap = new Map();
    let loafKeep = [];
    const readProbe = async () => {
      const snap = await cdp.evaluate(`(globalThis.__ZIEDIT_IR_PERF_DATA__ ?? { segments: [], fullRebuildEvents: [] })`);
      for (const s of snap.segments) { if (s.t0 > pageStart) segMap.set(s.t0 + ':' + s.length, s); }
      for (const e of snap.fullRebuildEvents) { if (e.time > pageStart) evtMap.set(e.kind + ':' + e.time, e); }
      const g = await cdp.evaluate('window.__gate');
      for (const lt of g.longtasks) { if (lt.start > pageStart) ltMap.set(lt.start + ':' + lt.dur, lt); }
      loafKeep = g.loaf.filter(x => x.start > pageStart).slice(-40);
      const v = await cdp.evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.length');
      rec.progress = { docLen: v, segs: segMap.size, evts: evtMap.size, longtasks: ltMap.size }; save();
    };

    const t0 = Date.now();
    let sentence = 0;
    const focusAgain = async () => {
      const rect = await cdp.evaluate(`(() => { const r = document.querySelector('.cm-content').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 40 }; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await cdp.evaluate(`(() => { const v = document.querySelector('.cm-content').cmTile.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); return 1; })()`);
    };
    // 多面覆盖：散文 ×2、列表续写、代码围栏、表格（表头建表+格内键入+Tab 跨格）。
    // 每模式后强制重锚焦点回主视图（表格格编辑器会吞掉后续键入——实测焦点被困后整轮测量被污染）；
    // 每行嵌入 zN 序号标记 + 按句时间窗分桶，分面出数。
    const typeLine = async (text) => { for (const ch of text) { await key(cdp, ch); await new Promise(r => setTimeout(r, 90 + Math.floor(Math.random() * 60))); } };
    const sentenceWindows = [];
    while (Date.now() - t0 < TYPING_MS) {
      sentence++;
      const n = sentence, marker = `z${n}x`, pattern = n % 5;
      const wStart = await cdp.evaluate('Math.round(performance.now())');
      if (pattern === 3) { // 围栏：```js + Enter(自动闭合) + 代码行 + Enter + Enter(经闭合行退出)
        await typeLine('```js');
        await enterKey(cdp); await new Promise(r => setTimeout(r, 300));
        await typeLine(`const v${n} = ${n}; // ${marker}`);
        await enterKey(cdp); await new Promise(r => setTimeout(r, 250));
        await enterKey(cdp); await new Promise(r => setTimeout(r, 250));
      } else if (pattern === 4) { // 表格：完整表头 + Enter(建表入格) + 格内键入 + Tab + 第二格 + Enter(提交)
        await typeLine(`| 头A${n} | 头B |`);
        await enterKey(cdp); await new Promise(r => setTimeout(r, 350));
        await typeLine(`值${marker}`);
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await new Promise(r => setTimeout(r, 250));
        await typeLine(`二${n}`);
        await enterKey(cdp); await new Promise(r => setTimeout(r, 250));
      } else if (pattern === 2) { // 列表续写
        await typeLine(`- 列表项${marker} 持续键入`);
        await enterKey(cdp);
      } else { // 散文
        await typeLine(`第${n}句 性能门禁持续键入 ZiEdit ac36 ${marker}。`);
        await enterKey(cdp);
      }
      const wEnd = await cdp.evaluate('Math.round(performance.now())');
      sentenceWindows.push({ n, surface: ['prose', 'prose', 'list', 'fence', 'table'][pattern], start: wStart, end: wEnd });
      await focusAgain(); // 重锚：模式（尤其表格格）可能吞焦点，逐句回收
      await new Promise(r => setTimeout(r, 1200));
      if (n <= 3 || n % 5 === 0) {
        const len = await cdp.evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.length');
        if (n <= 3 && len === base.len) await focusAgain();
        else if (n % 5 === 0) await readProbe();
      }
    }
    await new Promise(r => setTimeout(r, 2000)); // 收尾防抖（最后一次 reportHeadings）
    await readProbe();

    // —— 汇总与判据（fail-closed：输入未落地/样本不足/序号断裂即败）——
    const finalLen = await cdp.evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.length');
    const tail = await cdp.evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.sliceString(-80)');
    const sequence = await cdp.evaluate(`(() => { const doc = document.querySelector('.cm-content').cmTile.view.state.doc.toString(); const ns = [...doc.matchAll(/z(\\d+)x/g)].map(m => +m[1]); let ok = ns.length > 0; for (let i = 1; i < ns.length; i++) if (ns[i] !== ns[i-1] + 1) ok = false; return { count: ns.length, last: ns[ns.length-1] || 0, ordered: ok }; })()`);
    const durations = [...segMap.values()].filter(s => s.docChanged).map(s => s.t3 - s.t0).sort((a, b) => a - b);
    const changedSegs = [...segMap.values()].filter(s => s.docChanged);
    const phaseMed = (pick) => { const vs = changedSegs.map(pick).sort((a, b) => a - b); return vs.length ? vs[Math.floor(vs.length / 2)] : 0; };
    // 分面统计：按句时间窗把事务分桶到 散文/列表/围栏/表格（表格含格提交同步重事务）
    const bySurface = { prose: [], list: [], fence: [], table: [], unbinned: [] };
    for (const s of changedSegs) {
      const w = sentenceWindows.find(win => s.t0 >= win.start && s.t0 <= win.end);
      (w ? bySurface[w.surface] : bySurface.unbinned).push(s.t3 - s.t0);
    }
    const surfaceStats = {};
    for (const [name, ds] of Object.entries(bySurface)) {
      ds.sort((a, b) => a - b);
      surfaceStats[name] = { n: ds.length, p50: percentile(ds, 0.5), p95: percentile(ds, 0.95), max: ds.length ? ds[ds.length - 1] : 0 };
    }
    const longtasks = [...ltMap.values()].sort((a, b) => a.dur - b.dur);
    const breaches = longtasks.filter(lt => lt.dur > 100);
    const events = [...evtMap.values()];
    rec.result = {
      sentencesTyped: sentence, baseLen: base.len, finalLen, tail, sequence,
      segments: { total: segMap.size, docChanged: durations.length, p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), max: durations.length ? durations[durations.length - 1] : 0 },
      surfaces: surfaceStats,
      phases: { stateFields: phaseMed(s => s.t1 - s.t0), decorations: phaseMed(s => s.t2 - s.t1), domCommit: phaseMed(s => s.t3 - s.t2) },
      longtasks: { count: longtasks.length, over100ms: breaches.length, maxDur: longtasks.length ? longtasks[longtasks.length - 1].dur : 0, worst: breaches.slice(-5) },
      loafTail: loafKeep.slice(-10),
      fullRebuildEvents: { total: events.length, byKind: events.reduce((a, e) => { a[e.kind] = (a[e.kind] || 0) + 1; return a; }, {}),
        withTimes: events.map(e => ({ kind: e.kind, time: Math.round(e.time) })),
        sentenceWindows: sentenceWindows.map(w => ({ n: w.n, surface: w.surface, start: Math.round(w.start), end: Math.round(w.end) })) },
      inputLanded: finalLen > base.len,
      bars: { p95: 16, max: 50, longtaskMs: 100, minSamples: 100 },
    };
    const reasons = [];
    if (!rec.result.inputLanded) reasons.push('input not landed');
    if (!sequence || !sequence.ordered || sequence.count < sentence) reasons.push(`sequence broken: ${JSON.stringify(sequence)} / typed ${sentence}`);
    if (rec.result.segments.docChanged < 100) reasons.push(`insufficient samples: ${rec.result.segments.docChanged}`);
    if (rec.result.segments.p95 > 16) reasons.push(`p95 ${rec.result.segments.p95} > 16`);
    if (rec.result.segments.max > 50) reasons.push(`max ${rec.result.segments.max} > 50`);
    if (rec.result.longtasks.over100ms > 0) reasons.push(`longtask>100ms × ${rec.result.longtasks.over100ms}`);
    rec.failReasons = reasons;
    rec.verdict = reasons.length === 0;
    rec.mechanismLock = { expectedZeroRebuildsPostB2: true, referencesReady: rec.result.fullRebuildEvents.byKind.referencesReady || 0, getLines: rec.result.fullRebuildEvents.byKind.getLines || 0 };
    save();
    await cdp.close();
  } finally {
    await killTree(child.pid);
  }
  return rec;
}

(async () => {
  for (let i = 0; i < ROUNDS; i++) await runRound(i);
  const ok = out.rounds.filter(r => r.verdict);
  out.summary = {
    roundsPassed: `${ok.length}/${out.rounds.length}`,
    medianP95: median(out.rounds.map(r => r.result?.segments.p95 ?? 0)),
    medianMax: median(out.rounds.map(r => r.result?.segments.max ?? 0)),
    totalOver100msLongtasks: out.rounds.reduce((a, r) => a + (r.result?.longtasks.over100ms ?? 0), 0),
    referencesReadyTotal: out.rounds.reduce((a, r) => a + (r.mechanismLock?.referencesReady ?? 0), 0),
    getLinesTotal: out.rounds.reduce((a, r) => a + (r.mechanismLock?.getLines ?? 0), 0),
  };
  out.verdict = ok.length === out.rounds.length;
  save();
  console.log(JSON.stringify({ verdict: out.verdict, summary: out.summary, rounds: out.rounds.map(r => ({ kind: r.kind, verdict: r.verdict, p95: r.result?.segments.p95, max: r.result?.segments.max, over100: r.result?.longtasks.over100ms, rebuilds: r.mechanismLock })) }, null, 2));
  process.exitCode = out.verdict ? 0 : 1;
})().catch(e => { out.fatal = String(e.stack || e); out.verdict = false; save(); console.error(e); process.exit(1); });
