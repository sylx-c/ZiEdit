//! misc —— 杂项命令：保存（含滚动备份）/全量读取/JSON 格式化/校验和/回收站删除/跨文件搜索/Hex 查找

use crate::encoding;
use crate::error::ZiEditError;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 编辑缓冲上限（10MB；AC-21 ≤10MB 守卫）
pub const READ_ALL_LIMIT: u64 = 10 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
struct FileSignature {
    len: u64,
    modified: Option<SystemTime>,
}

fn file_signature(path: &Path) -> Result<Option<FileSignature>, ZiEditError> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(Some(FileSignature {
            len: meta.len(),
            modified: meta.modified().ok(),
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ZiEditError::Io(e)),
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), ZiEditError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::store::atomic_write(path, bytes)?;
    Ok(())
}

/// 备份目录：<配置目录>/backups/（ADR 014 开发态隔离：debug → `-dev` 后缀目录）
fn backups_dir(app: &tauri::AppHandle) -> PathBuf {
    crate::paths::config_dir(app)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("backups")
}

/// 滚动备份核心（纯函数便于单测）：把 path 当前内容复制为 <dir>/<hash>.<name>.1.bak，
/// 旧 .k 依次右移，超出 keep 的淘汰；path 不存在或 keep=0 不动。
/// RUST-05（审计 2026-10-17）：关键步骤不再 `let _ =` 吞错——建目录/首份复制失败返回 Err
/// （调用方记日志，保存继续但备份链缺一节可观测）；滚动 rename 失败记 warn 后继续（缺中间节）。
fn backup_roll_to(dir: &Path, path: &Path, keep: u32) -> Result<(), ZiEditError> {
    if keep == 0 || !path.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| ZiEditError::Msg(format!("backup dir: {e}")))?;
    let mut h = DefaultHasher::new();
    path.to_string_lossy().hash(&mut h);
    let tag = format!("{:016x}", h.finish());
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let bak = |k: u32| dir.join(format!("{}.{}.{}.bak", tag, name, k));
    let _ = std::fs::remove_file(bak(keep)); // 淘汰最旧：不存在=正常，忽略
    let mut k = keep.saturating_sub(1);
    while k >= 1 {
        let from = bak(k);
        if from.exists()
            && let Err(e) = std::fs::rename(&from, bak(k + 1))
        {
            log::warn!("[ZiEdit] 备份滚动 rename 失败：{e}");
        }
        if k == 1 {
            break;
        }
        k -= 1;
    }
    std::fs::copy(path, bak(1))
        .map(|_| ())
        .map_err(|e| ZiEditError::Msg(format!("backup copy: {e}")))
}

