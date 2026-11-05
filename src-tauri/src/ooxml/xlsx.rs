use super::*;
use crate::commands::csv::CsvRecord;
use serde::Serialize;
use std::collections::HashMap;

pub struct Workbook {
    pub sheets: Vec<Sheet>,
}
pub struct Sheet {
    pub name: String,
    pub records: Vec<Vec<String>>,
}
#[derive(Serialize)]
pub struct SheetInfo {
    pub name: String,
    pub rows: usize,
}
#[derive(Serialize)]
pub struct OpenResult {
    pub sheets: Vec<SheetInfo>,
    pub truncated: bool,
}
#[derive(Serialize)]
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
        }
    }
}

fn strings(zip: &mut Package) -> Result<Vec<String>> {
    if !zip.file_names().any(|n| n == "xl/sharedStrings.xml") {
        return Ok(Vec::new());
    }
    let mut pool = Vec::new();
    let mut text = String::new();
    let mut in_text = false;
    let mut bytes = 0;
    xml(zip, "xl/sharedStrings.xml", 64 * 1024 * 1024, |event| {
        match event {
            Event::Start(e) if e.local_name().as_ref() == b"t" => in_text = true,
            Event::Text(e) if in_text => text.push_str(&e.unescape().map_err(|e| e.to_string())?),
            Event::End(e) if e.local_name().as_ref() == b"t" => in_text = false,
            Event::End(e) if e.local_name().as_ref() == b"si" => {
                bytes += text.len();
                pool.push(std::mem::take(&mut text));
            }
            _ => {}
        }
        if text.len() > 32 * 1024 || bytes + text.len() + pool.len() * 24 > 64 * 1024 * 1024 {
            return Err("XLSX_SHARED_STRINGS_LIMIT".into());
        }
        Ok(())
    })?;
    Ok(pool)
}

fn column(reference: &str) -> Result<usize> {
    let mut n = 0usize;
    for c in reference.bytes().take_while(u8::is_ascii_alphabetic) {
        n = n
            .checked_mul(26)
            .and_then(|v| v.checked_add((c.to_ascii_uppercase() - b'A' + 1) as usize))
            .ok_or("XLSX_COLUMN_LIMIT:1024")?;
        if n > 1024 {
            return Err("XLSX_COLUMN_LIMIT:1024".into());
        }
    }
    n.checked_sub(1)
        .ok_or_else(|| "XLSX_INVALID_CELL_REFERENCE".into())
}

fn worksheet(
    zip: &mut Package,
    name: &str,
    pool: &[String],
    bytes: &mut usize,
) -> Result<Vec<Vec<String>>> {
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut row = Vec::new();
    let mut row_no = 0usize;
    let mut col = 0;
    let mut kind = String::new();
    let mut value = String::new();
    let mut capture = false;
    let mut in_cell = false;
    let mut in_row = false;
    xml(zip, name, 64 * 1024 * 1024, |event| {
        match event {
            Event::Start(e) | Event::Empty(e) => match e.local_name().as_ref() {
                b"row" => {
                    if in_row {
                        return Err("XLSX_NESTED_ROW".into());
                    }
                    in_row = true;
                    row_no = match attr(&e, b"r")? {
                        Some(n) => n.parse().map_err(|_| "XLSX_INVALID_ROW")?,
                        None => records.len() + 1,
                    };
                    if row_no == 0 || row_no > 200_000 || row_no <= records.len() {
                        return Err("XLSX_ROW_LIMIT_OR_ORDER:200000".into());
                    }
                }
                b"c" => {
                    if !in_row || in_cell {
                        return Err("XLSX_INVALID_CELL".into());
                    }
                    in_cell = true;
                    col = match attr(&e, b"r")? {
                        Some(r) => column(&r)?,
                        None => row.len(),
                    };
                    if col >= 1024 {
                        return Err("XLSX_COLUMN_LIMIT:1024".into());
                    }
                    kind = attr(&e, b"t")?.unwrap_or_default();
                    value.clear();
                }
                b"v" | b"t" if in_cell => capture = true,
                _ => {}
            },
            Event::Text(e) if capture => value.push_str(&e.unescape().map_err(|e| e.to_string())?),
            Event::End(e) => match e.local_name().as_ref() {
                b"v" | b"t" => capture = false,
                b"c" => {
                    in_cell = false;
                    let cell = if kind == "s" {
                        pool.get(
                            value
                                .parse::<usize>()
                                .map_err(|_| "XLSX_INVALID_SHARED_STRING")?,
                        )
                        .ok_or("XLSX_INVALID_SHARED_STRING")?
                        .clone()
                    } else {
                        std::mem::take(&mut value)
                    };
                    if cell.len() > 32 * 1024 {
                        return Err("XLSX_CELL_LIMIT:32KiB".into());
                    }
                    *bytes += cell.len()
                        + (col + 1).saturating_sub(row.len()) * std::mem::size_of::<String>();
                    if *bytes > TEXT_LIMIT {
                        return Err("OOXML_TEXT_LIMIT:10MiB".into());
                    }
                    row.resize(row.len().max(col + 1), String::new());
                    row[col] = cell;
                }
                b"row" => {
                    in_row = false;
                    *bytes += (row_no - records.len()) * std::mem::size_of::<Vec<String>>();
                    if *bytes > TEXT_LIMIT {
                        return Err("OOXML_TEXT_LIMIT:10MiB".into());
                    }
                    records.resize_with(row_no - 1, Vec::new);
                    records.push(std::mem::take(&mut row));
                }
                _ => {}
            },
            _ => {}
        }
        if value.len() > 32 * 1024 {
            return Err("XLSX_CELL_LIMIT:32KiB".into());
        }
        Ok(())
    })?;
    Ok(records)
}

