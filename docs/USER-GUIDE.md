# ZiEdit 使用指南

本文按常见任务介绍 ZiEdit 的操作路径。菜单名称以当前界面语言为准。全局快捷键使用下文标出的 Ctrl；部分编辑器键位采用 Mod（macOS 为 Command，其他平台为 Ctrl），请以应用内快捷键参考为准。

## 1. 打开文件与文件夹

- 按 `Ctrl+O` 选择一个或多个文件，按 `Ctrl+Shift+O` 选择文件夹。
- 也可以在文件树中筛选、双击文件，或把文件拖到窗口。重复打开同一路径会激活已有标签。
- 按 `Ctrl+N` 新建未命名文本。首次保存时选择文件路径；按 `F5` 从磁盘重新加载。
- 文件树右键可新建、重命名、删除到回收站；在路径框粘贴绝对路径并按 Enter 可直接打开。
- 外部修改会在状态栏提示：干净缓冲会自动重载，有未保存修改时保留当前编辑。文件被移走或删除后，可用“另存为”保留缓冲内容。

## 2. 文本编辑与只读视图

- 不超过 10 MiB 的普通文本直接进入编辑面；更大的文本使用分块流式只读面。
- 流式只读面支持滚动、查找和书签，但不支持替换、列编辑或格式化。需要修改大文件时，请先拆分文件或使用外部工具。
- `Ctrl+Z` 撤销，`Ctrl+Y` 或 `Ctrl+Shift+Z` 重做，`Insert` 切换插入/改写，`Alt+Z` 切换自动换行。
- 可编辑的 JSON/XML 按 `Ctrl+Shift+J` 格式化。磁盘只读文件仍可在内存缓冲中编辑；写回失败时使用“另存为”。
- 工具栏的“编辑/只读”切换当前标签；编辑菜单中的只读模式作用于所有标签。

## 3. 保存、备份与崩溃恢复

- `Ctrl+S` 保存当前内容；`Ctrl+Shift+S` 另存为。文件菜单的“转换另存”可转换编码、行尾和 Unicode 规范化，并写入新文件。
- 默认自动保存目标是旁路恢复快照，原文件不会因定时快照被改写。设置中可改为直接写原文件，或把自动保存间隔设为 `0` 关闭定时保存和快照。
- “关闭时自动保存”单独控制关闭流程。关闭标签或恢复会话遇到未保存修改时，按提示选择保存、放弃或取消。
- 异常退出后启动时会显示可恢复的缓冲。选择要恢复的项目后检查内容，再用 `Ctrl+S` 保存；也可全部丢弃。快照可能缺少最后几次输入。
- 在设置中启用备份并设置保留份数；工具菜单可打开备份目录。恢复快照和备份属于不同机制。

## 4. 矩形选区与列编辑

- 在源码编辑面点击工具栏“列”或按 `Alt+C`，再拖拽选取矩形；即使未开启列模式，也可直接 `Alt+拖拽`。
- `Alt+Shift+↑/↓` 扩展矩形高度；列模式中 `Shift+方向键` 调整边界；`Esc` 清除矩形回到单光标。
- `Ctrl+C` 复制矩形，短行会补空格；`Delete` 或 `Backspace` 删除所选列并将右侧文本左移。
- 右键“列操作”可填充、编号、改大小写、对齐和求和。右键菜单不会清除已经选好的矩形。
- 即时渲染和大文件流式查看面不提供列编辑；请切回源码编辑面。

## 5. 查找、替换与跳转

- `Ctrl+F` 查找，`Ctrl+H` 替换，`F3`/`Shift+F3` 跳到下一处/上一处，`Ctrl+G` 按从 1 开始的行号跳转。
- 查找栏支持区分大小写、全字和正则。替换只对可编辑文本提供；流式查看面只有查找。
- `Ctrl+Shift+F` 在文件中查找，选择目录并设置文件通配符；点击结果可跳到对应行。批量替换列表按每行一组“查找<Tab>替换”执行。
- 即时渲染中的查找会切换到源码；渲染预览提供适用的查找操作。执行批量操作前先确认范围并保留备份。

## 6. Markdown 四种形态

