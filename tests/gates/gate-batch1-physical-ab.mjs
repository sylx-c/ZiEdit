// gate-batch1-physical-ab.mjs — batch1 门禁：物理键入 A/B（A=CDP 合成 / B=SendInput 真实注入 / --human 真人）
// 迁移自 docs/tmp/audit-r2/gate-batch1-physical-ab.mjs（只读源）。整备：profile 落 RUN_DIR/profiles/b1ab，
// gate-sendinput.py 随迁同目录；verdict=false 时退出码置 1（供 run-all.mjs 汇总）。
// 用法: node tests/gates/gate-batch1-physical-ab.mjs <corpus.md> <out.json> [durationMs=60000] [--human]
// 判据（batch1 键入/选区路径增量化，AC-36 分档判决登记输入）:
// A 通道（CDP 合成）：既有 28-30ms/键地板；durationMs 拟真键入，t3-t0 分段（__ZIEDIT_IR_PERF_DATA__）p50/p95 出数；
// B 通道（SendInput）：伴随 gate-sendinput.py 真实注入（ime-input.py 口径：EnumWindows+SetForegroundWindow+SendInput）；
// B 通道 keys 不计入 A 分段；若无探针分段，退化为 longtask/loaf + rAF 帧时间对比（JSON 标注 degraded: true）；
// --human：打印提示语等待真人连打 durationMs（挂起项），仅采样观测通道；
// 输入落地校验（fail-closed）：A 通道 docLen 未增 / B 通道 typedChars=0 / observer 缺失即 FAIL；
// 判读口径：合成 vs 物理地板差值（帧时间 p50 差）写入 verdictNote，供 AC-36 分档判决登记。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import { RUN_DIR, GATES_DIR, EXE, PORT, INIT_OBSERVERS, RAF_SAMPLER, connectCDP, waitTargets, waitMounted, clickFocus, killTree, percentile } from './gate-lib.mjs';

const corpusArg = process.argv[2];
const outFileArg = process.argv[3];
const DURATION_MS = Math.max(10000, parseInt(process.argv[4] || '60000', 10));
const HUMAN = process.argv.includes('--human');
if (!corpusArg || !outFileArg) { console.error('用法: node tests/gates/gate-batch1-physical-ab.mjs <corpus.md> <out.json> [durationMs=60000] [--human]'); process.exit(1); }
const corpus = path.resolve(corpusArg);
const outFile = path.resolve(outFileArg);
const webviewDir = path.join(RUN_DIR, 'profiles/b1ab');
const pyHelper = path.join(GATES_DIR, 'gate-sendinput.py');

const out = { build: { exe: EXE, corpus, corpusBytes: fs.statSync(corpus).size, durationMs: DURATION_MS, human: HUMAN, cdpFloorMsPerKey: '28-30', port: PORT, machine: { platform: process.platform, node: process.version } }, rounds: [] };
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

const key = async (cdp, ch) => {
  const code = ch.length === 1 && /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : 'Unidentified';
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code });
};