pub fn open(path: &str) -> Result<Workbook> {
    let mut zip = package(path)?;
    let mut targets = HashMap::new();
    xml(
        &mut zip,
        "xl/_rels/workbook.xml.rels",
        1024 * 1024,
        |event| {
            if let Event::Start(e) | Event::Empty(e) = event
                && e.local_name().as_ref() == b"Relationship"
                && attr(&e, b"TargetMode")?.as_deref() != Some("External")
                && let (Some(id), Some(target)) = (attr(&e, b"Id")?, attr(&e, b"Target")?)
            {
                let target = if target.starts_with('/') {
                    target.trim_start_matches('/').to_owned()
                } else {
                    format!("xl/{target}")
                };
                if target.split('/').any(|p| p == "..") {
                    return Err("XLSX_INVALID_TARGET".into());
                }
                targets.insert(id, target);
            }
            Ok(())
        },
    )?;
    let mut names = Vec::new();
    xml(&mut zip, "xl/workbook.xml", 1024 * 1024, |event| {
        if let Event::Start(e) | Event::Empty(e) = event
            && e.local_name().as_ref() == b"sheet"
        {
            if names.len() >= 64 {
                return Err("XLSX_SHEET_LIMIT:64".into());
            }
            let id = attr(&e, b"r:id")?.ok_or("XLSX_MISSING_RELATIONSHIP")?;
            names.push((
                attr(&e, b"name")?.unwrap_or_default(),
                targets.get(&id).ok_or("XLSX_MISSING_RELATIONSHIP")?.clone(),
            ));
        }
        Ok(())
    })?;
    let pool = strings(&mut zip)?;
    let mut sheets = Vec::new();
    let mut bytes = 0;
    for (name, target) in names {
        sheets.push(Sheet {
            name,
            records: worksheet(&mut zip, &target, &pool, &mut bytes)?,
        });
    }
    Ok(Workbook { sheets })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_inline_numeric_cached_formula_and_empty_sheet() {
        let p = fixture(
            &[
                (
                    "xl/workbook.xml",
                    "<workbook xmlns:r='r'><sheets><sheet name='Data' r:id='r1'/><sheet name='Empty' r:id='r2'/></sheets></workbook>",
                ),
                (
                    "xl/_rels/workbook.xml.rels",
                    "<Relationships><Relationship Id='r1' Target='worksheets/sheet1.xml'/><Relationship Id='r2' Target='worksheets/sheet2.xml'/></Relationships>",
                ),
                (
                    "xl/sharedStrings.xml",
                    "<sst><si><t>shared &amp; text</t></si></sst>",
                ),
                (
                    "xl/worksheets/sheet1.xml",
                    "<worksheet><sheetData><row r='1'><c r='A1' t='s'><v>0</v></c><c r='C1' t='inlineStr'><is><t>inline</t></is></c><c r='D1'><v>42</v></c><c r='E1'><f>D1+1</f><v>43</v></c></row></sheetData></worksheet>",
                ),
                (
                    "xl/worksheets/sheet2.xml",
                    "<worksheet><sheetData/></worksheet>",
                ),
            ],
            "values.xlsx",
        );
        let book = open(&p).unwrap();
        assert_eq!(
            book.sheets[0].records[0],
            ["shared & text", "", "inline", "42", "43"]
        );
        assert!(book.sheets[1].records.is_empty());
        assert!(!book.info().truncated);
    }
    #[test]
    fn column_limit() {
        assert_eq!(column("AMJ1").unwrap(), 1023);
        assert!(column("AMK1").is_err());
    }

    #[test]
    fn worksheet_limits_are_explicit_not_silent_truncation() {
        for (name, text, expected) in [
            (
                "row-limit.xlsx",
                "<worksheet><row r='200001'/></worksheet>".to_string(),
                "ROW_LIMIT",
            ),
            (
                "cell-limit.xlsx",
                format!(
                    "<worksheet><row><c><v>{}</v></c></row></worksheet>",
                    "x".repeat(32 * 1024 + 1)
                ),
                "CELL_LIMIT",
            ),
            (
                "text-limit.xlsx",
                "<worksheet><row><c><v>x</v></c></row></worksheet>".to_string(),
                "TEXT_LIMIT",
            ),
        ] {
            let p = fixture(&[("sheet.xml", &text)], name);
            let mut zip = package(&p).unwrap();
            let mut bytes = if expected == "TEXT_LIMIT" {
                TEXT_LIMIT
            } else {
                0
            };
            assert!(
                worksheet(&mut zip, "sheet.xml", &[], &mut bytes)
                    .err()
                    .unwrap()
                    .contains(expected)
            );
        }
    }

    #[test]
    fn sparse_and_empty_rows_keep_positions() {
        let p = fixture(
            &[(
                "sheet.xml",
                "<worksheet><row r='2'/><row r='4'><c r='B4'/></row></worksheet>",
            )],
            "sparse.xlsx",
        );
        let rows = worksheet(&mut package(&p).unwrap(), "sheet.xml", &[], &mut 0).unwrap();
        assert_eq!(rows.len(), 4);
        assert!(rows[0].is_empty());
        assert_eq!(rows[3], ["", ""]);
    }
}
