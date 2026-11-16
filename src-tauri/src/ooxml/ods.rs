//! ods —— ODF 电子表格（.ods）有界提取（批 2）。
//! 为什么不用 calamine 的 Ods 内核：实测 calamine 0.38 的 read_table 循环对
//! 截断/畸形的 content.xml **无 Eof 处理**（最小复现：包内 content.xml 缺
//! `</table:table>` 闭合即无限循环挂起解析线程），违反本仓「有界离线、
//! 显式哨兵、绝不静默」红线——见 docs/changes/office-compare-batch2.md。
//! xlsx/xlsb 流式通道与 xls 记录通道均有 Eof 处理（已核实源码），继续用 calamine。
//!
//! 本模块按既有 quick-xml 有界管线（ooxml::xml）解析 content.xml 的电子表格子集：
//! table:table / table:table-row / table:table-cell(|covered)，取 office:value /
//! office:string-value / office:date-value / office:time-value / office:boolean-value
//! 与 table:formula；number-rows/columns-repeated 展开受行列上限约束（空行重复
//! 只推进行游标不物化，与 xlsx 通道的稀疏行占位同语义）。
//! 日期/时长以 ISO 字符串原样呈现（ODF 样式系统不解析——如实：数值无样式码
//! 按通用格式显示，日期保持 ISO 文本）。
use super::{Package, Result, TEXT_LIMIT, xml};
use quick_xml::events::Event;

pub struct OdsWorkbook {
    pub sheets: Vec<OdsSheet>,
}
pub struct OdsSheet {
    pub name: String,
    /// (0 基行, 0 基列, 显示值)
    pub cells: Vec<(u32, u32, String)>,
    /// (0 基行, 0 基列, 公式原文)
    pub formulas: Vec<(u32, u32, String)>,
}

const SHEET_LIMIT: usize = 64;
const ROW_LIMIT: u64 = 200_000;
const COLUMN_LIMIT: u32 = 1024;
const CELL_LIMIT: usize = 32 * 1024;
const CONTENT_LIMIT: u64 = 64 * 1024 * 1024;

/// 单元格值属性 → 显示值（None = 无值属性：字符串走段落文本，真空格不物化）
fn cell_value(e: &quick_xml::events::BytesStart<'_>) -> Result<Option<Option<String>>> {
    // 返回 Ok(Some(None)) = 显式字符串（段落文本模式）；Ok(None) = 无值
    if let Some(v) = super::attr(e, "office:value")? {
        let f: f64 = v.parse().map_err(|_| "ODS_INVALID_NUMBER".to_string())?;
        return Ok(Some(Some(general_number(f))));
    }
    if let Some(v) = super::attr(e, "office:string-value")? {
        return Ok(Some(Some(v)));
    }
    if let Some(v) = super::attr(e, "office:date-value")? {
        return Ok(Some(Some(v))); // ISO 日期文本原样（不猜单元格样式）
    }
    if let Some(v) = super::attr(e, "office:time-value")? {
        return Ok(Some(Some(v))); // ISO 时长文本原样
    }
    if let Some(v) = super::attr(e, "office:boolean-value")? {
        return Ok(Some(Some(
            if v.eq_ignore_ascii_case("true") {
                "TRUE"
            } else {
                "FALSE"
            }
            .to_string(),
        )));
    }
    if let Some(v) = super::attr(e, "office:value-type")?
        && v == "string"
    {
        return Ok(Some(None));
    }
    Ok(None)
}

