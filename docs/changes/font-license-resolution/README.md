# 字体版权问题处理记录

日期：2026-11-05。范围：ZiEdit 当前源码及新构建中分发的字体、SVG 字形数据和内嵌字体。UI 布局、四主题和正文排版规则未改。此前审计发现的字体来源/许可缺口已通过固定来源、替换字形与完整原文/源码分发处理；不把本项结论扩大为整个项目（ELK、Emoji 等）的版权审计放行。

## 最终分发字体

| 组 | 最终载荷 | 授权/处理 |
|---|---|---|
| 编辑器字体 | JetBrains Mono v2.304 Regular/Bold/Italic，3 份官方原始 WOFF2 | SIL OFL 1.1。此前本地文件内部版本为2.305、声明2.304不一致，已使用官方固定 tag 原始文件替换，附同 tag 原版版权和 OFL。 |
| 数学字体 | @mathjax/mathjax-stix2-font 4.1.3，26 个 SVG JS 组件 | JS 代码 Apache-2.0；STIX Two 衍生字形 OFL 1.1。完整保留 STIX Authors、MicroPress、Elsevier、Adobe 与 MathJax 版权，修改版名 mathjax-stix2 未使用保留名 TM Math。 |
| PDF Foxit 标准字体 | 10 PFB，原许可证 | BSD-3-Clause；与 pdf.js v6.4.299 官方字节一致。 |
| PDF Liberation Sans | 1.07.4 四 TTF，原许可证 | GPLv2 + Liberation 字体例外，保留原字体以免改变内建字形索引/宽度；对应源码和构建材料 1.07.4 随同软件分发。字体例外不当作无需源码的理由。 |
| 数学零宽辅助字体 | MJX-ZERO 0.1，内嵌于 MathJax output/svg.js | MathJax Consortium 2023–2026，Apache-2.0。附固定4.1.3官方源文件和完整许可，不依赖其为空的内部版权字段。 |

以上许可允许商业软件使用，无需购买这些字体的商业授权；保留原许可、署名、源码及 OFL 不单售字体等义务已落实到本轮资源配置及材料。没有复制系统商业字体；系统字体回退仍由操作系统提供。

### 为什么替换 NewCM

NewCM npm 包只标 Apache，公开源码仓库/提交无法访问，生成定义还涉及 NewCM 与额外字形，不能确认准确源版本及逐字形许可。当前 CTAN 字体又有不同文件的 GFL/GPL 条款，不能把标签当成任选双许可。继续补一个当前版许可文件不能证明旧字形被正确授权。

因此移除 `public/renderers/font` 的全部旧 NewCM SVG 资产，换成官方 STIX2 固定包。MathJax 上层 TeX/排版引擎不变，公式字形风格会有所变化。STIX2 固定定义只引用 STIXTwoMath/Text 五个字体输入，没有 NewCM/MJX-Extra 混源。STIX 历史完整 OFL 文本被保留，不把其 v2.13 tag 冒充为 MathJax 输入字体的具体子版本；其源字形系列统一适用 OFL，不依赖 GPL 对应源码链来分发。

`mathjax` 的 npm 传递依赖仍可能安装其默认 NewCM 包；它只在开发依赖目录中，当前 Vite 不导入它，公共资产只复制审核过的 STIX2 SVG 组件。旧字形移至忽略的临时审计目录，不进入前端和原生资源；旧发布包和构建缓存不会自动被本次修正。

## 许可访问和分发

- [最终用户字体许可入口](../../../public/font-licenses/README.md)
- [逐文件散列/许可/来源清单](../../../public/font-licenses/manifest.json)
- [STIX完整OFL](../../../public/font-licenses/OFL-STIX.txt)
- [MathJax字形分项说明](../../../public/font-licenses/NOTICE-MathJax-STIX2.txt)
- [内嵌MJX-ZERO准确源码](../../../public/font-licenses/MathJax-zero-source.ts.txt)
- [PDF字体对应源说明](../../../public/third-party-sources/LIBERATION-SOURCE.txt)
- [总第三方声明](../../../THIRD-PARTY-NOTICES.md)

