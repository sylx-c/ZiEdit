# 图片查看器补强 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 图片查看器补齐可发现性（常显缩放控件+双击）、拖拽平移、90° 旋转、超大图解码前守护，并补前后端测试。

**Architecture:** 渐进增强现有 `src/image-view/view.ts`（`<img>` + CSS transform，不引库不重写 canvas）。Rust 侧新增 `image_probe` 命令只读文件头取尺寸（imagesize crate），前端纯函数判定是否守护；守护时展示卡片而非解码，fail-open。

**Tech Stack:** Tauri 2 / Rust（imagesize crate）/ TypeScript 原生 DOM / vitest+jsdom / cargo test。

**Spec:** `docs/changes/image-view-enhance.md`（已获用户批准的设计）

## Global Constraints

- 无新前端依赖；Rust 侧仅新增 `imagesize` 一个 crate。
- **不自动 `git commit` / `git push`**——项目三原则：提交与推送永远等用户授权。各任务以「验证通过」收尾，提交由用户在收口任务后统一决定。
- i18n zh/en 双语同步，键名沿用 `img.*` 模式，四处键位块都要加（zh 两块、en 两块，位置照现有 `img.loadFail` 的分布）。
- 常规路径图片字节走 asset 协议不经 IPC（性能红线）；`image_probe` 是唯一例外（一次性、仅文件头）。
- 每任务完成跑该任务的测试；收口任务跑全量门禁：`npm test`、`npx tsc --noEmit`、`cargo test`、`cargo clippy --all-targets -- -D warnings`、`cargo fmt --check`（manifest 均 `src-tauri/Cargo.toml`）。
- 验收编号 **ac-010**（tests/ 现有最大 ac-009）。
- 样式与交互遵循现有 H-2 工具栏上下文段模式与 `.img-view`/`.img-canvas` 类名体系（`src/styles.css:1659-1664`）。

## Review Focus

1. **SVG/GIF 不探测**：`a.svg`/`a.gif` 打开不走 probe，行为与今天一致。→ Task 6 测试断言 `imageProbe` 未被调用。
2. **探测 fail-open**：probe 返回 null/报错时必须照常加载图片，守护绝不拦截正常图。→ Task 6 测试 null → `<img>` 出现。
3. **旋转×缩放组合换算**：旋转 90° 后 100%/fit 的宽高须交换（含 +48px padding 补偿），不交换会显示错位。→ Task 5 测试断言 frame 宽高互换。
4. **守护卡片动作可用**：「用系统查看器打开」真实调用 `openWithDefault(path)`。→ Task 6 测试断言 invoke 被调。
5. **destroy 后无僵尸监听**：切换标签后 dispatch 拖拽/滚轮事件不抛错不产生副作用；双击前的两次 press/release 无移动时不平移。→ Task 4 测试 destroy 后 dispatch 无异常、零位移 press/click 不改 scrollLeft。

---

### Task 1: Rust `image_probe` 命令（文件头尺寸探测）

**Files:**
- Modify: `src-tauri/Cargo.toml`（[dependencies] 加 imagesize，注释：图片查看守护（ac-010）——仅解析文件头取尺寸，不解码像素）
- Modify: `src-tauri/src/commands/misc.rs`（与 `image_write` 同文件，:322 附近）
- Modify: `src-tauri/src/lib.rs`（invoke_handler，:261 `commands::misc::image_write` 旁）

**Interfaces:**
- Produces: `commands::misc::image_probe(path: String) -> Result<Option<ImageProbeInfo>, ZiEditError>`（`pub async fn`，探测逻辑 `spawn_blocking` 包裹，模式照 `search.rs:289`）；`ImageProbeInfo { width: u32, height: u32, format: String }`（`#[derive(Serialize)]`，与 misc.rs 现有返回类型的 serde 用法一致）。**任何失败（文件不存在/非图片/解析错误）一律 `Ok(None)`，不返回 Err**——fail-open 语义，前端 None 即照常加载。

