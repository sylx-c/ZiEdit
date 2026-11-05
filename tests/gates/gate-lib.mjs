// gate-lib.mjs — CDP 门禁脚本共享小工具（CDP 连接 / 挂载等待 / observer 注入 / 清理）
// 迁移自 docs/tmp/audit-r2/gate-lib.mjs（只读源，2026-10-23 固化为可重复验收集）。
// 整备：① 路径不依赖 cwd——REPO_ROOT 经 import.meta.url 定位，脚本可从任意目录运行（约定从仓库根运行）；
//   ② 语料/结果/profile/构建产物统一落 RUN_DIR（默认 <repo>/docs/tmp/gates-run/，该目录随 docs/tmp/ 已在 .gitignore，不入库）；
//   ③ exe 路径可用环境变量 ZIEDIT_GATE_EXE 覆盖（默认指向 prepare-gate-build.mjs 的隔离构建产物）。
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
window.__gate = { longtasks: [], allLongtasks: [], loaf: [], errors: [] };
window.addEventListener('error', e => window.__gate.errors.push(String(e.message)));
try { new PerformanceObserver(l => { for (const e of l.getEntries()) { const task = { start: Math.round(e.startTime), dur: Math.round(e.duration) }; window.__gate.longtasks.push(task); window.__gate.allLongtasks.push(task); } }).observe({ entryTypes: ['longtask'] }); } catch (e) {}
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
  let id = 0; const pending = new Map(), listeners = new Map();
  let failure;
  const fail = error => {
    failure = error;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); }
    pending.clear();
  };
  socket.onclose = () => fail(new Error('CDP connection closed'));
  socket.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Inspector.targetCrashed') return fail(new Error('WebView2 renderer crashed'));
    for (const listener of listeners.get(m.method) ?? []) listener(m.params);
    const t = pending.get(m.id);
    if (!t) return;
    pending.delete(m.id); clearTimeout(t.timer);
    m.error ? t.reject(new Error(JSON.stringify(m.error))) : t.resolve(m.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const r = ++id;
    const timer = setTimeout(() => { pending.delete(r); reject(new Error('CDP timeout ' + method)); }, 120000);
    pending.set(r, { resolve, reject, timer }); socket.send(JSON.stringify({ id: r, method, params }));
  });
  const evaluate = async expression => {
    const v = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (v.exceptionDetails) throw new Error(JSON.stringify(v.exceptionDetails).slice(0, 500));
    return v.result.value;
  };
  await send('Inspector.enable');
  const on = (method, listener) => {
    if (!listeners.has(method)) listeners.set(method,new Set());
    listeners.get(method).add(listener);
    return () => listeners.get(method)?.delete(listener);
  };
  return { send, evaluate, on, close: () => { listeners.clear(); socket.close(); } };
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

/** 在采样开始前记录原生显示配置，避免远程显示刷新率变化被当作产品差异。 */
export async function readDisplayEnvironment() {
  if (process.platform !== 'win32') return { platform: process.platform };
  const result = await run('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_VideoController | Select-Object Name,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate | ConvertTo-Json -Compress'], { windowsHide: true });
  return JSON.parse(result.stdout.trim());
}

// rAF 帧时间序列采样（start/stop 配对；返回帧间隔 ms 数组）
export const RAF_SAMPLER = `
window.__raf = { frames: [], running: false, generation:0, frame:0 };
window.__rafStart = () => { if (window.__raf.running) return 1; window.__raf.running = true; window.__raf.frames = []; const generation = ++window.__raf.generation; let last = performance.now(); const tick = t => { if (!window.__raf.running || generation !== window.__raf.generation) return; if (t >= last) window.__raf.frames.push(Math.round((t - last) * 100) / 100); last = t; window.__raf.frame = requestAnimationFrame(tick); }; window.__raf.frame = requestAnimationFrame(tick); return 1; };
window.__rafStop = () => { window.__raf.running = false; window.__raf.generation++; cancelAnimationFrame(window.__raf.frame); return window.__raf.frames.slice(); };
`;

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 只调整本门禁启动的原生窗口，固定 GPU 样本视口，并返回原始窗口尺寸。 */
export async function setNativeWindowSize(pid, width, height) {
  if (![pid,width,height].every(Number.isSafeInteger) || pid <= 0 || width < 300 || height < 200) throw new Error('Invalid gate window bounds');
  const result = await run('powershell', ['-NoProfile','-Command', `
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class MdGateWindow{[StructLayout(LayoutKind.Sequential)]public struct Rect{public int Left,Top,Right,Bottom;}[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out Rect r);[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int hgt,uint flags);}';
    $taskWindow=(Get-Process -Id ${pid}).MainWindowHandle;$taskRect=New-Object MdGateWindow+Rect;
    if($taskWindow -eq 0 -or -not [MdGateWindow]::GetWindowRect($taskWindow,[ref]$taskRect)){throw 'Native gate window not found'};
    if(-not [MdGateWindow]::SetWindowPos($taskWindow,[IntPtr]::Zero,0,0,${width},${height},22)){throw 'Native gate resize failed'};
    @{width=$taskRect.Right-$taskRect.Left;height=$taskRect.Bottom-$taskRect.Top}|ConvertTo-Json -Compress;
  `], { windowsHide:true });
  return JSON.parse(result.stdout.trim());
}

