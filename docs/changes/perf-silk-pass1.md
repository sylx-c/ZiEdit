# perf-silk Pass 1 — 打开/输入/操作快路径优化（草稿卡）

状态：草稿（oracle 实施前评审中）· 2026-10-26 · 任务索引：`.slim/deepwork/perf-silk/progress.md`

## 依据

三路只读审计（前端 src/、后端 src-tauri/、构建与门禁）结论汇总，证据为文件:行号，见审计任务结果。要点：

- 打开慢：前端 4 次串行 IPC（openFile→textOpen→textOpen→textReadAll，`shell/app.ts:523,1407` + `text-view/edit.ts:415,427`）；后端把文件读 3~4 遍（`kind_detect/mod.rs:171`、`encoding/mod.rs:203`、`file_engine/mod.rs:233`、`commands/text.rs:229`）；`text_read_all` 不复用块缓存（`commands/misc.rs:98`）。
- 输入卡：每次状态上报做全量序列化/选区切片（`edit.ts:1281-1301`、`app.ts:1428-1437`）；草稿标签每次按键全文 `toString()`；大纲停手 300ms 后全量解析（`app.ts:4394-4444`）；分屏预览 300ms 节流式全量 `toString`+全量块重渲（`app.ts:1658-1689`）；后端自动保存路径：快照每 10s 全目录重读重解析（`commands/recovery.rs:155-168`，最坏 640MB）。
- 操作卡：同步命令在 Tauri 主线程做重 I/O——OOXML 全家（`commands/ooxml.rs:63-193`，ZIP+XML 解析直接冻结 UI）、保存全量重编码+整文件备份拷贝+fsync（`commands/misc.rs:119-164`）、read_dir/session/recent（`commands/mod.rs:124-407`）、sysicon、font_read(32MB+base64)；流式查看/CSV 滚动未 rAF 节流（`text-view/view.ts:937`、`csv-view/table.ts:254`）；标尺每帧全量重建+强测布局（`app.ts:2058-2101`）；文件树过滤无防抖（`file-tree/tree.ts:88`）。
- 首屏重：首屏 JS ≈1,481KB（codemirror 886 + index 630），13 个语言包模块级实例化（`text-view/highlight.ts:22-37`）+ 视图全部静态 import（`shell/app.ts:69-106`）；markdown-it 主线程+worker 双份打包（`markdown-view/{preview,headings,static-html}.ts`）。
- 已确认无需动：mermaid/MathJax 走 vendored 按需加载；Cargo release profile 全口径优化；滚动路径无昂贵 CSS；分块读取/虚拟化/有界性体系本身是对的。

## 目标（Pass 1 完成判据）

1. **打开**：打开路径 IPC 往返 4→≤2；后端对同一文件消除重复读；首屏 JS 体积降 40% 以上（目标 <900KB）。
2. **输入**：每次按键不再有 O(文档) 主线程工作；自动保存节拍内无全目录重解析；office 打开期间 UI 可交互。
3. **操作**：主线程零重 I/O（命令全部 async+spawn_blocking）；滚动路径 rAF 化；标尺增量绘制。
4. **零回归**：`vitest run`、`npx tsc --noEmit`、`cargo test`、`clippy -D warnings`、`fmt --check` 全绿；门禁 run-all 相对基线不劣化（基线固化于 `docs/tmp/gates-run/results/`）。

## 非目标（Pass 2 候选 / 需用户决策）

- IPC 原始字节通道（`tauri::ipc::Response`，改 ipc.ts 契约）。
- 保存备份拷贝语义 / fsync 策略（ADR 012 红线，不改语义，仅移出主线程+减少 stat）。
- 对比降级阈值语义变化（500 万行阈值不动，只加护栏）；`normalize_preview` 采样化（计数语义有单测锁定）。
- 快照增量/delta 化；标签栏节点复用（P2-1）；IR 增量上报（P2-2）；大纲全 Worker 化（本档只做指纹门控）。

## 门禁基线与复测（gpu 档，语料 dense-2m.md，结果 JSON 在 docs/tmp/gates-run/results/）