/// 读取全文件为文本（编辑缓冲用；超出上限报错）。async + spawn_blocking：
/// 走 TextRegistry（ensure_open + 块缓存组装 + 解码），与 text_open/text_lines 共享
/// 探测缓存与块缓存，避免打开路径双读；返回形状/上限/错误串与旧实现一致。
/// 读取前核对缓存条目与磁盘当前 (len,mtime) 一致，失配即失效重开——
/// 不读回保存/外部改写前的旧块。
#[tauri::command]
pub async fn text_read_all(
    app: tauri::AppHandle,
    registry: tauri::State<'_, crate::commands::text::TextRegistry>,
    path: String,
    encoding_name: Option<String>,
) -> Result<String, ZiEditError> {
    use crate::commands::text::{ensure_open, snapshot, validate_registry_entry};

    ensure_open(&registry, &app, &path, encoding_name.as_deref())?;
    // 版本校验：条目 (len,mtime) ≠ 磁盘当前版本（text_save 落盘 / 外部改写）→ 失效重开
    if !validate_registry_entry(&registry, &path)? {
        ensure_open(&registry, &app, &path, encoding_name.as_deref())?;
    }
    // 锁内只取 Arc 快照（块缓存 + 打开瞬间长度 + 编码名），组装与解码在阻塞线程
    let snap = snapshot(&registry, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let len = snap.len;
        if len > READ_ALL_LIMIT {
            return Err(ZiEditError::Msg(format!(
                "File exceeds the edit buffer limit ({} MB)",
                READ_ALL_LIMIT / 1048576
            )));
        }
        let mut out = Vec::with_capacity(len as usize);
        {
            let mut cache = snap
                .cache
                .lock()
                .map_err(|e| ZiEditError::Msg(e.to_string()))?;
            let chunks = len.div_ceil(crate::file_engine::CHUNK as u64);
            for idx in 0..chunks {
                let block = cache.read_chunk(idx)?;
                out.extend_from_slice(&block);
            }
        }
        if out.len() as u64 > READ_ALL_LIMIT {
            return Err(ZiEditError::Msg(
                "File grew beyond the 10MB edit buffer limit".into(),
            ));
        }
        let (text, _) = encoding::decode(&out, &snap.encoding_name);
        Ok(text)
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// 保存：按编码写回（不可映射字符报错，由 UI 引导另存 UTF-8）；原子写；写前按 backup_keep 滚动备份（ADR 012）。
/// async + spawn_blocking：全量重编码（≤10MB）、整文件备份拷贝与 fsync 不冻结主线程。
/// 成功落盘后失效 TextRegistry 条目：前端只清了自己的 memo，后端块缓存/行索引
/// 若不失效，保存后切走再切回可能装载旧块、后续保存可能覆盖新内容。
#[tauri::command]
pub async fn text_save(
    registry: tauri::State<'_, crate::commands::text::TextRegistry>,
    path: String,
    content: String,
    encoding_name: String,
    backup_keep: Option<u32>,
    app: tauri::AppHandle,
) -> Result<SaveStat, ZiEditError> {
    let path_for_invalidate = path.clone();
    let stat = tauri::async_runtime::spawn_blocking(move || {
        text_save_impl(&path, content, &encoding_name, backup_keep, &app)
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))??;
    // 失效（探测缓存键含 len/mtime，自动跟随）：下次 ensure_open 按新基线重开
    crate::commands::text::invalidate(&registry, &path_for_invalidate)?;
    Ok(stat)
}

fn text_save_impl(
    path: &str,
    content: String,
    encoding_name: &str,
    backup_keep: Option<u32>,
    app: &tauri::AppHandle,
) -> Result<SaveStat, ZiEditError> {
    let p = PathBuf::from(path);
    // 保存是基于打开时内容的写回。编码或备份期间若外部程序改写/增长了文件，
    // 直接覆盖会丢掉外部更新；先后两次签名检查把这段可控竞态收口为可恢复错误。
    // 注：三次 file_signature 各守一个竞态窗口（编码前基线/编码后/备份后），
    // 合并任两次都会改变竞态检查语义，故保留（stat 本身微秒级，热点在重编码/拷贝/fsync）。
    let before = file_signature(&p)?;
    // 先编码校验（不可映射字符报错时不得先动备份，ADR 012）
    let mut original = [0u8; 3];
    let original_len = match std::fs::File::open(&p) {
        Ok(mut file) => file.read(&mut original)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(ZiEditError::Io(e)),
    };
    let bytes = encoding::encode_preserving_bom(&content, encoding_name, &original[..original_len])
        .map_err(|e| ZiEditError::Unmappable(e.to_string()))?;
    if file_signature(&p)? != before {
        return Err(ZiEditError::ExternalChanged);
    }
    if let Err(e) = backup_roll_to(&backups_dir(app), &p, backup_keep.unwrap_or(0)) {
        // ADR 012：备份是保护不是前置——失败不阻断保存，但必须可观测（修前 let _ = 静默失效）
        log::warn!("[ZiEdit] 滚动备份失败：{e}——本次保存继续，备份链缺一节");
    }
    if file_signature(&p)? != before {
        return Err(ZiEditError::ExternalChanged);
    }
    atomic_write(&p, &bytes)?;
    // A-11（审计 2026-10-17）：返回落盘基线（len/modifiedMs）——前端 onSaved 同步立基线，
    // 消除「轮询器 stat 发出于写盘前、返回于写盘后」窗口内被误判外部修改的 TOCTOU。
    let meta =
        std::fs::metadata(&p).map_err(|e| ZiEditError::Msg(format!("stat after save: {e}")))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(SaveStat {
        len: meta.len(),
        modified_ms: modified,
    })
}

/// 保存落盘基线（A-11）：text_save 成功即返回，前端据此同步刷新大小/修改时间基线
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveStat {
    pub len: u64,
    pub modified_ms: u64,
}

/// 备份目录路径（设置面板「打开备份目录」用）
#[tauri::command]
pub fn backup_dir(app: tauri::AppHandle) -> Result<String, ZiEditError> {
    Ok(backups_dir(&app).to_string_lossy().to_string())
}

/// 本地字体导入（C-3 #22）：读字体文件返回 base64，前端经 FontFace API 会话注册。
/// 只读字节不解析字体；文件大小上限 32MB（中文字体 ttf/otf 可达数十 MB）。
/// async + spawn_blocking：数十 MB 读取 + base64 编码不冻结主线程
#[tauri::command]
pub async fn font_read(path: String) -> Result<String, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        const MAX_FONT_BYTES: u64 = 32 * 1024 * 1024;
        let p = PathBuf::from(&path);
        let meta = std::fs::metadata(&p)?;
        if meta.len() > MAX_FONT_BYTES {
            return Err(ZiEditError::Msg(format!("FONT_TOO_LARGE:{}", meta.len())));
        }
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        std::fs::File::open(&p).and_then(|f| f.take(MAX_FONT_BYTES + 1).read_to_end(&mut bytes))?;
        if bytes.len() as u64 > MAX_FONT_BYTES {
            return Err(ZiEditError::Msg(format!("FONT_TOO_LARGE:{}", bytes.len())));
        }
        Ok(base64_encode(&bytes))
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// base64 标准编码（无外部依赖自实现，字体导入专用）
/// base64（自研实现，零新依赖；hex_bytes 窗口返回与 font_read 共用；s3 上传/取图与
/// image_write 经 base64_decode 往返）
pub fn base64_encode(data: &[u8]) -> String {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TBL[(n >> 18) as usize & 63] as char);
        out.push(TBL[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TBL[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TBL[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// base64 标准解码（自研实现，与 base64_encode 互逆；009 图床上传路径专用——
/// 前端 FileReader 读图为 base64 过 IPC，Rust 侧解码后走 s3_put_object）。
/// 严格校验：非法字符 / 长度非 4 倍数 / 填充位后仍有数据均报错（防静默截断）。
pub fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok((c - b'A') as u32),
            b'a'..=b'z' => Ok((c - b'a') as u32 + 26),
            b'0'..=b'9' => Ok((c - b'0') as u32 + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("invalid base64 character: {}", c as char)),
        }
    }
    let bytes = s.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return Err(format!("length {} not multiple of 4", bytes.len()));
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (ci, chunk) in bytes.chunks(4).enumerate() {
        let pad = chunk.iter().filter(|&&c| c == b'=').count();
        if pad > 2 || chunk[..4 - pad].contains(&b'=') {
            return Err("misplaced padding".to_string());
        }
        // 尾块外的 '=' 都是非法（填充只出现在末块）
        if ci + 1 < bytes.len() / 4 && pad > 0 {
            return Err("padding in non-final chunk".to_string());
        }
        let n = (val(chunk[0])? << 18)
            | (val(chunk[1])? << 12)
            | if pad < 2 { val(chunk[2])? << 6 } else { 0 }
            | if pad < 1 { val(chunk[3])? } else { 0 };
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

/// 写图片文件（009 规则 4 触发②「保存为本地文件」分支：拖入/粘贴图片落盘到
/// Markdown 同目录 assets/ 下，前端负责目标路径与撞名后缀）。不覆盖已存在文件。
/// async + spawn_blocking：base64 解码与写盘不冻结主线程
#[tauri::command]
pub async fn image_write(path: String, data_base64: String) -> Result<(), ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if p.exists() {
            return Err(ZiEditError::Exists);
        }
        let bytes = base64_decode(&data_base64).map_err(|e| ZiEditError::Msg(e.to_string()))?;
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&p, &bytes)?;
        Ok(())
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// JSON 只读格式化（async + spawn_blocking：整文解析重排不冻结主线程）
#[tauri::command]
pub async fn format_json(text: String) -> Result<String, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let v: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| ZiEditError::Msg(format!("JSON parse error: {e}")))?;
        serde_json::to_string_pretty(&v).map_err(ZiEditError::Json)
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// XML 只读格式化（quick-xml 流式事件重排缩进，M6-2；
/// async + spawn_blocking：整文解析重排不冻结主线程）
#[tauri::command]
pub async fn format_xml(text: String) -> Result<String, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || format_xml_impl(&text))
        .await
        .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

fn format_xml_impl(text: &str) -> Result<String, ZiEditError> {
    use quick_xml::Reader;
    use quick_xml::Writer;
    use quick_xml::events::Event;
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut out: Vec<u8> = Vec::new();
    let mut writer = Writer::new_with_indent(&mut out, b' ', 2);
    let mut depth: usize = 0;
    let mut pending_text = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                flush_text(&mut writer, &mut pending_text)?;
                writer
                    .write_event(Event::Start(e.borrow()))
                    .map_err(|e| ZiEditError::Msg(e.to_string()))?;
                depth += 1;
            }
            Ok(Event::End(e)) => {
                flush_text(&mut writer, &mut pending_text)?;
                depth = depth.saturating_sub(1);
                writer
                    .write_event(Event::End(e.borrow()))
                    .map_err(|e| ZiEditError::Msg(e.to_string()))?;
            }
            Ok(Event::Empty(e)) => {
                flush_text(&mut writer, &mut pending_text)?;
                writer
                    .write_event(Event::Empty(e.borrow()))
                    .map_err(|e| ZiEditError::Msg(e.to_string()))?;
            }
            Ok(Event::Text(t)) => {
                let txt = t.unescape().map_err(|e| ZiEditError::Msg(e.to_string()))?;
                if !txt.trim().is_empty() {
                    pending_text.push_str(txt.as_ref());
                }
            }
            Ok(Event::CData(t)) => {
                flush_text(&mut writer, &mut pending_text)?;
                writer
                    .write_event(Event::CData(t))
                    .map_err(|e| ZiEditError::Msg(e.to_string()))?;
            }
            Ok(Event::Comment(t)) => {
                flush_text(&mut writer, &mut pending_text)?;
                writer
                    .write_event(Event::Comment(t))
                    .map_err(|e| ZiEditError::Msg(e.to_string()))?;
            }
            Ok(Event::Decl(t)) => {
                flush_text(&mut writer, &mut pending_text)?;
                writer
                    .write_event(Event::Decl(t))
                    .map_err(|e| ZiEditError::Msg(e.to_string()))?;
            }
            Ok(Event::PI(t)) => {
                flush_text(&mut writer, &mut pending_text)?;
                writer
                    .write_event(Event::PI(t))
                    .map_err(|e| ZiEditError::Msg(e.to_string()))?;
            }
            Ok(Event::DocType(t)) => {
                writer
                    .write_event(Event::DocType(t))
                    .map_err(|e| ZiEditError::Msg(e.to_string()))?;
            }
            Err(e) => return Err(ZiEditError::Msg(format!("XML parse error: {e}"))),
            Ok(Event::Eof) => break,
        }
    }
    flush_text(&mut writer, &mut pending_text)?;
    String::from_utf8(out).map_err(|e| ZiEditError::Msg(e.to_string()))
}

