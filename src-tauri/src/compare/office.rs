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

use crate::ooxml::xlsx;

/// 可投影对比的 Office 扩展名路由（批 1：docx/xlsx；后续批次扩 xls/ods/xlsm 等）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeKind {
    Docx,
    Xlsx,
}

/// 扩展名 → 投影类别；None = 走既有文本/二进制路径（行为零变化）
pub fn office_kind(path: &Path) -> Option<OfficeKind> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("docx") => Some(OfficeKind::Docx),
        Some("xlsx") => Some(OfficeKind::Xlsx),
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
/// - sheet 名同样字面量化（防御理论上的控制字符）。
pub fn project_xlsx(book: &xlsx::Workbook) -> Vec<String> {
    let mut lines = Vec::new();
    for sheet in &book.sheets {
        lines.push(format!("{SHEET_PREFIX}{}", sanitize_cell(&sheet.name)));
        for row in &sheet.records {
            if row.is_empty() {
                lines.push(String::new());
            } else {
                lines.push(
                    row.iter()
                        .map(|c| sanitize_cell(c))
                        .collect::<Vec<_>>()
                        .join("\t"),
                );
            }
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ooxml::xlsx::Sheet;

    #[test]
    fn kind_routing_by_extension() {
        assert_eq!(office_kind(Path::new("a.DOCX")), Some(OfficeKind::Docx));
        assert_eq!(office_kind(Path::new("b.Xlsx")), Some(OfficeKind::Xlsx));
        assert_eq!(office_kind(Path::new("c.doc")), None);
        assert_eq!(office_kind(Path::new("d.xls")), None);
        assert_eq!(office_kind(Path::new("e.txt")), None);
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
            sheets: vec![
                Sheet {
                    name: "S1".into(),
                    records: vec![
                        vec!["h1".into(), "h2".into()],
                        vec!["a".into(), "b".into()],
                        Vec::new(),                  // 稀疏空行占位
                        vec!["x".into(), "".into()], // 尾格清空保留列位
                    ],
                },
                Sheet {
                    name: "Empty".into(),
                    records: Vec::new(),
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
            sheets: vec![Sheet {
                name: "N".into(),
                records: vec![vec!["multi\nline\tcell".into()]],
            }],
        });
        assert_eq!(
            lines,
            ["\u{25C7} Sheet: N", "multi\u{23CE}line\u{21E5}cell"]
        );
    }
}
