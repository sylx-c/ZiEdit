# 第三方声明（Third-Party Notices）

ZiEdit 本体以 [MIT](LICENSE) 许可。以下组件随应用分发，各自适用其原始许可；目录内附带的原版许可文件以原版为准。

## 分发许可原文与审计状态（2026-11-05）

`third-party-licenses/` 附带逐包原始版权/许可文本、版本来源、SHA-256 与 `SOURCE-OFFERS.txt`；源码树位于 `public/third-party-licenses/`。本机未安装的平台包和缺少原文的包已补官方固定归档/提交证据，见 `third-party-sources/license-evidence/`。源码获取及检查见 `third-party-sources/option-ext/`、`mpl-crates/` 和 `elkjs/`；ELK 对应源码状态由严格门禁判定，不以收集成功替代放行。运行 `npm run license:check`，构建后运行 `npm run license:dist`；任一未决项或散列漂移均阻止正式打包与公开发布。

字体原文、来源与逐文件散列见 `font-licenses/`；不明确的 NewCM 字形已换用 STIX2，未使用的 npm mathjax 及其默认 NewCM 依赖已从锁文件移除，本地 MathJax 渲染器功能保留。测试诊断 stackback 0.0.2 无法补齐固定版本原文，已替换为 `tools/stackback-compat/` 中本项目自编 MIT 兼容模块。

其他分项材料：

- `third-party-sources/vendored-evidence/` 保留 Mermaid 实际打包的55个精确版本、完整 sourcesContent、原始 bundle 许可尾文和本地修改前后字节，包括 PDF.js legacy 内嵌 core-js 3.50.0。它不同于当前 npm 依赖树；DOMPurify 选择 Apache-2.0 分支使用，r-efi 选择 MIT，AND 许可保留全部适用声明。
- `third-party-sources/other-renderers/` 核对 MathJax 固定原归档全部实际分发文件、mhchemparser 4.2.1 原始版权/Apache 原文，以及 highlight 11.7.0 的192种语法和核心源码等价证明、第三方语言原文及注册包装修改。MathJax 的路径注册不等于分发 SRE 等未复制组件。
- `third-party-sources/windows-installer/` 附实际 NSIS 3.13 及 Tauri CLI 默认3.11的原始声明和工具散列、Tauri NSIS 插件0.5.3原文；安装器明确使用 zlib 压缩，不使用额外的 CPL LZMA 解压器。
- `third-party-sources/ring-notices/` 保留 ring 0.17.14 全部原始源码归档及独立版权/许可源码文件，包含 Google/Andrew Moon 等嵌入归属，不仅是根目录许可证。
- `third-party-sources/webview2-loader/` 附 Microsoft.Web.WebView2 1.0.3800.47 SDK 的原始 BSD-3-Clause `LICENSE.txt`、`NOTICE.txt` 及与 Rust crate 六个 loader 二进制逐字节匹配的记录；这是可免费再分发的 loader，不把独立 WebView2 Runtime 或整个微软SDK称为本项目开源源码。
- `asset-provenance/emoji/` 保留 gemoji、iamcal、Unicode 的固定来源数据、三份原始许可、逐条映射与纠错记录；不再使用自写合并许可代替原文。
- `asset-provenance/project-art/` 记录入库的项目SVG母版、界面SVG源码与本次重生安装图标；`asset-provenance/website/` 保留本轮自编示例及真实截图来源，不为旧截图补造权属记录。

这些材料覆盖已审查的组件与具体分发义务，不是对商标、专利、历史权属或所有未来版本的零风险保证。Linux 系统共享库与 AppImage 内嵌库、安装包的 WebView2 bootstrapper/VC runtime 必须按实际目标产物再检查，不能用 Windows 核查代替全部平台验收。

## 本地内置资产（public/）

