//! compare —— 深度对比核心（008 子 PRD，ADR 010）
//! 行哈希流式 diff：每行两个 64 位哈希（原始字节 / 解码文本），similar 跑在哈希序列上；
//! 内存 = 行数 × 16 字节；超阈值（500 万行）降级为 4KB 锚点窗口哈希的块级对比。
//! 纯 Rust 核心，不依赖 tauri 运行时（可独立单测）；性能红线：顺序流式，不整文件驻留。

pub mod detect;
mod input;
pub use input::{InputState, input_state, inputs_binary};

use std::collections::hash_map::DefaultHasher;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use similar::{Algorithm, capture_diff_slices_deadline};

use crate::encoding;

/// 行哈希降级阈值（008 规则 4；可在设置调整的候选项）
pub const LINE_LIMIT: u64 = 5_000_000;
/// compare_detail 单次行窗口上限
pub const DETAIL_WINDOW: u64 = 2_000;
/// diff 兜底 deadline（≈3s）：超时 similar 返回非最小但**合法**的 diff
/// （剩余区间按 delete+insert 切分，行号区间仍正确）。
/// 采样预检 [`should_degrade`] 已把会触发该情形的「整体改写型」输入几乎排除，
/// 此值只防御采样漏网的病态形态（如行序重排：采样命中率高、Myers 代价仍高）；
/// 500 万行阈值与既有降级语义不受影响。
pub const DIFF_DEADLINE: Duration = Duration::from_secs(3);

/// 一行的双哈希：字节含换行符，文本去换行（CRLF/LF 差异 → 字节异/文本同）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LineHash {
    pub byte: u64,
    pub text: u64,
}

pub fn hash_of<T: Hash + ?Sized>(v: &T) -> u64 {
    let mut h = DefaultHasher::new();
    v.hash(&mut h);
    h.finish()
}

/// 去除行尾换行（\r\n / \n / \r）
fn trim_newline(mut s: &str) -> &str {
    s = s.strip_suffix('\n').unwrap_or(s);
    s = s.strip_suffix('\r').unwrap_or(s);
    s
}

/// 流式哈希整文件（按行）；返回每行哈希与元信息。
/// 解码缓冲复用（小项）：每行新建解码器但复用 String 容量（语义与逐行
/// `encoding::decode` 一致：BOM 嗅探按行、替换字符按行产出）。
pub fn hash_lines(path: &Path, enc_name: &str, cap: u64) -> std::io::Result<(Vec<LineHash>, u64)> {
    let f = File::open(path)?;
    let mut r = BufReader::with_capacity(1024 * 1024, f);
    let enc = encoding_rs::Encoding::for_label(enc_name.as_bytes()).unwrap_or(encoding_rs::UTF_8);
    let mut out = Vec::new();
    let mut raw = Vec::with_capacity(512);
    let mut text = String::with_capacity(1024);
    let mut total: u64 = 0;
    loop {
        raw.clear();
        let n = r.read_until(b'\n', &mut raw)?;
        if n == 0 {
            break;
        }
        total += 1;
        if total > cap {
            // 上限保护：超 cap 停止收集（调用方改走降级）
            return Ok((out, total));
        }
        text.clear();
        let mut dec = enc.new_decoder();
        if let Some(need) = dec.max_utf8_buffer_length(n) {
            text.reserve(need);
        }
        let _ = dec.decode_to_string(&raw, &mut text, true);
        out.push(LineHash {
            byte: hash_of(&raw),
            text: hash_of(trim_newline(&text)),
        });
        if total.is_multiple_of(262_144) {
            out.reserve(262_144);
        }
    }
    Ok((out, total))
}

/// 降级窗口对比结果：每窗口哈希 + 每窗口行号区间 `(首行, 末行)`（1 基）
pub type WindowHashLines = (Vec<LineHash>, Vec<(u64, u64)>);

