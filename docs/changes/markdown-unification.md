# Markdown 正文、地图与滚动体系统一改造

状态：实施与原生验收完成（2026-11-14：本机 60Hz/DPR1 冷/热矩阵 19/19×2 全过、发布验收 10/10 通过、1.0.1 已公开）。本记录保留全部历史过程与未达项归因。

## 范围与权威

保留四种模式、默认打开方式、大小上限、右轨外观、离线资源和链接安全规则。无新依赖、无新 Tauri IPC。已有编辑缓冲保存正文、选区和撤销历史；`document-client.ts` 将首份快照及后续 ChangeSet 送到 Worker，`document-model.ts` 维护增量语法树、稳定块身份和文档元数据。

独立预览与分屏右栏都使用 `createBlockRenderer`。固定 `.md-col` 下按块增量提交，活动节点与离开正文的 LRU 缓存分开；保留完整 DOM，避免破坏跨段选择、复制与全文查找。Front Matter、目录、引用定义和脚注独立建模，不再把特殊语法视为整篇缓存失效条件。巨大代码保留原文本与高亮祖先，按行组分片布局。

引用依赖按具体标签索引：修改一个定义只更新使用它的块；代码中的方括号和直接 URL 链接不依赖同名定义。未定义引用也记录依赖，后续添加定义时能够更新。脚注引用按首次出现编号、定义源码顺序及块内引用位置签名，生成脚注正文另有显示序与源码区间索引。

`ScrollSurfaceAdapter` 统一布局快照、锚点、定位、像素滚动和地图采样。阅读面由 `ReadingSurface` 管理块几何和阅读锚；即时渲染由 CodeMirror 管理高度图。渲染地图、视口框、滑块共用排版高度。分屏最右轨固定控制预览；`SplitScrollCoordinator` 按每帧最新用户方向同步，并用目标位置识别程序回声。

大纲、跳行、预览查找、页内链接、模式恢复都通过适配器定位。删除旧标题扫描、错误末尾哨兵、150ms 同步锁、图片解码/600ms 定时恢复和表格外层重复 scrollTop 补偿。尺寸变化和停滚补齐使用共享 8ms 帧队列；组件销毁停止 Worker 订阅、观察器、待派发水合和迟到回填。

## 已复现的根因

1. 预览整篇替换与分屏节点搬运有不同实现；4096 块缓存上限会影响活动正文。
2. 地图使用源码行，滑块使用排版像素，两者缺少同版本布局；标题稀疏或长尾时导航信息不足。
3. 水合为判断离屏公式位置读取每个目标的内部几何，强制展开跳过布局的正文子树。100KB 样本可产生 400ms 以上长任务。
4. 表格与外层同时修正整页滚动；停滚与几何变化绕过渐进队列。位移验收须区分原生输入提交和布局补偿，不能直接沿用旧量具的读数。
5. 渐进装饰后续片会与旧装饰叠加；格式状态在空事务里也换对象，导致待交付片不断被取消重排。
6. 原生门禁重载后可能认错旧页面；连续启停 rAF 采样器会遗留旧循环。已修正新页面标识、独立 profile、采样代次和交互/停手分段统计。
7. GFM 表格原叶解析器一次 `advance()` 扫描整表，队列的 8ms 预算无法抢占；现在顶层表格逐行推进。预热改用 `ensureSyntaxTree` 保留在途解析，全文完成后发布，避免每 16KB 发布半张表、反复替换表格。行节点的额外复用标记会破坏增量语义，已经撤回。
8. 阅读页跳到离屏 `content-visibility:auto` 子树时，原生 WebView2 可访问性树曾触发渲染器崩溃。导航先展开目标及相邻页，滚远后恢复离屏优化；不禁用可访问性或删除正文。
9. 程序滚动回声可能先于下一次尺寸观察到达，重记视觉锚会把图片/字体导致的位移当成新位置。已区分程序目标与用户输入；原生曾复现的 45px 切标签偏移，在后续构建中为 0px。
10. 即时渲染的视口上报微任务与直接 rAF 后续片，会在 CM 测量过程中再次修改布局。视口上报、停滚与后续片统一经帧队列，在队列交付点由 CM 完成高度测量和锚定；不再在观察器的微任务里强制测量。
11. 尺寸观察期间的锚恢复还会展开相邻离屏页，产生更浅层的新尺寸通知，触发 ResizeObserver 循环告警。尺寸补偿不展开邻页，显式导航与自然滚动负责展开。后台解析排在当前视口任务之后，使用本帧剩余预算（至多 8ms），并覆盖 64KiB 以上的文档；100KB 混合文档此前仍会进入 CM 默认的较长后台解析片。冷构建受 4ms 时间预算限制，普通正文块数上限 128，重内容保持 32。统一增至 128 的实验使密集正文帧间隔退回 33ms，已据此收紧；固定 3ms 解析片也复现过巨表迟到发布的 15px 位移。
12. v23 混合正文在自然反向滚动时两次触发 WebView2 渲染器崩溃。取消离屏优化的对照没有崩溃，但重新出现 100ms 以上长任务，不能作为修复交付。v24 将当前页及邻页展开覆盖到自然滚动，远离后释放；有足够前方正文时，连续输入期间暂缓远端 DOM 追加。其原生稳定性与性能正在复验，不能据单元测试认定已修复崩溃。
13. v24 原生完整矩阵未再出现渲染器崩溃，但密集正文收尾仍有 165–186ms 主线程任务。CPU 与文字 Range 剖析确认，重复登记全文块几何、整篇元数据扫描和公式目标准备会串联执行，同时覆盖既有文字锚，产生 24.84–45.69px 位移。v25 在各块构建片登记元数据和渲染目标，删除重复收尾；公式匹配、邻域判定和停滚补挂也分片，完成标志等待派发完成。空追加不得覆盖脚注的独立源码定位索引。
14. v24 即时渲染约 50ms 任务来自 `MixedParse.startInner()` 的全文树扫描；帧队列无法打断单次调用。共享编辑语言保留 CommonMark 的语言数据、键位、粘贴与折叠支持，直接配置增量 Markdown 解析器；代码着色统一走随包 Worker，避免另一套嵌套语言解析。未改文档的可见代码缓存源码片段，避免每次滚动重新收集巨块。后台 Promise 后续片每帧最多放行一个，防止在队列计时之外叠加执行。
15. v25 已消除原有尾部 ≥100ms 任务，4MB IR 与超大 JavaScript 代码的定向原生门禁通过；阅读面公式换图仍产生一帧 24.84–45.69px 位移。逐帧同时读取真实文字与组件锚点，确认是交付后到尺寸观察之间的延迟。v26 由公式交付立即通知唯一阅读高度管理器补偿；地图只在条纹外观改变时替换色段，重内容构建上限收紧为 24 块，减少停手阶段的重复布局。
16. v27 完整矩阵中 13 份正文语料有 12 份通过，位置、编辑、导航通过；1MB 普通正文首屏 441ms。密集 2MB 的开头几笔滚轮仍使分屏/IR 响应 P95 达到 84.7/53.1ms；混合 IR 的表格对照为 33.3ms，对照 16.8ms，仍失败。新增矩阵入口保留这些结果，不挑选最好的一轮。v28 把连续输入纳入待处理输入检查，并在同一显示面的装饰写入之后合并布局测量，预留测量预算；旧 IR 对照门禁增加 32ms 绝对门槛，防止全文与基线一起变慢时误报通过。
17. v28 原生复验仍失败：混合 IR 的全文与无表格基线均为 33.3ms；密集正文 IR 响应 P95 为 64ms，分屏响应约 41ms 但帧 P95 超标。保留地图尺寸和正文排版，仅暂停地图刷新时，同一混合 IR 样本的全文与基线均降至 16.8ms；这是定位实验，不能替代产品验收。地图刷新原先先写滑块、建立条纹，再读取 CM 正文几何；v29 将正文采样置于全部右轨写入之前。原生调用栈还捕获到 CM 默认 idle 解析约 48ms，预热改为先发布一次视口及其后 100KB，再保留解析到全文完成，避免不断提交半张表。右轨合成层和 transform 位移实验未改善，未纳入生产代码。v29 原生结果待复验。
18. v29 前端 1184 项通过，原生混合 IR 仍为 33.3ms。逐项隔离地图采样、条纹绘制与滑块刷新后，确认组合成本会错过刷新周期；保留全部采样和滑块，仅将条纹改为固定宽度、绘制缩放的实验降为 16.8ms。v30 对结构条采用这一绘制方式，保留原色段透明度与主题变量；源码多色地图沿用原分段规则。同一轮原生几何还证实 684px 地图的最后条纹落在 920px：JS 按 3px 计数，CSS 实际最小条距为 4px。现在统一 3px 条槽，按轨道有效高度计数和换算点击，原生正文门禁新增尾部裁切检查。v30 原生完整矩阵仍有未达项，见下方证据。

