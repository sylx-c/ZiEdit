// prepare-gate-build.mjs — 门禁隔离构建准备：从仓库根源码复制出独立 src-tauri 签出，
// 烤入 CDP 调试端口（additional_browser_args --remote-debugging-port=18430，env 注入已证失效），
// 改产品名/标识避免与正式安装冲突。
// 迁移自 docs/tmp/audit-r2/prepare-gate-build.mjs（只读源）。整备：仓库根与产物目录不再依赖 cwd——
//   root 经 import.meta.url 定位（脚本可从任意目录运行），dest 落 RUN_DIR/native-gate-build。
// 用法: node tests/gates/prepare-gate-build.mjs   （已存在 dest 时报错，先手动删）
// node tests/gates/prepare-gate-build.mjs --build：准备后通过 Tauri CLI 构建，嵌入当前 dist。
// 直接 cargo build 缺少 custom-asset，不能用于桌面性能验收。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, RUN_DIR } from './gate-lib.mjs';
import { sourceSnapshot, writeJson, sha256, assertInside } from '../../scripts/build-provenance.mjs';
const root = REPO_ROOT, dest = path.join(RUN_DIR, 'native-gate-build'), native = path.join(dest, 'src-tauri');
// 无条件隔离；调用者的 CARGO_TARGET_DIR 不得使门禁覆盖正式可执行文件。
const target = path.join(native, 'target');
const sourceBefore = sourceSnapshot(root);
assertInside(path.join(root, 'docs/tmp'), native);
if (fs.existsSync(native)) {
  if (!process.argv.includes('--refresh') || !fs.existsSync(path.join(dest, 'gate-build.json'))) {
    throw new Error('Isolated checkout already exists; --refresh requires a completed gate build record: ' + native);
  }
  for (const dir of ['src', 'icons', 'capabilities']) {
    const stale = path.join(native, dir);
    assertInside(native, stale);
    fs.rmSync(stale, { recursive: true, force: true });
  }
}
fs.mkdirSync(native, { recursive: true });
for (const d of ['src', 'icons', 'capabilities']) fs.cpSync(path.join(root, 'src-tauri', d), path.join(native, d), { recursive: true });
for (const f of ['Cargo.toml', 'Cargo.lock', 'build.rs']) fs.copyFileSync(path.join(root, 'src-tauri', f), path.join(native, f));
// bundle.resources 的键指向 src-tauri 之外（../LICENSE、../THIRD-PARTY-NOTICES.md、../public/…、../src/…）——
// 隔离签出需按仓库同布局补拷全部映射源，否则 tauri build 报 resource path 不存在（2026-11-06 通用化）
const resourceConfig = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
for (const from of Object.keys(resourceConfig.bundle?.resources ?? {})) {
  const rel = from.replace(/^\.\.\//, '').replaceAll('/', path.sep);
  const src = path.join(root, rel);
  const to = path.join(dest, rel);
  assertInside(dest, to);
  if (fs.existsSync(src)) {
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, to, { recursive: true });
    else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(src, to); }
  }
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
config.productName = 'ZiEdit Gates';
config.identifier = 'dev.ziedit.gates.r' + sha256(dest).slice(0, 12);
// frontendDist 必须是相对路径：绝对 Windows 路径 E:\... 的盘符冒号会被 tauri-utils 解析成
// URL scheme "e"，custom-protocol 构建下 get_app_url 返回该伪 URL，经 WebView2 规范化为
// file:///E:/... 后被零网络 on_navigation 钩子拦截，webview 永远停在 about:blank（2026-10-21 实证）。
// RUN_DIR 可自定义层级，始终计算相对于隔离 native 根的当前前端资产路径。
config.build = { frontendDist: path.relative(native, path.join(root, 'dist')).replaceAll('\\', '/') };
fs.writeFileSync(path.join(native, 'tauri.conf.json'), JSON.stringify(config, null, 2) + '\n');
const lib = path.join(native, 'src/lib.rs');
let source = fs.readFileSync(lib, 'utf8');
// 2026-10-24 品牌更名 ZiEdit：锚点同步（原 ZiEdit）
if (!source.includes('.title("ZiEdit")')) throw new Error('Window title anchor missing');
source = source.replace('.title("ZiEdit")', '.title("ZiEdit Gates").additional_browser_args("--remote-debugging-port=18430")');
fs.writeFileSync(lib, source);
console.log(JSON.stringify({ dest, nextSteps: [
  `cd "${dest}"`,
  `node "${path.join(root, 'node_modules/@tauri-apps/cli/tauri.js')}" build --no-bundle`,
  `exe: ${path.join(target, 'release/ziedit.exe')}`,
] }, null, 2));
if (process.argv.includes('--build')) {
  // 不接受遗留 dist 冒充当前源码；与 package.json 的 build 入口相同。
  for (const args of [['node_modules/typescript/bin/tsc'], ['node_modules/vite/bin/vite.js', 'build']]) {
    const frontend = spawnSync(process.execPath, args.map((arg, index) => index ? arg : path.join(root, arg)),
      { cwd: root, stdio: 'inherit', windowsHide: true });
    if (frontend.error) throw frontend.error;
    if (frontend.status !== 0) process.exit(frontend.status ?? 1);
  }
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--no-bundle'],
    { cwd: dest, stdio: 'inherit', windowsHide: true, env: { ...process.env, CARGO_TARGET_DIR: target } });
  if (result.error) throw result.error;
  const exe = path.join(target, 'release/ziedit.exe');
  const sourceAfter = sourceSnapshot(root);
  writeJson(path.join(dest, 'gate-build.json'), {
    status: result.status === 0 && fs.existsSync(exe) && sourceBefore.sha256 === sourceAfter.sha256 ? 'passed' : 'failed',
    sourceBefore, sourceAfter, channel: process.env.ZIEDIT_CHANNEL === 'release' ? 'release' : 'dev',
    exe, exeSha256: fs.existsSync(exe) ? sha256(fs.readFileSync(exe)) : null,
    differences: ['productName', 'identifier', 'window title', 'CDP port 18430', 'frontendDist relative path', 'no installer bundle'],
    configSha256: sha256(fs.readFileSync(path.join(native, 'tauri.conf.json'))),
    nativeSourceSha256: sha256(fs.readFileSync(lib)),
  });
  if (sourceBefore.sha256 !== sourceAfter.sha256) throw new Error('Source changed during gate build');
  process.exitCode = result.status ?? 1;
}