/// 降级路径：按 4KB 窗口哈希（字节/文本），块级对比。
/// 同时返回每窗口的**行号区间** `(首行, 末行)`（1 基，与该窗口字节区间相交的行）——
/// 降级块的 a/b 坐标是窗口号，而前端契约（textLines/compareDetail 按行号拉取）需要行号，
/// 调用方用 [`window_blocks_to_lines`] 做块→行映射（修前降级详情把
/// 块号当行号应答，5M 路径老问题，采样降级扩大暴露面后一并修复）。
/// 窗口按精确 4KB 边界填满读（read_full），保证窗口号 ↔ 字节偏移对齐。
pub fn hash_windows(path: &Path, enc_name: &str) -> std::io::Result<WindowHashLines> {
    let f = File::open(path)?;
    let mut r = BufReader::with_capacity(64 * 1024, f);
    let mut out = Vec::new();
    let mut lines = Vec::new();
    let mut buf = vec![0u8; 4096];
    let mut nl_before: u64 = 0;
    loop {
        let n = read_full(&mut r, &mut buf)?;
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        let nl_inside = chunk.iter().filter(|&&b| b == b'\n').count() as u64;
        let first = nl_before + 1;
        // 窗口内最后一个 \n 之后仍有字节（或整窗无 \n）：这些字节属于一条延伸到
        // 下一窗口的行，该行也与此窗口相交 → 末行 +1；窗口恰以 \n 结尾则不加。
        let trailing = match chunk.iter().rposition(|&b| b == b'\n') {
            Some(p) => p + 1 < n,
            None => true,
        };
        let last = nl_before + nl_inside + u64::from(trailing);
        let (text, _) = encoding::decode(chunk, enc_name);
        out.push(LineHash {
            byte: hash_of(chunk),
            text: hash_of(text.trim_end_matches(['\n', '\r'])),
        });
        lines.push((first, last));
        nl_before += nl_inside;
        if n < buf.len() {
            break; // EOF 尾窗
        }
    }
    Ok((out, lines))
}

/// 循环填满读：窗口必须精确对齐 4KB 边界（BufReader::read 可能短读，直接当窗口会错位）
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = r.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// 降级块坐标（4KB 窗口号，1 基）→ 行号区间。块级近似：窗口边界切进某行时该行
/// 与相邻两块都相交（±1 行跨界重叠），对降级（块级）展示语义可接受。
pub fn window_blocks_to_lines(
    mut blocks: Vec<Block>,
    la: &[(u64, u64)],
    lb: &[(u64, u64)],
) -> Vec<Block> {
    let map = |start: u64, end: u64, lines: &[(u64, u64)]| -> Option<(u64, u64)> {
        let (s, e) = (start as usize, end as usize);
        (s >= 1 && e >= s && e <= lines.len()).then(|| (lines[s - 1].0, lines[e - 1].1))
    };
    for blk in &mut blocks {
        if let Some((s, e)) = map(blk.a_start, blk.a_end, la) {
            blk.a_start = s;
            blk.a_end = e;
        }
        if let Some((s, e)) = map(blk.b_start, blk.b_end, lb) {
            blk.b_start = s;
            blk.b_end = e;
        }
    }
    blocks
}

/// 对齐块（1 基，含端点）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub kind: String, // equal | replace | delete | insert
    pub a_start: u64,
    pub a_end: u64,
    pub b_start: u64,
    pub b_end: u64,
}

/// 哈希序列 → 对齐块序列。
/// 直接以 `&[LineHash]` 喂 similar（LineHash: Eq+Hash+Ord），不再物化 16 字节串数组
/// 与引用切片两层中间 Vec（修前每侧 2 份、共 4 份临时分配， 6a）。
/// 带 DIFF_DEADLINE 兜底：超时得到非最小但合法的 diff（见 DIFF_DEADLINE 注释）。
pub fn diff_hashes(a: &[LineHash], b: &[LineHash]) -> Vec<Block> {
    let ops =
        capture_diff_slices_deadline(Algorithm::Myers, a, b, Some(Instant::now() + DIFF_DEADLINE));
    let mut out = Vec::new();
    for op in &ops {
        let blk = match op.tag() {
            similar::DiffTag::Equal => Block {
                kind: "equal".into(),
                a_start: op.old_range().start as u64 + 1,
                a_end: op.old_range().end as u64,
                b_start: op.new_range().start as u64 + 1,
                b_end: op.new_range().end as u64,
            },
            similar::DiffTag::Replace => Block {
                kind: "replace".into(),
                a_start: op.old_range().start as u64 + 1,
                a_end: op.old_range().end as u64,
                b_start: op.new_range().start as u64 + 1,
                b_end: op.new_range().end as u64,
            },
            similar::DiffTag::Delete => Block {
                kind: "delete".into(),
                a_start: op.old_range().start as u64 + 1,
                a_end: op.old_range().end as u64,
                b_start: 0,
                b_end: 0,
            },
            similar::DiffTag::Insert => Block {
                kind: "insert".into(),
                a_start: 0,
                a_end: 0,
                b_start: op.new_range().start as u64 + 1,
                b_end: op.new_range().end as u64,
            },
        };
        out.push(blk);
    }
    out
}

// ---- 采样预检----

/// 采样预检参数：每侧等距采 ≤1 万个行哈希，命中率 <15% 判「整体改写型」。
pub const SAMPLE_MAX: usize = 10_000;
pub const SAMPLE_MATCH_FLOOR: f64 = 0.15;
/// 预检只对大输入启用：小文件 Myers 本就毫秒级，保持既有行级结果（含 enc_marks）零变化。
pub const SAMPLE_PRECHECK_MIN_LINES: usize = 100_000;