顶层巨表已分片；容器内表格和罕见 Setext 转换仍沿用原 GFM 规则。完整正文 DOM 保留；大代码按 64 行组、大表按 64 行 tbody 分片布局，表头与各组共享列宽权重。普通段落、图片、目录、脚注等各自保持完整块身份。

19. v31 首次解析先交付块索引和前 32 块 HTML，其余 HTML 在 Worker 分批序列化；阅读面先提交可读节点，流结束或失败均结束等待。结构地图改为单个 Canvas，源码多色地图及无 Canvas 的 DOM 降级仍保留；主题变化会重新绘制。
20. v31 远程环境密集 2MB 两个阅读面在 30 秒观察期内仍未构建完成，分屏一次记录到大幅位置跳动，追踪复测未复现。代码审查发现独立预览等整篇构建结束才登记销毁和恢复旧位置；v32 在首批可读前登记清理，且用户已输入或导航后不再执行迟到恢复。重内容每片块数上限从 24 调至 48，仍受 4ms 构建预算限制；须以原生采样验证效果。

21. v32 混合密集正文真实地图跳转可复现 WebView2 崩溃；普通 2MB 同场景未复现。定位对照发现全部展开离屏正文、或临时隐藏公式目标时未复现；只扩大已展开页面范围和改成逐块离屏仍会崩溃。这些对照不属于产品修复，不能牺牲选择或公式显示作为通过依据。阅读面此前在滚动时没有取消旧视口仍在进行的公式挂载，v33 改为用户输入时取消在途结果并重新排队，停止后按新视口补挂；跨帧分类也检查输入版本。新实现仍须原生重复复现验证。
22. 跨模式目标落在表格等多行替换块时，CM 的常规 `scrollIntoView` 只能定位块边缘。v33 在首次定位后按高度图插值，但真实门禁仍偏移约 5.23 行：追踪发现恢复时目标仍是源码行，约 70ms 后表格替换块才交付。v34 等待目标视口解析和块级装饰交付，定向门禁一次通过（偏差 0.59 行）；带采样追踪的复测仍失败，确认状态层交付时 CM 高度图不一定已更新。v35 还等待目标替换块进入高度图，但两次原生复测分别偏 7.03 行和 0.59 行；追踪表明首次恢复后 CM 的后续测量仍会改变块内比例。v36 在恢复期间响应布局通知并多次定位；三次原生复测仅一次通过，另两次跳离目标约 460 行，因此不能交付。v37 等连续布局更新结束后核对布局版本和目标块高度，仅恢复一次；用户输入、导航、视图销毁或文档变化时取消。原生复验待完成。

23. 超大代码块的旧门禁遗漏了打开/模式挂载阶段。v37 的 1MB 普通代码和高亮代码在这两段仍有约 1.3–1.6 秒主线程任务，不能按旧判据宣称通过。原生 CPU profile 定位到分片扫描逐字符访问 `Text.data`；v38 改为每节点读取一次、按换行扫描并分片让出，同时补回 `Range.cloneContents()` 省略的高亮祖先。原生巨代码与巨表的打开/挂载长任务检查均通过；高亮代码 IR 响应 P95 51ms 仍未通过。

24. v38 密集正文追踪记录到全文解析在连续输入空隙仍占约 6–9ms，旧阅读 DOM 的整批移除约 98ms，并伴随垃圾回收。隔离的隐藏旧宿主、分片移除探针产生 312ms 挂载任务和 78px 位移，未纳入产品。v39 在首段视口前瞻发布后，连续滚动期间暂停全文预热，停手后继续；定向与完整前端回归通过，原生效果待复验。保留原先 20.84px 停滚位移的失败证据，后续未复现不能等同于根因已修复。

25. 最终差异复查发现 Worker 高亮缓存的淘汰仍会在序列化之前删除当前文档的大产物，导致巨代码无色。新增回归先复现失败；现在活动产物保留到本轮序列化可读取，下一文档不再使用时按缓存预算释放。原生巨 JavaScript 门禁增加关键字和 Unicode 字符串的实际颜色结构检查。v38/v39 的快速首屏不能替代修复后保留高亮的验收；此修复的定向 15 项通过，完整回归及新原生构建待完成。

26. v40 实际颜色检查仍失败。原生隔离探针确认同一高亮 Worker 从页面创建正常，短代码约 100ms、巨代码约 600–750ms 返回完整 token；从文档 Worker 创建则约 4ms 触发无详细信息的错误事件。嵌套启动失败会静默返回无色正文，连小代码也受影响。v41 由页面按内容需要启动经典高亮 Worker，通过 MessageChannel 与文档 Worker 直接通信，避免在主线程中转大批 token；销毁文档时终止两个后台服务。新增端口、按需连接和迟到销毁回归，定向 45 项通过；真实高亮后的原生成本仍待验收。

27. v41 原生确认颜色恢复，三个渲染面的交互帧 P95 均为 16.8ms、停滚位移均为 0，但巨高亮代码首屏约 7.7 秒，打开/分屏挂载仍有 114–127ms 主线程任务。原生 CPU 与时间线把模式切换任务分解为旧 DOM 移除约 73ms，加新编辑器初始化与状态更新；正文交付任务同时包含离屏重分组 `replaceChildren` 约 39ms、插入约 16ms，以及首次锚点测量约 42ms。v42 在重分组、挂载与高成本视图释放后加入任务边界，继续核对挂载代次；大块构建不再每 256 个 token 无条件等待，仍按 8ms 时间片让出。即时渲染按排序索引只查询可见代码 token，避免每次滚动扫描 78000 项；重复代码仅请求一次高亮。定向 46 项通过，原生结果待测。

28. v42 完整原生矩阵 18/19 通过，400KB 单表格在即时渲染停手后丢失原单元格节点。定向探针记录同一表格的解析范围从 303130 扩展至 433311、行数从 4558 增至 6501；`TableViewport.update()` 因行数变化清空 thead/tbody，重新创建可见行。相同逻辑单元格仍在原位置，但原 DOM 锚已断开；保留该次失败，不能跳过身份检查。v43 在列数未变时增删行窗口并保留已有行，列数变化才重建网格；缩短表格只移除越界行。新增回归先复现失败，修复后相关 31 项通过，完整回归和原生复验待完成。

29. v43 原生确认单表格的原单元格保留、最大位移 4px，但 IR 响应 P95 66.7ms，仍未达标。带探针复测记录到 CodeMirror 默认 `ParseWorker.work` 的 41.5/47.4/67.5ms idle 任务：部分表格交付后 `viewport.to` 会扩大，首次前瞻不再覆盖新的视口，而连续滚动期间预热仍整体暂停，默认解析器因而接管。v44 在 8ms 队列内持续覆盖变化后的视口及 100KB 前瞻，只在该范围已就绪时暂停远端全文解析；保留行节点使范围扩展不再清空当前网格。新增回归先复现失败，修复后相关 22 项通过，完整回归和原生复验待完成。

30. v44 定向单表格通过，但完整矩阵 16/19 通过：混合 100KB IR 响应 P95 52.3ms、单表格 IR 67.3ms，延迟图片在导航门禁中一次产生 223.59px 瞬时位移。后续定向探针未复现图片位移，但再次捕获默认 `ParseWorker.work` 的 41.5ms 任务，确认预热不能稳定抢在默认解析之前完成。v45 在构建时将锁定的 `@codemirror/language` 6.13.1 后台 Slice/MinSlice 收紧至 8ms，保留初始/编辑预算、增量语义和 CM 高度管理；源码特征缺失或重复即构建失败，开发依赖预打包也不得绕过。没有修改依赖版本或 node_modules。阅读面捕获当前正文图片的 load/error，立即通知同一锚管理器，覆盖尺寸观察尚未交付的间隙；用户输入和销毁仍取消旧锚。相关 42 项通过，完整回归和原生复验待完成。

31. v45 定向单表格通过（三模式响应 P95 33.7/42.0/42.2ms，位移 0/0/3px），混合 100KB IR 仍为 54.6ms，导航图片仍有 223.59px 瞬时位移。带探针的两个复测均通过，不能替代正式失败。时间线确认应用队列末尾通过 `lineBlockAtHeight(0)` 强制 CM 同步测量、换件，单次队列约 21.7ms；v46 将这部分交回 CM 绘制前的合并测量，不再在队列末尾同步读高度图。图片新增“固有尺寸生效但 load/RO 均未交付”的回归，先复现再修正：只在当前正文的图片加载及完成两帧期间检查当前视觉锚；新原生滚动未记锚时不补偿旧基线，销毁停止观察及检查。相关 61 项通过；完整回归、当前原生构建和正式矩阵待完成。

