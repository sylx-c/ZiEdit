//! commands/compare —— 深度对比命令薄层（008 子 PRD；架构编码约定：只做参数校验与转发）

use serde::Serialize;

use crate::compare::{self, detect};
use crate::encoding;
use crate::error::ZiEditError;
use std::path::PathBuf;

/// 文件对比元信息
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub path: String,
    pub encoding: String,
    pub bom: &'static str,
    /// 行尾类型（008 规则 5 v0.6）：LF/CRLF/CR/MIX/-
    pub eol: &'static str,
    pub lines: u64,
    pub len: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub binary: bool,
    pub input_state: compare::InputState,
    pub blocks: Vec<compare::Block>,
    pub meta_a: FileMeta,
    pub meta_b: FileMeta,
    /// 行哈希 diff 的行级"文本同/字节异"标记（块内 1 基行号 → encoding/eol）
    pub enc_marks_a: Vec<(u64, u8)>,
    pub enc_marks_b: Vec<(u64, u8)>,
    /// 降级为锚点块级对比（008 规则 4）
    pub degraded: bool,
}

fn meta_of(path: &str, enc: &str, lines: u64) -> std::io::Result<FileMeta> {
    let p = PathBuf::from(path);
    let len = std::fs::metadata(&p)?.len();
    Ok(FileMeta {
        path: path.into(),
        encoding: enc.into(),
        bom: compare::bom_of(&p),
        eol: compare::eol_of(&p),
        lines,
        len,
    })
}
fn enc_name_of(path: &str) -> Result<String, ZiEditError> {
    let p = PathBuf::from(path);
    // 探测走 (path,len,mtime) 进程内缓存：compare_open/compare_detail
    // 每次调用各探测两侧文件，修前是每次调用重读头尾采样 ×2
    let info = encoding::detect_cached(&p)
        .map_err(|e| ZiEditError::ctx("Encoding detection failed", e))?;
    Ok(info.name)
}

/// 打开对比：流式行哈希 diff（超限降级为锚点块级）
#[tauri::command]
pub async fn compare_open(a: String, b: String) -> Result<CompareResult, ZiEditError> {
    let pa = PathBuf::from(&a);
    let pb = PathBuf::from(&b);
    let input_state = compare::input_state(&pa, &pb)?;
    let binary = compare::inputs_binary(&pa, &pb)?;
    if binary {
        return Ok(CompareResult {
            binary,
            input_state,
            blocks: Vec::new(),
            meta_a: meta_of(&a, "-", 0)?,
            meta_b: meta_of(&b, "-", 0)?,
            enc_marks_a: Vec::new(),
            enc_marks_b: Vec::new(),
            degraded: false,
        });
    }
    let enc_a = enc_name_of(&a)?;
    let enc_b = enc_name_of(&b)?;

    let (ha, ta) = compare::hash_lines(&pa, &enc_a, compare::LINE_LIMIT)
        .map_err(|e| ZiEditError::ctx("Read failed", e))?;
    let (hb, tb) = compare::hash_lines(&pb, &enc_b, compare::LINE_LIMIT)
        .map_err(|e| ZiEditError::ctx("Read failed", e))?;

    let degraded = ta > compare::LINE_LIMIT
        || tb > compare::LINE_LIMIT
        // 采样预检（6b）：大输入且采样命中率 <15%（整体改写型）直接走既有
        // hash_windows 有界降级，避免 Myers O(N·M) 级代价；判据见 should_degrade
        || compare::should_degrade(&ha, &hb);
    let (blocks, marks_a, marks_b) = if degraded {
        // 降级：按 4KB 窗口哈希重跑（块级，008 规则 4）
        let (wa, la) =
            compare::hash_windows(&pa, &enc_a).map_err(|e| ZiEditError::ctx("Read failed", e))?;
        let (wb, lb) =
            compare::hash_windows(&pb, &enc_b).map_err(|e| ZiEditError::ctx("Read failed", e))?;
        // 块号→行号映射：降级块的 a/b 坐标是 4KB 窗口号，而前端契约
        //（textLines/compareDetail）按行号拉取——修前把块号当行号下发，降级详情答错行
        //（5M 降级路径既有问题，采样降级扩大暴露面后一并修复）
        (
            compare::window_blocks_to_lines(compare::diff_hashes(&wa, &wb), &la, &lb),
            Vec::new(),
            Vec::new(),
        )
    } else {
        // 行级 diff + "文本同/字节异"标记（编码差异候选；detail 再细分 eol/encoding）
        let blocks = compare::diff_hashes(&ha, &hb);
        let mut marks_a = Vec::new();
        let mut marks_b = Vec::new();
        for blk in &blocks {
            if blk.kind != "replace" {
                continue;
            }
            let n = (blk.a_end - blk.a_start + 1).min(blk.b_end - blk.b_start + 1);
            for k in 0..n {
                let ia = (blk.a_start + k - 1) as usize;
                let ib = (blk.b_start + k - 1) as usize;
                if let (Some(va), Some(vb)) = (ha.get(ia), hb.get(ib))
                    && va.text == vb.text
                    && va.byte != vb.byte
                {
                    marks_a.push((blk.a_start + k, 1));
                    marks_b.push((blk.b_start + k, 1));
                }
            }
        }
        (blocks, marks_a, marks_b)
    };

    Ok(CompareResult {
        binary,
        input_state,
        blocks,
        meta_a: meta_of(&a, &enc_a, if degraded { ta } else { ha.len() as u64 })?,
        meta_b: meta_of(&b, &enc_b, if degraded { tb } else { hb.len() as u64 })?,
        enc_marks_a: marks_a,
        enc_marks_b: marks_b,
        degraded,
    })
}