| 组件 | 版本 | 许可证 | 位置 |
|---|---|---|---|
| JetBrains Mono（等宽字体） | 2.304 | SIL OFL 1.1 | `public/fonts/`（见 `public/fonts/OFL-LICENSE.txt`）；自[上游固定 tag 的 webfonts](https://github.com/JetBrains/JetBrainsMono/tree/v2.304/fonts/webfonts)逐字节获取 Regular/Bold/Italic 原始 WOFF2，附同 tag OFL 许可；散列见字体清单 |
| MathJax | 4.1.3 | Apache-2.0 | `public/renderers/mathjax/` |
| MathJax STIX2 字体（@mathjax/mathjax-stix2-font） | 4.1.3 | JavaScript 代码 Apache-2.0；STIX Two 衍生字形 SIL OFL 1.1 | `public/renderers/font/`；完整历史上游版权与 OFL、MathJax 追加版权见 `OFL-STIX.txt`、`NOTICE.txt`、`LICENSE`。生成定义只引用 STIXTwoMath/Text，修改版名称 mathjax-stix2 不使用保留名称 TM Math。未声称历史 OFL 文本的 tag 就是源字体输入子版本。 |
| MathJax MJX-ZERO 内嵌辅助字体 | 0.1（随 MathJax 4.1.3） | Apache-2.0 | 内嵌于 `public/renderers/mathjax/output/svg.js`，用于换行测量；MathJax Consortium 2023–2026 版权和准确 payload 源码见 `font-licenses/MathJax-zero-source.ts.txt`，不归类为 STIX 字形。 |
| Mermaid | 12.2.0 | MIT | `public/renderers/mermaid/` |
| highlight.js | 11.7.0 | BSD-3-Clause | `public/renderers/highlight/`；`third-languages.js` 另含 highlightjs-solidity 2.0.5（实际固定归档 LICENSE 为 WTFPL-2.0；metadata 的 MIT 标记与原文不同，按原文履行并保留差异记录）、highlightjs-sap-abap 0.2.0（MIT）、highlightjs-hlsl unversioned（MIT）、highlightjs-gdscript unversioned（BSD-3-Clause），来源见 manifest |
| Emoji 短名映射 | 本地整理 | MIT 上游谱系 | `src/markdown-view/unicode-emojis.json`；出处及声明见 [unicode-emojis.NOTICE.md](src/markdown-view/unicode-emojis.NOTICE.md) |
| GitHub 标记图标（Octicons `mark-github` 16） | primer/octicons v19.19.0 | MIT | 内嵌于 `src/shell/app.ts`，放在关于对话框「官网」之前。图形未改。来源 [mark-github-16.svg](https://github.com/primer/octicons/blob/v19.19.0/icons/mark-github-16.svg)，Copyright (c) 2025 GitHub Inc. |
| Tauri 生成 schemas | 随构建工具 | MIT OR Apache-2.0（Tauri） | `src-tauri/gen/schemas/` 为 Tauri 生成产物，非手工维护的第三方源码 |
| PDF 解码资产（pdf.js CMaps/标准字体/JS 解码回退） | 6.4.299 | pdf.js 代码 Apache-2.0；Foxit 字体 BSD-3-Clause；Liberation Sans **1.07.4** 为 GPL-2.0 WITH Liberation 字体例外 | `public/pdfjs-assets/`（含 LICENSE、standard_fonts/LICENSE_FOXIT、LICENSE_LIBERATION）。字体例外不免除字体本身的源码分发义务；对应 1.07.4 源码包、SHA-256 与获取说明随 `third-party-sources/` 分发，见 `LIBERATION-SOURCE.txt`；发布时须与二进制一同提供并检查最终包内容。不能将整个目录统称 Apache-2.0。版本依据 [pdf.js v6.4.299 上游说明](https://github.com/mozilla/pdf.js/blob/v6.4.299/external/standard_fonts/README.md) |

Mermaid 12.2.0 的传递依赖中包含多种许可证（MIT、ISC、Apache-2.0、EPL-2.0（elkjs）、MPL-2.0 OR Apache-2.0（dompurify）、BSD-3-Clause、Unlicense 等），逐包版本、许可与来源完整清单见 `public/renderers/manifest.json`。

## npm 依赖（前端运行时）

CodeMirror 6 系列（MIT）、markdown-it（MIT）及其打包内传递依赖（linkify-it、mdurl，MIT）、Tauri 插件（MIT OR Apache-2.0）、mermaid / mathjax（见上表）、pdfjs-dist 6.4.299（代码 Apache-2.0，legacy 构建；CMaps 与标准字体分项许可见上表）等。完整清单与版本见 `package-lock.json`。

ZiEdit 构建时将 `@codemirror/language` 6.13.1 的后台解析单片上限调整为 8ms；修改由 `scripts/codemirror-parser-budget.mjs` 校验并应用，原版权与 MIT 许可保持有效。

锁文件中的非 MIT/Apache 许可显式列示（含构建依赖，不表示每个包均进入运行时）：entities（BSD-2-Clause）、argparse（PSF-2.0）、lru-cache（BlueOak-1.0.0）、mdn-data（CC0-1.0）、elkjs（EPL-2.0）、robust-predicates（Unlicense）、lightningcss 及其平台包（MPL-2.0）、webidl-conversions（BSD-2-Clause）。Mermaid 内嵌 ELK、DOMPurify、KaTeX 的许可原文随附于 `public/renderers/mermaid/licenses/`。

### Lezer Markdown

`@lezer/markdown`（MIT）随 CodeMirror 打包；`src/markdown-view/cooperative-table.ts` 中的表格单元格边界算法亦改写自该组件。其版权与许可如下：

```text
MIT License

Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

manifest 的 `licenseFiles` 路径相对于 `public/renderers/`；没有随包许可文件的条目只列许可标识与上游 URL，不声称上游包内文件已随包。清单排除类型包及未随浏览器产物分发的安装工具依赖（`@types/*`、`@antfu/*`、`@iconify/*`、package-manager-detector、tinyexec、import-meta-resolve）；它们虽出现在 Mermaid npm dependencies 闭包，并非此处 vendored 资产。

## Rust 依赖（src-tauri/）

版本以 Cargo.lock 为准、许可以本清单为准（源自 crates.io 元数据）。以下包含全部目标平台及构建依赖，按完整许可表达式分组；OR 表示可选许可，AND 表示同时适用。

生成方式：`node scripts/gen-rust-notices.mjs`（执行 `cargo metadata --format-version 1 --locked`，不修改锁文件）。

直接依赖（含构建依赖）：`arboard`、`chardetng`、`crc32fast`、`encoding_rs`、`imagesize`、`log`、`md-5`、`quick-xml`、`regex`、`reqwest`、`serde`、`serde_json`、`sha1`、`sha2`、`similar`、`tauri`、`tauri-build`、`tauri-plugin-clipboard-manager`、`tauri-plugin-dialog`、`tauri-plugin-log`、`tauri-plugin-opener`、`tauri-plugin-single-instance`、`thiserror`、`trash`、`unicode-normalization`、`windows-sys`、`zip`。

EPL-2.0 组件 elkjs 属于前端 Mermaid，不在 Rust 依赖树中；见 vendored 清单及随附许可。

### (Apache-2.0 OR MIT) AND BSD-3-Clause

- encoding_rs 0.8.42

### (MIT OR Apache-2.0) AND Unicode-3.0

- unicode-ident 1.0.27

### 0BSD OR MIT OR Apache-2.0

- adler2 2.0.1

### Apache-2.0

- gethostname 1.1.0
- similar 2.7.0
- sync_wrapper 1.0.2
- tao 0.37.1

### Apache-2.0 / MIT

- fnv 1.0.7

### Apache-2.0 AND ISC

- ring 0.17.14

### Apache-2.0 AND MIT

- dpi 0.1.2

### Apache-2.0 OR BSL-1.0

- ryu 1.0.23

### Apache-2.0 OR ISC OR MIT

- hyper-rustls 0.27.10
- rustls 0.23.46

### Apache-2.0 OR MIT

- async-channel 2.5.0
- async-executor 1.14.0
- async-io 2.6.0
- async-lock 3.4.2
- async-process 2.5.0
- async-signal 0.2.14
- async-task 4.7.1
- atomic-waker 1.1.2
- autocfg 1.5.1
- bit-set 0.8.0
- bit-vec 0.8.0
- blocking 1.7.0
- cargo_toml 1.0.1
- chardetng 0.1.17
- concurrent-queue 2.5.0
- ctor 1.0.13
- equivalent 1.0.2
- event-listener 5.4.2
- event-listener-strategy 0.5.4
- fastrand 2.5.0
- futures-lite 2.6.1
- idna_adapter 1.2.2
- indexmap 1.9.3
- indexmap 2.14.2
- libappindicator 0.9.0
- libappindicator-sys 0.9.0
- muda 0.20.0
- multiversion_no_op 1.0.0
- parking 2.2.1
- pin-project-lite 0.2.17
- polling 3.11.0
- portable-atomic 1.15.0
- portable-atomic-util 0.2.8
- rustc-hash 2.1.3
- tauri 2.12.3
- tauri-build 2.7.2
- tauri-codegen 2.7.2
- tauri-macros 2.7.2
- tauri-plugin 2.7.1
- tauri-plugin-clipboard-manager 2.4.2
- tauri-plugin-dialog 2.8.2
- tauri-plugin-fs 2.7.0
- tauri-plugin-log 2.10.1
- tauri-plugin-opener 2.7.1
- tauri-plugin-single-instance 2.5.4
- tauri-runtime 2.12.1
- tauri-runtime-wry 2.12.1
- tauri-utils 2.10.1
- utf8_iter 1.0.4
- uuid 1.28.0
- window-vibrancy 0.8.1
- wry 0.57.0
- zeroize 1.9.1
- zeroize_derive 1.5.0

### Apache-2.0 WITH LLVM-exception

- target-lexicon 0.12.16

### Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT

- linux-raw-sys 0.12.1
- rustix 1.1.5
- wasi 0.11.1+wasi-snapshot-preview1
- wasip2 1.0.4+wasi-0.2.12
- wit-bindgen 0.57.1

### Apache-2.0/MIT

- cesu8 1.1.0
- dbus 0.9.12
- libdbus-sys 0.2.7

### BSD-2-Clause OR Apache-2.0 OR MIT

- zerocopy 0.8.63
- zerocopy-derive 0.8.63

### BSD-3-Clause

- alloc-no-stdlib 3.0.0
- alloc-stdlib 0.3.0
- subtle 2.6.1

### BSD-3-Clause AND MIT

- brotli 9.0.0

### BSD-3-Clause OR Apache-2.0

- moxcms 0.8.1
- pxfm 0.1.30

### BSD-3-Clause OR MIT OR Apache-2.0

- num_enum 0.7.6
- num_enum_derive 0.7.6

### BSD-3-Clause/MIT

- brotli-decompressor 6.0.1

### BSL-1.0

- clipboard-win 5.4.1
- error-code 3.4.0

### CC0-1.0 OR MIT-0 OR Apache-2.0

- constant_time_eq 0.6.1
- dunce 1.0.5

### CDLA-Permissive-2.0

- webpki-roots 1.0.12

### ISC

- libloading 0.7.4
- rustls-webpki 0.103.16
- untrusted 0.9.0

### MIT

- atk 0.18.2
- atk-sys 0.18.2
- block2 0.6.2
- bytes 1.12.1
- cairo-rs 0.18.5
- cairo-sys-rs 0.18.2
- cargo_metadata 0.19.2
- cfb 0.14.0
- cfg_aliases 0.2.2
- combine 4.6.8
- crunchy 0.2.4
- darling 0.24.1
- darling_core 0.24.1
- darling_macro 0.24.1
- derive_more 2.1.1
- derive_more-impl 2.1.1
- dlopen2 0.8.2
- dlopen2_derive 0.4.3
- dom_query 0.28.0
- embed-resource 3.0.12
- endi 1.1.1
- fax 0.2.7
- fern 0.7.1
- gdk 0.18.2
- gdk-pixbuf 0.18.5
- gdk-pixbuf-sys 0.18.0
- gdk-sys 0.18.2
- gdkwayland-sys 0.18.2
- gdkx11 0.18.2
- gdkx11-sys 0.18.2
- generic-array 0.14.7
- gio 0.18.4
- gio-sys 0.18.1
- glib 0.18.5
- glib-macros 0.18.5
- glib-sys 0.18.1
- gobject-sys 0.18.0
- gtk 0.18.2
- gtk-sys 0.18.2
- gtk3-macros 0.18.2
- http-body 1.1.0
- http-body-util 0.1.5
- http-range 0.1.5
- hyper 1.12.0
- hyper-util 0.1.21
- ico 0.5.0
- imagesize 0.13.0
- infer 0.22.0
- is-docker 0.2.0
- is-wsl 0.4.0
- javascriptcore-rs 1.1.2
- javascriptcore-rs-sys 1.1.1
- libredox 0.1.25
- memoffset 0.9.1
- mio 1.2.4
- new_debug_unreachable 1.0.6
- nix 0.31.3
- nom 8.0.0
- objc2 0.6.5
- objc2-encode 4.1.0
- objc2-foundation 0.3.2
- open 5.4.4
- os_pipe 1.2.3
- pango 0.18.3
- pango-sys 0.18.0
- phf 0.13.1
- phf_codegen 0.13.1
- phf_generator 0.13.1
- phf_macros 0.13.1
- phf_shared 0.13.1
- plist 1.10.1
- precomputed-hash 0.1.1
- quick-xml 0.41.0
- quick-xml 0.42.0
- redox_syscall 0.5.18
- redox_users 0.5.3
- rfd 0.16.0
- schemars 0.8.22
- schemars 0.9.0
- schemars 1.2.3
- schemars_derive 0.8.22
- simd-adler32 0.3.10
- slab 0.4.12
- soup3 0.5.0
- soup3-sys 0.5.0
- strsim 0.11.1
- synstructure 0.14.0
- tauri-winres 0.3.6
- tiff 0.11.3
- tokio 1.53.2
- tokio-util 0.7.20
- tower 0.5.3
- tower-http 0.6.11
- tower-layer 0.3.3
- tower-service 0.3.3
- tracing 0.1.44
- tracing-attributes 0.1.31
- tracing-core 0.1.36
- trash 5.2.9
- tree_magic_mini 3.2.2
- try-lock 0.2.5
- uds_windows 1.2.1
- urlencoding 2.1.3
- urlpattern 0.6.0
- version-compare 0.2.1
- vswhom 0.1.0
- vswhom-sys 0.1.3
- want 0.3.2
- wayland-backend 0.3.17
- wayland-client 0.31.15
- wayland-protocols 0.32.13
- wayland-protocols-wlr 0.3.12
- wayland-scanner 0.31.11
- wayland-sys 0.31.11
- webkit2gtk 2.0.2
- webkit2gtk-sys 2.0.2
- webview2-com 0.39.1
- webview2-com-macros 0.8.1
- webview2-com-sys 0.39.1
- winnow 0.5.40
- winnow 1.0.4
- winreg 0.56.0
- x11 2.21.0
- x11-dl 2.21.0
- zbus 5.19.0
- zbus_macros 5.19.0
- zbus_names 4.3.4
- zcheapstr 1.1.0
- zip 9.5.1
- zmij 1.0.23
- zvariant 5.15.0
- zvariant_derive 5.15.0
- zvariant_utils 4.2.0

### MIT OR Apache-2.0

- android_log-sys 0.3.2
- android_logger 0.15.1
- android_system_properties 0.1.6
- anyhow 1.0.104
- arboard 3.6.1
- async-broadcast 0.7.2
- async-recursion 1.2.0
- async-trait 0.1.92
- base64 0.21.7
- base64 0.22.1
- base64 0.23.1
- bitflags 2.13.2
- block-buffer 0.10.4
- bstr 1.13.1
- bumpalo 3.20.3
- camino 1.2.6
- cargo-platform 0.1.9
- cc 1.8.0
- cfg-expr 0.15.8
- cfg-if 1.0.5
- chacha20 0.10.2
- chrono 0.4.45
- cookie 0.18.2
- core-foundation 0.10.1
- core-foundation-sys 0.8.7
- core-graphics 0.25.0
- core-graphics-types 0.2.0
- cpufeatures 0.2.17
- cpufeatures 0.3.1
- crc32fast 1.5.2
- crossbeam-channel 0.5.17
- crossbeam-utils 0.8.23
- crypto-common 0.1.7
- defmt 1.1.1
- defmt-macros 1.1.1
- defmt-parser 1.0.0
- deranged 0.5.8
- digest 0.10.7
- dirs 7.0.0
- dirs-sys 0.5.0
- displaydoc 0.2.7
- dtoa 1.0.11
- dyn-clone 1.0.20
- embed_plist 1.2.2
- enumflags2 0.7.12
- enumflags2_derive 0.7.12
- env_filter 0.1.4
- erased-serde 0.4.10
- errno 0.3.14
- fdeflate 0.3.7
- field-offset 0.3.6
- find-msvc-tools 0.1.14
- fixedbitset 0.5.7
- flate2 1.1.10
- form_urlencoded 1.2.2
- futures-channel 0.3.34
- futures-core 0.3.34
- futures-executor 0.3.34
- futures-io 0.3.34
- futures-macro 0.3.34
- futures-sink 0.3.34
- futures-task 0.3.34
- futures-util 0.3.34
- getrandom 0.2.17
- getrandom 0.3.4
- getrandom 0.4.3
- glob 0.3.4
- half 2.7.1
- hashbrown 0.12.3
- hashbrown 0.15.5
- hashbrown 0.17.1
- heck 0.4.1
- heck 0.5.0
- hermit-abi 0.5.3
- hex 0.4.3
- html5ever 0.39.0
- http 1.5.0
- httparse 1.10.1
- iana-time-zone 0.1.65
- iana-time-zone-haiku 0.1.2
- idna 1.1.0
- image 0.25.10
- ipnet 2.12.2
- itoa 1.0.18
- jni-sys 0.3.1
- jni-sys 0.4.1
- jni-sys-macros 0.4.1
- js-sys 0.3.106
- jsonptr 0.7.1
- keyboard-types 0.8.3
- libc 0.2.190
- lock_api 0.4.14
- log 0.4.34
- markup5ever 0.39.0
- md-5 0.10.6
- mime 0.3.17
- ndk 0.9.0
- ndk-context 0.1.1
- ndk-sys 0.6.0+11769913
- num_threads 0.1.7
- num-conv 0.2.2
- num-traits 0.2.19
- once_cell 1.21.4
- ordered-stream 0.2.0
- parking_lot 0.12.5
- parking_lot_core 0.9.12
- percent-encoding 2.3.2
- petgraph 0.8.3
- piper 0.2.5
- pkg-config 0.3.34
- png 0.17.16
- png 0.18.1
- powerfmt 0.2.1
- proc-macro-crate 1.3.1
- proc-macro-crate 2.0.2
- proc-macro-crate 3.5.0
- proc-macro-error 1.0.4
- proc-macro-error-attr 1.0.4
- proc-macro2 1.0.107
- quinn 0.11.12
- quinn-proto 0.11.19
- quinn-udp 0.5.16
- quote 1.0.47
- rand 0.10.3
- rand_core 0.10.1
- rand_pcg 0.10.2
- ref-cast 1.0.27
- ref-cast-impl 1.0.27
- regex 1.13.1
- regex-automata 0.4.18
- regex-syntax 0.8.11
- reqwest 0.12.28
- reqwest 0.13.5
- rustc_version 0.4.1
- rustls-pki-types 1.15.1
- rustversion 1.0.23
- scopeguard 1.2.0
- semver 1.0.28
- serde 1.0.229
- serde_core 1.0.229
- serde_derive 1.0.229
- serde_derive_internals 0.29.1
- serde_json 1.0.154
- serde_repr 0.1.21
- serde_spanned 0.6.9
- serde_spanned 1.1.2
- serde_with 3.24.0
- serde_with_macros 3.24.0
- serde-untagged 0.1.9
- serialize-to-javascript 0.1.2
- serialize-to-javascript-impl 0.1.2
- servo_arc 0.4.3
- sha1 0.10.7
- sha2 0.10.9
- shlex 2.0.1
- signal-hook-registry 1.4.8
- simdutf8 0.1.5
- siphasher 1.0.4
- smallvec 1.16.3
- socket2 0.6.5
- softbuffer 0.4.8
- stable_deref_trait 1.2.1
- string_cache 0.9.0
- string_cache_codegen 0.6.1
- swift-rs 1.0.9
- syn 1.0.109
- syn 2.0.119
- syn 3.0.9
- system-deps 6.2.2
- tao-macros 0.1.4
- tempfile 3.27.0
- tendril 0.5.1
- thiserror 1.0.69
- thiserror 2.0.21
- thiserror-impl 1.0.69
- thiserror-impl 2.0.21
- time 0.3.55
- time-core 0.1.9
- time-macros 0.2.32
- tokio-rustls 0.26.6
- toml 0.8.2
- toml 1.1.8+spec-1.1.0
- toml_datetime 0.6.3
- toml_datetime 1.1.2+spec-1.1.0
- toml_edit 0.19.15
- toml_edit 0.20.2
- toml_edit 0.25.17+spec-1.1.0
- toml_parser 1.1.5+spec-1.1.0
- toml_writer 1.1.3+spec-1.1.0
- tray-icon 0.25.1
- typed-path 0.13.0
- typeid 1.0.3
- typenum 1.20.1
- unicode-normalization 0.1.25
- unicode-segmentation 1.13.3
- url 2.5.8
- wasm-bindgen 0.2.129
- wasm-bindgen-futures 0.4.79
- wasm-bindgen-macro 0.2.129
- wasm-bindgen-macro-support 0.2.129
- wasm-bindgen-shared 0.2.129
- wasm-streams 0.5.0
- web_atoms 0.2.6
- web-sys 0.3.106
- web-time 1.1.0
- weezl 0.1.12
- windows 0.62.2
- windows_aarch64_gnullvm 0.42.2
- windows_aarch64_gnullvm 0.52.6
- windows_aarch64_gnullvm 0.53.1
- windows_aarch64_msvc 0.42.2
- windows_aarch64_msvc 0.52.6
- windows_aarch64_msvc 0.53.1
- windows_i686_gnu 0.42.2
- windows_i686_gnu 0.52.6
- windows_i686_gnu 0.53.1
- windows_i686_gnullvm 0.52.6
- windows_i686_gnullvm 0.53.1
- windows_i686_msvc 0.42.2
- windows_i686_msvc 0.52.6
- windows_i686_msvc 0.53.1
- windows_x86_64_gnu 0.42.2
- windows_x86_64_gnu 0.52.6
- windows_x86_64_gnu 0.53.1
- windows_x86_64_gnullvm 0.42.2
- windows_x86_64_gnullvm 0.52.6
- windows_x86_64_gnullvm 0.53.1
- windows_x86_64_msvc 0.42.2
- windows_x86_64_msvc 0.52.6
- windows_x86_64_msvc 0.53.1
- windows-collections 0.3.2
- windows-core 0.62.2
- windows-future 0.3.2
- windows-implement 0.60.2
- windows-interface 0.59.3
- windows-link 0.2.1
- windows-numerics 0.3.1
- windows-result 0.4.1
- windows-strings 0.5.1
- windows-sys 0.45.0
- windows-sys 0.52.0
- windows-sys 0.60.2
- windows-sys 0.61.2
- windows-targets 0.42.2
- windows-targets 0.52.6
- windows-targets 0.53.5
- windows-threading 0.2.1
- windows-version 0.1.7
- wl-clipboard-rs 0.9.4
- x11rb 0.13.2
- x11rb-protocol 0.13.2

### MIT OR Apache-2.0 OR LGPL-2.1-or-later

- r-efi 5.3.0
- r-efi 6.0.0

### MIT OR Apache-2.0 OR Zlib

- lru-slab 0.1.3
- raw-window-handle 0.6.2
- zune-core 0.5.3
- zune-jpeg 0.5.15

### MIT OR Zlib OR Apache-2.0

- miniz_oxide 0.8.9
- miniz_oxide 0.9.1

### MIT/Apache-2.0

- bitflags 1.3.2
- bs58 0.5.1
- core_detect 1.0.0
- downcast-rs 1.2.1
- foreign-types 0.5.0
- foreign-types-macros 0.2.4
- foreign-types-shared 0.3.1
- ident_case 1.0.1
- jni 0.21.1
- json-patch 4.2.0
- quick-error 2.0.1
- serde_urlencoded 0.7.1
- version_check 0.9.5
- winapi 0.3.9
- winapi-i686-pc-windows-gnu 0.4.0
- winapi-x86_64-pc-windows-gnu 0.4.0

### MPL-2.0

- cssparser 0.37.0
- cssparser-macros 0.7.1
- dtoa-short 0.3.5
- option-ext 0.2.0
- selectors 0.38.0

### Unicode-3.0

- icu_collections 2.3.0
- icu_locale_core 2.3.0
- icu_normalizer 2.3.0
- icu_normalizer_data 2.3.0
- icu_properties 2.3.0
- icu_properties_data 2.3.0
- icu_provider 2.3.1
- litemap 0.8.3
- potential_utf 0.1.6
- tinystr 0.8.4
- writeable 0.6.4
- yoke 0.8.3
- yoke-derive 0.8.4
- zerofrom 0.1.8
- zerofrom-derive 0.1.8
- zerotrie 0.2.5
- zerovec 0.11.8
- zerovec-derive 0.11.6

### Unlicense OR MIT

- aho-corasick 1.1.5
- byteorder 1.5.0
- byteorder-lite 0.1.0
- jiff 0.2.38
- jiff-core 0.1.1
- jiff-static 0.2.38
- jiff-tzdb 0.1.9
- jiff-tzdb-platform 0.1.3
- memchr 2.8.3
- winapi-util 0.1.11

### Unlicense/MIT

- same-file 1.0.6
- walkdir 2.5.0

### Zlib

- foldhash 0.1.5
- foldhash 0.2.0
- zlib-rs 0.6.8

### Zlib OR Apache-2.0 OR MIT

- bytemuck 1.25.2
- dispatch2 0.3.1
- objc2-app-kit 0.3.2
- objc2-cloud-kit 0.3.2
- objc2-core-data 0.3.2
- objc2-core-foundation 0.3.2
- objc2-core-graphics 0.3.2
- objc2-core-image 0.3.2
- objc2-core-location 0.3.2
- objc2-core-text 0.3.2
- objc2-exception-helper 0.1.1
- objc2-io-surface 0.3.2
- objc2-quartz-core 0.3.2
- objc2-ui-kit 0.3.2
- objc2-user-notifications 0.3.2
- objc2-web-kit 0.3.2
- tinyvec 1.13.3

---

更新本文件时同步检查：`public/renderers/manifest.json`（vendored 资产清单）、`package-lock.json`、`src-tauri/Cargo.lock`。
