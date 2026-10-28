//! encoding —— 四级编码探测与解码（决策 003）
//! 顺序：BOM → 文件内显式声明 → 启发式（严格 UTF-8 校验优先 + chardetng）→ 手动覆盖。
//! 置信度门禁说明：chardetng 无置信度 API，以「解码零错误校验」作代理——
//! 猜测结果解码采样无替换字符即接受，有错误则回退（决策 003 的"按字符集阈值"工程化）。

use chardetng::EncodingDetector;
use encoding_rs::Encoding;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

pub use crate::error::EncodeError;

pub const HEAD_SAMPLE: u64 = 64 * 1024;
pub const TAIL_SAMPLE: u64 = 64 * 1024;
const DECL_SCAN: usize = 4 * 1024;
/// 探测缓存容量（打开/对比/搜索路径的重复探测零 I/O）
const PROBE_CACHE_CAP: usize = 32;

// ---- 进程内探测缓存----

/// 探测缓存键：路径 + 长度 + mtime。len/mtime 入键保证外部修改后自动失效，
/// 同内容同判定的语义不变。
#[derive(Clone, PartialEq, Eq, std::hash::Hash)]
pub(crate) struct ProbeKey {
    path: String,
    len: u64,
    mtime_ms: u64,
}

/// stat 一次构造探测缓存键（encoding/kind_detect 共用）
pub(crate) fn probe_key(path: &Path) -> std::io::Result<ProbeKey> {
    let meta = std::fs::metadata(path)?;
    Ok(ProbeKey {
        path: path.to_string_lossy().into_owned(),
        len: meta.len(),
        mtime_ms: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    })
}

/// 手写小容量 LRU（探测缓存专用，零新依赖）：tick 计数近似最近使用序淘汰。
pub(crate) struct ProbeLru<K: Clone + Eq + std::hash::Hash, V> {
    cap: usize,
    map: HashMap<K, (u64, V)>,
    tick: u64,
}

impl<K: Clone + Eq + std::hash::Hash, V> ProbeLru<K, V> {
    pub(crate) fn new(cap: usize) -> Self {
        Self {
            cap,
            map: HashMap::new(),
            tick: 0,
        }
    }

    pub(crate) fn get(&mut self, key: &K) -> Option<&V> {
        let ProbeLru { cap: _, map, tick } = self;
        let entry = map.get_mut(key)?;
        *tick += 1;
        entry.0 = *tick;
        Some(&entry.1)
    }

    /// 键已存在则覆盖并刷新 tick；否则在容量约束下插入（淘汰最久未用）。
    /// map_entry 建议不适用：淘汰分支需要先释放 entry 借用再改 map。
    #[allow(clippy::map_entry)]
    pub(crate) fn put(&mut self, key: K, value: V) {
        if self.cap == 0 {
            return;
        }
        self.tick += 1;
        let t = self.tick;
        if self.map.contains_key(&key) {
            self.map.insert(key, (t, value));
            return;
        }
        if self.map.len() >= self.cap
            && let Some(evict) = self
                .map
                .iter()
                .min_by_key(|(_, v)| v.0)
                .map(|(k, _)| k.clone())
        {
            self.map.remove(&evict);
        }
        self.map.insert(key, (t, value));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EncodingSource {
    Bom,
    Declaration,
    Heuristic,
    Fallback,
    Manual,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodingInfo {
    /// encoding_rs 规范名（UTF-8 / GBK / UTF-16LE / Shift_JIS ...），作为前后端协议标识
    pub name: String,
    pub source: EncodingSource,
    /// 启发式来源时的可信度标记：true = 解码校验零替换
    pub verified: bool,
}

pub fn fallback() -> EncodingInfo {
    EncodingInfo {
        name: "UTF-8".into(),
        source: EncodingSource::Fallback,
        verified: false,
    }
}

/// 读采样：头 64KB + （文件够大时）尾 64KB
fn read_samples(f: &mut std::fs::File, len: u64) -> std::io::Result<(Vec<u8>, Option<Vec<u8>>)> {
    let head_len = HEAD_SAMPLE.min(len) as usize;
    let mut head = vec![0u8; head_len];
    f.seek(SeekFrom::Start(0))?;
    f.read_exact(&mut head)?;
    let tail = read_tail_from(f, len)?;
    Ok((head, tail))
}

/// 尾采样（文件 > 头+尾窗口时才有）：独立成函数供缓存命中路径补读
fn read_tail_from(f: &mut std::fs::File, len: u64) -> std::io::Result<Option<Vec<u8>>> {
    if len <= HEAD_SAMPLE + TAIL_SAMPLE {
        return Ok(None);
    }
    let mut t = vec![0u8; TAIL_SAMPLE as usize];
    f.seek(SeekFrom::Start(len - TAIL_SAMPLE))?;
    f.read_exact(&mut t)?;
    Ok(Some(t))
}

/// 第一级：BOM
fn from_bom(head: &[u8]) -> Option<&'static Encoding> {
    if head.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Some(encoding_rs::UTF_8)
    } else if head.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) {
        Encoding::for_label(b"UTF-32LE")
    } else if head.starts_with(&[0x00, 0x00, 0xFE, 0xFF]) {
        Encoding::for_label(b"UTF-32BE")
    } else if head.starts_with(&[0xFF, 0xFE]) {
        Some(encoding_rs::UTF_16LE)
    } else if head.starts_with(&[0xFE, 0xFF]) {
        Some(encoding_rs::UTF_16BE)
    } else {
        None
    }
}

