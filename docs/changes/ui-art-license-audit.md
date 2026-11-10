# UI 美术边界与资源许可审计（2026-11-05）

**后续修复更新：本页为首轮历史审计，90项原缺口及后续发现的内嵌组件/素材问题已在全面修复任务处理；当前状态、严格门禁和分发验证边界以[版权来源与分发修复](license-remediation/README.md)为准。旧记录不作为当前待审清单。**

**字体状态更新：下文是首轮审计历史记录；其中 NewCM、JetBrains 版本与字体原文分发问题已在后续专项修复中处理。当前字体结论见 [字体版权问题处理记录](font-license-resolution/README.md)。非字体的 ELK/Emoji/其他依赖未决项仍独立保留。**

## 当前结论

用户要求保留现有排版、布局、功能位置和四个主题，仅做美术优化。此前蓝墨 V2 改变工具栏/侧栏/标签/标尺/弹层尺寸和四主题基础配色，现已撤回这些 CSS 变化，恢复 Git HEAD 的原布局与主题底色。旧 V2 原型和截图是历史方案，不是本轮结果。

本轮只保留不改变盒尺寸的四处美术细节：工具栏选中按钮内描边、当前文件行内侧定位线、活动标签顶边强调、状态格去凹凸的细平面边框。主题 radio 与命令面板语义/焦点修正保留。不更改正文排版或引入外部美术素材。四主题仍为简洁白、冷灰蓝、石墨、纯黑。新方案尚未得到用户视觉认可，不声称已经定稿。

## 审计范围和方法

检查锁文件、已安装 npm 包、本地 Cargo 缓存与 `cargo metadata --locked --offline`、公共资产、网站与 Demo、实际 Vite 产物及 Tauri 资源配置。原文文件按字节收集并记录 SHA-256；不以一个 MIT 标签替代各包原有版权。网络核实以官方项目固定版本及发行站为依据。

本机锁文件记录 296 个 npm 包（251 本机已安装，115 development-only），Cargo metadata 包含 556 个第三方包的全目标保守超集，不能将其全部当作最终二进制实际运行依赖。收集 1226 份原始许可/版权/NOTICE 文件，共 5,280,632 字节。

没有发现必须购买授权或禁止商用的 UI 字体/图标的确证。**存在真实分发义务和未决溯源事项，不能宣称没有任何版权风险或已具备发布条件。** 免费商用不等于无署名、无源码义务；GPL 字体例外也不免除字体自身的 GPL 义务。

## 资源结果

| 对象 | 证据和结论 | 本轮处理/剩余事项 |
|---|---|---|
| JetBrains Mono 2.304 | `public/fonts/OFL-LICENSE.txt` 含版权和 SIL OFL 1.1，允许随软件嵌入/商业分发，不可单独出售字体。此文件无 Reserved Font Name 声明。 | 保留字体和原文，无新增商业字体。 |
| 系统界面字体 | CSS 声明 Segoe UI / Microsoft YaHei / Apple 系统字体回退，不等于把字体文件再分发。 | 未发现复制这些系统商业字体的文件。 |
| 工作台 SVG/品牌标 | 使用仓库现有 SVG 路径，不依赖收费图标包。仅凭几何形状无法证明全部历史原创。 | 本轮未引入任何外部图标。无法确认历史权属的声明不伪装为已证原创。 |
| 官网 GitHub SVG | 路径与 Lucide 0.468.0 github.svg 一致，ISC 允许免费商业使用但要求保留原文。 | 已在 HTML 加完整 ISC 注释，并新增 `website/third-party-licenses.txt`。 |
| Mermaid 图标 | 内置 treeView/architecture 默认形状有上游源码来源，Mermaid MIT 原文存在。CSS 的 Font Awesome 注释不构成付费 Pro 资产证据。 | 未发现 Font Awesome Pro 的确证，不编造侵权结论。 |
| PDF Foxit 字体 | BSD-3-Clause（`LICENSE_FOXIT`），原总表统称 Apache 不准确。 | 已纠正总声明。 |
| PDF LiberationSans 四字体 | 1.07.4，GPLv2 + Liberation font exception；与 pdf.js v6.4.299 官方字节一致。 | 保留功能和原字体。随 `public/third-party-sources/` 提供准确版本源码包、构建材料和散列；Tauri 资源配置已加入。未重编译字体验证二进制复现，最终发布需核对源码与二进制同包。 |
| MathJax NewCM 字形 | npm 代码 Apache 原文不能覆盖所有源字形；当前 CTAN 按字体区分 GFL/GPL3+例外，不能将两个许可标签理解为任选。 | **未解决**：MathJax 4.1.3 实际源字形版本和逐字体来源待确认。已删除无证的“任择双许可/GFL已满足”结论。没有为避开问题擅自删除公式功能。 |
| npm/Cargo 原文 | 原来多为名称/许可简写，不能替代独立版权和许可原文。khroma 本地 license 确认 MIT。 | 新增离线收集器和完整逐包原文目录，Tauri 显式分发。 |
| MPL option-ext | Windows normal 依赖路径 option-ext→dirs-sys→dirs→tauri，MPL 允许商用但有对应源码义务。 | 已补原文和精确源码获取说明；需最终发行可用性检查。 |
| EPL elkjs | JavaScript 固定源码版本已定位，其生成依赖外部 ELK Java 源码。 | **未解决**：ELK Java 精确对应版本/完整性须补证。源码获取说明已明确此缺口。 |
| Emoji 映射 | 源码 notice 含 MIT 版权，但原先未单独随包，且本地增补未逐条溯源。 | 已配置完整 notice 随包；**本地增补逐条来源仍待补齐**。 |
| 官网截图/OG | 未发现付费图库证据，但缺生成和示例内容来源记录。 | 记录为溯源文档缺口；不能据此判定侵权，也不能证明零风险。 |