/// 估算 a 侧采样行哈希在 b 侧的**成员**命中率（位置无关）：
/// 对 b 侧**全量**行哈希建排序成员表，a 侧按步长采样后二分查成员。
/// 修前两侧同下标步进——B 开头插入一行即全错位，99% 相似的文件被误判为 0。
/// 翻译改写/完全不同文件 → ≈0；插入/删除/局部修改 → 接近未改部分占比（位置无关）。
/// 两侧任一为空返回 1.0（空侧 diff 是平凡全增/全删，不触发降级）。
/// 同内容同判定：纯函数、无时间依赖（缺陷 2 的确定性路由依赖此性质）。
pub fn sample_match_rate(a: &[LineHash], b: &[LineHash]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 1.0;
    }
    let sa = (a.len() / SAMPLE_MAX).max(1);
    // b 全量排序副本（排序+二分，比 HashSet 省每条目开销；b 本就存在，内存翻倍可控）
    let mut sorted: Vec<LineHash> = b.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let sampled = a.len().div_ceil(sa);
    let hits = a
        .iter()
        .step_by(sa)
        .filter(|h| sorted.binary_search(h).is_ok())
        .count();
    hits as f64 / sampled as f64
}

/// 全量行 diff 前的降级判决：大输入（任一侧 ≥10 万行）且采样命中率 <15% 时
/// 直接走既有 hash_windows 有界降级路径。判据（经验值）与理由：
/// Myers 复杂度 O((N+M)·D)，D ≈ 不匹配行数；命中率 <15% 意味着两侧几乎没有
/// 公共行（整体改写型输入），全量行 diff 是 O(N·M) 级灾难，而块级降级结果仍完整可用。
/// 500 万行阈值与降级语义不动；此为新增护栏。
pub fn should_degrade(a: &[LineHash], b: &[LineHash]) -> bool {
    if a.len() < SAMPLE_PRECHECK_MIN_LINES && b.len() < SAMPLE_PRECHECK_MIN_LINES {
        return false;
    }
    sample_match_rate(a, b) < SAMPLE_MATCH_FLOOR
}

/// 行级类别：解码文本相同但字节不同时，区分"编码差异"与"行尾差异"
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineCat {
    /// 行尾差异：去掉换行符后字节完全一致（LF/CRLF/CR）
    Eol,
    /// 编码差异：去掉换行符后字节仍不同（如 UTF-8 vs GBK）
    Encoding,
}

/// 原始行字节 → 行类别（detail 路径逐行调用）
pub fn line_category(raw_a: &[u8], raw_b: &[u8]) -> LineCat {
    let ta = raw_a.strip_suffix(b"\n").unwrap_or(raw_a);
    let ta = ta.strip_suffix(b"\r").unwrap_or(ta);
    let tb = raw_b.strip_suffix(b"\n").unwrap_or(raw_b);
    let tb = tb.strip_suffix(b"\r").unwrap_or(tb);
    if ta == tb {
        LineCat::Eol
    } else {
        LineCat::Encoding
    }
}

/// 行级徽标判决（008 规则 9 v0.4 单一判决点）：**解码文本相同而原始字节不同**（行尾/编码差异）
/// 才给出行类别；文本本身不同 = 内容差异（行内 span 已按六类分类），不打「编码/EOL」行级徽标。
/// 修前：detail 对窗口内全部配对行无条件调 line_category，凡文本有变的行都被误标 Encoding。
pub fn detail_line_cat(text_a: &str, text_b: &str, raw_a: &[u8], raw_b: &[u8]) -> Option<LineCat> {
    if text_a != text_b || raw_a == raw_b {
        return None;
    }
    Some(line_category(raw_a, raw_b))
}

/// `\n` 行锚点（compare 语义：`read_lines_raw`/`hash_lines` 均按 `\n` 切行，lone `\r` 不是行界
/// ——与 file_engine 的 build_index（`\r` 也是行界）不同，故独立维护）。
#[derive(Debug, Clone, Copy)]
struct NlAnchor {
    /// 该行起始的字节偏移
    offset: u64,
    /// 该行的 0 基行号（= 此前出现的 `\n` 计数）
    line: u64,
}

struct NlIndex {
    anchors: Vec<NlAnchor>,
}