Tauri 的 `bundle.resources` 显式复制 `font-licenses/` 与 `third-party-sources/` 为可读目录。用户可在应用资源目录直接打开，而非仅把许可藏在可执行文件中。Vite public 也包含同样材料。Liberation对应源包 2,937,949 字节，SHA-256 `ad98b7498dc2992f7f0868f79b65ce4a720a3acdb63ab3f1f1cb6881117a5406`；包含 SFD、Makefile、转换脚本和原始许可，不只提供外部网页链接。

## 防止复发

- [同步脚本](../../../scripts/sync-math-font.mjs) 固定 STIX2 4.1.3，校验输入定义、拒绝未审核/残留 JS，再逐字节复制所需 SVG 组件。
- [字体门禁](../../../scripts/verify-font-licenses.mjs) 核对全部字体载荷、许可原文与可读副本、STIX实际npm原字节、内嵌字体、源码包散列以及 Tauri 资源映射。新增字体扩展名或额外字体 data URI 会拒绝。
- 每次 Vite buildStart 同步后运行门禁。字体更新必须先审核，再显式 `--record` 更新清单，不是自动接受任意新字体。
- 依赖原文收集器已添加 STIX2 专项证据，补 npm 归档漏带的原文；不会将包的 Apache 字段误作字形 OFL 的替代。

## 实际渲染验证

使用与当前源码相同的离线 MathJax 设置、实际 SVG 字体资源，以及 pdf.js 6.4.299 真引擎，非 mock 字体。测试时没有外网资源请求。

- 12 组公式生成14个SVG（部分编号/结构有额外SVG），98个字形path；无 merror/data-mjx-error。覆盖分式、根式、积分、级数、矩阵、双线体/花体/Fraktur、伸缩括号、向量、宏、AMS编号和引用、文本/粗体。人工看图确认编号及引用均为(1)。
- PDF 特意设置 `useSystemFonts:false`，实际请求本地 LiberationSans-Regular.ttf、FoxitSymbol.pfb、FoxitDingbats.pfb，确认普通拉丁、希腊符号和勾选符号可显示。提取文字含 Helvetica ABC 123、αβχ，canvas非白像素数据存在。
- 发现并修复手工预加载字体与SVG输出器的竞态：改为由 MathJax output/svg 在自身就绪后加载配置的 STIX 字体，避免早执行和依赖环。
- [真实引擎渲染截图](rendering.png)。此为引擎验证页，不是生产UI截图或原生完整流程验收。

复验方式：在项目根运行 `node tests/fixtures/font-verification/server.mjs`，浏览器打开 `http://127.0.0.1:4182/tests/fixtures/font-verification/index.html`。完成后检查 `window.mathResult`、`window.pdfResult`、`window.fontTestsDone`；关闭该服务。验证页复制了应用配置，后续字体加载策略变化时需同步更新。

## 构建与范围

- 最终 `npm run tauri build -- --debug --no-bundle`：通过，包含 TypeScript/Vite 与原生构建；没有构建/发布安装器。
- 将清单中54项字体/原文证据与 `dist` 逐SHA-256核对全部一致。`target/debug/font-licenses` 的全部可读副本、`third-party-sources` 的字体源码包也与源码材料逐字节一致；不是只检查配置存在。
- `git diff --check`：通过。实际渲染验证页最终浏览器控制台零错误/零警告。
- 字体门禁通过，包含5组字体、可读原文副本和对应源码散列检查。
- 离线渲染、文档语义、统一阅读回归：3文件/54项通过；最终加载顺序修正后离线渲染9项再次通过。
- 逐包版权原文 `--check` 通过；该总体审计仍有非本轮字体范围的未决项，不能混作字体门禁失败或项目整体放行。
- 未重编译 Liberation 字体做二进制可复现性验证，未声称全平台字形覆盖完全相同；原PDF字体文件本轮未改变。
- 未提交、未推送、未发布。新构建用于本轮验证；已发布的旧版本需未来发布时更新分发材料。
