// gate-walk-f.mjs — T2「F 类走查：三面一致 × 四主题逐组合」矩阵门禁
// 迁移自 docs/tmp/audit-r2/gate-walk-f.mjs（只读源）。整备：profile 落 RUN_DIR/profiles/walkf，
// 截屏落 RUN_DIR/shots/f-matrix；其余口径不变。
// 用法: node tests/gates/gate-walk-f.mjs <corpus.md> <out.json>
// 语料校验（同 gate-batch1-scroll.mjs 口径）：$$ ≥10 且表格分隔行 |--- ≥10，不足即报错退出并提示 gen-corpus.mjs；
// 另加 ≤2MiB 闸（分屏/IR 准入上限，007 v0.15 规则 6，src/common/mode.ts:48/98），超了split/wysiwyg 会被置灰。
//
// ── 切换实现依据（侦察结论，2026-10-22，只读）──
// 主题切换：
// src/shell/chrome.ts:673-679 `export function applyTheme(key)` —
// documentElement.classList 去 th-paper/th-cool/th-graphite/th-black、加 `th-${key}`，并
// setAttribute('data-tone', tone)。主题类与 data-tone 均挂 <html>。
// 主题清单：chrome.ts:665-670 THEMES = paper(light)/cool(light)/graphite(dark)/black(dark)；
// 令牌口径见 docs/design/README.md「色彩令牌」节（th-<key> + data-tone 挂 <html>）。
// 产品内路径：app.ts:3966-3972 `view.theme` → openThemeDialog → applyTheme；
// app.ts:3971 注释明确「CM6 即时渲染直接使用主题令牌；重挂会丢光标」——主题只换 CSS 令牌不换几何（判据 2 依据）。
// CDP 最短路径：Runtime.evaluate 直接复刻 applyTheme 三行 DOM 操作（等效、零副作用、不经对话框）。
// 形态切换（Markdown 三形态 = 源码'edit' / 分屏'split' / 即时渲染'wysiwyg'；独立预览 'md' v2.6 已删，
// 见 src/shell/app.ts:169-170 与 src/common/mode.ts:5-9）：
// 动作注册表 app.ts:3742-3750：view.mdSource / view.mdSplit / view.mdWysiwyg → run: () => mdMode(m)；
// mdMode（app.ts:3158-3162）→ setMode(tab, m)（app.ts:453-457：modeMap.set + render()）。
// 工具栏 seg 按钮同口径：app.ts:3846-3849 注册 tbmd.source / tbmd.split / tbmd.ir；
// buildToolbar（chrome.ts:429）把 id 写进 button[data-action]，chrome.ts:432-434 click → reg.run(id)。
// CDP 最短路径：真实鼠标点击 `button[data-action="tbmd.source|tbmd.split|tbmd.ir"]`（与用户操作同构，
// 避开内联 evaluate 无法 import applyTheme/mdMode 模块的问题；快捷键注册表 001 规则 34 无三形态快捷键）。
//
// ── DOM 签名选择器清单（侦察结论，写死）──
// 源码 edit  ：.cm-content > .cm-line（CM6 行盒；gate-lib waitMounted 已验证 .cm-content 挂载）。
// 分屏 split ：挂载结构 app.ts:1584-1590：.md-split > (.md-split-src | .md-split-preview)；
// 签名取右栏 .md-split-preview .md-col > .md-block —— blockcache.ts:229-245 每顶层块一个 .md-block 容器
// （styles.css:908 `.md-preview .md-col>.md-block{display:contents}`，几何取各 .md-block 首个有盒子的子元素）。
// 即时渲染 IR：livepreview.ts:1411 host.classList.add('md-ir')（host=#viewarea）；
// 签名取 .md-ir .cm-content > .cm-line（styles.css:1317-1323 .md-ir 行/块样式组）。
// 「未生效」特征（fail-closed，切换后校验）：
// edit → 有 .cm-content 且无 .md-split / .md-ir；split → 有 .md-split-preview .md-col；
// wysiwyg → 有 .md-ir .cm-content。
//
// 判据（fail-closed，逐条 verdict/reasons）：
// 1) 12/12 组合挂载成功且全程零 JS error（window.__gate.errors，INIT_OBSERVERS 口径）；
// 2) 同一形态跨 4 主题：块级几何序列完全一致（块数相等 + 逐块 top/height 差 ≤1px）——主题只换颜色不换几何；
// 3) 每形态首个主题组合截屏存在且 >10KiB（PNG 字节数粗判非空白/非纯色，纯色 960×600 PNG 通常 <5KiB；
// 仅粗判，最终观感以人看 RUN_DIR/shots/f-matrix/*.png 为准）。
// 跨形态一致性只出数据（三组签名序列入 JSON）不下 pass/fail——三面语义差异由人判读（AC-38 口径）。
// 结束 taskkill /F /T 清理；欢迎模态驱散循环复制自 gate-batch1-arrow.mjs（Esc 与遮罩角落点击交替，最多 5 轮）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RUN_DIR, EXE, PORT, GATE_ENV, GATE_BUDGET, INIT_OBSERVERS, connectCDP, waitTargets, waitMounted, killTree } from './gate-lib.mjs';

