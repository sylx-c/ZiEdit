//! file_engine —— 分块读取、行锚点索引（决策 002，spike 实证参数）
//! 64KB 分块 positioned read + LRU 256 块缓存 + 4KB 行锚点。
//! 性能红线：任何路径不得把整个文件读入内存。

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;

pub const CHUNK: usize = 64 * 1024;
pub const ANCHOR_STRIDE: u64 = 4 * 1024;
pub const CACHE_BLOCKS: usize = 256;
/// 行窗口原始字节预算；超长单行必须显式失败，不能无界累计整个文件。
pub const MAX_LINE_WINDOW_BYTES: usize = 4 * 1024 * 1024;

/// 分块解码并逐行消费；回调返回 false 可取消，单行和原始文件大小均有界。
/// 解码缓冲跨块复用（clear 保留容量，不再每块新分配 ~256KB）。
pub fn visit_lines(
    path: &Path,
    encoding: &str,
    max_bytes: u64,
    mut on_line: impl FnMut(u64, &str) -> bool,
) -> Result<(), String> {
    let mut cache = ChunkCache::open(path).map_err(|e| e.to_string())?;
    if cache.len() > max_bytes {
        return Err("size-limit".into());
    }
    let enc = encoding_rs::Encoding::for_label(encoding.as_bytes()).ok_or("Unknown encoding")?;
    let mut decoder = enc.new_decoder();
    let mut line = String::new();
    let mut decoded = String::with_capacity(CHUNK * 4 + 16);
    let mut no = 1;
    let mut after_cr = false;
    let chunks = cache.len().div_ceil(CHUNK as u64);
    for idx in 0..chunks {
        let bytes = cache.read_chunk(idx).map_err(|e| e.to_string())?;
        decoded.clear(); // 容量保留：跨块复用解码缓冲
        let (_, used, _) = decoder.decode_to_string(&bytes, &mut decoded, idx + 1 == chunks);
        if used != bytes.len() {
            return Err("Decode buffer exceeded".into());
        }
        for part in decoded.split_inclusive(['\r', '\n']) {
            if after_cr && part == "\n" {
                after_cr = false;
                continue;
            }
            let ending = part.ends_with(['\r', '\n']);
            let text = if ending {
                &part[..part.len() - 1]
            } else {
                part
            };
            if line.len() + text.len() > MAX_LINE_WINDOW_BYTES {
                return Err("line-limit".into());
            }
            line.push_str(text);
            after_cr = part.ends_with('\r');
            if ending {
                if !on_line(no, &line) {
                    return Ok(());
                }
                no += 1;
                line.clear();
            }
        }
    }
    if !line.is_empty() {
        on_line(no, &line);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Anchor {
    pub offset: u64,
    pub line: u64,
}

#[derive(Debug)]
pub struct LineIndex {
    pub anchors: Vec<Anchor>,
    pub total_lines: u64,
    pub file_len: u64,
    pub utf16: Option<bool>, // Some(true)=LE，Some(false)=BE
}

/// 分块读取器：LRU 块缓存，块大小 64KB，缓存上限 256 块（≈16MB）。
/// 块以 `Arc<[u8]>` 存储：命中/插入路径只克隆引用计数，不再整块字节拷贝。
pub struct ChunkCache {
    file: File,
    len: u64,
    blocks: HashMap<u64, (u64, Arc<[u8]>)>,
    tick: u64,
    hits: u64,
    misses: u64,
}

impl ChunkCache {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        Ok(Self {
            file,
            len,
            blocks: HashMap::new(),
            tick: 0,
            hits: 0,
            misses: 0,
        })
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn stats(&self) -> (u64, u64) {
        (self.hits, self.misses)
    }

    /// 读取第 idx 块（命中缓存或按需 positioned read）。
    /// 返回 Arc 克隆：命中路径零字节拷贝（修前命中与插入各 clone 一次整块）。
    pub fn read_chunk(&mut self, idx: u64) -> std::io::Result<Arc<[u8]>> {
        let off = idx * CHUNK as u64;
        if off >= self.len {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "chunk beyond eof",
            ));
        }
        if let Some((t, buf)) = self.blocks.get_mut(&idx) {
            self.tick += 1;
            *t = self.tick;
            self.hits += 1;
            return Ok(buf.clone());
        }
        let end = (off + CHUNK as u64).min(self.len);
        let mut buf = vec![0u8; (end - off) as usize];
        {
            let f = &mut self.file;
            f.seek(SeekFrom::Start(off))?;
            f.read_exact(&mut buf)?;
        }
        self.misses += 1;
        self.tick += 1;
        let t = self.tick;
        let block: Arc<[u8]> = buf.into();
        if self.blocks.len() >= CACHE_BLOCKS
            && let Some((&evict, _)) = self.blocks.iter().min_by_key(|(_, v)| v.0)
        {
            self.blocks.remove(&evict);
        }
        self.blocks.insert(idx, (t, block.clone()));
        Ok(block)
    }

    /// 预热块：仅在未缓存时写入（字节须与该块应有长度一致，否则忽略）。
    /// 打开路径复用编码探测的头部采样喂块 0，随后的换行统计命中缓存零额外 I/O。
    pub fn warm_block(&mut self, idx: u64, bytes: Vec<u8>) {
        let off = idx * CHUNK as u64;
        let expect = (CHUNK as u64).min(self.len.saturating_sub(off)) as usize;
        if off >= self.len || bytes.len() != expect || self.blocks.contains_key(&idx) {
            return;
        }
        self.tick += 1;
        let t = self.tick;
        if self.blocks.len() >= CACHE_BLOCKS
            && let Some((&evict, _)) = self.blocks.iter().min_by_key(|(_, v)| v.0)
        {
            self.blocks.remove(&evict);
        }
        self.blocks.insert(idx, (t, bytes.into()));
    }

    /// 从字节偏移 off 起累计读取，直到凑满 `lines` 个逻辑行（首屏/跳转窗口用）。
    /// EOF 时返回已累计部分（修复：末行无换行的文件不再整窗报错）。
    pub fn read_lines_from(&mut self, off: u64, lines: u64) -> std::io::Result<Vec<u8>> {
        self.read_lines_encoded(off, lines, None)
    }

    pub fn read_lines_encoded(
        &mut self,
        off: u64,
        lines: u64,
        utf16: Option<bool>,
    ) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::new();
        let mut idx = off / CHUNK as u64;
        let mut skip = (off % CHUNK as u64) as usize;
        let mut nl = 0;
        let mut cr = false;
        while idx * (CHUNK as u64) < self.len && nl < lines {
            let chunk = self.read_chunk(idx)?;
            let bytes = &chunk[skip.min(chunk.len())..];
            let unit_bytes = if utf16.is_some() { 2 } else { 1 };
            for (i, pair) in bytes.chunks_exact(unit_bytes).enumerate() {
                let unit = match utf16 {
                    Some(true) => u16::from_le_bytes([pair[0], pair[1]]),
                    Some(false) => u16::from_be_bytes([pair[0], pair[1]]),
                    None => u16::from(pair[0]),
                };
                // CR 的边界在下一单元判定，跨块 CRLF 只记一次。
                if cr {
                    nl += 1;
                    if nl >= lines && unit != 10 {
                        out.extend_from_slice(&bytes[..i * unit_bytes]);
                        return Ok(out);
                    }
                }
                if unit == 10 && !cr {
                    nl += 1;
                }
                cr = unit == 13;
                if out.len() + (i + 1) * unit_bytes > MAX_LINE_WINDOW_BYTES {
                    return Err(std::io::Error::other("LINE_WINDOW_TOO_LARGE:4MiB"));
                }
                if nl >= lines {
                    out.extend_from_slice(&bytes[..(i + 1) * unit_bytes]);
                    return Ok(out);
                }
            }
            out.extend_from_slice(bytes);
            skip = 0;
            idx += 1;
        }
        Ok(out)
    }
}

