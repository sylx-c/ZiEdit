use super::Result;
use crate::commands::csv::CsvRecord;
use calamine::{Data, Range, Reader, Sheets};
use ooxml_numfmt::{DateSystem, FormatOptions};
use serde::Serialize;
use std::path::Path;

/// Excel 家族有界提取（批 2：calamine 内核替换自研 XML 遍历）。
/// 覆盖 xlsx/xlsm/xltx/xltm/xlam/xls/xlsb/ods；显示值渲染走 ooxml-numfmt——
/// 对比与查看统一为 Excel 所见口径，日期列不再以序列数（如 45292）参与对比。
///
/// 上限语义沿用批 1：包 ≤100MiB、sheet ≤64、行 ≤20 万、列 ≤1024、格文本 ≤32KiB、
/// 提取文本合计 ≤10MiB——全部显式哨兵报错，绝不静默截断；calamine 错误统一映射
/// `XLSX_OPEN:<原因>`。
///
/// 有界红线（与批 1 自研内核同强度）：xlsx/xlsb 走内核流式 cells reader，行列/记账
/// 上限**逐格先检再物化**；xls/ods 内核无流式接口，走 worksheet_range 整表物化后检
/// （xls 受格式固有 65536×256 矩形上界约束；ods 在 open 时整包解析——残余暴露见
/// docs/changes/office-compare-batch2.md 风险备忘）。
pub struct Sheet {
    pub name: String,
    /// 显示值矩阵（Excel 所见口径：格式化数字/日期/百分比/布尔/错误字面量）
    pub records: Vec<Vec<String>>,
    /// 稀疏公式通道（worksheet_formula）：(0 基行, 0 基列, 公式文本)
    pub formulas: Vec<(u32, u32, String)>,
    /// 合并单元格区间 (行起, 行止, 列起, 列止)（0 基含端点；xlsb/ods 内核不暴露，为空）
    pub merges: Vec<(u32, u32, u32, u32)>,
}
pub struct Workbook {
    pub sheets: Vec<Sheet>,
    /// 1904 日期系统（Mac 旧历法）标志：影响序列数→显示值换算
    pub is_1904: bool,
}
#[derive(Serialize)]
pub struct SheetInfo {
    pub name: String,
    pub rows: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub sheets: Vec<SheetInfo>,
    pub truncated: bool,
    /// 1904 日期系统标志（前端可如实提示）
    pub is_1904: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordsResult {
    pub records: Vec<CsvRecord>,
    pub total: usize,
}
impl Workbook {
    pub fn info(&self) -> OpenResult {
        OpenResult {
            sheets: self
                .sheets
                .iter()
                .map(|s| SheetInfo {
                    name: s.name.clone(),
                    rows: s.records.len(),
                })
                .collect(),
            truncated: false,
            is_1904: self.is_1904,
        }
    }
}

// ---- 上限常量（哨兵语义沿用批 1 自研内核）----
const PACKAGE_LIMIT: u64 = 100 * 1024 * 1024;
const SHEET_LIMIT: usize = 64;
const ROW_LIMIT: u64 = 200_000;
const COLUMN_LIMIT: u32 = 1024;
const CELL_LIMIT: usize = 32 * 1024;
/// 无格式码可查时的日期兜底显示（xlsb/ods 通道）：确定性 ISO 风格，Excel 实际
/// 逐格格式不可知——如实选稳定可读形式，不猜单元格格式。
const FALLBACK_DATETIME_CODE: &str = "yyyy-mm-dd hh:mm:ss";
const FALLBACK_DURATION_CODE: &str = "[h]:mm:ss";

fn text_options(is_1904: bool) -> FormatOptions {
    FormatOptions {
        date_system: if is_1904 {
            DateSystem::Date1904
        } else {
            DateSystem::Date1900
        },
        ..FormatOptions::default()
    }
}

/// 数值 → 显示值：格式码交给 ooxml-numfmt；不可解析的格式码退回原始数值文本
/// （确定性回退——Excel 对无法解析的格式同样显示原值量级）。
fn fmt_numeric(v: f64, code: &str, opts: &FormatOptions) -> String {
    match ooxml_numfmt::format(v, code, opts) {
        Ok(s) => s,
        Err(_) => {
            if v.fract() == 0.0 && v.abs() < 1e15 {
                format!("{}", v as i64)
            } else {
                format!("{v}")
            }
        }
    }
}

/// 单元格值 + 格式码 → 显示值（对比与查看的统一口径）。
/// 流式通道的 DataRef 先转 owned Data（字符串即刻克隆，不持有读缓冲）。
fn display_value(v: &Data, code: Option<&str>, opts: &FormatOptions) -> String {
    match v {
        Data::Empty => String::new(),
        Data::Bool(b) => {
            if *b {
                "TRUE".into()
            } else {
                "FALSE".into()
            }
        }
        Data::Error(e) => e.to_string(),
        Data::String(s) => s.clone(),
        // ISO 通道（ods 的 DateTimeIso / DurationIso）：字符串原样
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::DateTime(dt) => {
            // 日期/时长无格式码（xlsb/ods 通道）：确定性兜底显示
            let code = code.unwrap_or(if dt.is_duration() {
                FALLBACK_DURATION_CODE
            } else {
                FALLBACK_DATETIME_CODE
            });
            fmt_numeric(dt.as_f64(), code, opts)
        }
        Data::Int(i) => fmt_numeric(*i as f64, code.unwrap_or("General"), opts),
        Data::Float(f) => fmt_numeric(*f, code.unwrap_or("General"), opts),
    }
}

/// 有界放置器：逐格先检上限（行/列/格文本/记账）再物化进稠密行矩阵。
/// 记账与批 1 同口径：格文本 + String 头（24B/格）+ 行 Vec 头（24B/行，含空行占位）。
struct RecordsBuilder<'a> {
    records: Vec<Vec<String>>,
    bytes: &'a mut usize,
}
impl<'a> RecordsBuilder<'a> {
    fn new(bytes: &'a mut usize) -> Self {
        Self {
            records: Vec::new(),
            bytes,
        }
    }
    fn push(&mut self, r: u32, c: u32, text: String) -> Result<()> {
        if r as u64 + 1 > ROW_LIMIT {
            return Err("XLSX_ROW_LIMIT_OR_ORDER:200000".into());
        }
        if c + 1 > COLUMN_LIMIT {
            return Err("XLSX_COLUMN_LIMIT:1024".into());
        }
        if text.len() > CELL_LIMIT {
            return Err("XLSX_CELL_LIMIT:32KiB".into());
        }
        let ru = r as usize;
        if ru >= self.records.len() {
            *self.bytes += (ru + 1 - self.records.len()) * std::mem::size_of::<Vec<String>>();
            if *self.bytes > super::TEXT_LIMIT {
                return Err("OOXML_TEXT_LIMIT:10MiB".into());
            }
            self.records.resize_with(ru + 1, Vec::new);
        }
        let row = &mut self.records[ru];
        if c as usize >= row.len() {
            row.resize(c as usize + 1, String::new());
        }
        *self.bytes += text.len() + std::mem::size_of::<String>();
        if *self.bytes > super::TEXT_LIMIT {
            return Err("OOXML_TEXT_LIMIT:10MiB".into());
        }
        row[c as usize] = text;
        Ok(())
    }
}

