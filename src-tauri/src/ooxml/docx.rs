use super::*;
use serde::Serialize;

pub struct Document {
    pub lines: Vec<String>,
    pub total_chars: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub para_count: usize,
    pub total_chars: usize,
    pub truncated: bool,
}
impl Document {
    pub fn info(&self) -> OpenResult {
        OpenResult {
            para_count: self.lines.len(),
            total_chars: self.total_chars,
            truncated: false,
        }
    }
}
pub fn open(path: &str) -> Result<Document> {
    let mut zip = package(path)?;
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut in_row = false;
    let mut first_cell = true;
    let mut cell_paragraphs = 0;
    let mut bytes = 0;
    xml(&mut zip, "word/document.xml", 32 * 1024 * 1024, |event| {
        match event {
            Event::Start(e) | Event::Empty(e) => match e.local_name().as_ref() {
                b"tr" => {
                    in_row = true;
                    first_cell = true;
                }
                b"tc" => {
                    if !first_cell {
                        current.push('\t');
                    }
                    first_cell = false;
                    cell_paragraphs = 0;
                }
                b"p" if in_row => {
                    if cell_paragraphs > 0 {
                        current.push('\n');
                    }
                    cell_paragraphs += 1;
                }
                b"t" => in_text = true,
                b"tab" => current.push('\t'),
                b"br" | b"cr" => current.push('\n'),
                _ => {}
            },
            Event::Text(e) if in_text => {
                current.push_str(&e.unescape().map_err(|e| e.to_string())?)
            }
            Event::CData(e) if in_text => {
                current.push_str(std::str::from_utf8(&e).map_err(|e| e.to_string())?)
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"t" => in_text = false,
                b"p" if !in_row => {
                    bytes += current.len();
                    lines.push(std::mem::take(&mut current));
                }
                b"tr" => {
                    in_row = false;
                    bytes += current.len();
                    lines.push(std::mem::take(&mut current));
                }
                _ => {}
            },
            _ => {}
        }
        if bytes + current.len() + lines.len() * std::mem::size_of::<String>() > TEXT_LIMIT {
            return Err("OOXML_TEXT_LIMIT:10MiB".into());
        }
        Ok(())
    })?;
    let total_chars = lines.iter().map(|s| s.chars().count()).sum();
    Ok(Document { lines, total_chars })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paragraphs_tables_breaks() {
        let p = fixture(
            &[(
                "word/document.xml",
                "<w:document xmlns:w='w'><w:p><w:r><w:t>A&amp;</w:t><w:t>B</w:t><w:tab/><w:t>C</w:t><w:br/><w:t>D</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:t>X</w:t></w:p></w:tc><w:tc><w:p><w:t>Y</w:t></w:p></w:tc></w:tr></w:tbl></w:document>",
            )],
            "paragraphs.docx",
        );
        assert_eq!(open(&p).unwrap().lines, ["A&B\tC\nD", "X\tY"]);
    }
    #[test]
    fn extraction_limit_is_explicit() {
        let text = format!(
            "<document><p><t>{}</t></p></document>",
            "a".repeat(TEXT_LIMIT + 1)
        );
        let p = fixture(&[("word/document.xml", &text)], "limit.docx");
        assert!(open(&p).err().unwrap().contains("TEXT_LIMIT"));
    }
}