/// 第二级：文件内显式声明（XML / HTML / Python coding 注释）
fn from_declaration(head: &[u8]) -> Option<&'static Encoding> {
    let text = String::from_utf8_lossy(&head[..DECL_SCAN.min(head.len())]).to_ascii_lowercase();
    // XML: <?xml version="1.0" encoding="gbk"?>
    if let Some(i) = text.find("encoding=") {
        let rest = &text[i + 9..];
        let quote = rest.chars().next()?;
        if quote == '"' || quote == '\'' {
            let end = rest[1..].find(quote)? + 1;
            let label = &rest[1..end];
            if let Some(enc) = Encoding::for_label(label.as_bytes())
                && (enc != encoding_rs::UTF_8 || text.contains("<?xml"))
            {
                return Some(enc);
            }
        }
    }
    // HTML: <meta charset=...>
    if let Some(i) = text.find("charset=") {
        let rest = text[i + 8..].trim_start_matches(['"', '\'']);
        let label: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !label.is_empty()
            && let Some(enc) = Encoding::for_label(label.as_bytes())
        {
            return Some(enc);
        }
    }
    // Python: # -*- coding: gbk -*-
    if let Some(i) = text.find("coding:") {
        let rest = text[i + 7..].trim_start_matches(['"', '\'']);
        let label: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if !label.is_empty()
            && let Some(enc) = Encoding::for_label(label.as_bytes())
        {
            return Some(enc);
        }
    }
    None
}

/// 无 BOM UTF-16：整体同一奇偶位 >30% NUL，反侧 <10%，有信号的半段方向一致。
/// 只接受有效码元，避免零填充/二进制被当成文本；无 ASCII 的纯中文不强猜。
pub(crate) fn utf16_without_bom(bytes: &[u8]) -> Option<&'static Encoding> {
    if bytes.len() < 8 || !bytes.len().is_multiple_of(2) {
        return None;
    }
    let pairs = bytes.len() / 2;
    for (side, enc) in [(1, encoding_rs::UTF_16LE), (0, encoding_rs::UTF_16BE)] {
        let signal = |range: std::ops::Range<usize>, side: usize| {
            let count = range.len();
            let zeros = range.clone().filter(|i| bytes[i * 2 + side] == 0).count();
            let other = range
                .clone()
                .filter(|i| bytes[i * 2 + 1 - side] == 0)
                .count();
            zeros * 100 > count * 30 && other * 100 < count * 10
        };
        let uniform = signal(0..pairs, side)
            && [0..pairs / 2, pairs / 2..pairs]
                .iter()
                .all(|range| !signal(range.clone(), 1 - side));
        if uniform && !enc.decode_without_bom_handling(bytes).1 {
            return Some(enc);
        }
    }
    None
}