/// calamine 错误 → XLSX_* 哨兵（统一前缀，前端照既有 contains 契约处理）
fn map_open_err(e: impl std::fmt::Display) -> String {
    format!("XLSX_OPEN:{e}")
}

/// 读单个 sheet（按内核能力分流），产出显示值矩阵 + 公式 + 合并区间
fn sheet_of(
    book: &mut Sheets<std::io::BufReader<std::fs::File>>,
    name: &str,
    opts: &FormatOptions,
    bytes: &mut usize,
) -> Result<Sheet> {
    let mut builder = RecordsBuilder::new(bytes);
    let mut formulas: Vec<(u32, u32, String)> = Vec::new();
    let mut merges: Vec<(u32, u32, u32, u32)> = Vec::new();
    match book {
        // xlsx 家族：流式值+样式一遍、公式一遍（有界红线保持：逐格先检再物化）
        Sheets::Xlsx(b) => {
            {
                let mut reader = b.worksheet_cells_reader(name).map_err(map_open_err)?;
                while let Some((cell, sid)) =
                    reader.next_cell_with_style_id().map_err(map_open_err)?
                {
                    let code = reader
                        .styles()
                        .get(sid)
                        .and_then(|s| s.number_format.as_ref())
                        .map(|nf| nf.format_code.as_str());
                    let (r, c) = cell.get_position();
                    let v = Data::from(cell.get_value().clone());
                    builder.push(r, c, display_value(&v, code, opts))?;
                }
            }
            {
                let mut reader = b.worksheet_cells_reader(name).map_err(map_open_err)?;
                while let Some(cell) = reader.next_formula().map_err(map_open_err)? {
                    if !cell.get_value().is_empty() {
                        let (r, c) = cell.get_position();
                        formulas.push((r, c, cell.get_value().clone()));
                    }
                }
            }
            merges = b
                .merge_cells_by_sheet_name(name)
                .map_err(map_open_err)?
                .into_iter()
                .map(|d| (d.start.0, d.end.0, d.start.1, d.end.1))
                .collect();
        }
        // xlsb：流式值/公式（内核无样式通道——日期走兜底显示）
        Sheets::Xlsb(b) => {
            {
                let mut reader = b.worksheet_cells_reader(name).map_err(map_open_err)?;
                while let Some(cell) = reader.next_cell().map_err(map_open_err)? {
                    let (r, c) = cell.get_position();
                    let v = Data::from(cell.get_value().clone());
                    builder.push(r, c, display_value(&v, None, opts))?;
                }
            }
            let mut reader = b.worksheet_cells_reader(name).map_err(map_open_err)?;
            while let Some(cell) = reader.next_formula().map_err(map_open_err)? {
                if !cell.get_value().is_empty() {
                    let (r, c) = cell.get_position();
                    formulas.push((r, c, cell.get_value().clone()));
                }
            }
        }
        // xls / ods：内核无流式接口——整表物化后检（残余暴露见模块注释）
        Sheets::Xls(_) | Sheets::Ods(_) => {
            let range: Range<Data> = book.worksheet_range(name).map_err(map_open_err)?;
            if let Some((last_row, last_col)) = range.end() {
                if last_row as u64 + 1 > ROW_LIMIT {
                    return Err("XLSX_ROW_LIMIT_OR_ORDER:200000".into());
                }
                if last_col + 1 > COLUMN_LIMIT {
                    return Err("XLSX_COLUMN_LIMIT:1024".into());
                }
            }
            for (r, c, v) in range.used_cells() {
                builder.push(r as u32, c as u32, display_value(v, None, opts))?;
            }
            let frange = book.worksheet_formula(name).map_err(map_open_err)?;
            for (r, c, f) in frange.used_cells() {
                if !f.is_empty() {
                    formulas.push((r as u32, c as u32, f.clone()));
                }
            }
            if let Sheets::Xls(xb) = book {
                merges = xb
                    .merge_cells_by_sheet_name(name)
                    .map_err(map_open_err)?
                    .into_iter()
                    .map(|d| (d.start.0, d.end.0, d.start.1, d.end.1))
                    .collect();
            }
        }
    }
    formulas.sort_unstable_by_key(|(r, c, _)| (*r, *c));
    Ok(Sheet {
        name: name.into(),
        records: builder.records,
        formulas,
        merges,
    })
}

