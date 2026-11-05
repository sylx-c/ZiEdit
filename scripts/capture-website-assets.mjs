import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { connectCDP } from '../tests/gates/gate-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = 'compliance/asset-provenance/website/';
const executable = path.resolve(process.env.ZIEDIT_WEBSITE_EXE ?? path.join(root, 'docs/tmp/visual-review/ziedit-review.exe'));
const port = Number(process.env.ZIEDIT_WEBSITE_CDP_PORT ?? 9223);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const abs = relative => path.join(root, relative);
const read = relative => fs.readFileSync(abs(relative));
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const record = file => ({ path: relative(file), bytes: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) });
const saveJson = (file, value) => { fs.mkdirSync(path.dirname(abs(file)), { recursive: true }); fs.writeFileSync(abs(file), JSON.stringify(value, null, 2) + '\n'); };
const pngSize = bytes => { assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Not a PNG'); return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }; };
const examples = {
  zh: { text: '工作笔记.txt', code: '任务清单.ts', markdown: '写作手册.md', language: 'zh-CN' },
  en: { text: 'workspace-notes.txt', code: 'task-list.ts', markdown: 'writing-guide.md', language: 'en-US' },
};

function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    assert(!entry.isSymbolicLink(), 'No symlink capture inputs');
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  }).sort();
}
async function assertPortFree(number) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${number} is already in use; refusing to attach to an unrelated process`)));
    server.listen(number, '127.0.0.1', () => server.close(resolve));
  });
}
async function targetAt(number, predicate, timeout = 45000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${number}/json/list`);
      const found = (await response.json()).find(predicate);
      if (found) return found;
    } catch {}
    await pause(100);
  }
  throw new Error(`No matching CDP target on ${number}`);
}
async function waitFor(cdp, expression, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await cdp.evaluate(expression).catch(() => false)) return;
    await pause(100);
  }
  const state = await cdp.evaluate("({url:location.href,title:document.title,lang:document.documentElement.lang,tabs:[...document.querySelectorAll('#tabbar .tab')].map(e=>e.innerText),body:document.body.innerText.slice(0,2400)})").catch(() => null);
  throw new Error('UI did not reach expected real state: ' + expression + '\n' + JSON.stringify(state));
}
async function settle(cdp) {
  await cdp.evaluate('document.fonts.ready');
  await cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await pause(500);
}
async function stopOwned(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform !== 'win32') { child.kill('SIGTERM'); return; }
  const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await new Promise(resolve => killer.once('exit', resolve));
}
async function invoke(cdp, name, args = {}) {
  return cdp.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`);
}
async function click(cdp, expression) {
  const result = await cdp.evaluate(`(()=>{const element=(${expression});if(!element)return false;element.click();return true;})()`);
  assert(result, 'Missing real control: ' + expression);
}
async function closeWelcome(cdp) {
  await cdp.evaluate("[...document.querySelectorAll('.welcome-box button')].find(e=>/开始使用|Get started/.test(e.textContent))?.click()");
}
async function capture(cdp, output, expected) {
  await settle(cdp);
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const bytes = Buffer.from(result.data, 'base64');
  const dimensions = pngSize(bytes);
  assert.deepEqual(dimensions, expected, `Unexpected native capture dimensions at ${output}; resize the real window, do not scale the bitmap`);
  fs.mkdirSync(path.dirname(abs(output)), { recursive: true });
  fs.writeFileSync(abs(output), bytes);
  return { ...record(abs(output)), ...dimensions };
}
async function applicationAssets(cdp) {
  const assets = await cdp.evaluate(`(async()=>{const urls=[...new Set([...document.querySelectorAll('script[src],link[rel="stylesheet"]')].map(e=>e.src||e.href).concat(performance.getEntriesByType('resource').map(e=>e.name)))].filter(url=>url.startsWith(location.origin+'/')&&/\\.(?:js|css|woff2?)(?:$|\\?)/.test(url));return Promise.all(urls.sort().map(async url=>{const response=await fetch(url);if(!response.ok)throw Error('Missing app asset '+url);const bytes=await response.arrayBuffer();const hash=await crypto.subtle.digest('SHA-256',bytes);return {url,path:new URL(url).pathname,bytes:bytes.byteLength,sha256:[...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join('')};}));})()`);
  return assets.map(asset => {
    const currentDist = abs('dist/' + decodeURIComponent(asset.path.replace(/^\//, '')));
    return { ...asset, matchesCurrentDist: fs.existsSync(currentDist) && sha(fs.readFileSync(currentDist)) === asset.sha256 };
  });
}

async function nativeCapture() {
  assert(process.platform === 'win32', 'Native capture currently documents the Windows review build');
  assert.equal(path.basename(executable).toLowerCase(), 'ziedit-review.exe', 'Use a separately identified review executable, never the installed application');
  assert(fs.existsSync(executable), 'Review executable missing');
  await assertPortFree(port);
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'ziedit-website-capture-'));
  const results = [];
  const build = { executable: record(executable), currentDistSnapshot: files(abs('dist')).map(record),
    note: 'Current dist is recorded independently. Only loaded application assets whose hashes match may be identified with it; no claim that current dist is embedded in this older review executable.' };
  let loadedAssets = [];
  for (const [locale, spec] of Object.entries(examples)) {
    let child, cdp;
    const sampleDir = abs(evidence + 'examples/' + locale);
    const sampleFiles = ['text', 'code', 'markdown'].map(kind => path.join(sampleDir, spec[kind]));
    for (const file of sampleFiles) assert(fs.existsSync(file));
    try {
      const profile = path.join(runtime, locale);
      fs.mkdirSync(profile, { recursive: true });
      child = spawn(executable, sampleFiles, { stdio: 'ignore', windowsHide: false,
        env: { ...process.env, APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'),
          WEBVIEW2_USER_DATA_FOLDER: path.join(profile, 'WebView2'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } });
      const target = await targetAt(port, item => item.type === 'page' && item.url.startsWith('http://tauri.localhost'));
      cdp = await connectCDP(target.webSocketDebuggerUrl);
      await waitFor(cdp, "!!window.__TAURI_INTERNALS__ && document.querySelectorAll('#tabbar .tab').length>0");
      await closeWelcome(cdp);
      // Windows Known Folder APIs can retain the separately identified review profile
      // despite APPDATA overrides. Close only stale review tabs through real controls.
      const previousNames = await cdp.evaluate("[...document.querySelectorAll('#tabbar .tab-name')].map(e=>e.textContent)");
      for (const name of previousNames.filter(name => !['text', 'code', 'markdown'].some(kind => spec[kind] === name))) {
        await click(cdp, `[...document.querySelectorAll('#tabbar .tab')].find(e=>e.querySelector('.tab-name')?.textContent===${JSON.stringify(name)})?.querySelector('.tab-close')`);
      }
      await waitFor(cdp, "document.querySelectorAll('#tabbar .tab').length===3");
      const settings = await invoke(cdp, 'settings_load');
      // Ordinary settings IPC + application reload; no stylesheet/DOM fabrication.
      await invoke(cdp, 'settings_save', { settings: { ...settings, language: spec.language, theme: 'paper', mdDefaultMode: 'preview' } });
      await cdp.send('Page.reload');
      const expectedMenu = locale === 'en' ? 'File' : '文件';
      await waitFor(cdp, `document.querySelector('#menubar .menu-item')?.innerText.startsWith(${JSON.stringify(expectedMenu)}) && document.querySelectorAll('#tabbar .tab').length===3`);
      await closeWelcome(cdp);
      for (const kind of ['text', 'code', 'markdown']) {
        const name = spec[kind];
        await click(cdp, `[...document.querySelectorAll('#tabbar .tab')].find(e=>e.querySelector('.tab-name')?.textContent===${JSON.stringify(name)})`);
        await waitFor(cdp, `document.querySelector('#tabbar .tab.active .tab-name')?.textContent===${JSON.stringify(name)}`);
        await waitFor(cdp, kind === 'markdown' ? "!!document.querySelector('.md-preview .md-col h1')" : "!!document.querySelector('.cm-content')");
        const state = await cdp.evaluate(`({url:location.href,title:document.title,language:document.documentElement.lang,theme:document.documentElement.className,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},active:document.querySelector('.tab.active')?.title,mode:document.querySelector('.mode-cell')?.textContent,sidebar:document.querySelector('#sidebar')?.innerText,dialogs:document.querySelectorAll('.ov-mask').length})`);
        state.selectedLanguage = (await invoke(cdp, 'settings_load')).language;
        assert.equal(state.selectedLanguage, spec.language);
        assert.equal(state.dialogs, 0, 'An overlay would conceal the application');
        assert(state.active.includes(name), 'Active file mismatch');
        const raw = await capture(cdp, evidence + `raw/${locale}/${kind}.png`, { width: 1600, height: 1040 });
        const destination = `website/shots/${locale}/${kind}.png`;
        fs.copyFileSync(abs(raw.path), abs(destination));
        results.push({ locale, kind, sample: record(path.join(sampleDir, name)), state, raw, published: record(abs(destination)), method: 'Unmodified real Tauri WebView2 Page.captureScreenshot; byte-for-byte copy, no cropping, bitmap resizing, DOM composition or stylesheet injection.' });
      }
      loadedAssets.push({ locale, assets: await applicationAssets(cdp) });
      console.log('Captured real native website images: ' + locale);
    } finally {
      cdp?.close();
      await stopOwned(child);
    }
    await pause(500);
    await assertPortFree(port);
  }
  saveJson(evidence + 'native-capture.json', { schema: 1, capturedAt: new Date().toISOString(),
    origin: 'New capture in this remediation session; historical screenshots are replaced, not retroactively attributed.',
    authorship: 'Sample text and code newly written for ZiEdit in this session; no external article, sample code, image or real personal/project data was copied. Project MIT license applies to these new contributions; depicted application components retain their own notices.',
    script: record(abs('scripts/capture-website-assets.mjs')), host: { platform: os.platform(), release: os.release(), architecture: os.arch() },
    isolation: 'Separately identified dev.ziedit.visual-review executable/profile; fresh per-language WEBVIEW2_USER_DATA_FOLDER. APPDATA/LOCALAPPDATA overrides are requested but Windows Known Folder APIs may retain the review configuration; stale review tabs are closed via real controls. Only owned child PIDs are stopped. Installed dev.ziedit.app is not attached, reconfigured or closed.',
    build, loadedAssets, results });
}

async function ogCapture() {
  const edge = process.env.ZIEDIT_WEBSITE_BROWSER ?? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(file => fs.existsSync(file));
  assert(edge && fs.existsSync(edge), 'Set ZIEDIT_WEBSITE_BROWSER to a local Chromium/Edge executable');
  const browserPort = 9224;
  await assertPortFree(browserPort);
  const site = abs('website');
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(site, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(site + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
    const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(file)] ?? 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': mime }); fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ziedit-website-og-'));
  let child, cdp;
  try {
    child = spawn(edge, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${browserPort}`, `--user-data-dir=${profile}`, url], { stdio: 'ignore', windowsHide: true });
    const target = await targetAt(browserPort, item => item.type === 'page');
    cdp = await connectCDP(target.webSocketDebuggerUrl);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1262, height: 624, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url });
    await waitFor(cdp, "document.readyState==='complete' && [...document.images].every(image=>image.complete && image.naturalWidth>0)");
    await click(cdp, "document.querySelector('[data-set-lang=zh]')");
    const raw = await capture(cdp, evidence + 'raw/og.png', { width: 1262, height: 624 });
    fs.copyFileSync(abs(raw.path), abs('website/og.png'));
    const inputs = files(site).filter(file => relative(file) !== 'website/og.png').map(record);
    saveJson(evidence + 'og-capture.json', { schema: 1, capturedAt: new Date().toISOString(),
      origin: 'New real website first-viewport capture in this remediation session. No DOM/CSS injection, composition or image resampling.',
      script: record(abs('scripts/capture-website-assets.mjs')), browser: record(edge), browserVersion: await cdp.send('Browser.getVersion'),
      viewport: { width: 1262, height: 624, dpr: 1 }, servedOrigin: 'Ephemeral loopback static server for repository website only; no use of port 1420 or DSH.',
      inputs, raw, published: record(abs('website/og.png')) });
  } finally {
    cdp?.close(); await stopOwned(child); await new Promise(resolve => server.close(resolve));
  }
}

function verify() {
  for (const file of ['native-capture.json', 'og-capture.json']) {
    const report = JSON.parse(read(evidence + file));
    assert.equal(record(abs('scripts/capture-website-assets.mjs')).sha256, report.script.sha256, `Capture script changed since ${file}; recapture or explicitly audit the difference`);
    const pairs = report.results ?? [report];
    for (const pair of pairs) {
      for (const item of [pair.raw, pair.published, ...(pair.sample ? [pair.sample] : [])]) assert.deepEqual(record(abs(item.path)), { path: item.path, bytes: item.bytes, sha256: item.sha256 });
      assert.equal(pair.raw.sha256, pair.published.sha256, 'Published image differs from the raw capture');
    }
    if (report.inputs) for (const item of report.inputs) assert.deepEqual(record(abs(item.path)), item, 'Website inputs changed after OG capture: ' + item.path);
  }
  console.log('Website samples, six native images, OG image, raw copies and capture receipts verified. Historical assets are not covered by these new receipts.');
}

const command = process.argv[2];
try {
  if (command === '--native') await nativeCapture();
  else if (command === '--og') await ogCapture();
  else if (command === '--verify') verify();
  else throw new Error('Use --native, --og or --verify. Only the independently identified review executable may be captured.');
} catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
