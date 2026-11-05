# PDF 查看（pdf.js）实施计划

> **状态：已收口（2026-10-29）。** Task 1–7 实现完成（聚焦测试 26 项、tsc、vite build 过；全量门禁 1097/1097 绿）；Task 8 文档同步完成；真实安装包冒烟通过。实现偏差一处：6.4.299 `PDFDocumentProxy` 无 `destroy()`，统一走 `loadingTask.destroy()` 幂等守卫（依据包内 api.d.ts，engine.ts 注释记录）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **修订记录：** 2026-10-29 v2——按 oracle 计划门评（attempt 1 不放行）修订：worker 降级链、pdfjs 6.x API 校正、wasm/解码资产决策、静态复制方案、路由全链路、加载取消、有界尺寸预取、真实内存约束、尺子/右轨行为、集成门禁与 CI Node 版本、asset 授权收紧、回退如实描述、无障碍与主题边界。
> 2026-10-29 v3——attempt 2 复核修订：①worker 降级不手动清空 workerSrc/workerPort，交 pdf.js 内置降级；②解码资产复制 wasm/ 两份 *_nowasm_fallback.js 并显式 useWasm:false+wasmUrl；③加载等待期 abort 立即 loadingTask.destroy()、失败清理、防重复销毁；④去掉未测页 A4 估高与过渡动画——仅追加已实测页，远跳页给可取消测量进度；⑤内存预算计入在途/预渲染 canvas，离场 page.cleanup()；⑥CI Node 固定 24（必改）、冒烟必须在真实安装包上；⑦WebView2 直接采用配套 legacy 主库+worker（不做版本赌注）；⑧复用既有文件级授权（lib.rs:64-69 / ipc.ts:200），不新增命令；⑨文件大小用既有 fileStat（ipc.ts:82），不以 pdf_open 当探针；⑩补 DPR 变化与重绘后焦点保持验收。

**Goal:** PDF 从「文本降级读取」升级为 pdf.js 渲染的完整查看：连续滚动整页、缩放（适应窗/100%/±/Ctrl+滚轮）、页码跳转、90° 旋转、超大守护，解析失败/加密时回退现有文本通道（如实描述其限制）。

**Architecture:** 新增 `src/pdf-view/` 前端模块（pdfjs-dist 渲染，自绘信息条与页容器，不用 pdf_viewer.css）；字节经 asset 协议 fetch（`convertFileSrc` + **复用既有文件级授权**，复用既有 asset 机制并避免 IPC 大 buffer 序列化）；Rust 侧仅改 `kind_detect` 路由枚举（新增 `Pdf` route），文本提取通道 `pdf_open`/`pdf_lines` 原样保留作回退。CSP 仅在 `connect-src` 追加 `asset: http://asset.localhost`（asset 域仅对显式授权的文件/目录可达，与 `img-src` 同级信任）；**不引入 `wasm-unsafe-eval`**——wasm 解码器不用，但复制 `wasm/` 下两份 `*_nowasm_fallback.js` 及其许可，`getDocument` 显式 `useWasm:false` + `wasmUrl` 指向 fallback，JPEG2000/JBIG2/CCITT 走 JS 解码路径。

**Tech Stack:** Tauri 2 / TypeScript 原生 DOM / pdfjs-dist **6.4.299**（精确锁定，Apache-2.0）/ vitest+jsdom / cargo test。

**运行时与环境约束（实现前必须核对，不得臆测 API）：**
- **pdfjs 6.x API 以包内类型为准**：安装后先读 `node_modules/pdfjs-dist/types/**` 确认 `getDocument` 参数集（6.4 已移除 `isEvalSupported`；`render` 的参数形态以 d.ts 为准——按 d.ts 编码，不按旧版记忆编码）。
- **Node/CI 兼容**：pdfjs-dist 6.4 engines 要求 Node `>=22.13.0 || >=24`；本机 v24.21.0 满足；**CI `.github/workflows/ci.yml` 的 `node-version: 20` 必须随本任务升为 `24`**（不留豁免记录）；engine.ts 对 `pdfjs-dist` 一律**动态 `import()`**（单测 mock 注入，Node 侧永不加载真包）。
- **WebView2**：**直接采用 pdfjs-dist 配套 `legacy` 成对主库+worker**（`pdfjs-dist/build/legacy/…`），不做最低版本赌注；legacy 构建的语法约束即为本项目的运行时兼容下界。
- **Vite worker**：不经 Vite `new Worker(new URL(...))` 编译管线；以 legacy worker 的 `?url` 同源 URL 设 `GlobalWorkerOptions.workerSrc`，由 pdf.js 自行构造/管理 worker 与主线程降级；**不手动清空 workerSrc/workerPort**（清空会破坏 fake worker 导入），异步加载失败由 pdf.js 内置降级承接，外层只捕获最终错误。