fn flush_text<W: std::io::Write>(
    writer: &mut quick_xml::Writer<W>,
    pending: &mut String,
) -> Result<(), ZiEditError> {
    use quick_xml::events::{BytesText, Event};
    if !pending.is_empty() {
        writer
            .write_event(Event::Text(BytesText::new(pending)))
            .map_err(ZiEditError::Io)?;
        pending.clear();
    }
    Ok(())
}

/// 校验和（流式，1MB 缓冲）。async：GB 级文件计算不冻结主线程（M6）
#[tauri::command]
pub async fn checksum(path: String, algo: String) -> Result<String, ZiEditError> {
    use crc32fast::Hasher as Crc;
    use md5::Md5;
    use sha1::{Digest as _, Sha1};
    use sha2::Sha256;
    let mut f = std::fs::File::open(&path)?;
    let mut buf = vec![0u8; 1024 * 1024];
    let mut crc = Crc::new();
    let mut md5 = Md5::new();
    let mut sha1 = Sha1::new();
    let mut sha256 = Sha256::new();
    let algo_l = algo.to_lowercase();
    if !matches!(algo_l.as_str(), "crc32" | "md5" | "sha1" | "sha256") {
        return Err(ZiEditError::Msg(
            "Unsupported algorithm; use crc32/md5/sha1/sha256".into(),
        ));
    }
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        match algo_l.as_str() {
            "crc32" => crc.update(&buf[..n]),
            "md5" => md5.update(&buf[..n]),
            "sha1" => sha1.update(&buf[..n]),
            "sha256" => sha256.update(&buf[..n]),
            _ => {
                return Err(ZiEditError::Msg(
                    "Unsupported algorithm; use crc32/md5/sha1/sha256".into(),
                ));
            }
        }
    }
    Ok(match algo_l.as_str() {
        "crc32" => format!("{:08x}", crc.finalize()),
        "md5" => format!("{:x}", md5.finalize()),
        "sha1" => format!("{:x}", sha1.finalize()),
        "sha256" => format!("{:x}", sha256.finalize()),
        _ => unreachable!(),
    })
}