- 可在视图菜单“Markdown”、工具栏或状态栏形态选择器中切换：源码、渲染预览、分屏预览、即时渲染。
- 源码、分屏和即时渲染允许编辑；渲染预览只读。预览中点击“编辑”可回到源码。
- 渲染预览和分屏预览上限为 2 MiB，即时渲染上限为 4 MiB；超过上限时继续使用源码，不超过 10 MiB 的文件仍可编辑。默认形态可在设置修改。
- 支持标题大纲、GFM 表格、MathJax 数学公式、Mermaid 图表和代码高亮。格式按钮与右键菜单提供常用 Markdown 操作。
- 图片可写入本地。启用图床后，上传和取图会访问你配置的 S3 兼容地址；凭据只保留在会话内存中。

## 7. CSV、图片、PDF 与 Office

- CSV/TSV 默认以表格只读视图打开，可在工具栏切换分隔符；需要修改请切回源码。超过 256 MiB 时表格不可用，使用源码流式视图。
- 图片视图支持缩放、旋转、适应窗口和 100% 显示。
- PDF 提供连续整页渲染、页码跳转、缩放和旋转。PDF 是画布视图，不提供正文选择、复制、全文搜索或正文屏幕阅读；超过 100 MiB 不加载。加载失败或加密文件请用系统查看器。
- DOCX 提取正文，XLSX 提取工作表数据并可切换工作表；两者都是只读提取，不提供 Office 原版式编辑、公式重算或保存回写。

## 8. 双文件对比

- 打开工具菜单“比较文件…”，选择两个文件；也可在文件树按住 `Ctrl` 选择两个文件后右键比较。
- 对比视图提供并排、统一和 A/B 形态。使用差异导航或 `Alt+←/→` 跳到上一处/下一处差异；可只显示差异并按图例过滤类别。
- 除增加、删除和修改外，还会标出编码、同形字符、Unicode 规范化、不可见字符、行尾空白和 BOM 差异。
- 规范化操作先预览再另存为新文件。任一源文件变化后重新比较，避免使用过期结果；二进制输入不能比较。

## 9. 标签、书签与会话

- `Ctrl+Tab` 按最近使用切换标签；`Ctrl+PageUp/PageDown` 按标签顺序切换。`Ctrl+W` 关闭当前标签，`Ctrl+Shift+W` 关闭全部，`Ctrl+Shift+T` 重开最近关闭的标签。
- 在支持书签的文本视图中，`Ctrl+F2` 添加或取消当前行书签，`F2` 跳到下一书签；侧栏大纲可跳到标题或代码符号。
- 最近文件和收藏面板可重开路径，收藏支持分组。文件菜单“会话”可保存命名会话并恢复整组标签。
- 恢复会替换当前标签组；如果当前有未保存修改，先选择保存、放弃或取消。会话保存标签状态，不是文件内容的独立备份。

## 10. 日志尾随台

- 从工具菜单打开“日志尾随台”，点击“添加日志”选择文件，可同时观察多个来源。
- 每个来源使用颜色区分；点击 `ERROR`、`WARN`、`INFO` 隐藏或显示相应级别。可暂停/继续轮询，也可清空显示区。
- 这是轮询式观察窗口，每个来源更新最多取尾部 60 行，显示最多保留 2000 行；日志快速增长时可能跳过中间行。
- 清空只移除窗口内容，不删除原文件。需要完整日志时直接打开源文件。

## 11. 设置、外观与字体

- `Ctrl+,` 打开设置，可调整主题、语言、Markdown 默认形态、自动保存与备份、只读模式和关闭按钮行为。
- 工具栏字号控件、`Ctrl+滚轮`、`Ctrl+=`/`Ctrl+-` 调整字号（10–18），`Ctrl+0` 恢复 12。视图菜单“外观”也提供主题和文字大小。
- 从“视图 → 外观 → 字体 → 导入本地字体…”选择编辑字体，或恢复默认 JetBrains Mono。
- 关闭按钮可设置为询问、直接退出或最小化到托盘；“记住我的选择”可在设置中清除。语言切换保留当前编辑内容。

## 12. 快捷键与命令面板