pub fn open(path: &str) -> Result<Workbook> {
    let p = Path::new(path);
    // 包大小预检（100MiB 红线，先于内核读取拒绝）
    let len = std::fs::metadata(p)
        .map_err(|e| format!("XLSX_OPEN:{e}"))?
        .len();
    if len > PACKAGE_LIMIT {
        return Err("OOXML_PACKAGE_LIMIT:100MiB".into());
    }
    // ods 走自有有界管线（calamine Ods 对截断 content.xml 无限循环——见 ods.rs 注释）
    if p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("ods"))
    {
        return Ok(super::ods::to_workbook(super::ods::open(path)?));
    }
    let mut book: Sheets<std::io::BufReader<std::fs::File>> =
        calamine::open_workbook_auto(p).map_err(map_open_err)?;
    if book.sheet_names().len() > SHEET_LIMIT {
        return Err("XLSX_SHEET_LIMIT:64".into());
    }
    let is_1904 = match &book {
        Sheets::Xls(b) => b.has_1904_epoch(),
        Sheets::Xlsx(b) => b.has_1904_epoch(),
        Sheets::Xlsb(b) => b.has_1904_epoch(),
        Sheets::Ods(_) => false,
    };
    let opts = text_options(is_1904);
    let names = book.sheet_names();
    let mut sheets = Vec::with_capacity(names.len());
    let mut bytes = 0usize;
    for name in names {
        sheets.push(sheet_of(&mut book, &name, &opts, &mut bytes)?);
    }
    Ok(Workbook { sheets, is_1904 })
}