/// 通用数字显示（与 xlsx 通道的 General 口径一致：整数去小数点）
fn general_number(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

/// 有界解析 content.xml（状态机：table → row → cell → text:p 段落）
fn parse(zip: &mut Package, bytes: &mut usize) -> Result<OdsWorkbook> {
    #[derive(PartialEq, Clone, Copy)]
    enum Mode {
        Root,
        Table,
        Row,
        CellText,
    }
    let mut mode = Mode::Root;
    let mut sheets: Vec<OdsSheet> = Vec::new();
    let mut cur_name = String::new();
    let mut cur_cells: Vec<(u32, u32, String)> = Vec::new();
    let mut cur_formulas: Vec<(u32, u32, String)> = Vec::new();
    let mut row_cursor: u64 = 0; // 下一行号（含空行推进）
    // 当前行
    let mut row_cells: Vec<(u32, String)> = Vec::new();
    let mut row_formulas: Vec<(u32, String)> = Vec::new();
    let mut row_col: u32 = 0;
    let mut row_repeats: u32 = 1;
    // 段落文本格（CellText 模式）：落格列跨度
    let mut text_start_col: u32 = 0;
    let mut text_repeats: u32 = 1;
    let mut pending = String::new();
    let mut in_paragraph = false;
    let mut paragraphs = 0u32;
    xml(zip, "content.xml", CONTENT_LIMIT, |event| {
        match event {
            Event::Start(e) => {
                let name = e.local_name();
                match name.as_ref() {
                    "table" => {
                        if mode != Mode::Root {
                            return Err("ODS_NESTED_TABLE".into());
                        }
                        if sheets.len() >= SHEET_LIMIT {
                            return Err("XLSX_SHEET_LIMIT:64".into());
                        }
                        mode = Mode::Table;
                        cur_name = super::attr(&e, "table:name")?.unwrap_or_default();
                        cur_cells = Vec::new();
                        cur_formulas = Vec::new();
                        row_cursor = 0;
                    }
                    "table-row" if mode == Mode::Table => {
                        row_cells = Vec::new();
                        row_formulas = Vec::new();
                        row_col = 0;
                        row_repeats = super::attr(&e, "table:number-rows-repeated")?
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(1);
                        mode = Mode::Row;
                    }
                    "table-cell" | "covered-table-cell" if mode == Mode::Row => {
                        let repeats: u32 = super::attr(&e, "table:number-columns-repeated")?
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(1);
                        let formula = super::attr(&e, "table:formula")?;
                        let start_col = row_col;
                        if row_col.saturating_add(repeats) > COLUMN_LIMIT {
                            return Err("XLSX_COLUMN_LIMIT:1024".into());
                        }
                        match cell_value(&e)? {
                            Some(Some(v)) => {
                                if v.len() > CELL_LIMIT {
                                    return Err("XLSX_CELL_LIMIT:32KiB".into());
                                }
                                for k in 0..repeats {
                                    row_cells.push((start_col + k, v.clone()));
                                }
                            }
                            Some(None) => {
                                // 字符串：段落文本在元素内（Start 事件——Empty 走另一分支）
                                mode = Mode::CellText;
                                text_start_col = start_col;
                                text_repeats = repeats;
                                pending.clear();
                                paragraphs = 0;
                            }
                            None => {}
                        }
                        if let Some(f) = formula {
                            for k in 0..repeats {
                                row_formulas.push((start_col + k, f.clone()));
                            }
                        }
                        row_col = row_col.saturating_add(repeats);
                    }
                    "p" | "h" if mode == Mode::CellText => {
                        in_paragraph = true;
                        if paragraphs > 0 {
                            pending.push('\n');
                        }
                    }
                    _ => {}
                }
            }
            Event::Empty(e) => {
                match e.local_name().as_ref() {
                    "table" => {
                        // 空表：<table:table table:name='X'/> —— 零行零格
                        if mode != Mode::Root {
                            return Err("ODS_NESTED_TABLE".into());
                        }
                        if sheets.len() >= SHEET_LIMIT {
                            return Err("XLSX_SHEET_LIMIT:64".into());
                        }
                        sheets.push(OdsSheet {
                            name: super::attr(&e, "table:name")?.unwrap_or_default(),
                            cells: Vec::new(),
                            formulas: Vec::new(),
                        });
                    }
                    "table-row" if mode == Mode::Table => {
                        // 空行（自闭合）：只推进行游标
                        let repeats: u32 = super::attr(&e, "table:number-rows-repeated")?
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(1);
                        row_cursor = row_cursor.saturating_add(repeats as u64);
                        if row_cursor > ROW_LIMIT {
                            return Err("XLSX_ROW_LIMIT_OR_ORDER:200000".into());
                        }
                    }
                    "table-cell" | "covered-table-cell" if mode == Mode::Row => {
                        let repeats: u32 = super::attr(&e, "table:number-columns-repeated")?
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(1);
                        let formula = super::attr(&e, "table:formula")?;
                        let start_col = row_col;
                        if row_col.saturating_add(repeats) > COLUMN_LIMIT {
                            return Err("XLSX_COLUMN_LIMIT:1024".into());
                        }
                        if let Some(Some(v)) = cell_value(&e)? {
                            if v.len() > CELL_LIMIT {
                                return Err("XLSX_CELL_LIMIT:32KiB".into());
                            }
                            for k in 0..repeats {
                                row_cells.push((start_col + k, v.clone()));
                            }
                        }
                        if let Some(f) = formula {
                            for k in 0..repeats {
                                row_formulas.push((start_col + k, f.clone()));
                            }
                        }
                        row_col = row_col.saturating_add(repeats);
                    }
                    "p" | "h" if mode == Mode::CellText => {
                        paragraphs += 1; // 空段落（占位换行语义）
                    }
                    _ => {}
                }
            }
            Event::Text(t) if in_paragraph => {
                pending
                    .push_str(&quick_xml::escape::unescape(t.as_ref()).map_err(|e| e.to_string())?);
            }
            Event::GeneralRef(t) if in_paragraph => {
                pending.push_str(&super::resolve_ref(t.as_ref())?);
            }
            Event::CData(t) if in_paragraph => pending.push_str(t.as_ref()),
            Event::End(e) => match e.local_name().as_ref() {
                "p" | "h" => {
                    if in_paragraph {
                        in_paragraph = false;
                        paragraphs += 1;
                    }
                }
                "table-cell" | "covered-table-cell" if mode == Mode::CellText => {
                    if pending.len() > CELL_LIMIT {
                        return Err("XLSX_CELL_LIMIT:32KiB".into());
                    }
                    if !pending.is_empty() {
                        for k in 0..text_repeats {
                            row_cells.push((text_start_col + k, pending.clone()));
                        }
                    }
                    pending.clear();
                    mode = Mode::Row;
                }
                "table-row" if mode == Mode::Row || mode == Mode::CellText => {
                    if mode == Mode::CellText {
                        return Err("ODS_UNCLOSED_CELL".into());
                    }
                    // 行落地：按重复数展开推进游标（空行不物化格内容；非空行
                    // 逐份展开落格，受行上限约束）
                    let base = row_cursor;
                    let has_content = !row_cells.is_empty() || !row_formulas.is_empty();
                    let n: u64 = row_repeats as u64;
                    if base + n > ROW_LIMIT {
                        return Err("XLSX_ROW_LIMIT_OR_ORDER:200000".into());
                    }
                    if has_content {
                        *bytes += std::mem::size_of::<Vec<(u32, String)>>();
                        for k in 0..n {
                            let r = (base + k) as u32;
                            for (c, v) in &row_cells {
                                *bytes += v.len() + std::mem::size_of::<String>();
                                if *bytes > TEXT_LIMIT {
                                    return Err("OOXML_TEXT_LIMIT:10MiB".into());
                                }
                                cur_cells.push((r, *c, v.clone()));
                            }
                        }
                        for k in 0..n {
                            let r = (base + k) as u32;
                            for (c, f) in &row_formulas {
                                cur_formulas.push((r, *c, f.clone()));
                            }
                        }
                    }
                    row_cursor = base + n;
                    row_cells.clear();
                    row_formulas.clear();
                    mode = Mode::Table;
                }
                "table" => {
                    if mode != Mode::Table {
                        return Err("ODS_UNCLOSED_ROW".into());
                    }
                    sheets.push(OdsSheet {
                        name: std::mem::take(&mut cur_name),
                        cells: std::mem::take(&mut cur_cells),
                        formulas: std::mem::take(&mut cur_formulas),
                    });
                    mode = Mode::Root;
                }
                _ => {}
            },
            _ => {}
        }
        Ok(())
    })?;
    // 截断哨兵：Eof 时仍处表/行/格内部 = content.xml 不完整（calamine 对此挂起，
    // 本模块显式报错——绝不静默吞掉半截表）
    if mode != Mode::Root {
        return Err("ODS_TRUNCATED_CONTENT".into());
    }
    Ok(OdsWorkbook { sheets })
}

pub fn open(path: &str) -> Result<OdsWorkbook> {
    super::reject_legacy_wps(path)?;
    let p = std::path::Path::new(path);
    let len = std::fs::metadata(p)
        .map_err(|e| format!("ODS_OPEN:{e}"))?
        .len();
    if len > 100 * 1024 * 1024 {
        return Err("OOXML_PACKAGE_LIMIT:100MiB".into());
    }
    let mut zip = super::package(path)?;
    let mut bytes = 0usize;
    parse(&mut zip, &mut bytes)
}

/// 转为 xlsx 通道的 Workbook 形态（稀疏格 → 稠密行矩阵，同一稀疏占位语义）
pub fn to_workbook(book: OdsWorkbook) -> super::xlsx::Workbook {
    let mut sheets = Vec::with_capacity(book.sheets.len());
    for s in book.sheets {
        let mut records: Vec<Vec<String>> = Vec::new();
        for (r, c, v) in s.cells {
            let ru = r as usize;
            if ru >= records.len() {
                records.resize_with(ru + 1, Vec::new);
            }
            let row = &mut records[ru];
            if c as usize >= row.len() {
                row.resize(c as usize + 1, String::new());
            }
            row[c as usize] = v;
        }
        let mut formulas = s.formulas;
        formulas.sort_unstable_by_key(|(r, c, _)| (*r, *c));
        sheets.push(super::xlsx::Sheet {
            name: s.name,
            records,
            formulas,
            merges: Vec::new(), // covered-cell 合并语义不还原（如实：无合并区间）
        });
    }
    super::xlsx::Workbook {
        sheets,
        is_1904: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ods_fixture(content: &str, name: &str) -> String {
        crate::ooxml::fixture(
            &[
                ("mimetype", "application/vnd.oasis.opendocument.spreadsheet"),
                (
                    "META-INF/manifest.xml",
                    "<manifest:manifest xmlns:manifest='urn:oasis:names:tc:opendocument:xmlns:manifest:1.0' manifest:version='1.2'><manifest:file-entry manifest:full-path='/' manifest:media-type='application/vnd.oasis.opendocument.spreadsheet'/><manifest:file-entry manifest:full-path='content.xml' manifest:media-type='text/xml'/></manifest:manifest>",
                ),
                ("content.xml", content),
            ],
            name,
        )
    }
    const HEAD: &str = "<office:document-content xmlns:office='urn:oasis:names:tc:opendocument:xmlns:office:1.0' xmlns:table='urn:oasis:names:tc:opendocument:xmlns:table:1.0' xmlns:text='urn:oasis:names:tc:opendocument:xmlns:text:1.0'><office:body><office:spreadsheet>";
    const TAIL: &str = "</office:spreadsheet></office:body></office:document-content>";

    #[test]
    fn values_strings_dates_repeats() {
        let content = format!(
            "{HEAD}<table:table table:name='Data'>             <table:table-row>             <table:table-cell office:value-type='float' office:value='42'/>             <table:table-cell office:value-type='string'><text:p>hello &amp; bye</text:p></table:table-cell>             <table:table-cell office:value-type='date' office:date-value='2024-01-01'/>             <table:table-cell office:value-type='boolean' office:boolean-value='true'/>             <table:table-cell table:number-columns-repeated='2' office:value-type='float' office:value='7'/>             </table:table-row>             <table:table-row><table:table-cell table:number-columns-repeated='3'/>             <table:table-cell office:value-type='float' office:value='9'/>             </table:table-row>             </table:table>{TAIL}"
        );
        let p = ods_fixture(&content, "vals.ods");
        let book = to_workbook(open(&p).unwrap());
        assert_eq!(book.sheets.len(), 1);
        assert_eq!(book.sheets[0].name, "Data");
        // 行 1：42 | hello & bye | 2024-01-01 | TRUE | 7 | 7（重复列占位）
        assert_eq!(
            book.sheets[0].records[0],
            ["42", "hello & bye", "2024-01-01", "TRUE", "7", "7"]
        );
        // 行 2：空格重复推进列游标 → 第 4 列（D2）为 9
        assert_eq!(book.sheets[0].records[1], ["", "", "", "9"]);
    }

    #[test]
    fn repeated_empty_rows_advance_cursor() {
        // 稀疏表：99 个空行后的数据必须落在第 100 行（行位语义不漂移）
        let content = format!(
            "{HEAD}<table:table table:name='S'>             <table:table-row table:number-rows-repeated='99'/>             <table:table-row><table:table-cell office:value-type='float' office:value='5'/></table:table-row>             </table:table>{TAIL}"
        );
        let p = ods_fixture(&content, "sparse-rows.ods");
        let book = to_workbook(open(&p).unwrap());
        assert_eq!(book.sheets[0].records.len(), 100);
        assert_eq!(book.sheets[0].records[99], ["5"]);
    }

    #[test]
    fn formulas_reported() {
        let content = format!(
            "{HEAD}<table:table table:name='S'>             <table:table-row>             <table:table-cell office:value-type='float' office:value='3' table:formula='of:=1+2'/>             </table:table-row></table:table>{TAIL}"
        );
        let p = ods_fixture(&content, "formula.ods");
        let book = to_workbook(open(&p).unwrap());
        assert_eq!(book.sheets[0].formulas, vec![(0, 0, "of:=1+2".to_string())]);
        assert_eq!(book.sheets[0].records[0], ["3"]);
    }

    #[test]
    fn truncated_content_errors_instead_of_hanging() {
        // calamine 0.38 对此形态无限循环（缺 </table:table>）；本模块显式哨兵报错。
        // 该测试同时是选型证据：秒级完成即通过（挂起则门禁超时失败）。
        let content = format!(
            "{HEAD}<table:table table:name='S'>             <table:table-row><table:table-cell office:value-type='float' office:value='1'/>             </table:table-row></office:spreadsheet></office:body></office:document-content>"
        );
        let p = ods_fixture(&content, "truncated.ods");
        // quick-xml 的标签配对检查先行命中（OOXML_XML 哨兵），状态机兜底为
        // ODS_TRUNCATED_CONTENT——两者都是显式报错，测试锁定「秒级报错不挂起」
        let err = open(&p).err().expect("畸形内容必须报错");
        assert!(
            err.starts_with("OOXML_XML:") || err == "ODS_TRUNCATED_CONTENT",
            "got {err}"
        );
    }

    #[test]
    fn limits_sentinels() {
        let mut row = String::new();
        for i in 0..1025 {
            row.push_str(&format!(
                "<table:table-cell office:value-type='float' office:value='{i}'/>"
            ));
        }
        let content = format!(
            "{HEAD}<table:table table:name='S'><table:table-row>{row}</table:table-row></table:table>{TAIL}"
        );
        let p = ods_fixture(&content, "col-over.ods");
        assert_eq!(open(&p).err().unwrap(), "XLSX_COLUMN_LIMIT:1024");
        let mut tables = String::new();
        for i in 0..65 {
            tables.push_str(&format!(
                "<table:table table:name='T{i}'><table:table-row><table:table-cell office:value-type='float' office:value='1'/></table:table-row></table:table>"
            ));
        }
        let content = format!("{HEAD}{tables}{TAIL}");
        let p = ods_fixture(&content, "sheet-over.ods");
        assert_eq!(open(&p).err().unwrap(), "XLSX_SHEET_LIMIT:64");
    }

    #[test]
    fn multi_paragraph_string_joins_with_newline() {
        let content = format!(
            "{HEAD}<table:table table:name='S'>             <table:table-row>             <table:table-cell office:value-type='string'><text:p>l1</text:p><text:p>l2</text:p></table:table-cell>             </table:table-row></table:table>{TAIL}"
        );
        let p = ods_fixture(&content, "paras.ods");
        let book = to_workbook(open(&p).unwrap());
        assert_eq!(book.sheets[0].records[0], ["l1\nl2"]);
    }

    #[test]
    fn empty_table_and_general_float() {
        let content = format!(
            "{HEAD}<table:table table:name='E'/><table:table table:name='F'>             <table:table-row><table:table-cell office:value-type='float' office:value='2.5'/>             <table:table-cell office:value-type='float' office:value='-3'/>             </table:table-row></table:table>{TAIL}"
        );
        let p = ods_fixture(&content, "empty-table.ods");
        let book = to_workbook(open(&p).unwrap());
        assert_eq!(book.sheets.len(), 2);
        assert_eq!(book.sheets[0].name, "E");
        assert!(book.sheets[0].records.is_empty());
        assert_eq!(book.sheets[1].records[0], ["2.5", "-3"]);
    }
}