/// 详情行（1 基行号 + 文本 + 类别标记 + 变更 run）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailLine {
    pub no: u64,
    pub text: String,
    /// encoding / eol（行级类别，其余行为 None）
    pub line_cat: Option<String>,
    pub spans: Vec<detect::SpanText>,
}

/// 变更块内详情：按行取文本做码点级六类分类
#[tauri::command]
pub async fn compare_detail(
    a: String,
    b: String,
    a_from: u64,
    a_to: u64,
    b_from: u64,
    b_to: u64,
) -> Result<Vec<Vec<DetailLine>>, ZiEditError> {
    let enc_a = enc_name_of(&a)?;
    let enc_b = enc_name_of(&b)?;
    let a_to = a_to.min(a_from + compare::DETAIL_WINDOW - 1);
    let b_to = b_to.min(b_from + compare::DETAIL_WINDOW - 1);
    let raw_a = compare::read_lines_raw(&PathBuf::from(&a), a_from, a_to)
        .map_err(|e| ZiEditError::ctx("Read failed", e))?;
    let raw_b = compare::read_lines_raw(&PathBuf::from(&b), b_from, b_to)
        .map_err(|e| ZiEditError::ctx("Read failed", e))?;

    let side = |raws: &[Vec<u8>], from: u64, enc: &str| -> Vec<DetailLine> {
        raws.iter()
            .enumerate()
            .map(|(i, raw)| {
                let (text, _) = encoding::decode(raw, enc);
                DetailLine {
                    no: from + i as u64,
                    text: text.trim_end_matches(['\n', '\r']).to_string(),
                    line_cat: None,
                    spans: Vec::new(),
                }
            })
            .collect()
    };
    let mut la = side(&raw_a, a_from, &enc_a);
    let mut lb = side(&raw_b, b_from, &enc_b);

    // 配对行：码点级分类 + 行级类别（encoding/eol；仅「文本同/字节异」行，008 规则 9 v0.4）
    let pairs = la.len().min(lb.len());
    for i in 0..pairs {
        if let Some(cat) = compare::detail_line_cat(&la[i].text, &lb[i].text, &raw_a[i], &raw_b[i])
        {
            la[i].line_cat = Some(match cat {
                compare::LineCat::Eol => "eol".to_string(),
                compare::LineCat::Encoding => "encoding".to_string(),
            });
            lb[i].line_cat = la[i].line_cat.clone();
        }
        let spans = detect::classify_line_pair(&la[i].text, &lb[i].text);
        la[i].spans = spans.clone();
        lb[i].spans = spans;
    }
    Ok(vec![la, lb])
}

/// 规范化预览行（008 规则 12 v0.6：另存前的修复 diff 预览）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLine {
    pub line: u64,
    pub before: String,
    pub after: String,
}

/// 规范化预览结果（有界载荷：计数 + ≤20 行样本，正文不整篇回传——分块红线）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizePreview {
    pub same: bool,
    pub changed: u64,
    pub added: u64,
    pub removed: u64,
    pub sample: Vec<PreviewLine>,
}