**Spec:** 本文档即设计定稿（控制器 2026-10-29 拍板；事实核查与门评依据见文内 file:line）。

## Global Constraints

- 前端新依赖仅 `pdfjs-dist@6.4.299` 一个；Rust 零新 crate。
- PDF 页尺寸已知（viewport）——页占位高度用真实值；**尺寸获取有界分批且仅追加已实测页**（见 Task 4），禁止「打开即遍历全部 getPage」，也禁止未测页估高（如 A4 假设）。
- 提交纪律（本项目本次特批）：实现任务以「验证通过」收尾，由控制器统一本地 commit，**禁止 push 远程**。
- i18n zh/en 双语同步，键名 `pdf.*`，zh 两块、en 两块（位置照 `img.loadFail` 分布，`src/common/i18n.ts:301-315 / 973-987` 模式）；所有按钮加 `aria-label`/`title`，错误提示可被读屏播报（`role="alert"`）。
- 无障碍边界（如实声明，写进 PRD 与信息条首次提示）：纯 canvas 首版**不支持**正文选择/复制、全文搜索、屏幕阅读；键盘滚动/跳页/缩放必须可用（Tab 焦点、方向键、PageUp/Dn、Ctrl+滚轮）。
- 主题边界：外壳（工具条/背景/滚动条）继承 CSS 变量主题；**PDF 页面保持原始配色与白底**，暗色模式只加深页面周围衬底与阴影，不反相、不改文档颜色。
- 样式与交互对齐 image-view：信息条常显、类名 `.pdf-*`（`src/styles.css:65-76、157-165` 变量体系）。
- 全量门禁（收口任务）：`npx tsc --noEmit && npm test`；`cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo fmt --manifest-path src-tauri/Cargo.toml --check`；**打包后 WebView2 真实样本冒烟**（见 Task 8）。
- 验收编号 **ac-011**（docs/ 现有最大 ac-010）。
- 每任务完成跑该任务测试；不跑全量（控制器统一跑）。

## 事实基础（已核查，file:line 相对仓库根）

- CSP 现值 `src-tauri/tauri.conf.json:16`：`default-src 'self'; img-src 'self' data: asset: http://asset.localhost; … connect-src 'self' ipc: http://ipc.localhost; …`；未配置 `worker-src`（回落 `default-src 'self'`——同源 workerSrc 可加载）；asset 协议已启用（:17-20）；Rust 端授权已有目录级（`src-tauri/src/lib.rs:54-60`）**与文件级（`lib.rs:64-69`，前端包装 `src/common/ipc.ts:200` 附近，含路径规范化）——直接复用，不新增命令**；文件元数据（大小/mtime）已有 `fileStat`（`src/common/ipc.ts:82`）。
- PDF 现状：`.pdf` → 语言 `Pdf`、route `Text`（`src-tauri/src/kind_detect/mod.rs:30-35、134-139、164-168`；route 枚举 :8-14 仅 Text/Image）；文本提取 `src-tauri/src/ooxml/pdf.rs`（入口 :272-276，提取 :148；**拒绝加密与压缩文本流**——回退描述必须如实；不得当大小探针用）；IPC `pdf_open`/`pdf_lines`（`src-tauri/src/commands/ooxml.rs:151-179`、`lib.rs:241-242`、前端 `src/common/ipc.ts:283-284`）；TextView 消费点 `src/text-view/view.ts:530-537、172`（按 `language === 'Pdf'` 初始化，不依赖 route——回退只需把标签路由改回 text，勿重新走检测）。
- 路由类型与会话链路（Task 7 全改）：`src/common/ipc.ts:5`（route 类型）、`src/common/state.ts:103/156`（会话恢复/序列化）、`src/shell/app.ts:503/561/1439-1444`（销毁/切换分支）；强制 view 模式 `app.ts:629`（`language: Pdf`）与 `:631`（非文本 route）已覆盖，无需扩展，测试锁行为即可。
- 尺子/右轨：`app.ts:2533` 按模式隐藏尺子——PDF 视图须隐藏文本尺子、不创建文本 minimap/右轨、使用自身滚动容器；切回文本视图后尺子/右轨恢复（测试锁）。
- 既有上限常量：OOXML 包 100MiB（`src-tauri/src/ooxml/mod.rs:20-24`）、CSV 256MiB（`src-tauri/src/commands/csv.rs:52-59`）、图片守护 16384px/66MP（`src/image-view/guard.ts:1-5`）。
- 视图路由点：image `src/shell/app.ts:1670-1692`、csv `:2208-2227`、文本 `:2253-2266`；子视图不写全局状态栏（image-view 视图内信息条先例 `:231-244`）。
- `src/pdf-view/` 无残留文件。