/// 顺序扫描构建 `\n` 锚点（每 4KB 至多一个，后台/首次 detail 调用 O(file) 一次）
fn build_nl_index(path: &Path) -> std::io::Result<NlIndex> {
    let f = File::open(path)?;
    let mut r = BufReader::with_capacity(1024 * 1024, f);
    let mut anchors = Vec::new();
    let mut lines: u64 = 0;
    let mut pos: u64 = 0;
    let mut next_anchor: u64 = 0;
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            break;
        }
        for (i, &b) in buf.iter().enumerate() {
            if b == b'\n' {
                lines += 1;
                let line_start = pos + i as u64 + 1;
                if line_start >= next_anchor {
                    anchors.push(NlAnchor {
                        offset: line_start,
                        line: lines,
                    });
                    next_anchor = line_start + 4 * 1024;
                }
            }
        }
        let consumed = buf.len();
        pos += consumed as u64;
        r.consume(consumed);
    }
    Ok(NlIndex { anchors })
}

/// `\n` 锚点缓存：`(path, len, mtime)` LRU（容量 8）——滚动详情不再每屏从文件头
/// 线性重扫（6e：首次 O(file) 建锚点，之后 O(窗口+4KB)；外部修改自动失效）
fn nl_index_cache()
-> &'static Mutex<crate::encoding::ProbeLru<crate::encoding::ProbeKey, Arc<NlIndex>>> {
    static CACHE: OnceLock<
        Mutex<crate::encoding::ProbeLru<crate::encoding::ProbeKey, Arc<NlIndex>>>,
    > = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(crate::encoding::ProbeLru::new(8)))
}

fn nl_index_cached(path: &Path) -> std::io::Result<Arc<NlIndex>> {
    let key = crate::encoding::probe_key(path)?;
    if let Ok(mut cache) = nl_index_cache().lock()
        && let Some(hit) = cache.get(&key)
    {
        return Ok(hit.clone());
    }
    let idx = Arc::new(build_nl_index(path)?);
    if let Ok(mut cache) = nl_index_cache().lock() {
        cache.put(key, idx.clone());
    }
    Ok(idx)
}

/// 取指定行区间 [from,to]（1 基含端点）的原始行（含行尾字节，与旧 read_until(b'\n')
/// 口径一致）。走锚点缓存 + file_engine 块缓存：滚动详情不再每屏 O(file) 头部重扫。
pub fn read_lines_raw(path: &Path, from: u64, to: u64) -> std::io::Result<Vec<Vec<u8>>> {
    use crate::file_engine::{CHUNK, ChunkCache};
    let index = nl_index_cached(path)?;
    let mut cache = ChunkCache::open(path)?;
    let from = from.max(1);
    let want = (to.saturating_sub(from) + 1).min(DETAIL_WINDOW);
    if want == 0 {
        return Ok(Vec::new());
    }
    // 二分定位 ≤ from-1 的最后锚点，从锚点顺序扫 \n
    let (mut line, mut pos) = (0u64, 0u64);
    {
        let anchors = &index.anchors;
        let target = from - 1;
        let mut lo = 0usize;
        let mut hi = anchors.len();
        while lo < hi {
            let mid = (lo + hi) / 2;
            if anchors[mid].line <= target {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo > 0 {
            line = anchors[lo - 1].line;
            pos = anchors[lo - 1].offset;
        }
    }
    let len = cache.len();
    let mut out: Vec<Vec<u8>> = Vec::new();
    let mut cur = Vec::new();
    'scan: while pos < len && out.len() < want as usize {
        let idx = pos / CHUNK as u64;
        let chunk = cache.read_chunk(idx)?;
        let base = idx * CHUNK as u64;
        let start = (pos - base) as usize;
        for &b in &chunk[start..] {
            cur.push(b);
            pos += 1;
            if b == b'\n' {
                if line + 1 >= from {
                    out.push(std::mem::take(&mut cur));
                    if out.len() as u64 >= want {
                        break 'scan;
                    }
                } else {
                    cur.clear();
                }
                line += 1;
            }
        }
    }
    // 末行无 \n 且落在区间内
    if out.len() < want as usize && !cur.is_empty() && line + 1 >= from {
        out.push(cur);
    }
    Ok(out)
}

/// 行尾类型（008 规则 5 v0.6）：前 64KiB 采样统计主导行尾；混合→"MIX"；无换行→"-"。
/// 与 bom_of 同为有界前缀读，不整读文件（分块红线）。
pub fn eol_of(path: &Path) -> &'static str {
    use std::io::Read as _;
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return "-",
    };
    let mut buf = [0u8; 65536];
    let n = f.read(&mut buf).unwrap_or(0);
    let data = &buf[..n];
    let (mut crlf, mut lf, mut cr) = (0u32, 0u32, 0u32);
    let mut i = 0;
    while i < data.len() {
        match data[i] {
            b'\r' if i + 1 < data.len() && data[i + 1] == b'\n' => {
                crlf += 1;
                i += 2;
                continue;
            }
            b'\r' => cr += 1,
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }
    match (crlf, lf, cr) {
        (0, 0, 0) => "-",
        (_, 0, 0) => "CRLF",
        (0, _, 0) => "LF",
        (0, 0, _) => "CR",
        _ => "MIX",
    }
}

