//! text —— 文本视图服务：打开/行区间/跳转/查找（002 子 PRD）
//! 行索引后台构建（不阻塞首屏，事件通知完成）；行读取走 file_engine 分块接口。

use crate::encoding::{self, EncodingInfo};
use crate::error::ZiEditError;
use crate::file_engine::{
    CHUNK, ChunkCache, LineIndex, build_index_cached, build_index_encoded, jump_to_line,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

/// 同步建索引的文件大小上限（超过则等后台线程）
const SYNC_INDEX_LIMIT: u64 = 8 * 1024 * 1024;
/// find 每批扫描行数
const FIND_BATCH_LINES: u64 = 200;
const REGISTRY_CAP: usize = 32;
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

/// 打开的文本文件。cache 走 `Arc<Mutex<ChunkCache>>`、index 走 `Arc<LineIndex>`：
/// registry 锁只做 map 查询拿 Arc 快照，读取/解码/切行/collect 在锁外进行
/// （Arc 快照模式，竞态安全：并发 text_refresh 换缓存时旧快照持有者读旧内容，不撕裂）。
pub struct TextFile {
    pub cache: Arc<Mutex<ChunkCache>>,
    pub index: Option<Arc<LineIndex>>,
    pub encoding: EncodingInfo,
    /// 打开时的磁盘 mtime（毫秒）：text_refresh 等长改写检测用（M11）
    pub mtime: u64,
    generation: u64,
    last_used: Instant,
}

#[derive(Default)]
pub struct TextRegistry(pub Mutex<HashMap<String, TextFile>>);

/// 锁外读取快照（text_read_all 复用 registry 块缓存用）。
/// 版本护栏在取快照前由 validate_registry_entry 把关（len/mtime 对账磁盘，
/// 失配即移除条目并重开），快照本身只携带读取所需的缓存与编码信息。
pub(crate) struct TextSnapshot {
    pub cache: Arc<Mutex<ChunkCache>>,
    pub len: u64,
    pub encoding_name: String,
}

/// registry 锁内取 Arc 快照（不持锁返回）
pub(crate) fn snapshot(registry: &TextRegistry, path: &str) -> Result<TextSnapshot, ZiEditError> {
    let reg = registry
        .0
        .lock()
        .map_err(|e| ZiEditError::Msg(e.to_string()))?;
    let tf = reg
        .get(path)
        .ok_or_else(|| ZiEditError::Msg("File is not open".into()))?;
    let len = tf
        .cache
        .lock()
        .map_err(|e| ZiEditError::Msg(e.to_string()))?
        .len();
    Ok(TextSnapshot {
        cache: tf.cache.clone(),
        len,
        encoding_name: tf.encoding.name.clone(),
    })
}

/// 失效条目（text_save 成功落盘后调用——后端块缓存/行索引若不失效，
/// 切走再切回可能装载旧块、后续保存可能覆盖新内容；探测缓存键含 len/mtime 自动失效）。
/// 下次 ensure_open 按 len/mtime 基线重新打开。
pub(crate) fn invalidate(registry: &TextRegistry, path: &str) -> Result<(), ZiEditError> {
    registry
        .0
        .lock()
        .map_err(|e| ZiEditError::Msg(e.to_string()))?
        .remove(path);
    Ok(())
}

/// 缓存版本校验：条目 (len, mtime) 与磁盘当前版本一致返回 true；
/// 失配（保存/外部改写）→ 移除条目并返回 false（调用方随后 ensure_open 重开）。
pub(crate) fn validate_registry_entry(
    registry: &TextRegistry,
    path: &str,
) -> Result<bool, ZiEditError> {
    let entry = {
        let reg = registry
            .0
            .lock()
            .map_err(|e| ZiEditError::Msg(e.to_string()))?;
        reg.get(path)
            .map(|tf| (tf.cache.lock().map(|c| c.len()).unwrap_or(0), tf.mtime))
    };
    let Some((cache_len, entry_mtime)) = entry else {
        return Ok(false);
    };
    let p = PathBuf::from(path);
    let meta = match std::fs::metadata(&p) {
        Ok(m) => m,
        Err(_) => {
            invalidate(registry, path)?;
            return Ok(false);
        }
    };
    let disk_mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if cache_len == meta.len() && entry_mtime == disk_mtime {
        Ok(true)
    } else {
        invalidate(registry, path)?;
        Ok(false)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextOpenResult {
    pub path: String,
    pub len: u64,
    pub encoding: EncodingInfo,
    /// 换行类型（多数派主类型）：crlf / lf / cr / none
    pub newline: String,
    /// 是否混合行尾（次类占比 ≥2%：保存按主类型统一，前端提示）
    pub mixed: bool,
    /// 打开瞬间已知的总行数（0 = 索引后台构建中，等事件）
    pub total_lines: u64,
    pub index_ready: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLine {
    pub no: u64,
    pub text: String,
}

/// 超长单行的有界分段结果。offset/next_offset 均为该逻辑行内的原始字节偏移，
/// 前端可以按段翻页而不把整行复制进 WebView。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLineSegment {
    pub no: u64,
    pub offset: u64,
    pub next_offset: Option<u64>,
    pub total_bytes: u64,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindHit {
    pub line: u64,
    pub col: u64, // 1 起的字符列
}

/// 打开核心（提取，无 registry/app 依赖，供 ensure_open 与单测组合）：
/// stat 一次供 mtime 基线与探测缓存键；探测走 (path,len,mtime) 缓存，
/// 未命中时一次头 64KB 读喂编码探测并预热块 0（随后 detect_newline 命中零额外 I/O）。
fn open_text_file(
    p: &Path,
    preferred: Option<&str>,
) -> Result<(ChunkCache, EncodingInfo, u64), ZiEditError> {
    let meta = std::fs::metadata(p).map_err(|e| ZiEditError::ctx("Open failed", e))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut cache = ChunkCache::open(p).map_err(|e| ZiEditError::ctx("Open failed", e))?;
    let encoding = match preferred {
        Some(name) => EncodingInfo {
            name: name.into(),
            source: encoding::EncodingSource::Manual,
            verified: false,
        },
        None => {
            let (info, head) = encoding::detect_cached_keep_head(p)
                .map_err(|e| ZiEditError::ctx("Encoding detection failed", e))?;
            if let Some(head) = head {
                cache.warm_block(0, head);
            }
            info
        }
    };
    Ok((cache, encoding, mtime))
}

pub(crate) fn ensure_open(
    registry: &TextRegistry,
    app: &AppHandle,
    path: &str,
    preferred: Option<&str>,
) -> Result<(), ZiEditError> {
    let preferred = preferred
        .map(|name| {
            encoding_rs::Encoding::for_label(name.as_bytes())
                .map(|enc| enc.name())
                .ok_or_else(|| ZiEditError::Encode(crate::error::EncodeError::Unknown(name.into())))
        })
        .transpose()?;
    // 后台标签可能已被外部改写；命中前按长度/mtime 对账，失配后沿用重开路径。
    validate_registry_entry(registry, path)?;
    let mut reg = registry
        .0
        .lock()
        .map_err(|e| ZiEditError::Msg(e.to_string()))?;
    if let Some(tf) = reg.get_mut(path) {
        if preferred.is_none_or(|name| name == tf.encoding.name) {
            tf.last_used = Instant::now();
            return Ok(());
        }
        // 编码决定行界码元宽度；不能沿用另一编码建立的字节偏移。
        reg.remove(path);
    }
    let p = PathBuf::from(path);
    let (mut cache, encoding, mtime) = open_text_file(&p, preferred)?;
    let len = cache.len();
    let index_encoding = encoding.name.clone();
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    if reg.len() >= REGISTRY_CAP
        && let Some(victim) = reg
            .iter()
            .min_by_key(|(_, tf)| tf.last_used)
            .map(|(key, _)| key.clone())
    {
        reg.remove(&victim);
    }
    let (index_ready, total) = if len <= SYNC_INDEX_LIMIT {
        // 索引经块缓存顺序扫描（减读）：同一遍磁盘读取同时建行索引并填充块缓存，
        // 随后的 text_read_all / 滚动窗口全部内存命中——不再对文件主体二读磁盘
        let idx = build_index_cached(&mut cache, &index_encoding)?;
        let t = idx.total_lines;
        reg.insert(
            path.to_string(),
            TextFile {
                cache: Arc::new(Mutex::new(cache)),
                index: Some(Arc::new(idx)),
                encoding,
                mtime,
                generation,
                last_used: Instant::now(),
            },
        );
        (true, t)
    } else {
        reg.insert(
            path.to_string(),
            TextFile {
                cache: Arc::new(Mutex::new(cache)),
                index: None,
                encoding,
                mtime,
                generation,
                last_used: Instant::now(),
            },
        );
        drop(reg);
        // 后台构建索引，完成后发事件
        let key = path.to_string();
        let pp = p.clone();
        let app2 = app.clone();
        std::thread::spawn(move || match build_index_encoded(&pp, &index_encoding) {
            Ok(idx) => {
                let total = idx.total_lines;
                let state = app2.state::<TextRegistry>();
                if let Ok(mut reg) = state.0.lock()
                    && let Some(tf) = reg.get_mut(&key)
                    && tf.generation == generation
                {
                    tf.index = Some(Arc::new(idx));
                } else {
                    return;
                }
                let _ = app2.emit(
                    "text-index",
                    serde_json::json!({ "path": key, "totalLines": total }),
                );
            }
            Err(e) => {
                let _ = app2.emit(
                    "text-index",
                    serde_json::json!({ "path": key, "error": e.to_string() }),
                );
            }
        });
        (false, 0)
    };
    let _ = index_ready;
    let _ = total;
    Ok(())
}

#[tauri::command]
pub async fn text_open(
    app: AppHandle,
    registry: tauri::State<'_, TextRegistry>,
    path: String,
    encoding_name: Option<String>,
) -> Result<TextOpenResult, ZiEditError> {
    ensure_open(&registry, &app, &path, encoding_name.as_deref())?;
    let mut reg = registry
        .0
        .lock()
        .map_err(|e| ZiEditError::Msg(e.to_string()))?;
    let tf = reg
        .get_mut(&path)
        .ok_or_else(|| ZiEditError::Msg("Internal state missing".into()))?;
    // 块缓存持有打开瞬间的权威长度（修前再 stat 一次磁盘，减读）
    let len = tf
        .cache
        .lock()
        .map_err(|e| ZiEditError::Msg(e.to_string()))?
        .len();
    let (newline, mixed) = detect_newline(tf);
    Ok(TextOpenResult {
        path: path.clone(),
        len,
        encoding: tf.encoding.clone(),
        newline,
        mixed,
        total_lines: tf.index.as_ref().map(|i| i.total_lines).unwrap_or(0),
        index_ready: tf.index.is_some(),
    })
}

/// 磁盘 mtime（毫秒）
fn disk_mtime(p: &std::path::Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 首块行尾统计：返回 (主类型, 是否混合)。
/// 修复：块尾 `\r` 与下一块首字节联合判定（不再把 `\r\n` 误报成 cr）；
/// 混合判定：至少两类行尾且次类 ≥ 总数的 2%（可感知才报 mixed）。
/// 块读取走 ChunkCache（ensure_open 已用编码探测的头部采样预热块 0，通常零额外 I/O）。
fn detect_newline(tf: &mut TextFile) -> (String, bool) {
    let mut cache = match tf.cache.lock() {
        Ok(c) => c,
        Err(_) => return ("none".into(), false),
    };
    let raw = match cache.read_chunk(0) {
        Ok(c) => c,
        Err(_) => return ("none".into(), false),
    };
    if raw.is_empty() {
        return ("none".into(), false);
    }
    let (decoded, _) = encoding::decode(&raw, &tf.encoding.name);
    let chunk = decoded.as_bytes();
    let mut crlf = 0u64;
    let mut lf = 0u64;
    let mut cr = 0u64;
    let mut i = 0usize;
    while i < chunk.len() {
        match chunk[i] {
            b'\n' => {
                lf += 1;
                i += 1;
            }
            b'\r' => {
                if i + 1 < chunk.len() {
                    if chunk[i + 1] == b'\n' {
                        crlf += 1;
                    } else {
                        cr += 1;
                    }
                    i += if chunk[i + 1] == b'\n' { 2 } else { 1 };
                } else {
                    // 块尾 \r：读下一块首字节判定（文件尾则视为 lone \r）
                    let next_first = cache
                        .read_chunk(1)
                        .ok()
                        .and_then(|c| encoding::decode(&c, &tf.encoding.name).0.bytes().next());
                    if next_first == Some(b'\n') {
                        crlf += 1;
                    } else {
                        cr += 1;
                    }
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
    let total = crlf + lf + cr;
    if total == 0 {
        return ("none".into(), false);
    }
    let (major, major_n) = [("crlf", crlf), ("lf", lf), ("cr", cr)]
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .unwrap();
    let second = total - major_n;
    let mixed = second > 0 && second * 50 >= total;
    (major.into(), mixed)
}

/// 逻辑行切分：`\n` 或 lone `\r` 均为行界（`\r\n` 只切一次）；行内容不含行尾。
/// 与 file_engine 的 build_index/count_eols 同语义（CR 文件可读，002 规则 4 v1.4）。
fn split_lines(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                out.push(&text[start..i]);
                i += 1;
                start = i;
            }
            b'\r' => {
                let eol = if bytes.get(i + 1) == Some(&b'\n') {
                    2
                } else {
                    1
                };
                out.push(&text[start..i]);
                i += eol;
                start = i;
            }
            _ => i += 1,
        }
    }
    if start < bytes.len() {
        out.push(&text[start..]);
    }
    out
}

/// 读取行区间 [from, to]（1 起含两端），按给定编码名解码。
/// 索引未就绪时返回 Err("INDEXING")。
/// 锁收窄：registry 锁只做 map 查询拿 Arc 快照，读取/解码/切行/collect 全在锁外。
#[tauri::command]
pub async fn text_lines(
    app: AppHandle,
    registry: tauri::State<'_, TextRegistry>,
    path: String,
    from: u64,
    to: u64,
    encoding_name: Option<String>,
) -> Result<Vec<TextLine>, ZiEditError> {
    if from == 0 || to < from {
        return Err(ZiEditError::Msg(
            "Line numbers start at 1 and to >= from".into(),
        ));
    }
    // 服务端窗口钳制（M8）：单次 ≤5000 行，防大相等块整读触碰性能红线
    let to = to.min(from.saturating_add(4999));
    ensure_open(&registry, &app, &path, encoding_name.as_deref())?;
    // registry 锁内只取快照（cache 与 index 的 Arc + 编码名 + 空文件判定）
    let (cache, index, enc_name, empty) = {
        let mut reg = registry
            .0
            .lock()
            .map_err(|e| ZiEditError::Msg(e.to_string()))?;
        let tf = reg
            .get_mut(&path)
            .ok_or_else(|| ZiEditError::Msg("File is not open".into()))?;
        tf.last_used = Instant::now();
        let empty = tf
            .cache
            .lock()
            .map_err(|e| ZiEditError::Msg(e.to_string()))?
            .is_empty();
        (
            tf.cache.clone(),
            tf.index.clone(),
            encoding_name.unwrap_or_else(|| tf.encoding.name.clone()),
            empty,
        )
    };
    if empty {
        return Ok(vec![TextLine {
            no: 1,
            text: String::new(),
        }]);
    }
    let index = index.ok_or(ZiEditError::Indexing)?;
    let total = index.total_lines;
    if from > total {
        return Ok(Vec::new());
    }
    let want = (to - from + 1).min(total.saturating_sub(from - 1)).max(1);
    // 锁外：跳转 + 窗口读取 + 解码 + 切行 + collect（仅持 per-file cache 锁）
    let (raw, want) = {
        let mut cache = cache.lock().map_err(|e| ZiEditError::Msg(e.to_string()))?;
        let offset = jump_to_line(&mut cache, &index, from - 1)
            .ok_or_else(|| ZiEditError::Msg("Locate failed".into()))?;
        read_window(&mut cache, offset, want, index.utf16)?
    };
    let (text, _replaced) = encoding::decode(&raw, &enc_name);
    let lines: Vec<TextLine> = split_lines(&text)
        .into_iter()
        .take(want as usize)
        .enumerate()
        .map(|(i, l)| TextLine {
            no: from + i as u64,
            text: l.to_string(),
        })
        .collect();
    Ok(lines)
}

const LINE_SEGMENT_BYTES: u64 = 256 * 1024;

fn unit_at(cache: &mut ChunkCache, pos: u64, utf16: Option<bool>) -> std::io::Result<Option<u16>> {
    if pos >= cache.len() {
        return Ok(None);
    }
    let chunk = cache.read_chunk(pos / CHUNK as u64)?;
    let at = (pos % CHUNK as u64) as usize;
    if utf16.is_some() {
        if at + 1 >= chunk.len() {
            return Ok(None);
        }
        let pair = [chunk[at], chunk[at + 1]];
        Ok(Some(if utf16 == Some(true) {
            u16::from_le_bytes(pair)
        } else {
            u16::from_be_bytes(pair)
        }))
    } else {
        Ok(Some(u16::from(chunk[at])))
    }
}

/// 返回一行内容的原始字节边界（不含 CR/LF），扫描只保留一个分块。
fn line_content_end(
    cache: &mut ChunkCache,
    start: u64,
    utf16: Option<bool>,
) -> std::io::Result<u64> {
    let width = if utf16.is_some() { 2 } else { 1 };
    let mut pos = start;
    while pos < cache.len() {
        let idx = pos / CHUNK as u64;
        let base = idx * CHUNK as u64;
        let chunk = cache.read_chunk(idx)?;
        let begin = (pos - base) as usize;
        let end = chunk.len().saturating_sub(width - 1);
        for at in (begin..end).step_by(width) {
            let unit = if width == 2 {
                let pair = [chunk[at], chunk[at + 1]];
                if utf16 == Some(true) {
                    u16::from_le_bytes(pair)
                } else {
                    u16::from_be_bytes(pair)
                }
            } else {
                u16::from(chunk[at])
            };
            if unit == 10 || unit == 13 {
                let content_end = base + at as u64;
                return Ok(content_end);
            }
        }
        pos = base + chunk.len() as u64;
    }
    Ok(cache.len())
}

fn aligned_segment_start(
    cache: &mut ChunkCache,
    line_start: u64,
    offset: u64,
    total: u64,
    encoding_name: &str,
    utf16: Option<bool>,
) -> Result<u64, ZiEditError> {
    let mut at = line_start.saturating_add(offset.min(total));
    if utf16.is_some() {
        at = line_start + (at.saturating_sub(line_start) / 2) * 2;
    } else if encoding_name.eq_ignore_ascii_case("UTF-8") {
        // 上一段从多字节字符中间结束时，向前退到字符首字节，避免下一段首字符变成 U+FFFD。
        while at > line_start && at > 0 {
            let b = unit_at(cache, at, None)?.unwrap_or(0) as u8;
            if b & 0xc0 != 0x80 {
                break;
            }
            at -= 1;
        }
    }
    Ok(at)
}

fn read_raw_range(cache: &mut ChunkCache, from: u64, len: u64) -> Result<Vec<u8>, ZiEditError> {
    let mut out = Vec::with_capacity(len as usize);
    let mut at = from;
    let end = from.saturating_add(len).min(cache.len());
    while at < end {
        let idx = at / CHUNK as u64;
        let chunk = cache.read_chunk(idx)?;
        let begin = (at % CHUNK as u64) as usize;
        let take = (end - at).min((chunk.len() - begin) as u64) as usize;
        out.extend_from_slice(&chunk[begin..begin + take]);
        at += take as u64;
    }
    Ok(out)
}

/// 读取超长单行的一个有界片段。普通行仍由 text_lines 承载，只有超过 4MiB 行窗时由前端调用。
#[tauri::command]
pub async fn text_line_segment(
    app: AppHandle,
    registry: tauri::State<'_, TextRegistry>,
    path: String,
    line: u64,
    offset: u64,
    max_bytes: Option<u64>,
    encoding_name: Option<String>,
) -> Result<TextLineSegment, ZiEditError> {
    if line == 0 {
        return Err(ZiEditError::Msg("Line numbers start at 1".into()));
    }
    ensure_open(&registry, &app, &path, encoding_name.as_deref())?;
    // registry 锁内只取快照（锁收窄，同 text_lines）
    let (cache, index, enc_name) = {
        let mut reg = registry
            .0
            .lock()
            .map_err(|e| ZiEditError::Msg(e.to_string()))?;
        let tf = reg
            .get_mut(&path)
            .ok_or_else(|| ZiEditError::Msg("File is not open".into()))?;
        (tf.cache.clone(), tf.index.clone(), tf.encoding.name.clone())
    };
    let index = index.ok_or(ZiEditError::Indexing)?;
    if line > index.total_lines {
        return Err(ZiEditError::Msg("Line is out of range".into()));
    }
    // 锁外：跳转 + 行边界扫描 + 分段读取（仅持 per-file cache 锁）
    let mut cache = cache.lock().map_err(|e| ZiEditError::Msg(e.to_string()))?;
    let line_start = jump_to_line(&mut cache, &index, line - 1)
        .ok_or_else(|| ZiEditError::Msg("Locate failed".into()))?;
    let content_end = line_content_end(&mut cache, line_start, index.utf16)?;
    let total = content_end.saturating_sub(line_start);
    let wanted = max_bytes
        .unwrap_or(LINE_SEGMENT_BYTES)
        .clamp(1024, LINE_SEGMENT_BYTES);
    let actual_start = aligned_segment_start(
        &mut cache,
        line_start,
        offset,
        total,
        &enc_name,
        index.utf16,
    )?;
    let mut raw = read_raw_range(
        &mut cache,
        actual_start,
        wanted.min(content_end.saturating_sub(actual_start)),
    )?;
    if enc_name.eq_ignore_ascii_case("UTF-8") {
        while !raw.is_empty() && std::str::from_utf8(&raw).is_err() {
            raw.pop();
        }
    }
    let consumed = raw.len() as u64;
    let (text, _) = encoding::decode(&raw, &enc_name);
    let next = actual_start
        .saturating_add(consumed)
        .checked_sub(line_start)
        .filter(|v| *v < total);
    Ok(TextLineSegment {
        no: line,
        offset: actual_start - line_start,
        next_offset: next,
        total_bytes: total,
        text,
    })
}

/// 大行窗口自动缩小，但单行超预算显式报错，绝不静默截断内容。
fn read_window(
    cache: &mut ChunkCache,
    offset: u64,
    mut want: u64,
    utf16: Option<bool>,
) -> Result<(Vec<u8>, u64), ZiEditError> {
    loop {
        match cache.read_lines_encoded(offset, want, utf16) {
            Ok(raw) => return Ok((raw, want)),
            Err(e) if want > 1 && e.to_string().contains("LINE_WINDOW_TOO_LARGE") => {
                want = (want / 2).max(1)
            }
            Err(e) => return Err(ZiEditError::Io(e)),
        }
    }
}

#[tauri::command]
pub async fn text_close(
    registry: tauri::State<'_, TextRegistry>,
    path: String,
) -> Result<(), ZiEditError> {
    registry
        .0
        .lock()
        .map_err(|e| ZiEditError::Msg(e.to_string()))?
        .remove(&path);
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

/// 查找结果（002 规则 7 v1.3 统一查找栏）：命中 + 计数（want_count=true 时统计）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub hit: Option<FindHit>,
    /// 全文命中总数（未请求计数为 None）
    pub total: Option<u64>,
    /// 命中之前的匹配数（"第 N 处" = before + 1；未计数为 None）
    pub before: Option<u64>,
}

/// 大小写折叠 + 偏移映射（RUST-02，审计 2026-10-17）：`to_lowercase` 会改变字节数
/// （İ U+0130 2B → i̇ 3B；ß 2B → ss 2B 等），折叠串上的字节偏移不能直接当原文偏移用——
/// 修前调用方 `l[..col]` 遇非字符边界即 panic（release `panic=abort` 整进程退出）。
/// 构建折叠串时同步产出「折叠字节位 → 原文字节位」映射（每个折叠产出字节记其源字符起点；
/// 映射值恒为原文字符边界）。大小写敏感路径不折叠、映射为空（恒等）。
fn fold_with_map(line: &str) -> (String, Vec<usize>) {
    let mut hay = String::with_capacity(line.len());
    let mut map: Vec<usize> = Vec::with_capacity(line.len() + 4);
    for (b, ch) in line.char_indices() {
        for lc in ch.to_lowercase() {
            let before = hay.len();
            hay.push(lc);
            // 逐字节登记（折叠字符可占多字节：U+0307 = 2B——每字节都要指向源字符起点）
            for _ in before..hay.len() {
                map.push(b);
            }
        }
    }
    (hay, map)
}

/// 折叠串字节位 → 原文字节位（map 为空=大小写敏感恒等；越界=行尾）
fn orig_byte(map: &[usize], line: &str, hay_at: usize) -> usize {
    if map.is_empty() {
        hay_at
    } else if hay_at < map.len() {
        map[hay_at]
    } else {
        line.len()
    }
}

/// 行内全部命中的**原文字节偏移**（恒为字符边界；列口径由调用方处理）。
/// 单一判决：文本查看态查找（text_find）与文件树全项目查找（find_in_files）共用本函数，
/// 大小写/全字/正则三种口径只此一处，两条查找路径不可能再各自漂移。
pub(crate) fn find_all_in(
    l: &str,
    re: Option<&regex::Regex>,
    needle: &str,
    case_sensitive: bool,
    whole_word: bool,
) -> Vec<usize> {
    let mut out = Vec::new();
    if let Some(re) = re {
        for m in re.find_iter(l) {
            let word = |ch: char| ch.is_alphanumeric() || ch == '_';
            let before = l[..m.start()].chars().next_back().is_some_and(word);
            let after = l[m.end()..].chars().next().is_some_and(word);
            if !whole_word || !before && !after {
                out.push(m.start());
            }
        }
        return out;
    }
    let (hay, map): (String, Vec<usize>) = if case_sensitive {
        (l.to_string(), Vec::new())
    } else {
        fold_with_map(l)
    };
    let ned = if case_sensitive {
        needle.to_string()
    } else {
        needle.to_lowercase()
    };
    if !whole_word {
        let mut idx = 0;
        while let Some(p) = hay[idx..].find(&ned) {
            let at = idx + p;
            out.push(orig_byte(&map, l, at)); // 折叠偏移 → 原文边界
            idx = at + ned.len().max(1);
        }
        return out;
    }
    // 全字：按字符扫描（与 find_in 同口径）；偏移同样经映射回原文
    let nchars: Vec<char> = ned.chars().collect();
    let hchars: Vec<char> = hay.chars().collect();
    if nchars.is_empty() || hchars.len() < nchars.len() {
        return out;
    }
    let starts: Vec<usize> = hay.char_indices().map(|(b, _)| b).collect();
    for start in 0..=(hchars.len() - nchars.len()) {
        if hchars[start..start + nchars.len()] == nchars[..] {
            let before_ok =
                start == 0 || !hchars[start - 1].is_alphanumeric() && hchars[start - 1] != '_';
            let after = start + nchars.len();
            let after_ok =
                after >= hchars.len() || !hchars[after].is_alphanumeric() && hchars[after] != '_';
            if before_ok && after_ok {
                // 折叠字符的 hay 字节起点 → 原文字节边界
                out.push(orig_byte(&map, l, starts[start]));
            }
        }
    }
    out
}

/// 查找正则小缓存（最近 8 条）：text_find 每次调用重编译正则 → 复用编译产物（小项）
type RegexCacheEntry = (String, Arc<regex::Regex>);

fn cached_regex(pat: &str) -> Result<Arc<regex::Regex>, String> {
    const CAP: usize = 8;
    fn cache() -> &'static Mutex<Vec<RegexCacheEntry>> {
        static CACHE: OnceLock<Mutex<Vec<RegexCacheEntry>>> = OnceLock::new();
        CACHE.get_or_init(|| Mutex::new(Vec::new()))
    }
    if let Ok(mut c) = cache().lock()
        && let Some(pos) = c.iter().position(|(p, _)| p == pat)
    {
        let entry = c.remove(pos);
        c.push(entry); // 移到尾部 = 最近使用
        return Ok(c.last().expect("just pushed").1.clone());
    }
    let re = Arc::new(regex::Regex::new(pat).map_err(|e| e.to_string())?);
    if let Ok(mut c) = cache().lock() {
        if c.len() >= CAP {
            c.remove(0); // 淘汰最旧
        }
        c.push((pat.into(), re.clone()));
    }
    Ok(re)
}

/// 统一查找（002 规则 7 v1.3）：从 from_line 起找下一个匹配；backward=true 找 from_line 之前的
/// 最后一个匹配（环绕语义由前端二次调用实现）；want_count=true 时统计全文命中与序数。
/// 锁粒度 per-batch：大文件查找不再长时间阻塞其他文件的读取（性能整改）。
#[tauri::command]
// 保留既有 IPC 参数名，避免仅为 lint 改变调用契约。
#[allow(clippy::too_many_arguments)]
pub async fn text_find(
    app: AppHandle,
    registry: tauri::State<'_, TextRegistry>,
    path: String,
    needle: String,
    opts: FindOptions,
    from_line: u64,
    want_count: Option<bool>,
    backward: Option<bool>,
) -> Result<FindResult, ZiEditError> {
    if needle.is_empty() {
        return Ok(FindResult {
            hit: None,
            total: Some(0),
            before: None,
        });
    }
    ensure_open(&registry, &app, &path, None)?;
    let want_count = want_count.unwrap_or(false);
    let backward = backward.unwrap_or(false);
    let re = if opts.regex {
        let pat = if opts.case_sensitive {
            needle.clone()
        } else {
            format!("(?i){}", needle)
        };
        Some(cached_regex(&pat).map_err(|e| ZiEditError::Msg(format!("Regex error: {e}")))?)
    } else {
        None
    };
    let mut line: u64 = 1;
    let mut total_seen: u64 = 0; // 已扫过的命中数
    let mut hit: Option<FindHit> = None;
    let mut hit_before: u64 = 0; // 命中处之前的匹配数（正向计数路径用）
    loop {
        // 每批重新取快照：保留关闭/刷新文件时的批间可见性。
        // 批内先拿 cache/index 的 Arc 快照再锁 cache 做 I/O——registry 锁不再覆盖读取全程。
        let (cache, index, enc_name) = {
            let mut reg = registry
                .0
                .lock()
                .map_err(|e| ZiEditError::Msg(e.to_string()))?;
            let tf = reg
                .get_mut(&path)
                .ok_or_else(|| ZiEditError::Msg("File is not open".into()))?;
            (tf.cache.clone(), tf.index.clone(), tf.encoding.name.clone())
        };
        let index = index.ok_or(ZiEditError::Indexing)?;
        let total_lines = index.total_lines;
        if line > total_lines {
            break;
        }
        let want = FIND_BATCH_LINES.min(total_lines - line + 1);
        let (raw, want) = {
            let mut cache = cache.lock().map_err(|e| ZiEditError::Msg(e.to_string()))?;
            let offset = jump_to_line(&mut cache, &index, line - 1)
                .ok_or_else(|| ZiEditError::Msg("Locate failed".into()))?;
            read_window(&mut cache, offset, want, index.utf16)?
        };
        let (text, _) = encoding::decode(&raw, &enc_name);
        for (i, l) in split_lines(&text)
            .into_iter()
            .take(want as usize)
            .enumerate()
        {
            let cols = find_all_in(
                l,
                re.as_deref(),
                &needle,
                opts.case_sensitive,
                opts.whole_word,
            );
            if cols.is_empty() {
                continue;
            }
            let line_no = line + i as u64;
            if !backward {
                if hit.is_none() && line_no >= from_line.max(1) {
                    let col = l[..cols[0]].chars().count() as u64 + 1;
                    hit = Some(FindHit { line: line_no, col });
                    hit_before = total_seen;
                    if !want_count {
                        return Ok(FindResult {
                            hit,
                            total: None,
                            before: None,
                        });
                    }
                }
            } else if line_no < from_line.max(1) {
                // 反向：记录 from_line 之前的最后一个命中（计数统一由正向 count-only 扫描提供）
                let col = l[..cols[0]].chars().count() as u64 + 1;
                hit = Some(FindHit { line: line_no, col });
            }
            total_seen += cols.len() as u64;
        }
        // 反向模式扫到 from_line 即停；环绕（找全文最后一个）由前端传超大 from_line 实现
        if backward && line >= from_line.max(1) {
            return Ok(FindResult {
                hit,
                total: None,
                before: None,
            });
        }
        line += want;
    }
    let has_hit = hit.is_some();
    Ok(FindResult {
        hit,
        total: if want_count { Some(total_seen) } else { None },
        before: if has_hit && want_count {
            Some(hit_before)
        } else {
            None
        },
    })
}

/// 探测文件是否变化（日志跟随用）：变化则换新缓存并后台重建索引（发 text-index 事件）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRefreshResult {
    pub len: u64,
    pub changed: bool,
}

#[tauri::command]
pub async fn text_refresh(
    app: AppHandle,
    registry: tauri::State<'_, TextRegistry>,
    path: String,
) -> Result<TextRefreshResult, ZiEditError> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p)?;
    let disk_len = meta.len();
    let disk_m = disk_mtime(&p);
    // 刷新必须先比较旧基线，不能让 ensure_open 提前重开而吞掉 changed 信号。
    let is_open = registry
        .0
        .lock()
        .map_err(|e| ZiEditError::Msg(e.to_string()))?
        .contains_key(&path);
    if !is_open {
        ensure_open(&registry, &app, &path, None)?;
    }
    let mut reg = registry
        .0
        .lock()
        .map_err(|e| ZiEditError::Msg(e.to_string()))?;
    let tf = reg
        .get_mut(&path)
        .ok_or_else(|| ZiEditError::Msg("File is not open".into()))?;
    // 等长改写也能检测（M11）：长度或 mtime 任一变化即判定变更
    {
        let cache_len = tf
            .cache
            .lock()
            .map_err(|e| ZiEditError::Msg(e.to_string()))?
            .len();
        if cache_len == disk_len && tf.mtime == disk_m {
            return Ok(TextRefreshResult {
                len: disk_len,
                changed: false,
            });
        }
    }
    let encoding = tf.encoding.clone();
    let fresh = ChunkCache::open(&p)?;
    // 换新缓存（Arc 替换）：持旧 Arc 快照的并发读取继续读旧内容，不撕裂（Arc 快照模式）
    tf.cache = Arc::new(Mutex::new(fresh));
    tf.index = None;
    tf.mtime = disk_m;
    tf.generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let generation = tf.generation;
    tf.encoding = encoding;
    let index_encoding = tf.encoding.name.clone();
    drop(reg);
    let key = path.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        let idx = match build_index_encoded(&p, &index_encoding) {
            Ok(i) => i,
            Err(e) => {
                let _ = app2.emit(
                    "text-index",
                    serde_json::json!({ "path": key, "error": e.to_string() }),
                );
                return;
            }
        };
        let total = idx.total_lines;
        let state = app2.state::<TextRegistry>();
        if let Ok(mut reg) = state.0.lock()
            && let Some(tf) = reg.get_mut(&key)
            && tf.generation == generation
        {
            tf.index = Some(Arc::new(idx));
        } else {
            return;
        }
        let _ = app2.emit(
            "text-index",
            serde_json::json!({ "path": key, "totalLines": total }),
        );
    });
    Ok(TextRefreshResult {
        len: disk_len,
        changed: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regex_whole_word_composition() {
        let re = regex::Regex::new("err").unwrap();
        assert_eq!(
            find_all_in("error err err_1 err-2", Some(&re), "err", true, true),
            vec![6, 16]
        );
    }

    #[test]
    fn whole_word_find_all() {
        // 通用词边界约定：- 与 _ 之外的非字母数字均算词边界（_ 算词内）；find_all_in 返回全部命中的字节偏移
        assert_eq!(
            find_all_in("error code err-101", None, "err", true, true),
            vec![11]
        );
        assert_eq!(
            find_all_in("an error here", None, "error", true, true),
            vec![3]
        );
        assert_eq!(
            find_all_in("errors here", None, "error", true, true),
            Vec::<usize>::new()
        );
        assert_eq!(
            find_all_in("err_code", None, "err", true, true),
            Vec::<usize>::new()
        );
        assert_eq!(
            find_all_in("plain find", None, "find", false, false),
            vec![6]
        );
        // 多命中一行全列出（计数/全部高亮依据）
        assert_eq!(
            find_all_in("err err err", None, "err", true, false),
            vec![0, 4, 8]
        );
        // 大小写不敏感
        assert_eq!(
            find_all_in("Err eRR", None, "err", false, false),
            vec![0, 4]
        );
    }

    fn temp_text_file(name: &str, content: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("ZiEdit-text-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, content).unwrap();
        p
    }

    fn tf_of(p: &std::path::Path) -> TextFile {
        TextFile {
            cache: Arc::new(Mutex::new(ChunkCache::open(p).unwrap())),
            index: None,
            encoding: EncodingInfo {
                name: "UTF-8".into(),
                source: crate::encoding::EncodingSource::Fallback,
                verified: true,
            },
            mtime: 0,
            generation: 0,
            last_used: Instant::now(),
        }
    }

    #[test]
    fn regex_cache_roundtrip() {
        // 正则小缓存（小项）：命中复用、容量 8、错误模式不缓存
        let r1 = cached_regex("err+").unwrap();
        let r2 = cached_regex("err+").unwrap();
        assert!(
            std::sync::Arc::ptr_eq(&r1, &r2),
            "同模式必须命中同一编译产物"
        );
        for i in 0..10 {
            cached_regex(&format!("pat{i}_unique")).unwrap();
        }
        // 容量 8：最早条目被淘汰后重新编译（不再 ptr_eq），但不报错
        assert!(cached_regex("err+").is_ok());
        assert!(cached_regex("(unclosed").is_err());
    }

    /// 保存→失效→重开读取，不读回旧块；外部改写（未失效）也能被版本校验拦下。
    /// 组合层测试（text_save/text_read_all 命令带 AppHandle/State，无法在单测实例化），
    /// 逐段调用命令实现所用的同一组 pub(crate) 入口。
    #[test]
    fn save_invalidates_registry_and_read_all_sees_new_content() {
        use std::time::Duration;

        let open_into_registry = |registry: &TextRegistry, p: &std::path::Path| {
            let (cache, encoding, mtime) = open_text_file(p, None).unwrap();
            let idx = build_index_encoded(p, &encoding.name).unwrap();
            registry.0.lock().unwrap().insert(
                p.to_string_lossy().into_owned(),
                TextFile {
                    cache: Arc::new(Mutex::new(cache)),
                    index: Some(Arc::new(idx)),
                    encoding,
                    mtime,
                    generation: 0,
                    last_used: Instant::now(),
                },
            );
        };
        let read_all_via_snapshot = |registry: &TextRegistry, p: &std::path::Path| -> String {
            let snap = snapshot(registry, &p.to_string_lossy()).unwrap();
            assert!(validate_registry_entry(registry, &p.to_string_lossy()).unwrap());
            let mut out = Vec::new();
            {
                let mut cache = snap.cache.lock().unwrap();
                for idx in 0..snap.len.div_ceil(CHUNK as u64) {
                    out.extend_from_slice(&cache.read_chunk(idx).unwrap());
                }
            }
            encoding::decode(&out, &snap.encoding_name).0
        };

        let p = temp_text_file("save-invalidate.txt", b"old content line\n");
        let registry = TextRegistry::default();
        open_into_registry(&registry, &p);
        assert_eq!(read_all_via_snapshot(&registry, &p), "old content line\n");

        // ① 保存路径：写新内容 + text_save 成功后的 invalidate（同一入口）
        std::thread::sleep(Duration::from_millis(10)); // 保证 mtime 前进
        std::fs::write(&p, b"NEW content line\n").unwrap();
        invalidate(&registry, &p.to_string_lossy()).unwrap();
        // read_all 获取序列：条目不在 → ensure_open 重开 → 校验 → 快照 → 组装
        open_into_registry(&registry, &p);
        assert_eq!(read_all_via_snapshot(&registry, &p), "NEW content line\n");

        // ② 外部改写（无人失效）：validate_registry_entry 必须检出失配并移除条目
        std::thread::sleep(Duration::from_millis(10));
        std::fs::write(&p, b"external rewrite\n").unwrap();
        let path_str = p.to_string_lossy().into_owned();
        assert!(!validate_registry_entry(&registry, &path_str).unwrap());
        assert!(
            registry.0.lock().unwrap().get(&path_str).is_none(),
            "失配条目必须被移除（下次 ensure_open 重开）"
        );
        assert!(snapshot(&registry, &path_str).is_err());
        // 重开后读到最新内容
        open_into_registry(&registry, &p);
        assert_eq!(read_all_via_snapshot(&registry, &p), "external rewrite\n");
        // 等长但 mtime 失配同样淘汰，不依赖测试执行时的文件系统时钟精度。
        registry.0.lock().unwrap().get_mut(&path_str).unwrap().mtime = 0;
        assert!(!validate_registry_entry(&registry, &path_str).unwrap());
        open_into_registry(&registry, &p);
        // 长度、编码与行尾一起变化，重开必须重新探测而非沿用后台标签的元数据。
        let fresh: Vec<u8> = [
            vec![0xff, 0xfe],
            "new\r\n"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect(),
        ]
        .concat();
        std::fs::write(&p, &fresh).unwrap();
        assert!(!validate_registry_entry(&registry, &path_str).unwrap());
        open_into_registry(&registry, &p);
        let mut reg = registry.0.lock().unwrap();
        let tf = reg.get_mut(&path_str).unwrap();
        assert_eq!(tf.cache.lock().unwrap().len(), fresh.len() as u64);
        assert_eq!(tf.encoding.name, "UTF-16LE");
        assert_eq!(detect_newline(tf), ("crlf".into(), false));
    }

    #[test]
    fn newline_detect_kinds() {
        let p = temp_text_file("lf.txt", b"a\nb\nc\n");
        assert_eq!(detect_newline(&mut tf_of(&p)), ("lf".into(), false));
        let p = temp_text_file("crlf.txt", b"a\r\nb\r\n");
        assert_eq!(detect_newline(&mut tf_of(&p)), ("crlf".into(), false));
        let p = temp_text_file("cr.txt", b"a\rb\r");
        assert_eq!(detect_newline(&mut tf_of(&p)), ("cr".into(), false));
        let p = temp_text_file("none.txt", b"single line");
        assert_eq!(detect_newline(&mut tf_of(&p)), ("none".into(), false));
        // 混合：CRLF 主 + LF 次（次类 ≥2%）
        let p = temp_text_file("mixed.txt", b"a\r\nb\r\nc\nd\r\n");
        assert_eq!(detect_newline(&mut tf_of(&p)), ("crlf".into(), true));
        // 微量混杂（1/1000）不报 mixed
        let mut big = Vec::new();
        for i in 0..999 {
            big.extend_from_slice(format!("l{}\r\n", i).as_bytes());
        }
        big.extend_from_slice(b"tail\n");
        let p = temp_text_file("mostly.txt", &big);
        assert_eq!(detect_newline(&mut tf_of(&p)), ("crlf".into(), false));
        // 块尾 \r + 次块首 \n：不再误报 cr（构造 >64KB 文件，第 0 块末尾恰为 \r）
        let mut blk = Vec::new();
        while blk.len() < 64 * 1024 - 1 {
            blk.extend_from_slice(b"aaaa\r\n");
        }
        blk.push(b'\r'); // 第 0 块最后一个字节
        blk.extend_from_slice(b"\nrest\r\n");
        let p = temp_text_file("boundary.txt", &blk);
        assert_eq!(detect_newline(&mut tf_of(&p)), ("crlf".into(), false));
    }

    #[test]
    fn long_line_segment_keeps_memory_bounded() {
        let p = temp_text_file(
            "long-segment.txt",
            &[vec![b'x'; 4 * 1024 * 1024 + 123], b"\nnext".to_vec()].concat(),
        );
        let mut cache = ChunkCache::open(&p).unwrap();
        let end = line_content_end(&mut cache, 0, None).unwrap();
        assert_eq!(end, 4 * 1024 * 1024 + 123);
        let raw = read_raw_range(&mut cache, 0, LINE_SEGMENT_BYTES).unwrap();
        assert_eq!(raw.len() as u64, LINE_SEGMENT_BYTES);
        assert!(end > LINE_SEGMENT_BYTES);
        assert_eq!(
            line_content_end(&mut cache, end + 1, None).unwrap(),
            p.metadata().unwrap().len()
        );
    }

    #[test]
    fn split_lines_semantics() {
        assert_eq!(split_lines("a\r\nb\r\nc"), vec!["a", "b", "c"]);
        assert_eq!(split_lines("a\rb\rc"), vec!["a", "b", "c"]);
        assert_eq!(
            split_lines("one\r\ntwo\rthree\nfour"),
            vec!["one", "two", "three", "four"]
        );
        assert_eq!(split_lines(""), Vec::<&str>::new());
        assert_eq!(split_lines("no-eol"), vec!["no-eol"]);
        assert_eq!(split_lines("trail\n"), vec!["trail"]);
        assert_eq!(split_lines("trail\r"), vec!["trail"]);
    }

    #[test]
    fn find_case_fold_offset_map_rust02() {
        // RUST-02（审计 2026-10-17）：to_lowercase 会变字节长（İ U+0130 2B → i̇ 3B、ß→ss），
        // 折叠串上的字节偏移不得直接当原文偏移（修前 l[..col] 非边界 panic；release abort 杀进程）。
        let cols = find_all_in("İı", None, "ı", false, false);
        assert_eq!(cols, vec![2]); // İ 占 0..2，ı 在原文字节 2
        // KELVIN K（3B）→ k（1B）收缩：命中折叠位映射回原文字符起点（1）
        let cols2 = find_all_in("xKy", None, "k", false, false);
        assert_eq!(cols2, vec![1]);
        // 多命中 + 变长混合：原文字节偏移逐一正确
        let cols3 = find_all_in("aİbİc", None, "i", false, false);
        assert_eq!(cols3, vec![1, 4]);
        // 大小写敏感路径不受影响
        let cols4 = find_all_in("İı", None, "ı", true, false);
        assert_eq!(cols4, vec![2]);
        // 全字路径同样映射
        let cols5 = find_all_in("İ ı x", None, "ı", false, true);
        assert_eq!(cols5, vec![3]);
        // ASCII 快路径回归
        assert_eq!(find_all_in("abcABC", None, "b", false, false), vec![1, 4]);
    }
}
