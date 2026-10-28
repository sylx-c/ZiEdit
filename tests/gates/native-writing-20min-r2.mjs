// 20 分钟原生连续写作实测：CDP 合成按键持续输入，周期性保存，
// 结束校验：内容完整有序（序号单调）、保存字节一致、撤销可用、进程资源无失控增长。
// 迁移自 docs/tmp/audit-r2/native-writing-20min-r2.mjs（只读源）。整备：① exe/port/清理改用 ./gate-lib.mjs
// 约定（ZIEDIT_GATE_EXE/RUN_DIR），被测文件落 RUN_DIR/files/，结果 JSON 落 <out.json>（可省，默认
// RUN_DIR/results/native-writing-20min.json）；② 原两处 taskkill /F /PID（无 /T，漏杀 WebView2 子进程）
// 统一改 killTree；③ 结束时汇总 out.verdict（序号完整有序 + 保存字节一致 + redo 恢复），退出码随之。
// 用法: node tests/gates/native-writing-20min-r2.mjs [out.json]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import { RUN_DIR, EXE, PORT, killTree } from './gate-lib.mjs';
const dir = path.join(RUN_DIR, 'files');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'writing-20min.md');
const DURATION_MS = 20 * 60 * 1000;
const outFile = path.resolve(process.argv[2] || path.join(RUN_DIR, 'results', 'native-writing-20min.json'));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const out = { started: new Date().toISOString(), build: { exe: EXE, file, durationMs: DURATION_MS, machine: { platform: process.platform, node: process.version } }, samples: [], checks: {} };
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

fs.writeFileSync(file, '# 连续写作测试\n\n');
const child = spawn(EXE, [file], {
  detached: true, stdio: 'ignore', // 可见窗：隐藏窗 getBoundingClientRect 归零破坏 CM6 视口测量（AC36 实证）
  env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(RUN_DIR, 'profiles/write') },
});
child.unref();

async function waitTargets(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page' && t.url.includes('tauri'));
      if (page) return page;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('CDP timeout');
}
const target = await waitTargets(120000);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); const t = pending.get(m.id); if (t) { pending.delete(m.id); clearTimeout(t.tm); m.error ? t.rej(new Error(JSON.stringify(m.error))) : t.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const r = ++id; const tm = setTimeout(() => rej(new Error('timeout ' + method)), 60000); pending.set(r, { res, rej, tm }); ws.send(JSON.stringify({ id: r, method, params })); });
const evaluate = async e => { const v = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (v.exceptionDetails) throw new Error(JSON.stringify(v.exceptionDetails).slice(0, 300)); return v.result.value; };

// 冷 profile 首启「欢迎」模态驱散（T1 判决的测量工件：mask 拦截全部键盘；Esc 与遮罩角落点击交替）
const dismissWelcome = async () => {
  for (let i = 0; i < 5; i++) {
    if (!(await evaluate("!!document.querySelector('.ov-mask')").catch(() => false))) return true;
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    if (!(await evaluate("!!document.querySelector('.ov-mask')").catch(() => false))) return true;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 6, y: 6, button: 'left', clickCount: 1 }).catch(() => {});
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 6, y: 6, button: 'left', clickCount: 1 }).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
  }
  return !(await evaluate("!!document.querySelector('.ov-mask')").catch(() => true));
};

await (async () => { const t0 = Date.now(); for (;;) { if (await evaluate("!!document.querySelector('.cm-content')").catch(() => false)) return; if (Date.now() - t0 > 45000) {
      out.checks.bootDiag = await evaluate(`JSON.stringify({title:document.title, ready:document.readyState, viewarea:!!document.getElementById('viewarea'), tabs:document.getElementById('tabbar')?.children.length??-1, cm:!!document.querySelector('.cm-content'), body:(document.body?.innerText||'').slice(0,150), scripts:document.querySelectorAll('script').length, ls:localStorage.length})`).catch(e => 'diagfail '+e);
      save();
      throw new Error('editor timeout');
    } await new Promise(r => setTimeout(r, 200)); } })();