- [ ] **Step 1: 写失败测试**（misc.rs 尾部 `#[cfg(test)]`，沿用本文件现有测试风格）

测试用例（fixture 用内联字节数组写 `std::env::temp_dir()` 下唯一临时文件）：
- `image_probe_png_returns_dims`：嵌入 1×1 PNG 完整字节（67 字节标准 blob）→ `Ok(Some(info))`，`info.width == 1 && info.height == 1`
- `image_probe_bmp_returns_dims`：手写 54 字节 BITMAPINFOHEADER（宽 800 高 600 写入偏移 18/22）→ `Ok(Some(_))` 且 800×600
- `image_probe_text_file_none`：内容 `b"hello world"` 的文件 → `Ok(None)`
- `image_probe_missing_file_none`：不存在的路径 → `Ok(None)`

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml image_probe`
Expected: 编译失败（`image_probe` 未定义）

- [ ] **Step 3: 实现**

Cargo.toml 加 `imagesize = "0.13"`；misc.rs 加 `ImageProbeInfo` 与 `image_probe`（`imagesize::size(&path)` 映射 `ImageSize{width,height}` + `imagesize::image_type` 取格式名，失败全部 `Ok(None)`，`log::warn!` 记录原因）；lib.rs 注册。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml image_probe`
Expected: 4 passed

---

### Task 2: 前端 ipc 封装 + 守护阈值纯函数

**Files:**
- Modify: `src/common/ipc.ts`（`:193` `openWithDefault` 附近加封装）
- Create: `src/image-view/guard.ts`
- Test: `tests/ac-010-image-guard.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `image_probe` 命令。
- Produces: `imageProbe(path: string): Promise<{ width: number; height: number; format: string } | null>`（ipc.ts，invoke 失败 catch → null，与命令的 Ok(None) 双保险）；guard.ts 导出 `GUARD_MAX_SIDE = 16384`、`GUARD_MAX_PIXELS = 66_000_000`、`shouldGuard(w: number, h: number): boolean`（`w > GUARD_MAX_SIDE || h > GUARD_MAX_SIDE || w * h > GUARD_MAX_PIXELS`）、`isProbeableImage(path: string): boolean`（扩展名小写后 ∈ png/jpg/jpeg/webp/bmp）。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/ac-010-image-guard.test.ts
import { describe, it, expect } from 'vitest';
import { shouldGuard, isProbeableImage, GUARD_MAX_SIDE, GUARD_MAX_PIXELS } from '../src/image-view/guard';

describe('shouldGuard 阈值（ac-010）', () => {
  it('16384 边长恰在限内不守护，16385 守护', () => {
    expect(shouldGuard(16384, 4000)).toBe(false);
    expect(shouldGuard(16385, 10)).toBe(true);
    expect(shouldGuard(10, 16385)).toBe(true);
  });
  it('像素超 66MP 守护，64MP 不守护', () => {
    expect(shouldGuard(8000, 8000)).toBe(false);          // 64MP
    expect(shouldGuard(8126, 8126)).toBe(true);            // ≈66.03MP
    expect(GUARD_MAX_PIXELS).toBe(66_000_000);
    expect(GUARD_MAX_SIDE).toBe(16384);
  });
});

describe('isProbeableImage 仅位图探测（ac-010）', () => {
  it('png/jpg/jpeg/webp/bmp 大小写不敏感', () => {
    for (const p of ['a.png', 'A.JPG', 'b.WebP', 'c.bmp', 'd.jpeg']) expect(isProbeableImage(p)).toBe(true);
  });
  it('svg/gif/无扩展名不探测', () => {
    for (const p of ['a.svg', 'a.gif', 'a.txt', 'noext']) expect(isProbeableImage(p)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ac-010-image-guard.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 guard.ts 与 ipc.imageProbe**（签名见 Interfaces；Windows 路径 `\` 与大小写按扩展名小写比较处理）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ac-010-image-guard.test.ts`
