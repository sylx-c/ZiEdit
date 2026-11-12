//! recovery —— 崩溃恢复：脏缓冲快照 + 存活标记（ADR 012 v2，002 规则 29）。
//! 快照 = 未保存编辑缓冲的独立落盘（区别于自动保存写原文件、备份存旧版本）；
//! 存活标记随启动写入、正常退出删除；标记与有效快照同时存在才提示恢复。
use crate::error::ZiEditError;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

/// 单个恢复快照（磁盘 JSON）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRecord {
    /// 标签键：真实文件路径或 draft://N
    pub key: String,
    pub content: String,
    /// 基线：快照时的磁盘 mtime/len（恢复时对比提示"磁盘已变化"）
    pub mtime: u64,
    pub len: u64,
    pub draft: bool,
    pub ts: u64,
}

/// recovery_list 返回的轻量条目（不含内容）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryItem {
    pub key: String,
    pub ts: u64,
    pub bytes: u64,
    pub draft: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryList {
    /// 有异常退出标记且存在可恢复快照（空标记不触发恢复）
    pub crashed: bool,
    pub items: Vec<RecoveryItem>,
}

fn recovery_dir(app: &tauri::AppHandle) -> PathBuf {
    // ADR 014 开发态隔离：与 config_dir 同源（debug → `-dev` 后缀目录）
    let base =
        crate::paths::config_dir(app).unwrap_or_else(|_| std::env::temp_dir().join("ZiEdit"));
    // 复用设置落盘入口，每次解析以覆盖后台读取/丢弃任务，不改变 IPC 参数。
    let settings = super::misc::settings_load(app.clone());
    recovery_dir_for(&base, settings.get("snapshotDir").and_then(|v| v.as_str()))
}

fn recovery_dir_for(base: &std::path::Path, setting: Option<&str>) -> PathBuf {
    match setting.filter(|s| !s.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => base.join("recovery"),
    }
}

fn marker_path(app: &tauri::AppHandle) -> Result<PathBuf, ZiEditError> {
    Ok(marker_path_for(&crate::paths::config_dir(app)?))
}

fn marker_path_for(base: &std::path::Path) -> PathBuf {
    base.join("recovery").join("live.marker")
}

fn write_marker_at(path: &std::path::Path) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        prepare_snapshot_dir(dir, true)?;
    }
    std::fs::write(path, b"")
}

/// 仅收紧应用自管目录；已有用户目录可能承载其它文件，不能修改其权限。
fn prepare_snapshot_dir(dir: &std::path::Path, managed: bool) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let existed = dir.try_exists()?;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        if managed || !existed {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = managed;
        std::fs::create_dir_all(dir)?;
    }
    Ok(())
}

fn write_snapshot_in(
    dir: &std::path::Path,
    managed: bool,
    rec: &RecoveryRecord,
) -> std::io::Result<()> {
    if rec.content.len() > SNAP_MAX_BYTES {
        return Err(std::io::Error::other("Snapshot exceeds size limit"));
    }
    prepare_snapshot_dir(dir, managed)?;
    let path = dir.join(format!("{}.{}.json", key_tag(&rec.key), rec.ts));
    let protected = encode_snapshot(&serde_json::to_vec(rec)?)?;
    crate::store::atomic_write_private(&path, &protected)?;
    // 只有新副本完整落盘后才淘汰旧副本。
    recycle_old(dir, &rec.key, &path, rec.ts).map_err(|e| std::io::Error::other(e.to_string()))
}

/// 同 key 快照的文件名 tag（64 位哈希，16 位十六进制）
fn key_tag(key: &str) -> String {
    let mut h = DefaultHasher::new();
    key.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// 严格快照文件名匹配 `{tag}.{ts}.json`：命中返回 ts。
/// 不匹配该模式（遗留命名如测试用 snapshot.json、live.marker、临时文件等）返回 None——
/// 按 tag 回收/查找/丢弃均不触碰这些文件，仍由 cap_total 总量兜底。
fn snap_ts_of(name: &str, tag: &str) -> Option<u64> {
    let rest = name.strip_suffix(".json")?;
    let (t, ts) = rest.split_once('.')?;
    if t == tag { ts.parse().ok() } else { None }
}

/// 是否为严格快照命名 `{16位十六进制}.{数字}.json`（与具体 tag 无关），
/// 用于区分现行 tag 命名快照与遗留/无关 .json 文件。
fn is_tag_named(name: &str) -> bool {
    let Some(rest) = name.strip_suffix(".json") else {
        return false;
    };
    let Some((t, ts)) = rest.split_once('.') else {
        return false;
    };
    t.len() == 16
        && t.bytes().all(|b| b.is_ascii_hexdigit())
        && !ts.is_empty()
        && ts.bytes().all(|b| b.is_ascii_digit())
}

/// 仅本应用快照命名（`{16hex}.{ts}.json` 及其 `.tmp` 中间态）可被清理/淘汰/清扫。
/// F2（2026-10 审计）安全修复：自定义快照目录可能是用户任意文件夹——
/// 退出清理/总量淘汰/清空/清扫若按 `.json` 后缀一揽子删除，会误删用户自己的 JSON 文件。
fn owned_snapshot_name(name: &str) -> bool {
    is_tag_named(name) || name.strip_suffix(".tmp").is_some_and(is_tag_named)
}

fn now_ms() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut previous = LAST.load(Ordering::Relaxed);
    loop {
        let next = now.max(previous.saturating_add(1));
        match LAST.compare_exchange_weak(previous, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(current) => previous = current,
        }
    }
}

