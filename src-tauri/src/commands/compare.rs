//! commands/compare —— 深度对比命令薄层（008 子 PRD；架构编码约定：只做参数校验与转发）

use serde::Serialize;

use crate::commands::ooxml::{self, Content, OoxmlRegistry};
use crate::compare::{self, detect, office::OfficeKind};
use crate::encoding;
use crate::error::ZiEditError;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

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
    /// Office 投影侧标记（批 1："docx"|"xlsx"；null=原始文本路径）。
    /// 投影侧的 encoding/bom/eol 无意义，前端隐藏徽标改示投影说明。
    pub office_a: Option<&'static str>,
    pub office_b: Option<&'static str>,
    /// 任一 docx 侧含修订标记（对比口径=接受修订后终态，头部如实告知）
    pub revisions: bool,
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
    // 探测走 (path,len,mtime) 进程内缓存（BE2 任务 1）：compare_open/compare_detail
    // 每次调用各探测两侧文件，修前是每次调用重读头尾采样 ×2
    let info = encoding::detect_cached(&p)
        .map_err(|e| ZiEditError::ctx("Encoding detection failed", e))?;
    Ok(info.name)
}

/// 打开对比：流式行哈希 diff（超限降级为锚点块级）。
/// Office 投影分流（批 1）：任一侧 docx/xlsx → 提取投影行序列再 diff，
/// 不再对原始 ZIP 字节做行哈希（deflate 噪声，同内容重存也全文标红）。
#[tauri::command]
pub async fn compare_open(
    app: tauri::AppHandle,
    a: String,
    b: String,
) -> Result<CompareResult, ZiEditError> {
    crate::paths::reject_device_path(&a)?;
    crate::paths::reject_device_path(&b)?;
    // 行哈希 diff / 编码探测 / 元信息读取均为阻塞 IO+CPU，移阻塞线程不冻结异步运行时（照 misc.rs 范例）。
    tauri::async_runtime::spawn_blocking(move || {
        let pa = PathBuf::from(&a);
        let pb = PathBuf::from(&b);
        let input_state = compare::input_state(&pa, &pb)?;
        let kind_a = compare::office::office_kind(&pa);
        let kind_b = compare::office::office_kind(&pb);
        if kind_a.is_some() || kind_b.is_some() {
            let registry = app.state::<OoxmlRegistry>();
            return compare_open_office(&registry, &a, &b, kind_a, kind_b, input_state);
        }
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
                office_a: None,
                office_b: None,
                revisions: false,
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
        // 采样预检（BE2 6b）：大输入且采样命中率 <15%（整体改写型）直接走既有
        // hash_windows 有界降级，避免 Myers O(N·M) 级代价；判据见 should_degrade
        || compare::should_degrade(&ha, &hb);
        let (blocks, marks_a, marks_b) = if degraded {
            // 降级：按 4KB 窗口哈希重跑（块级，008 规则 4）
            let (wa, la) = compare::hash_windows(&pa, &enc_a)
                .map_err(|e| ZiEditError::ctx("Read failed", e))?;
            let (wb, lb) = compare::hash_windows(&pb, &enc_b)
                .map_err(|e| ZiEditError::ctx("Read failed", e))?;
            // 块号→行号映射（BE2 收口缺陷 1）：降级块的 a/b 坐标是 4KB 窗口号，而前端契约
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
            office_a: None,
            office_b: None,
            revisions: false,
        })
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

// ---- Office 投影对比（批 1：docx/xlsx）----

fn office_tag(kind: Option<OfficeKind>) -> Option<&'static str> {
    match kind {
        Some(OfficeKind::Docx) => Some("docx"),
        Some(OfficeKind::Xlsx) => Some("xlsx"),
        None => None,
    }
}

/// Office 投影侧快照：行哈希 + 元信息（encoding/bom/eol 对投影无意义 → 占位值）
struct OfficeSide {
    hashes: Vec<compare::LineHash>,
    lines: u64,
    revisions: bool,
}

fn office_side(
    registry: &OoxmlRegistry,
    path: &str,
    kind: OfficeKind,
) -> Result<OfficeSide, ZiEditError> {
    match kind {
        OfficeKind::Docx => {
            let content = ooxml::load(registry, path, 0)?;
            let Content::Docx(doc) = &*content else {
                unreachable!()
            };
            Ok(OfficeSide {
                hashes: compare::office::hash_doc_lines(&doc.lines),
                lines: doc.lines.len() as u64,
                revisions: doc.revisions,
            })
        }
        OfficeKind::Xlsx => {
            let content = ooxml::load(registry, path, 1)?;
            let Content::Xlsx(book) = &*content else {
                unreachable!()
            };
            let projection = compare::office::project_xlsx_cached(std::path::Path::new(path), book);
            let lines = projection.len() as u64;
            Ok(OfficeSide {
                hashes: compare::office::hash_doc_lines(&projection),
                lines,
                revisions: false,
            })
        }
    }
}

/// Office 投影路径主流程（任一侧 docx/xlsx 时进入；混合 office↔text 亦支持——
/// 提取文本对原始文本的对比同样成立）。
fn compare_open_office(
    registry: &OoxmlRegistry,
    a: &str,
    b: &str,
    kind_a: Option<OfficeKind>,
    kind_b: Option<OfficeKind>,
    input_state: compare::InputState,
) -> Result<CompareResult, ZiEditError> {
    // 非投影侧仍按既有二进制判决拒绝；投影侧跳过（容器是 ZIP，binary 判据不适用）
    if (kind_a.is_none() && compare::input_binary(std::path::Path::new(a))?)
        || (kind_b.is_none() && compare::input_binary(std::path::Path::new(b))?)
    {
        return Ok(CompareResult {
            binary: true,
            input_state,
            blocks: Vec::new(),
            meta_a: meta_of(a, "-", 0)?,
            meta_b: meta_of(b, "-", 0)?,
            enc_marks_a: Vec::new(),
            enc_marks_b: Vec::new(),
            degraded: false,
            office_a: office_tag(kind_a),
            office_b: office_tag(kind_b),
            revisions: false,
        });
    }
    // 统一侧快照：Office 走投影（enc "-"，docx 带修订标志），文本走既有探测+行哈希
    let side_of = |registry: &OoxmlRegistry,
                   path: &str,
                   kind: Option<OfficeKind>|
     -> Result<(Vec<compare::LineHash>, u64, String, bool), ZiEditError> {
        match kind {
            Some(k) => {
                let side = office_side(registry, path, k)?;
                Ok((side.hashes, side.lines, "-".into(), side.revisions))
            }
            None => {
                let enc = enc_name_of(path)?;
                let (hashes, total) =
                    compare::hash_lines(&PathBuf::from(path), &enc, compare::LINE_LIMIT)
                        .map_err(|e| ZiEditError::ctx("Read failed", e))?;
                Ok((hashes, total, enc, false))
            }
        }
    };
    let (ha, ta, enc_a, rev_a) = side_of(registry, a, kind_a)?;
    let (hb, tb, enc_b, rev_b) = side_of(registry, b, kind_b)?;
    // 对齐到投影口径：byte := text。diff_hashes 按 (byte, text) 双字段判等——
    // 双哈希设计服务「同文异码」检测（文本对里 byte 含原始字节含换行）；投影无
    // 字节层，混合对的文本侧若保留原 byte，等内容行也会被判全替换。office 路径
    // 统一按解码文本相等对齐；编码/EOL 徽标本就不产出（enc_marks 恒空，语义一致）。
    let mut ha = ha;
    let mut hb = hb;
    for side in [&mut ha, &mut hb] {
        for h in side.iter_mut() {
            h.byte = h.text;
        }
    }
    // 行数上限：显式哨兵（投影侧由提取上限有界；混合对的文本侧超 500 万行同样
    // 如实报错——降级路径读原始容器字节对投影无意义，截断半截 diff 更不可取）
    if ha.len() as u64 > compare::LINE_LIMIT
        || ta > compare::LINE_LIMIT
        || hb.len() as u64 > compare::LINE_LIMIT
        || tb > compare::LINE_LIMIT
    {
        return Err(ZiEditError::Msg(format!(
            "OFFICE_PROJECTION_LIMIT:{}",
            compare::LINE_LIMIT
        )));
    }
    // 行级 diff：DIFF_DEADLINE（3s）兜底超时合法非最小解；采样降级不适用——
    // 其降级路径 hash_windows 读原始容器字节，对投影是噪声（见 compare::office 注释）。
    let blocks = compare::diff_hashes(&ha, &hb);
    let meta_side = |path: &str,
                     kind: Option<OfficeKind>,
                     enc: &str,
                     lines: u64|
     -> Result<FileMeta, ZiEditError> {
        match kind {
            Some(_) => {
                let len = std::fs::metadata(path).map(|m| m.len())?;
                Ok(FileMeta {
                    path: path.into(),
                    encoding: "-".into(),
                    bom: "",
                    eol: "-",
                    lines,
                    len,
                })
            }
            None => Ok(meta_of(path, enc, lines)?),
        }
    };
    Ok(CompareResult {
        binary: false,
        input_state,
        blocks,
        meta_a: meta_side(a, kind_a, &enc_a, ha.len() as u64)?,
        meta_b: meta_side(b, kind_b, &enc_b, hb.len() as u64)?,
        // 投影行 byte==text，无「文本同/字节异」可言；混合对的 office 侧同样不参与
        enc_marks_a: Vec::new(),
        enc_marks_b: Vec::new(),
        degraded: false,
        office_a: office_tag(kind_a),
        office_b: office_tag(kind_b),
        revisions: rev_a || rev_b,
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

/// Office 投影行窗口（1 基含端点）：ooxml::window 校验 + ≤5000 行钳制。
/// docx 零拷贝借用注册表缓存行；xlsx 现投影（注册表命中时仅 join 成本）。
/// 返回 (窗口行文本, 投影总行数)。
fn office_window(
    registry: &OoxmlRegistry,
    path: &str,
    kind: OfficeKind,
    from: u64,
    to: u64,
) -> Result<(Vec<String>, u64), ZiEditError> {
    let range = crate::ooxml::window(from, to).map_err(ZiEditError::Msg)?;
    // Arc 与 owned 都要活到切片用完（borrow checker：不能在 match 臂内释放）
    let content = match kind {
        OfficeKind::Docx => ooxml::load(registry, path, 0)?,
        OfficeKind::Xlsx => ooxml::load(registry, path, 1)?,
    };
    let owned: Arc<Vec<String>>;
    let slice: &[String] = match (&*content, kind) {
        (Content::Docx(doc), OfficeKind::Docx) => &doc.lines,
        (Content::Xlsx(book), OfficeKind::Xlsx) => {
            // 缓存投影（批 1 收尾）：窗口取行不再每次全量 join；键含 len/mtime，
            // 与注册表 workbook 同一失效语义（file 变化 → 两侧同时 miss 重解析）。
            owned = compare::office::project_xlsx_cached(std::path::Path::new(path), book);
            &owned
        }
        _ => unreachable!(),
    };
    let total = slice.len() as u64;
    let out = range
        .take_while(|i| *i < slice.len())
        .map(|i| slice[i].clone())
        .collect();
    Ok((out, total))
}

/// 对比视图相等块取行（批 1）：按 compare_open 同一分流取投影行窗口。
/// 有界：ooxml::window（1 基、≤5000 行）+ WINDOW_BYTES 行/窗护栏（与 document_lines 同口径）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeLine {
    pub no: u64,
    pub text: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeLinesResult {
    pub lines: Vec<OfficeLine>,
    pub total: u64,
}
#[tauri::command]
pub async fn office_lines(
    app: tauri::AppHandle,
    path: String,
    from: u64,
    to: u64,
) -> Result<OfficeLinesResult, ZiEditError> {
    crate::paths::reject_device_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<OoxmlRegistry>();
        let kind = compare::office::office_kind(&PathBuf::from(&path))
            .ok_or_else(|| ZiEditError::Msg("OFFICE_LINES:unsupported-kind".into()))?;
        let (texts, total) = office_window(&registry, &path, kind, from, to)?;
        let mut lines = Vec::with_capacity(texts.len());
        let mut bytes = 0usize;
        for (i, text) in texts.into_iter().enumerate() {
            if text.len() > crate::ooxml::WINDOW_BYTES {
                return Err(ZiEditError::Msg("OOXML_LINE_LIMIT:4MiB".into()));
            }
            if bytes + text.len() > crate::ooxml::WINDOW_BYTES {
                break;
            }
            bytes += text.len();
            lines.push(OfficeLine {
                no: from + i as u64,
                text,
            });
        }
        Ok(OfficeLinesResult { lines, total })
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

/// 变更块内详情：按行取文本做码点级六类分类。
/// Office 投影侧（批 1）：行文本取自投影切片，行级类别（编码/EOL）不判定——
/// 投影无字节层；六类码点级分类对投影行照常成立。
#[tauri::command]
pub async fn compare_detail(
    app: tauri::AppHandle,
    a: String,
    b: String,
    a_from: u64,
    a_to: u64,
    b_from: u64,
    b_to: u64,
) -> Result<Vec<Vec<DetailLine>>, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<OoxmlRegistry>();
        let kind_a = compare::office::office_kind(&PathBuf::from(&a));
        let kind_b = compare::office::office_kind(&PathBuf::from(&b));
        let a_to = a_to.min(a_from + compare::DETAIL_WINDOW - 1);
        let b_to = b_to.min(b_from + compare::DETAIL_WINDOW - 1);
        // 侧数据源：投影行（office）或原始行字节（文本，含编码用于解码与行级类别）
        enum Src {
            Office(Vec<String>),
            Text(Vec<Vec<u8>>, String),
        }
        let src = |registry: &OoxmlRegistry,
                   path: &str,
                   kind: Option<OfficeKind>,
                   from: u64,
                   to: u64|
         -> Result<Src, ZiEditError> {
            match kind {
                Some(k) => Ok(Src::Office(office_window(registry, path, k, from, to)?.0)),
                None => {
                    let enc = enc_name_of(path)?;
                    let raw = compare::read_lines_raw(&PathBuf::from(path), from, to)
                        .map_err(|e| ZiEditError::ctx("Read failed", e))?;
                    Ok(Src::Text(raw, enc))
                }
            }
        };
        let sa = src(&registry, &a, kind_a, a_from, a_to)?;
        let sb = src(&registry, &b, kind_b, b_from, b_to)?;

        let side = |s: Src, from: u64| -> (Vec<DetailLine>, Option<Vec<Vec<u8>>>) {
            match s {
                Src::Office(lines) => (
                    lines
                        .into_iter()
                        .enumerate()
                        .map(|(i, text)| DetailLine {
                            no: from + i as u64,
                            text,
                            line_cat: None,
                            spans: Vec::new(),
                        })
                        .collect(),
                    None,
                ),
                Src::Text(raws, enc) => (
                    raws.iter()
                        .enumerate()
                        .map(|(i, raw)| {
                            let (text, _) = encoding::decode(raw, &enc);
                            DetailLine {
                                no: from + i as u64,
                                text: text.trim_end_matches(['\n', '\r']).to_string(),
                                line_cat: None,
                                spans: Vec::new(),
                            }
                        })
                        .collect(),
                    Some(raws),
                ),
            }
        };
        let (mut la, raw_a) = side(sa, a_from);
        let (mut lb, raw_b) = side(sb, b_from);

        // 配对行：码点级分类 + 行级类别（encoding/eol；仅两侧都是原始文本时判定，
        // 008 规则 9 v0.4——投影行无字节层，混合对不产出编码/EOL 徽标）
        let pairs = la.len().min(lb.len());
        for i in 0..pairs {
            if let (Some(raw_a), Some(raw_b)) = (&raw_a, &raw_b)
                && let Some(cat) =
                    compare::detail_line_cat(&la[i].text, &lb[i].text, &raw_a[i], &raw_b[i])
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
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
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
    crate::paths::reject_device_path(&src)?;
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
/// 计数确定性保证（BE2 收口缺陷 2）：**计数不随机器速度变化**——
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
    crate::paths::reject_device_path(&src)?;
    crate::paths::reject_device_path(&dst)?;
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
    crate::paths::reject_device_path(&src.to_string_lossy())?;
    crate::paths::reject_device_path(&dst.to_string_lossy())?;
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

    // ---- 批 1：Office 投影对比（docx/xlsx 分流）----

    fn docx_fixture(name: &str, mid: &str) -> String {
        let xml = format!(
            "<w:document xmlns:w='w'><w:p><w:r><w:t>alpha</w:t></w:r></w:p><w:p><w:r><w:t>{mid}</w:t></w:r></w:p><w:p><w:r><w:t>gamma</w:t></w:r></w:p></w:document>"
        );
        crate::ooxml::fixture(&[("word/document.xml", &xml)], name)
    }
    fn xlsx_fixture(name: &str, b2: &str) -> String {
        crate::ooxml::fixture(
            &[
                (
                    "xl/workbook.xml",
                    "<workbook xmlns:r='r'><sheets><sheet name='Data' r:id='r1'/></sheets></workbook>",
                ),
                (
                    "xl/_rels/workbook.xml.rels",
                    "<Relationships><Relationship Id='r1' Target='worksheets/sheet1.xml'/></Relationships>",
                ),
                (
                    "xl/sharedStrings.xml",
                    &format!("<sst><si><t>h1</t></si><si><t>{b2}</t></si></sst>"),
                ),
                (
                    "xl/worksheets/sheet1.xml",
                    "<worksheet><sheetData><row r='1'><c r='A1' t='s'><v>0</v></c></row><row r='2'><c r='B2' t='s'><v>1</v></c></row></sheetData></worksheet>",
                ),
            ],
            name,
        )
    }
    fn temp_txt(name: &str, text: &str) -> String {
        let dir = std::env::temp_dir().join(format!("ZiEdit-cmp-office-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, text).unwrap();
        p.to_string_lossy().into_owned()
    }
    fn temp_bin(name: &str, bytes: &[u8]) -> String {
        let dir = std::env::temp_dir().join(format!("ZiEdit-cmp-office-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p.to_string_lossy().into_owned()
    }

    /// docx：同内容 → 0 差异（修前按原始 ZIP 字节对比是噪声全红）；
    /// 单段修改 → 恰好一个 replace 块（第 2 段）
    #[test]
    fn office_compare_docx_projection() {
        let a = docx_fixture("cmp-a.docx", "beta");
        let b = docx_fixture("cmp-b.docx", "beta");
        let c = docx_fixture("cmp-c.docx", "BETA");
        let registry = OoxmlRegistry::default();
        let state =
            compare::input_state(std::path::Path::new(&a), std::path::Path::new(&b)).unwrap();
        let same = compare_open_office(
            &registry,
            &a,
            &b,
            Some(OfficeKind::Docx),
            Some(OfficeKind::Docx),
            state,
        )
        .unwrap();
        assert!(!same.binary);
        assert_eq!(same.office_a, Some("docx"));
        assert_eq!(same.office_b, Some("docx"));
        assert!(!same.revisions);
        assert!(
            same.blocks.iter().all(|b| b.kind == "equal"),
            "同内容重存 → 0 差异，got {:?}",
            same.blocks
        );
        assert_eq!(same.meta_a.lines, 3);
        assert_eq!(same.meta_a.encoding, "-");
        assert_eq!(same.meta_a.bom, "");
        assert!(!same.degraded);
        assert!(same.enc_marks_a.is_empty());

        let state2 =
            compare::input_state(std::path::Path::new(&a), std::path::Path::new(&c)).unwrap();
        let diff = compare_open_office(
            &registry,
            &a,
            &c,
            Some(OfficeKind::Docx),
            Some(OfficeKind::Docx),
            state2,
        )
        .unwrap();
        let replaces: Vec<_> = diff.blocks.iter().filter(|b| b.kind == "replace").collect();
        assert_eq!(replaces.len(), 1, "单段修改 = 单 replace 块");
        assert_eq!((replaces[0].a_start, replaces[0].a_end), (2, 2));
        assert_eq!((replaces[0].b_start, replaces[0].b_end), (2, 2));
    }

    /// docx 修订标志传播：ins/del 出现 → revisions=true（对比头部如实告知终态口径）
    #[test]
    fn office_compare_docx_revisions_flag() {
        let plain = docx_fixture("rev-plain.docx", "beta");
        let xml = "<w:document xmlns:w='w'><w:p><w:ins><w:r><w:t>x</w:t></w:r></w:ins></w:p></w:document>";
        let marked = crate::ooxml::fixture(&[("word/document.xml", xml)], "rev-marked.docx");
        let registry = OoxmlRegistry::default();
        let state =
            compare::input_state(std::path::Path::new(&plain), std::path::Path::new(&marked))
                .unwrap();
        let res = compare_open_office(
            &registry,
            &plain,
            &marked,
            Some(OfficeKind::Docx),
            Some(OfficeKind::Docx),
            state,
        )
        .unwrap();
        assert!(res.revisions, "B 侧含修订 → 标志置位");
    }

    /// xlsx：sheet 头 + 行投影；改一格 = 单 replace（第 3 投影行 = 第 2 数据行）；
    /// 元信息 encoding "-"（投影无编码语义）
    #[test]
    fn office_compare_xlsx_projection() {
        let a = xlsx_fixture("xl-a.xlsx", "old");
        let b = xlsx_fixture("xl-b.xlsx", "new");
        let registry = OoxmlRegistry::default();
        let state =
            compare::input_state(std::path::Path::new(&a), std::path::Path::new(&b)).unwrap();
        let res = compare_open_office(
            &registry,
            &a,
            &b,
            Some(OfficeKind::Xlsx),
            Some(OfficeKind::Xlsx),
            state,
        )
        .unwrap();
        assert_eq!(res.office_a, Some("xlsx"));
        // 投影：[sheet 头, "h1", "\told/new"] → 头两行等值 + 单行替换
        let replaces: Vec<_> = res.blocks.iter().filter(|b| b.kind == "replace").collect();
        assert_eq!(replaces.len(), 1, "got {:?}", res.blocks);
        assert_eq!((replaces[0].a_start, replaces[0].a_end), (3, 3));
        assert_eq!(res.meta_a.lines, 3);
        assert_eq!(res.meta_a.encoding, "-");
        // 相同内容 → 0 差异
        let c = xlsx_fixture("xl-c.xlsx", "old");
        let state2 =
            compare::input_state(std::path::Path::new(&a), std::path::Path::new(&c)).unwrap();
        let same = compare_open_office(
            &registry,
            &a,
            &c,
            Some(OfficeKind::Xlsx),
            Some(OfficeKind::Xlsx),
            state2,
        )
        .unwrap();
        assert!(same.blocks.iter().all(|b| b.kind == "equal"));
    }

    /// 混合对：docx 投影 vs 原始文本行（提取文本对源文本的对比成立）；
    /// 二进制文本侧仍按既有语义拒绝（binary=true，但 office 标记保留）
    #[test]
    fn office_compare_mixed_and_binary_refusal() {
        let a = docx_fixture("mix-a.docx", "beta");
        let txt = temp_txt("mix.txt", "alpha\nbeta\ngamma\n");
        let registry = OoxmlRegistry::default();
        let state =
            compare::input_state(std::path::Path::new(&a), std::path::Path::new(&txt)).unwrap();
        let res =
            compare_open_office(&registry, &a, &txt, Some(OfficeKind::Docx), None, state).unwrap();
        assert_eq!(res.office_a, Some("docx"));
        assert_eq!(res.office_b, None);
        assert!(!res.meta_b.encoding.is_empty(), "文本侧编码语义保留");
        assert!(
            res.blocks.iter().all(|b| b.kind == "equal"),
            "投影与等价文本 → 0 差异，got {:?}",
            res.blocks
        );
        // 二进制文本侧：.doc 扩展名 + 二进制内容 → 拒绝对比（既有语义）
        let doc_bin = temp_bin("legacy.doc", &[0u8; 100]);
        let state2 =
            compare::input_state(std::path::Path::new(&a), std::path::Path::new(&doc_bin)).unwrap();
        let refused = compare_open_office(
            &registry,
            &a,
            &doc_bin,
            Some(OfficeKind::Docx),
            None,
            state2,
        )
        .unwrap();
        assert!(refused.binary);
        assert!(refused.blocks.is_empty());
        assert_eq!(refused.office_a, Some("docx"));
    }

    /// office_window：1 基窗口切片、越界空、xlsx 投影行取窗（含 sheet 头行）
    #[test]
    fn office_window_slicing() {
        let a = xlsx_fixture("win-a.xlsx", "v");
        let registry = OoxmlRegistry::default();
        let (lines, total) = office_window(&registry, &a, OfficeKind::Xlsx, 2, 3).unwrap();
        assert_eq!(total, 3);
        assert_eq!(lines, ["h1", "\tv"]);
        // 越界：from 超投影总行数 → 空（total 仍如实）
        let (none, t2) = office_window(&registry, &a, OfficeKind::Xlsx, 9, 12).unwrap();
        assert!(none.is_empty());
        assert_eq!(t2, 3);
        // docx：段落行窗口
        let d = docx_fixture("win-d.docx", "beta");
        let (dl, dt) = office_window(&registry, &d, OfficeKind::Docx, 2, 2).unwrap();
        assert_eq!(dt, 3);
        assert_eq!(dl, ["beta"]);
    }

    /// 批 1 收尾·性能实测（阶段 0.2）：20 万行级 xlsx 与大 docx 的 Office 投影对比打开耗时，
    /// 与同规模文本对比（hash_lines + diff_hashes）同量级。默认 #[ignore]（语料生成 +
    /// 全量解析为秒级，日常门禁不跑）：
    /// `cargo test --release --manifest-path src-tauri/Cargo.toml office_compare_perf -- --ignored --nocapture`
    /// （release 才是发行口径；数据记入 docs/changes/office-compare-batch1.md 收口卡）。
    #[test]
    #[ignore]
    fn office_compare_perf_200k_scale_matches_text() {
        use std::time::Instant;
        let dir = std::env::temp_dir().join("ZiEdit-cmp-perf");
        std::fs::create_dir_all(&dir).unwrap();
        let registry = OoxmlRegistry::default();
        let run = |a: &str, b: &str, kind_a, kind_b| {
            let state =
                compare::input_state(std::path::Path::new(a), std::path::Path::new(b)).unwrap();
            let t = Instant::now();
            let res = compare_open_office(&registry, a, b, kind_a, kind_b, state).unwrap();
            (t.elapsed().as_millis(), res)
        };

        // —— 20 万行级 xlsx（1 列，提取文本 ≈9.8MiB，贴 10MiB 红线的最大可行规模；
        // 2 列即超 OOXML_TEXT_LIMIT 显式哨兵——红线行为，非缺陷）——
        let xlsx_sheet = |mutate: bool| {
            let mut s = String::with_capacity(16 << 20);
            s.push_str("<worksheet><sheetData>");
            // 单位数取值：逐格 String 记账（24B/格 + 24B/行）× 20 万行 ≈9.8MiB，
            // 贴 10MiB 红线内——六位数取值即超限（哨兵是红线行为，见收口卡备忘）。
            for r in 1..=200_000u32 {
                let v = if mutate && r == 100_000 { 9u32 } else { r % 10 };
                s.push_str(&format!(
                    "<row r='{r}'><c r='A{r}' t='n'><v>{v}</v></c></row>"
                ));
            }
            s.push_str("</sheetData></worksheet>");
            s
        };
        let xlsx_meta: &[(&str, &str)] = &[
            (
                "xl/workbook.xml",
                "<workbook xmlns:r='r'><sheets><sheet name='Data' r:id='r1'/></sheets></workbook>",
            ),
            (
                "xl/_rels/workbook.xml.rels",
                "<Relationships><Relationship Id='r1' Target='worksheets/sheet1.xml'/></Relationships>",
            ),
        ];
        let plain = xlsx_sheet(false);
        let big = crate::ooxml::fixture(
            &[
                xlsx_meta[0],
                xlsx_meta[1],
                ("xl/worksheets/sheet1.xml", &plain),
            ],
            "perf-200k.xlsx",
        );
        // 同内容重存场景：字节拷贝成独立文件——投影按提取内容对比，与真实「不同 deflate
        // 流的同内容重存」等价；两侧独立解析（路径不同，注册表不命中）。
        let twin = dir.join("perf-200k-twin.xlsx");
        std::fs::copy(&big, &twin).unwrap();
        let twin = twin.to_string_lossy().into_owned();
        let (ms, same) = run(&big, &twin, Some(OfficeKind::Xlsx), Some(OfficeKind::Xlsx));
        println!("perf: xlsx 200k rows same-content compare_open = {ms}ms");
        assert!(same.blocks.iter().all(|b| b.kind == "equal"));
        assert_eq!(same.meta_a.lines, 200_001); // sheet 头 + 20 万数据行
        let mutated = xlsx_sheet(true);
        let big2 = crate::ooxml::fixture(
            &[
                xlsx_meta[0],
                xlsx_meta[1],
                ("xl/worksheets/sheet1.xml", &mutated),
            ],
            "perf-200k-mut.xlsx",
        );
        let (ms2, diff) = run(&big, &big2, Some(OfficeKind::Xlsx), Some(OfficeKind::Xlsx));
        println!("perf: xlsx 200k rows one-cell-change compare_open = {ms2}ms");
        let replaces: Vec<_> = diff.blocks.iter().filter(|b| b.kind == "replace").collect();
        assert_eq!(replaces.len(), 1, "改一格恰好一处，got {:?}", diff.blocks);
        assert_eq!((replaces[0].a_start, replaces[0].a_end), (100_001, 100_001));

        // —— 大 docx（12 万段 × ~40 字符 ≈7.7MiB 提取文本）——
        let docx_xml = |mutate: bool| {
            let mut s = String::with_capacity(8 << 20);
            s.push_str("<w:document xmlns:w='w'>");
            for i in 0..120_000u32 {
                let tag = if mutate && i == 60_000 {
                    "CHANGED-para"
                } else {
                    "para"
                };
                s.push_str(&format!(
                    "<w:p><w:r><w:t>{tag} {i:06} ——— padding text to body size</w:t></w:r></w:p>"
                ));
            }
            s.push_str("</w:document>");
            s
        };
        let dxml = docx_xml(false);
        let dmut = docx_xml(true);
        let d1 = crate::ooxml::fixture(&[("word/document.xml", &dxml)], "perf-docx.docx");
        let d2 = crate::ooxml::fixture(&[("word/document.xml", &dmut)], "perf-docx-mut.docx");
        let dtwin = dir.join("perf-docx-twin.docx");
        std::fs::copy(&d1, &dtwin).unwrap();
        let dtwin = dtwin.to_string_lossy().into_owned();
        let (dms, dsame) = run(&d1, &dtwin, Some(OfficeKind::Docx), Some(OfficeKind::Docx));
        println!("perf: docx 120k paragraphs same-content compare_open = {dms}ms");
        assert!(dsame.blocks.iter().all(|b| b.kind == "equal"));
        let (dms2, ddiff) = run(&d1, &d2, Some(OfficeKind::Docx), Some(OfficeKind::Docx));
        println!("perf: docx 120k paragraphs one-para-change compare_open = {dms2}ms");
        assert_eq!(
            ddiff.blocks.iter().filter(|b| b.kind == "replace").count(),
            1
        );

        // —— 同规模文本基线（对比量级参照）——
        let txt = dir.join("perf-200k.txt");
        let mut body = String::with_capacity(4 << 20);
        for r in 1..=200_000u32 {
            body.push_str(&format!("{r}\n"));
        }
        std::fs::write(&txt, body.as_bytes()).unwrap();
        let t = Instant::now();
        let (ha, _) = compare::hash_lines(&txt, "UTF-8", compare::LINE_LIMIT).unwrap();
        let (hb, _) = compare::hash_lines(&txt, "UTF-8", compare::LINE_LIMIT).unwrap();
        let blocks = compare::diff_hashes(&ha, &hb);
        println!(
            "perf: text 200k lines hash_lines x2 + diff = {}ms ({} blocks)",
            t.elapsed().as_millis(),
            blocks.len()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

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

    /// 收口缺陷 2：preview 计数确定性——大而异输入不再经 Myers/deadline，
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