## Review Focus

1. **worker 降级链**：workerSrc 异步加载失败也必须降级主线程，查看不失效。→ Task 2 测试（mock reject 与同步 throw 两路）。
2. **加密/损坏 PDF 回退**：`PasswordException`/解析错误出错误卡片；「以文本模式打开」把标签路由切回 text（复用 TextView+`pdfOpen`），**同时提示旧提取器不支持加密/压缩流，文本可能为空**，并提供「用系统查看器打开」出口；`pdf_open`/`pdf_lines` 现有测试零回归。→ Task 3 测试。
3. **守护边界与内存预算**：文件 >100MiB 拦、=100MiB 不拦（措辞用「超过产品阈值」不说必然 OOM）；单页渲染输出像素按 **DPR 后**值限 16.7MP 且单边 ≤8192；**可见页+预渲染+在途 canvas 总 RGBA 预算 ≤256MiB**（超出按距视口距离降采样），离场页 `page.cleanup()` 释放解码资源。→ Task 4/6 测试。
4. **异步竞态与取消**：`destroy()`/文档重载必须 AbortController 中止 fetch、等待期的 abort 立即 `loadingTask.destroy()`、在页渲染 `RenderTask.cancel()`；`doc.destroy()`/`loadingTask.destroy()` 各只调一次（幂等守卫）；迟到回调零 DOM 写入。→ Task 3/4 测试。
5. **Ctrl+滚轮与滚动不冲突**：无 Ctrl 原生滚动；Ctrl+滚轮以视口中心页为锚缩放。→ Task 5 测试。
6. **会话恢复竞态**：恢复会话打开 PDF 时文件级授权必须先于字节 fetch 完成。→ Task 7 测试。
7. **DPR 变化与焦点保持**：跨屏 DPR 变化后可见页按新 DPR 重渲染；页容器重绘/重排后焦点不丢失（焦点环仍在原控件或页流容器上）。→ Task 5 测试。

---

### Task 1: Rust `kind_detect` 新增 `Pdf` route

**Files:**
- Modify: `src-tauri/src/kind_detect/mod.rs`（route 枚举 :8-14 加 `Pdf`；`.pdf` 映射返回 `route: Pdf`、language 仍 `Pdf`；完整检测分支 :164-168 同步）
- Test: 同文件 `#[cfg(test)]`

**Interfaces:**
- Produces: `route: Pdf` 判定；serde 序列化值 `"pdf"`（前端 `tab.route === 'pdf'` 依赖）。
- 不改 `pdf_open`/`pdf_lines`/`ooxml/pdf.rs` 任何行为。

- [ ] Step 1 失败测试：`a.pdf` → `route == Pdf && language == Pdf`；`.txt`/`.png` 判定不变。
- [ ] Step 2 `cargo test --manifest-path src-tauri/Cargo.toml kind_detect` → FAIL
- [ ] Step 3 实现（枚举+映射+完整检测分支三处）
- [ ] Step 4 同命令 → PASS

---

### Task 2: pdfjs-dist 接入 + worker 降级 + 守护纯函数

