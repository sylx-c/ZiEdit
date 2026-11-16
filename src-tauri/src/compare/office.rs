//! compare/office —— Office 文本投影（008 扩展 · 批 1：docx/xlsx 对比分流）
//! docx/xlsx 不再按原始 ZIP 字节逐行对比（deflate 流噪声，同内容重存也全文标红），
//! 而是提取为规范文本行序列后走既有行哈希 diff 管线。
//! 纯函数、不依赖 tauri 运行时（与 compare 模块其余部分同一红线）。
//!
//! 投影确定性：同一提取结果必须产出逐字节一致的行序列（单测锁定）——
//! compare 的外部修改检测按 (path,len,mtime) 失效重载，投影漂移会破坏该语义。
//!
//! docx：`docx::Document.lines` 即投影（段落=行），零拷贝直接哈希。
//! xlsx：sheet 头行 + 每行 tab 连接；空行保留占位使稀疏行对齐。
//! 行内容**不含行号**：Excel 插入行会重排后续 r 属性，行号入行会把
//! 「插入一行」放大成「其后所有行替换」；行定位交给块坐标（线号）承担。

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use crate::ooxml::xlsx;

/// 可投影对比的 Office 扩展名路由（批 1：docx/xlsx；批 2 扩全家族）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeKind {
    Docx,
    Xlsx,
}

/// 扩展名 → 投影类别；None = 走既有文本/二进制路径（行为零变化）。
/// 批 2：Word 家族（docx/docm/dotx/dotm/odt）→ Docx；Excel 家族 + ODF 电子表格
/// （xlsx/xlsm/xltx/xltm/xlam/xls/xlsb/ods）→ Xlsx（显示值口径）。
pub fn office_kind(path: &Path) -> Option<OfficeKind> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("docx" | "docm" | "dotx" | "dotm" | "odt" | "pptx" | "wps" | "dps") => {
            Some(OfficeKind::Docx)
        }
        Some("xlsx" | "xlsm" | "xltx" | "xltm" | "xlam" | "xls" | "xlsb" | "ods" | "et") => {
            Some(OfficeKind::Xlsx)
        }
        _ => None,
    }
}

/// 投影行哈希：byte 与 text 同源 —— 投影无字节层，编码/EOL 徽标与 enc_marks
/// 均不适用（detail 的行级类别只在两侧都是原始文本时判定）。
pub fn hash_doc_lines(lines: &[String]) -> Vec<super::LineHash> {
    lines
        .iter()
        .map(|l| {
            let h = super::hash_of(l);
            super::LineHash { byte: h, text: h }
        })
        .collect()
}

/// 单元格字面量化：制表符/换行会破坏行投影的结构（列边界/行边界），
/// 替换为可见字面量（⇥/⏎）保持单行单格；对比视图行内高亮照常可用。
pub fn sanitize_cell(cell: &str) -> String {
    cell.replace('\t', "\u{21E5}")
        .replace(['\r', '\n'], "\u{23CE}")
}

/// sheet 头行前缀：区别于数据行的稳定分隔标记
const SHEET_PREFIX: &str = "\u{25C7} Sheet: ";

/// xlsx 值投影：每 sheet 一行头 + 数据行（tab 连接，列位置即格位置）。
/// - 空行投影为空字符串：稀疏行占位，插入/删除行由 Myers 对齐吸收；
/// - 行尾空格串保留（`a\t` ≠ `a`）：单元格清空是真实差异；
/// - sheet 名同样字面量化（防御理论上的控制字符）；
/// - 批 2：records 已是显示值口径（calamine + ooxml-numfmt），对比=所见。
pub fn project_xlsx(book: &xlsx::Workbook) -> Vec<String> {
    project_xlsx_mode(book, false)
}

/// 公式投影（批 2）：有公式的格投影公式原文（不带 = 前缀——投影要稳定可 diff，
/// 前缀是查看层约定），其余格仍为显示值；行结构/sheet 头与值投影完全一致
/// （同一文件两种投影行数相同，切换开关不改变对齐块坐标语义）。
pub fn project_xlsx_formula(book: &xlsx::Workbook) -> Vec<String> {
    project_xlsx_mode(book, true)
}