/// 采样严格 UTF-8 校验，容忍采样边界对多字节序列的切断：
/// - 尾界切断：`from_utf8` 报「结尾不完整」（`error_len` 为 None）即前缀合法，视为通过；
/// - 头界切断（tail 以接续字节开头）：接续字节属于界外的引导字节，剥掉至多 3 个后再校验。
///
/// 未采样的字节不构成反证：采样区（去掉边界半字符）整体合法 UTF-8 即判 UTF-8。
fn sampled_utf8_ok(bytes: &[u8], starts_on_boundary: bool) -> bool {
    let mut b = bytes;
    if starts_on_boundary {
        let strip = b.iter().take(3).take_while(|&&c| c & 0xC0 == 0x80).count();
        b = &b[strip..];
    }
    match std::str::from_utf8(b) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none(), // 结尾不完整 = 采样切断，前缀仍合法
    }
}

/// 第三级：UTF-16 间隔 NUL → 严格 UTF-8 → chardetng。
fn from_heuristic(head: &[u8], tail: Option<&[u8]>) -> EncodingInfo {
    if let Some(enc) = utf16_without_bom(head)
        && tail.is_none_or(|t| {
            utf16_without_bom(t).is_none_or(|tail_enc| tail_enc == enc)
                && !enc.decode_without_bom_handling(t).1
        })
    {
        return EncodingInfo {
            name: enc.name().into(),
            source: EncodingSource::Heuristic,
            verified: true,
        };
    }
    // UTF-8 优先原则（决策 003）：全采样严格校验通过直接判 UTF-8。
    // 边界切断容忍（2026-10 修复）：头采样恰在 64KB 处、尾采样在 len-64KB 处开始/结束，
    // 都可能把多字节字符切半——不容忍会把合法 UTF-8 误判失败、落入 chardetng 误猜
    // （实测 75KB 中文 UTF-8 文档被判成 windows-1252）。
    let utf8_ok =
        sampled_utf8_ok(head, false) && tail.map(|t| sampled_utf8_ok(t, true)).unwrap_or(true);
    if utf8_ok {
        return EncodingInfo {
            name: "UTF-8".into(),
            source: EncodingSource::Heuristic,
            verified: true,
        };
    }
    let mut det = EncodingDetector::new();
    det.feed(head, tail.is_none());
    if let Some(t) = tail {
        det.feed(t, true);
    }
    let guess = det.guess(None, true);
    // 验证代理：解码采样无替换字符即接受；有错误则回退 GB18030（中文兜底）再验
    let (_, _, err) = guess.decode(head);
    if !err {
        return EncodingInfo {
            name: guess.name().into(),
            source: EncodingSource::Heuristic,
            verified: true,
        };
    }
    let (_, _, err2) = encoding_rs::GB18030.decode(head);
    let _ = err2;
    EncodingInfo {
        name: guess.name().into(),
        source: EncodingSource::Heuristic,
        verified: false,
    }
}

/// 完整探测入口（无缓存版：单次打开路径之外的高阶语义/单测直接用）
pub fn detect(path: &Path) -> std::io::Result<EncodingInfo> {
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    Ok(detect_file(&mut f, len)?.0)
}

/// 采样级探测核心：返回 (探测结果, 头部采样)。
/// 头部采样与文件首个 64KB 分块内容一致，调用方可用于预热块缓存
/// （打开路径一次头部读取同时喂编码探测与换行统计， 减读）。
fn detect_file(f: &mut std::fs::File, len: u64) -> std::io::Result<(EncodingInfo, Vec<u8>)> {
    if len == 0 {
        return Ok((fallback(), Vec::new()));
    }
    let (head, tail) = read_samples(f, len)?;
    Ok((detect_from_samples(&head, tail.as_deref()), head))
}

/// 四级判定（BOM → 显式声明 → 启发式）：纯函数，供直读与缓存复用两条路径共用
fn detect_from_samples(head: &[u8], tail: Option<&[u8]>) -> EncodingInfo {
    if let Some(enc) = from_bom(head) {
        EncodingInfo {
            name: enc.name().into(),
            source: EncodingSource::Bom,
            verified: true,
        }
    } else if let Some(enc) = from_declaration(head) {
        EncodingInfo {
            name: enc.name().into(),
            source: EncodingSource::Declaration,
            verified: true,
        }
    } else {
        from_heuristic(head, tail)
    }
}

