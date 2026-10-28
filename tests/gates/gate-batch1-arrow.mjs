// gate-batch1-arrow.mjs — batch1 门禁：方向键长按（ArrowDown/ArrowUp 键盘重复模拟）
// 迁移自 docs/tmp/audit-r2/gate-batch1-arrow.mjs（只读源）。整备：profile 落 RUN_DIR/profiles/b1arrow；
// verdict=false 时退出码置 1（供 run-all.mjs 汇总）。
// 用法: node tests/gates/gate-batch1-arrow.mjs <corpus.md> <out.json> [holdMs=60000]
// 判据（batch1 键入/选区路径增量化）:
// hold 期（Down 轮 + Up 轮）零 >50ms 长任务（fail-closed：observer 未注册/数据缺失即 FAIL）；
// rAF 帧时间 p95 / max 上报（阈值基线由运行时判读，首轮出数）；
// 输入落地：每 500 键抽查 selection 主锚位置变化，未动即 FAIL；
// CM6 事务探针 __ZIEDIT_IR_PERF_DATA__（如在场）segments 上报。
// 依赖：gate-lib.mjs（CDP/挂载/聚焦/killTree）；IR 探针为可选项（缺席不判败，但 JSON 标注）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RUN_DIR, EXE, PORT, GATE_ENV, GATE_BUDGET, INIT_OBSERVERS, RAF_SAMPLER, connectCDP, waitTargets, waitMounted, clickFocus, killTree, percentile } from './gate-lib.mjs';

const corpusArg = process.argv[2];
const outFileArg = process.argv[3];
const HOLD_MS = Math.max(5000, parseInt(process.argv[4] || '60000', 10));
if (!corpusArg || !outFileArg) { console.error('用法: node tests/gates/gate-batch1-arrow.mjs <corpus.md> <out.json> [holdMs=60000]'); process.exit(1); }
const corpus = path.resolve(corpusArg);
const outFile = path.resolve(outFileArg);
const webviewDir = path.join(RUN_DIR, 'profiles/b1arrow');

const out = { build: { exe: EXE, corpus, corpusBytes: fs.statSync(corpus).size, holdMs: HOLD_MS, keyIntervalMs: 30, port: PORT, machine: { platform: process.platform, node: process.version } }, rounds: [] };
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
Object.assign(out.build, { environment: GATE_ENV, budgets: GATE_BUDGET });

const ARROW = { ArrowDown: 40, ArrowUp: 38 };
const arrowKey = async (cdp, name) => {
  const vk = ARROW[name];
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: vk });
};