/// 规范化预览（008 规则 12 v0.6）：按当前选项计算修复 diff 概要，不落盘。
/// 读取与限额口径同 normalize_save（≤100MB 有界读）。
#[tauri::command]
pub async fn normalize_preview(
    src: String,
    opts: compare::NormalizeOpts,
    encoding_name: Option<String>,
) -> Result<NormalizePreview, ZiEditError> {
    const LIMIT: u64 = 100 * 1024 * 1024;
    let p = PathBuf::from(&src);
    let enc = match &encoding_name {
        Some(e) => e.clone(),
        None => enc_name_of(&src)?,
    };
    let len = std::fs::metadata(&p)?.len();
    if len > LIMIT {
        return Err(ZiEditError::Msg(
            "File exceeds the 100MB normalization limit".into(),
        ));
    }
    use std::io::Read;
    let mut raw = Vec::new();
    std::fs::File::open(&p).and_then(|f| f.take(LIMIT + 1).read_to_end(&mut raw))?;
    if raw.len() as u64 > LIMIT {
        return Err(ZiEditError::Msg(
            "File grew beyond the 100MB normalization limit".into(),
        ));
    }
    let (mut text, _) = encoding::decode(&raw, &enc);
    if opts.strip_bom {
        text = text.trim_start_matches('\u{FEFF}').to_string();
    }
    let after = compare::normalize_text(&text, &opts);
    Ok(preview_summary(&text, &after))
}

/// 纯函数：行级修复概要（单测覆盖）。display 截断 120 字符、样本 ≤20 行。
/// 计数确定性保证：**计数不随机器速度变化**——
/// - 行数相等（normalize 的绝大多数情形）：逐位配对计数。normalize 是逐字符变换 +
///   行尾映射，不移动/增删行，等行数时逐位配对即最小编辑脚本的计数（单行替换 run 的
///   合计相同），O(N) 且不经过 Myers/diff_deadline。
/// - 行数不等（lone-CR 源的行尾归一会拆行）：小输入走 Myers 精确解；大而异输入
///   （成员采样 <15% 且 ≥10 万行，[`compare::should_degrade`] 同一确定性路由）按
///   「整体替换」计数，不依赖 deadline 的时间行为。
fn preview_summary(before: &str, after: &str) -> NormalizePreview {
    fn strip_cr(s: &str) -> &str {
        if let Some(t) = s.strip_suffix('\r') {
            t
        } else {
            s
        }
    }
    let take120 = |s: &str| -> String { s.chars().take(120).collect() };
    let a: Vec<&str> = before.split('\n').map(strip_cr).collect();
    let b: Vec<&str> = after.split('\n').map(strip_cr).collect();
    if a.len() == b.len() {
        // 逐位配对（确定性，见函数注释）
        let mut changed = 0u64;
        let mut sample = Vec::new();
        for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
            if x != y {
                changed += 1;
                if sample.len() < 20 {
                    sample.push(PreviewLine {
                        line: i as u64 + 1,
                        before: take120(x),
                        after: take120(y),
                    });
                }
            }
        }
        return NormalizePreview {
            same: changed == 0,
            changed,
            added: 0,
            removed: 0,
            sample,
        };
    }
    let lh = |v: &[&str]| -> Vec<compare::LineHash> {
        v.iter()
            .map(|l| compare::LineHash {
                byte: compare::hash_of(l),
                text: compare::hash_of(l),
            })
            .collect()
    };
    if compare::should_degrade(&lh(&a), &lh(&b)) {
        // 确定性路由：大而异输入按整体替换计数（changed = 较大侧行数），与机器速度无关
        let n = a.len().max(b.len()) as u64;
        let mut sample = Vec::new();
        for i in 0..a.len().min(b.len()) {
            if sample.len() >= 20 {
                break;
            }
            sample.push(PreviewLine {
                line: i as u64 + 1,
                before: take120(a[i]),
                after: take120(b[i]),
            });
        }
        return NormalizePreview {
            same: false,
            changed: n,
            added: 0,
            removed: 0,
            sample,
        };
    }
    let blocks = compare::diff_hashes(&lh(&a), &lh(&b));
    let mut changed = 0u64;
    let mut added = 0u64;
    let mut removed = 0u64;
    let mut sample = Vec::new();
    for blk in &blocks {
        match blk.kind.as_str() {
            "replace" => {
                changed += (blk.a_end - blk.a_start + 1).max(blk.b_end - blk.b_start + 1);
                for i in 0..(blk.a_end - blk.a_start + 1).max(blk.b_end - blk.b_start + 1) {
                    if sample.len() >= 20 {
                        break;
                    }
                    let ai = (blk.a_start - 1) + i; // 1 基 → 0 基
                    let bi = (blk.b_start - 1) + i;
                    sample.push(PreviewLine {
                        line: (ai + 1).min(a.len() as u64),
                        before: a
                            .get(ai as usize)
                            .map(|s| s.chars().take(120).collect())
                            .unwrap_or_default(),
                        after: b
                            .get(bi as usize)
                            .map(|s| s.chars().take(120).collect())
                            .unwrap_or_default(),
                    });
                }
            }
            "insert" => {
                added += blk.b_end - blk.b_start + 1;
                for i in blk.b_start..=blk.b_end {
                    if sample.len() >= 20 {
                        break;
                    }
                    sample.push(PreviewLine {
                        line: blk.a_start.min(a.len() as u64),
                        before: String::new(),
                        after: b
                            .get((i - 1) as usize)
                            .map(|s| s.chars().take(120).collect())
                            .unwrap_or_default(),
                    });
                }
            }
            "delete" => {
                removed += blk.a_end - blk.a_start + 1;
                for i in blk.a_start..=blk.a_end {
                    if sample.len() >= 20 {
                        break;
                    }
                    sample.push(PreviewLine {
                        line: i,
                        before: a
                            .get((i - 1) as usize)
                            .map(|s| s.chars().take(120).collect())
                            .unwrap_or_default(),
                        after: String::new(),
                    });
                }
            }
            _ => {}
        }
    }
    let same = changed == 0 && added == 0 && removed == 0;
    NormalizePreview {
        same,
        changed,
        added,
        removed,
        sample,
    }
}

