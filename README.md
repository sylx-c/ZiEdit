# ZiEdit

**[中文](README.md)** | [English](README.en.md)

跨平台、离线优先的桌面文件查看与编辑工具，支持文本、代码、Markdown、CSV、图片与常见文档格式。Windows / macOS / Linux，基于 Tauri 2 + Rust + CodeMirror 6。

全程本地运行，不需要账号，不上传数据；唯一可选的联网能力是用户自行配置的 S3 兼容图床。

## 功能特性

**多格式文件查看**
- 文本与代码查看与编辑；图片（png / jpg / gif / webp / bmp / svg）；CSV / TSV 表格（可切换分隔符）
- docx / xlsx 只读提取、PDF 文本提取（有界离线，不做版式引擎）
- 编码自动识别（BOM → 文件内声明 → 启发式 → 手动覆盖），支持 GBK / GB18030 / UTF-8/16/32 / Shift_JIS 等，可编码转换另存、Unicode 规范化另存
- 大文件无压力：虚拟滚动 + 分块读取，日志级文件也能流畅打开；日志尾板（tail）轮询刷新

**Markdown**
- 源码 / 预览 / 分屏 / 所见即所得四种模式，Live Preview 增量渲染
- MathJax 数学公式、Mermaid 图表、worker 化代码高亮、GFM 表格编辑、大纲导航、格式化
- 可选 S3 图床上传（去重、重命名模板；密钥仅保留在会话内存）

**文件对比**
- 双文件对比：并排 / 统一 / A-B 三视图
- 差异自动分类：同形字符、Unicode 规范化、不可见字符、空白、内容

**编辑与工作台**
- 矩形/列选区与列编辑、粘贴矩阵、书签、查找替换与批量替换、多文件查找、跳转行
- 文件树（多选、收藏、最近文件、过滤）、命令面板、系统文件图标
- 主题、字体导入、界面缩放、中英双语界面（zh-CN / en-US）
- 自动保存与崩溃恢复快照；系统文件关联：图片、文本/配置、Markdown、JSON/YAML/XML、CSV 与 24 种源码扩展名

## 从源码构建

当前版本仅在 Windows 上经过测试；macOS 与 Linux 安装包由 CI 构建产出，尚未在对应平台实际运行验证，问题欢迎通过 [Issues](https://github.com/sylx-c/ZiEdit/issues) 反馈。预编译安装包见 [Releases](https://github.com/sylx-c/ZiEdit/releases)。

环境要求：

- Node.js ≥ 20，npm
- Rust stable（rustup）
- Linux：`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
- macOS：Xcode Command Line Tools；Windows：WebView2（系统自带或自动安装）

```bash
git clone https://github.com/sylx-c/ZiEdit.git
cd ZiEdit
npm ci
npm run tauri dev      # 开发运行
npm run tauri build    # 打安装包（Windows NSIS / macOS dmg.app / Linux appimage deb rpm）
```

仅调试前端（不启动桌面外壳）：`npm run dev`。

## 开发

常用命令、测试组织与提交前门禁见 [CONTRIBUTING.md](CONTRIBUTING.md)；CI 定义见 `.github/workflows/ci.yml`。

- 前端测试：`npm test`（vitest，1028 个用例，按验收编号 ac-0XX 组织）
- Rust 测试：`cargo test --manifest-path src-tauri/Cargo.toml`（140 个单测）

## 参与贡献

问题与建议可通过 issue 反馈；提交 PR 前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)。随应用分发的第三方组件（MathJax、Mermaid、highlight.js、JetBrains Mono 等）许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