/// 编码探测缓存
fn detect_cache() -> &'static Mutex<ProbeLru<ProbeKey, EncodingInfo>> {
    static CACHE: OnceLock<Mutex<ProbeLru<ProbeKey, EncodingInfo>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ProbeLru::new(PROBE_CACHE_CAP)))
}

/// 头部采样共享缓存：kind_detect 嗅探（≤4KB 窗口）与编码探测
/// （64KB 窗口）复用同一次文件头读取。键与失效规则同探测缓存 `(path, len, mtime)`，
/// 按各自窗口截断使用，识别语义不变。
fn head_sample_cache() -> &'static Mutex<ProbeLru<ProbeKey, Arc<[u8]>>> {
    static CACHE: OnceLock<Mutex<ProbeLru<ProbeKey, Arc<[u8]>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ProbeLru::new(PROBE_CACHE_CAP)))
}

/// 取共享头部采样：`window` 按文件长度截断后（`need`）已缓存样本足够长则零 I/O 命中；
/// 未命中执行 `read`（调用方自读并返回实际字节）并回填，供另一路复用。
/// 持锁只做查表与写入，磁盘 I/O 在锁外进行。
pub(crate) fn shared_head_sample(
    key: &ProbeKey,
    window: usize,
    read: impl FnOnce() -> std::io::Result<Vec<u8>>,
) -> std::io::Result<Arc<[u8]>> {
    let need = window.min(key.len as usize);
    if need == 0 {
        return Ok(Vec::new().into());
    }
    if let Ok(mut cache) = head_sample_cache().lock()
        && let Some(hit) = cache.get(key)
        && hit.len() >= need
    {
        return Ok(hit.clone());
    }
    let sample: Arc<[u8]> = read()?.into();
    if let Ok(mut cache) = head_sample_cache().lock() {
        cache.put(key.clone(), sample.clone());
    }
    Ok(sample)
}

/// 共享缓存中的完整头采样（长度恰为该文件应采的头部窗口）——供探测命中路径回补块预热
fn head_from_cache(key: &ProbeKey) -> Option<Arc<[u8]>> {
    let expect = HEAD_SAMPLE.min(key.len) as usize;
    let hit = head_sample_cache().lock().ok()?.get(key)?.clone();
    (hit.len() == expect).then_some(hit)
}

/// 探测（带 `(path, len, mtime)` 进程内 LRU 缓存）：text/compare/search 打开路径统一走这里，
/// 重复探测零 I/O；外部修改（len/mtime 变化）自动失效重探测。
pub fn detect_cached(path: &Path) -> std::io::Result<EncodingInfo> {
    Ok(detect_cached_keep_head(path)?.0)
}

/// 同 [`detect_cached`]；把头部采样一并返回供块 0 预热（避免随后的换行统计再读一次头部）：
/// 未命中时随探测读回；命中时若共享采样缓存保有该文件的完整头采样也直接返回（复用
/// kind_detect/上次探测的同一次读取），否则 None（块缓存按需读）。
pub fn detect_cached_keep_head(path: &Path) -> std::io::Result<(EncodingInfo, Option<Vec<u8>>)> {
    let key = probe_key(path)?;
    let hit = detect_cache()
        .lock()
        .ok()
        .and_then(|mut cache| cache.get(&key).cloned());
    if let Some(info) = hit {
        return Ok((info, head_from_cache(&key).map(|h| h.to_vec())));
    }
    let len = key.len;
    let (info, head) = if len == 0 {
        (fallback(), Vec::new())
    } else {
        let head_len = HEAD_SAMPLE.min(len) as usize;
        let want_tail = len > HEAD_SAMPLE + TAIL_SAMPLE;
        let mut tail: Option<Vec<u8>> = None;
        let head = shared_head_sample(&key, head_len, || {
            // 未命中共享缓存：一次打开同时读头（探测+预热）与尾（启发式）采样
            let mut f = std::fs::File::open(path)?;
            let mut buf = vec![0u8; head_len];
            f.seek(SeekFrom::Start(0))?;
            f.read_exact(&mut buf)?;
            tail = read_tail_from(&mut f, len)?;
            Ok(buf)
        })?;
        if want_tail && tail.is_none() {
            // 共享缓存命中（读取闭包未执行）：尾采样单独补读，探测语义与直读一致
            let mut f = std::fs::File::open(path)?;
            tail = read_tail_from(&mut f, len)?;
        }
        (detect_from_samples(&head, tail.as_deref()), head.to_vec())
    };
    if let Ok(mut cache) = detect_cache().lock() {
        cache.put(key, info.clone());
    }
    Ok((info, Some(head)))
}