/// 逻辑行尾计数：`\n` 计 1；其后不是 `\n` 的 `\r` 也计 1（`\r\n` 只计 1）。
/// 缓冲末尾的孤立 `\r` 无法判定，跳过（累计读取语境下由后续数据修正）。
pub fn count_eols(buf: &[u8]) -> u64 {
    let mut n = 0u64;
    let mut i = 0usize;
    while i < buf.len() {
        match buf[i] {
            b'\n' => {
                n += 1;
                i += 1;
            }
            b'\r' if i + 1 < buf.len() => {
                n += 1;
                i += if buf[i + 1] == b'\n' { 2 } else { 1 };
            }
            _ => i += 1,
        }
    }
    n
}

/// 字节扫描建索引的状态机：feed 任意切分的字节切片（BufReader 缓冲或 64KB 块均可），
/// 行语义与 count_eols/split_lines 一致：`\n` / lone `\r` 均为行界，`\r\n` 只算一个。
struct ByteScan {
    anchors: Vec<Anchor>,
    next_anchor: u64,
    lines: u64,
    line_start: u64,
    pos: u64,       // 绝对扫描位置（= 下一块首字节的文件偏移）
    carry_cr: bool, // 上一块末字节是 \r，需与下一块首字节联合判定
}

impl ByteScan {
    fn new() -> Self {
        Self {
            anchors: Vec::new(),
            next_anchor: 0,
            lines: 0,
            line_start: 0,
            pos: 0,
            carry_cr: false,
        }
    }