fn project_xlsx_mode(book: &xlsx::Workbook, formula: bool) -> Vec<String> {
    let mut lines = Vec::new();
    for sheet in &book.sheets {
        lines.push(format!("{SHEET_PREFIX}{}", sanitize_cell(&sheet.name)));
        // 公式查找：稀疏表按 (行,列) 有序 → 行游标单调推进 + 行内顺序查找
        let mut fidx = 0usize;
        for (ri, row) in sheet.records.iter().enumerate() {
            if row.is_empty() {
                lines.push(String::new());
                continue;
            }
            // 推进公式游标到当前行（跳过更早行）
            while fidx < sheet.formulas.len() && (sheet.formulas[fidx].0 as usize) < ri {
                fidx += 1;
            }
            if !formula {
                lines.push(
                    row.iter()
                        .map(|c| sanitize_cell(c))
                        .collect::<Vec<_>>()
                        .join("\t"),
                );
                continue;
            }
            let mut out = String::new();
            for (ci, cell) in row.iter().enumerate() {
                if ci > 0 {
                    out.push('\t');
                }
                // 行内从游标起找 (ri, ci)（同行的公式连续存放）
                let mut k = fidx;
                let text = loop {
                    if k >= sheet.formulas.len() || sheet.formulas[k].0 as usize > ri {
                        break cell.as_str();
                    }
                    if sheet.formulas[k].1 as usize == ci {
                        break sheet.formulas[k].2.as_str();
                    }
                    k += 1;
                };
                out.push_str(&sanitize_cell(text));
            }
            lines.push(out);
        }
    }
    lines
}

/// xlsx 投影缓存：`(path, len, mtime)` + 投影模式（值/公式）LRU（容量 4×2，照
/// compare::mod 的 nl_index_cache 模式）。office_window/office_side 每次窗口取行都要把
/// 注册表命中的 workbook 重新 join 成投影行（20 万行级每次全量 join 有感知），缓存后
/// 命中 O(1) 克隆 Arc；外部修改按键自动失效——与 OoxmlRegistry（len/mtime 失效）
/// 同一语义，投影与 workbook 不会错版本。
type ProjectionCache =
    crate::encoding::ProbeLru<(crate::encoding::ProbeKey, bool), Arc<Vec<String>>>;
fn xlsx_projection_cache() -> &'static Mutex<ProjectionCache> {
    static CACHE: OnceLock<Mutex<ProjectionCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(crate::encoding::ProbeLru::new(8)))
}

