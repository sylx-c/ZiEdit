//! commands —— Tauri command 薄层（架构编码约定：只做参数校验与转发）

pub mod compare;
pub mod csv;
pub mod misc;
pub mod ooxml;
pub mod recovery;
pub mod s3;
pub mod text;

use crate::error::ZiEditError;
use crate::kind_detect::{ViewRoute, detect, detect_fast};
use crate::store;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

const RECENT_MAX: usize = 50;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub len: u64,
    pub route: ViewRoute,
    pub language: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedInfo {
    pub path: String,
    pub len: u64,
    pub route: ViewRoute,
    pub language: Option<&'static str>,
    /// 修改时间（UNIX 毫秒；取不到为 0）
    pub modified_ms: u64,
    /// 文件系统只读位（001 规则 23 可写灯 / 编辑进入守卫）
    pub readonly: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabState {
    pub path: String,
    pub route: ViewRoute,
    pub language: Option<String>,
    pub scroll: f64,
    #[serde(default)]
    pub bookmarks: Vec<u64>,
    /// 草稿标签正文（走查 N ：重启不丢草稿；非草稿标签为 None）
    #[serde(default)]
    pub draft_content: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub tabs: Vec<TabState>,
    pub active_index: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentState {
    pub items: Vec<String>,
}

/// 最近/收藏条目视图（读取时用 metadata 现算 is_dir，不改存储格式）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavGroup {
    pub name: String,
    #[serde(default)]
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoritesState {
    #[serde(default)]
    pub items: Vec<String>,
    /// 收藏组（001 规则 20 v1.1；旧 favorites.json 无此字段，serde default 兼容）
    #[serde(default)]
    pub groups: Vec<FavGroup>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavGroupView {
    pub name: String,
    pub items: Vec<RecentEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoritesView {
    pub items: Vec<RecentEntry>,
    pub groups: Vec<FavGroupView>,
}

fn entry_of(path: &str) -> RecentEntry {
    RecentEntry {
        path: path.to_string(),
        is_dir: std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false),
    }
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, ZiEditError> {
    // ADR 014 开发态隔离：debug 构建落到 `-dev` 后缀目录，dev 调试不污染真实配置
    crate::paths::config_dir(app)
}

/// 持久化事务串行锁：recent/favorites/session 的「读旧值→改→
/// 原子写回」整体事务进程内串行。store::save 的 temp+rename 只保证单次写完整，
/// 不保证事务顺序——并发读改写会同读一份旧 JSON、各自写回丢更新；session_save
/// 并发落盘则可能旧请求晚于新请求 rename，重启恢复到旧会话。
/// 粒度选择：单一全局锁。这些命令都是用户操作级低频读写（点击星标/打开文件），
/// 临界区是微秒级 JSON 读改写，按 store 文件分锁只增加复杂度无收益。
/// 锁在 spawn_blocking 闭包内获取、随临界区结束释放，绝不跨 await。
fn persistence_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    match LOCK.lock() {
        Ok(g) => g,
        // 中毒只可能来自持锁临界区 panic：store::save 原子写不会留下半份文件，
        // 拒绝后续所有持久化比冒险继续更糟，故 poisoned 也放行
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// 目录列表（懒加载树用）：仅扩展名快速识别，不做内容 I/O。
/// async + spawn_blocking：大目录逐条 metadata 不冻结主线程
#[tauri::command]
pub async fn read_dir(path: String) -> Result<Vec<DirEntry>, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let rd = std::fs::read_dir(&path)
            .map_err(|e| ZiEditError::ctx("Failed to read directory", e))?;
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let meta = entry.metadata()?;
            let is_dir = meta.is_dir();
            let len = meta.len();
            let kind = if is_dir {
                crate::kind_detect::FileKind {
                    route: ViewRoute::Text,
                    language: None,
                    binary: false,
                }
            } else {
                detect_fast(&entry.path())
            };
            out.push(DirEntry {
                name,
                is_dir,
                len,
                route: kind.route,
                language: kind.language,
            });
        }
        // 目录优先，同类按名称（自然顺序，不区分大小写）；
        // sort_by_cached_key：小写 key 每条目只算一次，消除比较期重复分配
        out.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));
        Ok(out)
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// 打开文件：完整识别（含 NUL 嗅探）。
/// 最近文件登记由前端显式 recent_add 完成（性能整改：原先两侧各写一次 recent.json，双写去重）。
/// async + spawn_blocking：识别嗅探含内容读取，不冻结主线程
#[tauri::command]
pub async fn open_file(path: String) -> Result<OpenedInfo, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let meta = std::fs::metadata(&p).map_err(|e| ZiEditError::ctx("Cannot access file", e))?;
        if meta.is_dir() {
            return Err(ZiEditError::Msg("This is a directory".into()));
        }
        let kind = detect(&p).map_err(|e| ZiEditError::ctx("Detection failed", e))?;
        Ok(OpenedInfo {
            path,
            len: meta.len(),
            route: kind.route,
            language: kind.language,
            modified_ms: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            readonly: meta.permissions().readonly(),
        })
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// 轻量文件状态（001 规则 29 外部修改检测轮询用；无识别嗅探，纯 metadata）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatResult {
    pub len: u64,
    pub modified_ms: u64,
    pub is_dir: bool,
}

#[tauri::command]
pub fn file_stat(path: String) -> Result<FileStatResult, ZiEditError> {
    let meta = std::fs::metadata(&path)?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStatResult {
        len: meta.len(),
        modified_ms,
        is_dir: meta.is_dir(),
    })
}