- 帮助菜单“快捷键参考”按分类列出当前注册的快捷键；在搜索框中输入按键、操作名称或分类即可筛选。当前文件、视图和焦点会影响动作是否可用。
- `Ctrl+Shift+P` 打开命令面板，可搜索并执行更多动作，也可搜索文件。对话框、命令面板和菜单打开时会拦截全局快捷键。
- `Alt+F/E/S/V/T/H` 分别打开文件、编辑、搜索、视图、工具和帮助菜单；方向键导航，Enter 执行，Esc 关闭。`F11` 最大化或还原窗口。
- 编辑器快捷键应先聚焦正文；平台使用 macOS `Command` 或其他平台 `Ctrl` 的 Mod 键。以快捷键参考中显示的实际按键为准。

---

# ZiEdit User Guide

This guide follows the same twelve topics as the in-app Help panel. Menu names follow the selected interface language. Global shortcuts use the Ctrl keys shown below; some editor shortcuts use Mod (Command on macOS, Ctrl elsewhere). Follow the in-app shortcut reference.

## 1. Open files and folders

- Press `Ctrl+O` to choose one or more files, or `Ctrl+Shift+O` to choose a folder.
- You can also filter the file tree, double-click a file, or drop files into the window. Opening a path that already has a tab activates that tab. `Ctrl+N` creates an untitled text document.
- Use `F5` to reload from disk. Context-menu actions in the tree create, rename or move items to the trash. Paste an absolute path into the path field and press Enter.
- A clean buffer reloads after an external change. Unsaved edits stay in place with a warning. If a file was moved or deleted, use Save As to keep the buffer.

## 2. Text editing and read-only views

- Ordinary text up to 10 MiB opens in the editor. Larger text uses a chunked streaming read-only view.
- The streaming view supports scrolling, find and bookmarks, but has no replacement, column editing or formatting. Split very large files or use an external tool when you need to edit them.
- `Ctrl+Z` undoes, `Ctrl+Y` or `Ctrl+Shift+Z` redoes, `Insert` toggles insert/overwrite, and `Alt+Z` toggles wrapping. Format editable JSON/XML with `Ctrl+Shift+J`.
- The toolbar Edit/Read-only switch affects the current tab. Read-only mode in Edit applies to all tabs. A disk read-only file can still be changed in memory; use Save As if writing back fails.

## 3. Save, backups and crash recovery

- `Ctrl+S` saves the current content; an untitled document asks for a path. `Ctrl+Shift+S` saves a copy. File → Convert and Save As converts encoding, line endings or Unicode normalization into a new file.
- Autosave defaults to sidecar recovery snapshots, so timed snapshots do not rewrite the original file. Settings can switch to direct file writes, or set the interval to `0` to disable timed saves and snapshots.
- Auto-save on close is separate. When closing tabs or restoring a session with unsaved edits, choose Save, Discard or Cancel in the confirmation.
- After an abnormal exit, startup lists recoverable buffers. Restore selected items and review them before pressing `Ctrl+S`, or discard all. A snapshot may miss the last few keystrokes.
- Enable backups and choose the retention count in Settings; Tools opens the backup directory. Recovery snapshots and backups are separate mechanisms.

## 4. Rectangular selections and column editing

- In the source editor, press `Alt+C` or click Column, then drag a rectangle. `Alt+drag` also works when the switch is off.
- `Alt+Shift+Up/Down` grows the rectangle. In column mode, `Shift+Arrow` adjusts its edges. Press Esc to return to a single cursor.
- `Ctrl+C` copies the rectangle and pads short lines with spaces. Delete or Backspace removes the selected columns and shifts remaining text left.
- Right-click Column for fill, numbering, case conversion, alignment and sums. The context menu keeps the existing rectangle. Column editing is available in the source editor, not in instant rendering or the streaming view.

## 5. Find, replace and go to line

- `Ctrl+F` opens Find, `Ctrl+H` opens Replace, `F3`/`Shift+F3` moves to the next/previous match, and `Ctrl+G` jumps to a one-based line number.
- Find supports case sensitivity, whole words and regular expressions. Replace is available only for editable text; the streaming view provides find only.
- `Ctrl+Shift+F` searches files in a selected directory with filename globs. Click a result to open its line. Batch Replace List runs one find<Tab>replacement pair per line.
- Finding in instant rendering switches to source. Confirm the scope before running a batch operation and keep a backup when making broad replacements.