32. v46 定向导航、混合正文和单表格全部通过，完整矩阵仅 11/19 通过：混合/特殊语法 IR 响应 50.7/54.8ms，普通 100KB/400KB/1MB/2MB 及单标题长尾的 IR 停手位移约 32px，巨 JavaScript 的 IR 挂载出现 103ms 任务。异步测量失去了原有锚定时序，v47 撤回该部分，保留图片修复；不能为降低任务耗时牺牲稳定位置。队列存在待提交的布局测量时不再接纳后台解析，滚动期行内与块装饰窗口从 512 收紧到 256 字符，仍逐片完整覆盖视口。新增后台工作晚于本片布局交付的调度回归；验证和原生构建待完成。

33. v47 恢复同步测量后普通 1MB 和特殊语法正文通过，但混合 100KB 的即时渲染停手位移为 21.08px，巨 JavaScript 分屏响应仍有超标。带探针的复测未复现混合位移，不能替代正式失败。v48 的确定性回归发现字符分片落在列表缩进内时，位于行首的间距装饰会被删掉、又被相邻两片排除，停滚重建时才补回；32 种前缀均与完整布局逐项比较，原实现可复现遗漏。普通行窗口与片尾现在对齐行边界，巨行仍按字符分片，最多额外处理 256 字符。补充文档由尾部视口整体缩短的回归，先复现旧坐标 `lineAt` 越界，再限制到新文档范围。相关 110 项通过，原生位移效果待实际复验。巨代码诊断仍按输入至观察响应判定，不以较晚的 scroll 事件时间降低数值。

34. v48 正式定向仍复现混合 IR 位移 21.08px，特殊语法 IR 响应 56.7ms；普通 1MB、巨 JavaScript、导航通过。行边界修复解决了确定性装饰遗漏，但不能归因为本次位移的完整根因。原生低开销逐帧记录和 CM 测量探针再次复现：正文布局几乎不变，高度图却触发一行（21.59px）的滚动校正。隔离为每次事务立即完成 CM 测量后，同语料位移降为 0、三模式响应通过。共享队列此前允许同一编辑面连续提交多个事务，CM 在上次测量前重记锚点，覆盖了应保留的原始基线；v49 对标记所属编辑面的任务每帧最多放行一次，其余面仍可处理，后台解析仍晚于待交付测量。不添加第二套 scrollTop 补偿。新增调度回归先红后绿，相关 55 项通过；完整回归和正式原生复验待完成。

35. v49 正式矩阵 18/19 通过，混合 IR 位移从 21.08px 降至 0.5px，特殊语法与所有普通正文、巨单块、编辑、导航、恢复和早期交互通过。唯一未达项为密集 2MB 预览异步完成前的 108ms 长任务；不以低漂移或定向通过抵消。带探针复测的预览任务为 69/79ms，IR 响应 53ms，不能替代正式判定。CPU/时间线证实 MathJax 冷启动字体/输出器初始化、首个公式排版、正文交付和强制锚定布局可在同一微任务链执行，后续还有较重的浏览器布局。v50 在库首次就绪后通过共享队列让出，异步结果也逐任务交付并在提交时检查当前世代；取消挂载会取消已排队的交付。同步缓存复用和即时高度锚定不变，不修改第三方资源。两项回归先红后绿，相关 51 项通过；原生长任务是否消除仍待验证。

36. v50 密集 2MB 定向及完整矩阵均消除了原有 ≥100ms 收尾任务；完整矩阵的混合 IR 响应 P95 52.7ms 仍失败。导航期间远程显示新增 2560×1440/32Hz 适配器，后续 WebView DPR 从 1 变为 1.25；整轮不能作为固定环境验收或与后半轮旧版对照直接比较。早期交互门在正文挂载前操作禁用菜单的竞态已修正，当前远程环境复验通过。CPU 追踪还发现首段块装饰交付约 29ms：几何刷新登记了 `pending.budgeted`，但推进时只检查滚动占位状态，停滚、字体及尺寸刷新仍按较大窗口处理。v51 让这些任务也遵守交互分片，并保留未处理的表格；密集小视口回归先红后绿，相关 29 项通过。既有列表对照需先发布 ensureSyntaxTree 的在途结果再取完整布局，避免将局部语法树误作全文基线。原生预算与位移效果待复验。

37. v51 在固定的当前远程环境完成矩阵，仍有混合 IR 10.58px、普通 4MB IR 10.40px、巨表 IR 18.80px 位移，密集预览超过 30 秒未完成、密集分屏有 122ms 任务。v50 同环境对照也出现普通 4MB 10.40px 位移，不能把这些问题全部归因于 v51 分片；带探针复测未重现也不能抵消正式失败。源码确认停滚补齐错误地发送几何失效通知，令表格重置已测量的行高；v52 分离停滚与真实几何变化，新增回归先红后绿。密集原生追踪还显示大量时间耗在等待下一帧：共享队列对极便宜的后台片也强制每帧只放行一片。v52 允许后台片在独立宏任务中使用同一 8ms 预算的剩余时间，计入 Promise 微任务实际成本；新输入、前台事务或预算用完立即让到下一帧。编辑事务及测量仍保持每面每帧一次，不能连续事务覆盖原锚。相关 59 项通过，完整回归与原生复验待完成。密集分屏追踪包含约 102ms 的 V8 GC，保留原始时间线，不以调度修改直接声称消除。

38. v52 正式定向中密集 2MB 停手后预览约 13.05 秒、分屏约 8.39 秒完成，均未出现 ≥100ms 任务；混合 IR 位移 0.40px。但普通 4MB 位移 10.40px、巨表位移 20px 仍失败，不能用重内容改善收口。空白 WebView 同环境复测响应 45.1ms（此前 62.1ms），说明当前环境响应会波动，不能把 50ms 描述为环境绝对下限。普通正文隔离为 CM 默认锚落在空白行顶部，段间距缩小时后续文字仍移动；同事务使用 CM 原生滚动目标的诊断位移为 0px。v53 仅对这种空白锚交付下一可见正文及其现有偏移，仍由 CM 同轮测量/定位，不另写像素补偿、不改变选区与横向位置。巨表后台发布更长解析前缀时还会清空已有行高，v53 经内容、引用、列布局、宽度与世代核验后保留未变前缀的测量。另修复公式结果因滚动暂缓后由 30ms 定时器直接交付、绕过共享队列的路径。新增行高和定时交付回归均先红后绿；原生复验待完成。

39. （2026-11-11）渲染预览/分屏首次打开 CRLF 行尾的 Markdown 时，GFM 表格整段退化为段落：HTML 折叠段内换行与填充空格后显示成一行 `| 对比项 | ...`，切一次源码/分屏或编辑后自愈（预览改读编辑器缓冲，CM 文档恒 LF）。复现结论：`@lezer/markdown` 的表格分隔行判定（本仓库 `cooperative-table.ts` 的同款 `delimiter` 正则）不接受行尾 `\r`；已保存 Markdown 默认进渲染预览，首开无编辑器缓冲，`textReadAll` 原样读盘的 CRLF 直接进入 Lezer。markdown-it 回退与即时渲染不受影响（前者内部归一，后者由 CM6 装载时按 `/\r\n?|\n/` 分行）。约定渲染输入不变量：外部文本进入 Markdown 渲染前必须归一为 LF（`common/text.toLf`），在 `createBlockRenderer.render`（预览/分屏唯一入口，回退与引用定义扫描同坐标）、`MarkdownDocumentClient.render`（Worker 与本地回退共用入口，`sent`/diff 记账同口径）、`MarkdownDocumentSession.update`（Lezer 文档解析最后防线）三处执行；不在表格解析器内容忍 `\r`，避免 `\r` 进入单元格文本与行内解析。新增 `src/markdown-view/render-input-eol.test.ts`，锁 LF/CRLF/CR/混合/前导BOM+CRLF 行尾产出同一文档文本、块结构与渲染 HTML 并覆盖预览入口；另新增 `src/markdown-view/render-correctness.test.ts` 作为跨引擎/跨行尾结构基线（常用 GFM 构造与 markdown-it 参考实现比对；自定义语法——任务列表/高亮上下标/脚注/emoji/目录/公式占位——用期值断言）。`toLf` 同时剥离前导 U+FEFF（剪贴板/草稿/恢复快照可绕过文件解码层的 BOM 嗅探），解码层行为由 `encoding::tests::decode_strips_bom_and_keeps_crlf_verbatim` 锁定（BOM 剥离、CRLF 原样交付）。原生侧新增 `tests/gates/gate-md-structure.mjs`（入 run-all 默认集）：同一份样例的 LF/CRLF/CR/混排四副本在真实窗口逐元素断言展示结构并以即时渲染对照；修复前构建上 crlf/cr/mixed 三份红（表格 0 格、竖线正文），修复后构建四份全绿。发布门 `release-formats` 的 md 夹具改为 CRLF 并新增表格真实渲染断言。样式/几何一致性仍归 `gate-md-consistency`，其纵向间距基线差另案收口，见「尚待关闭」。