/// 新建空文件（001 规则 28：树右键轻量管理；已存在报 EXISTS）
#[tauri::command]
pub fn file_create(path: String) -> Result<(), ZiEditError> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err(ZiEditError::Exists);
    }
    std::fs::File::create(&p).map(|_| ())?;
    Ok(())
}

/// 新建目录（001 规则 28；已存在报 EXISTS）
#[tauri::command]
pub fn dir_create(path: String) -> Result<(), ZiEditError> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err(ZiEditError::Exists);
    }
    std::fs::create_dir(&p)?;
    Ok(())
}

/// 重命名/移动（001 规则 28；目标已存在报 EXISTS，不覆盖）
#[tauri::command]
pub fn file_rename(from: String, to: String) -> Result<(), ZiEditError> {
    let src = PathBuf::from(&from);
    let dst = PathBuf::from(&to);
    if !src.exists() {
        return Err(ZiEditError::NotFound);
    }
    if dst.exists() {
        return Err(ZiEditError::Exists);
    }
    std::fs::rename(&src, &dst)?;
    Ok(())
}

/// 会话读写：draft_content 可达 10MB，序列化/解析移出主线程
#[tauri::command]
pub async fn session_load(app: AppHandle) -> SessionState {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = match config_dir(&app) {
            Ok(d) => d,
            Err(_) => return SessionState::default(),
        };
        store::load_or_default(&store::config_file(&dir, "session.json"))
    })
    .await
    .unwrap_or_else(|e| {
        log::warn!("session_load blocking task failed: {e}");
        SessionState::default()
    })
}

/// 保存与 recent/favorites 共用持久化事务锁：临界区覆盖整次原子写，
/// 落盘顺序=到达锁顺序（≈命令到达顺序）——并发保存时新会话必然晚到、
/// 晚落盘，不会出现旧请求晚于新请求落盘、重启恢复到旧会话。
#[tauri::command]
pub async fn session_save(app: AppHandle, session: SessionState) -> Result<(), ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = config_dir(&app)?;
        let _tx = persistence_lock();
        store::save(&store::config_file(&dir, "session.json"), &session)
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// 内部助手（非 IPC 命令）：recent_list 读取最近列表用。
/// 此前挂着 `#[tauri::command]` 却未登记到 generate_handler!，既误导前端以为可直接 invoke，
/// 又让「命令清单」与「已注册命令」两处口径不一；它不是对外接口，故去掉属性。
fn recent_load(app: AppHandle) -> RecentState {
    let dir = match config_dir(&app) {
        Ok(d) => d,
        Err(_) => return RecentState::default(),
    };
    store::load_or_default(&store::config_file(&dir, "recent.json"))
}

/// 最近列表（带 is_dir，读取时现算；失效路径保留，由前端展示置灰/清理）。
/// async + spawn_blocking：逐路径 metadata 不冻结主线程
#[tauri::command]
pub async fn recent_list(app: AppHandle) -> Vec<RecentEntry> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = recent_load(app);
        state.items.iter().map(|p| entry_of(p)).collect()
    })
    .await
    .unwrap_or_else(|e| {
        log::warn!("recent_list blocking task failed: {e}");
        Vec::new()
    })
}