Expected: PASS

---

### Task 3: 信息条缩放控件重构 + 双击循环

**Files:**
- Modify: `src/image-view/view.ts`（`showInfo()` :124-144 重构）
- Modify: `src/common/i18n.ts`（zh/en 各两块，照 `img.loadFail` 的分布位置）
- Modify: `src/styles.css`（`.img-info` 控件样式：按钮组、分隔）
- Test: `tests/ac-010-image-view.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `zoomBy/fitToWindow/zoom100/toggleFitMode`（view.ts :73-99，保留全部——工具栏 tbimg.* 依赖它们）。
- Produces: 信息条 DOM 结构 `.img-info > (.img-ctrl[title=缩小] , .img-pct 文本 , .img-ctrl[title=放大] , .img-fitbtn)`；`displayMode` getter 语义不变（fit/100/zoom）；新增行为：图片 `dblclick` 时 `fit → 100 → fit` 循环。

新增 i18n 键（zh 先行，en 对应 Zoom in/Zoom out/Fit to window）：
`'img.zoomIn': '放大'`、`'img.zoomOut': '缩小'`、`'img.fit': '适应窗'`（按钮 title 用）。

- [ ] **Step 1: 写失败测试**

jsdom 无真实解码，`mount()` 后手动 `img.dispatchEvent(new Event('load'))`，再断言（参考 tests/ 现有 mock 手法，`vi.mock('@tauri-apps/api/core')` 让 `convertFileSrc` 返回 `asset://x`，并 `vi.stubGlobal('__TAURI_INTERNALS__', {})`）：
- `信息条有 −/百分比/+/适应窗 四件`：load 后 `.img-info` 存在，含 2 个 `.img-ctrl` 按钮、`.img-pct` 文本为「适应窗」（img.modeFit）、`.img-fitbtn` 存在
- `点击放大进入自由倍率并显示百分比`：点 `.img-ctrl`（放大）→ `displayMode === 'zoom'`、`.img-pct` 文本变为 `125%`
- `点击缩小回到 100%`：再点缩小 → `.img-pct` 为 `100%`
- `双击循环 fit→100→fit`：img 上派发两次 `dblclick` → displayMode 依次 `'100'`、`'fit'`

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ac-010-image-view.test.ts`
Expected: FAIL（无 .img-ctrl/.img-pct）

- [ ] **Step 3: 实现**

`showInfo()` 改为一次性构建控件条（meta 文本并入 `.img-pct`）；−/+ 分别调 `zoomBy(0.8)/zoomBy(1.25)`（与工具栏 tbimg 同参数）；`zoomBy` 内当 `scale` 恰为 1 时 `fitMode` 置 `'100'`（保证百分比显示与 displayMode 一致）；img 上加 `dblclick` 监听实现循环；`destroy()` 移除新增监听。CSS 加 `.img-ctrl`（无边框小按钮，复用现有工具栏按钮变量）与 `user-select: none`（防双击选中文本，见 Review Focus 5）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ac-010-image-view.test.ts`
Expected: PASS（含 Task 2 的 guard 测试同跑无回归：`npx vitest run tests/ac-010-`）

---

### Task 4: 拖拽平移（程序化滚动）

**Files:**
- Modify: `src/image-view/view.ts`
- Modify: `src/styles.css`（`.img-canvas` 光标 grab；`.img-view.panning .img-canvas` grabbing）
- Test: `tests/ac-010-image-view.test.ts`（追加）

**Interfaces:**
- Consumes: Task 3 后的 view.ts 结构。
- Produces: 指针拖拽（左键 0 / 中键 1）平移：`pointerdown` 于 `.img-canvas` → `setPointerCapture`，`pointermove` 时 `wrap.scrollLeft -= movementX; wrap.scrollTop -= movementY`；`pointerup/cancel` 结束；不依赖 overflow 判定（无溢出时位移自然无效）。`destroy()` 移除监听。