## 验证与证据

结果均按当次构建和环境记录，失败样本不排除。先前 Windows 报告远程显示 2560×1440、32Hz，DPR 1.25，实测 rAF 约 31.2ms；v32 矩阵期间 Windows 不再列出该远程显示适配器，而列出 NVIDIA 1920×1080、60Hz，WebView2 实测 DPR 1.25、帧 P95 约 19ms。2026-11-12 起批5 验收在本机直连显示执行（NVIDIA 1920×1080@60Hz、DPR 1）。矩阵逐项记录采样前后的显示配置；v37 同时核对每份可获得的 WebView GPU 和缩放。不同环境的样本不能直接比较。原生性能阈值保持不变。

| 证据 | 结果 |
| --- | --- |
| 2026-11-12 批5 本机 60Hz 严格验收四轮矩阵 + 修前对照 + 复测：`docs/tmp/phase-a/{md-matrix-after,md-matrix-after-warm,md-matrix-after-r3,md-matrix-before}/matrix.json`、`dense-2m-resample1.json`、`mixed-100k-resample1.json` | 修后 exe `bd6de369…`（源码 `4de917e…`＝04201e5＋未提交改动）三轮矩阵均 17/19，未达组合互不相同；修前对照 exe `09d603d9…`（04201e5 干净树独立 worktree 构建，gate-build DIRTY=false）18/19。环境全程本机 NVIDIA RTX 2070 SUPER 1920×1080@60Hz、WebView DPR 1、1280×832，displayChanged=false、webviewEnvironment 一致。修前两项已知未达已关闭：single-js-1m 三模式响应 33.2/42.2/36.4ms（修前 44.7/49.0/49.4 贴线）；single-table-400k 分屏挂载长任务全空（修前 124ms）。三轮未达项归因：①冷轮 mixed-100k split 50.5ms、dense-2m IR 53.4ms——同 exe 复测全绿（[32.4,39.4,35.3]/[32.0,39.7,39.4]），50ms 线运行间波动；②热轮 metadata IR 停后阅读锚漂 9.58px——修前矩阵同败此项（IR 阅读锚间歇，与 ir-settle E3 同族）；③热轮导航图片延迟加载阅读锚——v44/v45/批2 已记录的既存间歇；④第三轮 plain-2m IR 8.97px、single-heading-tail IR 9.58px——同②族。无一项可归因本轮改动（blockcache 差集清理/reading-surface 脏区间/text-view 行复用）；19/19 单轮全过未达成，不认定性能验收完成。 |
| 2026-11-12 ir-settle 本机 60Hz 专项（修前/修后对照）：`docs/tmp/phase-a/a3-stage/gate-ir-settle.json`、`docs/tmp/phase-a/before-gate-ir-settle.log` | 修后 5/12 FAIL、修前 4/12 FAIL，失败全部为 E3 缩略图跳转（修后 topMax 124.6/midMax 120.3px；修前 125.2/110.1px）；E1/E2 滚轮停稳双侧全绿（≤0.6px，门槛 2/4px）。E3 为修前已存在的 IR 跳转锚未达项，非本轮回归；≤2/≤4px 严格验收未通过，保持未达并留样。 |
| 2026-11-12 批5 逐项对应门 + 门禁口径修正：`docs/tmp/phase-a/{a1-stage,gates-a2.log,walkf-mdstructure-rerun.log,before-results/}` | A1a/A1b：ir-scroll PASS；md-surfaces(dense-2m) 首轮 FAIL——preview→split 模式切换边界长任务 104ms（修前同任务 77ms；同 exe 复测 <100ms PASS），该边界任务历史区间 77–107ms 贴 100ms 线波动。A2：gate-batch1-scroll PASS（jumps=0、无 ≥100ms 长任务）、ac36 PASS（3/3，935s）。arrow 门修前/修后同败（ArrowDown/Up 锚卡 6/7 检查；修后另有 1 次 >50ms 长任务）——perf-silk 终态即 1+1 边缘、从未全绿，既存未达保留不放宽。walk-f split 签名选择器随 `.md-reading-page` 分页架构漂移（修前同败）修正为后代选择器后：C1/C2-edit/C2-split/C3 过，C2-wysiwyg 跨主题几何漂移 1.63px（块 25）未达（修前 3.13px，双侧败，既存；1.5px 一致性线不放宽）。md-structure 的 run-all 聚合接线修正（门禁自写固定路径、聚合器读 --out 目录）后聚合 PASS，LF/CRLF/CR/混排四副本全绿（门禁本体两轮皆 PASS，修正仅让聚合器读到真实结果）。 |
| 2026-11-11 两项复测：`docs/tmp/md-unification-after/fix-2026-11-11/single-js-1m.json`、`single-table-400k.json` | 只重跑先前未达的两份语料，不是完整 19 项。巨 JavaScript 分屏滚轮响应 P95 48.8ms（27 笔里有一笔 169.8ms，P95 取次高值）。400KB 单表分屏挂载未再记录 ≥50ms 的长任务，分屏滚轮响应 P95 36.1ms。两份报告 `failures` 均为空。EXE SHA256：`66e7fc74d64f2151b3c11e03a7c5f4ea1c2c56759697b76677e35d5419be3ebd`。没有同环境旧版对照，不能据此收口。 |
| 2026-11-11 当前源码完整原生：`docs/tmp/md-unification-after/final-2026-11-11/matrix.json` | 19 项中 17 项通过。未达：巨 JavaScript 分屏滚轮响应 P95 50.6ms；400KB 单表分屏挂载长任务 124ms。普通 1MB 首屏 409.5ms。位置、编辑、导航、早期交互及两项 IR 对照通过。显示为本地 NVIDIA RTX 2070 SUPER、1920×1080、60Hz，WebView 缩放 1、视口 1280×832，全程未变。没有同环境旧版对照。EXE SHA256：`b61105fa9d15cceed5282515934821c15d471992796c3de7d45670594be8f3f5`。不认定全部通过。 |
| v53 接续前端：`docs/tmp/md-unification-tests-v53-resume.json` | 162 文件、1224 项全部通过（按文件串行、`--maxWorkers=2`）；类型检查、前端构建及 Tauri CLI 隔离构建通过。当前 EXE SHA256：`10f630e4812a7fa146fe8ea5cc13d698001149dbdfe2c36665cc13bb14857626`；462 份构建后资产清单见 `build-v53/frontend-hashes.json`，本次未采集构建前清单，不声称前后 SHA 比对通过。 |
| v53 正式定向：`docs/tmp/md-unification-after/targeted-v53/` | 普通 4MB IR、巨表三模式的停滚文字位移均为 0px，原节点保留；定向交互帧 P95 约 33ms、响应 P95 73.7–86.9ms，仍未通过原 32ms/50ms 门槛。 |
| v53 完整原生：`docs/tmp/md-unification-after/final-v53-verified/matrix.json` | 新版 6/19 通过：位置、编辑、导航、早期交互及两项 IR 对照通过。13 份正文语料仍有帧 P95 或响应超标；普通 100KB 另有一次即时渲染菜单项缺失/禁用错误。没有文字漂移/节点丢失或 ≥100ms 长任务失败，不以此抵消性能未达项。普通 1MB 首屏 490.2ms。显示配置及 WebView GPU/DPR 全程一致（远程显示 32Hz、DPR 1.25）。误选旧版路径的初始轮次已中止并保留在 `final-v53/`，不作为完整矩阵。 |
| v53 同环境改造前：`final-v53-verified/before-plain-1m.json`、`before-mixed-100k.json` | 已核验旧版 EXE SHA 为 `2ac3660bee4b8f2da0dc552bf0595ee8c7e1dda3d72c739649a26a7c04ff8394`。普通 1MB 首屏 752.4ms；旧版地图尾部裁切，混合分屏有 ≥100ms 任务和阅读锚丢失，响应仍超标。只与本轮当前版本比较。 |
| v53 菜单复现及空白对照：`targeted-v53/plain-100k-repro.json`、`scroll-control.json` | 普通 100KB 的菜单错误单独复测未复现，三模式文字位移均为 0px；分屏/IR 响应仍为 69.8/93.3ms，正式矩阵的菜单失败不撤销。卸载应用上下文后的空白 WebView 帧 P95 31.6ms、响应 P95 61.8ms、无长任务。此对照反映本轮额外延迟，不代表 50ms 在所有远程轮次均不可达，也不能替代产品验收。 |
| v52 前端：`docs/tmp/md-unification-tests-v52.json`、`md-unification-v52-targeted-final.log` | 161 文件、1217 项全部通过，相关 59 项通过；6000 块 10.15s，保留 20 秒原限制。类型检查、前端和 Tauri CLI 构建通过，462 份前端资产构建前后 SHA 一致；EXE SHA256：`365965507d40e9055ebeebe75aa283a72cd486456414971ee938ab8e43360cef`。原生复验进行中。 |
| v52 原生定向：`docs/tmp/md-unification-after/targeted-v52/` | 混合、巨表、普通 4MB 与密集 2MB 均保留正式失败；改善与未达项见 38。`trace-table.json` 与 `probe-gap-target-plain-4m.json` 是诊断，不能覆盖正式位移失败。空白对照响应 45.1ms、帧 P95 31.6ms、无长任务。 |
| v51 前端：`docs/tmp/md-unification-tests-v51-serial.json`、`md-unification-v51-targeted.log` | 161 文件、1216 项全部通过；相关 29 项、类型检查、前端和 Tauri CLI 构建通过。完整回归按文件串行、`--maxWorkers=2`；6000 块用例 16.85s，原 20 秒限制不变。此前并行文件运行的该用例在 20.04s 超时，完整失败记录仍在 `md-unification-tests-v51.json`；单独运行 11.32s 通过，不用单独通过替代完整回归。462 个前端文件在原生构建前后 SHA 一致，EXE SHA256：`c482ab5debb61807fb6d30492fd7cce811be3f5148e636529c35baebb940a09c`。 |
| v51 完整原生：`docs/tmp/md-unification-after/final-v51/matrix.json` | 固定 32Hz、DPR 1.25，显示配置与 WebView GPU 全程一致。导航、编辑、位置、早期输入和两项 IR 对照通过；普通 1MB 首屏 488.7ms。正文三模式均有滚轮响应 >50ms，另有条目 37 的实际失败，不能认定全部通过。 |
| v51 同环境改造前：`final-v51/before-plain-1m.json`、`before-mixed-100k.json` | 旧版普通 1MB 首屏 1138.7ms、混合 100KB 首屏 539.4ms；旧版地图尾部裁切，混合分屏出现 ≥100ms 任务及锚丢失。仅与同轮新版比较，不跨显示环境。 |
| 当前远程空白 WebView：`docs/tmp/md-unification-after/final-v51-scroll-control.json` | 对照先导航到 `about:blank`，卸载应用脚本；用一个空的高元素滚动，不构建 4000 行文本。帧 P95 31.6ms、响应 P95 62.1ms、无长任务。响应门槛仍按 50ms 判定；此环境对照不能抵消正文位移、异步超时或长任务。 |
| v50 前端：`docs/tmp/md-unification-tests-v50.json` | 161 文件、1215 项全部通过；相关 51 项、类型检查、前端与 Tauri CLI 构建通过，保留 6000 块原 20 秒门槛。462 个前端文件在原生构建前后 SHA 一致；EXE SHA256：`eab6702c9d1c16a9030dafb5e07bbc51060ef9aae6a4d9920bfd596dea7ecf13`。 |
| v50 原生定向：`docs/tmp/md-unification-after/targeted-v50/` | 密集 2MB、混合 100KB、特殊语法三模式及导航门禁通过；最大阅读位移分别为 0.69/0.69/1.63px，未出现 ≥100ms 任务。完整矩阵仍需独立判定，不能用定向通过替代。 |
| v50 完整原生：`docs/tmp/md-unification-after/final-v50/matrix.json` | 导航开始前的 15 项中 14 项通过；密集预览未再出现 ≥100ms 收尾任务，普通 1MB 首屏 466.6ms。混合 IR 响应 P95 52.7ms 失败。导航功能检查本身通过，但采样期间显示配置变化，使整轮不满足固定环境要求；后半轮与旧版不能直接比较。早期交互加载竞态修正后，在当前远程环境的 `targeted-v50/early-input-remote.json` 通过，最大位移 0.34px、旧正文异步修改为零。 |
| v49 前端：`docs/tmp/md-unification-tests-v49.json` | 160 文件、1213 项全部通过；相关 55 项、类型检查、前端和 Tauri CLI 构建通过，保留 6000 块原 20 秒门槛。462 个前端文件在原生构建前后 SHA 一致；EXE SHA256：`9dbb79d4b97e30362eb5d637d221cedccbee9509c05a96176f3570818573ae94`。 |
| v49 完整原生：`docs/tmp/md-unification-after/final-v49/matrix.json` | 新版 18/19 通过，唯一未达项见 35。混合正文 IR 响应 41.8ms、位移 0.5px，巨表格 IR 位移 3px；所有模式地图与滑块同源、尾部未裁切，显示配置/GPU/DPR 全程一致。保留密集预览 108ms 任务，未认定全部完成。 |
| v49 同环境旧版：`final-v49/before-plain-1m.json`、`before-mixed-100k.json` | 旧版普通 1MB 首屏 802.5ms、分屏响应 86.8ms，IR 停手位移 31.78px；旧版混合预览响应 268.3ms 并有 ≥100ms 任务，地图尾部裁切。对照均保留原失败。 |
| v49 定向与诊断：`docs/tmp/md-unification-after/targeted-v49/` | 混合、特殊语法和巨表格定向三模式通过。密集正文 CPU 与全时间线独立保存为 `profile-dense-2m.json.*`，不以带探针的预览通过覆盖正式失败。 |
| v48 前端：`docs/tmp/md-unification-tests-v48.json` | 160 文件、1212 项全部通过；相关 110 项、类型检查、前端与 Tauri CLI 构建通过。462 个前端文件在原生构建前后 SHA 一致，清单和程序身份见 `build-v48/`。 |
| v48 正式定向：`docs/tmp/md-unification-after/targeted-v48/` | 普通 1MB 首屏 413.9ms、三模式通过；巨 JavaScript 三模式及导航通过。混合 IR 位移 21.08px、特殊语法 IR 响应 56.7ms 未通过；未运行完整矩阵。EXE SHA256：`2d2c5684c067563eeeae185633ba7d0218144019900034948e7e4e46990f3a74`。 |
| v48 隔离诊断：`targeted-v48/trace-mixed.json`、`probe-anchor.json`、`probe-heightmap.json`、`probe-dispatch.json` | 原生测量探针保留高度图和 scrollTop 写入；立即结算每次事务的对照使混合 IR 位移降至 0px。这些诊断不得代替修改后的正式验收，根因和方案见 34。 |
| v47 前端：`docs/tmp/md-unification-tests-v47.json` | 160 文件、1209 项全部通过；相关 62 项、类型检查、前端与 Tauri 原生构建通过。462 个前端文件 SHA 清单保存于 `build-v47/frontend-hashes.json`。 |
| v47 原生定向：`docs/tmp/md-unification-after/targeted-v47/` | 普通 1MB、特殊语法和导航通过，图片最大位移 0.41px；混合即时渲染位移 21.08px、巨 JavaScript 分屏响应超标。EXE SHA256：`f4c81653dc172868a6689942bfb492aa157f3431e6ab839014a8c5b13edd9ba9`。带探针结果独立保留，不覆盖正式失败。 |
| v30 本机 60Hz 完整矩阵：`docs/tmp/md-unification-after/final-v30/matrix.json` | 新版 18 项中 12 项通过；混合 100KB、密集 2MB、普通 1MB、特殊语法正文及两项 IR 门禁失败。普通 1MB 首屏 504.4ms；密集正文仍有响应或帧间隔超标。位置、编辑、导航门禁通过。 |
| v30 同环境改造前：`final-v30/before-plain-1m.json`、`before-mixed-100k.json` | 旧版 1MB 首屏 792.3ms；旧版地图尾部裁切，混合内容响应与长任务未达标。此对照仅与本机 60Hz 的 v30 样本比较。 |
| v31 远程环境密集正文：`docs/tmp/md-unification-after/targeted-v31/dense-2m.json` | 预览/分屏/IR 滚轮响应 P95 为 75.3/82.6/118.5ms；两个阅读面 30 秒内未完成，分屏有 ≥100ms 长任务且一次锚位移约 70579px，未通过。 |
| v31 远程追踪复测：`docs/tmp/md-unification-after/trace-v31/dense-2m.json` | 大幅位移未重现；两阅读面观察结束时均挂载 18937 块但构建未完成。一次未复现不能消除前次失败。 |
| v31 远程混合 IR：`docs/tmp/md-unification-after/targeted-v31/ir-mixed-100k.json` | 单次门禁通过，全文帧 P95 31.7ms；该样本不能说明 60Hz 下已通过。 |
| v32 前端回归：`docs/tmp/md-unification-tests-v32-resume.json` | 1189/1189 通过；前端和 Tauri 原生构建通过。 |
| v33 前端回归：`docs/tmp/md-unification-tests-v33-final.json`、`md-unification-v33-targeted-tests3.log` | 完整回归 1193/1193 通过；随后补充的缓存命中边界通过定向测试。 |
| v33 原生定向：`docs/tmp/md-unification-after/targeted-v33/` | 密集 2MB 真实地图深跳转连续 3 次通过，最大阅读位移约 0.34px；旧正文异步修改为零。位置门禁原容差下通过，但即时渲染仍偏约 5.23 行；v34 收紧该语料往返容差到 1 行并待原生复验。 |
| v37 定向前端：`tests/scroll-anchor.test.ts`、`src/markdown-view/geometry-refresh.test.ts` | 22 项通过；前端构建通过。最新源码的完整回归仍待完成。 |
| v37 原生定向：`docs/tmp/md-unification-after/targeted-v37/` | 表格跨模式位置连续 3 次通过，最大偏差 0.02 行；普通 1MB、混合 100KB、密集 2MB 的三种渲染面定向通过，普通 1MB 首屏 415.3ms。空白滚动对照响应 P95 50.1ms；该次 WebView DPR 为 1，GPU 为 NVIDIA RTX 2070 SUPER，不与 DPR 1.25 的旧样本直接比较。完整矩阵待运行。 |
| v37 完整矩阵：`docs/tmp/md-unification-after/final-v37/matrix.json` | 按旧判据新版 18/19 通过；密集 2MB IR 响应 P95 110.7ms，并出现 100ms 交互任务。普通 1MB 首屏 466.8ms，同环境旧版约 803.7ms。超大单块打开/挂载缺口见根因 23，不能据此认定其验收通过。 |
| v38 原生定向：`docs/tmp/md-unification-after/targeted-v38/` | 巨代码首屏 296.8/319.2ms，巨表 1414.2ms；新增打开/挂载长任务检查通过，巨代码与巨表的模式停滚最大位移分别 0/3px。高亮代码 IR 响应 51ms，密集正文多轮约 52–54ms，仍有失败；诊断时间线同时保留垃圾回收与旧正文销毁成本。 |
| v39 前端：`docs/tmp/md-unification-tests-v39.json` | 158 文件、1197 项全部通过，含 6000 块原 20 秒门槛；定向 34 项与前端构建通过。原生构建及最终矩阵待完成。 |
| v40 前端：`docs/tmp/md-unification-tests-v40.json` | 159 文件、1198 项全部通过；前端与 Tauri 原生构建通过。 |
| v40 原生定向：`docs/tmp/md-unification-after/targeted-v40/single-js-1m.json` | 预览和分屏仍缺高亮；IR 响应 P95 53.4ms，未通过。根因与后续处理见 26。 |
| v41 前端：`docs/tmp/md-unification-tests-v41.json` | 159 文件、1201 项全部通过，前端与 Tauri 原生构建通过。 |
| v42 前端：`docs/tmp/md-unification-tests-v42.json` | 159 文件、1202 项全部通过，保留 6000 块原 20 秒门槛；定向 46 项、类型检查、前端及 Tauri 原生构建通过。 |
| v42 原生定向：`docs/tmp/md-unification-after/targeted-v42/` | 巨高亮代码首屏 2017.2ms，实际颜色正常；三模式响应 P95 34.3/34.1/40.8ms、位移 0，打开/挂载无 ≥100ms 任务。密集 2MB 三模式通过，最大位移 0.69px。 |
| v42 完整原生矩阵：`docs/tmp/md-unification-after/final-v42/matrix.json` | 新版 18/19 通过，唯一未达项为单表格 IR 停滚时节点断开，见根因 28；普通 1MB 首屏 436.3ms。位置、编辑、导航、早期交互及两项 IR 对照通过，显示配置/GPU/DPR 全程一致。 |
| v42 同环境改造前：`final-v42/before-plain-1m.json`、`before-mixed-100k.json` | 普通 1MB 首屏 786.8ms、混合 100KB 首屏 544.2ms；分屏响应 P95 66.2/300.9ms，混合内容有 ≥100ms 任务，地图尾部裁切；普通正文 IR 停滚位移 21.59px。 |
| v43 前端：`docs/tmp/md-unification-tests-v43.json` | 159 文件、1203 项全部通过；相关 31 项、类型检查、前端及 Tauri 原生构建通过。 |
| v43 原生单表格：`docs/tmp/md-unification-after/targeted-v43/` | 原单元格不再断开、最大位移 4px；IR 响应 P95 66.7ms 未达标。CPU profile 与时间线保留默认后台解析的长片证据，见根因 29。 |
| v44 前端：`docs/tmp/md-unification-tests-v44.json` | 159 文件、1204 项全部通过；相关 22 项、类型检查、前端及 Tauri 原生构建通过。 |
| v44 原生单表格：`docs/tmp/md-unification-after/targeted-v44/single-table-400k.json` | 三模式通过，响应 P95 33.6/35.3/32.6ms；最大位移 0/0/3px，原节点保留，交互帧 P95 16.8ms，打开/挂载及交互/停手无 ≥100ms 任务。 |
| v44 完整原生矩阵：`docs/tmp/md-unification-after/final-v44/matrix.json` | 新版 16/19 通过，未达项见根因 30；普通 1MB 首屏 448.6ms，帧 P95 均达标。两项 IR 对照、早期交互、编辑和位置门禁通过；所有失败保留，不用定向通过替代。 |
| v44 原生诊断：`docs/tmp/md-unification-after/targeted-v44/probe-navigation.json`、`profile-single-table.json.*` | 导航诊断的图片位移 0.41px、未复现上一轮失败；CPU/时间线仍有 41.5ms 默认后台解析。诊断结果不能作为完整矩阵通过依据。 |
| v45 最终前端：`docs/tmp/md-unification-tests-v45-final.json` | 160 文件、1207 项全部通过；相关 42 项、类型检查、前端与 Tauri 原生构建通过，保留 6000 块原 20 秒门槛。开发 ESM 带/不带版本查询均验证 8ms；最终 462 个前端文件与已构建原生候选逐一同 SHA，证据为 `build-v45/frontend-identity.json`。原生矩阵待完成。 |
| v45 原生定向：`docs/tmp/md-unification-after/targeted-v45/` | 单表格通过；混合 IR 响应 P95 54.6ms、导航图片位移 223.59px 未通过。带 CPU/时间线及写入探针的复测通过，仍保留正式失败，根因与后续修改见条目 31。 |
| v46 前端：`docs/tmp/md-unification-tests-v46.json`、`md-unification-v46-targeted.log` | 160 文件、1208 项全部通过；相关 61 项、类型检查和前端构建通过。保留 6000 块原 20 秒门槛；Tauri 原生构建与正式验收进行中。 |
| v46 原生定向：`docs/tmp/md-unification-after/targeted-v46/` | 导航通过，图片位移 0.41px；混合 IR 响应 P95 41ms，单表格 IR 35.7ms、位移 3px。正式矩阵发现普通正文位移回归，不能据此定向结果收口，见根因 32。EXE SHA256：`9cc817e4b6a5c97282ba1299bc6c2aff55535eda85296a04c171d750079e7955`。 |
| v46 完整原生：`docs/tmp/md-unification-after/final-v46/matrix.json` | 新版 11/19 通过；1MB 普通首屏 418.2ms。图片、导航、输入、编辑、早期交互、两份 IR 对照通过；普通正文锚定回归及 3 项响应/挂载未达标，均保留。整个矩阵显示配置及 WebView GPU/DPR 无变化；同环境旧版普通 1MB 首屏 795.7ms、混合 552.3ms，地图尾部、分屏异步完成及长任务等仍失败。 |
| v41 原生定向：`docs/tmp/md-unification-after/targeted-v41/single-js-1m.json` | 实际关键字/Unicode 字符串高亮通过；三模式响应 P95 33.7/33.2/44.1ms、位移 0，但超大单块打开/挂载长任务失败。诊断 profile 与完整时间线保存在同目录，不以带探针的响应时间替代正式采样。 |
| v39 原生密集 2MB：`docs/tmp/md-unification-after/targeted-v39/dense-2m.json` | 单轮通过：预览、分屏、IR 响应 P95 33.6/36.7/48.7ms，阅读位移 0.42/0.69/1.41px。旧 20.84px 位移未复现，不等同于完成根因修复。 |
| v32 原生完整矩阵：`docs/tmp/md-unification-after/final-v32/matrix.json` | 新版 19 项中 10 项通过；普通 1MB 首屏 429.9ms。编辑、导航通过；混合和部分普通/密集文档的滚轮响应超 50ms，混合 IR 超出慢帧对照预算；模式往返偏差 6.13 行，早期交互门禁一次 WebView2 崩溃。 |
| v32 生命周期复现：`docs/tmp/md-unification-after/targeted-v32/early-input.json`、`early-input-repro1.json` | 首次单独检查通过，最大位移 0.34px；矩阵及随后复测各发生一次 WebView2 崩溃，后者定位于深滚动后首次切换源码，仍在排查。 |
| v32 同环境改造前：`final-v32/before-plain-1m.json`、`before-mixed-100k.json` | 旧版普通 1MB 首屏 801.4ms，混合内容首屏 542.7ms；保留各模式响应、地图和锚点失败细节。 |
| Rust：`docs/tmp/md-unification-rust-tests.log`、`md-unification-clippy.log` | 既有 test、clippy、fmt 通过；本轮未改 Rust 业务代码。 |

