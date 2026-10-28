// gate-lib.mjs — CDP 门禁脚本共享小工具（CDP 连接 / 挂载等待 / observer 注入 / 清理）
// 迁移自 docs/tmp/audit-r2/gate-lib.mjs（只读源，2026-10-23 固化为可重复验收集）。
// 整备：① 路径不依赖 cwd——REPO_ROOT 经 import.meta.url 定位，脚本可从任意目录运行（约定从仓库根运行）；
// ② 语料/结果/profile/构建产物统一落 RUN_DIR（默认 <repo>/docs/tmp/gates-run/，该目录随 docs/tmp/ 已在 .gitignore，不入库）；
// ③ exe 路径可用环境变量 ZIEDIT_GATE_EXE 覆盖（默认指向 prepare-gate-build.mjs 的隔离构建产物）。
// 用法: import { REPO_ROOT, RUN_DIR, EXE, PORT, connectCDP, waitTargets, waitMounted, INIT_OBSERVERS, RAF_SAMPLER, clickFocus, killTree, percentile, median } from './gate-lib.mjs'
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RUN_DIR = process.env.ZIEDIT_GATE_RUN_DIR ? path.resolve(process.env.ZIEDIT_GATE_RUN_DIR) : path.join(REPO_ROOT, 'docs/tmp/gates-run');
export const EXE = process.env.ZIEDIT_GATE_EXE ? path.resolve(process.env.ZIEDIT_GATE_EXE) : path.join(RUN_DIR, 'native-gate-build/src-tauri/target/release/ziedit.exe');
export const PORT = 18430; // 隔离构建经 prepare-gate-build.mjs 烤入 lib.rs（env 注入已证失效）
export const GATES_DIR = path.dirname(fileURLToPath(import.meta.url)); // 脚本自身目录（伴随资产定位）

export const GATE_ENV = process.env.ZIEDIT_GATE_ENV || 'gpu';
if (!['gpu', 'soft'].includes(GATE_ENV)) throw new Error(`未知 ZIEDIT_GATE_ENV=${GATE_ENV}（须为 gpu|soft）`);
// 环境预算只作用于运行仪器，不改变 AC-36 或正确性判据。
export const GATE_BUDGET = Object.freeze({
  frameMultiplier: GATE_ENV === 'soft' ? 2 : 1,
  scrollLongtaskMs: GATE_ENV === 'soft' ? 200 : 100,
  arrowLongtaskMs: GATE_ENV === 'soft' ? 100 : 50,
  walkFrameMs: GATE_ENV === 'soft' ? 64 : 32,
  walkStableMs: GATE_ENV === 'soft' ? 1600 : 800,
});

// INIT 观测注入（longtask + long-animation-frame + error 收集；与 native-gate-ac36 同口径）
export const INIT_OBSERVERS = `
window.__gate = { longtasks: [], loaf: [], errors: [] };
window.addEventListener('error', e => window.__gate.errors.push(String(e.message)));
try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__gate.longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) }); }).observe({ entryTypes: ['longtask'] }); } catch (e) {}
try { new PerformanceObserver(l => { for (const e of l.getEntries()) { const s = (e.scripts||[]).reduce((a,x)=>a+(x.duration||0),0); window.__gate.loaf.push({ start: Math.round(e.startTime), dur: Math.round(e.duration), script: Math.round(s) }); } }).observe({ entryTypes: ['long-animation-frame'] }); } catch (e) {}
`;

export async function waitTargets(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return page;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('CDP target timeout');
}

export async function connectCDP(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
  let id = 0; const pending = new Map();
  socket.onmessage = ev => {
    const m = JSON.parse(ev.data), t = pending.get(m.id);
    if (!t) return;
    pending.delete(m.id); clearTimeout(t.timer);
    m.error ? t.reject(new Error(JSON.stringify(m.error))) : t.resolve(m.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const r = ++id;
    const timer = setTimeout(() => { pending.delete(r); reject(new Error('CDP timeout ' + method)); }, 120000);
    pending.set(r, { resolve, reject, timer }); socket.send(JSON.stringify({ id: r, method, params }));
  });
  const evaluate = async expression => {
    const v = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (v.exceptionDetails) throw new Error(JSON.stringify(v.exceptionDetails).slice(0, 500));
    return v.result.value;
  };
  return { send, evaluate, close: () => socket.close() };
}

// 免 reload 挂载等待 .cm-content（僵尸会话下 Page.reload 不完成；等自动挂载后注入，2026-10-21 实证口径）
export async function waitMounted(cdp, timeoutMs = 180000) {
  const t0 = Date.now();
  for (;;) {
    const ok = await cdp.evaluate("!!document.querySelector('.cm-content')").catch(() => false);
    if (ok) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('mount timeout');
    await new Promise(r => setTimeout(r, 100));
  }
}

// 真实鼠标点击 + DOM 聚焦 + 光标置 pos（native-writing-20min 已验证口径；pos 默认文档末）
export async function clickFocus(cdp, pos = null) {
  const rect = await cdp.evaluate(`(() => { const r = document.querySelector('.cm-content').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 40 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  return cdp.evaluate(`(() => { const v = document.querySelector('.cm-content').cmTile.view; v.dispatch({ selection: { anchor: ${pos === null ? 'v.state.doc.length' : pos} } }); v.focus(); return { len: v.state.doc.length }; })()`);
}

// taskkill /F /T 树杀（漏 WebView2 子进程会占住 profile 与端口，下轮调试失效）
export async function killTree(pid) {
  try { await run('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 10000 }); } catch {}
}
export async function killByName(name) {
  try { await run('taskkill', ['/F', '/T', '/IM', name], { timeout: 10000 }); } catch {}
}

export const percentile = (sorted, fraction) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : 0;
export const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// rAF 帧时间序列采样（start/stop 配对；返回帧间隔 ms 数组）
export const RAF_SAMPLER = `
window.__raf = { frames: [], running: false };
window.__rafStart = () => { if (window.__raf.running) return 1; window.__raf.running = true; window.__raf.frames = []; let last = performance.now(); const tick = t => { window.__raf.frames.push(Math.round((t - last) * 100) / 100); last = t; if (window.__raf.running) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return 1; };
window.__rafStop = () => { window.__raf.running = false; return window.__raf.frames.slice(); };
`;