/// 缓存版投影（批 1 收尾性能项 / 批 2 加公式模式）：stat 失败（文件被并发删除等
/// 理论情形）时不缓存、直接投影返回，取行路径行为不回退。
pub fn project_xlsx_cached(path: &Path, book: &xlsx::Workbook, formula: bool) -> Arc<Vec<String>> {
    let key = crate::encoding::probe_key(path).ok().map(|k| (k, formula));
    if let Some(key) = &key
        && let Ok(mut cache) = xlsx_projection_cache().lock()
        && let Some(hit) = cache.get(key)
    {
        return hit.clone();
    }
    let projection = Arc::new(if formula {
        project_xlsx_formula(book)
    } else {
        project_xlsx(book)
    });
    if let Some(key) = key
        && let Ok(mut cache) = xlsx_projection_cache().lock()
    {
        cache.put(key, projection.clone());
    }
    projection
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ooxml::xlsx::Sheet;

    #[test]
    fn kind_routing_by_extension() {
        assert_eq!(office_kind(Path::new("a.DOCX")), Some(OfficeKind::Docx));
        assert_eq!(office_kind(Path::new("b.Xlsx")), Some(OfficeKind::Xlsx));
        // 批 2 全家族：Word 家族（含 odt 文本管线）与 Excel 家族（含 ods 电子表格）
        for name in ["c.docm", "d.dotx", "e.dotm", "f.odt"] {
            assert_eq!(
                office_kind(Path::new(name)),
                Some(OfficeKind::Docx),
                "{name}"
            );
        }
        for name in [
            "g.xls", "h.xlsb", "i.xlsm", "j.xltm", "k.xltx", "l.xlam", "m.ods",
        ] {
            assert_eq!(
                office_kind(Path::new(name)),
                Some(OfficeKind::Xlsx),
                "{name}"
            );
        }
        // 旧格式与未知：仍走既有路径（.doc/.ppt spike 未决）
        assert_eq!(office_kind(Path::new("n.doc")), None);
        assert_eq!(office_kind(Path::new("o.ppt")), None);
        assert_eq!(office_kind(Path::new("p.txt")), None);
        assert_eq!(office_kind(Path::new("noext")), None);
    }

    #[test]
    fn doc_line_hashes_have_no_byte_layer() {
        let h = hash_doc_lines(&["a".into(), "中".into()]);
        assert_eq!(h.len(), 2);
        for l in &h {
            assert_eq!(l.byte, l.text, "投影行 byte/text 同源");
        }
        // 与逐行 hash_of 一致（缓存/重载语义依赖确定性）
        assert_eq!(h[0].text, super::super::hash_of(&"a".to_string()));
    }

    #[test]
    fn xlsx_projection_structure_and_alignment() {
        let book = xlsx::Workbook {
            is_1904: false,
            sheets: vec![
                Sheet {
                    name: "S1".into(),
                    records: vec![
                        vec!["h1".into(), "h2".into()],
                        vec!["a".into(), "b".into()],
                        Vec::new(),                  // 稀疏空行占位
                        vec!["x".into(), "".into()], // 尾格清空保留列位
                    ],
                    formulas: Vec::new(),
                    merges: Vec::new(),
                },
                Sheet {
                    name: "Empty".into(),
                    records: Vec::new(),
                    formulas: Vec::new(),
                    merges: Vec::new(),
                },
            ],
        };
        let lines = project_xlsx(&book);
        assert_eq!(
            lines,
            vec![
                "\u{25C7} Sheet: S1",
                "h1\th2",
                "a\tb",
                "",
                "x\t",
                "\u{25C7} Sheet: Empty",
            ]
        );
        // 确定性：同输入两次投影逐字节一致
        assert_eq!(lines, project_xlsx(&book));
    }

    #[test]
    fn cell_literals_keep_projection_single_line() {
        assert_eq!(sanitize_cell("a\tb\nc\rd"), "a\u{21E5}b\u{23CE}c\u{23CE}d");
        let lines = project_xlsx(&xlsx::Workbook {
            is_1904: false,
            sheets: vec![Sheet {
                name: "N".into(),
                records: vec![vec!["multi\nline\tcell".into()]],
                formulas: Vec::new(),
                merges: Vec::new(),
            }],
        });
        assert_eq!(
            lines,
            ["\u{25C7} Sheet: N", "multi\u{23CE}line\u{21E5}cell"]
        );
    }

    #[test]
    fn projection_cache_hits_and_invalidates_on_change() {
        // 批 1 收尾：窗口取行的重复 join 走 (path,len,mtime) LRU——同键命中同一投影（指针相等），
        // 文件变化（len/mtime 变）后失效重投影，绝不回退旧版本。
        let dir = std::env::temp_dir().join("ZiEdit-office-cache");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("cache-v1.xlsx");
        std::fs::write(&p, []).unwrap();
        let mk_book = |tag: &str| xlsx::Workbook {
            is_1904: false,
            sheets: vec![Sheet {
                name: "S".into(),
                records: vec![vec![tag.into()]],
                formulas: vec![(0, 0, "F1".into())],
                merges: Vec::new(),
            }],
        };
        let v1 = project_xlsx_cached(&p, &mk_book("v1"), false);
        // 命中：同键返回同一 Arc
        let hit = project_xlsx_cached(&p, &mk_book("ignored"), false);
        assert!(Arc::ptr_eq(&v1, &hit), "同键命中缓存，不重投影");
        assert_eq!(*hit, vec!["\u{25C7} Sheet: S", "v1"]);
        // 公式模式独立分键：不与值投影互相覆盖
        let f1 = project_xlsx_cached(&p, &mk_book("ignored"), true);
        assert_eq!(*f1, vec!["\u{25C7} Sheet: S", "F1"]);
        let f1b = project_xlsx_cached(&p, &mk_book("ignored"), true);
        assert!(Arc::ptr_eq(&f1, &f1b), "公式模式同样命中缓存");
        // 外部修改：len/mtime 变 → 失效重投影（两种模式一并失效）
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&p, [0u8; 8]).unwrap();
        let v2 = project_xlsx_cached(&p, &mk_book("v2"), false);
        assert_eq!(*v2, vec!["\u{25C7} Sheet: S", "v2"]);
        assert!(!Arc::ptr_eq(&v1, &v2));
        let f2 = project_xlsx_cached(&p, &mk_book("v2"), true);
        assert_eq!(*f2, vec!["\u{25C7} Sheet: S", "F1"], "公式文本来自新 book");
        let _ = std::fs::remove_file(&p);
    }
}