优化前（2026-10-26 基线）→ Pass 1 后（commit 795118e，同机同档复测）：

| 门禁 | 预算线 | 基线 | Pass 1 后 | 判定 |
|---|---|---|---|---|
| ac36 键入 p95 | ≤16ms | 42.5 | 36.4（max 51.2；>100ms 长任务 0） | FAIL→FAIL（−14%，长任务清零） |
| arrow 长任务>50ms | 0 | 78 次 | 4 次（p95 33.5→16.8） | FAIL→FAIL（−95%） |
| scroll 长任务>100ms | 0 | 207 次 | 81 次（帧 p95 164→117） | FAIL→FAIL（−61%） |
| ir-scroll 无表格 p95 | 基线+2ms | 33.5 | 16.9（带表格 33.3） | PASS→FAIL* |
| walk-f 外观矩阵 | 全过 | PASS | PASS（174s） | 持平 |

*ir-scroll 的对照侧（隐藏表格）从 33.5 提速到 16.9，表格渲染成本由此显形——绝对帧时间持平或更好，非回归。

结论：五项绝对读数全部持平或改善，但严格预算线（16ms p95 / 0 长任务）优化前从未达成，Pass 1 仍未全绿。剩余热点（Pass 2）：① 持续键入 ~36ms 尾延迟（实测分解：stateFields 10.7ms + decorations 14.9ms，每键全量重算）；② 滚动 81 次长任务——P2-B 诊断纠正：门禁驱动 `.cm-scroller`，2MB 语料默认进 IR 面，成因在 liveDeco 滚动全量重建/分片 dispatch、liveBlockField 视口强制重建、表格公式高度回填的逐帧强制测量（证据：扫描期 scrollHeight 增长 7.7 万 px），并非流式面；③ IR 表格帧 33ms（同 ② 的 B3）。

首屏 JS：1,516KB → ≈247KB（−84%，codemirror 886KB 与六视图/markdown-it 全部按需）。

## Pass 2（2026-10-27）：滚动与键入预算线攻坚

目标：把 Pass 1 未达标的滚动/键入预算线打绿。六轮实施（P2-A1~A6）+ 诊断车道（P2-B，纠正归因：scroll 门禁实测 IR 面而非流式面）+ 后端小项（P2-C）。

**终态门禁（gpu 档 dense-2m，第 7 轮复测 vs 基线）**：

| 门禁 | 基线 | 终态 | 判定 |
|---|---|---|---|
| scroll 长任务>100ms | 207（帧 p95 164） | **0（帧 p95 33.4）** | **PASS** |
| ir-scroll 表格帧 p95 | 33.3（对照 16.9） | **16.8 = 对照** | **PASS** |
| walk-f 跨主题几何 | — | 全过 | **PASS** |
| arrow 长任务>50ms | 78 | 1+1（6571 键；上轮 0+0，冷启动尖峰抖动） | FAIL（边缘） |
| ac36 键入 p95 | 42.5 | **31.9-32.8**（键序正确、max 41.6<50、>100ms 长任务 0） | FAIL（仅预算线，见下） |

**ac36 16ms 预算线的地板证据**：2.08M 语料末尾追加单字符，TreeFragment 未覆盖区间仅 1 字符、复用 79,998 子树，Lezer 增量解析中位 **13.24ms**；本仓全部状态字段合计 ~0.1ms。即 p95≈32 = 解析器固有地板 + 装饰 + CM 提交开销。**16ms 线低于该语料下 CM6 增量解析的物理下限**，需要产品决策：改预算（如 p95≤40 + 零长任务 + 键序正确），或改语料口径（<1MB），或保留为长期目标。

**实施内容**：滚动=装饰覆盖差集保留（B1）+ 视口差集重建/块件复用（B2）+ 高度停稳校准（B3）+ 8ms 帧预算渐进渲染与滚动占位（512 字符分片，主题/resize/字体刷新同步完整渲染）；键入=普通段落快路（局部重建，结构内容快路因引入丢字与视觉回归已回退并锁定回归测试）；后端=text_find 锁外读取 + JoinError 日志；门禁=逐事件/分相/IR 探针观测增强。