- [ ] **Step 1: 写失败测试**

- `拖拽改变滚动位置`：load 后设 `img.getBoundingClientRect` 无关；直接在 img 上派发 `pointerdown`（`{ button: 0, clientX: 100, clientY: 100 }`）→ `pointermove`（`{ clientX: 80, clientY: 90 }`）→ `pointerup`；断言 `wrap.scrollLeft === 20 && wrap.scrollTop === 10`
- `无移动的按下抬起不平移`：down(100,100) → up(100,100)；断言 scrollLeft/Top 均为 0
- `destroy 后派发事件无异常`：`iv.destroy()` 后再派发 pointerdown/move/up 与 wheel，不抛错且 DOM 已清空

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ac-010-image-view.test.ts`
Expected: 新用例 FAIL（scrollLeft 不变）

- [ ] **Step 3: 实现**

用 `pointerdown` + `setPointerCapture(e.pointerId)`；位移取 `e.movementX/Y`（jsdom 支持，事件构造时传入）；拖拽中给 wrap 加 `.panning` 类切换光标。滚轮语义不变（无 Ctrl 原生滚动）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ac-010-image-view.test.ts`
Expected: PASS

---

### Task 5: 90° 旋转（含 fit/100% 重算）

**Files:**
- Modify: `src/image-view/view.ts`（新增 `.img-frame` 内层包裹）
- Modify: `src/styles.css`（`.img-frame` 尺寸由 JS 设定、`transform-origin: center`；img 绝对居中于 frame）
- Modify: `src/common/i18n.ts`（`'img.rotateL': '左转 90°'`、`'img.rotateR': '右转 90°'`，en 对应）
- Test: `tests/ac-010-image-view.test.ts`（追加）

**Interfaces:**
- Consumes: Task 3 的信息条控件条。
- Produces: `rotate(delta: 1 | -1)` 方法（工具栏/信息条可调）；内部状态 `rotation: 0|90|180|270`；信息条加 2 个 `.img-rot` 按钮（⟲/⟳）置于 −/+ 左侧；**结构变更**：`wrap > .img-frame > img`，frame 的显式宽高 = 旋转后视觉宽高 × 缩放 + 48px padding（transform 不影响布局，frame 承担布局占位，img 在 frame 内 `transform: rotate(Ndeg)`）。

- [ ] **Step 1: 写失败测试**

测试内用 `Object.defineProperty(img, 'naturalWidth', { value: 800 })`、`naturalHeight: 600`（jsdom 下这两个属性可覆盖）：
- `100% 模式旋转 90° 后 frame 宽高互换`：load → `zoom100()` → `rotate(1)`；断言 frame.style.width 为 `648px`（600+48）、height 为 `848px`（800+48）；再 `rotate(1)` 两次回到 0° 断言恢复 `848/648`
- `适应窗模式下旋转仍保持 fit`：rotate 后 `displayMode === 'fit'` 且 img 带 `.fit` 类
- `信息条含左右旋转钮`：2 个 `.img-rot`，点击各触发 rotation 变化（经 frame 宽高断言）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ac-010-image-view.test.ts`
Expected: FAIL（无 frame/rotate）

- [ ] **Step 3: 实现**

`applyFit()` 改为按 `rotation % 180 !== 0` 交换 `naturalWidth/Height` 计算 frame 尺寸（fit 模式 frame 尺寸清空交由 CSS `max-width/max-height` 约束 img，注意 `.fit` 类从 img 挪到 frame 的等效处理——保持工具栏 checked 判定 `displayMode` 不受影响）；padding 补偿逻辑（原 :117-120）随迁至 frame 尺寸计算。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ac-010-image-view.test.ts`
Expected: PASS

---

### Task 6: 超大图守护卡片（probe 接线）