    fn note_line(&mut self) {
        if self.line_start >= self.next_anchor {
            self.anchors.push(Anchor {
                offset: self.line_start,
                line: self.lines,
            });
            self.next_anchor += ANCHOR_STRIDE;
        }
    }

    fn feed(&mut self, buf: &[u8]) {
        let mut i = 0usize;
        if self.carry_cr {
            // 上一块末尾 \r：无论本块首字节是否 \n 都结束一行
            self.note_line();
            self.lines += 1;
            let skip = if buf.first() == Some(&b'\n') { 1u64 } else { 0 };
            self.line_start = self.pos + skip;
            self.pos += skip;
            i = skip as usize;
            self.carry_cr = false;
        }
        while i < buf.len() {
            match buf[i] {
                b'\n' => {
                    self.note_line();
                    self.lines += 1;
                    self.line_start = self.pos + 1;
                }
                b'\r' => {
                    if i + 1 < buf.len() {
                        self.note_line();
                        self.lines += 1;
                        let eol = if buf[i + 1] == b'\n' { 2u64 } else { 1 };
                        self.line_start = self.pos + eol;
                        i += eol as usize - 1;
                        self.pos += eol - 1;
                    } else {
                        self.carry_cr = true;
                    }
                }
                _ => {}
            }
            i += 1;
            self.pos += 1;
        }
    }

    fn finish(mut self, file_len: u64) -> LineIndex {
        if file_len > 0 && self.line_start < file_len {
            // 末行无行尾符
            self.note_line();
            self.lines += 1;
        }
        LineIndex {
            anchors: self.anchors,
            total_lines: self.lines,
            file_len,
            utf16: None,
        }
    }
}

/// UTF-16 扫描建索引的状态机：按 2 字节码元推进，奇数尾字节忽略（与逐对 read_exact
/// 在 EOF 断行的旧实现语义一致）。
struct Utf16Scan {
    le: bool,
    anchors: Vec<Anchor>,
    next_anchor: u64,
    lines: u64,
    line_start: u64,
    pos: u64,
    pending_cr: bool,
}

impl Utf16Scan {
    fn new(le: bool) -> Self {
        Self {
            le,
            anchors: vec![Anchor { offset: 0, line: 0 }],
            next_anchor: ANCHOR_STRIDE,
            lines: 0,
            line_start: 0,
            pos: 0,
            pending_cr: false,
        }
    }