/// 窗口行取数（xlsx_records 用）：formula 开关为真时，有公式的格显示公式文本
/// （"="+公式，Excel 编辑栏口径），否则显示值。
pub fn window_records(sheet: &Sheet, from: u64, to: u64, formula: bool) -> Result<Vec<CsvRecord>> {
    let range = super::window(from, to)?;
    let rows = &sheet.records;
    let mut out = Vec::new();
    for i in range.take_while(|i| *i < rows.len()) {
        let cells: Vec<String> = if formula {
            let r = i as u32;
            rows[i]
                .iter()
                .enumerate()
                .map(|(c, v)| {
                    match sheet
                        .formulas
                        .binary_search_by_key(&(r, c as u32), |(fr, fc, _)| (*fr, *fc))
                    {
                        Ok(idx) => format!("={}", sheet.formulas[idx].2),
                        Err(_) => v.clone(),
                    }
                })
                .collect()
        } else {
            rows[i].clone()
        };
        out.push(CsvRecord {
            no: (i + 1) as u64,
            cells,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小但结构真实的 xlsx OPC 包（calamine 经 _rels/.rels 定位 workbook）
    fn wb_fixture(sheet: &str, styles: Option<&str>, name: &str) -> String {
        let mut entries = vec![
            (
                "[Content_Types].xml",
                "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><Default Extension='xml' ContentType='application/xml'/><Override PartName='/xl/workbook.xml' ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'/><Override PartName='/xl/worksheets/sheet1.xml' ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'/></Types>",
            ),
            (
                "_rels/.rels",
                "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' Target='xl/workbook.xml'/></Relationships>",
            ),
            (
                "xl/workbook.xml",
                "<workbook xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><sheets><sheet name='S' r:id='r1'/></sheets></workbook>",
            ),
            (
                "xl/_rels/workbook.xml.rels",
                "<Relationships><Relationship Id='r1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Target='worksheets/sheet1.xml'/></Relationships>",
            ),
        ];
        if let Some(s) = styles {
            entries.push(("xl/styles.xml", s));
        }
        entries.push(("xl/worksheets/sheet1.xml", sheet));
        crate::ooxml::fixture(&entries, name)
    }

    #[test]
    fn formatted_values_date_percent_bool_error() {
        // 自定义 yyyy-mm-dd（id 164）+ 内置 10（0.00%）+ 布尔/错误通道 + General
        let styles = "<styleSheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><numFmts count='1'><numFmt numFmtId='164' formatCode='yyyy-mm-dd'/></numFmts><cellXfs count='3'><xf numFmtId='164' applyNumberFormat='1'/><xf numFmtId='10' applyNumberFormat='1'/><xf numFmtId='0'/></cellXfs></styleSheet>";
        let p = wb_fixture(
            "<worksheet><sheetData><row r='1'><c r='A1' s='0'><v>45292</v></c><c r='B1' s='1'><v>0.4512</v></c><c r='C1' t='b'><v>1</v></c><c r='D1' t='e'><v>#DIV/0!</v></c><c r='E1' s='2'><v>42</v></c></row></sheetData></worksheet>",
            Some(styles),
            "fmt.xlsx",
        );
        let book = open(&p).unwrap();
        assert!(!book.is_1904);
        assert_eq!(
            book.sheets[0].records[0],
            ["2024-01-01", "45.12%", "TRUE", "#DIV/0!", "42"]
        );
        assert!(!book.info().truncated);
        // 确定性：同文件二次提取逐字节一致（投影缓存语义依赖）
        let again = open(&p).unwrap();
        assert_eq!(book.sheets[0].records, again.sheets[0].records);
    }

    #[test]
    fn formulas_and_formula_window() {
        let p = wb_fixture(
            "<worksheet><sheetData><row r='1'><c r='A1'><v>1</v></c><c r='B1'><f>A1*2</f><v>2</v></c></row></sheetData></worksheet>",
            None,
            "formula.xlsx",
        );
        let book = open(&p).unwrap();
        assert_eq!(book.sheets[0].formulas, vec![(0, 1, "A1*2".to_string())]);
        let sheet = &book.sheets[0];
        assert_eq!(
            window_records(sheet, 1, 10, false).unwrap()[0].cells,
            ["1", "2"]
        );
        assert_eq!(
            window_records(sheet, 1, 10, true).unwrap()[0].cells,
            ["1", "=A1*2"]
        );
    }

    #[test]
    fn date_system_1904_and_builtin_time() {
        // date1904='1'：同一序列数按 1904 历法换算；内置 20（h:mm）走时间通道
        let entries = vec![
            (
                "[Content_Types].xml",
                "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><Default Extension='xml' ContentType='application/xml'/><Override PartName='/xl/workbook.xml' ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'/><Override PartName='/xl/worksheets/sheet1.xml' ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'/></Types>",
            ),
            (
                "_rels/.rels",
                "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' Target='xl/workbook.xml'/></Relationships>",
            ),
            (
                "xl/workbook.xml",
                "<workbook xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><workbookPr date1904='1'/><sheets><sheet name='S' r:id='r1'/></sheets></workbook>",
            ),
            (
                "xl/_rels/workbook.xml.rels",
                "<Relationships><Relationship Id='r1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Target='worksheets/sheet1.xml'/></Relationships>",
            ),
            (
                "xl/styles.xml",
                "<styleSheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><cellXfs count='2'><xf numFmtId='14'/><xf numFmtId='20'/></cellXfs></styleSheet>",
            ),
            (
                "xl/worksheets/sheet1.xml",
                "<worksheet><sheetData><row r='1'><c r='A1' s='0'><v>1</v></c><c r='B1' s='1'><v>0.5</v></c></row></sheetData></worksheet>",
            ),
        ];
        let p = crate::ooxml::fixture(&entries, "d1904.xlsx");
        let book = open(&p).unwrap();
        assert!(book.is_1904);
        assert!(book.info().is_1904);
        // 1904 系：serial 0 = 1904-01-01，serial 1 = 1904-01-02；内置 14（mm-dd-yy
        // en-US 显示）→ "01-02-04"；同一序列在 1900 系会是 "01-01-00"——历法生效证据
        assert_eq!(book.sheets[0].records[0][0], "01-02-04");
        assert_eq!(book.sheets[0].records[0][1], "12:00");
    }

    #[test]
    fn text_format_keeps_leading_zeros() {
        // 内置 49（@）文本格式：字符串照原样（含前导零）
        let styles = "<styleSheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><cellXfs count='1'><xf numFmtId='49'/></cellXfs></styleSheet>";
        let p = wb_fixture(
            "<worksheet><sheetData><row r='1'><c r='A1' t='str' s='0'><v>007</v></c></row></sheetData></worksheet>",
            Some(styles),
            "text.xlsx",
        );
        let book = open(&p).unwrap();
        assert_eq!(book.sheets[0].records[0], ["007"]);
    }

    #[test]
    fn merges_reported_for_xlsx() {
        let p = wb_fixture(
            "<worksheet><sheetData><row r='1'><c r='A1'><v>1</v></c></row></sheetData><mergeCells count='1'><mergeCell ref='A1:B2'/></mergeCells></worksheet>",
            None,
            "merge.xlsx",
        );
        let book = open(&p).unwrap();
        assert_eq!(book.sheets[0].merges, vec![(0, 1, 0, 1)]);
    }

    #[test]
    fn limits_are_explicit_sentinels() {
        // 非 ZIP 内容伪装 xlsx：open_workbook_auto 报错 → XLSX_OPEN 哨兵
        let dir = std::env::temp_dir().join("ZiEdit-xlsx-calamine");
        std::fs::create_dir_all(&dir).unwrap();
        let corrupt = dir.join("corrupt.xlsx");
        std::fs::write(&corrupt, b"not a zip at all").unwrap();
        assert!(
            open(corrupt.to_str().unwrap())
                .err()
                .unwrap()
                .starts_with("XLSX_OPEN:")
        );
        let _ = std::fs::remove_file(&corrupt);
        // 行上限哨兵（r=200001，流式逐格先检）
        let p = wb_fixture(
            "<worksheet><sheetData><row r='200001'><c r='A200001'><v>1</v></c></row></sheetData></worksheet>",
            None,
            "row-over.xlsx",
        );
        assert_eq!(
            open(&p).err().unwrap(),
            "XLSX_ROW_LIMIT_OR_ORDER:200000",
            "行上限哨兵"
        );
        // 列上限哨兵（AMK=1025 列）
        let p2 = wb_fixture(
            "<worksheet><sheetData><row r='1'><c r='A1'><v>1</v></c><c r='AMK1'><v>2</v></c></row></sheetData></worksheet>",
            None,
            "col-over.xlsx",
        );
        assert_eq!(
            open(&p2).err().unwrap(),
            "XLSX_COLUMN_LIMIT:1024",
            "列上限哨兵（AMK=1025 列）"
        );
        // sheet 数上限（65 个 sheet）
        let mut names = String::from("<workbook xmlns:r='r'><sheets>");
        let mut rels = String::from("<Relationships>");
        let mut entries: Vec<(String, String)> = Vec::new();
        for i in 0..65 {
            names.push_str(&format!("<sheet name='S{i}' r:id='r{i}'/>"));
            rels.push_str(&format!(
                "<Relationship Id='r{i}' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Target='worksheets/sheet{i}.xml'/>"
            ));
            entries.push((
                format!("xl/worksheets/sheet{i}.xml"),
                "<worksheet><sheetData/></worksheet>".into(),
            ));
        }
        names.push_str("</sheets></workbook>");
        rels.push_str("</Relationships>");
        entries.insert(0, ("xl/workbook.xml".into(), names));
        entries.push(("xl/_rels/workbook.xml.rels".into(), rels));
        entries.push((
            "_rels/.rels".into(),
            "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' Target='xl/workbook.xml'/></Relationships>".into(),
        ));
        let refs: Vec<(&str, &str)> = entries
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        let p3 = crate::ooxml::fixture(&refs, "sheet-over.xlsx");
        assert_eq!(open(&p3).err().unwrap(), "XLSX_SHEET_LIMIT:64");
    }
    #[test]
    fn ods_routes_to_bounded_pipeline() {
        // .ods 扩展名路由到自有有界管线（calamine Ods 挂起缺陷，见 ods.rs 注释）；
        // 经 xlsx::open 统一入口验证路由与值口径。
        let p = crate::ooxml::fixture(
            &[
                ("mimetype", "application/vnd.oasis.opendocument.spreadsheet"),
                (
                    "META-INF/manifest.xml",
                    "<manifest:manifest xmlns:manifest='urn:oasis:names:tc:opendocument:xmlns:manifest:1.0' manifest:version='1.2'><manifest:file-entry manifest:full-path='/' manifest:media-type='application/vnd.oasis.opendocument.spreadsheet'/><manifest:file-entry manifest:full-path='content.xml' manifest:media-type='text/xml'/></manifest:manifest>",
                ),
                (
                    "content.xml",
                    "<office:document-content xmlns:office='urn:oasis:names:tc:opendocument:xmlns:office:1.0' xmlns:table='urn:oasis:names:tc:opendocument:xmlns:table:1.0' xmlns:text='urn:oasis:names:tc:opendocument:xmlns:text:1.0'><office:body><office:spreadsheet><table:table table:name='Data'><table:table-row><table:table-cell office:value-type='float' office:value='42'/><table:table-cell office:value-type='string'><text:p>hello</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>",
                ),
            ],
            "data.ods",
        );
        let book = open(&p).unwrap();
        assert!(!book.is_1904);
        assert_eq!(book.sheets[0].name, "Data");
        assert_eq!(book.sheets[0].records[0], ["42", "hello"]);
    }

    #[test]
    fn sparse_rows_keep_positions() {
        let p = wb_fixture(
            "<worksheet><sheetData><row r='2'/><row r='4'><c r='B4'><v>7</v></c></row></sheetData></worksheet>",
            None,
            "sparse.xlsx",
        );
        let rows = open(&p).unwrap().sheets[0].records.clone();
        assert_eq!(rows.len(), 4);
        assert!(rows[0].is_empty());
        assert_eq!(rows[3], ["", "7"]);
        // 窗口取数：1 基行号、稀疏占位
        let sheet = &open(&p).unwrap().sheets[0];
        let got = window_records(sheet, 4, 4, false).unwrap();
        assert_eq!(got[0].no, 4);
        assert_eq!(got[0].cells, ["", "7"]);
    }
}