/// 启动即写存活标记（lib.rs setup 调用）
pub fn write_marker(app: &tauri::AppHandle) {
    if let Ok(path) = marker_path(app) {
        let _ = write_marker_at(&path);
    }
}

/// 启动清扫残留临时文件（P3-25 灾备补强）：atomic_write 中途崩溃会留下 `*.json.tmp`，
/// 启动时只清掉本应用的中间态，保留正式快照供崩溃恢复使用。
pub fn sweep_tmp(app: &tauri::AppHandle) {
    let dir = recovery_dir(app);
    sweep_tmp_in(&dir);
}

fn sweep_tmp_in(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.strip_suffix(".tmp").is_some_and(is_tag_named) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// 正常退出：清空快照 + 删标记（lib.rs ExitRequested 调用；前端 recovery_clear 同步清快照）
pub fn shutdown_cleanup(app: &tauri::AppHandle) {
    let dir = recovery_dir(app);
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name();
            if owned_snapshot_name(&name.to_string_lossy()) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    if let Ok(path) = marker_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

/// 快照写入结果（P3-25 灾备可观测）：前端据此在状态栏轻提示，不再静默丢保护
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotOutcome {
    /// 因超限（>10MB，与编辑缓冲上限一致）未入快照
    pub skipped: bool,
    /// 本次因总量兜底被淘汰的旧快照数
    pub evicted: u64,
}

/// 写入一条快照（覆盖同键旧快照）；内容 ≤10MB，超限跳过（与编辑缓冲上限一致）并如实回报
#[tauri::command]
pub async fn recovery_snapshot(
    app: tauri::AppHandle,
    key: String,
    content: String,
    mtime: u64,
    len: u64,
    draft: bool,
) -> Result<SnapshotOutcome, ZiEditError> {
    if content.len() > SNAP_MAX_BYTES {
        return Ok(SnapshotOutcome {
            skipped: true,
            evicted: 0,
        }); // 超限不入快照（不会出现在恢复列表）
    }
    // JSON 序列化、原子写和旧快照扫描都可能涉及多 MB 文本与磁盘 I/O，移出 Tokio
    // 命令线程，避免快照高峰拖住其它命令。前端仍按调用顺序串行提交快照。
    tauri::async_runtime::spawn_blocking(move || {
        let ts = now_ms();
        let rec = RecoveryRecord {
            key: key.clone(),
            content,
            mtime,
            len,
            draft,
            ts,
        };
        // 存活标记只属于应用配置目录，不随用户快照目录切换。
        let marker = marker_path(&app)?;
        write_marker_at(&marker)?;
        let dir = recovery_dir(&app);
        write_snapshot_in(&dir, marker.parent() == Some(dir.as_path()), &rec)?;
        Ok(SnapshotOutcome {
            skipped: false,
            evicted: cap_total(&app),
        })
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// 回收同 key 旧快照（覆盖写入路径）：按文件名 tag 匹配删除，零内容读取。
/// 已接受的权衡（BE1）：64 位哈希碰撞（≈2^-64）可能误删他 key 的旧快照，
/// 由 cap_total 总量兜底；替代的是原先逐文件 read_to_string + 全量 JSON 解析
/// （快照可达 10MB，高峰期逐份解析拖住整个命令线程）。
/// 只删 ts 不晚于刚写入者的同 tag 文件；不匹配严格模式的遗留文件不动。
fn recycle_old(
    dir: &std::path::Path,
    key: &str,
    keep: &std::path::Path,
    ts: u64,
) -> Result<(), ZiEditError> {
    let tag = key_tag(key);
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in rd.flatten() {
        if entry.path() == keep {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if snap_ts_of(&name, &tag).is_some_and(|old| old <= ts) {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

/// 快照总量兜底：超过 64 个文件时按时间淘汰最旧；返回本次淘汰数（0=未触发）。
/// F2（2026-10 审计）：仅严格 tag 命名参与淘汰——自定义快照目录下用户的无关 .json 绝不删；
/// 遗留命名（无 tag/无数字时间戳）不再参与淘汰（未发布期无存量，安全优先）。
fn cap_total(app: &tauri::AppHandle) -> u64 {
    let dir = recovery_dir(app);
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let files: Vec<(u64, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !owned_snapshot_name(&name) {
                return None;
            }
            let ts = name
                .trim_end_matches(".json")
                .rsplit('.')
                .next()
                .and_then(|t| t.parse().ok())?;
            Some((ts, e.path()))
        })
        .collect();
    let victims = prune_oldest(files, SNAP_MAX_FILES);
    let mut n = 0;
    for p in victims {
        if std::fs::remove_file(p).is_ok() {
            n += 1;
        }
    }
    n as u64
}

/// 快照文件数上限（超出按时间淘汰最旧）
const SNAP_MAX_FILES: usize = 64;
/// 单条快照内容上限（与编辑缓冲上限一致）
const SNAP_MAX_BYTES: usize = 10 * 1024 * 1024;

const ENCRYPTED_MAGIC: &[u8] = b"ZEDP1\0";
// JSON escaping can expand each content byte sixfold; reserve metadata and DPAPI overhead.
const SNAP_MAX_SERIALIZED: usize = SNAP_MAX_BYTES * 6 + 1024 * 1024;
const SNAP_MAX_DISK: usize = SNAP_MAX_SERIALIZED + 64 * 1024;
const DECRYPT_ERROR: &str = "无法解密恢复快照（数据损坏或不属于当前 Windows 用户/计算机）";

#[cfg(windows)]
fn dpapi(bytes: &[u8], protect: bool) -> std::io::Result<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(std::io::Error::other)?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input lives through the synchronous call; optional arguments are null.
    // No LOCAL_MACHINE flag: DPAPI binds the ciphertext to the current user.
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(std::io::Error::other(if protect {
            format!("无法加密恢复快照：{}", std::io::Error::last_os_error())
        } else {
            DECRYPT_ERROR.to_string()
        }));
    }
    // SAFETY: successful DPAPI returns cbData readable bytes allocated by LocalAlloc.
    // Copy before freeing, including the zero-length case (no null slice construction).
    let result = if output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec()
    };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}

/// 会话与命名会话共用快照的 DPAPI 封装。Unix 保持明文，不写魔数。
pub(crate) fn seal_persisted(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    encode_snapshot(bytes)
}

/// 没有魔数的旧 JSON 原样返回。魔数存在但解密失败时返回错误，调用方不得写回。
pub(crate) fn open_persisted(bytes: &[u8], max_plain: usize) -> std::io::Result<Vec<u8>> {
    if !bytes.starts_with(ENCRYPTED_MAGIC) {
        if bytes.len() > max_plain {
            return Err(std::io::Error::other(
                "persisted payload exceeds size limit",
            ));
        }
        return Ok(bytes.to_vec());
    }
    let fail = || std::io::Error::other(DECRYPT_ERROR);
    let header = ENCRYPTED_MAGIC.len();
    let length_bytes = bytes.get(header..header + 4).ok_or_else(fail)?;
    let length = u32::from_le_bytes(length_bytes.try_into().map_err(|_| fail())?) as usize;
    if length > max_plain {
        return Err(fail());
    }
    #[cfg(windows)]
    {
        let plaintext = dpapi(&bytes[header + 4..], false)?;
        if plaintext.len() != length {
            return Err(fail());
        }
        Ok(plaintext)
    }
    #[cfg(not(windows))]
    {
        Err(fail())
    }
}

#[derive(Debug)]
pub(crate) enum SealedJson<T> {
    Missing,
    Value(T),
    Unreadable,
}

/// 只读。解密失败或加密正文无法解析时不改名、不覆盖。
pub(crate) fn read_sealed_json<T: serde::de::DeserializeOwned>(
    path: &std::path::Path,
    max_plain: usize,
) -> SealedJson<T> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return SealedJson::Missing,
        Err(_) => return SealedJson::Unreadable,
    };
    match open_persisted(&bytes, max_plain) {
        Err(_) => SealedJson::Unreadable,
        Ok(plain) => match serde_json::from_slice(&plain) {
            Ok(value) => SealedJson::Value(value),
            Err(_) if bytes.starts_with(ENCRYPTED_MAGIC) => SealedJson::Unreadable,
            Err(_) => {
                crate::store::quarantine(path);
                SealedJson::Missing
            }
        },
    }
}

pub(crate) fn write_sealed_json<T: Serialize>(
    path: &std::path::Path,
    value: &T,
    limit: usize,
) -> Result<(), ZiEditError> {
    let json = serde_json::to_vec_pretty(value)?;
    crate::store::check_size(json.len(), limit)?;
    let stored = seal_persisted(&json)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::store::atomic_write_private(path, &stored)?;
    Ok(())
}

fn encode_snapshot(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    #[cfg(windows)]
    {
        let ciphertext = dpapi(bytes, true)?;
        let mut encoded = ENCRYPTED_MAGIC.to_vec();
        encoded.extend_from_slice(
            &u32::try_from(bytes.len())
                .map_err(std::io::Error::other)?
                .to_le_bytes(),
        );
        encoded.extend_from_slice(&ciphertext);
        Ok(encoded)
    }
    #[cfg(not(windows))]
    {
        // Unix 文件与目录权限在写入入口强制；不伪称明文受到加密保护。
        Ok(bytes.to_vec())
    }
}

fn decode_snapshot(bytes: Vec<u8>) -> std::io::Result<String> {
    if !bytes.starts_with(ENCRYPTED_MAGIC) {
        return String::from_utf8(bytes).map_err(std::io::Error::other);
    }
    let fail = || std::io::Error::other(DECRYPT_ERROR);
    let header = ENCRYPTED_MAGIC.len();
    let length = bytes.get(header..header + 4).ok_or_else(fail)?;
    let length = u32::from_le_bytes(length.try_into().map_err(|_| fail())?) as usize;
    if length > SNAP_MAX_SERIALIZED {
        return Err(fail());
    }
    #[cfg(windows)]
    {
        let plaintext = dpapi(&bytes[header + 4..], false)?;
        if plaintext.len() != length {
            return Err(fail());
        }
        String::from_utf8(plaintext).map_err(|_| fail())
    }
    #[cfg(not(windows))]
    {
        Err(fail())
    }
}

fn read_snapshot_bounded(path: &std::path::Path) -> std::io::Result<String> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    if file.metadata()?.len() > SNAP_MAX_DISK as u64 {
        return Err(std::io::Error::other("Snapshot exceeds size limit"));
    }
    let mut bytes = Vec::new();
    file.take(SNAP_MAX_DISK as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > SNAP_MAX_DISK {
        return Err(std::io::Error::other("Snapshot exceeds size limit"));
    }
    decode_snapshot(bytes)
}

/// 纯函数：保留时间最新的 keep 条，返回应淘汰的路径（最旧优先）
fn prune_oldest(mut files: Vec<(u64, PathBuf)>, keep: usize) -> Vec<PathBuf> {
    if files.len() <= keep {
        return Vec::new();
    }
    files.sort_by_key(|(ts, _)| *ts);
    let drop = files.len() - keep;
    files.into_iter().take(drop).map(|(_, p)| p).collect()
}

#[tauri::command]
pub async fn recovery_list(app: tauri::AppHandle) -> Result<RecoveryList, ZiEditError> {
    let dir = recovery_dir(&app);
    let marker = marker_path(&app)?;
    // 崩溃恢复路径全量读+解析快照（最多 64×10MB）为阻塞 IO，移阻塞线程（照 misc.rs 范例）。
    tauri::async_runtime::spawn_blocking(move || list_in_dir(&dir, &marker))
        .await
        .map_err(|e| ZiEditError::Msg(e.to_string()))
}

fn list_in_dir(dir: &std::path::Path, marker: &std::path::Path) -> RecoveryList {
    // 正常启动（无 live.marker）直接返回空列表：零文件读取与 JSON 解析
    // （此前每次启动都要全量读+解析最多 64×10MB 快照）。
    // 前端仅在 crashed=true 时消费 items（app.ts 恢复提示：!crashed 提前返回），
    // 空 items 无人读取；崩溃恢复路径（marker 存在，罕见）保持全量解析。
    if !marker.exists() {
        return RecoveryList {
            crashed: false,
            items: Vec::new(),
        };
    }
    let mut items = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !owned_snapshot_name(&name) || !name.ends_with(".json") {
                continue;
            }
            let txt = match read_snapshot_bounded(&e.path()) {
                Ok(txt) => txt,
                Err(err) => {
                    if err.to_string().contains(DECRYPT_ERROR) {
                        items.push(RecoveryItem {
                            key: format!("无法解密：{name}"),
                            ts: name
                                .trim_end_matches(".json")
                                .rsplit('.')
                                .next()
                                .and_then(|s| s.parse().ok())
                                .unwrap_or(0),
                            bytes: e.metadata().map(|m| m.len()).unwrap_or(0),
                            draft: false,
                            error: Some(err.to_string()),
                        });
                    }
                    continue;
                }
            };
            let Ok(rec) = serde_json::from_str::<RecoveryRecord>(&txt) else {
                continue;
            };
            items.push(RecoveryItem {
                key: rec.key,
                ts: rec.ts,
                bytes: rec.content.len() as u64,
                draft: rec.draft,
                error: None,
            });
        }
    }
    items.sort_by_key(|i| std::cmp::Reverse(i.ts));
    // 走到这里 marker 必存在：空快照不触发恢复（空标记不提示）
    let crashed = !items.is_empty();
    RecoveryList { crashed, items }
}

/// 读取单条快照全文（恢复时用；无则 None）
#[tauri::command]
pub async fn recovery_read(
    app: tauri::AppHandle,
    key: String,
) -> Result<Option<RecoveryRecord>, ZiEditError> {
    // 候选快照可达 10MB，读取+解析移出 Tokio 命令线程
    tauri::async_runtime::spawn_blocking(move || read_latest_in(&recovery_dir(&app), &key))
        .await
        .map_err(|e| ZiEditError::Msg(e.to_string()))?
        .map_err(Into::into)
}

/// 只解析文件名 tag 匹配的候选（不再读目录内全部文件）；解析后仍校验
/// rec.key == key（覆盖哈希碰撞与遗留同 tag 文件），最新 ts 胜出。
/// 遗留命名兼容（收口评审 #9）：tag 候选缺失时回退全量解析——list 可见的
/// 快照必须能被恢复，否则用户看到可恢复项却静默拿不到内容。
fn read_latest_in(dir: &std::path::Path, key: &str) -> std::io::Result<Option<RecoveryRecord>> {
    if key.strip_prefix("无法解密：").is_some_and(is_tag_named) {
        return Err(std::io::Error::other(DECRYPT_ERROR));
    }
    let tag = key_tag(key);
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut latest: Option<RecoveryRecord> = None;
    let mut legacy: Vec<PathBuf> = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if snap_ts_of(&name, &tag).is_some() {
            let txt = read_snapshot_bounded(&e.path())?;
            let Ok(rec) = serde_json::from_str::<RecoveryRecord>(&txt) else {
                continue;
            };
            if rec.key == key && latest.as_ref().is_none_or(|old| old.ts < rec.ts) {
                latest = Some(rec);
            }
        } else if name.ends_with(".json") && !is_tag_named(&name) {
            legacy.push(e.path());
        }
    }
    if latest.is_none() && !legacy.is_empty() {
        for p in legacy {
            let Ok(txt) = read_snapshot_bounded(&p) else {
                continue;
            };
            let Ok(rec) = serde_json::from_str::<RecoveryRecord>(&txt) else {
                continue;
            };
            if rec.key == key && latest.as_ref().is_none_or(|old| old.ts < rec.ts) {
                latest = Some(rec);
            }
        }
    }
    Ok(latest)
}