const corpusArg = process.argv[2];
const outFileArg = process.argv[3];
if (!corpusArg || !outFileArg) { console.error('用法: node tests/gates/gate-walk-f.mjs <corpus.md> <out.json>'); process.exit(1); }
const corpus = path.resolve(corpusArg);
const outFile = path.resolve(outFileArg);
const webviewDir = path.join(RUN_DIR, 'profiles/walkf');
const shotsDir = path.join(RUN_DIR, 'shots', 'f-matrix');
fs.mkdirSync(shotsDir, { recursive: true });

// —— 语料校验（同 scroll 门禁口径 + 2MiB 准入闸）——
const text = fs.readFileSync(corpus, 'utf8');
const corpusStats = {
  bytes: Buffer.byteLength(text, 'utf8'),
  dollars: (text.match(/\$\$/g) || []).length,
  tables: (text.match(/^\|[-\s|]*---/gm) || []).length,
};
if (corpusStats.dollars < 10 || corpusStats.tables < 10) {
  const msg = `语料公式/表格不足（$$=${corpusStats.dollars}, |---=${corpusStats.tables}，各需 ≥10）。用 gen-corpus.mjs 生成密集语料。`;
  fs.writeFileSync(outFile, JSON.stringify({ verdict: false, fatal: msg, corpus, corpusStats }, null, 2));
  console.error(msg); process.exit(1);
}
if (corpusStats.bytes > 2 * 1024 * 1024) {
  const msg = `语料 ${corpusStats.bytes}B 超 2MiB，分屏/IR 准入闸会置灰（007 v0.15 规则 6）。换 ≤2MiB 语料（gen-corpus.mjs 控制体量）。`;
  fs.writeFileSync(outFile, JSON.stringify({ verdict: false, fatal: msg, corpus, corpusStats }, null, 2));
  console.error(msg); process.exit(1);
}

const MODES = ['edit', 'split', 'wysiwyg'];   // 形态序：源码 → 分屏 → IR（mode-major，便于判据 2 逐形态对比）
const THEMES = ['paper', 'cool', 'graphite', 'black']; // chrome.ts:665-670 THEMES
const THEME_TONE = { paper: 'light', cool: 'light', graphite: 'dark', black: 'dark' };
// 形态切换：见下方 switchMode（Alt 菜单真实路径；工具栏常驻隐藏，tbmd.* 按钮默认不在 DOM）