## 6. Four Markdown modes

- Use View → Markdown, the toolbar or the status-bar selector to choose source, rendered preview, split preview or instant rendering.
- Source, split and instant rendering allow edits; rendered preview is read-only. Click Edit in preview to return to source.
- Rendered and split previews are limited to 2 MiB; instant rendering to 4 MiB. Above those limits use source; files up to 10 MiB remain editable. Change the default mode in Settings.
- Heading outlines, GFM tables, MathJax, Mermaid and code highlighting are supported. Formatting controls and context menus provide common Markdown operations.
- Images can be stored locally. When image hosting is enabled, uploads and retrieval access the configured S3-compatible endpoint; credentials stay in session memory.

## 7. CSV, images, PDF and Office

- CSV/TSV opens as a read-only table with selectable delimiters; switch to source to edit. Above 256 MiB, use the streaming source view. Images support zoom, rotation, fit-to-window and 100% display.
- PDF provides continuous full-page rendering, page jumps, zoom and rotation. It is a canvas view without body-text selection, copying, full-text search or body-text screen-reader access; files above 100 MiB are blocked. Use the system viewer for failures or encrypted files.
- DOCX extracts body text and XLSX extracts worksheet data; XLSX provides a sheet selector. These views are read-only extraction and do not provide faithful Office layout editing, formula recalculation or write-back.

## 8. Compare two files

- Choose Tools → Compare Files and select two files, or Ctrl-click two files in the tree and compare from the context menu.
- Comparison offers side-by-side, unified and A/B views. Use difference navigation or `Alt+Left/Right` for the previous/next difference, and use the legend to filter categories.
- Comparison identifies added, removed and changed content as well as encoding, confusable characters, Unicode normalization, invisible characters, trailing spaces and BOM differences.
- Preview normalization repairs before saving to a new file. Compare again after either source changes; binary input is unsupported.

## 9. Tabs, bookmarks and sessions

- `Ctrl+Tab` switches by recent use; `Ctrl+PageUp/PageDown` follows tab order. `Ctrl+W` closes the current tab, `Ctrl+Shift+W` closes all, and `Ctrl+Shift+T` reopens the last closed tab.
- In supported text views, `Ctrl+F2` toggles a bookmark and `F2` goes to the next bookmark. The outline navigates headings and code symbols; Recent and Favorites reopen paths.
- File → Sessions saves named tab groups and restores them. Restoring replaces the current tab group, so handle unsaved changes first.
- A session stores tab state; it is not an independent backup of file contents.

## 10. Log Tail Board

- Open Tools → Log Tail Board and add files. Source colors distinguish multiple logs; click ERROR, WARN or INFO to hide or show a level.
- Pause or resume polling, or clear the displayed output. Clearing the board does not delete the source files.
- The board retains at most 2,000 rows and fetches at most 60 trailing lines per source update. Rapidly growing logs can skip intermediate lines.
- Open the original file for complete content.

## 11. Settings, appearance and fonts

- Press `Ctrl+,` to open Settings for theme, language, Markdown defaults, autosave and backups, read-only mode and close behavior.
- Use the toolbar size control, `Ctrl+wheel` or `Ctrl+=`/`Ctrl+-` for sizes 10–18; `Ctrl+0` resets to 12. View → Appearance also contains theme and text-size controls.
- Import a font through View → Appearance → Font → Import Local Font, or restore JetBrains Mono.
- Close behavior can ask, exit directly or minimize to the tray. Clear a remembered choice in Settings. Changing language preserves current edits.

## 12. Shortcuts and command palette

- Help → Keyboard Shortcuts lists registered keys by category. Search by a key combination, action or category. Availability depends on the current file, view and focus.
- `Ctrl+Shift+P` opens the command palette for more actions and file search. Dialogs, the palette and menus intercept global shortcuts.
- `Alt+F/E/S/V/T/H` opens File, Edit, Search, View, Tools and Help. Use arrows to navigate, Enter to run and Esc to close. `F11` maximizes or restores the window.
- Focus the document for editor shortcuts. Use Command on macOS and Ctrl elsewhere for Mod shortcuts; follow the keys shown in the in-app reference.
