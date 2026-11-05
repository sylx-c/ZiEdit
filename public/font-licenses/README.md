# ZiEdit 字体许可与来源

本目录与 `third-party-sources/` 作为独立资源随桌面应用分发，也包含在离线前端资源中。桌面安装目录的 `font-licenses/` 可直接用文本编辑器打开这些文件；字体不是单独出售的商品。

| 实际分发对象 | 来源与许可 | 原文 |
|---|---|---|
| JetBrains Mono Regular/Bold/Italic | 官方 v2.304 三份原始 WOFF2，SIL OFL 1.1，允许随软件商业分发 | `OFL-JetBrainsMono.txt` |
| MathJax STIX2 4.1.3 SVG 字形 | STIX Two 衍生字形采用 SIL OFL 1.1，MathJax JS 代码 Apache-2.0；完整保留历史版权，修改版名称 mathjax-stix2 不使用保留名称 TM Math | `OFL-STIX.txt`、`NOTICE-MathJax-STIX2.txt`、`Apache-MathJax.txt` |
| MJX-ZERO 0.1 内嵌辅助字体 | MathJax Consortium 2023–2026，Apache-2.0。只用于公式换行测量，不是 STIX 字形 | `MathJax-zero-source.ts.txt`、`Apache-MathJax.txt` |
| PDF Foxit 标准字体 | PDFium/Foxit，BSD-3-Clause | `BSD-Foxit.txt` |
| PDF Liberation Sans 1.07.4 | GPLv2 + Liberation 字体例外；保留原字体、许可及对应源包 | `GPL-Liberation.txt`；同级 `../third-party-sources/LIBERATION-SOURCE.txt` 和源码包 |

系统界面字体回退由操作系统提供，没有复制到应用。Mermaid/KaTeX 排版代码未额外带入字体文件。

精确载荷及许可原文的 SHA-256、字节数、版本来源记录在 `manifest.json`。保留的 `mathjax-stix2-definition.ts.txt` 证明本次数学字形只引用 STIXTwoMath/Text 五个字体输入。该定义不提供源字体输入的具体子版本，本文也不将历史完整 OFL 文本版本冒充为其源版本；STIX Two 系列统一适用 OFL，随包保留完整版权链。

原来来源版本无法确认的 NewCM SVG 字形已移出分发目录。开发依赖 mathjax 的依赖树仍可能安装默认 NewCM 包，但应用只复制明确选定的 STIX2 SVG 组件；构建检查拒绝混入未审核的字体载荷。旧版本安装包和旧构建缓存不会因本次源码修正自动获得新许可材料，后续发布须重新构建。

字体门禁：`node scripts/verify-font-licenses.mjs`。每次 Vite 构建会先同步固定数学字体，再执行此检查；变更字体后须先审核，再显式更新清单，不能把 `--record` 当作自动放行。

上游来源：

- https://github.com/JetBrains/JetBrainsMono/tree/v2.304/fonts/webfonts
- https://registry.npmjs.org/@mathjax/mathjax-stix2-font/4.1.3
- https://github.com/stipub/stixfonts/blob/v2.13/OFL.txt
- https://github.com/mathjax/MathJax-src/blob/4.1.3/ts/output/svg/Wrappers/zero.ts
- https://github.com/mozilla/pdf.js/tree/v6.4.299/external/standard_fonts
- https://deb.debian.org/debian/pool/main/f/fonts-liberation/fonts-liberation_1.07.4.orig.tar.gz