/// 规范化另存（008 规则 12：NFC/去 BOM/行尾/全半角 → 新文件）
#[tauri::command]
pub async fn normalize_save(
    src: String,
    dst: String,
    opts: compare::NormalizeOpts,
    encoding_name: Option<String>,
) -> Result<u64, ZiEditError> {
    const LIMIT: u64 = 100 * 1024 * 1024;
    let p = PathBuf::from(&src);
    let enc = match &encoding_name {
        Some(e) => e.clone(),
        None => enc_name_of(&src)?,
    };
    let len = std::fs::metadata(&p)?.len();
    if len > LIMIT {
        return Err(ZiEditError::Msg(
            "File exceeds the 100MB normalization limit".into(),
        ));
    }
    use std::io::Read;
    let mut raw = Vec::new();
    std::fs::File::open(&p).and_then(|f| f.take(LIMIT + 1).read_to_end(&mut raw))?;
    if raw.len() as u64 > LIMIT {
        return Err(ZiEditError::Msg(
            "File grew beyond the 100MB normalization limit".into(),
        ));
    }
    let (mut text, _) = encoding::decode(&raw, &enc);
    if opts.strip_bom {
        text = text.trim_start_matches('\u{FEFF}').to_string();
    }
    let before = text.len();
    let text = compare::normalize_text(&text, &opts);
    let changed = (before != text.len()
        || opts.nfc
        || opts.full_to_half
        || opts.newline.is_some()
        || opts.strip_bom) as u64;
    let bytes =
        encoding::encode_preserving_bom(&text, &enc, if opts.strip_bom { &[] } else { &raw })
            .map_err(|e| ZiEditError::Msg(format!("Encoding write-back failed: {e}")))?;
    crate::store::atomic_write(std::path::Path::new(&dst), &bytes)?;
    Ok(changed)
}

/// 编码转换另存核心（002 规则 21a / 008 规则 13 v0.6）：原编码读（自动探测）→ 目标编码写新文件；
/// 目标不可映射时失败不落盘。≤100MB 有界读（与 normalize_save 同口径）。
pub fn encode_convert_impl(
    src: &std::path::Path,
    dst: &std::path::Path,
    to_enc: &str,
) -> Result<u64, ZiEditError> {
    const LIMIT: u64 = 100 * 1024 * 1024;
    let len = std::fs::metadata(src)?.len();
    if len > LIMIT {
        return Err(ZiEditError::Msg(
            "File exceeds the 100MB encoding conversion limit".into(),
        ));
    }
    use std::io::Read;
    let mut raw = Vec::new();
    std::fs::File::open(src).and_then(|f| f.take(LIMIT + 1).read_to_end(&mut raw))?;
    if raw.len() as u64 > LIMIT {
        return Err(ZiEditError::Msg(
            "File grew beyond the 100MB encoding conversion limit".into(),
        ));
    }
    let info =
        encoding::detect(src).map_err(|e| ZiEditError::ctx("Encoding detection failed", e))?;
    let (text, _) = encoding::decode(&raw, &info.name);
    let text = text.trim_start_matches('\u{FEFF}');
    let bytes = encoding::encode(text, to_enc)
        .map_err(|e| ZiEditError::Msg(format!("Encoding conversion failed: {e:?}")))?;
    crate::store::atomic_write(dst, &bytes)?;
    Ok(bytes.len() as u64)
}

