# 第三方声明（Third-Party Notices）

ZiEdit 本体以 [MIT](LICENSE) 许可。以下组件随应用分发，各自适用其原始许可；目录内附带的原版许可文件以原版为准。

## 本地内置资产（public/）

| 组件 | 版本 | 许可证 | 位置 |
|---|---|---|---|
| JetBrains Mono（等宽字体） | — | SIL OFL 1.1 | `public/fonts/`（见 `public/fonts/OFL-LICENSE.txt`） |
| MathJax | 4.1.3 | Apache-2.0 | `public/renderers/mathjax/` |
| MathJax New Computer Modern 字体（@mathjax/mathjax-newcm-font） | 4.1.3 | Apache-2.0（按包声明） | `public/renderers/font/` |
| Mermaid | 12.2.0 | MIT | `public/renderers/mermaid/` |
| highlight.js | — | BSD-3-Clause | `public/renderers/highlight/` |

Mermaid 12.2.0 的传递依赖中包含多种许可证（MIT、ISC、Apache-2.0、EPL-2.0（elkjs）、MPL-2.0 OR Apache-2.0（dompurify）、BSD-3-Clause、Unlicense 等），逐包版本、许可与来源完整清单见 `public/renderers/manifest.json`。

## npm 依赖（前端运行时）

CodeMirror 6 系列（MIT）、markdown-it（MIT）、Tauri 插件（MIT OR Apache-2.0）、mermaid / mathjax（见上表）等。完整清单与版本见 `package-lock.json`。

## Rust 依赖（src-tauri/）

Tauri 2（MIT OR Apache-2.0）、encoding_rs（Apache-2.0 OR MIT）、chardetng（Apache-2.0 OR MIT）、similar（Apache-2.0）、quick-xml（MIT OR Apache-2.0）、zip（MIT）、trash、reqwest（MIT OR Apache-2.0）等。完整清单与版本见 `src-tauri/Cargo.lock`，各 crate 许可以其发布包内声明为准。

---

更新本文件时同步检查：`public/renderers/manifest.json`（vendored 资产清单）、`package-lock.json`、`src-tauri/Cargo.lock`。