**教训记录**：键入结构快路（A3/A4）三轮引入键序丢失与跨主题几何漂移，第五轮按「键入/滚动改动可分离」假设拆分回退成功——大文档 CM6 场景下「装饰局部化」的安全边界是段落级，结构级（表格/围栏内编辑）需要完全不同的机制（如受控单元格编辑器），列入 Pass 3 候选。

## 收口评审（oracle，2026-10-27）

实施后 oracle 收口门禁结论「修正后放行」，9 项必修全部落地（commit 795118e）：

1. 保存后 TextRegistry 缓存失效 + text_read_all 版本校验（保存切回不读旧内容）
2. textOpen 备忘补齐 refresh/close/索引事件/编码切换四类失效（尾随台不再冻结）
3. markdown 同步入口就绪屏障 + 冷启动回退测试（6 用例）
4. 懒加载迟到续体代际屏障 + 独立包装层（首开切换不被清屏）
5. recent/favorites/session 持久化事务串行锁（并发不丢更新，32/16 线程回归）
6. 对比采样改成员判定（抗位移误降级）+ 降级块→行映射（修复既有块号当行号问题）
7. preview 计数确定性路由（等行数逐位配对/大而异整体替换，不随机器速度漂移）
8. ooxml/csv 发布以磁盘版本仲裁（晚到旧扫描不覆盖、外部改写必重扫）
9. recovery 遗留命名兼容（list 可见即可读可弃 + 总量兜底纳入遗留文件）

延后到 Pass 2：JoinError 静默兜底补日志、text_find 读取仍持全局锁、语言包静态打包、composition.ts 依赖边、IPC 字节通道、快照增量、块缓存全局预算。

## 车道划分（写域互斥）

| 车道 | 写域 | 内容 |
|---|---|---|
| FA shell 快路径 | `src/shell/**`、`src/common/ipc.ts`、`src/common/snapshot.ts` | ① ipc.ts：`textOpen` 结果按 path 备忘（关闭时清除），打开路径 `Promise.all` 并行化；② 草稿内容按需序列化（脏标/切标签/关闭时才 `toString()`）；③ `renderStatus()` rAF 合并；④ 分屏预览节流→重置防抖+最长等待 1s（见决策）；⑤ 大纲指纹门控+避免重复全量 `toString()`（主线程保留）；⑥ 标尺探针宽度缓存+差量更新；⑦ 视图懒加载：`app.ts:69-106` 六视图改动态 import（参照 `livepreview.ts:92-105` 范例） |
| FB 编辑器+bundle+轻视图 | `src/text-view/**`、`src/csv-view/**`、`src/file-tree/**`、`vite.config.ts` | ① `highlight.ts` 13 语言 parser 惰性化（getParser 缓存）；② `edit.ts` langExt 改动态 import（Compartment 二次 reconfigure）；③ `report()` 选区字数免 sliceString；④ `view.ts` scroll 上报 rAF 合并、书签排序缓存；⑤ CSV scroll rAF+行复用池；⑥ 文件树过滤防抖+索引缓存；⑦ vite manualChunks 细化+恢复 chunk 警告线；⑧ 修 `table.ts` 对 ipc.ts 的无效动态 import |
| FC markdown 视图 | `src/markdown-view/**` | ① markdown-it 三处实例合一为共享惰性实例（消 worker/主线程双份打包）；② `render-service.ts` 水合 target 池复用（免全量 querySelectorAll）；③ `blockcache` 渲染入参免全量字符串复制（能做则做） |
| BE1 后端 async+恢复 | `src-tauri/src/commands/{ooxml,misc,mod,recovery}.rs`、`sysicon.rs` | ① 同步命令全部 `async fn`+`spawn_blocking`（照抄 `search.rs:289` 写法；ooxml 全家、misc 保存/format_json/format_xml/font_read/image_write、mod.rs read_dir/open_file/session_*/recent_*/favorites_*、sysicon）；② `recovery_snapshot/list/read/discard` 改按文件名模式定位同键旧快照，不再读内容（保留同键多文件历史兼容清理）；③ 保存路径减 stat、移出主线程（temp+rename 与备份可观测性不动） |
| BE2 后端引擎（BE1 完成后串行派发） | `src-tauri/src/commands/{text,compare,search,csv}.rs`、`kind_detect/`、`file_engine/`、`encoding/`、`compare/`、`misc.rs` 内 `text_read_all` | ① 打开路径头部采样合一（kind+编码+换行单次 ≤128KB 读）+ `(path,len,mtime)` 探测缓存；② `text_read_all` 复用 TextRegistry 块缓存；③ `text_lines` 解码/切行移出全局锁（对齐 `text_find` 批释放模式）；④ CSV 索引扫描移出锁；⑤ `diff_hashes` 去中间拷贝、similar 设宽裕 deadline、超时/超判据走既有 `hash_windows` 降级（见决策）；⑥ `normalize_text` 单趟化；⑦ `read_chunk` 双 clone 消减；⑧ 正则小 LRU、`hash_lines` 解码复用 |