const out = {
  build: { exe: EXE, environment: GATE_ENV, budgets: GATE_BUDGET, corpus, corpusBytes: corpusStats.bytes, corpusStats, port: PORT, machine: { platform: process.platform, node: process.version } },
  basis: {
    theme: 'chrome.ts:673-679 applyTheme → <html> class th-<key> + data-tone（CDP evaluate 复刻三行）',
    mode: 'app.ts:3846-3849 工具栏 tbmd.source/split/ir → chrome.ts:432-434 click→reg.run → app.ts:3158 mdMode → app.ts:453 setMode（CDP 真实鼠标点击 button[data-action]）',
    selectors: { edit: '.cm-content > .cm-line', split: '.md-split-preview .md-col > .md-block', wysiwyg: '.md-ir .cm-content > .cm-line' },
  },
  combos: [], criteria: [],
};
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

// applyTheme（chrome.ts:673-679）同口径：主题类与 data-tone 均挂 <html>
const themeExpr = key => `(() => { const r = document.documentElement; r.classList.remove('th-paper','th-cool','th-graphite','th-black'); r.classList.add('th-${key}'); r.setAttribute('data-tone','${THEME_TONE[key]}'); return { cls: r.className, tone: r.getAttribute('data-tone') }; })()`;

// 渲染稳定等待：rAF 连续 10 帧 <32ms 或 800ms 上限（awaitPromise 由 gate-lib evaluate 承担）
const WAIT_STABLE = `
new Promise(resolve => {
  const t0 = performance.now(); let streak = 0, frames = 0, last = performance.now();
  const tick = t => {
    frames++; const d = t - last; last = t;
    streak = d < ${GATE_BUDGET.walkFrameMs} ? streak + 1 : 0;
    if (streak >= 10 || t - t0 > ${GATE_BUDGET.walkStableMs}) return resolve({ frames, ms: Math.round(t - t0), streak });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`;

// 块级签名：容器相对坐标（scrollTop=0 口径；切主题不重建 DOM/不重排期望——判据 2）
// 返回 [{tag, cls, hash, top, height}]；cls 截断 60 字符；hash = djb2(textContent 前 120 字符)
const SIGNATURE = `
(sel => {
  const djb2 = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
  const els = [...document.querySelectorAll(sel)];
  if (!els.length) return { sel, n: 0, blocks: [] };
  // display:contents 容器（split 的 .md-block，styles.css:908）无自身盒子——取首个有高度的后代盒子
  const boxOf = el => {
    let r = el.getBoundingClientRect();
    if (r.height > 0 || r.width > 0) return { r, host: el };
    const kid = el.querySelector(':scope > *');
    if (!kid) return { r, host: el };
    r = kid.getBoundingClientRect();
    return { r, host: kid };
  };
  const scroller = els[0].closest('.cm-scroller') || els[0].closest('.md-split-preview') || els[0].parentElement;
  const base = scroller.getBoundingClientRect().top;
  const blocks = els.map(el => {
    const { r } = boxOf(el);
    // 水易变内容剔除：含公式/图表占位（.md-render-target）的块，其 textContent 会随 MathJax/Mermaid
    // 异步回填变化（T3-A 真机判例：block 758 hash qq5ptj→75js52 即水合前后采样差）——此类块只签
    // tag/cls/几何，hash 置 'volatile'，跨主题一致性判据不受水合时序影响。
    const volatile = !!el.querySelector('.md-render-target');
    return {
      tag: el.tagName.toLowerCase(),
      cls: String(el.className.baseVal ?? el.className).slice(0, 60),
      hash: volatile ? 'volatile' : djb2((el.textContent || '').slice(0, 120)),
      top: Math.round((r.top - base) * 100) / 100,
      height: Math.round(r.height * 100) / 100,
    };
  });
  return { sel, n: blocks.length, blocks };
})`;

// 形态生效特征（fail-closed）：切换后 DOM 必须有对应节点，缺即该组合 FAIL
const FEATURE = {
  edit: `!!document.querySelector('.cm-content') && !document.querySelector('.md-split') && !document.querySelector('.md-ir')`,
  split: `!!document.querySelector('.md-split .md-split-preview .md-col')`,
  wysiwyg: `!!document.querySelector('.md-ir .cm-content')`,
};
const SIGN_SEL = {
  edit: '.cm-content > .cm-line',
  split: '.md-split-preview .md-col > .md-block',
  wysiwyg: '.md-ir .cm-content > .cm-line',
};