    fn feed(&mut self, buf: &[u8]) {
        for pair in buf.as_chunks::<2>().0 {
            let unit = if self.le {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            };
            if self.pending_cr {
                self.lines += 1;
                self.line_start = if unit == 10 { self.pos + 2 } else { self.pos };
                self.pending_cr = false;
                if self.line_start >= self.next_anchor {
                    self.anchors.push(Anchor {
                        offset: self.line_start,
                        line: self.lines,
                    });
                    self.next_anchor = self.line_start + ANCHOR_STRIDE;
                }
                if unit == 10 {
                    self.pos += 2;
                    continue;
                }
            }
            if unit == 10 {
                self.lines += 1;
                self.line_start = self.pos + 2;
                if self.line_start >= self.next_anchor {
                    self.anchors.push(Anchor {
                        offset: self.line_start,
                        line: self.lines,
                    });
                    self.next_anchor = self.line_start + ANCHOR_STRIDE;
                }
            } else if unit == 13 {
                self.pending_cr = true;
            }
            self.pos += 2;
        }
    }

    fn finish(mut self, file_len: u64) -> LineIndex {
        if self.pending_cr {
            self.lines += 1;
            self.line_start = file_len;
        }
        if self.line_start < file_len {
            self.lines += 1;
        }
        if file_len == 0 {
            self.anchors.clear();
        }
        LineIndex {
            anchors: self.anchors,
            total_lines: self.lines,
            file_len,
            utf16: Some(self.le),
        }
    }
}

enum IndexScan {
    Byte(ByteScan),
    Utf16(Utf16Scan),
}

impl IndexScan {
    fn feed(&mut self, buf: &[u8]) {
        match self {
            IndexScan::Byte(s) => s.feed(buf),
            IndexScan::Utf16(s) => s.feed(buf),
        }
    }

    fn finish(self, file_len: u64) -> LineIndex {
        match self {
            IndexScan::Byte(s) => s.finish(file_len),
            IndexScan::Utf16(s) => s.finish(file_len),
        }
    }
}

/// 顺序扫描构建行锚点索引（后台线程执行，不阻塞首屏）。
/// 行语义与 count_eols/split_lines 一致：`\n` / lone `\r` 均为行界，`\r\n` 只算一个。
pub fn build_index(path: &Path) -> std::io::Result<LineIndex> {
    let f = File::open(path)?;
    let file_len = f.metadata()?.len();
    let mut r = BufReader::with_capacity(1024 * 1024, f);
    let mut scan = IndexScan::Byte(ByteScan::new());
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            break;
        }
        scan.feed(buf);
        let consumed = buf.len();
        r.consume(consumed);
    }
    Ok(scan.finish(file_len))
}

pub fn build_index_encoded(path: &Path, encoding: &str) -> std::io::Result<LineIndex> {
    let le = match encoding.to_ascii_uppercase().as_str() {
        "UTF-16LE" => Some(true),
        "UTF-16BE" => Some(false),
        _ => None,
    };
    let f = File::open(path)?;
    let file_len = f.metadata()?.len();
    let mut scan = match le {
        Some(le) => IndexScan::Utf16(Utf16Scan::new(le)),
        None => IndexScan::Byte(ByteScan::new()),
    };
    let mut r = BufReader::with_capacity(1024 * 1024, f);
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            break;
        }
        scan.feed(buf);
        let consumed = buf.len();
        r.consume(consumed);
    }
    Ok(scan.finish(file_len))
}

/// 经块缓存顺序扫描建行索引（打开路径复用同一遍磁盘读）：扫描期间块进入 LRU 缓存，
/// 随后的 text_read_all/滚动窗口全部内存命中——同一次打开不再对文件主体二读磁盘。
/// 适用于块缓存容量内（≤16MB）的同步索引；更大文件或后台扫描请走独立句柄的
/// [`build_index_encoded`]（避免扫描与 UI 读取争锁、超出容量自淘汰抖动）。
pub fn build_index_cached(cache: &mut ChunkCache, encoding: &str) -> std::io::Result<LineIndex> {
    let file_len = cache.len();
    let mut scan = match encoding.to_ascii_uppercase().as_str() {
        "UTF-16LE" => IndexScan::Utf16(Utf16Scan::new(true)),
        "UTF-16BE" => IndexScan::Utf16(Utf16Scan::new(false)),
        _ => IndexScan::Byte(ByteScan::new()),
    };
    for idx in 0..file_len.div_ceil(CHUNK as u64) {
        let block = cache.read_chunk(idx)?;
        scan.feed(&block);
    }
    Ok(scan.finish(file_len))
}