#[tauri::command]
pub async fn recovery_discard(app: tauri::AppHandle, keys: Vec<String>) -> Result<(), ZiEditError> {
    // 按各 key 的文件名 tag 删文件，零内容读取与解析
    discard_keys_in(&recovery_dir(&app), &keys);
    Ok(())
}

/// 丢弃指定 keys 的快照：tag 命名走文件名快速通道（零内容读取）；
/// 遗留命名兼容（收口评审 #9）：目录存在遗留 .json 时逐份解析，命中任一 key 即删——
/// list 可见的快照必须可被丢弃，否则残留在恢复列表成「幽灵条目」。
fn discard_keys_in(dir: &std::path::Path, keys: &[String]) {
    let tags: Vec<String> = keys.iter().map(|k| key_tag(k)).collect();
    let mut legacy: Vec<PathBuf> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if tags.iter().any(|t| snap_ts_of(&name, t).is_some()) {
                let _ = std::fs::remove_file(e.path());
            } else if name.ends_with(".json") && !is_tag_named(&name) {
                legacy.push(e.path());
            }
        }
    }
    if legacy.is_empty() {
        return;
    }
    for p in legacy {
        let Ok(txt) = read_snapshot_bounded(&p) else {
            continue;
        };
        let Ok(rec) = serde_json::from_str::<RecoveryRecord>(&txt) else {
            continue;
        };
        if keys.contains(&rec.key) {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// 清空全部快照（保留存活标记的删减由退出钩子负责）
#[tauri::command]
pub async fn recovery_clear(app: tauri::AppHandle) -> Result<(), ZiEditError> {
    let dir = recovery_dir(&app);
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if owned_snapshot_name(&e.file_name().to_string_lossy()) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decrypt_failure_leaves_the_original_file() {
        let dir =
            std::env::temp_dir().join(format!("ziedit-seal-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.json");
        let garbage = b"ZEDP1\0\x04\x00\x00\x00nope";
        std::fs::write(&path, garbage).unwrap();
        let loaded = read_sealed_json::<serde_json::Value>(&path, 1024);
        assert!(matches!(loaded, SealedJson::Unreadable));
        assert_eq!(std::fs::read(&path).unwrap(), garbage);
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("session.json")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sealed_json_roundtrip_and_legacy_plaintext() {
        let dir = std::env::temp_dir().join(format!(
            "ziedit-seal-ok-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.json");
        write_sealed_json(&path, &serde_json::json!({"n": 1}), 4096).unwrap();
        let stored = std::fs::read(&path).unwrap();
        #[cfg(windows)]
        assert!(stored.starts_with(ENCRYPTED_MAGIC));
        #[cfg(not(windows))]
        assert!(stored.starts_with(b"{"));
        match read_sealed_json::<serde_json::Value>(&path, 4096) {
            SealedJson::Value(value) => assert_eq!(value["n"], 1),
            SealedJson::Missing | SealedJson::Unreadable => panic!("sealed session did not load"),
        }
        let legacy = br#"{ "n": 2 }"#;
        std::fs::write(&path, legacy).unwrap();
        match read_sealed_json::<serde_json::Value>(&path, 4096) {
            SealedJson::Value(value) => assert_eq!(value["n"], 2),
            SealedJson::Missing | SealedJson::Unreadable => panic!("legacy plaintext did not load"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn private_snapshot_write_read_and_failed_replacement() {
        let dir = std::env::temp_dir().join(format!(
            "ziedit-private-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let mut rec = RecoveryRecord {
            key: "draft://private".into(),
            content: "中文\0\n🔐".into(),
            mtime: 42,
            len: 20,
            draft: true,
            ts: 1,
        };
        write_snapshot_in(&dir, true, &rec).unwrap();
        let first = dir.join(format!("{}.1.json", key_tag(&rec.key)));
        assert_eq!(
            read_latest_in(&dir, &rec.key).unwrap().unwrap().content,
            rec.content
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&first).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        // 在目标位置放置目录，强制替换失败；旧内容不能被提前回收。
        rec.ts = 2;
        let collision = dir.join(format!("{}.2.json", key_tag(&rec.key)));
        std::fs::create_dir(&collision).unwrap();
        assert!(write_snapshot_in(&dir, true, &rec).is_err());
        assert!(first.exists());
        let previous: RecoveryRecord =
            serde_json::from_str(&read_snapshot_bounded(&first).unwrap()).unwrap();
        assert_eq!(previous.content, rec.content);
        assert_eq!(previous.ts, 1);
        std::fs::remove_dir(&collision).unwrap();
        std::fs::write(dir.join("unrelated.json"), b"keep").unwrap();
        rec.content = "\0".repeat(SNAP_MAX_BYTES);
        write_snapshot_in(&dir, true, &rec).unwrap();
        assert_eq!(
            read_latest_in(&dir, &rec.key).unwrap().unwrap().content,
            rec.content
        );
        assert!(!first.exists());
        rec.ts = 3;
        rec.content.push('x');
        assert!(write_snapshot_in(&dir, true, &rec).is_err());
        assert!(dir.join(format!("{}.2.json", key_tag(&rec.key))).exists());
        assert_eq!(std::fs::read(dir.join("unrelated.json")).unwrap(), b"keep");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn custom_directory_permissions_are_preserved_and_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("ziedit-custom-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let rec = RecoveryRecord {
            key: "draft://custom".into(),
            content: String::new(),
            mtime: 0,
            len: 0,
            draft: true,
            ts: 1,
        };
        write_snapshot_in(&dir, false, &rec).unwrap();
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o755
        );
        let path = dir.join(format!("{}.1.json", key_tag(&rec.key)));
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let new_dir = dir.join("new");
        write_snapshot_in(&new_dir, false, &rec).unwrap();
        assert_eq!(
            std::fs::metadata(new_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn encrypted_roundtrip_content_boundaries() {
        for content in [
            String::new(),
            "中文\0\n🔐".into(),
            "a".repeat(4096),
            "\0".repeat(SNAP_MAX_BYTES),
        ] {
            let rec = RecoveryRecord {
                key: "draft://encrypted".into(),
                content,
                mtime: 0,
                len: 0,
                draft: true,
                ts: 1,
            };
            let json = serde_json::to_vec(&rec).unwrap();
            let encoded = encode_snapshot(&json).unwrap();
            assert!(encoded.starts_with(ENCRYPTED_MAGIC));
            assert!(encoded.len() <= SNAP_MAX_DISK);
            let decoded = decode_snapshot(encoded).unwrap();
            let back: RecoveryRecord = serde_json::from_str(&decoded).unwrap();
            assert_eq!(back.content, rec.content);
        }
    }

    #[test]
    fn corrupted_ciphertext_is_visible_and_preserved() {
        let dir =
            std::env::temp_dir().join(format!("ziedit-dpapi-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("live.marker");
        write_marker_at(&marker).unwrap();
        assert_eq!(std::fs::metadata(&marker).unwrap().len(), 0);
        let path = dir.join(format!("{}.1.json", key_tag("draft://bad")));
        for bytes in [
            ENCRYPTED_MAGIC.to_vec(),
            [ENCRYPTED_MAGIC, &1u32.to_le_bytes(), b"corrupt"].concat(),
        ] {
            std::fs::write(&path, bytes).unwrap();
            assert!(
                read_snapshot_bounded(&path)
                    .unwrap_err()
                    .to_string()
                    .contains(DECRYPT_ERROR)
            );
            let list = list_in_dir(&dir, &marker);
            assert!(list.crashed);
            assert_eq!(list.items.len(), 1);
            assert!(list.items[0].error.as_ref().unwrap().contains("无法解密"));
            assert!(read_latest_in(&dir, "draft://bad").is_err());
            assert!(read_latest_in(&dir, &list.items[0].key).is_err());
            assert!(path.exists());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn listing_filters_unowned_and_oversized_files() {
        let dir = std::env::temp_dir().join(format!("ziedit-list-bounds-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("live.marker"), b"").unwrap();
        let record = r#"{"key":"test","ts":1,"content":"ok","draft":true,"mtime":0,"len":0}"#;
        std::fs::write(dir.join("unrelated.json"), record).unwrap();
        assert!(list_in_dir(&dir, &dir.join("live.marker")).items.is_empty());
        let path = dir.join("0123456789abcdef.1700000000000.json");
        std::fs::write(&path, record).unwrap();
        assert_eq!(list_in_dir(&dir, &dir.join("live.marker")).items.len(), 1);
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(SNAP_MAX_DISK as u64).unwrap();
        assert!(read_snapshot_bounded(&path).is_ok());
        file.set_len(SNAP_MAX_DISK as u64 + 1).unwrap();
        assert!(read_snapshot_bounded(&path).is_err());
        assert!(list_in_dir(&dir, &dir.join("live.marker")).items.is_empty());
        drop(file);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recovery_directory_override() {
        let base = PathBuf::from("config");
        let custom = std::env::temp_dir().join("custom-snapshots");
        assert_eq!(recovery_dir_for(&base, custom.to_str()), custom);
        assert_eq!(marker_path_for(&base), base.join("recovery/live.marker"));
        assert!(!marker_path_for(&base).starts_with(&custom));
    }

    #[test]
    fn custom_snapshots_use_application_marker() {
        let root =
            std::env::temp_dir().join(format!("ziedit-marker-{}-{}", std::process::id(), now_ms()));
        let base = root.join("config");
        let custom = root.join("custom");
        std::fs::create_dir_all(&custom).unwrap();
        let marker = marker_path_for(&base);
        write_marker_at(&marker).unwrap();
        assert!(marker.exists());
        assert!(!custom.join("live.marker").exists());
        let rec = RecoveryRecord {
            key: "draft://1".into(),
            content: "unsaved".into(),
            mtime: 0,
            len: 0,
            draft: true,
            ts: 1,
        };
        std::fs::write(
            custom.join(format!("{}.1.json", key_tag(&rec.key))),
            serde_json::to_vec(&rec).unwrap(),
        )
        .unwrap();
        assert!(list_in_dir(&custom, &marker).crashed);
        std::fs::remove_file(&marker).unwrap();
        std::fs::write(custom.join("live.marker"), b"unrelated").unwrap();
        assert!(!list_in_dir(&custom, &marker).crashed);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// F2：清理/淘汰只认本应用快照命名——自定义目录（用户任意文件夹）里的无关文件绝不触碰
    #[test]
    fn cleanup_only_owned_snapshot_names() {
        assert!(owned_snapshot_name("0123456789abcdef.1729987200000.json"));
        assert!(owned_snapshot_name(
            "0123456789abcdef.1729987200000.json.tmp"
        ));
        assert!(!owned_snapshot_name("data.json"));
        assert!(!owned_snapshot_name("snapshot.json"));
        assert!(!owned_snapshot_name("notes.json.tmp"));
        assert!(!owned_snapshot_name("package-lock.json"));
        assert!(!owned_snapshot_name("live.marker"));
        assert!(!owned_snapshot_name("0123456789abcdef.json")); // 缺时间戳段
    }

    #[test]
    fn recovery_directory_empty_uses_default() {
        let base = PathBuf::from("config");
        assert_eq!(recovery_dir_for(&base, None), base.join("recovery"));
        assert_eq!(recovery_dir_for(&base, Some("")), base.join("recovery"));
    }

    #[test]
    fn recovery_three_states() {
        let dir = std::env::temp_dir().join(format!(
            "ZiEdit-recovery-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!list_in_dir(&dir, &dir.join("live.marker")).crashed); // 正常退出，无标记无快照
        std::fs::write(dir.join("live.marker"), b"live").unwrap();
        assert!(!list_in_dir(&dir, &dir.join("live.marker")).crashed); // 崩溃或清理中断，但无快照
        let rec = RecoveryRecord {
            key: "draft://1".into(),
            content: "unsaved".into(),
            mtime: 0,
            len: 0,
            draft: true,
            ts: 1,
        };
        std::fs::write(
            dir.join(format!("{}.1.json", key_tag(&rec.key))),
            serde_json::to_vec(&rec).unwrap(),
        )
        .unwrap();
        let result = list_in_dir(&dir, &dir.join("live.marker"));
        assert!(result.crashed);
        assert_eq!(result.items.len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn record_roundtrip() {
        let rec = RecoveryRecord {
            key: "/tmp/a.txt".into(),
            content: "hello\nworld".into(),
            mtime: 123,
            len: 11,
            draft: false,
            ts: 456,
        };
        let json = serde_json::to_string(&rec).unwrap();
        let back: RecoveryRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back.key, rec.key);
        assert_eq!(back.content, rec.content);
        assert!(!back.draft);
    }

    /// P3-25：总量兜底纯函数——未超限不动、超限淘汰最旧（新快照绝不误删）
    #[test]
    fn prune_keeps_newest() {
        let mk = |n: u64| vec![(n, PathBuf::from(format!("snap{n}.json")))];
        // 未超限：零淘汰
        let files: Vec<_> = (1..=SNAP_MAX_FILES as u64).flat_map(mk).collect();
        assert!(prune_oldest(files, SNAP_MAX_FILES).is_empty());
        // 超限 3 条：淘汰时间戳最小的 3 条
        let files: Vec<_> = (1..=SNAP_MAX_FILES as u64 + 3).flat_map(mk).collect();
        let victims = prune_oldest(files, SNAP_MAX_FILES);
        assert_eq!(victims.len(), 3);
        assert_eq!(
            victims,
            vec![
                PathBuf::from("snap1.json"),
                PathBuf::from("snap2.json"),
                PathBuf::from("snap3.json")
            ]
        );
    }

    /// P3-25：启动清扫只认 `*.json.tmp`，绝不误删快照本体
    #[test]
    fn sweep_targets_only_tmp() {
        let dir = std::env::temp_dir().join(format!(
            "ZiEdit-recovery-sweep-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let snapshot = dir.join("0123456789abcdef.1700000000000.json");
        let tmp = dir.join("0123456789abcdef.1700000000000.json.tmp");
        std::fs::write(&snapshot, b"snapshot").unwrap();
        std::fs::write(&tmp, b"partial").unwrap();
        std::fs::write(dir.join("notes.json.tmp"), b"unrelated").unwrap();
        std::fs::write(dir.join("live.marker"), b"live").unwrap();
        sweep_tmp_in(&dir);
        assert!(snapshot.exists(), "正式快照必须保留");
        assert!(!tmp.exists(), "快照中间态应被清扫");
        assert!(dir.join("notes.json.tmp").exists());
        assert!(dir.join("live.marker").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// P3-25：超限如实回报（前端据此状态栏提示；此处锁契约常量与判定边界）
    #[test]
    fn oversize_boundary() {
        assert!(!(SNAP_MAX_BYTES as u64 > SNAP_MAX_BYTES as u64)); // 恰好 10MB 不算超限
        assert!(SNAP_MAX_BYTES as u64 + 1 > SNAP_MAX_BYTES as u64);
        let o = SnapshotOutcome {
            skipped: true,
            evicted: 0,
        };
        let j = serde_json::to_string(&o).unwrap();
        assert!(j.contains("\"skipped\":true"));
        assert!(j.contains("\"evicted\":0"));
    }

    /// BE1：回收按文件名 tag——同 key 旧副本删除、他 key 与遗留命名文件不碰、
    /// ts 更大的残留（时钟回拨场景）不删
    #[test]
    fn recycle_old_by_tag() {
        let dir = std::env::temp_dir().join(format!(
            "ZiEdit-recovery-recycle-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let a = "/a.txt";
        let b = "/b.txt";
        let name = |key: &str, ts: u64| format!("{}.{}.json", key_tag(key), ts);
        std::fs::write(dir.join(name(a, 1)), b"old-a").unwrap(); // 同 key 旧副本：该删
        let keep = dir.join(name(a, 2));
        std::fs::write(&keep, b"new-a").unwrap(); // 刚写入者：保留
        std::fs::write(dir.join(name(a, 3)), b"future-a").unwrap(); // ts 更大：不删
        std::fs::write(dir.join(name(b, 1)), b"old-b").unwrap(); // 他 key：不碰
        std::fs::write(dir.join("snapshot.json"), b"legacy").unwrap(); // 遗留命名：不碰
        recycle_old(&dir, a, &keep, 2).unwrap();
        assert!(!dir.join(name(a, 1)).exists(), "同 key 旧副本应被回收");
        assert!(keep.exists(), "刚写入者保留");
        assert!(dir.join(name(a, 3)).exists(), "ts 更大的残留不删");
        assert!(dir.join(name(b, 1)).exists(), "他 key 快照不碰");
        assert!(dir.join("snapshot.json").exists(), "遗留命名文件不碰");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// BE1：读取按 tag 过滤候选——只解析文件名匹配者、解析后校验内容 key、最新 ts 胜出
    #[test]
    fn read_latest_by_tag() {
        let dir = std::env::temp_dir().join(format!(
            "ZiEdit-recovery-read-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let a = "/a.txt";
        let b = "/b.txt";
        let rec = |key: &str, content: &str, ts: u64| RecoveryRecord {
            key: key.into(),
            content: content.into(),
            mtime: 0,
            len: 0,
            draft: false,
            ts,
        };
        let put = |key: &str, r: &RecoveryRecord| {
            std::fs::write(
                dir.join(format!("{}.{}.json", key_tag(key), r.ts)),
                serde_json::to_vec(r).unwrap(),
            )
            .unwrap();
        };
        put(a, &rec(a, "old", 1));
        put(a, &rec(a, "new", 5)); // 最新同 key 胜出
        put(b, &rec(b, "other", 9)); // 他 key：即便 ts 更大也不取
        // 文件名挂 a 的 tag 但内容是他 key（哈希碰撞/错位）：内容校验兜底，不得返回
        std::fs::write(
            dir.join(format!("{}.{}.json", key_tag(a), 7)),
            serde_json::to_vec(&rec(b, "mismatch", 7)).unwrap(),
        )
        .unwrap();
        let got = read_latest_in(&dir, a).unwrap().unwrap();
        assert_eq!(got.key, a);
        assert_eq!(got.content, "new");
        assert_eq!(got.ts, 5);
        assert!(read_latest_in(&dir, "/missing.txt").unwrap().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// BE1：丢弃按各 key 的 tag——精确删除、他 key 与遗留命名文件保留
    #[test]
    fn discard_by_tag() {
        let dir = std::env::temp_dir().join(format!(
            "ZiEdit-recovery-discard-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let a = "/a.txt";
        let b = "/b.txt";
        let name = |key: &str, ts: u64| format!("{}.{}.json", key_tag(key), ts);
        std::fs::write(dir.join(name(a, 1)), b"a1").unwrap();
        std::fs::write(dir.join(name(a, 2)), b"a2").unwrap();
        std::fs::write(dir.join(name(b, 1)), b"b1").unwrap();
        std::fs::write(dir.join("snapshot.json"), b"legacy").unwrap();
        discard_keys_in(&dir, &[a.to_string()]);
        assert!(!dir.join(name(a, 1)).exists());
        assert!(!dir.join(name(a, 2)).exists());
        assert!(dir.join(name(b, 1)).exists(), "他 key 快照保留");
        assert!(dir.join("snapshot.json").exists(), "遗留命名文件保留");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 收口评审 #9：遗留命名快照——list 可见即必须可读可弃；tag 命名优先
    #[test]
    fn legacy_named_snapshot_readable_and_discardable() {
        let dir = std::env::temp_dir().join(format!(
            "ZiEdit-recovery-legacy-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let rec = |key: &str, content: &str, ts: u64| RecoveryRecord {
            key: key.into(),
            content: content.into(),
            mtime: 0,
            len: 0,
            draft: true,
            ts,
        };
        // 遗留命名（无 tag）：内容是合法记录
        std::fs::write(
            dir.join("snapshot.json"),
            serde_json::to_vec(&rec("draft://9", "old", 42)).unwrap(),
        )
        .unwrap();
        // 遗留回退：无 tag 命中时按内容找到
        let got = read_latest_in(&dir, "draft://9")
            .unwrap()
            .expect("legacy fallback");
        assert_eq!(got.ts, 42);
        // tag 命名同键更新时优先于遗留
        std::fs::write(
            dir.join(format!("{}.99.json", key_tag("draft://9"))),
            serde_json::to_vec(&rec("draft://9", "new", 99)).unwrap(),
        )
        .unwrap();
        assert_eq!(read_latest_in(&dir, "draft://9").unwrap().unwrap().ts, 99);
        // 丢弃：tag 命中 + 遗留回退都删净
        discard_keys_in(&dir, &["draft://9".to_string()]);
        assert!(read_latest_in(&dir, "draft://9").unwrap().is_none());
        assert!(!dir.join("snapshot.json").exists());
        assert!(
            !dir.join(format!("{}.99.json", key_tag("draft://9")))
                .exists()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 收口评审 #9：严格命名判定的边界（临时文件/标记/非十六进制不误判）
    #[test]
    fn tag_named_pattern_strict() {
        assert!(is_tag_named("0123456789abcdef.1700000000000.json"));
        assert!(!is_tag_named("snapshot.json"));
        assert!(!is_tag_named("0123456789abcdef.1700000000000.json.tmp"));
        assert!(!is_tag_named("short.123.json"));
        assert!(!is_tag_named("0123456789abcdeg.123.json"));
        assert!(!is_tag_named("live.marker"));
        assert!(!is_tag_named("0123456789abcdef..json"));
    }
}