// 真实输入（CDP Input 域，经浏览器命中测试与默认动作，等同用户操作）
export async function clickXY(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
export async function pressKey(cdp, key, code, keyCode, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
}
export async function waitFor(cdp, expr, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cdp.evaluate(expr).catch(() => false)) return true; await sleep(100); }
  throw new Error('waitFor timeout: ' + expr);
}
/** 冷 profile 首启欢迎模态拦截输入：Esc 与角落点击交替驱散（同 gate-walk-f 口径），返回是否已驱散 */
export async function dismissOverlay(cdp) {
  for (let i = 0; i < 5; i++) {
    if (!(await cdp.evaluate("!!document.querySelector('.ov-mask')"))) return true;
    await pressKey(cdp, 'Escape', 'Escape', 27); await sleep(300);
    if (!(await cdp.evaluate("!!document.querySelector('.ov-mask')"))) return true;
    await clickXY(cdp, 6, 6); await sleep(300);
  }
  return !(await cdp.evaluate("!!document.querySelector('.ov-mask')"));
}
/** Markdown 形态切换走真实菜单：Alt → 视图 → Markdown ▸ → 目标项（源码视图/分屏预览/即时渲染/渲染预览）。
 *  菜单交互存在悬停时序竞态（子菜单未及时展开/菜单被重绘）——整段重试一次，避免把门禁抖动记成产品失败。 */
export async function switchMdMode(cdp, label, attempts = 2) {
  for (let attempt = 1; ; attempt++) {
    try { return await switchMdModeOnce(cdp, label); }
    catch (error) {
      await pressKey(cdp, 'Escape', 'Escape', 27).catch(() => {});
      await sleep(350);
      if (attempt >= attempts) throw error;
    }
  }
}

async function switchMdModeOnce(cdp, label) {
  const at = expr => cdp.evaluate(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 } : null; })()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 });
  await sleep(350);
  const view = await at(`[...document.querySelectorAll('.menu-item')].find(e => (e.querySelector('.mi-label')?.textContent ?? e.textContent ?? '').trim().includes('视图'))`);
  if (!view) throw new Error('view menu not visible after Alt');
  await clickXY(cdp, view.x, view.y); await sleep(350);
  const sub = await at(`[...document.querySelectorAll('.menu-dropdown .menu-action.has-sub')].find(e => (e.querySelector('.ma-label')?.textContent ?? '').trim() === 'Markdown')`);
  if (!sub) { await pressKey(cdp, 'Escape', 'Escape', 27); throw new Error('Markdown submenu missing'); }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sub.x, y: sub.y }); await sleep(400);
  const act = await at(`[...document.querySelectorAll('.menu-dropdown.sub .menu-action')].find(e => (e.querySelector('.ma-label')?.textContent ?? '').trim() === ${JSON.stringify(label)} && !e.classList.contains('disabled'))`);
  if (!act) { await pressKey(cdp, 'Escape', 'Escape', 27); throw new Error('mode item missing/disabled: ' + label); }
  await clickXY(cdp, act.x, act.y);
  if (label === '即时渲染') await waitFor(cdp, `!!document.querySelector('.md-ir:not(.md-ir-loading) .cm-content')`, 180000);
}