**Files:**
- Modify: `package.json`（dependencies 精确 `pdfjs-dist: 6.4.299`）
- Modify: `.github/workflows/ci.yml`（`node-version: 20` → `24`，注释：pdfjs-dist 6.4 engines 要求——必改不留豁免）
- Modify: `src-tauri/tauri.conf.json:16`（connect-src 追加 `asset: http://asset.localhost`，注释说明；其余指令不动，**不加 wasm 相关指令**）
- Create: `src/pdf-view/engine.ts`（动态 import pdfjs、workerSrc 配置、getDocument 封装、AbortController 取消）
- Create: `src/pdf-view/guard.ts`
- Create: `scripts/sync-pdfjs-assets.mjs` + `vite.config.ts` 内联小插件（buildStart 复制 `node_modules/pdfjs-dist/{cmaps,standard_fonts}` 与 `wasm/*_nowasm_fallback.js`（含其许可文件）→ `public/pdfjs-assets/`，.gitignore 加 `public/pdfjs-assets/`；dev 与 build 同源可得；**其余 wasm 二进制不复制**）
- Test: `tests/ac-011-pdf-guard.test.ts`、`tests/ac-011-pdf-engine.test.ts`

**Interfaces:**
- engine.ts：`loadPdfBytes(path, signal): Promise<ArrayBuffer>`（`convertFileSrc` + fetch + arrayBuffer；abort 冒泡）；`openDocument(bytes, signal): Promise<{ doc, loadingTask }>`——内部动态 `import('pdfjs-dist/legacy/build/pdf.mjs')`（**legacy 成对构建**），legacy worker 经 `?url` 设 `GlobalWorkerOptions.workerSrc`；**不手动清空 workerSrc/workerPort**——worker 启动/加载失败由 pdf.js 内置主线程 fake worker 降级承接，外层只捕获最终错误；`getDocument` 参数按 d.ts 核对后传 `cMapUrl/standardFontDataUrl = '/pdfjs-assets/…'`、`useWasm:false`、`wasmUrl` 指向 fallback 资产；**abort 语义：等待 loadingTask 的 promise 期间收到 signal → 立即 `loadingTask.destroy()` 并让 promise 以 AbortError 结束；失败路径同样清理；`doc.destroy()`/`loadingTask.destroy()` 幂等守卫各只执行一次**。**API 细节（含 render 用法）一律以 `node_modules/pdfjs-dist/types` 为准，编码前先把关键签名抄进代码注释。**
- guard.ts：`PDF_MAX_FILE_BYTES = 100 * 1024 * 1024`（对齐 `ooxml/mod.rs`，注释互引；措辞「产品阈值」）；`PDF_MAX_PAGE_PIXELS = 16_700_000`（**DPR 后**）、`PDF_MAX_SIDE = 8192`、`CANVAS_BUDGET_BYTES = 256 * 1024 * 1024`（**可见+预渲染+在途** RGBA 总预算）、`ZOOM_MIN = 0.1`、`ZOOM_MAX = 8`、`clampScale(baseW, baseH, scale, dpr)`（像素与单边双约束按比例下调）、`shouldGuardFile(sizeBytes)`、`shouldWarnPages(n)`（`> 2000` 提示不阻止）。
- 测试：guard 纯函数边界（恰 100MiB 不拦/+1 拦；clampScale 数学含 DPR 与单边；预算函数含在途页）；engine 以 `vi.mock` 注入假 pdfjs 模块与 `?url` import——覆盖 workerSrc 设置、加载失败由内置降级承接（外层不重复造 worker）、abort 等待期立即 destroy、重复 destroy 幂等、abort 传播。

- [ ] Step 1 失败测试 → [ ] Step 2 vitest FAIL → [ ] Step 3 实现（npm i -D 无关；npm i pdfjs-dist@6.4.299 --save-exact）→ [ ] Step 4 vitest PASS + `npx vite build` 确认 `public/pdfjs-assets/` 进产物、worker 文件以独立 URL 产出、`npx tsc` 过

---

### Task 3: PdfView 骨架（加载态/错误卡片/文本回退/取消）

**Files:**
- Create: `src/pdf-view/view.ts`（构造签名对照 `src/image-view/view.ts:47-50`；`mount()/destroy()`）
- Modify: `src/common/i18n.ts`（`pdf.loadFail/encrypted/encryptedNote/fallbackText/openSystem/loading` 等）
- Modify: `src/styles.css`（`.pdf-view` 暗色衬底不改页面色、`.pdf-info`、`.pdf-err`）
- Test: `tests/ac-011-pdf-view.test.ts`