v32 EXE SHA256：`b396f86dedc69559dffe46c080e7bd6ef363d14cb7f6a7d4f1d6bff5d1df310e`；v33 EXE：`c8dc0ab50a5c47399ef8e14dc072e560b004231c4c9983158de5677bce16c527`；v37 EXE：`b595a2c736aa1bd16873fa7772c9fc31c4478d9ee9087a0861fbbe2219a17663`；改造前 EXE：`2ac3660bee4b8f2da0dc552bf0595ee8c7e1dda3d72c739649a26a7c04ff8394`。所有原生性能样本串行采集；最终报告须记录最新 EXE 的 SHA256、远程显示配置以及改造前同环境对照，不能用前端回归或旧环境结果代替。

## 原生门禁运行

```powershell
node tests/gates/gen-corpus.mjs
node tests/gates/gen-md-surfaces-corpus.mjs
node tests/gates/prepare-gate-build.mjs --build
node tests/gates/run-all.mjs md-surfaces ir-scroll --corpus mixed-100k
node tests/gates/run-md-matrix.mjs
```

`--build` 先执行与前端 build 相同的 TypeScript/Vite 构建，再调用 Tauri CLI，避免遗留 dist 被当成当前代码。自定义 `ZIEDIT_GATE_RUN_DIR`、`CARGO_TARGET_DIR` 时，应把 `ZIEDIT_GATE_EXE` 指向构建输出的实际 exe。