async function runRound(roundIdx) {
  // 持久 profile：不 rmSync——冷 profile 首启「欢迎」模态会拦截全部键盘（测量环境工件，非产品缺陷），
  // 欢迎标记存 localStorage，保留 profile 即不再弹；驱散循环为兜底（Esc 与遮罩角落点击交替）。
  const rec = { round: roundIdx, kind: roundIdx === 0 ? 'cold' : 'warm' };
  out.rounds.push(rec); save();

  const child = spawn(EXE, [corpus], {
    detached: true, stdio: 'ignore', // 可见窗口：隐藏窗视口测量失真（native-gate-ac36 实证）
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
    await cdp.evaluate('globalThis.__ZIEDIT_IR_PERF__ = true'); // 探针早开：数据 getter 惰性挂载，报告侧按实际快照判定
    await new Promise(r => setTimeout(r, 3000)); // 挂载期异步跑完

    // 冷 profile 首启有「欢迎」模态（localStorage 标记随 webview profile 走）——mask 会拦截全部键盘。
    // 驱散循环：Esc（焦点在 body 时有效）与遮罩角落点击（mask mousedown 直接关）交替，最多 5 轮。
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
    rec.welcome = { dismissed: welcomeGone }; save();
    if (!welcomeGone) throw new Error('welcome/overlay modal not dismissible — keyboard cannot land (fail-closed)');

    // 光标置文档中部附近的首个普通段落/列表行（避开原子块：表格/公式/围栏内部——blockAtomic 生效后
    // 原子域内的垂直移动会被 CM6 拒绝，起始点落在件内会让锚点全程不动，假 FAIL）
    const base = await clickFocus(cdp, null); // 先点文档末拿焦点
    const mid = await cdp.evaluate(`(() => { const v = document.querySelector('.cm-content').cmTile.view; const doc = v.state.doc; let line = doc.lineAt(Math.floor(doc.length / 2)); const plain = l => /^(这是第|- )/.test(l.text); for (let i = 0; i < 400 && !plain(line) && line.number < doc.lines; i++) line = doc.line(line.number + 1); v.dispatch({ selection: { anchor: line.from } }); v.focus(); return { pos: line.from, line: line.number, text: line.text.slice(0, 24), len: doc.length }; })()`);
    const probePresent = await cdp.evaluate('globalThis.__ZIEDIT_IR_PERF__ === true');
    const pageStart = await cdp.evaluate('Math.round(performance.now())');
    rec.base = { len: base.len, mid }; rec.pageStart = pageStart; rec.probePresent = !!probePresent; save();

    // observer 注册校验（fail-closed）
    const obsOk = await cdp.evaluate(`!!(window.__gate && Array.isArray(window.__gate.longtasks) && Array.isArray(window.__gate.loaf))`);
    if (!obsOk) throw new Error('observer not registered (window.__gate missing)');

    const readGate = async () => {
      const g = await cdp.evaluate('window.__gate');
      const lts = (g?.longtasks || []).filter(x => x.start > pageStart);
      const loaf = (g?.loaf || []).filter(x => x.start > pageStart);
      const snap = await cdp.evaluate(`(globalThis.__ZIEDIT_IR_PERF_DATA__ ?? null)`).catch(() => null);
      return { lts, loaf, snap };
    };

    // —— 长按模拟：~30ms 间隔 rawKeyDown/keyUp（键盘重复），先 ArrowDown 后 ArrowUp ——
    const holds = [];
    for (const keyName of ['ArrowDown', 'ArrowUp']) {
      const t0 = Date.now();
      let keys = 0, lastAnchor = -1, lastHead = -1, lastAnchorChangeKey = -1, anchorChecks = 0, anchorStuck = 0, anchorRests = 0;
      const spots = []; // { key, anchor, line }
      await cdp.evaluate('window.__rafStart()');
      while (Date.now() - t0 < HOLD_MS) {
        await arrowKey(cdp, keyName);
        keys++;
        if (keys % 500 === 0) { // 每 500 键抽查 selection 主锚
          const s = await cdp.evaluate(`(() => { const v = document.querySelector('.cm-content').cmTile.view; const r = v.state.selection.ranges[0]; const lc = v.state.doc.lines; const atStart = r.head <= v.state.doc.line(1).from, atEnd = r.head >= v.state.doc.line(lc).to; return { anchor: r.anchor, head: r.head, line: v.state.doc.lineAt(r.head).number, atStart, atEnd }; })()`);
          anchorChecks++;
          // 文档首尾的合法停滞（Down 到末行/Up 到首行）记 rests 不记 stuck
          const resting = keyName === 'ArrowDown' ? s.atEnd : s.atStart;
          if (lastAnchor >= 0 && s.anchor === lastAnchor && s.head === lastHead) { if (resting) anchorRests++; else anchorStuck++; } else lastAnchorChangeKey = keys;
          lastAnchor = s.anchor; lastHead = s.head;
          spots.push({ key: keys, ...s });
          rec.progress = { keyName, keys, anchor: s.anchor, line: s.line }; save();
        }
        await new Promise(r => setTimeout(r, 6)); // dispatch 一对 ~24ms，+6ms ≈ 30ms 节奏（CDP 合成 28-30ms/键地板）
      }
      const frameTimes = await cdp.evaluate('window.__rafStop()');
      const { lts, loaf, snap } = await readGate();
      const segs = snap?.segments?.filter(s => s.t0 > pageStart) || [];
      const segDur = segs.filter(s => s.docChanged).map(s => s.t3 - s.t0).sort((a, b) => a - b);
      holds.push({
        keyName, keys, durationMs: Date.now() - t0,
        anchors: { checks: anchorChecks, stuck: anchorStuck, rests: anchorRests, lastChangeKey: lastAnchorChangeKey, spots: spots.slice(-3) },
        frameTimes: { n: frameTimes.length, p50: percentile([...frameTimes].sort((a, b) => a - b), 0.5), p95: percentile([...frameTimes].sort((a, b) => a - b), 0.95), max: frameTimes.length ? Math.max(...frameTimes) : 0 },
        longtasks: { count: lts.length, over50: lts.filter(l => l.dur > 50).length, over100: lts.filter(l => l.dur > 100).length, maxDur: lts.length ? Math.max(...lts.map(l => l.dur)) : 0, worst: lts.filter(l => l.dur > 50).slice(-5) },
        overBudget: lts.filter(l => l.dur > GATE_BUDGET.arrowLongtaskMs).length,
        loaf: { count: loaf.length, maxDur: loaf.length ? Math.max(...loaf.map(l => l.dur)) : 0 },
        segments: segs.length ? { n: segs.length, docChanged: segDur.length, p50: percentile(segDur, 0.5), p95: percentile(segDur, 0.95), max: segDur.length ? segDur[segDur.length - 1] : 0 } : null,
      });
      save();
    }

    const finalPos = await cdp.evaluate(`(() => { const v = document.querySelector('.cm-content').cmTile.view; return { len: v.state.doc.length, anchor: v.state.selection.ranges[0].anchor }; })()`);
    rec.result = { holds, finalPos, bars: { longtaskMs: GATE_BUDGET.arrowLongtaskMs, anchorCheckEveryKeys: 500 } };

    const reasons = [];
    if (!obsOk) reasons.push('observer missing');
    for (const h of holds) {
      if (h.keys < Math.floor(HOLD_MS / 60)) reasons.push(`${h.keyName}: insufficient keys ${h.keys}`);
      if (h.frameTimes.n < 10) reasons.push(`${h.keyName}: rAF frames missing (${h.frameTimes.n})`);
      if (h.overBudget > 0) reasons.push(`${h.keyName}: longtask>${GATE_BUDGET.arrowLongtaskMs}ms × ${h.overBudget}`);
      if (h.anchors.checks > 0 && h.anchors.stuck === h.anchors.checks && h.anchors.checks >= 2) reasons.push(`${h.keyName}: selection anchor never moved across ${h.anchors.checks} checks`);
      if (h.anchors.checks > 0 && h.anchors.stuck > 0) reasons.push(`${h.keyName}: anchor stuck at ${h.anchors.stuck}/${h.anchors.checks} checks`);
    }
    if (finalPos.len !== mid.len) reasons.push(`doc mutated: ${mid.len} -> ${finalPos.len}`);
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
    down: rec.result?.holds[0] ? { keys: rec.result.holds[0].keys, p95: rec.result.holds[0].frameTimes.p95, max: rec.result.holds[0].frameTimes.max, over50: rec.result.holds[0].longtasks.over50 } : null,
    up: rec.result?.holds[1] ? { keys: rec.result.holds[1].keys, p95: rec.result.holds[1].frameTimes.p95, max: rec.result.holds[1].frameTimes.max, over50: rec.result.holds[1].longtasks.over50 } : null,
    probePresent: rec.probePresent ?? false,
  };
  out.verdict = rec.verdict === true;
  save();
  console.log(JSON.stringify({ verdict: out.verdict, failReasons: rec.failReasons ?? [], summary: out.summary }, null, 2));
  process.exitCode = out.verdict ? 0 : 1;
})().catch(e => { out.fatal = String(e.stack || e); out.verdict = false; save(); console.error(e); process.exit(1); });