**Interfaces:**
- mount：加载态（`role="status"`）→ `loadPdfBytes`（AbortController）→ `openDocument` → Task 4 渲染。加密（`PasswordException`）/解析错误 → `.pdf-err` 卡片（`role="alert"`）：原因 + 三出口——『重试』『以文本模式打开』（回调 `onFallbackToText(path)`，卡片文案**如实**注明旧提取器不支持加密与压缩文本流、文本可能为空）『用系统查看器打开』（`openWithDefault`）。
- 超限（Task 6）→ `.pdf-guard` 卡片（同样给文本回退与系统查看器出口；文本通道同受 100MiB 限制时相应按钮置灰并说明）。
- destroy：abort fetch、`loadingTask.destroy()`（等待期 abort 由 engine 内部处理，见 Task 2）、`doc.destroy()`、移除监听；**两个 destroy 幂等守卫各只执行一次**；代际 token 双保险。
- 生命周期竞态测试：加载中 destroy → 无 DOM 写入、无未捕获 rejection（`unhandledrejection` 监听断言）。

- [ ] Step 1-4：TDD 循环（mock engine 四态 + destroy 竞态）。

---

### Task 4: 连续滚动渲染引擎（有界尺寸预取+canvas 池）

**Files:**
- Modify: `src/pdf-view/view.ts`
- Create: `src/pdf-view/pager.ts`（布局与渲染调度纯逻辑，jsdom 可测）
- Test: `tests/ac-011-pdf-pager.test.ts`

**Interfaces:**
- **尺寸预取有界分批、仅追加已实测页**：打开后仅取首批（视口 ±2 页）viewport 定占位；滚动接近未测页时增量 `getPage().getViewport()`（每批 ≤8 页、可取消——批内页面离场即弃）；**页流只包含已测得尺寸的页，未测页不出现、不用 A4 等估高、无跳变动画**；文档总高度随实测推进增长（页流尾部显示「测量中…」指示与可取消的测量进度，远距离跳页先等目标页测量完成再滚动定位）。>2000 页文档永不全量预取。
- 布局：`.pdf-flow > .pdf-page`；占位高度 = 基准高 × scale（含页间距）；适应窗/100%/自由倍率三模式（对齐 image-view 语义）；原生 `/Rotate` 由 viewport 自带 rotation 处理，用户旋转叠加（0|90|180|270，占位宽高随之交换）。
- 渲染：IntersectionObserver（root=滚动容器，rootMargin 上下各 1 页高）定待渲染集合；render 参数按 d.ts（`canvas` 形态）；`RenderTask.cancel()` 取消旧任务；**canvas 池 LRU**：默认 ≤6 页满分辨率；**可见页 >6 或（可见+预渲染+在途）RGBA 总量逼近 `CANVAS_BUDGET_BYTES` 时按距视口距离降 dpr 渲染**（预算数学进 pager.ts 纯函数）；滚出页 `canvas.width=0` 释放并调用 **`page.cleanup()`** 释放解码图像缓存；预算与池上限对在途渲染任务同样生效（排队时即计入）。
- resize/容器宽变化：ResizeObserver 重算 fit scale 与占位（只写样式，不重读布局）；混合页尺寸文档（每页独立基准宽高）必须正确。
- 代际 token：destroy/文档重载自增，异步回调先查再写。
- jsdom 测试：mock canvas/IntersectionObserver/ResizeObserver——占位数学（含混合尺寸、/Rotate、用户旋转）、有界预取批次与取消、**未测页不进页流**、池上限/LRU/降 dpr 预算（含在途页）、`cleanup()` 调用、代际丢弃。

- [ ] Step 1-4：TDD 循环。

---

### Task 5: 信息条（页码/缩放/旋转）+ Ctrl+滚轮 + 键盘

**Files:**
- Modify: `src/pdf-view/view.ts`、`src/styles.css`（`.pdf-info` 常显底部固定，照 `.img-info`）
- Modify: `src/common/i18n.ts`（`pdf.zoomIn/zoomOut/fit/rotateL/rotateR/pageJump/pageOf` 等）
- Test: `tests/ac-011-pdf-view.test.ts`（追加）

**Interfaces:**
- 信息条：⟲ / − / `百分比|适应窗` / + / ⟳ / 页码框 `当前/总页`（回车跳转，滚动定位目标页顶）；全部控件 `aria-label`/`title`。
- 缩放：`zoomBy(1.25/0.8)`；双击 fit↔100；Ctrl+wheel `preventDefault` 以视口中心页为锚；clamp 全入口（含 dpr 后像素守护）。
- 键盘：方向键/PageUp/Dn/Home/End 滚动（聚焦页流容器，`tabindex="0"`、焦点环可见）；Tab 在信息条控件间移动；**页容器重绘/重排/DPR 变化重渲染后焦点保持**（焦点元素被替换时移回等位控件）。
- 测试：zoom clamp、Ctrl+wheel 锚定数学、跳页、双击循环、键盘事件、DPR 变化触发重渲染且焦点保持、destroy 移除监听。

