// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
pub mod commands;
pub mod compare;
pub mod encoding;
pub mod error;
pub mod file_engine;
pub mod kind_detect;
pub mod ooxml;
pub mod paths;
pub mod store;
pub mod sysicon;

use commands::text::TextRegistry;
use error::ZiEditError;
use tauri::{Emitter, Manager};

fn allowed_navigation(url: &tauri::Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    matches!(
        (url.scheme(), url.host_str(), url.port()),
        ("tauri", Some("localhost"), None) | ("http" | "https", Some("tauri.localhost"), None)
    ) || (cfg!(debug_assertions)
        && matches!(
            (url.scheme(), url.host_str(), url.port()),
            ("http", Some("localhost" | "127.0.0.1"), Some(1420))
        ))
}

/// 从参数表筛出可作为打开目标的文件路径（001 规则 10）：跳过开关项；
/// 支持 `path:line` 尾缀（剥尾冒号+数字再判存在，Windows 盘符 C:\ 不受尾缀数字影响）。
/// 启动命令行与单实例转发的 argv 共用（批 F #6）。
fn filter_file_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter(|a| {
            if std::path::Path::new(a).exists() {
                return true;
            }
            match a.rsplit_once(':') {
                Some((p, n)) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => {
                    std::path::Path::new(p).exists()
                }
                _ => false,
            }
        })
        .collect()
}

/// 放行 asset 协议目录（H-5 T9：协议 scope 自 `**` 收紧为空，运行期按打开的文件目录动态放行）。
/// 前端在打开图片/Markdown（本地图片解析）前调用。
#[tauri::command]
fn allow_asset_dir(app: tauri::AppHandle<tauri::Wry>, dir: String) -> Result<(), ZiEditError> {
    app.asset_protocol_scope()
        .allow_directory(&dir, false)
        .map_err(|e| ZiEditError::Msg(format!("allow asset dir: {e}")))
}

#[tauri::command]
fn allow_asset_file(app: tauri::AppHandle<tauri::Wry>, path: String) -> Result<(), ZiEditError> {
    let path = std::fs::canonicalize(&path)
        .map_err(|e| ZiEditError::Msg(format!("resolve asset file: {e}")))?;
    app.asset_protocol_scope()
        .allow_file(path)
        .map_err(|e| ZiEditError::Msg(format!("allow asset file: {e}")))
}

/// 打开日志目录（H-4 正式感外壳）：OS 日志目录（app_log_dir），缺失则先建；经系统文件管理器展示。
/// Rust 侧直接调 opener（不经前端 capability scope——目录路径运行期才定）。
#[tauri::command]
fn open_log_dir(app: tauri::AppHandle<tauri::Wry>) -> Result<(), ZiEditError> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| ZiEditError::Msg(format!("app_log_dir: {e}")))?;
    std::fs::create_dir_all(&dir).map_err(|e| ZiEditError::Msg(format!("create logs dir: {e}")))?;
    tauri_plugin_opener::open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| ZiEditError::Msg(format!("open log dir: {e}")))
}

/// 用系统默认程序打开（001 规则 26）：P0-3/RL-1 根修——任意用户路径走前端插件
/// open-path 必被 capability scope 拒（只放行 $RESOURCE 随包声明），三入口此前全灭；
/// 与 open_log_dir 同一先例：Rust 侧直调，权限面保持收紧（前端不经手 open-path 权限）。
#[tauri::command]
fn open_with_default(path: String) -> Result<(), ZiEditError> {
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|e| ZiEditError::Msg(format!("open with default: {e}")))
}

/// 冷启动 CLI 文件拉取（P5-6）：前端监听就绪后取走 pending（一次性，取后清空）
#[tauri::command]
fn cli_take_pending(pending: tauri::State<'_, std::sync::Mutex<Vec<String>>>) -> Vec<String> {
    let mut p = pending.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *p)
}

