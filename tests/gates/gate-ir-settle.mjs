// gate-ir-settle.mjs — 即时渲染「停稳不弹」真机门（2026-10-30 阶段 2 基线与验收）
// 测什么：用户停止滚动后，屏幕上的内容是否还会自己移动（主诉「停下就弹一下」）。
//   在视口顶部（60px）与视口中线各取一个参考位置，等原生平滑滚动动画结束（连续 3 帧 scrollTop 不变）后，
//   逐帧跟踪 1.5s 内两个参考位置的屏幕 y，记录最大位移。
//   E1 滚轮连续下滚后停住 / E2 连续上滚后停住 / E3 缩略图点击跳转（孤立程序跳转）后。
// 判据：顶部参考位移 ≤ 2px（CM6 滚动锚应保证）；中线参考位移 ≤ 4px（占位与实块高度不一致会在此暴露）。
// 用法: node tests/gates/gate-ir-settle.mjs [corpus.md]   （默认 RUN_DIR/corpus/mixed-100k.md；仅 Windows）
// 结果: RUN_DIR/results/gate-ir-settle.json
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RUN_DIR, EXE, waitTargets, connectCDP, waitMounted, killTree, sleep, clickXY, waitFor, dismissOverlay, switchMdMode } from './gate-lib.mjs';