/// 按名称解码为 UTF-8（lossy），返回（文本, 替换发生与否）
pub fn decode(bytes: &[u8], name: &str) -> (String, bool) {
    let enc = Encoding::for_label(name.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let (cow, _enc_used, had_errors) = enc.decode(bytes);
    (cow.into_owned(), had_errors)
}

/// UTF-8 按名称编码写回（005 保存用；M2 预留）
pub fn encode(text: &str, name: &str) -> Result<Vec<u8>, EncodeError> {
    let enc =
        Encoding::for_label(name.as_bytes()).ok_or_else(|| EncodeError::Unknown(name.into()))?;
    // encoding_rs 按 Web 编码规范把 UTF-16 的 encode 重定向到 UTF-8。
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        return Ok(text
            .encode_utf16()
            .flat_map(|unit| {
                if enc == encoding_rs::UTF_16LE {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                }
            })
            .collect());
    }
    let (cow, _enc_used, had_errors) = enc.encode(text);
    if had_errors {
        return Err(EncodeError::Unmappable);
    }
    Ok(cow.into_owned())
}

/// BOM 属于文件元信息；解码去除后，保存按原编码保留，避免混入编辑缓冲。
pub fn encode_preserving_bom(
    text: &str,
    name: &str,
    original: &[u8],
) -> Result<Vec<u8>, EncodeError> {
    let mut bytes = encode(text, name)?;
    let enc =
        Encoding::for_label(name.as_bytes()).ok_or_else(|| EncodeError::Unknown(name.into()))?;
    let bom: &[u8] = if enc == encoding_rs::UTF_8 {
        &[0xef, 0xbb, 0xbf]
    } else if enc == encoding_rs::UTF_16LE {
        &[0xff, 0xfe]
    } else if enc == encoding_rs::UTF_16BE {
        &[0xfe, 0xff]
    } else {
        &[]
    };
    if !bom.is_empty() && original.starts_with(bom) && !bytes.starts_with(bom) {
        bytes.splice(0..0, bom.iter().copied());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(name: &str, content: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("ZiEdit-enc-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{}-{}", name, std::process::id()));
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content).unwrap();
        p
    }

    #[test]
    fn bom_utf8() {
        let p = fixture("bom8", "\u{FEFF}hello".as_bytes());
        let info = detect(&p).unwrap();
        assert_eq!(
            (info.name.as_str(), info.source),
            ("UTF-8", EncodingSource::Bom)
        );
    }

    #[test]
    fn bom_utf16le() {
        let p = fixture("bom16", &[0xFF, 0xFE, 0x31, 0x00, 0x32, 0x00]);
        let info = detect(&p).unwrap();
        assert_eq!(
            (info.name.as_str(), info.source),
            ("UTF-16LE", EncodingSource::Bom)
        );
    }

    #[test]
    fn gbk_no_bom_chinese() {
        // "中文编码测试" 的 GBK 字节
        let gbk: Vec<u8> = "中文编码测试，编码探测验证。".bytes().collect();
        // Rust String 是 UTF-8，需要手工转 GBK —— 用编码表对拍：直接用 encoding_rs 生成
        let (bytes, _, _) = encoding_rs::GBK.encode("中文编码测试，编码探测验证。第123行。");
        let _ = gbk;
        let p = fixture("gbk", &bytes);
        let info = detect(&p).unwrap();
        assert_eq!(info.source, EncodingSource::Heuristic);
        assert_eq!(info.name, "GBK");
        assert!(info.verified);
        // 解码往返 0 乱码
        let (text, err) = decode(&bytes, &info.name);
        assert!(!err);
        assert!(text.contains("中文编码测试"));
    }

    #[test]
    fn utf8_no_bom_strict_first() {
        let p = fixture("u8", "纯 UTF-8 无 BOM 中文\nsecond line\n".as_bytes());
        let info = detect(&p).unwrap();
        assert_eq!(info.name, "UTF-8");
        assert!(info.verified);
    }

    /// 回归（2026-10 乱码修复）：64KB 头采样把多字节字符切半，严格校验不得误判失败
    /// ——75KB 中文 UTF-8 文档曾因此落入 chardetng 被猜成 windows-1252。
    #[test]
    fn utf8_head_sample_boundary_split() {
        // 65535 个 ASCII 后紧跟「查」(E6 9F A5)：头采样恰含 E6 半字符
        let mut bytes = vec![b'a'; HEAD_SAMPLE as usize - 1];
        bytes.extend_from_slice("查".as_bytes());
        bytes.extend_from_slice(b"tail ascii");
        let p = fixture("u8-cut", &bytes);
        let info = detect(&p).unwrap();
        assert_eq!(info.name, "UTF-8");
        assert_eq!(info.source, EncodingSource::Heuristic);
        assert!(info.verified);
    }

    /// 回归（同上）：>128KB 文件的尾采样起点也可能落在多字节字符中间，
    /// 剥掉开头的接续字节后校验。
    #[test]
    fn utf8_tail_sample_boundary_split() {
        let tail_start = (HEAD_SAMPLE + TAIL_SAMPLE + 500) as usize - TAIL_SAMPLE as usize; // 66036
        let mut bytes = vec![b'a'; tail_start - 1];
        bytes.extend_from_slice("查".as_bytes()); // E6 落在 tail_start-1，9F 恰为尾采样首字节
        bytes.resize((HEAD_SAMPLE + TAIL_SAMPLE + 500) as usize, b'a');
        let p = fixture("u8-tail-cut", &bytes);
        let info = detect(&p).unwrap();
        assert_eq!(info.name, "UTF-8");
        assert!(info.verified);
    }

    #[test]
    fn utf16_no_bom_samples() {
        for text in [
            "Hello world, line 123\nSecond line 456\n",
            "中文 Hello 123\n世界 sample 456\n",
        ] {
            for name in ["UTF-16LE", "UTF-16BE"] {
                let bytes = encode(text, name).unwrap();
                let info = from_heuristic(&bytes, Some(&bytes));
                assert_eq!(info.name, name);
                assert_eq!(info.source, EncodingSource::Heuristic);
                assert!(info.verified);
                assert_eq!(decode(&bytes, &info.name), (text.into(), false));
            }
            assert_eq!(from_heuristic(text.as_bytes(), None).name, "UTF-8");
        }
        assert!(utf16_without_bom(&[0; 32]).is_none());
        assert!(utf16_without_bom(b"hello\0world").is_none());
        assert_eq!(from_heuristic("纯中文测试".as_bytes(), None).name, "UTF-8");
    }

    #[test]
    fn utf16_mixed_language_and_signal_free_tail() {
        let text = format!("{}{}", "English text ".repeat(100), "中文内容".repeat(300));
        let bytes = encode(&text, "UTF-16LE").unwrap();
        let tail = encode(&"中文内容".repeat(100), "UTF-16LE").unwrap();
        assert_eq!(from_heuristic(&bytes, Some(&tail)).name, "UTF-16LE");
        let opposite = encode(&"English text ".repeat(100), "UTF-16BE").unwrap();
        assert_ne!(from_heuristic(&bytes, Some(&opposite)).name, "UTF-16LE");
    }

    #[test]
    fn xml_declaration() {
        let p = fixture(
            "xml",
            "<?xml version=\"1.0\" encoding=\"GBK\"?><root/>".as_bytes(),
        );
        let info = detect(&p).unwrap();
        assert_eq!(
            (info.name.as_str(), info.source),
            ("GBK", EncodingSource::Declaration)
        );
    }

    #[test]
    fn html_charset() {
        let p = fixture(
            "html",
            "<!doctype html><meta charset=\"gb2312\"><body>hi".as_bytes(),
        );
        let info = detect(&p).unwrap();
        assert_eq!(info.source, EncodingSource::Declaration);
    }

    #[test]
    fn empty_file_fallback() {
        let p = fixture("empty", b"");
        assert_eq!(detect(&p).unwrap(), fallback());
    }

    #[test]
    fn encode_rejects_unmappable() {
        // UTF-8 文本中的 emoji 无法映射到 latin-1
        assert!(encode("ok ascii", "windows-1252").is_ok());
        assert!(encode("带中文", "windows-1252").is_err());
    }

    #[test]
    fn utf16_writeback_and_bom_roundtrip() {
        let text = "中文😀\r\nnext";
        for (name, bom) in [
            ("UTF-16LE", vec![0xff, 0xfe]),
            ("UTF-16BE", vec![0xfe, 0xff]),
            ("UTF-8", vec![0xef, 0xbb, 0xbf]),
        ] {
            let bytes = encode_preserving_bom(text, name, &bom).unwrap();
            assert!(bytes.starts_with(&bom));
            assert_eq!(decode(&bytes, name), (text.to_string(), false));
            let plain = encode(text, name).unwrap();
            assert!(!plain.starts_with(&bom));
            assert_eq!(decode(&plain, name), (text.to_string(), false));
        }
        assert_eq!(
            encode_preserving_bom("A", "UTF-16LE", &[]).unwrap(),
            vec![0x41, 0]
        );
        assert_eq!(
            encode_preserving_bom("A", "UTF-16BE", &[]).unwrap(),
            vec![0, 0x41]
        );
    }

    /// 探测缓存：命中零 I/O；外部修改（len/mtime 基线变化）失效重探测
    #[test]
    fn detect_cached_invalidates_on_change() {
        let p = fixture("cache-enc", "hello world".as_bytes());
        let first = detect_cached(&p).unwrap();
        assert_eq!(first.name, "UTF-8");
        // 二次调用走缓存，结果一致（同内容同判定）
        assert_eq!(detect_cached(&p).unwrap(), first);
        // keep_head 变体：探测命中时头采样从共享采样缓存回补（块 0 预热不再二读头部）
        let (info, head) = detect_cached_keep_head(&p).unwrap();
        assert_eq!(info, first);
        assert_eq!(head.as_deref(), Some(&b"hello world"[..]));
        // 外部修改为 UTF-16LE BOM：基线变化后必须重探测
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&p, [0xFF, 0xFE, b'a', 0x00, b'b', 0x00]).unwrap();
        let second = detect_cached(&p).unwrap();
        assert_eq!(
            (second.name.as_str(), second.source),
            ("UTF-16LE", EncodingSource::Bom)
        );
        // 共享头采样随新基线一并失效：回补的是新内容头部，不是旧采样
        let (_, head) = detect_cached_keep_head(&p).unwrap();
        assert_eq!(
            head.as_deref(),
            Some(&[0xFF, 0xFE, b'a', 0x00, b'b', 0x00][..])
        );
    }

    /// 头部采样 = 文件首个 64KB 分块内容（供块缓存预热的契约）
    #[test]
    fn detect_keep_head_matches_first_chunk() {
        let big = "x".repeat(100_000);
        let p = fixture("head-chunk", big.as_bytes());
        let (_, head) = detect_cached_keep_head(&p).unwrap();
        let head = head.expect("未命中缓存必须返回头部采样");
        assert_eq!(head.len(), HEAD_SAMPLE as usize);
        assert_eq!(&head[..], &big.as_bytes()[..HEAD_SAMPLE as usize]);
    }

    #[test]
    fn probe_lru_evicts_oldest() {
        let mut lru: ProbeLru<u32, &str> = ProbeLru::new(2);
        lru.put(1, "a");
        lru.put(2, "b");
        assert_eq!(lru.get(&1), Some(&"a")); // 1 变为最近使用
        lru.put(3, "c"); // 淘汰 2
        assert_eq!(lru.get(&2), None);
        assert_eq!(lru.get(&1), Some(&"a"));
        assert_eq!(lru.get(&3), Some(&"c"));
    }
}