完整 Markdown 矩阵使用 `run-md-matrix.mjs`：串行覆盖 13 份语料、编辑、导航、位置、早期交互及两份 IR 对照，共 19 项，失败样本保留在各自报告中。设置 `ZIEDIT_GATE_BEFORE_EXE` 可用同一量具复测改造前的普通 1MB 与混合正文；旧版本的失败独立标记，不影响新版本的通过判定。报告目录可作为唯一命令行参数指定，默认 `results/md-matrix`。

## 尚待关闭

- 2026-11-11 完整矩阵 19 项中 17 项通过之后，对未达的两份语料做了隔离复测：巨 JavaScript 分屏滚轮响应 P95 48.8ms，400KB 单表分屏挂载不再有 ≥50ms 的长任务。完整 19 项尚未用这次构建重跑，也没有同环境旧版对照，不能收口。
- v53 空白锚、巨表行高前缀及暂缓交付已完成完整前端回归、当前源码 Tauri CLI 构建和原生矩阵；正文/巨表位移问题在本轮未再复现，但完整性能验收仍未通过。
- 2026-11-12 批1a 已收口该样式基线：间距契约单一来源 `src/markdown-view/spacing.ts`（求和模型，IR 向预览 flow-root 基线看齐），`layout.ts` 消费之。新隔离构建（exe SHA256 `94089f139e85a3f6600ec53a9491d5ded939eecb2944b84d94c1bf7a32a628e1`，源码 SHA `c421dcb8…`）上 `gate-md-consistency` 四轮（LF/CRLF × 亮/暗）全 PASS、逐元素 0 差异（1.5px 未放宽），见 `docs/tmp/gates-run/results/gate-md-consistency.json`、`docs/tmp/batch1-consistency.log`；预览/IR 亮暗截图走查间距逐块对齐（`docs/tmp/gates-run/batch1-screenshots/`）。位置门 `gate-scroll-position` PASS（形态往返 drift≤0.02px）、`gate-batch1-scroll` PASS（dense-2m jumps=0、无 ≥100ms 长任务）、`gate-ir-scroll` PASS（p95 31.7ms ≤ 基线+2 且 ≤32ms）。
- 2026-11-12 批1c 已定位并修复普通 100KB 菜单切换错误：根因为 `wysiwygEligible` 对未知体量用 `?? Infinity`（禁用 IR），与分屏/modeOf/IR 挂载守卫/disabled 原因键四处 `?? 0` 不对称；会话恢复异步窗口（ensureFileMeta 稍后填 fileSizes）内 IR 菜单项被禁用。判决收口 `mode.ts` 的 `menuWysiwygEligible/menuSplitEligible`（未知按 0 乐观，超限仍由挂载守卫权威拦截），app.ts 委托；先红后绿回归（`mode.test.ts` 对称性用例，sabotage 回 Infinity 即红）。两处源码契约锁（ac-007-switch-silent / ac-007-readonly-ir）随政策更正同步更新并保留原意图。全量 vitest 1335 项绿、tsc 零错。菜单错误的真机复验随完整矩阵（批2）在匹配显示环境执行。
- 2026-11-12 批1 验收环境说明：当前为远程显示 32Hz（Microsoft Remote Display Adapter 2560×1440；物理 RTX 2070 SUPER 60Hz 未驱动会话）。`gate-ir-settle` 在此环境 FAIL（7/12，topMax 24.3/midMax 93.9px），但同环境 pre-批1 release 基线（exe `342f153a…`）FAIL 更重（topMax 123/midMax 106.5px，同 7/12、E3 大负 delta），证明为远程 32Hz 平滑滚动采样伪影、非批1a 回归（批1 反而降低最大漂移）；对照见 `docs/tmp/batch1-ir-settle-current.json` 与 `batch1-ir-settle-baseline.json`。ir-settle ≤2/≤4px 的严格验收须在本机 60Hz 复跑（并入批2 矩阵环境），远程样本不作验收依据。
- 2026-11-12 批2b 门禁口径对齐（独立于产品修复）：①`native-gate-ac36.mjs` 密集键入 p95 预算 16→40ms（落实 2026-11-04 用户决策，max50/长任务100/minSamples100 不变，16ms 留长期目标注释）。②`gate-md-surfaces.mjs` 挂载/打开/主线程长任务 ≥100ms 判定从 single-* 扩至全部语料（:218/:219/:246），暴露 dense-2m 挂载长任务。③修 ac36 形态前置缺陷：出厂默认已保存 md 进渲染预览（2026-10-29），预览态并存一个空的暂存 `.cm-content`（实测 cmLens=[0,1302503]），ac36 原 bare `querySelector('.cm-content')` 误取空编辑器→base.len=0、整轮键入落空（旧报告 0/3「input not landed」即此因，非产品回归；先前误判为并发门禁抢占，实为选择器缺陷）。改为挂载后显式 `switchMdMode('即时渲染')` 并待 `.md-ir:not(.md-ir-loading) .cm-content`（与 gate-md-surfaces IR 口径同源），切换 settle 后只剩唯一可见编辑器（probe 实证 cmCount=1、键入 1302503→1302510 落地）。
- 2026-11-12 批2c 挂载长任务修复（按体量分流，exe SHA256 `4b58be97c050a58ee2a87be9a4b8edc959e7a8433f6594515c6437c6b988fd8e`）：根因为换挂点击任务内同步 `clearViewarea` 对整棵水合预览 DOM 单次原子 detach（dense-2m 数千公式/代码块）走完整子树 ≥100ms，destroyView 本身仅 ≈3ms。`app.ts` 拆除按 `fileSizes` 分流：<256KB 沿用同步 `clearViewarea`+原 releasedLong 时序（保留锚定时序，IR 空行间距装饰即时交付）；≥256KB 改 `clearViewareaChunked`（≤8ms 预算分批清 `.md-col`、片间让出、世代守卫）异步挂载链。同环境前后对照（`batch2-surfaces-dense-before.json`→`batch2-sizegate-dense-2m.json`）：dense-2m 分屏挂载长任务 113→67ms、IR 112→58ms、打开 50→0，三面均无 ≥100ms；`batch2-sizegate-single-table-400k.json` 三面挂载/打开长任务全空、settle 0px。完整矩阵内 dense-2m 与 single-js-1m 挂载/打开长任务亦全空。【需谨慎项已规避】此前把异步挂载边界扩到小正文曾把 IR mdir-gap 延迟交付推进停手结算窗、引起 metadata 阅读锚 10.4px 位移；体量分流后小正文回同步路径，`batch2-sizegate-meta1..5.json` 五轮 IR settle maxDrift 0/0/0/0/0.4px（≤0.4，远低于 4px 门槛），同步隔离对照 `batch2-attrib-sync-iso1..3.json` 三轮 PASS。`livepreview.ts` flashLine 去 `void offsetWidth` 强制回流，改下一帧 rAF 重启脉冲（:843）。`lineBlockAtHeight(0)` 同步测量契约（:349/:377）未动。
- 2026-11-12 批2 ac36 清洁验收 PASS（3/3，严格单独运行，端口 18430 独占）：`docs/tmp/batch2-ac36-clean.json`，AC36_EXIT=0。冷/温/温三轮 base.len=1302503（dense-2m 全文）、inputLanded、序号 56/56 有序、docChanged 样本各 1464（≥100）；键入分段 p95 26.9/27.3/28.3ms（中位 27.3≤40）、max 32.2/30.9/32.4ms（中位 32.2≤50）、>100ms 长任务 0（单尾最大 56ms）；机制锁 getLines=0、referencesReady 各 22（B2 零全量重建保持）。前端门：tsc 零错、vitest 177 文件 1335 项全绿（`batch2-vitest-final.log`，按文件串行 --maxWorkers=2）、license:check releaseAllowed=true/unresolved=[]（`batch2-license-check.log`）。批2 未改 Rust 业务代码，隔离构建已编译原生侧。
- 2026-11-12 批2 完整矩阵 13/19（`docs/tmp/batch2-final-matrix/matrix.json`，exe 4b58be97）：位置/编辑/导航功能/早期交互/两项 IR 对照中 ir-dense-2m 及其余 13 项 PASS；plain-1m 首屏 413.2ms≤500。6 项未达均环境性或既存间歇，无产品正确性失败：①dense-2m 分屏滚轮响应 55.4ms、②plain-1m 分屏 50.4ms、③metadata 分屏 51.8ms、④single-js-1m IR 50.9ms（四项帧 p95 均 ≈19ms 远低于 32ms，仅滚轮响应边际超 50ms，远程显示时序抖动，逐轮波动）；⑤导航图片延迟加载阅读锚 maxDrift 224px（17 项检查仅此项败，字号/窗口缩放锚均 0px；语料 repeated-6001=126KB<256KB 走未改动的同步路径，批2 体量分流不涉；既存间歇，v44/v45 曾记 223.59px，v53/final-2026-11-11 基线此项 PASS）；⑥ir-mixed-100k >34ms 帧 3>基线 0+2（全文帧 p95 18.9ms≤32，边际）。环境：远程 OrayIddDriver + 物理 NVIDIA RTX 2070 SUPER 1920×1080@60Hz，WebView DPR 1.25、1282×834，displayChanged=false。无同环境旧版完整矩阵对照（未留存 pre-批2 exe；仅有 dense-2m 同环境前后对照）。按方案「环境劣化样本（远程 32Hz）不作验收依据」，滚轮响应 ≤50ms 全 19/19 与 ir-settle ≤2/≤4px 的严格性能验收须在本机 60Hz/DPR1 复跑收口；批2 产品修复（挂载长任务、metadata 位移回归、ac36 形态前置）已据本轮证据验证关闭，整体性能验收仍保持「进行中」。
- 2026-11-12 批2 暂缓项（随本机 60Hz 严格验收一并验证）：2c 的安全测量削减——`blockcache.ts` 冷构建尾部全量 `querySelectorAll('.md-block')`（:336，单次建尾扫描，改已提交集合差须保证中断建尾节点仍被清理）与 `reading-surface.ts` measure() 脏区间/父盒一次读（:265-271/:326-331，【需谨慎·锚管理器】）——本轮未改。原因：reading-surface 属锚管理器敏感路径，须配 ir-settle ≤2/≤4px 门逐项验证，而该严格门仅本机 60Hz 可判（远程 32Hz 为采样伪影，见批1 环境说明）；blockcache 建尾扫描有尾部清理正确性 subtlety，宜与锚门同环境验证。每键 stateFields/decorations 全量重算攻坚按方案「仅矩阵仍失败时」触发，本轮矩阵未达项均为环境性滚轮响应/既存图片锚间歇，非该热点，故不触发。`lineBlockAtHeight(0)` 同步契约（livepreview.ts:349/:377）全程未动。
- 2026-11-12 批5 测量削减已实施（批2 暂缓项收口）：`blockcache.ts` 建尾清理改「已提交集合差集」（:336-337 全树 `querySelectorAll('.md-block')`/`.md-reading-page'` 扫描移除；committedBlocks 在 commit 插入时增量登记、冷建/销毁清空，中断建尾、reset 非冷复用、被替换旧块均被差集覆盖；jsdom 游离宿主必须无条件 `remove()`——`isConnected` 守卫会漏删，首轮已修并有先红后绿记录）；`reading-surface.ts` `measureNested(dirty)` RO 热路径脏区间（脏父块子树外维持已交付 relative）+ 父盒一次读取（同父多嵌套目标共享一次 getBoundingClientRect），`measure()` 全量刷新契约不变（无 RO 宿主/测试依赖）；`text-view/view.ts` render() 行+签名复用（行内容物→双 32 位签名，仅签名不同或行缺失才重建，滚动/续写不再整视口重挂；折叠地图、长行缓存、cacheVersion 失效语义不变）。前端门全绿：tsc 零错×3 轮、vitest 1338/1338×3 轮（含 6000 块增量身份保持）。`livepreview.ts` `lineBlockAtHeight(0)` 同步契约（:349/:377）全程未动。本机 60Hz/DPR1 严格验收结果见上表 2026-11-12 各行：19/19 与 ir-settle ≤2/≤4px 均未达成（未达项为 50ms 线运行间波动与既存 IR 阅读锚间歇，均有修前对照/复测证据），性能验收维持「进行中」。
- 2026-11-13 批7 停滚锚漂移修复（HEAD 12b891b 线）：批5 记录的「IR 停后阅读锚漂 9.578125px（metadata/single-heading-tail 确定性）/26.0625px（dense-2m）」根因定位为 **块间空行行高装饰（mdir-gap）随重型块件走预算分片**——新入视口空行先按整行高 21.6px 渲染、分片到达后塌成 10.8px 间距，停滚后逐步收缩（ZIEDIT_MD_TRACE 邻域逐帧实录：t=114/164/214ms gap 逐个补上）。修复：live-block-field 滚动/视口事务内同步交付 gap 装饰（mergeLayoutNow，语法树可用时），重型块件（表格/公式 set）仍走预算分片；ir-cache.test 计数断言同步（blockDecos 分片不变，BlockPlaceholder 断言原样）。修复后本机 60Hz 实测：metadata/single-heading-tail/dense-2m IR 漂移 9.58/9.58/26.06 → **0/0/0.27**；r12 冷矩阵 **19/19**（本会话首个全绿）；r15 冷 18/19+热 17/19（残余均为既存贴线族：模式切换边界长任务 77-167ms、single-js split 响应 48-60ms、ir-dense-2m 帧 p95 33.3，非漂移类）。两项实验性加固因回归已回退并留档：settle 事务整窗 gap 重建（dense-2m ≥100ms 长任务）、无预留尺寸图片冻结（split 帧 p95 16.8→33.3；60Hz 实测该场景无冻结也过，故整体回退）。gate-md-images 在修前 exe（04201e5）同样失败（"scroller missing: split"）——既存失效门禁，与本轮改动无关，待独立排查。walk-f 形态切换菜单重试 2→3（量具稳健性）。`lineBlockAtHeight(0)` 同步契约未动。
- 最终性能问题修复后须重新构建、跑完整矩阵及同环境旧版对照，再做记录收口；现阶段保持“实施与原生验收进行中”。