const corpus = path.resolve(process.argv[2] ?? path.join(RUN_DIR, 'corpus', 'mixed-100k.md'));
if (!fs.existsSync(corpus)) { console.error('缺语料 ' + corpus); process.exit(1); }
const outFile = path.join(RUN_DIR, 'results', 'gate-ir-settle.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const webviewDir = path.join(RUN_DIR, 'profiles', 'ir-settle');
const TOP_PX = 2, MID_PX = 4, TRACK_MS = 1500;

const out = { exe: EXE, corpus, started: new Date().toISOString(), budget: { topPx: TOP_PX, midPx: MID_PX, trackMs: TRACK_MS }, rounds: [] };
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

// 页内跟踪器：参考位置取视口内文档位置，屏幕 y 经 coordsAtPos 读（块级件内的位置返回件的矩形）
const TRACKER = `window.__settle = {
  view() { return document.querySelector('.md-ir:not(.md-ir-loading) .cm-content').cmTile.view; },
  refAt(y) { const v = this.view(), r = v.scrollDOM.getBoundingClientRect(), c = v.contentDOM.getBoundingClientRect();
    return v.posAtCoords({ x: c.left + 30, y: r.top + y }, false); },
  yOf(pos) { const v = this.view(), rect = v.coordsAtPos(pos, 1) || v.coordsAtPos(pos, -1);
    return rect ? rect.top - v.scrollDOM.getBoundingClientRect().top : null; },
  stable() { return new Promise(res => { const v = this.view(); let last = v.scrollDOM.scrollTop, same = 0, n = 0;
    const tick = () => { const t = v.scrollDOM.scrollTop; same = Math.abs(t - last) < .5 ? same + 1 : 0; last = t;
      if (same >= 3 || ++n > 120) res(n); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }); },
  track(ms) { return new Promise(res => {
    const v = this.view(), h = v.scrollDOM.clientHeight;
    const h0 = v.scrollDOM.scrollHeight;
    const refs = [['top', this.refAt(60)], ['mid', this.refAt(h / 2)]].map(([name, pos]) => ({ name, pos, y0: this.yOf(pos), max: 0, at: 0, missing: 0 }));
    const top0 = v.scrollDOM.scrollTop, t0 = performance.now(); let frames = 0, writes = 0, lastTop = top0; const seq = [];
    const tick = () => { frames++;
      const t = v.scrollDOM.scrollTop; if (Math.abs(t - lastTop) >= .5) { writes++; seq.push([Math.round(performance.now() - t0), Math.round(t - lastTop)]); } lastTop = t;
      for (const r of refs) { const y = this.yOf(r.pos); if (y == null || r.y0 == null) { r.missing++; continue; }
        const d = Math.abs(y - r.y0); if (d > r.max) { r.max = d; r.at = Math.round(performance.now() - t0); } }
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else res({ frames, scrollWrites: writes, scrollDelta: Math.round(v.scrollDOM.scrollTop - top0), seq: seq.slice(0, 40),
        heightDelta: Math.round(v.scrollDOM.scrollHeight - h0),
        refs: refs.map(r => ({ name: r.name, max: Math.round(r.max * 10) / 10, at: r.at, missing: r.missing })) });
    };
    requestAnimationFrame(tick);
  }); },
};`;

async function wheel(cdp, x, y, deltaY, times, gapMs) {
  for (let i = 0; i < times; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
    await sleep(gapMs);
  }
}

(async () => {
  const child = spawn(EXE, [corpus], { detached: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: webviewDir } });
  child.unref();
  let cdp;
  try {
    const target = await waitTargets(30000);
    cdp = await connectCDP(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await waitMounted(cdp);
    await sleep(2500);
    if (!(await dismissOverlay(cdp))) throw new Error('welcome/overlay modal not dismissible (fail-closed)');
    if (!(await cdp.evaluate(`!!document.querySelector('.md-ir:not(.md-ir-loading) .cm-content')`))) await switchMdMode(cdp, '即时渲染');
    await waitFor(cdp, `!!document.querySelector('.md-ir:not(.md-ir-loading) .cm-content')`);
    await cdp.evaluate(TRACKER);
    // 先让渲染库就绪（冷启动 MathJax 可达 10s+），基线只测「停稳」本身，不把冷加载算进去
    await waitFor(cdp, `![...document.querySelectorAll('.md-ir:not(.md-ir-loading) .md-render-target')].some(t => t.dataset.renderState === 'loading')`, 30000).catch(() => {});
    await sleep(1000);
    const box = await cdp.evaluate(`(() => { const r = document.querySelector('.md-ir:not(.md-ir-loading) .cm-scroller').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

    const runCase = async (kind, act) => {
      await act();
      await cdp.evaluate('window.__settle.stable()');
      const r = await cdp.evaluate(`window.__settle.track(${TRACK_MS})`);
      const top = r.refs.find(x => x.name === 'top'), mid = r.refs.find(x => x.name === 'mid');
      const pass = top.missing === 0 && mid.missing === 0 && top.max <= TOP_PX && mid.max <= MID_PX;
      const rec = { kind, pass, ...r };
      out.rounds.push(rec); save();
      console.log(`${pass ? 'PASS' : 'FAIL'} ${kind} top=${top.max}px@${top.at}ms mid=${mid.max}px@${mid.at}ms writes=${r.scrollWrites} delta=${r.scrollDelta}`);
    };

    // E1/E2：滚轮连续下滚、上滚（每段 10 格 × 240px，间隔 40ms），各 4 段
    for (let i = 0; i < 4; i++) await runCase(`E1 滚轮下滚停住 #${i + 1}`, () => wheel(cdp, box.x, box.y, 240, 10, 40));
    for (let i = 0; i < 4; i++) await runCase(`E2 滚轮上滚停住 #${i + 1}`, () => wheel(cdp, box.x, box.y, -240, 10, 40));
    // E3：缩略图点击跳转（孤立程序跳转，修前停稳补偿会对这类跳转写 scrollTop）
    const mm = await cdp.evaluate(`(() => { const m = document.querySelector('.editor-rail .minimap'); if (!m || m.offsetParent === null) return null; const r = m.getBoundingClientRect(); return { x: r.left + r.width / 2, top: r.top, h: r.height }; })()`);
    if (mm) for (const ratio of [0.2, 0.75, 0.45, 0.9]) {
      await runCase(`E3 缩略图跳到 ${Math.round(ratio * 100)}%`, () => clickXY(cdp, mm.x, mm.top + mm.h * ratio));
    }
    else out.rounds.push({ kind: 'E3', pass: false, reason: 'minimap hidden' });
    out.errors = await cdp.evaluate('window.__gate?.errors ?? []').catch(() => []);
  } catch (err) {
    out.fatal = String(err?.stack ?? err);
    console.error(out.fatal);
  } finally {
    const failed = out.rounds.filter(r => !r.pass).length;
    out.summary = { rounds: out.rounds.length, failed,
      topMax: Math.max(0, ...out.rounds.map(r => r.refs?.[0]?.max ?? 0)), midMax: Math.max(0, ...out.rounds.map(r => r.refs?.[1]?.max ?? 0)) };
    out.verdict = !out.fatal && out.rounds.length > 0 && failed === 0;
    save();
    try { cdp?.close(); } catch {}
    await killTree(child.pid);
    console.log(`verdict: ${out.verdict ? 'PASS' : 'FAIL'} ${JSON.stringify(out.summary)} → ${outFile}`);
    process.exit(out.verdict ? 0 : 1);
  }
})();