/// 在系统文件管理器中显示（001 规则 26「定位」，reveal 与 open 同理由走 Rust 侧直调）
#[tauri::command]
fn reveal_in_dir(path: String) -> Result<(), ZiEditError> {
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|e| ZiEditError::Msg(format!("reveal in dir: {e}")))
}

/// 托盘「显示主窗」：show + unminimize + set_focus（菜单项与左键单击共用）
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 系统托盘（ADR 015）：常驻「显示 ZiEdit / 退出」两项菜单，左键单击显示主窗；
/// 图标复用 `default_window_icon()`（自研源图产物，零新资产）；菜单文案按 settings.language。
/// **「退出」只 `emit("ziedit://tray-quit")` 交前端**——与点 × 走同一退出判决
/// （脏文件清单 / 快照清理 / destroy 全在前端收口，Rust 侧绝不直接 exit，防第二判决点）。
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let zh = commands::misc::settings_load(app.clone())
        .get("language")
        .and_then(|v| v.as_str())
        .is_some_and(|s| s.starts_with("zh"));
    let show_i = MenuItem::with_id(
        app,
        "show",
        if zh { "显示 ZiEdit" } else { "Show ZiEdit" },
        true,
        None::<&str>,
    )?;
    let quit_i = MenuItem::with_id(
        app,
        "quit",
        if zh { "退出" } else { "Quit" },
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("ZiEdit")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => {
                // 单一判决：交前端走与点 × 完全相同的退出流
                if let Err(e) = app.emit("ziedit://tray-quit", ()) {
                    log::warn!("[ZiEdit] tray-quit emit 失败: {e}");
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // 运行日志（H-4）：OS 日志目录 ZiEdit.log，单文件轮转 1MB、本地时区时间戳；
        // panic=abort 下日志是"闪退"问题的唯一线索，关键路径 log::warn!
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir { file_name: None },
                )])
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .max_file_size(1_000_000)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(TextRegistry::default())
        .manage(commands::csv::CsvRegistry::default())
        .manage(commands::ooxml::OoxmlRegistry::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_dir,
            commands::open_file,
            commands::file_stat,
            commands::file_create,
            commands::dir_create,
            commands::file_rename,
            commands::session_load,
            commands::session_save,
            commands::recent_list,
            commands::recent_add,
            commands::recent_remove,
            commands::recent_clear,
            commands::favorites_list,
            commands::favorites_toggle,
            commands::favorites_group_add,
            commands::favorites_group_remove,
            commands::favorites_move,
            allow_asset_dir,
            allow_asset_file,
            open_log_dir,
            open_with_default,
            reveal_in_dir,
            cli_take_pending,
            commands::text::text_open,
            commands::text::text_lines,
            commands::text::text_line_segment,
            commands::text::text_find,
            commands::text::text_refresh,
            commands::text::text_close,
            commands::misc::text_read_all,
            commands::misc::text_save,
            commands::misc::format_json,
            commands::misc::format_xml,
            commands::misc::checksum,
            commands::misc::delete_to_trash,
            commands::search::find_in_files,
            commands::search::find_cancel,
            commands::misc::named_sessions_load,
            commands::misc::named_sessions_save,
            commands::misc::backup_dir,
            commands::misc::font_read,
            commands::csv::csv_records,
            commands::ooxml::docx_open,
            commands::ooxml::docx_lines,
            commands::ooxml::pdf_open,
            commands::ooxml::pdf_lines,
            commands::ooxml::xlsx_open,
            commands::ooxml::xlsx_records,
            commands::ooxml::ooxml_close,
            commands::misc::settings_load,
            commands::misc::settings_save,
            commands::compare::compare_open,
            commands::compare::compare_detail,
            commands::compare::normalize_save,
            commands::compare::normalize_preview,
            commands::compare::encode_convert_save,
            commands::recovery::recovery_snapshot,
            commands::recovery::recovery_list,
            commands::recovery::recovery_read,
            commands::recovery::recovery_discard,
            commands::recovery::recovery_clear,
            // 图床网络例外（009 / ADR 016）：仅此两条出网命令 + 本地落盘辅助
            commands::s3::s3_put_object,
            commands::s3::s3_get_image,
            commands::misc::image_write,
            sysicon::tree_file_icon,
        ])
        .manage(std::sync::Mutex::new(Vec::<String>::new()))
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 单实例转发（批 F #6）：第二个实例把参数转发给既有实例后退出。
            // P5-7（审计 2026-10-17）：argv 含 argv[0]=自身 exe 路径且必然存在 → 过筛被当
            // 文件转发，运行实例会把 ziedit.exe 自身当文件打开（session 实证）。与冷启动路径对齐 skip(1)。
            let files = filter_file_args(argv.into_iter().skip(1));
            if !files.is_empty() {
                let _ = app.emit("cli-open", files);
            }
        }))
        .setup(|app| {
            log::info!("ZiEdit {} starting", env!("CARGO_PKG_VERSION"));
            // 主窗口编程创建（007 v0.11 R1）：零网络红线最后防线——on_navigation 钩子只能
            // 在 webview 构建期挂上（Builder 无此 API），故自 tauri.conf.json 迁出窗口配置。
            // 只允许应用自身地址（tauri:// 与本地 dev 服务器），任何离开的导航一律拒绝
            //（外链经 opener 交系统浏览器；渲染区点击另有拦截，此处兜住 window.open 等残余路径）
            let wb = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("ZiEdit")
            .inner_size(1280.0, 832.0)
            .min_inner_size(960.0, 600.0)
            .decorations(false)
            .center()
            .on_navigation(|url| {
                let allowed = allowed_navigation(url);
                if !allowed {
                    // URL 的路径、参数和片段可能携带凭据，不写入日志。
                    log::warn!("[ZiEdit] blocked external navigation");
                }
                allowed
            });
            // ADR 014 开发态隔离：debug 构建的 WebView 数据目录（localStorage/Cookie/缓存）
            // 指到 exe 旁的 webview-dev\，dev 调试的界面状态（如欢迎页一次性标记）不落进安装版
            #[cfg(debug_assertions)]
            let wb = wb.data_directory(
                std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|d| d.join("webview-dev")))
                    .unwrap_or_else(|| std::env::temp_dir().join("ZiEdit-webview-dev")),
            );
            wb.build()?;
            // 反馈 16 防御性修复（P0-3 探测结论：本机 100% 缩放下原生 HWND 与 DOM 布局均随最大化
            // 正确跟随、无法复现；用户症状「内容停在旧宽度、右侧大片留白」指向特定 DPI/缩放配置
            // 下 WebView2 子窗口不随 WM_SIZE 同步的已知类问题）——每次窗口 Resized 主动把 webview
            // 边界钉回窗口内尺寸：幂等，正常路径无副作用，失步路径下一次 Resized 即纠正。
            if let Some(ww) = app.get_webview_window("main") {
                // WebviewWindow: AsRef<Webview> —— 取内层 webview 句柄（Manager::get_webview 需 unstable）
                let (w2, wv2) = (ww.clone(), ww.as_ref().clone());
                ww.on_window_event(move |e| {
                    if let tauri::WindowEvent::Resized(_) = e
                        && let Ok(sz) = w2.inner_size()
                    {
                        let _ = wv2.set_bounds(tauri::Rect {
                            position: tauri::Position::Physical(tauri::PhysicalPosition::new(0, 0)),
                            size: tauri::Size::Physical(sz),
                        });
                    }
                });
            }
            // 崩溃恢复存活标记（ADR 012 v2）：启动即写，正常退出删除；
            // 启动时仍在 = 上次异常退出，前端据 recovery_list 提示恢复
            commands::recovery::write_marker(app.handle());
            // P3-25：清扫上次崩溃留下的原子写临时文件（*.json.tmp）
            commands::recovery::sweep_tmp(app.handle());
            // 系统托盘（ADR 015）：失败仅告警降级（Linux 无托盘环境不影响主流程）
            if let Err(e) = build_tray(app.handle()) {
                log::warn!("[ZiEdit] 托盘创建失败（降级为无托盘运行）: {e}");
            }
            // 命令行打开（001 规则 10）：ZiEdit <file...>，支持 `path:line` 尾缀（前端解析行号）。
            // P5-6（审计 2026-10-17）：修前 setup 内即 emit——webview 页面 JS 未执行、前端监听
            // 未注册，Tauri 事件对未注册监听直接丢弃，冷启动文件静默丢失（真机 session 0 标签实证；
            // 单实例二次转发路径因前端已就绪而正常）。改**拉取式握手**：暂存 pending，前端
            // onCliOpen 注册完成后 invoke cli_take_pending 拉取；单实例转发仍走事件（彼时已就绪）。
            let files = filter_file_args(std::env::args().skip(1));
            log::info!("[ZiEdit] cli cold-start file count: {}", files.len());
            if !files.is_empty() {
                *app.state::<std::sync::Mutex<Vec<String>>>()
                    .lock()
                    .map_err(|e| e.to_string())? = files;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 正常退出：清空恢复快照并删存活标记（异常退出两样都留在盘上）
            if let tauri::RunEvent::ExitRequested { .. } = event {
                commands::recovery::shutdown_cleanup(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::filter_file_args;

    #[test]
    fn navigation_requires_exact_origin() {
        for url in [
            "http://tauri.localhost/index.html",
            "tauri://localhost/index.html",
            "about:blank",
        ] {
            assert!(super::allowed_navigation(&tauri::Url::parse(url).unwrap()));
        }
        for url in [
            "http://tauri.localhost.example/",
            "http://tauri.localhost@evil.invalid/",
            "http://tauri.localhost:9999/",
            "http://localhost:14200/",
            "https://example.com/",
            "tauri://evil/index.html",
        ] {
            assert!(
                !super::allowed_navigation(&tauri::Url::parse(url).unwrap()),
                "{url}"
            );
        }
    }

    /// P5-7（审计 2026-10-17）：argv[0]=自身 exe 且必然存在——存在性过滤**挡不住它**，
    /// 只能靠调用点 skip(1) 剔除；本断言证明 skip(1) 是必要的（去掉它 exe 会被当文件转发）。
    /// 两调用点（冷启动 std::env::args / 单实例 argv）的 skip(1) 对齐由前端契约锁兜底
    /// （tests/ac-001-cli-open.test.ts）。
    #[test]
    fn filter_file_args_keeps_existing_exe_so_skip1_is_load_bearing() {
        let exe = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(filter_file_args([exe.clone()]), vec![exe.clone()]);
        // 调用点语义：skip(1) 后 exe 消失
        assert!(filter_file_args([exe].into_iter().skip(1)).is_empty());
    }

    /// 语义：开关项与不存在的路径剔除；`path:line` 尾缀按剥尾后存在性判定（001 规则 10）
    #[test]
    fn filter_file_args_flags_nonexistent_and_line_suffix() {
        let tmp = std::env::temp_dir();
        let a = tmp.join("ziedit_filter_test_a.txt");
        std::fs::write(&a, b"x").unwrap();
        let a_s = a.to_string_lossy().to_string();
        let out = filter_file_args([
            "--flag".to_string(),
            a_s.clone(),
            "ziedit_filter_test_ghost.txt".to_string(),
            format!("{a_s}:12"),
            "E:\\ghost\\no.txt:3".to_string(),
        ]);
        assert_eq!(out, vec![a_s.clone(), format!("{a_s}:12")]);
        let _ = std::fs::remove_file(&a);
    }
}