await new Promise(r => setTimeout(r, 1000));
out.checks.welcomeDismissed = await dismissWelcome();
if (!out.checks.welcomeDismissed) { out.finished = new Date().toISOString(); save(); throw new Error('welcome modal not dismissible — keyboard cannot land (fail-closed)'); }
// 焦点定案插桩：记录窗口/DOM 焦点事件与活动元素漂移
await evaluate(`(() => {
  window.__foc = [];
  const log = m => window.__foc.push({ t: Math.round(performance.now()), m });
  window.addEventListener('focus', () => log('win-focus'));
  window.addEventListener('blur', () => log('win-blur'));
  document.addEventListener('visibilitychange', () => log('vis-' + document.visibilityState));
  let lastEl = null;
  window.__focScan = setInterval(() => {
    const el = document.activeElement;
    const id = el ? (el.className || el.tagName) : 'null';
    if (id !== lastEl) { lastEl = id; log('active=' + String(id).slice(0, 40)); }
  }, 250);
  return 1;
})()`);
// 真实鼠标点击 + DOM 聚焦（两者都做：WebView 拿焦点，CM6 拿 DOM 焦点）
const rect = await evaluate(`(() => { const r = document.querySelector('.cm-content').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 40 }; })()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
await evaluate(`(() => { const v = document.querySelector('.cm-content').cmTile.view; v.dispatch({ selection: { anchor: v.state.doc.length } }); v.focus(); window.__w = { lt: 0, ltMax: 0 }; new PerformanceObserver(l => { for (const e of l.getEntries()) { window.__w.lt++; window.__w.ltMax = Math.max(window.__w.ltMax, Math.round(e.duration)); } }).observe({ type: 'longtask', buffered: false }); return { active: document.activeElement?.className, len: v.state.doc.length }; })()`);

const key = async (ch) => {
  const code = ch.length === 1 && /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : 'Unidentified';
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code });
};
const insert = async (text) => { for (const ch of text) await key(ch); };

const t0 = Date.now();
let sentence = 0;
let lastMem = 0;
let baseLen = await evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.length');
while (Date.now() - t0 < DURATION_MS) {
  sentence++;
  if (sentence % 10 === 1) await evaluate(`(() => { const v = document.querySelector('.cm-content').cmTile.view; v.focus(); return 1; })()`).catch(() => {});
  const line = `第${sentence}句 ZiEdit writing test ${sentence}。`;
  await insert(line);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  if (sentence === 3) {
    const len = await evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.length');
    out.checks.earlyLen = { base: baseLen, after3: len };
    if (len <= baseLen) { out.checks.earlyAbort = 'input not landing'; out.finished = new Date().toISOString(); out.verdict = false; save(); await killTree(child.pid); process.exit(2); }
  }
  if (sentence % 30 === 0) { // 周期性保存
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'S', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'S', code: 'KeyS', modifiers: 2 });
  }
  if (sentence % 20 === 0) {
    try {
      const mem = await run('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid} -ErrorAction Stop).WorkingSet64/1MB`], { timeout: 10000 });
      lastMem = Math.round(parseFloat(mem.stdout.trim()));
    } catch { lastMem = -1; }
    const w = await evaluate('window.__w').catch(() => null);
    const heap = await evaluate('(performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)').catch(() => null);
    out.samples.push({ t: Math.round((Date.now() - t0) / 1000), sentence, memMB: lastMem, heapMB: heap, lt: w?.lt, ltMax: w?.ltMax });
    save();
  }
  await new Promise(r => setTimeout(r, 1200));
}

// 最终校验
out.checks.sentencesTyped = sentence;
out.checks.docTail = await evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.sliceString(-120)');
out.checks.docLen = await evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.length');
// 顺序检查：提取全部 第N句 序号，必须严格递增且无缺失
out.checks.order = await evaluate(`(() => { const doc = document.querySelector('.cm-content').cmTile.view.state.doc.toString(); const ns = [...doc.matchAll(/第(\\d+)句/g)].map(m => +m[1]); let ok = ns.length > 0; for (let i = 1; i < ns.length; i++) if (ns[i] !== ns[i-1] + 1) ok = false; return { count: ns.length, first: ns[0], last: ns[ns.length-1], ordered: ok, expected: ${sentence} }; })()`);
// 保存并字节比对
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'S', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'S', code: 'KeyS', modifiers: 2 });
await new Promise(r => setTimeout(r, 1500));
const disk = fs.readFileSync(file, 'utf8');
const inEditor = await evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.toString()');
out.checks.saveMatchesDisk = disk.replaceAll('\r\n', '\n') === inEditor;
out.checks.dirtyAfterSave = await evaluate('!!document.querySelector(".tab-dot")');
// 撤销一步
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Z', code: 'KeyZ', modifiers: 2 });
await new Promise(r => setTimeout(r, 500));
out.checks.undoTail = await evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.sliceString(-60)');
// 撤销栈健康：redo 恢复 + 再连续 undo 三步不异常
const preUndoLen = out.checks.docLen;
out.checks.redoLen = await (async () => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Y', code: 'KeyY', modifiers: 2, windowsVirtualKeyCode: 89 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Y', code: 'KeyY', modifiers: 2 });
  await new Promise(r => setTimeout(r, 500));
  return evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.length');
})();
out.checks.redoRestored = out.checks.redoLen === preUndoLen;
out.checks.undo3 = await (async () => {
  for (let i = 0; i < 3; i++) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Z', code: 'KeyZ', modifiers: 2 });
    await new Promise(r => setTimeout(r, 300));
  }
  return evaluate('document.querySelector(".cm-content").cmTile.view.state.doc.sliceString(-60)');
})();
out.checks.finalLongtasks = await evaluate('window.__w');
out.checks.focusLog = await evaluate('window.__foc');
out.finished = new Date().toISOString();
// 汇总 verdict（供 run-all.mjs 汇总）：序号完整有序 + 保存字节一致 + redo 恢复
out.verdict = out.checks.sentencesTyped > 0
  && out.checks.order?.ordered === true && out.checks.order?.count === out.checks.order?.expected
  && out.checks.saveMatchesDisk === true
  && out.checks.redoRestored === true;
save();
console.log(JSON.stringify({ verdict: out.verdict, checks: out.checks }, null, 2));
await killTree(child.pid);
process.exitCode = out.verdict ? 0 : 1;