async function runRound(roundIdx) {
  const cold = roundIdx === 0;
  if (cold) fs.rmSync(webviewDir, { recursive: true, force: true });
  const rec = { round: roundIdx, kind: cold ? 'cold' : 'warm', channels: {} };
  out.rounds.push(rec); save();

  const child = spawn(EXE, [corpus], {
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
    await cdp.evaluate(RAF_SAMPLER);
    await new Promise(r => setTimeout(r, 3000));

    const base = await clickFocus(cdp, null); // 光标置文档末
    const probePresent = await cdp.evaluate(`('__ZIEDIT_IR_PERF_DATA__' in globalThis) || (globalThis.__ZIEDIT_IR_PERF__ = true, '__ZIEDIT_IR_PERF_DATA__' in globalThis)`);
    rec.base = base; rec.probePresent = !!probePresent; save();

    const obsOk = await cdp.evaluate(`!!(window.__gate && Array.isArray(window.__gate.longtasks))`);
    if (!obsOk) throw new Error('observer not registered (window.__gate missing)');

    const readObs = async (pageStart) => {
      const g = await cdp.evaluate('window.__gate');
      const lts = (g?.longtasks || []).filter(x => x.start > pageStart);
      const loaf = (g?.loaf || []).filter(x => x.start > pageStart);
      return { lts, loaf };
    };
    const segStats = async (pageStart) => {
      const snap = await cdp.evaluate(`(globalThis.__ZIEDIT_IR_PERF_DATA__ ?? null)`).catch(() => null);
      const segs = (snap?.segments || []).filter(s => s.t0 > pageStart && s.docChanged);
      const d = segs.map(s => s.t3 - s.t0).sort((a, b) => a - b);
      return { n: segs.length, p50: percentile(d, 0.5), p95: percentile(d, 0.95), max: d.length ? d[d.length - 1] : 0 };
    };
    const frameStats = (arr) => { const s = [...arr].sort((a, b) => a - b); return { n: s.length, p50: percentile(s, 0.5), p95: percentile(s, 0.95), max: s.length ? s[s.length - 1] : 0 }; };

    // —— A 通道：CDP 合成拟真键入（28-30ms/键地板）——
    {
      const pageStartA = await cdp.evaluate('Math.round(performance.now())');
      await cdp.evaluate('window.__rafStart()');
      const t0 = Date.now(); let keys = 0;
      const sentence = () => `ab ${Math.floor(keys / 40)} physical channel A z${keys}x.`;
      while (Date.now() - t0 < DURATION_MS) {
        for (const ch of sentence()) { await key(cdp, ch); keys++; await new Promise(r => setTimeout(r, 24)); } // +dispatch ≈ 30ms/键
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        if (keys % 400 < 45) { rec.progress = { channel: 'A', keys }; save(); }
      }
      const framesA = await cdp.evaluate('window.__rafStop()');
      const { lts, loaf } = await readObs(pageStartA);
      const finalLenA = await cdp.evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.length');
      rec.channels.A = {
        kind: 'cdp-synthetic', keys, durationMs: Date.now() - t0,
        landed: finalLenA > base.len, baseLen: base.len, finalLen: finalLenA,
        segments: probePresent ? await segStats(pageStartA) : null,
        frameTimes: frameStats(framesA),
        longtasks: { count: lts.length, over100: lts.filter(l => l.dur > 100).length, maxDur: lts.length ? Math.max(...lts.map(l => l.dur)) : 0 },
        loaf: { count: loaf.length, maxDur: loaf.length ? Math.max(...loaf.map(l => l.dur)) : 0 },
      };
      save();
    }

    // —— B 通道：SendInput 真实注入 / --human 真人连打 ——
    {
      // 重置选区到文档末，便于 B 通道独立落地校验
      await clickFocus(cdp, null);
      const lenBeforeB = await cdp.evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.length');
      const pageStartB = await cdp.evaluate('Math.round(performance.now())');
      await cdp.evaluate('window.__rafStart()');
      let bInfo;
      if (HUMAN) {
        console.log(`\n[--human] 请在 ${Math.round(DURATION_MS / 1000)} 秒内于 ZiEdit 窗口真人连打（任意内容）… 计时开始。\n`);
        bInfo = { mode: 'human', waitedMs: DURATION_MS };
        await new Promise(r => setTimeout(r, DURATION_MS));
      } else {
        // python 已在环境；ime-input.py 口径：pid 找窗 + 抢前台 + SendInput 逐键
        const r = await run('python', [pyHelper, String(child.pid), String(DURATION_MS), '12'], { timeout: DURATION_MS + 30000 });
        const lastLine = r.stdout.trim().split('\n').pop();
        try { bInfo = { mode: 'sendinput', ...(lastLine ? JSON.parse(lastLine) : {}) }; }
        catch { bInfo = { mode: 'sendinput', raw: (r.stdout || r.stderr).slice(0, 300), exitCode: r.code }; }
      }
      const framesB = await cdp.evaluate('window.__rafStop()');
      await new Promise(r => setTimeout(r, 1000)); // 收尾防抖
      const { lts, loaf } = await readObs(pageStartB);
      const lenAfterB = await cdp.evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.length');
      const segB = probePresent ? await segStats(pageStartB) : null;
      const degraded = !(segB && segB.n >= 10);
      rec.channels.B = {
        ...bInfo,
        landed: bInfo.mode === 'human' ? true : (bInfo.typedChars > 0 && lenAfterB > lenBeforeB),
        lenBefore: lenBeforeB, lenAfter: lenAfterB,
        segments: segB,
        degraded, degradedNote: degraded ? 'B 通道无探针分段（SendInput 输入走系统消息泵，分段可能并入 A 或缺失）——退化为 longtask/loaf + rAF 帧时间对比' : null,
        frameTimes: frameStats(framesB),
        longtasks: { count: lts.length, over100: lts.filter(l => l.dur > 100).length, maxDur: lts.length ? Math.max(...lts.map(l => l.dur)) : 0 },
        loaf: { count: loaf.length, maxDur: loaf.length ? Math.max(...loaf.map(l => l.dur)) : 0 },
      };
      save();
    }

    // —— 判读口径：合成 vs 物理地板差值 ——
    const A = rec.channels.A, B = rec.channels.B;
    const floorDelta = (A?.frameTimes?.n > 0 && B?.frameTimes?.n > 0) ? Math.round((B.frameTimes.p50 - A.frameTimes.p50) * 100) / 100 : null;
    rec.verdictNote = {
      purpose: 'AC-36 分档判决登记输入：合成(CDP ~28-30ms/键地板) vs 物理(SendInput/真人) 帧时间 p50 差值',
      frameP50DeltaMs: floorDelta,
      interpretation: floorDelta === null ? '帧序列缺失，无法判读' : (floorDelta <= 2 ? '物理通道与合成地板等价（编辑器不在键入路径上）' : '物理通道帧时间高于合成地板，需结合 B 通道长任务判断编辑器责任'),
    };

    const reasons = [];
    if (!obsOk) reasons.push('observer missing');
    if (!A.landed) reasons.push('A channel input not landed');
    if (A.keys < Math.floor(DURATION_MS / 60)) reasons.push(`A keys insufficient: ${A.keys}`);
    if (!B.landed) reasons.push('B channel input not landed (typedChars=0 或 docLen 未增)');
    if (B.mode === 'sendinput' && B.foregroundLost) reasons.push('B channel foreground lost mid-run');
    if (A.longtasks.over100 > 0) reasons.push(`A longtask>100ms × ${A.longtasks.over100}`);
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
    A: rec.channels?.A ? { keys: rec.channels.A.keys, segP95: rec.channels.A.segments?.p95 ?? null, frameP50: rec.channels.A.frameTimes.p50 } : null,
    B: rec.channels?.B ? { mode: rec.channels.B.mode, typedChars: rec.channels.B.typedChars ?? null, degraded: rec.channels.B.degraded, frameP50: rec.channels.B.frameTimes.p50 } : null,
    floorDeltaMs: rec.verdictNote?.frameP50DeltaMs ?? null,
  };
  out.verdict = rec.verdict === true;
  save();
  console.log(JSON.stringify({ verdict: out.verdict, failReasons: rec.failReasons ?? [], summary: out.summary, verdictNote: rec.verdictNote }, null, 2));
  process.exitCode = out.verdict ? 0 : 1;
})().catch(e => { out.fatal = String(e.stack || e); out.verdict = false; save(); console.error(e); process.exit(1); });
