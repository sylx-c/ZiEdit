# ZiEdit 官网

零构建、零依赖的中英双语静态站。`index.html` 已包含两种语言的全部内容；截图、样式和脚本均使用相对路径，因此同时适用于本地根路径预览与线上 `/ZiEdit/` 子路径。

## 本地预览

任选一种静态服务器，在本目录运行：

```bash
python -m http.server 8000
```

然后打开 <http://localhost:8000/>。

也可以使用：

```bash
npx serve .
```

`npx serve` 仅作为可选预览工具，不是项目依赖，也不会生成构建产物。

## 部署到 GitHub Pages

**自动部署**：master 分支上 `website/**` 的任何变更会由 [website-deploy 工作流](../.github/workflows/website-deploy.yml) 自动发布到 `gh-pages`；也可在 Actions 页面手动触发（workflow_dispatch）。

手动部署（应急）：

1. 将 `website/` **目录内的全部内容**（不含本 README.md）发布到 `gh-pages` 分支根目录（不要多套一层 `website/`）。
2. 在仓库的 **Settings → Pages** 中选择 **Deploy from a branch**，分支选择 `gh-pages`，目录选择 `/ (root)`。
3. 发布后访问 <https://sylx-c.github.io/ZiEdit/>。

站点无需 Jekyll、Node.js 构建或资源打包。更新时同步替换 HTML、CSS、JS 与图片即可。

## 双语言与截图

- 默认语言为简体中文；右上角切换只修改根元素的 `lang`，CSS 同步显示对应语言块。
- 用户选择保存在 `localStorage`；脚本在 `<head>` 中阻塞执行，在正文解析前恢复语言，不产生异步渲染窗口。
- 六张截图全部预加载；所有 `<img>` 都有显式 `width="1600"` / `height="1040"`，且不使用懒加载。
- 格式切换由原生单选框与 CSS 完成；移动导航由原生复选框与 CSS 完成。
