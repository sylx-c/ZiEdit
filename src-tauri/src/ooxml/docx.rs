use super::*;
use serde::Serialize;

pub struct Document {
    pub lines: Vec<String>,
    pub total_chars: usize,
    /// 正文存在修订标记（w:ins/w:del）：查看提示与对比投影口径说明用。
    /// 提取语义不变（插入文本计入正文、w:delText 丢弃）＝「接受全部修订后的终态」。
    pub revisions: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub para_count: usize,
    pub total_chars: usize,
    pub truncated: bool,
    #[serde(default)]
    pub revisions: bool,
}
impl Document {
    pub fn info(&self) -> OpenResult {
        OpenResult {
            para_count: self.lines.len(),
            total_chars: self.total_chars,
            truncated: false,
            revisions: self.revisions,
        }
    }
}
pub fn open(path: &str) -> Result<Document> {
    // odt（ODF 文本文档）：读 content.xml 的 text:p/text:h 段落（批 2，quick-xml
    // 管线复用）；无修订语义（ODF 变更跟踪不解析），revisions 恒 false。
    let is_odf = std::path::Path::new(path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("odt"));
    if is_odf {
        return open_odf(path);
    }
    let mut zip = package(path)?;
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut in_row = false;
    let mut first_cell = true;
    let mut cell_paragraphs = 0;
    let mut bytes = 0;
    let mut revisions = false;
    xml(&mut zip, "word/document.xml", 32 * 1024 * 1024, |event| {
        match event {
            Event::Start(e) | Event::Empty(e) => match e.local_name().as_ref() {
                "tr" => {
                    in_row = true;
                    first_cell = true;
                }
                "tc" => {
                    if !first_cell {
                        current.push('\t');
                    }
                    first_cell = false;
                    cell_paragraphs = 0;
                }
                "p" if in_row => {
                    if cell_paragraphs > 0 {
                        current.push('\n');
                    }
                    cell_paragraphs += 1;
                }
                "t" => in_text = true,
                // 修订标记（批 1 对比投影）：w:ins/w:del 元素出现即置位；
                // 提取口径不变（终态），标志仅供查看/对比头部如实告知。
                "ins" | "del" => revisions = true,
                "tab" => current.push('\t'),
                "br" | "cr" => current.push('\n'),
                _ => {}
            },
            Event::Text(e) if in_text => current
                .push_str(&quick_xml::escape::unescape(e.as_ref()).map_err(|e| e.to_string())?),
            Event::GeneralRef(e) if in_text => {
                current.push_str(&crate::ooxml::resolve_ref(e.as_ref())?)
            }
            Event::CData(e) if in_text => current.push_str(e.as_ref()),
            Event::End(e) => match e.local_name().as_ref() {
                "t" => in_text = false,
                "p" if !in_row => {
                    bytes += current.len();
                    lines.push(std::mem::take(&mut current));
                }
                "tr" => {
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
    Ok(Document {
        lines,
        total_chars,
        revisions,
    })
}

/// ODF 文本文档（.odt）：content.xml 的 text:p / text:h 段落 → 行投影。
/// text:tab → 制表符、text:line-break / text:s（空格串）按显示语义展开；
/// 上限与 docx 同口径（10MiB 提取文本红线，显式哨兵）。
fn open_odf(path: &str) -> Result<Document> {
    let mut zip = package(path)?;
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut in_paragraph = false; // 段落文本模式（text:p/text:h 内）
    let mut bytes = 0usize;
    xml(&mut zip, "content.xml", 32 * 1024 * 1024, |event| {
        match event {
            Event::Start(e) | Event::Empty(e) => match e.local_name().as_ref() {
                "p" | "h" => {
                    in_paragraph = true;
                    current.clear();
                }
                "tab" if in_paragraph => current.push('\t'),
                "line-break" if in_paragraph => current.push('\n'),
                "s" if in_paragraph => {
                    // text:c 个空格（默认 1）
                    let n: usize = attr(&e, "text:c")?
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(1)
                        .min(1000);
                    for _ in 0..n {
                        current.push(' ');
                    }
                }
                // 命名空间内文本元素（office:text 等）不产出行
                _ => {}
            },
            Event::Text(t) if in_paragraph => current
                .push_str(&quick_xml::escape::unescape(t.as_ref()).map_err(|e| e.to_string())?),
            Event::GeneralRef(t) if in_paragraph => {
                current.push_str(&crate::ooxml::resolve_ref(t.as_ref())?)
            }
            Event::CData(t) if in_paragraph => current.push_str(t.as_ref()),
            Event::End(e) => match e.local_name().as_ref() {
                "p" | "h" => {
                    in_paragraph = false;
                    bytes += current.len() + std::mem::size_of::<String>();
                    if bytes > TEXT_LIMIT {
                        return Err("OOXML_TEXT_LIMIT:10MiB".into());
                    }
                    lines.push(std::mem::take(&mut current));
                }
                _ => {}
            },
            _ => {}
        }
        Ok(())
    })?;
    let total_chars = lines.iter().map(|s| s.chars().count()).sum();
    Ok(Document {
        lines,
        total_chars,
        revisions: false,
    })
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
    fn odt_text_projection() {
        // 批 2：odt → content.xml 段落行投影（tab/换行/空格串展开；revisions 恒 false）
        let p = fixture(
            &[
                ("mimetype", "application/vnd.oasis.opendocument.text"),
                (
                    "META-INF/manifest.xml",
                    "<manifest:manifest xmlns:manifest='urn:oasis:names:tc:opendocument:xmlns:manifest:1.0' manifest:version='1.2'><manifest:file-entry manifest:full-path='/' manifest:media-type='application/vnd.oasis.opendocument.text'/><manifest:file-entry manifest:full-path='content.xml' manifest:media-type='text/xml'/></manifest:manifest>",
                ),
                (
                    "content.xml",
                    "<office:document-content xmlns:office='urn:oasis:names:tc:opendocument:xmlns:office:1.0' xmlns:text='urn:oasis:names:tc:opendocument:xmlns:text:1.0'><office:body><office:text><text:h>标题</text:h><text:p>第一段<text:tab/>后</text:p><text:p>换行<text:line-break/>第二行</text:p><text:p>空<text:s text:c='3'/>格</text:p></office:text></office:body></office:document-content>",
                ),
            ],
            "doc.odt",
        );
        let doc = open(&p).unwrap();
        assert_eq!(doc.lines, ["标题", "第一段\t后", "换行\n第二行", "空   格"]);
        assert!(!doc.revisions);
    }
    #[test]
    fn revision_marks_set_flag_but_extraction_stays_final_state() {
        // w:ins 内文本计入正文（终态），w:delText 不计（local_name 非 t）；
        // 出现 ins/del 即置 revisions 标志。
        let p = fixture(
            &[(
                "word/document.xml",
                "<w:document xmlns:w='w'><w:p><w:ins><w:r><w:t>kept</w:t></w:r></w:ins><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p></w:document>",
            )],
            "revisions.docx",
        );
        let doc = open(&p).unwrap();
        assert_eq!(doc.lines, ["kept"]);
        assert!(doc.revisions);
        assert!(doc.info().revisions);
        // 无修订文档：标志为 false
        let clean = fixture(
            &[(
                "word/document.xml",
                "<w:document xmlns:w='w'><w:p><w:r><w:t>plain</w:t></w:r></w:p></w:document>",
            )],
            "clean.docx",
        );
        assert!(!open(&clean).unwrap().revisions);
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
