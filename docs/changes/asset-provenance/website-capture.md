# 官网截图与社交预览来源整改

本记录只证明本轮重新生成的图片，不为历史图片补造作者、示例或生成记录。

## 已替换的内容

- 官网六张 `website/shots/{zh,en}/{text,code,markdown}.png` 使用本仓库当前隔离 review 版 ZiEdit 重新截图，保留原有 **1600×1040** 像素尺寸。
- `website/og.png` 从当前官网真实首屏重新截图，保留原有 **1262×624** 像素尺寸。没有拼接窗口、替换界面文字、缩放位图、注入 CSS 或编辑截图中的内容。
- 旧截图中出现的 `demo2`、`field-notes.md` 等原始示例没有在仓库找到，因此不把它们视为本轮可复核证据。新示例放在 `compliance/asset-provenance/website/examples/{zh,en}/`，均为本轮为 ZiEdit 编写的虚构工作笔记、任务代码和写作说明，没有复制外部文章、第三方示例或真实个人/项目资料。

## 来源与复现

新增脚本 `scripts/capture-website-assets.mjs`，支持：

```sh
node scripts/capture-website-assets.mjs --native
node scripts/capture-website-assets.mjs --og
node scripts/capture-website-assets.mjs --verify
```

原生截图脚本只接受独立命名的 `ziedit-review.exe`，先确认 CDP 端口空闲，然后启动自己管理的进程。它通过命令行打开真实文件，通过真实标签控件切换文件，通过既有 `settings_save` IPC 和页面重新加载切换语言/主题；不绕过应用渲染路径，不构造截图 DOM。脚本只清理自身启动的 PID，用户安装版没有被连接、重配或关闭。

本次实际使用 `docs/tmp/visual-review/ziedit-review.exe`，其独立应用标识为 `dev.ziedit.visual-review`。二进制 SHA256、尺寸、系统版本、截图状态及加载资产散列见 `compliance/asset-provenance/website/native-capture.json`。当前 `dist` 单独记录，实际加载资产逐项标记是否与其一致；不能据“当前 dist 在磁盘上”断言它就是 review EXE 的内嵌前端。本次 review 版早于最新 Emoji 修正；六份示例不使用这些别名，也不展示 Mermaid/ELK 图。

本机实际像素截图为 1600×1040，对应窗口 CSS 视口 1280×832、DPR 1.25；保留原始物理像素，没有为了满足尺寸调用图片缩放。没有更改窗口布局或四主题定义，拍摄选择的是已有 Paper 主题。

Windows Known Folder API 保留了独立 review 配置，未完全跟随 APPDATA/LOCALAPPDATA 环境覆盖。脚本因此明确通过真实关闭控件清理旧 review 标签，只使用独立 WebView 目录；不会把环境变量覆写误写为“所有配置全新”。英文菜单与设置语言真实切换成功，但旧 review 构建的 HTML `lang` 属性仍为 `zh-CN`，这一原始状态在记录中保留，没有注入修正。该属性问题不阻碍图片中实际英文内容的来源证明。

OG 使用独立浏览器配置和临时回环静态服务器，不使用 1420 端口或 DSH 服务；仅访问本仓库官网。输入的 HTML/CSS/JS/图片等字节、浏览器程序及版本见 `compliance/asset-provenance/website/og-capture.json`。浏览器渲染后直接截取首视口。

## 原文件与义务

`compliance/asset-provenance/website/raw/` 保留全部截图原文件。发布图片与原文件须逐字节相同；`--verify` 检查六份示例、六张原生截图、OG 原图、发布图片和截图脚本散列。官网输入改变后须重新生成 OG；不能只更新清单掩盖陈旧截图。

新写的示例和截图流程按本项目 MIT 许可提供。画面中的 ZiEdit 图标、字体和其他组件继续保留各自来源声明，本记录不凭截图生成行为重新主张其中第三方组件的版权，也不代替图标/字体/整个发行物的审查。网站正文、图标、favicon 的来源由并行整改负责，本任务不修改它们。

本轮没有提交、推送或部署。后续若更换真实应用构建或官网代码，应重新截图并更新来源记录；历史图片不能由这份新证据追溯性地转为已证明。