/// 编码转换另存命令（薄包装）
#[tauri::command]
pub async fn encode_convert_save(
    src: String,
    dst: String,
    to_enc: String,
) -> Result<u64, ZiEditError> {
    encode_convert_impl(
        std::path::Path::new(&src),
        std::path::Path::new(&dst),
        &to_enc,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 008 规则 12 v0.6：预览概要纯函数——改/增/删计数与样本（≤20 行、120 字符截断）
    #[test]
    fn preview_summary_counts() {
        let same = preview_summary("a\nb\nc", "a\nb\nc");
        assert!(same.same);
        let rep = preview_summary("a\nX\nc", "a\nY\nc");
        assert_eq!((rep.changed, rep.added, rep.removed), (1, 0, 0));
        assert_eq!(rep.sample.len(), 1);
        assert_eq!(rep.sample[0].before, "X");
        assert_eq!(rep.sample[0].after, "Y");
        assert_eq!(rep.sample[0].line, 2);
        let del = preview_summary("a\nb\nc", "a\nc");
        assert_eq!((del.changed, del.added, del.removed), (0, 0, 1));
        let ins = preview_summary("a\nc", "a\nb\nc");
        assert_eq!((ins.changed, ins.added, ins.removed), (0, 1, 0));
        // 行尾归一（CRLF→LF）在展示层剥 \r：不构成文本差异
        let eol = preview_summary("a\r\nb\r\n", "a\nb\n");
        assert!(eol.same, "CRLF→LF 应仅字节异，预览按文本行视为相同");
    }

    /// ：preview 计数确定性——大而异输入不再经 Myers/deadline，
    /// 计数与机器速度无关（等行数逐位配对 / 大而异整体替换两条确定性路径）
    #[test]
    fn preview_counts_deterministic_no_deadline() {
        // ① 等行数 + 全量改写（全半角归一的最坏形态）：逐位配对，changed = N 精确值
        const N: usize = 150_000;
        let before: Vec<String> = (0..N).map(|i| format!("Ｆ{i}")).collect();
        let after: Vec<String> = (0..N).map(|i| format!("F{i}")).collect();
        let r = preview_summary(&before.join("\n"), &after.join("\n"));
        assert_eq!(r.changed, N as u64, "全量改写逐位计数必须精确");
        assert_eq!((r.added, r.removed), (0, 0));
        assert!(!r.same);
        assert_eq!(r.sample.len(), 20);
        assert_eq!(r.sample[0].line, 1);
        // ② 行数不等的大而异输入（lone-CR 源归一）：确定性整体替换，不跑 Myers
        const M: usize = 120_000;
        let cr_before = "x\r".repeat(M); // 无 \n → 1 行
        let cr_after = format!("{}x", "x\n".repeat(M - 1)); // M 行（无尾随空行）
        let r2 = preview_summary(&cr_before, &cr_after);
        assert_eq!(r2.changed, M as u64, "大而异按较大侧行数整体替换计数");
        assert_eq!((r2.added, r2.removed), (0, 0));
        // ③ 行数不等的小输入仍走 Myers 精确解（既有语义零变化）
        let r3 = preview_summary("a\nb\nc", "a\nc");
        assert_eq!((r3.changed, r3.added, r3.removed), (0, 0, 1));
    }

    /// 002 规则 21a / 008 规则 13 v0.6：编码转换另存核心（同步 impl，命令薄包装）
    #[test]
    fn encode_convert_impl_gbk() {
        let dir = std::env::temp_dir().join("ZiEdit-cmp-test");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("enc-utf8.txt");
        std::fs::write(&src, "中文abc".as_bytes()).unwrap();
        let dst = dir.join("enc-gbk-out.txt");
        let n = super::encode_convert_impl(&src, &dst, "GBK").unwrap();
        assert_eq!(n, 7); // GBK：中文=4 字节 + abc
        assert_eq!(
            std::fs::read(&dst).unwrap(),
            [0xD6, 0xD0, 0xCE, 0xC4, b'a', b'b', b'c']
        );
        let _ = std::fs::remove_file(&dst);
    }
}