- [ ] Step 1-4：TDD 循环。

---

### Task 6: 守护与限制接线

**Files:**
- Modify: `src/pdf-view/view.ts`（mount 前置 `shouldGuardFile`——大小取自既有 `fileStat`（`src/common/ipc.ts:82`，打开流程中已有的元数据；**不得用 `pdf_open` 当探针**——它会执行文本提取且可能失败））
- Modify: `src/common/i18n.ts`（`pdf.guardTitle/guardDesc/tooLargeForText` 等；**禁用「必然 OOM」类绝对表述**，用「超过产品安全阈值」）
- Test: `tests/ac-011-pdf-guard.test.ts`（追加接线用例）

**Interfaces:**
- >100MiB：守护卡片（描述含实际大小），出口=文本回退（若文本通道同超限则置灰说明）+ 系统查看器；**无「仍要加载」**（与图片守护语义不同，注释说明理由：渲染型加载无渐进安全档）。
- >2000 页：信息条提示徽标，不阻止。
- 单页像素/单边/总预算：clamp 接入 Task 5 全部缩放入口。

- [ ] Step 1-4：TDD 循环。

---

### Task 7: shell 路由接线（全链路）

**Files:**
- Modify: `src/common/ipc.ts`（:5 route 类型加 `'pdf'`；文件级授权**直接复用既有包装**——lib.rs:64-69 / ipc.ts:200 附近已有文件级授权与路径规范化，不新增 Rust 命令）
- Modify: `src/common/state.ts:103/156`（route 序列化/恢复接受 `'pdf'`）
- Modify: `src/shell/app.ts`（:1670-1692 旁加 `tab.route === 'pdf'` → `new PdfView(...)`，打开时调用既有文件级授权包装（先于任何字节 fetch）；:503/561/1439-1444 销毁/切换分支覆盖 pdf route；:2533 尺子隐藏覆盖 PDF 视图——隐藏文本尺子、不建文本 minimap/右轨、切回文本恢复；`onFallbackToText`：把该标签 route 切回 `'text'` 走 TextView+`pdfOpen` 初始化（复用 :2253-2266 与 `src/text-view/view.ts:530-537` 路径，不重新走文件检测）；:629/:631 强制 view 模式已覆盖——只加测试不改逻辑）
- Test: `tests/ac-011-pdf-route.test.ts`（mock PdfView：路由创建、文件级授权先于 fetch、fallback 切 text 不重检测、尺子/右轨隐藏与恢复、会话恢复含 pdf 标签）

- [ ] Step 1-4：TDD 循环（聚焦测试 + `tests/ac-001-` 壳层回归不破）。

---

### Task 8: 收口（文档同步 + 全量门禁 + 真实冒烟）

**Files:**
- Modify: `docs/PRD.md`（PDF 能力改「pdf.js 整页渲染查看 + 文本回退（不支持加密/压缩流提取）」；无障碍边界如实；边界区更新）
- Modify: `docs/CHANGELOG.md`（「未发布」新增 PDF 查看条目）
- Modify: `THIRD-PARTY-NOTICES.md`（pdfjs-dist 6.4.299 / Apache-2.0；cmaps 与 standard_fonts 数据归属以包内 LICENSE/README 为准如实记录；对照现有 npm 条目格式）
- Modify: `docs/changes/pdf-view-plan.md`（标记收口）

**Steps:**
- [ ] 全量门禁（Global Constraints 六命令全绿；CI node 已升 24）
- [ ] **真实安装包冒烟（强制，不得以 dev 模式替代）**：`npm run tauri build` 产 NSIS 安装包并实际安装后逐项核：普通多页 PDF（滚动/缩放/跳页/旋转/键盘/暗色衬底不反相）、加密 PDF（卡片+回退提示+系统查看器）、损坏文件、>100MiB 构造文件（守护卡）、CJK 扫描版（cmap/无 wasm JS 解码降级观察）、混合页尺寸与原生 /Rotate、Ctrl+滚轮锚定、resize/DPR 变化重排与焦点保持、会话恢复后重开 PDF（授权先于 fetch）
- [ ] 控制器统一本地 commit（禁 push）