/// 文件头部 BOM 探测（BOM 差异判定）
pub fn bom_of(path: &Path) -> &'static str {
    use std::io::Read as _;
    let mut f = File::open(path).ok();
    let mut head = [0u8; 4];
    let n = f
        .as_mut()
        .and_then(|f| f.read_exact(&mut head).ok())
        .map_or(0, |_| 4);
    match &head[..n] {
        [0xEF, 0xBB, 0xBF, ..] => "UTF-8",
        [0xFF, 0xFE, 0x00, 0x00] | [0x00, 0x00, 0xFE, 0xFF] => "UTF-32",
        [0xFF, 0xFE, ..] => "UTF-16LE",
        [0xFE, 0xFF, ..] => "UTF-16BE",
        _ => "",
    }
}

// ---- 规范化另存（008 规则 12） ----

/// 规范化选项
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeOpts {
    #[serde(default)]
    pub strip_bom: bool,
    #[serde(default)]
    pub nfc: bool,
    #[serde(default)]
    pub newline: Option<String>, // Some("LF"|"CRLF"|"CR")
    #[serde(default)]
    pub full_to_half: bool,
}

/// 文本规范化（纯函数，单测覆盖）。
/// 单趟扫描（6d）：流式规范化（NFKC/NFC 迭代器逐字符产出）→ 行尾状态机
/// （`\r\n` 与 lone `\r` 归一为一个行界再按目标行尾输出），替代修前最坏 5 份全文本
/// 拷贝的链式 replace/collect。输出与旧版逐字节一致（`normalize_single_pass_matches_legacy`
/// 单测锁定）；`\r`/`\n` 不参与 NFC/NFKC 的组合分解，规范化与行尾转换先后可交换。
pub fn normalize_text(text: &str, opts: &NormalizeOpts) -> String {
    use unicode_normalization::UnicodeNormalization;
    let nl = opts.newline.as_deref();
    let push_break = |out: &mut String| match nl {
        Some("CRLF") => out.push_str("\r\n"),
        Some("CR") => out.push('\r'),
        _ => out.push('\n'),
    };
    let norm: Box<dyn Iterator<Item = char> + '_> = match (opts.full_to_half, opts.nfc) {
        (true, false) => Box::new(text.chars().nfkc()),
        (false, true) => Box::new(text.chars().nfc()),
        (true, true) => Box::new(text.chars().nfkc().nfc()),
        (false, false) => Box::new(text.chars()),
    };
    if nl.is_none() {
        return norm.collect();
    }
    let mut out = String::with_capacity(text.len());
    // 上一字符是 \r：与下一字符联合判定（\r\n 只切一次；lone \r 也是一个行界）
    let mut pending_cr = false;
    for ch in norm {
        match ch {
            '\r' => {
                if pending_cr {
                    // 连续 lone \r：前一个是独立行界
                    push_break(&mut out);
                }
                pending_cr = true;
            }
            '\n' => {
                pending_cr = false;
                push_break(&mut out);
            }
            c => {
                if pending_cr {
                    pending_cr = false;
                    push_break(&mut out);
                }
                out.push(c);
            }
        }
    }
    if pending_cr {
        push_break(&mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_blocks_basic() {
        let h = |b: &str, t: &str| LineHash {
            byte: hash_of(&b),
            text: hash_of(&t),
        };
        let a = vec![h("1", "1"), h("2", "2"), h("3", "3")];
        let b = vec![h("1", "1"), h("x", "x"), h("3", "3")];
        let blocks = diff_hashes(&a, &b);
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[1].kind, "replace");
        assert_eq!((blocks[1].a_start, blocks[1].a_end), (2, 2));
    }

    #[test]
    fn line_category_eol_and_encoding() {
        assert_eq!(line_category(b"a\r\n", b"a\n"), LineCat::Eol);
        assert_eq!(
            line_category("中\n".as_bytes(), "中\r\n".as_bytes()),
            LineCat::Eol
        );
        assert_eq!(
            line_category("中\n".as_bytes(), b"\xd6\xd0\n"),
            LineCat::Encoding
        );
    }

    #[test]
    fn detail_line_cat_only_when_text_equal() {
        assert_eq!(detail_line_cat("same", "same", b"same\n", b"same\n"), None);
        // 文本不同 = 内容差异 → 无行级徽标（修前误标「编码」）
        assert_eq!(
            detail_line_cat("alpha", "beta", b"alpha\n", b"beta\n"),
            None
        );
        // 文本同、行尾异 → eol（CRLF vs LF）
        assert_eq!(
            detail_line_cat("row", "row", b"row\r\n", b"row\n"),
            Some(LineCat::Eol)
        );
        // 文本同、字节异 → encoding（同字形不同编码，如 GBK vs UTF-8）
        assert_eq!(
            detail_line_cat("中文", "中文", b"\xd6\xd0\xce\xc4\n", "中文\n".as_bytes()),
            Some(LineCat::Encoding)
        );
    }

    #[test]
    fn normalization() {
        let opts = NormalizeOpts {
            strip_bom: false,
            nfc: true,
            newline: Some("LF".into()),
            full_to_half: false,
        };
        assert_eq!(normalize_text("a\r\nb\r\n", &opts), "a\nb\n");
        assert_eq!(normalize_text("cafe\u{0301}", &opts), "caf\u{00E9}");
        let fw = NormalizeOpts {
            full_to_half: true,
            ..opts
        };
        assert_eq!(normalize_text("，；()", &fw), ",;()");
    }

    #[test]
    fn bom_detect() {
        let dir = std::env::temp_dir().join("ZiEdit-cmp-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("bom.txt");
        std::fs::write(&p, [0xEF, 0xBB, 0xBF, b'h', b'i']).unwrap();
        assert_eq!(bom_of(&p), "UTF-8");
        let p2 = dir.join("nobom.txt");
        std::fs::write(&p2, b"hi").unwrap();
        assert_eq!(bom_of(&p2), "");
    }

    #[test]
    fn eol_detect() {
        // 008 规则 5 v0.6：行尾类型采样（LF/CRLF/CR/MIX/-）
        let dir = std::env::temp_dir().join("ZiEdit-cmp-test");
        std::fs::create_dir_all(&dir).unwrap();
        let lf = dir.join("eol-lf.txt");
        std::fs::write(&lf, b"a\nb\nc\n").unwrap();
        assert_eq!(eol_of(&lf), "LF");
        let crlf = dir.join("eol-crlf.txt");
        std::fs::write(&crlf, b"a\r\nb\r\n").unwrap();
        assert_eq!(eol_of(&crlf), "CRLF");
        let mix = dir.join("eol-mix.txt");
        std::fs::write(&mix, b"a\r\nb\nc").unwrap();
        assert_eq!(eol_of(&mix), "MIX");
        let cr = dir.join("eol-cr.txt");
        std::fs::write(&cr, b"a\rb\r").unwrap();
        assert_eq!(eol_of(&cr), "CR");
        let none = dir.join("eol-none.txt");
        std::fs::write(&none, b"abc").unwrap();
        assert_eq!(eol_of(&none), "-");
    }

    // ---- 护栏单测 ----

    /// 6b 采样预检：匹配率估算与降级判决
    #[test]
    fn sample_precheck_rates_and_gate() {
        let h = |n: u64| LineHash { byte: n, text: n };
        // 相同大输入：命中率 1.0，不降级
        let same: Vec<LineHash> = (0..SAMPLE_PRECHECK_MIN_LINES as u64 + 10).map(h).collect();
        assert_eq!(sample_match_rate(&same, &same), 1.0);
        assert!(!should_degrade(&same, &same));
        // 整体改写型（大输入、零公共行）：命中率 0 → 降级
        let other: Vec<LineHash> = (0..SAMPLE_PRECHECK_MIN_LINES as u64 + 10)
            .map(|n| h(u64::MAX / 2 + n))
            .collect();
        assert!(should_degrade(&same, &other));
        // 小输入不触发预检（保持既有行级结果零变化）
        let small_a: Vec<LineHash> = (0..100).map(h).collect();
        let small_b: Vec<LineHash> = (0..100).map(|n| h(9_000_000 + n)).collect();
        assert!(!should_degrade(&small_a, &small_b));
        // 大输入但九成行相同：命中率 ≈0.9，不降级
        // （替换行取 i%10==3，避免与采样步长 10 对齐——采样点恰好全落在替换行上是合法的低估）
        let mut mostly = same.clone();
        for (i, v) in mostly.iter_mut().enumerate() {
            if i % 10 == 3 {
                *v = h(7_000_000 + i as u64);
            }
        }
        assert!(sample_match_rate(&mostly, &same) > 0.85);
        assert!(!should_degrade(&mostly, &same));
        // 空侧是平凡全增/全删：不触发降级
        assert_eq!(sample_match_rate(&[], &same), 1.0);
        assert!(!should_degrade(&[], &same));
        assert!(!should_degrade(&same, &[]));
    }

    /// ：成员判定位置无关——B 开头插入/删除行不得把高相似对误判为 0
    #[test]
    fn sample_membership_survives_offset_shift() {
        let h = |n: u64| LineHash { byte: n, text: n };
        let a: Vec<LineHash> = (0..SAMPLE_PRECHECK_MIN_LINES as u64 + 5).map(h).collect();
        // B 开头插入一行（其余与 A 完全一致，整体仅差 1 行）：修前同下标步进全错位 → 0
        let mut b_shifted = vec![h(u64::MAX)];
        b_shifted.extend(a.iter().copied());
        let rate = sample_match_rate(&a, &b_shifted);
        assert!(rate > 0.99, "插入一行不得误降级：{rate}");
        assert!(!should_degrade(&a, &b_shifted));
        // 对称：B 开头删除一行（B ⊂ A）同样高命中
        assert!(!should_degrade(&a, &a[1..]));
    }

    /// ：成员采样阈值边界——恰好 15% 不降级（严格小于），差一行即降级
    #[test]
    fn sample_membership_threshold_boundary() {
        let h = |n: u64| LineHash { byte: n, text: n };
        const N: usize = 200_000; // stride = 20 → 采样 10000 个
        let a: Vec<LineHash> = (0..N as u64)
            .map(|i| {
                // 采样点（i%20==0）中前 1500 个为成员：恰好 1500/10000 = 15%
                if i % 20 == 0 && i < 30_000 {
                    h(i)
                } else {
                    h(1_000_000 + i)
                }
            })
            .collect();
        let members: Vec<LineHash> = (0..30_000u64).step_by(20).map(h).collect();
        let rate = sample_match_rate(&a, &members);
        assert!((rate - 0.15).abs() < 1e-9, "rate={rate}");
        assert!(!should_degrade(&a, &members), "恰在阈值上不降级");
        // 抽掉一个成员 → 1499/10000 < 15% → 降级
        let mut fewer = members.clone();
        fewer[0] = h(2_000_000);
        assert!(should_degrade(&a, &fewer), "低于阈值必须降级");
    }

    /// ：降级块（4KB 窗口号）→ 行号映射的坐标契约
    #[test]
    fn hash_windows_line_ranges_and_block_mapping() {
        let dir = std::env::temp_dir().join("ZiEdit-cmp-win-tests");
        std::fs::create_dir_all(&dir).unwrap();
        // 100 行 × 100 字节 = 10000 字节 → 3 个窗口（4096/4096/1808）
        let line = |i: usize| -> Vec<u8> {
            let mut v = format!("L{i:03}").into_bytes();
            v.resize(99, b'x');
            v.push(b'\n');
            v
        };
        let content: Vec<u8> = (0..100).flat_map(|i| line(i).into_iter()).collect();
        let p = dir.join("win.txt");
        std::fs::write(&p, &content).unwrap();
        let (hashes, lines) = hash_windows(&p, "UTF-8").unwrap();
        assert_eq!(hashes.len(), 3);
        // w0: bytes 0..4096 含 40 个 \n，尾随 96 字节属第 41 行 → (1, 41)
        // w1: 41..81 行的 \n + 第 82 行开头 92 字节 → (41, 82)；w2: (82, 100)
        assert_eq!(lines, vec![(1, 41), (41, 82), (82, 100)]);
        // 块映射：equal 窗口块 [1..2] → 行 (1..41)；replace 块 [3..3] → 行 (82..100)
        let blocks = vec![
            Block {
                kind: "equal".into(),
                a_start: 1,
                a_end: 2,
                b_start: 1,
                b_end: 2,
            },
            Block {
                kind: "replace".into(),
                a_start: 3,
                a_end: 3,
                b_start: 3,
                b_end: 3,
            },
            Block {
                kind: "delete".into(),
                a_start: 1,
                a_end: 3,
                b_start: 0,
                b_end: 0,
            },
        ];
        let mapped = window_blocks_to_lines(blocks, &lines, &lines);
        // equal 窗口块 [1..2] → 首窗首行 .. 末窗末行 = (1, 82)
        assert_eq!((mapped[0].a_start, mapped[0].a_end), (1, 82));
        assert_eq!((mapped[0].b_start, mapped[0].b_end), (1, 82));
        assert_eq!((mapped[1].a_start, mapped[1].a_end), (82, 100));
        assert_eq!((mapped[1].b_start, mapped[1].b_end), (82, 100));
        // delete 块的 b 坐标为 0（无 B 侧）：不做映射，保持 0
        assert_eq!((mapped[2].a_start, mapped[2].a_end), (1, 100));
        assert_eq!((mapped[2].b_start, mapped[2].b_end), (0, 0));
        // 越界窗口号（防御）：不映射不 panic
        let oob = vec![Block {
            kind: "equal".into(),
            a_start: 1,
            a_end: 99,
            b_start: 1,
            b_end: 1,
        }];
        let mapped = window_blocks_to_lines(oob, &lines, &lines);
        assert_eq!((mapped[0].a_start, mapped[0].a_end), (1, 99));
    }

    /// 6d 单趟 normalize_text 与旧链式实现逐字节一致（锁定）
    #[test]
    fn normalize_single_pass_matches_legacy() {
        fn legacy(text: &str, opts: &NormalizeOpts) -> String {
            use unicode_normalization::UnicodeNormalization;
            let mut s: String = text.to_string();
            if opts.full_to_half {
                s = s.nfkc().collect();
            }
            if opts.nfc {
                s = s.nfc().collect();
            }
            if let Some(nl) = &opts.newline {
                let joined = s.replace("\r\n", "\n").replace('\r', "\n");
                s = match nl.as_str() {
                    "CRLF" => joined.replace('\n', "\r\n"),
                    "CR" => joined.replace('\n', "\r"),
                    _ => joined,
                };
            }
            s
        }
        let inputs = [
            "",
            "a\nb\r\nc\rd",
            "\r\n\r\n\n\r\r",
            "cafe\u{0301}",
            "，；()\r\n全角",
            "a\r\rb\r\n\n",
            "\u{FEFF}bom\r\n",
            "mixed ＡＢ\u{0301}c\r\nd\re",
            "no newline at all",
        ];
        let combos: [(bool, bool, Option<&str>); 9] = [
            (false, false, None),
            (true, false, None),
            (false, true, None),
            (false, false, Some("LF")),
            (false, false, Some("CRLF")),
            (false, false, Some("CR")),
            (true, true, Some("CRLF")),
            (true, false, Some("LF")),
            (false, true, Some("CR")),
        ];
        for text in inputs {
            for (fwh, nfc, nl) in combos {
                let opts = NormalizeOpts {
                    strip_bom: false,
                    nfc,
                    newline: nl.map(Into::into),
                    full_to_half: fwh,
                };
                assert_eq!(
                    normalize_text(text, &opts),
                    legacy(text, &opts),
                    "text={text:?} opts={opts:?}"
                );
            }
        }
    }

    /// 6e read_lines_raw：口径与旧 read_until(b'\n') 一致 + 锚点定位（跨 4KB 步长）
    #[test]
    fn read_lines_raw_window_and_anchors() {
        let dir = std::env::temp_dir().join("ZiEdit-cmp-raw-tests");
        std::fs::create_dir_all(&dir).unwrap();
        // 行长 > 4KB：锚点必然跨步长，验证二分定位正确
        let mut content = String::new();
        for i in 0..50 {
            content.push_str(&format!("line-{:03}-", i));
            content.push_str(&"x".repeat(200));
            content.push('\n');
        }
        content.push_str("tail-no-newline");
        let p = dir.join("anchors.txt");
        std::fs::write(&p, content.as_bytes()).unwrap();
        let raw = read_lines_raw(&p, 2, 4).unwrap();
        assert_eq!(raw.len(), 3);
        assert_eq!(raw[0], format!("line-001-{}\n", "x".repeat(200)).as_bytes());
        assert_eq!(raw[2], format!("line-003-{}\n", "x".repeat(200)).as_bytes());
        // 末行无换行
        let tail = read_lines_raw(&p, 51, 60).unwrap();
        assert_eq!(tail, vec![b"tail-no-newline".to_vec()]);
        // from 超界 → 空
        assert!(read_lines_raw(&p, 99, 100).unwrap().is_empty());
        // lone \r 不是 compare 行界（\n 才是）——口径锁定
        let p2 = dir.join("cr.txt");
        std::fs::write(&p2, b"aa\rbb\ncc").unwrap();
        assert_eq!(
            read_lines_raw(&p2, 1, 10).unwrap(),
            vec![b"aa\rbb\n".to_vec(), b"cc".to_vec()]
        );
        // 窗口上限：DETAIL_WINDOW 钳制（生成足够多行）
        let mut big = Vec::new();
        for _ in 0..DETAIL_WINDOW + 500 {
            big.extend_from_slice(b"row\n");
        }
        let p3 = dir.join("many.txt");
        std::fs::write(&p3, &big).unwrap();
        assert_eq!(
            read_lines_raw(&p3, 1, u64::MAX).unwrap().len(),
            DETAIL_WINDOW as usize
        );
    }
}