/// 跳转到目标行，返回该行起始的字节偏移（依赖锚点索引，002-AC-8）。
/// 行界与 build_index 同语义（\n / lone \r）。
pub fn jump_to_line(cache: &mut ChunkCache, index: &LineIndex, target: u64) -> Option<u64> {
    if index.anchors.is_empty() {
        return Some(0);
    }
    let mut lo = 0usize;
    let mut hi = index.anchors.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if index.anchors[mid].line <= target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let a = if lo == 0 {
        Anchor { offset: 0, line: 0 }
    } else {
        index.anchors[lo - 1]
    };
    let mut remaining = target - a.line;
    let mut off = a.offset;
    {
        let width = if index.utf16.is_some() { 2 } else { 1 };
        let mut cr = false;
        while off < cache.len() {
            let idx = off / CHUNK as u64;
            let chunk = cache.read_chunk(idx).ok()?;
            let base = idx * CHUNK as u64;
            for pos in ((off - base) as usize..chunk.len().saturating_sub(width - 1)).step_by(width)
            {
                let unit = match index.utf16 {
                    Some(true) => u16::from_le_bytes([chunk[pos], chunk[pos + 1]]),
                    Some(false) => u16::from_be_bytes([chunk[pos], chunk[pos + 1]]),
                    None => u16::from(chunk[pos]),
                };
                if cr {
                    remaining = remaining.saturating_sub(1);
                    cr = false;
                    if unit == 10 {
                        if remaining == 0 {
                            return Some(base + pos as u64 + width as u64);
                        }
                        continue;
                    }
                }
                if remaining == 0 {
                    return Some(base + pos as u64);
                }
                if unit == 13 {
                    cr = true;
                } else if unit == 10 {
                    remaining -= 1;
                }
            }
            off = base + CHUNK as u64;
        }
        Some(cache.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn gen_test_file(path: &Path, lines: usize) {
        let f = File::create(path).unwrap();
        let mut w = std::io::BufWriter::new(f);
        for i in 0..lines {
            writeln!(w, "line-{:06} padded-content-for-spike-migration-xxxx", i).unwrap();
        }
        w.flush().unwrap();
    }

    #[test]
    fn first_screen_and_tail() {
        let dir = std::env::temp_dir().join("ZiEdit-fe-test1");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.log");
        gen_test_file(&p, 10_000);
        let mut cache = ChunkCache::open(&p).unwrap();
        let buf = cache.read_lines_from(0, 50).unwrap();
        // 整块读取粒度：至少 50 行（渲染层再按行切分）
        assert!(count_eols(&buf) >= 50);
        let last = (cache.len() - 1) / CHUNK as u64;
        let tail = cache.read_chunk(last).unwrap();
        assert!(tail.contains(&b'\n'));
        assert_eq!(tail.last(), Some(&b'\n'));
    }

    #[test]
    fn index_and_jump() {
        let dir = std::env::temp_dir().join("ZiEdit-fe-test2");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("b.log");
        gen_test_file(&p, 10_000);
        let mut cache = ChunkCache::open(&p).unwrap();
        let index = build_index(&p).unwrap();
        assert_eq!(index.total_lines, 10_000);
        let off = jump_to_line(&mut cache, &index, 5000).expect("jump failed");
        let win = cache.read_lines_from(off, 1).unwrap();
        let s = String::from_utf8_lossy(&win);
        assert!(
            s.starts_with("line-005000"),
            "got: {}",
            &s[..s.len().min(40)]
        );
        // 越界目标返回文件尾
        let end = jump_to_line(&mut cache, &index, u64::MAX / 2).unwrap();
        assert_eq!(end, cache.len());
    }

    #[test]
    fn cache_lru_eviction() {
        let dir = std::env::temp_dir().join("ZiEdit-fe-test3");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("c.log");
        gen_test_file(&p, 5_000);
        let mut cache = ChunkCache::open(&p).unwrap();
        let chunks = cache.len().div_ceil(CHUNK as u64);
        for i in 0..chunks {
            cache.read_chunk(i).unwrap();
        }
        let (hits, misses) = cache.stats();
        assert!(misses >= chunks, "misses={} chunks={}", misses, chunks);
        // 再次读第 0 块：已被 LRU 淘汰则必 miss；无论如何不报错
        cache.read_chunk(0).unwrap();
        let _ = hits;
    }

    #[test]
    fn warm_block_hit_and_guard() {
        // warm_block 预热块 0 后 read_chunk 计为命中；长度不符/越界字节忽略（打开路径减读）
        let dir = std::env::temp_dir().join("ZiEdit-fe-warm");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("warm.log");
        gen_test_file(&p, 500);
        let mut cache = ChunkCache::open(&p).unwrap();
        let (_, m0) = cache.stats();
        assert_eq!(m0, 0);
        let head: Vec<u8> = {
            use std::io::Read as _;
            let mut f = File::open(&p).unwrap();
            let mut buf = vec![0u8; CHUNK.min(cache.len() as usize)];
            f.read_exact(&mut buf).unwrap();
            buf
        };
        cache.warm_block(0, head.clone());
        let block = cache.read_chunk(0).unwrap();
        assert_eq!(&block[..], &head[..]);
        let (h1, m1) = cache.stats();
        assert_eq!((h1, m1), (1, 0), "预热后命中零读盘");
        // 长度不符：忽略（不破坏缓存）
        cache.warm_block(1, vec![0u8; 3]);
        let mut probe = ChunkCache::open(&p).unwrap();
        probe.warm_block(0, vec![0u8; 3]);
        let (_, m2) = probe.stats();
        assert_eq!(m2, 0);
    }

    // ---- H1/B1 修复回归：EOF 边界与 CR 行尾 ----

    #[test]
    fn no_trailing_newline_reads_partial() {
        // 末行无换行的文件：读取窗口含末行不再报错，返回部分内容
        let dir = std::env::temp_dir().join("ZiEdit-fe-test4");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("no-nl.txt");
        std::fs::write(&p, b"aaa\nbbb\nccc-no-newline").unwrap();
        let mut cache = ChunkCache::open(&p).unwrap();
        let win = cache.read_lines_from(0, 10).expect("partial read");
        assert_eq!(win, b"aaa\nbbb\nccc-no-newline");
        let idx = build_index(&p).unwrap();
        assert_eq!(idx.total_lines, 3, "末行无换行也计一行");
    }

    #[test]
    fn empty_file_read_and_index() {
        let dir = std::env::temp_dir().join("ZiEdit-fe-test5");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("empty.txt");
        std::fs::write(&p, b"").unwrap();
        let mut cache = ChunkCache::open(&p).unwrap();
        let win = cache.read_lines_from(0, 50).expect("空文件不报错");
        assert!(win.is_empty());
        let idx = build_index(&p).unwrap();
        assert_eq!(idx.total_lines, 0);
        assert_eq!(jump_to_line(&mut cache, &idx, 0), Some(0));
    }

    #[test]
    fn cr_only_file_lines() {
        // 旧 Mac 格式（lone CR）：行索引按 \r 切行，跳转/窗口读取一致
        let dir = std::env::temp_dir().join("ZiEdit-fe-test6");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("cr.txt");
        let mut content = Vec::new();
        for i in 0..100 {
            content.extend_from_slice(format!("crline-{:03}", i).as_bytes());
            content.push(b'\r');
        }
        std::fs::write(&p, &content).unwrap();
        let idx = build_index(&p).unwrap();
        assert_eq!(idx.total_lines, 100, "lone CR 也是行界");
        let mut cache = ChunkCache::open(&p).unwrap();
        let off = jump_to_line(&mut cache, &idx, 42).expect("jump");
        let win = cache.read_lines_from(off, 1).unwrap();
        let s = String::from_utf8_lossy(&win);
        assert!(s.starts_with("crline-042"), "got {}", &s[..s.len().min(16)]);
    }

    #[test]
    fn crlf_crlf_and_mixed_eol_count() {
        assert_eq!(count_eols(b"a\r\nb\r\nc"), 2);
        assert_eq!(count_eols(b"a\rb\nc"), 2);
        assert_eq!(count_eols(b"a\nb\r\n"), 2);
        // 末尾孤立 \r 不计入（由后续数据判定）
        assert_eq!(count_eols(b"a\nb\r"), 1);
        // 混合：\r\n 与 lone \r 与 \n 并存
        assert_eq!(count_eols(b"a\r\nb\rc\nd"), 3);
    }

    #[test]
    fn jump_across_eol_kinds() {
        let dir = std::env::temp_dir().join("ZiEdit-fe-test7");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("mix.txt");
        std::fs::write(&p, b"one\r\ntwo\rthree\nfour").unwrap();
        let idx = build_index(&p).unwrap();
        assert_eq!(idx.total_lines, 4);
        let mut cache = ChunkCache::open(&p).unwrap();
        let off3 = jump_to_line(&mut cache, &idx, 3).expect("jump to 4th line");
        assert_eq!(off3, b"one\r\ntwo\rthree\n".len() as u64);
        let win = cache.read_lines_from(off3, 5).unwrap();
        assert_eq!(win, b"four");
    }

    /// build_index_cached 与独立句柄扫描逐锚点一致（打开路径减读的无行为变化锁）：
    /// 覆盖多块、块边界 lone \r（跨块联合判定）、UTF-16 两字节序与奇数尾字节。
    #[test]
    fn build_index_cached_matches_standalone_scan() {
        let dir = std::env::temp_dir().join("ZiEdit-fe-test8");
        std::fs::create_dir_all(&dir).unwrap();
        // 多块内容：块 0 的最后一个字节恰为 lone \r（跨 64KB 块边界联合判定），
        // 中段 CRLF/LF 混合，文件尾无行尾符
        let mut content = Vec::with_capacity(CHUNK * 2 + 64);
        content.extend(std::iter::repeat_n(b'x', CHUNK - 1));
        content.push(b'\r');
        while content.len() < CHUNK * 2 + 11 {
            content.extend_from_slice(b"Z\r\nY\n");
        }
        content.extend_from_slice(b"tail-no-eol");
        let p = dir.join("cached-idx.txt");
        std::fs::write(&p, &content).unwrap();
        let standalone = build_index(&p).unwrap();
        let mut cache = ChunkCache::open(&p).unwrap();
        let via_cache = build_index_cached(&mut cache, "UTF-8").unwrap();
        assert_eq!(via_cache.total_lines, standalone.total_lines);
        assert_eq!(via_cache.anchors, standalone.anchors);
        assert_eq!(via_cache.utf16, standalone.utf16);
        // 扫描后块已进缓存：全文件读取零未命中（打开路径不再二读磁盘的契约）
        let (hits, misses) = cache.stats();
        assert!(misses > 0, "扫描期间应发生按需读块");
        let chunks = content.len().div_ceil(CHUNK);
        let mut full = Vec::new();
        for idx in 0..chunks as u64 {
            full.extend_from_slice(&cache.read_chunk(idx).unwrap());
        }
        assert_eq!(full, content);
        assert_eq!(cache.stats().1, misses, "复读全部命中，无新增未命中");
        assert!(cache.stats().0 > hits);

        // UTF-16：码元级边界
        for name in ["UTF-16LE", "UTF-16BE"] {
            let text = format!("{}\r\n中文😀\rthird\nlast", "x".repeat(CHUNK / 2 - 2));
            let raw = crate::encoding::encode_preserving_bom(&text, name, &[]).unwrap();
            let p16 = dir.join(format!("cached-idx-{}.txt", name));
            std::fs::write(&p16, &raw).unwrap();
            let a = build_index_encoded(&p16, name).unwrap();
            let mut c16 = ChunkCache::open(&p16).unwrap();
            let b = build_index_cached(&mut c16, name).unwrap();
            assert_eq!(b.total_lines, a.total_lines, "{}", name);
            assert_eq!(b.anchors, a.anchors, "{}", name);
            assert_eq!(b.utf16, a.utf16, "{}", name);
        }

        // 奇数尾字节：独立扫描 read_exact 于 EOF 断行、缓存扫描 chunks_exact 丢余量——均忽略
        let mut odd_raw: Vec<u8> = Vec::new();
        for u in "a\nb".encode_utf16() {
            odd_raw.extend_from_slice(&u.to_le_bytes());
        }
        odd_raw.push(0x00);
        let p16odd = dir.join("cached-idx-utf16-odd.txt");
        std::fs::write(&p16odd, &odd_raw).unwrap();
        let oa = build_index_encoded(&p16odd, "UTF-16LE").unwrap();
        let mut codd16 = ChunkCache::open(&p16odd).unwrap();
        let ob = build_index_cached(&mut codd16, "UTF-16LE").unwrap();
        assert_eq!(ob.total_lines, oa.total_lines);
        assert_eq!(ob.anchors, oa.anchors);

        // 奇数长度 UTF-8 内容 + 空文件边界
        let podd = dir.join("cached-idx-odd.txt");
        std::fs::write(&podd, b"a\nb\rc").unwrap();
        let sa = build_index(&podd).unwrap();
        let mut codd = ChunkCache::open(&podd).unwrap();
        let sb = build_index_cached(&mut codd, "UTF-8").unwrap();
        assert_eq!(sb.total_lines, sa.total_lines);
        assert_eq!(sb.anchors, sa.anchors);
        let pempty = dir.join("cached-idx-empty.txt");
        std::fs::write(&pempty, b"").unwrap();
        let mut cempty = ChunkCache::open(&pempty).unwrap();
        assert_eq!(
            build_index_cached(&mut cempty, "UTF-8")
                .unwrap()
                .total_lines,
            0
        );
    }
    #[test]
    fn utf16_line_windows_and_cross_chunk_crlf() {
        for name in ["UTF-16LE", "UTF-16BE"] {
            let text = format!("{}\r\n中文😀\rthird\nlast", "x".repeat(CHUNK / 2 - 2));
            let raw = crate::encoding::encode_preserving_bom(
                &text,
                name,
                if name == "UTF-16LE" {
                    &[0xff, 0xfe]
                } else {
                    &[0xfe, 0xff]
                },
            )
            .unwrap();
            let p =
                std::env::temp_dir().join(format!("ZiEdit-lines-{}-{}", name, std::process::id()));
            std::fs::write(&p, &raw).unwrap();
            let index = build_index_encoded(&p, name).unwrap();
            assert_eq!(index.total_lines, 4);
            let mut cache = ChunkCache::open(&p).unwrap();
            for (line, expected) in [(1, "中文😀"), (2, "third"), (3, "last")] {
                let off = jump_to_line(&mut cache, &index, line).unwrap();
                let bytes = cache.read_lines_encoded(off, 1, index.utf16).unwrap();
                let (decoded, replaced) = crate::encoding::decode(&bytes, name);
                assert!(!replaced);
                assert_eq!(decoded.split(['\r', '\n']).next().unwrap(), expected);
            }
            std::fs::remove_file(p).unwrap();
        }
    }

    #[test]
    fn bounded_window_and_crlf_at_chunk_edge() {
        let p = std::env::temp_dir().join(format!("ZiEdit-window-budget-{}", std::process::id()));
        let mut bytes = vec![b'x'; CHUNK - 1];
        bytes.extend_from_slice(b"\r\nnext\n");
        std::fs::write(&p, &bytes).unwrap();
        let mut cache = ChunkCache::open(&p).unwrap();
        let index = build_index(&p).unwrap();
        let off = jump_to_line(&mut cache, &index, 1).unwrap();
        assert_eq!(off, CHUNK as u64 + 1);
        assert_eq!(cache.read_lines_from(off, 1).unwrap(), b"next\n");
        std::fs::write(&p, vec![b'x'; MAX_LINE_WINDOW_BYTES + CHUNK]).unwrap();
        let mut cache = ChunkCache::open(&p).unwrap();
        assert!(
            cache
                .read_lines_from(0, 1)
                .unwrap_err()
                .to_string()
                .contains("LINE_WINDOW_TOO_LARGE")
        );
        std::fs::remove_file(p).unwrap();
    }
}