// 形态切换走真实用户路径：Alt 呼出菜单栏（app.ts:419 menubarCtl 注释「Alt 按键 open 用」）→
// 点「视图」菜单 → 点目标模式项（.menu-action 的 .ma-label 文本，i18n.ts:88-90：
// 源码视图/分屏预览/即时渲染；菜单项无 data-action，经 chrome.ts:291-296 click→reg.run）。
// 工具栏路径不可用：007 规则 2「工具栏常驻隐藏」，tbmd.* 按钮默认不在 DOM（首轮实测 selector missing）。
const MODE_LABEL = { edit: '源码视图', split: '分屏预览', wysiwyg: '即时渲染' };
async function clickXY(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function switchMode(cdp, label) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 });
  await new Promise(r => setTimeout(r, 350));
  const view = await cdp.evaluate(`(() => { const el = [...document.querySelectorAll('.menu-item')].find(e => ((e.querySelector('.mi-label')?.textContent ?? e.textContent ?? '').trim().includes('视图'))); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
  if (!view) return { clicked: false, reason: 'menubar view menu not visible after Alt' };
  await clickXY(cdp, view.x, view.y);
  await new Promise(r => setTimeout(r, 350));
  // Markdown 子菜单（app.ts:224 label 'menu.markdown'→i18n「Markdown」）：mouseenter 填充（chrome.ts:264），
  // CDP 以 mouseMoved 触发 hover 展开
  const sub = await cdp.evaluate(`(() => { const el = [...document.querySelectorAll('.menu-dropdown .menu-action.has-sub')].find(e => (e.querySelector('.ma-label')?.textContent ?? '').trim() === 'Markdown'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 }; })()`);
  if (!sub) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    return { clicked: false, reason: 'Markdown submenu entry not found' };
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sub.x, y: sub.y });
  await new Promise(r => setTimeout(r, 400));
  const act = await cdp.evaluate(`(() => { const el = [...document.querySelectorAll('.menu-dropdown.sub .menu-action')].find(e => (e.querySelector('.ma-label')?.textContent ?? '').trim() === '${label}'); if (!el || el.classList.contains('disabled')) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!act) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    return { clicked: false, reason: `menu item not found/disabled: ${label}` };
  }
  await clickXY(cdp, act.x, act.y);
  return { clicked: true };
}

// 真实鼠标点击元素中心（备用；chrome.ts:432-434 click → reg.run(id)）
async function clickEl(cdp, selector) {
  const rect = await cdp.evaluate(`(() => { const el = document.querySelector('${selector}'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: !!el.disabled }; })()`);
  if (!rect) return { clicked: false, reason: 'selector missing: ' + selector };
  if (rect.disabled) return { clicked: false, reason: 'button disabled: ' + selector };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  return { clicked: true };
}