#[tauri::command]
pub async fn recent_add(app: AppHandle, path: String) -> Result<(), ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = config_dir(&app)?;
        recent_add_tx(&dir, &path)
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// recent_add 事务核心（锁内读—改—写；纯目录参数便于并发单测）
fn recent_add_tx(dir: &std::path::Path, path: &str) -> Result<(), ZiEditError> {
    let _tx = persistence_lock();
    let file = store::config_file(dir, "recent.json");
    let mut recent: RecentState = store::load_or_default(&file);
    let path = normalize_recent_path(path);
    recent.items.retain(|p| normalize_recent_path(p) != path);
    recent.items.insert(0, path);
    recent.items.truncate(RECENT_MAX);
    store::save(&file, &recent)
}

/// Windows 两种分隔符指向同一路径；其他平台的反斜杠可为合法文件名，保持原样。
fn normalize_recent_path(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', std::path::MAIN_SEPARATOR_STR)
    } else {
        path.to_string()
    }
}

/// 最近：移除指定条目（单条/批量共用）
#[tauri::command]
pub async fn recent_remove(app: AppHandle, paths: Vec<String>) -> Result<(), ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = config_dir(&app)?;
        let _tx = persistence_lock();
        let file = store::config_file(&dir, "recent.json");
        let mut recent: RecentState = store::load_or_default(&file);
        recent.items.retain(|p| !paths.contains(p));
        store::save(&file, &recent)
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// 最近：清空（不影响收藏）。纯写也入队：与 add/remove 的读改写并发时，
/// 若不持锁，clear 的落盘可能被持有旧列表的并发事务写回覆盖。
#[tauri::command]
pub async fn recent_clear(app: AppHandle) -> Result<(), ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = config_dir(&app)?;
        let _tx = persistence_lock();
        store::save(
            &store::config_file(&dir, "recent.json"),
            &RecentState::default(),
        )
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

fn favorites_view(state: &FavoritesState) -> FavoritesView {
    FavoritesView {
        items: state.items.iter().map(|p| entry_of(p)).collect(),
        groups: state
            .groups
            .iter()
            .map(|g| FavGroupView {
                name: g.name.clone(),
                items: g.items.iter().map(|p| entry_of(p)).collect(),
            })
            .collect(),
    }
}

fn favorites_load_state(app: &AppHandle) -> Result<(PathBuf, FavoritesState), ZiEditError> {
    let dir = config_dir(app)?;
    let file = store::config_file(&dir, "favorites.json");
    let state: FavoritesState = store::load_or_default(&file);
    Ok((file, state))
}

/// 收藏列表（未分组 + 分组，均带 is_dir）。
/// async + spawn_blocking：逐路径 metadata 不冻结主线程
#[tauri::command]
pub async fn favorites_list(app: AppHandle) -> FavoritesView {
    tauri::async_runtime::spawn_blocking(move || match favorites_load_state(&app) {
        Ok((_, state)) => favorites_view(&state),
        Err(_) => favorites_view(&FavoritesState::default()),
    })
    .await
    .unwrap_or_else(|e| {
        log::warn!("favorites_list blocking task failed: {e}");
        favorites_view(&FavoritesState::default())
    })
}

/// 星标切换：未分组↔移除；在组内则从组内移除
#[tauri::command]
pub async fn favorites_toggle(app: AppHandle, path: String) -> Result<FavoritesView, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = config_dir(&app)?;
        favorites_toggle_tx(&dir, &path)
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// favorites_toggle 事务核心（锁内读—改—写；纯目录参数便于并发单测）
fn favorites_toggle_tx(dir: &std::path::Path, path: &str) -> Result<FavoritesView, ZiEditError> {
    let _tx = persistence_lock();
    let file = store::config_file(dir, "favorites.json");
    let mut fav: FavoritesState = store::load_or_default(&file);
    if let Some(pos) = fav.items.iter().position(|p| p == path) {
        fav.items.remove(pos);
    } else if let Some(g) = fav
        .groups
        .iter_mut()
        .find(|g| g.items.iter().any(|p| p == path))
    {
        g.items.retain(|p| p != path);
    } else {
        fav.items.push(path.to_string());
    }
    store::save(&file, &fav)?;
    Ok(favorites_view(&fav))
}