/// 删除到系统回收站（二次确认由 UI 负责）
#[tauri::command]
pub fn delete_to_trash(path: String) -> Result<(), ZiEditError> {
    trash::delete(&path).map_err(|e| ZiEditError::Msg(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_load_normalizes_null_to_empty_object() {
        // 缺失 settings.json 时 load_or_default::<Value> 给 Null（验收缺陷 D1 回归）
        assert_eq!(
            settings_value_or_object(serde_json::Value::Null),
            serde_json::json!({})
        );
        // 正常对象与非 null 标量原样透传
        assert_eq!(
            settings_value_or_object(serde_json::json!({ "fontSize": 14 })),
            serde_json::json!({ "fontSize": 14 })
        );
        assert_eq!(
            settings_value_or_object(serde_json::json!(3)),
            serde_json::json!(3)
        );
    }

    #[test]
    fn checksum_empty_file_rejects_invalid_algorithm() {
        let path = std::env::temp_dir().join(format!(
            "ziedit-checksum-empty-{}-{}.tmp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::File::create_new(&path).unwrap();
        let result = tauri::async_runtime::block_on(checksum(
            path.to_string_lossy().into_owned(),
            "invalid".into(),
        ));
        std::fs::remove_file(path).unwrap();
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Unsupported algorithm")
        );
    }

    #[test]
    fn format_json_pretty() {
        let out =
            tauri::async_runtime::block_on(format_json(r#"{"a":1,"b":[1,2]}"#.into())).unwrap();
        assert!(out.contains("\n  \"a\": 1"));
    }

    #[test]
    fn format_xml_pretty() {
        let out =
            tauri::async_runtime::block_on(format_xml("<root><a>1</a><b><c/></b></root>".into()))
                .unwrap();
        assert!(out.contains("<root>\n  <a>1</a>"), "got: {}", out);
        assert!(out.contains("<c/>"), "self-closing preserved: {}", out);
    }

    #[test]
    fn format_xml_rejects_broken() {
        assert!(tauri::async_runtime::block_on(format_xml("<a><b></a>".into())).is_err());
    }
}

// ---- 命名会话（001 规则 13）----
#[tauri::command]
pub fn named_sessions_load(
    app: tauri::AppHandle,
) -> std::collections::HashMap<String, crate::commands::SessionState> {
    let dir = match crate::paths::config_dir(&app) {
        Ok(d) => d,
        Err(_) => return Default::default(),
    };
    crate::store::load_or_default(&crate::store::config_file(&dir, "named_sessions.json"))
}

#[tauri::command]
pub fn named_sessions_save(
    app: tauri::AppHandle,
    sessions: std::collections::HashMap<String, crate::commands::SessionState>,
) -> Result<(), ZiEditError> {
    let dir = crate::paths::config_dir(&app)?;
    crate::store::save(
        &crate::store::config_file(&dir, "named_sessions.json"),
        &sessions,
    )
}

// ---- 设置（001 规则 17）----

/// settings.json 缺失/损坏时 `load_or_default::<Value>` 返回 `Value::Null`
/// （`serde_json::Value` 的 `Default` 是 Null，非空对象）。前端启动序列把
/// 返回值当对象解引用（app.ts 旧版凭据剔除），Null 会让首启直接崩溃——
/// 这里统一归一化为空对象，与其余 load 命令（Vec/HashMap/结构体 Default）口径一致。
fn settings_value_or_object(v: serde_json::Value) -> serde_json::Value {
    if v.is_null() {
        serde_json::json!({})
    } else {
        v
    }
}

#[tauri::command]
pub fn settings_load(app: tauri::AppHandle) -> serde_json::Value {
    let dir = match crate::paths::config_dir(&app) {
        Ok(d) => d,
        Err(_) => return serde_json::json!({}),
    };
    settings_value_or_object(crate::store::load_or_default(&crate::store::config_file(
        &dir,
        "settings.json",
    )))
}

#[tauri::command]
pub fn settings_save(
    app: tauri::AppHandle,
    settings: serde_json::Value,
) -> Result<(), ZiEditError> {
    let dir = crate::paths::config_dir(&app)?;
    crate::store::save(&crate::store::config_file(&dir, "settings.json"), &settings)
}

#[cfg(test)]
mod backup_tests {
    use super::{backup_roll_to, file_signature};
    use std::path::PathBuf;

    fn write(p: &PathBuf, s: &str) {
        std::fs::write(p, s).unwrap();
    }

    #[test]
    fn roll_keeps_n_and_rotates() {
        let dir = std::env::temp_dir().join("ZiEdit-backup-test-roll");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.txt");
        write(&f, "v1");
        backup_roll_to(&dir, &f, 2).unwrap();
        write(&f, "v2");
        backup_roll_to(&dir, &f, 2).unwrap();
        write(&f, "v3");
        backup_roll_to(&dir, &f, 2).unwrap();
        // .1 = 最近一次写盘前的内容（v2），.2 = v1，v0 不存在
        let files: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|x| x.file_name().to_string_lossy().to_string()))
            .filter(|n| n.ends_with(".bak"))
            .collect();
        assert_eq!(
            files.len(),
            2,
            "keep=2 should keep exactly 2 backups: {files:?}"
        );
        // 滚动语义：.1 = 最近一次写盘前内容（v3 已落盘待下次），.2 = 再前一次（v2）
        assert_eq!(std::fs::read_to_string(get(&dir, 1)).unwrap(), "v3");
        assert_eq!(std::fs::read_to_string(get(&dir, 2)).unwrap(), "v2");
    }

    #[test]
    fn roll_failure_is_err_not_silent_rust05() {
        // RUST-05：目录被同名文件占据时 create_dir_all 失败必须返回 Err——
        // 修前 let _ = 吞掉后保存照常、备份静默缺失（ADR 012 保护失效不可观测）。
        let dir = std::env::temp_dir().join("ZiEdit-backup-test-err");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let blocked = dir.join("blocked"); // 同名文件挡住目录创建
        write(&blocked, "x");
        let f = dir.join("b.txt");
        write(&f, "v1");
        let err = backup_roll_to(&blocked, &f, 2).unwrap_err().to_string();
        assert!(
            !err.contains(&blocked.to_string_lossy().to_string()),
            "backup 错误信息不得带用户路径：{err}"
        );
    }

    fn get(dir: &PathBuf, k: u32) -> PathBuf {
        let mut found = None;
        for e in std::fs::read_dir(dir).unwrap() {
            let n = e.unwrap().file_name().to_string_lossy().to_string();
            if n.ends_with(&format!(".{}.bak", k)) {
                found = Some(dir.join(n));
            }
        }
        found.unwrap()
    }

    #[test]
    fn roll_zero_or_missing_noop() {
        let dir = std::env::temp_dir().join("ZiEdit-backup-test-noop");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("b.txt");
        write(&f, "x");
        backup_roll_to(&dir, &f, 0).unwrap();
        assert!(backup_roll_to(&dir, &dir.join("missing.txt"), 3).is_ok());
        let baks: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|x| x.file_name().to_string_lossy().to_string()))
            .filter(|n| n.ends_with(".bak"))
            .collect();
        assert!(
            baks.is_empty(),
            "keep=0 and missing source should produce no backups: {baks:?}"
        );
    }

    #[test]
    fn signature_changes_when_file_grows() {
        let dir = std::env::temp_dir().join("ZiEdit-save-signature-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("grow.txt");
        std::fs::write(&p, b"one").unwrap();
        let before = file_signature(&p).unwrap();
        std::fs::write(&p, b"one-two").unwrap();
        let after = file_signature(&p).unwrap();
        assert_ne!(before, after);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