(async () => {
  const child = spawn(EXE, [corpus], {
    detached: true, stdio: 'ignore', // 可见窗口（native-gate-ac36 实证：隐藏窗视口测量失真）
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: webviewDir },
  });
  child.unref();
  try {
    const target = await waitTargets(30000);
    const cdp = await connectCDP(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await waitMounted(cdp);
    await cdp.evaluate(INIT_OBSERVERS);
    await new Promise(r => setTimeout(r, 3000)); // 挂载期异步跑完

    // 欢迎模态驱散循环（复制自 gate-batch1-arrow.mjs，T1 判决：冷 profile 首启模态拦截键盘）
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
    out.welcome = { dismissed: welcomeGone }; save();
    if (!welcomeGone) throw new Error('welcome/overlay modal not dismissible (fail-closed)');

    // observer 注册校验（fail-closed）
    const obsOk = await cdp.evaluate(`!!(window.__gate && Array.isArray(window.__gate.errors))`);
    if (!obsOk) throw new Error('observer not registered (window.__gate missing)');

    // 语料默认可能以源码形态打开（app.ts:3099/3867 默认 edit）；矩阵从 edit 起步即可，切形态幂等
    for (const mode of MODES) {
      for (const theme of THEMES) {
        const rec = { mode, theme };
        out.combos.push(rec); save();
        try {
          // ① 切形态：Alt 菜单真实路径（工具栏常驻隐藏不可用，见 switchMode 注释）
          const clk = await switchMode(cdp, MODE_LABEL[mode]);
          if (!clk.clicked) throw new Error('mode switch failed: ' + clk.reason);
          // 形态挂载等待：特征节点出现（分屏右栏渲染为异步+防抖，上限 20s；源码/IR 秒级）
          const t0 = Date.now();
          let modeOk = false;
          while (Date.now() - t0 < 20000) {
            modeOk = await cdp.evaluate(FEATURE[mode]).catch(() => false);
            if (modeOk) break;
            await new Promise(r => setTimeout(r, 200));
          }
          if (!modeOk) throw new Error(`mode feature missing after switch (${mode}; 特征: ${FEATURE[mode]})`);
          rec.modeSwitchMs = Date.now() - t0;

          // ② 切主题：applyTheme 同口径三行（chrome.ts:673-679）
          rec.themeApplied = await cdp.evaluate(themeExpr(theme));

          // ③ 等渲染稳定：rAF 连续 10 帧 <32ms 或 800ms 上限
          rec.stable = await cdp.evaluate(WAIT_STABLE);
          // ③b split 面额外等渐进填充平台 + 水合稳定：块数稳定且公式目标全部处于
          // done/pending 终态（T3-B 起水合按视口邻域触发——远端目标合法停在 pending，
          // 「滚动到哪排版到哪」；平台=无 loading/未触达态且分布连续两次采样不变）。
          if (mode === 'split') {
            const tFill = Date.now();
            let plateau = false, prevB = -1, prevH = -1;
            while (Date.now() - tFill < 240000) {
              const s = await cdp.evaluate(`(() => { const total = document.querySelectorAll('.md-split-preview .md-render-target').length; return { b: document.querySelectorAll('.md-split-preview .md-block').length, h: document.querySelectorAll('.md-split-preview .md-render-target[data-render-done]').length + document.querySelectorAll('.md-split-preview .md-render-target[data-render-pending]').length, total }; })()`).catch(() => null);
              if (s && s.b > 0 && s.b === prevB && (s.total === 0 || (s.h >= s.total && s.h === prevH))) { plateau = true; break; }
              prevB = s?.b ?? -1; prevH = s?.h ?? -1;
              await new Promise(r => setTimeout(r, 500));
            }
            rec.fillPlateau = plateau;
            if (!plateau) throw new Error('split progressive fill/hydration did not plateau within 240s');
          }

          // ④a 截屏
          const shotFile = path.join(shotsDir, `${mode}-${theme}.png`);
          const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));
          rec.shot = { file: path.relative(RUN_DIR, shotFile), bytes: fs.statSync(shotFile).size };

          // ④b 块级签名（容器相对坐标）
          rec.signature = await cdp.evaluate(`(${SIGNATURE})(${JSON.stringify(SIGN_SEL[mode])})`);
          rec.errors = (await cdp.evaluate('window.__gate.errors.slice()')) || [];
          rec.ok = true;
        } catch (e) {
          rec.ok = false;
          rec.error = String(e.message || e);
        }
        save();
      }
    }

    // —— 判据（fail-closed，逐条 verdict/reasons）——
    const okCombos = out.combos.filter(c => c.ok);
    // C1：12/12 挂载成功 + 零 JS error
    {
      const reasons = [];
      const noSig = okCombos.filter(c => !c.signature || c.signature.n === 0);
      for (const c of out.combos) if (!c.ok) reasons.push(`${c.mode}-${c.theme}: ${c.error}`);
      for (const c of noSig) reasons.push(`${c.mode}-${c.theme}: empty signature`);
      const errCombos = okCombos.filter(c => c.errors.length > 0);
      for (const c of errCombos) reasons.push(`${c.mode}-${c.theme}: JS errors × ${c.errors.length} (${c.errors[0]?.slice(0, 120)})`);
      out.criteria.push({ id: 'C1', desc: '12/12 组合挂载成功、签名非空、零 JS error', verdict: reasons.length === 0, reasons });
    }
    // C2：同形态跨 4 主题几何序列一致（top/height 逐块 ≤1px；tag/cls/hash 也要一致——DOM 结构不该随主题变）
    for (const mode of MODES) {
      const combos = okCombos.filter(c => c.mode === mode && c.signature && c.signature.n > 0);
      const reasons = [];
      if (combos.length !== THEMES.length) {
        reasons.push(`only ${combos.length}/${THEMES.length} themes have signatures`);
      } else {
        const base = combos[0].signature.blocks;
        for (const c of combos.slice(1)) {
          const b2 = c.signature.blocks;
          if (b2.length !== base.length) { reasons.push(`${c.theme}: block count ${b2.length} != ${combos[0].theme} ${base.length}`); continue; }
          let worst = null;
          for (let i = 0; i < base.length; i++) {
            const a = base[i], b = b2[i];
            const dt = Math.abs(a.top - b.top), dh = Math.abs(a.height - b.height);
            if (dt > 1 || dh > 1) { if (!worst || dt + dh > worst.d) worst = { d: dt + dh, i, dt: +dt.toFixed(2), dh: +dh.toFixed(2) }; }
            if (a.tag !== b.tag || a.cls !== b.cls || a.hash !== b.hash) {
              reasons.push(`${c.theme}: block ${i} identity differs (tag/cls/hash)`); break;
            }
          }
          if (worst) reasons.push(`${c.theme}: geometry drift block ${worst.i} dTop=${worst.dt} dH=${worst.dh} (>1px)`);
        }
      }
      out.criteria.push({ id: 'C2-' + mode, desc: `${mode} 跨 4 主题块级几何序列一致（≤1px）`, verdict: reasons.length === 0, reasons });
    }
    // C3：每形态首个主题截屏存在且 >10KiB（PNG 字节粗判非空白/纯色；注释见头）
    {
      const reasons = [];
      for (const mode of MODES) {
        const c = out.combos.find(x => x.mode === mode && x.theme === THEMES[0]);
        if (!c?.shot || !(c.shot.bytes > 10 * 1024)) reasons.push(`${mode}-${THEMES[0]}: shot missing or <=10KiB (${c?.shot?.bytes ?? 0}B)`);
      }
      out.criteria.push({ id: 'C3', desc: '每形态首主题截屏存在且 >10KiB（粗判非空白）', verdict: reasons.length === 0, reasons });
    }
    // 跨形态签名只出数据不下判（AC-38 口径：三面语义差异由人判读）
    out.crossModeSignatures = Object.fromEntries(MODES.map(m => {
      const c = out.combos.find(x => x.mode === m && x.ok && x.signature);
      return [m, c ? { theme: c.theme, n: c.signature.n, blocks: c.signature.blocks } : null];
    }));

    out.verdict = out.criteria.every(c => c.verdict);
    save();
    await cdp.close();
    console.log(JSON.stringify({ verdict: out.verdict, criteria: out.criteria.map(c => ({ id: c.id, verdict: c.verdict, reasons: c.reasons.slice(0, 5) })) }, null, 2));
    process.exitCode = out.verdict ? 0 : 1;
  } finally {
    await killTree(child.pid);
  }
})().catch(async e => {
  out.fatal = String(e.stack || e); out.verdict = false; save();
  console.error(e); process.exit(1);
});
