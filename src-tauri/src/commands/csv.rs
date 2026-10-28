//! csv —— 记录级 CSV 解析（批 D-3，007：数据正确性修复）
//! 此前前端按物理行解析，引号字段内嵌换行会把一条记录拆碎；
//! 本模块在 Rust 侧按 RFC 4180 语义流式扫描记录边界（引号内换行属记录内容），
//! 建立记录起始字节偏移索引，按需窗口解码返回，不整文件读入前端。

use crate::error::ZiEditError;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 记录起始偏移索引（Rust 侧常驻；~8B/记录）。
/// MD-004（审计 2026-10-17）：len/modified_ms 为失效判决基线——外部修改后按新 stat 重建索引，
/// 修前索引只建一次永不失效，CSV 外部修改后 F5/重载仍按旧偏移读取（行错位、总数停旧）。
pub struct CsvIndex {
    offsets: Arc<Vec<u64>>,
    len: u64,
    modified_ms: u64,
    encoding: String,
}

#[derive(Default)]
pub struct CsvRegistry(pub Mutex<HashMap<String, CsvIndex>>);

/// 注册表容量（MD-004 同批：与 HexRegistry 同口径的 LRU 式淘汰——近似移除一个非当前路径的旧项）
const REGISTRY_CAP: usize = 8;

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvRecord {
    pub no: u64,
    pub cells: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvRecordsResult {
    pub records: Vec<CsvRecord>,
    pub total: u64,
    pub delimiter: String,
}

/// 索引构建的文件大小上限：超过则报错引导回源码视图（CSV 表格模式面向常规数据文件）
const CSV_INDEX_LIMIT: u64 = 256 * 1024 * 1024;
/// 单次窗口记录数上限（与 text_lines 的 5000 行钳制同口径）
const WINDOW_LIMIT: u64 = 5000;
/// 扫描缓冲
const SCAN_BUF: usize = 64 * 1024;
const WINDOW_BYTES: u64 = 4 * 1024 * 1024;
const INDEX_RECORD_LIMIT: usize = 2_000_000;

/// 流式扫描记录边界：返回每条记录的起始字节偏移。
/// 引号内（`"` 开启/关闭，`""` 转义）的 \n、\r、分隔符均为字面内容；
/// 引号外的 \n / lone \r / \r\n 为记录界（与文本视图行界语义一致）。
fn scan_offsets(f: &mut std::fs::File, len: u64, encoding: &str) -> std::io::Result<Vec<u64>> {
    let utf16 = match encoding {
        "UTF-16LE" => Some(true),
        "UTF-16BE" => Some(false),
        _ => None,
    };
    let width = if utf16.is_some() { 2 } else { 1 };
    if !len.is_multiple_of(width as u64) {
        return Err(std::io::Error::other("CSV_INVALID_UTF16:odd byte length"));
    }
    let mut offsets = vec![0u64];
    let mut buf = vec![0u8; SCAN_BUF];
    let mut in_quotes = false;
    let mut pos: u64 = 0;
    let mut prev: u16 = 0;
    while pos < len {
        let n = (len - pos).min(SCAN_BUF as u64) as usize;
        f.read_exact(&mut buf[..n])?;
        for (i, unit) in buf[..n].chunks_exact(width).enumerate() {
            let b = match utf16 {
                Some(true) => u16::from_le_bytes([unit[0], unit[1]]),
                Some(false) => u16::from_be_bytes([unit[0], unit[1]]),
                None => unit[0] as u16,
            };
            let next = pos + ((i + 1) * width) as u64;
            if in_quotes {
                if b == b'"' as u16 {
                    in_quotes = false;
                }
            } else {
                match b {
                    34 => in_quotes = true,
                    10 => {
                        // \r\n：\r 已切过，\n 不再切
                        if prev == b'\r' as u16 {
                            if let Some(last) = offsets.last_mut() {
                                *last = next;
                            }
                        } else {
                            let start = next;
                            if start < len {
                                offsets.push(start);
                            }
                        }
                    }
                    13 => {
                        // lone \r 与 \r\n 的 \r：都在此切记录
                        let start = next;
                        if start < len {
                            offsets.push(start);
                        }
                    }
                    _ => {}
                }
            }
            prev = b;
            if offsets.len() > INDEX_RECORD_LIMIT {
                return Err(std::io::Error::other(
                    "CSV_INDEX_TOO_LARGE:2000000 records; use source view",
                ));
            }
        }
        pos += n as u64;
    }
    // 末条记录为空（文件以换行结尾）时不计入
    if len == 0 {
        offsets.clear();
    } else if *offsets.last().unwrap() >= len {
        offsets.pop();
    }
    Ok(offsets)
}

/// 读取 [start, end) 字节
fn read_at(f: &mut std::fs::File, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    if end < start || end - start > 4 * 1024 * 1024 {
        return Err(std::io::Error::other(
            "CSV_RECORD_TOO_LARGE:4MiB; use source view",
        ));
    }
    let mut out = vec![0u8; (end - start) as usize];
    f.seek(SeekFrom::Start(start))?;
    f.read_exact(&mut out)?;
    Ok(out)
}

/// 去掉记录尾部的行尾字节（\r\n / \n / \r）
#[cfg(test)]
fn trim_eol(bytes: &mut Vec<u8>) {
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
}

/// 记录文本 → 单元格（RFC 4180 引号语义；纯函数供单测）
fn split_cells(text: &str, delim: char) -> Vec<String> {
    let cs: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if in_q {
            if c == '"' {
                if i + 1 < cs.len() && cs[i + 1] == '"' {
                    cur.push('"'); // "" 转义为字面引号
                    i += 2;
                    continue;
                }
                in_q = false;
            } else {
                cur.push(c);
            }
        } else if c == '"' {
            in_q = true;
        } else if c == delim {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
        i += 1;
    }
    out.push(cur);
    out
}

fn sniff_delimiter(text: &str) -> char {
    let mut best = (',', 0);
    for candidate in [',', ';', '\t'] {
        let count = split_cells(text, candidate).len() - 1;
        if count > best.1 {
            best = (candidate, count);
        }
    }
    best.0
}

/// 版本匹配判决：(len, modified_ms, encoding) 即索引版本（MD-004 基线）
fn csv_index_matches(ix: &CsvIndex, len: u64, modified_ms: u64, enc_name: &str) -> bool {
    ix.len == len && ix.modified_ms == modified_ms && ix.encoding == enc_name
}

/// 取版本匹配的索引：锁内只查缓存；整文件扫描在锁外；
/// 发布前二次校验——注册表已有**不同版本**条目（更新的请求已写回）时，
/// 晚到的旧扫描结果不覆盖不淘汰，直接返回注册表现有条目及其版本。
/// 返回 (offsets, 索引版本 len, 索引版本 mtime)；调用方负责读取前的磁盘版本校验。
fn ensure_csv_index(
    registry: &CsvRegistry,
    p: &Path,
    path: &str,
    len: u64,
    modified_ms: u64,
    enc_name: &str,
) -> Result<(Arc<Vec<u64>>, u64, u64), ZiEditError> {
    {
        let reg = registry
            .0
            .lock()
            .map_err(|e| ZiEditError::Msg(e.to_string()))?;
        if let Some(ix) = reg
            .get(path)
            .filter(|ix| csv_index_matches(ix, len, modified_ms, enc_name))
        {
            return Ok((ix.offsets.clone(), ix.len, ix.modified_ms));
        }
    }
    // 锁外扫描：整文件扫描不持全局注册表锁（锁收窄）
    let mut f = std::fs::File::open(p)?;
    let scanned = Arc::new(scan_offsets(&mut f, len, enc_name)?);
    let mut reg = registry
        .0
        .lock()
        .map_err(|e| ZiEditError::Msg(e.to_string()))?;
    // 发布前二次校验：以磁盘当前版本为准区分两种「版本不同」——
    // - 注册表条目 ≠ 本次版本，且磁盘 == 注册表版本 → 更新的请求已写回：
    // 晚到的旧扫描结果不覆盖不淘汰，返回注册表现有条目；
    // - 注册表条目 ≠ 本次版本，且磁盘 ≠ 注册表版本 → 注册表也已旧（外部改写）：
    // 本次扫描结果发布，由调用方的读取前校验兜底。
    if let Some(ix) = reg.get(path)
        && !csv_index_matches(ix, len, modified_ms, enc_name)
    {
        let disk = std::fs::metadata(p)?;
        let disk_mtime = mtime_ms(&disk);
        if ix.len == disk.len() && ix.modified_ms == disk_mtime {
            return Ok((ix.offsets.clone(), ix.len, ix.modified_ms));
        }
    }
    if !reg.contains_key(path)
        && reg.len() >= REGISTRY_CAP
        && let Some(victim) = reg.keys().find(|k| k.as_str() != path).cloned()
    {
        reg.remove(&victim);
    }
    reg.insert(
        path.to_string(),
        CsvIndex {
            offsets: scanned.clone(),
            len,
            modified_ms,
            encoding: enc_name.to_string(),
        },
    );
    Ok((scanned, len, modified_ms))
}

/// 取「与磁盘当前版本一致」的索引：获取后重新 stat，磁盘版本与
/// 索引版本失配（获取期间被外部改写）则按新版本重走——索引建立总会重新扫描——
/// 杜绝「旧偏移读新文件」。持续变化（>3 轮）显式报错。
fn stable_csv_offsets(
    registry: &CsvRegistry,
    p: &Path,
    path: &str,
    enc_name: &str,
) -> Result<(Arc<Vec<u64>>, u64), ZiEditError> {
    let mut meta = std::fs::metadata(p)?;
    let mut retries = 0u8;
    loop {
        let len = meta.len();
        if len > CSV_INDEX_LIMIT {
            return Err(ZiEditError::TooLarge);
        }
        let (offsets, ix_len, ix_mtime) =
            ensure_csv_index(registry, p, path, len, mtime_ms(&meta), enc_name)?;
        let cur = std::fs::metadata(p)?;
        if cur.len() == ix_len && mtime_ms(&cur) == ix_mtime {
            return Ok((offsets, ix_len));
        }
        retries += 1;
        if retries > 3 {
            return Err(ZiEditError::Msg(
                "CSV file changed repeatedly; retry later".into(),
            ));
        }
        meta = cur;
    }
}

#[tauri::command]
pub async fn csv_records(
    registry: tauri::State<'_, CsvRegistry>,
    path: String,
    from: u64,
    to: u64,
    delim: String,
    encoding_name: Option<String>,
) -> Result<CsvRecordsResult, ZiEditError> {
    if from == 0 || to < from {
        return Err(ZiEditError::Msg(
            "Record numbers start at 1 and to >= from".into(),
        ));
    }
    let to = to.min(from.saturating_add(WINDOW_LIMIT - 1));
    let enc_name = encoding_name.unwrap_or_else(|| "UTF-8".into());
    let p = PathBuf::from(&path);
    // 版本化索引获取 + 读取前磁盘版本校验（见 stable_csv_offsets）
    let (offsets, len) = stable_csv_offsets(&registry, &p, &path, &enc_name)?;
    let total = offsets.len() as u64;
    if total == 0 {
        return Ok(CsvRecordsResult {
            records: vec![],
            total: 0,
            delimiter: delim.chars().next().unwrap_or(',').to_string(),
        });
    }
    let mut f = std::fs::File::open(&p)?;
    let delim_char = match delim.chars().next() {
        Some(value) => value,
        None => {
            let end = offsets.get(1).copied().unwrap_or(len);
            let raw = read_at(&mut f, 0, end)?;
            sniff_delimiter(&crate::encoding::decode(&raw, &enc_name).0)
        }
    };
    if from > total {
        return Ok(CsvRecordsResult {
            records: vec![],
            total,
            delimiter: delim_char.to_string(),
        });
    }
    let to = to.min(total);
    let mut records = Vec::with_capacity((to - from + 1) as usize);
    let mut window_bytes = 0;
    for r in from..=to {
        let start = offsets[(r - 1) as usize];
        let end = if (r as usize) < offsets.len() {
            offsets[r as usize]
        } else {
            len
        };
        if !records.is_empty() && window_bytes + end - start > WINDOW_BYTES {
            break;
        }
        let raw = read_at(&mut f, start, end)?;
        window_bytes += raw.len() as u64;
        let (text, _) = crate::encoding::decode(&raw, &enc_name);
        let text = text.strip_suffix('\n').unwrap_or(&text);
        let text = text.strip_suffix('\r').unwrap_or(text);
        records.push(CsvRecord {
            no: r,
            cells: split_cells(text, delim_char),
        });
    }
    Ok(CsvRecordsResult {
        records,
        total,
        delimiter: delim_char.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_complete_multiline_header_ignores_quoted_delimiters() {
        assert_eq!(sniff_delimiter("\"a,b,c\nb\";c\r\n"), ';');
        assert_eq!(sniff_delimiter("\"a;\nb\"\tc\r\n"), '\t');
        assert_eq!(sniff_delimiter("a,b;c\n"), ',');
        assert_eq!(sniff_delimiter("\"a,b\nc\"\n"), ',');
    }

    #[test]
    fn utf16_record_boundaries_include_quoted_newlines_and_cross_chunk_crlf() {
        let dir = std::env::temp_dir().join("ZiEdit-csv-utf16-tests");
        std::fs::create_dir_all(&dir).unwrap();
        for enc in ["UTF-16LE", "UTF-16BE"] {
            let text = format!(
                "{}\r\n\"中文\n😀\",z\r\nlast\r\n",
                "a".repeat(SCAN_BUF / 2 - 1)
            );
            let bytes = crate::encoding::encode(&text, enc).unwrap();
            let p = dir.join(enc);
            std::fs::write(&p, &bytes).unwrap();
            let mut f = std::fs::File::open(&p).unwrap();
            let off = scan_offsets(&mut f, bytes.len() as u64, enc).unwrap();
            assert_eq!(off.len(), 3);
            assert!(off.iter().all(|n| n % 2 == 0));
            let raw = read_at(&mut f, off[1], off[2]).unwrap();
            assert_eq!(crate::encoding::decode(&raw, enc).0, "\"中文\n😀\",z\r\n");
        }
    }

    #[test]
    fn scan_quoted_newline_stays_one_record() {
        // 引号内嵌换行：一条记录，不再拆碎（批 D-3 核心用例）
        let dir = std::env::temp_dir().join("ZiEdit-csv-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("quoted.csv");
        std::fs::write(&p, "a,b\n\"x\ny\",z\n").unwrap();
        let mut f = std::fs::File::open(&p).unwrap();
        let len = std::fs::metadata(&p).unwrap().len();
        let off = scan_offsets(&mut f, len, "UTF-8").unwrap();
        assert_eq!(off, vec![0, 4]); // 两条记录（引号内 \n 未切）
    }

    #[test]
    fn scan_crlf_and_lone_cr() {
        let dir = std::env::temp_dir().join("ZiEdit-csv-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("eol.csv");
        std::fs::write(&p, "a\r\nb\rc\nd").unwrap();
        let mut f = std::fs::File::open(&p).unwrap();
        let len = std::fs::metadata(&p).unwrap().len();
        let off = scan_offsets(&mut f, len, "UTF-8").unwrap();
        // 4 条记录：a / b / c / d（无尾随空记录）
        assert_eq!(off.len(), 4);
    }

    #[test]
    fn scan_trailing_newline_no_empty_record() {
        let dir = std::env::temp_dir().join("ZiEdit-csv-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("trail.csv");
        std::fs::write(&p, "a,b\n").unwrap();
        let mut f = std::fs::File::open(&p).unwrap();
        let len = std::fs::metadata(&p).unwrap().len();
        let off = scan_offsets(&mut f, len, "UTF-8").unwrap();
        assert_eq!(off, vec![0]);
        std::fs::write(&p, b"h1,h2\r\n1,x\r\n2,y\r\n").unwrap();
        let mut f = std::fs::File::open(&p).unwrap();
        let len = f.metadata().unwrap().len();
        let off = scan_offsets(&mut f, len, "UTF-8").unwrap();
        assert_eq!(off, vec![0, 7, 12]);
        let mut row = read_at(&mut f, off[1], off[2]).unwrap();
        trim_eol(&mut row);
        assert_eq!(row, b"1,x");
    }

    #[test]
    fn scan_large_crosses_buffer() {
        // 跨 64KB 扫描缓冲的引号状态保持
        let dir = std::env::temp_dir().join("ZiEdit-csv-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("big.csv");
        let mut content = String::from("\"");
        content.push_str(&"x".repeat(SCAN_BUF + 100)); // 引号字段跨缓冲
        content.push_str("\",b\nsecond\n");
        std::fs::write(&p, content.as_bytes()).unwrap();
        let mut f = std::fs::File::open(&p).unwrap();
        let len = std::fs::metadata(&p).unwrap().len();
        let off = scan_offsets(&mut f, len, "UTF-8").unwrap();
        assert_eq!(off.len(), 2);
    }

    #[test]
    fn cells_basic_and_trim() {
        let mut b: Vec<u8> = b"aa,\"b,b\"\r\n".to_vec();
        trim_eol(&mut b);
        assert_eq!(b, b"aa,\"b,b\"");
        let mut b2: Vec<u8> = b"x\n".to_vec();
        trim_eol(&mut b2);
        assert_eq!(b2, b"x");
        assert_eq!(split_cells("aa,\"b,b\"", ','), vec!["aa", "b,b"]);
        assert_eq!(split_cells("a;;b", ';'), vec!["a", "", "b"]);
    }

    #[test]
    fn index_staleness_rebuild_md004() {
        // MD-004：外部修改后（len/mtime 基线不符）必须重扫索引——修前索引只建一次，
        // 后续读取全按旧偏移（行错位、总数停旧）。这里验证重扫路径产出新基线。
        let dir = std::env::temp_dir().join("ZiEdit-csv-stale-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.csv");
        std::fs::write(
            &p,
            "h1,h2
1,x
2,y
",
        )
        .unwrap();
        let meta = std::fs::metadata(&p).unwrap();
        let (len1, mt1) = (meta.len(), mtime_ms(&meta));
        let mut f = std::fs::File::open(&p).unwrap();
        let off1 = scan_offsets(&mut f, len1, "UTF-8").unwrap();
        assert_eq!(off1.len(), 3);
        // 外部追加一条记录（len/mtime 均变）
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(
            &p,
            "h1,h2
1,x
2,y
3,z
",
        )
        .unwrap();
        let meta2 = std::fs::metadata(&p).unwrap();
        let (len2, mt2) = (meta2.len(), mtime_ms(&meta2));
        let stale = len1 != len2 || mt1 != mt2;
        assert!(stale, "基线必须能感知修改");
        let mut f2 = std::fs::File::open(&p).unwrap();
        let off2 = scan_offsets(&mut f2, len2, "UTF-8").unwrap();
        assert_eq!(off2.len(), 4);
    }

    /// ：晚到的旧版本扫描结果不得覆盖注册表内更新版本（不淘汰、不回退）
    #[test]
    fn late_old_scan_does_not_overwrite_newer_index() {
        let dir = std::env::temp_dir().join("ZiEdit-csv-race-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("race.csv");
        std::fs::write(&p, "a,b\n").unwrap();
        let registry = CsvRegistry::default();
        let key = p.to_string_lossy().into_owned();

        // 模拟：v1 请求先 stat；期间文件改为 v2 并被他人扫描写回；v1 的扫描结果晚到
        let meta1 = std::fs::metadata(&p).unwrap();
        let (len1, mt1) = (meta1.len(), mtime_ms(&meta1));
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&p, "a,b\nc,d\n").unwrap();
        let meta2 = std::fs::metadata(&p).unwrap();
        let (len2, mt2) = (meta2.len(), mtime_ms(&meta2));
        // 「新请求」先完成：注册表持有 v2 索引
        let (v2_off, _, _) = ensure_csv_index(&registry, &p, &key, len2, mt2, "UTF-8").unwrap();
        assert_eq!(v2_off.len(), 2);
        // 「旧请求」晚到发布：注册表已有不同版本 → 不覆盖，返回注册表内 v2 条目
        let (late_off, late_len, late_mtime) =
            ensure_csv_index(&registry, &p, &key, len1, mt1, "UTF-8").unwrap();
        assert_eq!(late_len, len2, "晚到旧请求必须拿到注册表内新版本");
        assert_eq!(late_mtime, mt2);
        assert_eq!(late_off.len(), 2, "不得回退到旧偏移");
        {
            let reg = registry.0.lock().unwrap();
            let ix = reg.get(&key).unwrap();
            assert!(
                ix.len == len2 && ix.modified_ms == mt2,
                "注册表条目不被旧结果覆盖"
            );
        }
    }

    /// ：版本失配（外部改写）触发重扫；读取前校验稳定后返回新版本偏移
    #[test]
    fn stable_offsets_rescan_on_version_change() {
        let dir = std::env::temp_dir().join("ZiEdit-csv-stable-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("stable.csv");
        std::fs::write(&p, "h1,h2\n1,x\n").unwrap();
        let registry = CsvRegistry::default();
        let key = p.to_string_lossy().into_owned();

        let (off1, len1) = stable_csv_offsets(&registry, &p, &key, "UTF-8").unwrap();
        assert_eq!((off1.len() as u64, len1), (2, p.metadata().unwrap().len()));

        // 外部改写（增行）：再次获取必须重扫并返回新版本——不把旧偏移用于新文件
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&p, "h1,h2\n1,x\n2,y\n3,z\n").unwrap();
        let (off2, len2) = stable_csv_offsets(&registry, &p, &key, "UTF-8").unwrap();
        assert_eq!(off2.len(), 4, "版本失配必须重扫出新偏移");
        assert_eq!(len2, p.metadata().unwrap().len());
        // 偏移正确性：按新偏移读回第 2 条记录
        let mut f = std::fs::File::open(&p).unwrap();
        let raw = read_at(&mut f, off2[1], off2[2]).unwrap();
        assert_eq!(crate::encoding::decode(&raw, "UTF-8").0, "1,x\n");
    }
}
