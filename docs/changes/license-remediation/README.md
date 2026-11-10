# 版权来源与分发修复（2026-11-05）

## 范围与结论

检查固定 npm/Cargo 依赖、实际 vendored 渲染器、字体/内嵌字形、Emoji、项目图标、官网截图及 Windows 安装器材料。原90项逐包待补证已关闭：87项补精确上游原文，两个无足够证据的旧依赖从锁文件移除/以项目自编组件替代，ELK改用固定源码自编引擎。历史记录仍保留原未决，不冒充旧包合规。

当前 `npm run license:check` 全部通过，逐包清单未决项0。该结论是已审范围的许可及具体义务核查，不是商标/专利/所有历史作者权属的法律零风险承诺。没有引入付费未授权或限制本项目用途的素材。Windows以最终验收安装包解包检查为准；macOS/Linux特别AppImage附带的系统库仍需对应平台实际包装核查，不能用Windows结果替代。

## 已修复

- 许可证据：精确npm原归档核锁integrity、Cargo原归档核锁SHA256，原版权/完整许可/来源固定commit均保留；多平台optional未安装包用官方归档补证，不执行安装脚本。
- 未用的 npm MathJax/默认NewCM依赖移除，当前本地MathJax与已审STIX2数学功能保留；旧stackback0.0.2无完整原文，换用项目自编MIT兼容诊断模块，保留实际接口/全局formatter恢复并有测试。
- ELK：固定ELK0.9.1提交+官方PR955、elkjs0.9.3 wrapper、MELK0.9.1和依赖锁重新编译，替换旧生成声明。完整对应源码23.15MB/16028文件、原始各组件许可、生成Java、构建脚本/锁/修改记录随包。公开源码包独立解压严格离线重编，9个产物逐字节相同；12算法/224选项、13图JSON完全相同、43上游测试通过，浏览器5种图出SVG。旧未知引擎代码和归档移到忽略的历史目录，不再public分发。
- 5个MPL组件全部提供准确原源码包（option-ext、cssparser、cssparser-macros、dtoa-short、selectors）。selectors缺原文正文，保留原源码MPL头并独立附Mozilla官方2.0正文，不假装是上游包内文件。
- Vendored内嵌：实际source map识别55个精确版本，保留完整原始源码许可及3个bundle许可尾，覆盖PDF.js core-js3.50.0、DOMPurify实际3.4.12与当前lock差异、Cytoscape多项嵌入归属、patched源码前后。
- MathJax/highlight：全部分发MathJax字节核官方4.1.3原包；补mhchemparser4.2.1版权/Apache；highlight192语法token严格同源、core绑定alpha等价验证、第三方语言固定源与包装修改。Solidity2.0.5 metadata标MIT与实际WTFPL2冲突，按真实原文选择并如实记录，不再统称MIT。
- Native：ring官方归档391文件逐比缓存，保252份完整法律标记文件+源码归档；WebView2Loader1.0.3800.47官方BSD3 LICENSE/NOTICE与6个DLL/LIB exact对应。
- Emoji：1954键逐项来源与aliasOf，13处纠错、3个错名移除、11正规别名新增；保gemoji/iamcal/Unicode各自固定版完整原许可。独立复核通过。
- 素材：项目原SVG母版重生52图标，补来源commit/命令/工具/散列；官网6张真实应用截图和OG用本轮原创入库示例重拍，留原图、脚本、构建载荷和原文许可，不为旧图补造权属。未改工作台格局/主题。
- 包装：NSIS3.13实际工具与Tauri默认3.11均有原文/10项工具素材hash，插件0.5.3原文已附；显式zlib压缩，避免增加CPL LZMA模块义务。最终解包必须核插件/底图、EXE精确Tauri包类型marker以及全部许可源码，拒绝未知文件。

## 从开发阶段预防

[AGENTS.md](../../../AGENTS.md)第4节规定先审来源再引入，固定版本/散列、保留完整版权、AND/OR分支和内嵌素材分别审核；不得用“免费/AI生成/metadata”替代授权。证据缺失不可进入发行物，不得删待审记录规避门禁。

新增 `npm run license:check`、构建后 `npm run license:dist`。严格门禁已接入CI、工程验证、verified打包、正式Vite构建与公开发布。新增许可表达式或未覆盖copyleft义务默认失败；原生证据绑定当前依赖和真实工具；dist比较全体public载荷和集合、Vite模块/输出hash并拒未登记文件。Windows verified打包需7z解包检查，否则不接受候选。

## 验证记录

- 全量前端1293项/174文件通过；发布/构建保护6项通过；干净`npm ci --ignore-scripts`通过，自编替代模块实际依赖解析正确。
- `npm run license:check`全绿，无未决/skip（对应源码子门禁）。
- ELK源码重编、等价布局和浏览器实渲染见对应源码证据。
- Windows debug NSIS验收包构建成功（101035046字节，SHA256 `7252e049c062470e866613f7eb6a7d9921a296445d8b21ab4fb2d9f103d01e16`）。`npm run license:dist`最终通过；实际解包逐字节核3873项文件及7个插件/向导资源，无未知payload；EXE仅有精确Tauri `UNK → NSS`包类型标记差异。四组可读材料完整，ELK/MPL/字体源码可从包内直接取得，未附WebView2 bootstrapper或VC runtime二进制。见[最终解包报告](windows-installer-verification.json)。未运行安装器、不作公开发布。
- 未签名正式发布包、未执行安装器替换用户安装版，未做macOS/Linux安装包检查；这些不写成完成。未提交、推送或发布。

## 查阅入口

- [逐包许可证据](../../../public/third-party-licenses/README.md)
- [ELK对应源码](../../../compliance/third-party-sources/elkjs/README.md)
- [项目规则](../../../AGENTS.md)
- [总代声明](../../../THIRD-PARTY-NOTICES.md)
- [官网素材新来源](../asset-provenance/website-capture.md)
