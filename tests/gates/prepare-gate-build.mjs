// prepare-gate-build.mjs — 门禁隔离构建准备：从仓库根源码复制出独立 src-tauri 签出，
// 烤入 CDP 调试端口（additional_browser_args --remote-debugging-port=18430，env 注入已证失效），
// 改产品名/标识避免与正式安装冲突。
// 迁移自 docs/tmp/audit-r2/prepare-gate-build.mjs（只读源）。整备：仓库根与产物目录不再依赖 cwd——
// root 经 import.meta.url 定位（脚本可从任意目录运行），dest 落 RUN_DIR/native-gate-build。
// 用法: node tests/gates/prepare-gate-build.mjs   （已存在 dest 时报错，先手动删）
// 后续构建（在 dest/src-tauri 内）:
// cargo build --release                                    # 全口径（LTO 按仓库 Cargo.toml）
// CARGO_PROFILE_RELEASE_LTO=false cargo build --release    # LTO 降级，提速构建（性能口径略低于全 LTO，结果 JSON 需注明）
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, RUN_DIR } from './gate-lib.mjs';
const root = REPO_ROOT, dest = path.join(RUN_DIR, 'native-gate-build'), native = path.join(dest, 'src-tauri');
if (fs.existsSync(native)) throw new Error('Isolated checkout already exists: ' + native);
fs.mkdirSync(native, { recursive: true });
for (const d of ['src', 'icons', 'capabilities']) fs.cpSync(path.join(root, 'src-tauri', d), path.join(native, d), { recursive: true });
for (const f of ['Cargo.toml', 'Cargo.lock', 'build.rs']) fs.copyFileSync(path.join(root, 'src-tauri', f), path.join(native, f));
// bundle resources 引用 ../LICENSE 与 ../THIRD-PARTY-NOTICES.md（相对 src-tauri 即仓库根）——隔离签出需同布局补拷，否则 tauri-build 报 resource path 不存在
for (const f of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
  const src = path.join(root, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
config.productName = 'ZiEdit Gates';
config.identifier = 'dev.ziedit.gates.20261023';
// frontendDist 必须是相对路径：绝对 Windows 路径 E:\... 的盘符冒号会被 tauri-utils 解析成
// URL scheme "e"，custom-protocol 构建下 get_app_url 返回该伪 URL，经 WebView2 规范化为
// file:///E:/... 后被零网络 on_navigation 钩子拦截，webview 永远停在 about:blank（2026-10-21 实证）。
// RUN_DIR/native-gate-build/src-tauri 距仓库根 5 层，与原 audit-r2 布局同深，相对路径不变。
config.build = { frontendDist: '../../../../../dist' };
fs.writeFileSync(path.join(native, 'tauri.conf.json'), JSON.stringify(config, null, 2) + '\n');
const lib = path.join(native, 'src/lib.rs');
let source = fs.readFileSync(lib, 'utf8');
// 2026-10-24 品牌更名 ZiEdit：锚点同步（原 ZiEdit）
if (!source.includes('.title("ZiEdit")')) throw new Error('Window title anchor missing');
source = source.replace('.title("ZiEdit")', '.title("ZiEdit Gates").additional_browser_args("--remote-debugging-port=18430")');
fs.writeFileSync(lib, source);
console.log(JSON.stringify({ dest, nextSteps: [
  `cd "${path.join(native)}"`,
  'cargo build --release   # 或 CARGO_PROFILE_RELEASE_LTO=false cargo build --release 提速',
  `exe: ${path.join(native, 'target/release/ziedit.exe')}`,
] }, null, 2));