## 新的分发证据

- [逐包原文与范围说明](../../public/third-party-licenses/README.md)
- [逐包机器清单](../../public/third-party-licenses/manifest.json)
- [待补证清单](../../public/third-party-licenses/review-required.json)
- [MPL/EPL 对应源码说明](../../public/third-party-licenses/SOURCE-OFFERS.txt)
- [Liberation 对应源包与散列说明](../../compliance/third-party-sources/LIBERATION-SOURCE.txt)
- [更新的总声明](../../THIRD-PARTY-NOTICES.md)
- [官网图标原文](../../website/third-party-licenses.txt)

收集器有 90 项未决记录：45 个未安装的其他平台可选 npm 包、44 个缺独立许可文件的包（6 npm / 38 Cargo）、1 项 ELK Java 源码完整性。它们并不等于 90 个侵权依赖，亦不能自动豁免。另有上表 NewCM/Emoji/截图等不在收集器包级范围的待核事项。

`node scripts/generate-third-party-licenses.mjs --check` 检查字节一致性；`--check --strict` 对未决项返回非零，收集成功不等于合规放行。原文含开发及其他平台超集，是保守证据收集，不是每份都实际进入运行代码的宣称。公开发布前必须补齐所有实际分发项、检查最终安装包，并在依赖变化后重生成。

## 官方证据

- JetBrains Mono: https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304
- Lucide SVG: https://github.com/lucide-icons/lucide/blob/0.468.0/icons/github.svg
- Lucide ISC: https://github.com/lucide-icons/lucide/blob/0.468.0/LICENSE
- PDF 字体版本说明: https://github.com/mozilla/pdf.js/blob/v6.4.299/external/standard_fonts/README.md
- Liberation 1.07.4 对应源包: https://deb.debian.org/debian/pool/main/f/fonts-liberation/fonts-liberation_1.07.4.orig.tar.gz
- Debian 源清单 SHA-256: https://deb.debian.org/debian/pool/main/f/fonts-liberation/fonts-liberation_1.07.4-11.dsc
- NewCM 当前许可分项（不代替实际历史源版本证明）: https://ctan.org/tex-archive/fonts/newcomputermodern/License.txt

## 验证边界

- `npm run build`：通过。保留已有 Markdown 动态/静态导入分包提示；公共法律资产复制使构建增加约 1.8 秒文件复制开销。
- `ac-blue-ink-visual`、`ac-polish-visual`、`ac-001-palette-filter`：3 文件 / 12 项全部通过。
- `node scripts/generate-third-party-licenses.mjs --check`：通过（1226 份原文）。
- `git diff --check`：通过；CSS 最终 diff 仅为描边/阴影/边框，没有尺寸/字体/间距/四主题令牌差异。
- 已确认 `dist/third-party-licenses/manifest.json`（1,060,880 字节）与 `dist/third-party-sources/fonts-liberation_1.07.4.orig.tar.gz`（2,937,949 字节）实际生成。
- 对应字体源包 SHA-256 与 Debian `.dsc` 一致，归档包含 `src/*.sfd`、`Makefile`、`scripts/`、`License.txt` 和 `COPYING`。

未做全平台原生重验、最终签名安装包解包或律师权属确认；本轮审计不能作零风险保证。当前原生可执行文件尚未以本轮恢复后的 CSS 重建，不应将上一轮原生窗口当成最新结果。未提交或推送。