## 决策（避免语义回归）

1. 分屏预览：连续输入下纯重置防抖会让预览长时间陈旧——改为「重置防抖 300ms + 最长等待 1s 强制渲一次」。
2. 对比护栏：不做 Myers 部分结果；先采样判据，够不上全量行 diff 就直接走既有 `hash_windows` 有界路径；deadline 只作兜底。
3. recovery：回收按文件名模式（含 hash(key)），内容零读取；语义=同键旧快照仍被清理，兼容遗留多文件。已接受权衡：64 位哈希碰撞（≈2^-64）可能误删他键旧快照，换取取消全量解析。
4. `textOpen` 备忘在前端 ipc.ts 层做（key=path，关闭标签时清除），`edit.ts` 零改动，避免 FA/FB 接口耦合。
5. 视图懒加载把一次加载成本从启动挪到首次打开（本地 chunk ~50ms 级），换取纯文本/空窗启动显著变快——接受。

## 验证

- 车道内：`npx tsc --noEmit` + 相关 vitest（按 ac 编号）；后端 `cargo test` + `clippy -D warnings` + `fmt --check`。
- 汇聚后（本人执行一次全量）：vitest run / tsc / cargo test / clippy / fmt → `npm run build` 体积对比 → 删 `docs/tmp/gates-run/native-gate-build` 重建隔离 exe → `run-all.mjs` 与基线逐指标对比。

## 补记（2026-10-28，续 BE2，静态审阅轮）

- 打开路径头部采样合一（BE2 车道表①的剩余欠账）：kind_detect 嗅探（4KB 窗口）与 encoding 探测（64KB 窗口）此前各自 `File::open` 独立读头，重叠区间 `[0,4096)` 双读；现共享 `(path,len,mtime)` 采样缓存（`encoding::shared_head_sample`，容量 32，失效规则与既有探测缓存一致），按窗口截断使用，识别语义不变。顺带修复：探测缓存命中路径 `head=None` → 首块不预热 → `detect_newline` 三读头部；命中时从共享采样回补，预热契约恢复。
- 同步行索引经块缓存（消打开路径整文件二读）：`build_index`/`build_index_encoded` 重构为可喂任意切片的扫描状态机，新增 `build_index_cached`（≤8MB 同步路径）；扫描与 `text_read_all` 复用同一遍磁盘读。>8MB 后台扫描与刷新路径仍走独立句柄（避免争锁与超容量自淘汰）。等价性测试：`build_index_cached_matches_standalone_scan`（多块/块边界 lone \r/UTF-16 两字节序/奇尾/空文件）。
- 前端语言包按需加载的 chunk 缺陷：`manualChunks` 仍把全部 `@lezer/*` 并入常驻 codemirror chunk（解析器数据是语言包体积大头，按需加载形同虚设）；现仅 common/lr/highlight 随核心，11 个解析器数据包跟随动态导入分块。
- 状态：本轮全部改动仅静态审阅，未运行测试/构建/门禁（按任务约束）；上述测试与 `clippy`/`tsc`/`vitest`/门禁复测留待验证轮。