/// 新建收藏组（重名直接复用）
#[tauri::command]
pub async fn favorites_group_add(
    app: AppHandle,
    name: String,
) -> Result<FavoritesView, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _tx = persistence_lock();
        let (file, mut fav) = favorites_load_state(&app)?;
        if !name.is_empty() && !fav.groups.iter().any(|g| g.name == name) {
            fav.groups.push(FavGroup {
                name,
                items: Vec::new(),
            });
            store::save(&file, &fav)?;
        }
        Ok(favorites_view(&fav))
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// 解散收藏组：成员回到未分组（去重）
#[tauri::command]
pub async fn favorites_group_remove(
    app: AppHandle,
    name: String,
) -> Result<FavoritesView, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _tx = persistence_lock();
        let (file, mut fav) = favorites_load_state(&app)?;
        if let Some(pos) = fav.groups.iter().position(|g| g.name == name) {
            let g = fav.groups.remove(pos);
            for p in g.items {
                if !fav.items.contains(&p) {
                    fav.items.push(p);
                }
            }
            store::save(&file, &fav)?;
        }
        Ok(favorites_view(&fav))
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// 移动收藏条目到组（group=None 表示移回未分组）
#[tauri::command]
pub async fn favorites_move(
    app: AppHandle,
    path: String,
    group: Option<String>,
) -> Result<FavoritesView, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _tx = persistence_lock();
        let (file, mut fav) = favorites_load_state(&app)?;
        fav.items.retain(|p| p != &path);
        for g in &mut fav.groups {
            g.items.retain(|p| p != &path);
        }
        match group {
            Some(name) => {
                let g = fav
                    .groups
                    .iter_mut()
                    .find(|g| g.name == name)
                    .ok_or_else(|| {
                        ZiEditError::Msg(format!("Favorite group not found: {}", name))
                    })?;
                g.items.push(path);
            }
            None => fav.items.push(path),
        }
        store::save(&file, &fav)?;
        Ok(favorites_view(&fav))
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}
pub mod search;

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ZiEdit-mod-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Windows 不同入口的路径分隔符不同，入列后仍只能保留一条。
    #[cfg(windows)]
    #[test]
    fn recent_add_normalizes_path_separators() {
        let dir = temp_dir("recent-separators");
        recent_add_tx(&dir, "E:/x/y.md").unwrap();
        recent_add_tx(&dir, r"E:\x\y.md").unwrap();
        let state: RecentState = store::load_or_default(&store::config_file(&dir, "recent.json"));
        assert_eq!(state.items, vec![r"E:\x\y.md"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// ：并发 recent_add 不丢更新——读改写整体事务串行锁回归
    /// （修前两个并发请求同读旧 JSON 各自写回，丢对方条目）
    #[test]
    fn concurrent_recent_add_keeps_all() {
        let dir = temp_dir("recent-concurrent");
        let n = 32; // < RECENT_MAX(50)，排除截断干扰
        std::thread::scope(|s| {
            for i in 0..n {
                let dir = &dir;
                s.spawn(move || recent_add_tx(dir, &format!("f{i}.txt")).unwrap());
            }
        });
        let state: RecentState = store::load_or_default(&store::config_file(&dir, "recent.json"));
        assert_eq!(state.items.len(), n, "并发 recent_add 不得丢更新");
        for i in 0..n {
            assert!(state.items.contains(&format!("f{i}.txt")));
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// ：并发 favorites_toggle 不丢更新（每条目恰好切换一次，全部入列）
    #[test]
    fn concurrent_favorites_toggle_keeps_all() {
        let dir = temp_dir("favorites-concurrent");
        let n = 16;
        std::thread::scope(|s| {
            for i in 0..n {
                let dir = &dir;
                s.spawn(move || favorites_toggle_tx(dir, &format!("g{i}.txt")).unwrap());
            }
        });
        let fav: FavoritesState =
            store::load_or_default(&store::config_file(&dir, "favorites.json"));
        assert_eq!(fav.items.len(), n, "并发 favorites_toggle 不得丢更新");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