**Files:**
- Modify: `src/image-view/view.ts`（`mount()` 前置探测）
- Modify: `src/common/i18n.ts`（4 键，见 Step 3）
- Modify: `src/styles.css`（`.img-guard` 卡片，视觉沿用 `.img-err` 的占位风格）
- Test: `tests/ac-010-image-view.test.ts`（追加，`vi.mock('../src/common/ipc')` 控制 `imageProbe`/`openWithDefault`）

**Interfaces:**
- Consumes: Task 1 命令、Task 2 的 `imageProbe/isProbeableImage/shouldGuard`、ipc.ts:193 `openWithDefault`。
- Produces: mount 流程变为：`isProbeableImage(path)` → `imageProbe(path)` → 命中 `shouldGuard` 且未强制 → 渲染 `.img-guard` 卡片（标题/尺寸说明/两按钮），**不创建 img、不调 fileSrc**；「仍要加载」置 `forceLoad = true` 后走原 mount 流程（不再 probe）；「用系统查看器打开」调 `openWithDefault(path)`。

- [ ] **Step 1: 写失败测试**

- `超大 png 展示守护卡片且不建 img`：mock `imageProbe` resolve `{ width: 20000, height: 20000, format: 'png' }`；mount 后断言 `.img-guard` 存在、`wrap.querySelector('img') === null`、卡片文本含 `20000×20000`
- `仍要加载进入正常加载`：点卡片「仍要加载」按钮 → `wrap.querySelector('img')` 非空
- `用系统查看器打开`：mock `openWithDefault`；点对应按钮 → 断言以图片路径被调用一次
- `探测失败 fail-open`：`imageProbe` resolve null → img 非空、无卡片
- `svg 不探测`：路径 `a.svg`，断言 `imageProbe` 未被调用、img 非空

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ac-010-image-view.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**

i18n 新键（en 对应）：
`'img.guardTitle': '超大图片，已跳过解码'`、`'img.guardDesc': '原始尺寸 {0}×{1}，超过安全阈值（边 >{2}px 或 >{3}MP），直接解码可能导致程序卡死。'`、`'img.guardOpen': '用系统查看器打开'`、`'img.guardLoad': '仍要加载'`。
卡片结构 `.img-guard > (.img-guard-title, .img-guard-desc, .img-guard-actions > 2 buttons)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/ac-010-`
Expected: 全部 PASS（guard + view 两组）

---

### Task 7: 收口（文档同步 + 全量门禁）

**Files:**
- Modify: `docs/PRD.md:32`（图片查看括注补「拖拽平移/90° 旋转/超大图守护」）
- Modify: `docs/CHANGELOG.md`（「未发布」节新增条目：信息条常显缩放控件、双击循环、拖拽平移、90° 旋转、超大图守护卡片、ac-010 测试）
- Modify: `docs/changes/image-view-enhance.md`（标记定稿/收口）
- Modify: `THIRD-PARTY-NOTICES.md`（仅当该文件现有条目覆盖 Rust crate 依赖时才加 imagesize；先看文件现有范围，npm/vendored-only 则不加——事实决定，不臆断）

- [ ] **Step 1: 全量门禁**

Run: `npx tsc --noEmit && npm test`
Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo fmt --manifest-path src-tauri/Cargo.toml --check`
Expected: 全绿（110+6 前端测试通过、Rust 109+4）

- [ ] **Step 2: 文档同步**（按上表改四文件；CHANGELOG 措辞面向使用者）

- [ ] **Step 3: 手动冒烟（可选但推荐）**

`npm run tauri dev` 打开：一张普通 png（缩放/双击/拖拽/旋转）、一张 svg（不守护直接显示）、`docs/` 下任选文件改扩展名场景不适用——超大图可用脚本生成 20000×20000 png 验证卡片。

- [ ] **Step 4: 请用户授权提交**（列出变更文件清单，等授权；不自行 commit）
