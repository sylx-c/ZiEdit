use super::*;
use serde::Serialize;

/// 前缀无关属性读取：OOXML 常见 `w:val` 与无前缀 `val` 等价取值
///（命名空间绑定按文档而变，前缀不是语义；两形态都接受）。
fn attr_local(e: &quick_xml::events::BytesStart<'_>, name: &str) -> Result<Option<String>> {
    if let Some(v) = attr(e, name)? {
        return Ok(Some(v));
    }
    attr(e, &format!("w:{name}"))
}

/// 修订记录（批 3）：w:ins/w:del 的作者/时间/文本，按出现序。
/// 主提取口径不变（终态）；修订记录是并行的审阅通道（docx_revision_report）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionRecord {
    /// "ins" | "del"
    pub kind: String,
    pub author: String,
    pub date: String,
    /// 修订内文本（ins 取 w:t、del 取 w:delText）
    pub text: String,
}

/// 修订记录总量哨兵（交互载荷上限，超限显式报错）
pub const REVISION_LIMIT: usize = 10_000;

/// 修订报告（docx_revision_report 命令载荷；批 3 审阅通道）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionReport {
    pub records: Vec<RevisionRecord>,
    pub total: usize,
    pub truncated: bool,
}

pub struct Document {
    pub lines: Vec<String>,
    pub total_chars: usize,
    /// 正文存在修订标记（w:ins/w:del）：查看提示与对比投影口径说明用。
    /// 提取语义不变（插入文本计入正文、w:delText 丢弃）＝「接受全部修订后的终态」。
    pub revisions: bool,
    /// 修订明细（批 3）：作者/时间/文本，按出现序
    pub revision_records: Vec<RevisionRecord>,
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
    open_with_scope(path, false)
}

/// odt（ODF 文本文档）：读 content.xml 的 text:p/text:h 段落（批 2，quick-xml
/// 管线复用）；无修订语义（ODF 变更跟踪不解析），revisions 恒 false。
pub fn open_odf(path: &str) -> Result<Document> {
    let mut zip = package(path)?;
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut in_paragraph = false;
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
                    let n: usize = attr(&e, "text:c")?
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(1)
                        .min(1000);
                    for _ in 0..n {
                        current.push(' ');
                    }
                }
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
        revision_records: Vec::new(),
    })
}

/// 扩围开关（批 3，默认关）：正文之外追加页眉/页脚（word/headerN.xml、
/// word/footerN.xml）、脚注（word/footnotes.xml）、批注（word/comments.xml）
/// 段落作为投影附加段（◇ 分节头行区分）；w:pStyle Heading1-9 作行前缀（H1…H9）。
/// 关闭时与批 1/2 投影逐字节一致（缓存失效语义依赖）。
pub fn open_with_scope(path: &str, extended: bool) -> Result<Document> {
    let is_odf = std::path::Path::new(path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("odt"));
    if is_odf {
        return open_odf(path);
    }
    let mut zip = package(path)?;
    // 标题前缀随扩围开关（默认关=批 1 投影逐字节不变；开=H1…H9 前缀参与 diff）
    let mut doc = parse_body(&mut zip, extended)?;
    if extended {
        append_scoped(&mut zip, &mut doc)?;
    }
    Ok(doc)
}

fn parse_body(zip: &mut Package, with_headings: bool) -> Result<Document> {
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut in_text = false;
    let mut in_row = false;
    let mut first_cell = true;
    let mut cell_paragraphs = 0;
    let mut bytes = 0;
    let mut revisions = false;
    let mut revision_records: Vec<RevisionRecord> = Vec::new();
    // 修订采集：当前修订元素（ins/del）深度与文本累计（嵌套修订按最外层归类）
    let mut rev_depth: usize = 0;
    let mut in_del_text = false;
    let mut heading = String::new();
    let mut in_p = false;
    xml(zip, "word/document.xml", 32 * 1024 * 1024, |event| {
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
                "p" => {
                    in_p = true;
                    heading.clear();
                    if in_row {
                        if cell_paragraphs > 0 {
                            current.push('\n');
                        }
                        cell_paragraphs += 1;
                    }
                }
                "pStyle" => {
                    if with_headings
                        && in_p
                        && let Some(v) = attr_local(&e, "val")?
                        && v.len() == 8
                        && v.starts_with("Heading")
                        && v.as_bytes()[7].is_ascii_digit()
                    {
                        heading = v[7..].to_string();
                    }
                }
                "t" => in_text = true,
                "delText" => in_del_text = true,
                // 修订标记（批 1 对比投影）：出现即置位；批 3 起并行采集明细。
                // expand_empty_elements 下自闭合 ins/del 也产出 Start+End 对，
                // 深度计数自然平衡。
                "ins" | "del" => {
                    revisions = true;
                    revision_records.push(RevisionRecord {
                        kind: e.local_name().as_ref().to_string(),
                        author: attr_local(&e, "author")?.unwrap_or_default(),
                        date: attr_local(&e, "date")?.unwrap_or_default(),
                        text: String::new(),
                    });
                    rev_depth += 1;
                }
                "tab" => current.push('\t'),
                "br" | "cr" => current.push('\n'),
                _ => {}
            },
            Event::Text(e) if in_text => {
                let text = quick_xml::escape::unescape(e.as_ref()).map_err(|e| e.to_string())?;
                current.push_str(&text);
                if rev_depth > 0
                    && let Some(last) = revision_records.last_mut()
                {
                    last.text.push_str(&text);
                }
            }
            // del 修订文本：正文不计（终态口径），修订明细计入（审阅通道）
            Event::Text(e) if in_del_text => {
                let text = quick_xml::escape::unescape(e.as_ref()).map_err(|e| e.to_string())?;
                if rev_depth > 0
                    && let Some(last) = revision_records.last_mut()
                {
                    last.text.push_str(&text);
                }
            }
            Event::GeneralRef(e) if in_text => {
                let text = crate::ooxml::resolve_ref(e.as_ref())?;
                current.push_str(&text);
                if rev_depth > 0
                    && let Some(last) = revision_records.last_mut()
                {
                    last.text.push_str(&text);
                }
            }
            Event::CData(e) if in_text => {
                let text = e.as_ref();
                current.push_str(text);
                if rev_depth > 0
                    && let Some(last) = revision_records.last_mut()
                {
                    last.text.push_str(text);
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                "t" => in_text = false,
                "delText" => in_del_text = false,
                "p" if !in_row => {
                    in_p = false;
                    let line = if heading.is_empty() {
                        std::mem::take(&mut current)
                    } else {
                        format!("H{heading} {}", std::mem::take(&mut current))
                    };
                    push_line(&mut lines, &mut bytes, line)?;
                }
                "p" => {
                    in_p = false;
                    // 表格单元格段落不独立成行（批 1 口径：单元格内段落以
                    // 换行连接，整行文本在 End(tr) 落地）
                }
                "ins" | "del" => rev_depth = rev_depth.saturating_sub(1),
                "tr" => {
                    in_row = false;
                    let line = std::mem::take(&mut current);
                    push_line(&mut lines, &mut bytes, line)?;
                }
                _ => {}
            },
            _ => {}
        }
        if revision_records.len() > REVISION_LIMIT {
            return Err("DOCX_REVISION_LIMIT:10000".into());
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
        revision_records,
    })
}

fn push_line(lines: &mut Vec<String>, bytes: &mut usize, line: String) -> Result<()> {
    *bytes += line.len() + std::mem::size_of::<String>();
    if *bytes > TEXT_LIMIT {
        return Err("OOXML_TEXT_LIMIT:10MiB".into());
    }
    lines.push(line);
    Ok(())
}

/// 扩围附加段：页眉/页脚/脚注/批注（各以 ◇ 分节头行起始，段落口径同正文）
fn append_scoped(zip: &mut Package, doc: &mut Document) -> Result<()> {
    let mut names: Vec<(String, &'static str)> = Vec::new();
    for name in zip.file_names() {
        let name = name.map_err(|e| e.to_string())?;
        let label = if name.starts_with("word/header") && name.ends_with(".xml") {
            "页眉"
        } else if name.starts_with("word/footer") && name.ends_with(".xml") {
            "页脚"
        } else if name == "word/footnotes.xml" {
            "脚注"
        } else if name == "word/comments.xml" {
            "批注"
        } else {
            continue;
        };
        if names.len() >= 32 {
            return Err("DOCX_SCOPE_LIMIT:32".into());
        }
        names.push((name.to_string(), label));
    }
    // 分节顺序：页眉 → 页脚 → 脚注 → 批注（文档语义序，同组内按名稳定排序）
    let rank = |l: &str| match l {
        "页眉" => 0,
        "页脚" => 1,
        "脚注" => 2,
        _ => 3,
    };
    names.sort_by(|a, b| (rank(a.1), &a.0).cmp(&(rank(b.1), &b.0)));
    let mut bytes: usize = doc.lines.iter().map(|l| l.len()).sum();
    for (name, label) in names {
        let head = format!("\u{25C7} {label}: {name}");
        push_line(&mut doc.lines, &mut bytes, head)?;
        let mut current = String::new();
        let mut in_text = false;
        let mut started = false;
        xml(zip, &name, 16 * 1024 * 1024, |event| {
            match event {
                Event::Start(e) | Event::Empty(e) => match e.local_name().as_ref() {
                    "p" => {
                        if started {
                            let line = std::mem::take(&mut current);
                            push_line(&mut doc.lines, &mut bytes, line)?;
                        }
                        started = true;
                    }
                    "t" => in_text = true,
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
                Event::End(e) if e.local_name().as_ref() == "t" => in_text = false,
                _ => {}
            }
            if bytes + current.len() > TEXT_LIMIT {
                return Err("OOXML_TEXT_LIMIT:10MiB".into());
            }
            Ok(())
        })?;
        if started && !current.is_empty() {
            push_line(&mut doc.lines, &mut bytes, std::mem::take(&mut current))?;
        }
    }
    doc.total_chars = doc.lines.iter().map(|s| s.chars().count()).sum();
    Ok(())
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
    fn revision_records_carry_author_date_and_text() {
        // 批 3：ins/del 明细（作者/时间/文本按出现序）；主提取口径不变（终态）
        let p = fixture(
            &[(
                "word/document.xml",
                "<w:document xmlns:w='w'><w:p><w:ins w:author='张三' w:date='2026-11-01T10:00:00Z'><w:r><w:t>新增</w:t></w:r></w:ins><w:del w:author='李四' w:date='2026-11-02T11:00:00Z'><w:r><w:delText>旧文</w:delText></w:r></w:del></w:p></w:document>",
            )],
            "rev-detail.docx",
        );
        let doc = open(&p).unwrap();
        assert_eq!(doc.lines, ["新增"]);
        assert!(doc.revisions);
        assert_eq!(
            doc.revision_records,
            vec![
                RevisionRecord {
                    kind: "ins".into(),
                    author: "张三".into(),
                    date: "2026-11-01T10:00:00Z".into(),
                    text: "新增".into()
                },
                RevisionRecord {
                    kind: "del".into(),
                    author: "李四".into(),
                    date: "2026-11-02T11:00:00Z".into(),
                    text: "旧文".into()
                },
            ]
        );
        // delText 不进正文，但也不进修订文本（修订文本只取修订元素内 w:t；del 通道
        // 的 delText 主提取丢弃——批 1 口径；del 明细文本经 delText 计入由下方专测）
    }
    #[test]
    fn del_revision_text_via_deltext() {
        // del 明细文本应取 w:delText（修订删除的内容才是审阅要看的）；正文不含
        let p = fixture(
            &[(
                "word/document.xml",
                "<w:document xmlns:w='w'><w:p><w:del w:author='a' w:date='d'><w:r><w:delText>删除内容</w:delText></w:r></w:del></w:p></w:document>",
            )],
            "rev-del.docx",
        );
        let doc = open(&p).unwrap();
        assert_eq!(doc.lines, [""]);
        assert_eq!(doc.revision_records[0].text, "删除内容");
    }
    #[test]
    fn heading_prefix_and_extended_scope() {
        // 扩围（默认关）：关=与批 1 投影逐字节一致；开=H 前缀 + ◇ 附加段
        let doc_xml = "<w:document xmlns:w='w'><w:p><w:pPr><w:pStyle w:val='Heading1'/></w:pPr><w:r><w:t>标题一</w:t></w:r></w:p><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:document>";
        let p = fixture(
            &[
                ("word/document.xml", doc_xml),
                (
                    "word/header1.xml",
                    "<w:hdr xmlns:w='w'><w:p><w:r><w:t>页眉文字</w:t></w:r></w:p></w:hdr>",
                ),
                (
                    "word/comments.xml",
                    "<w:comments xmlns:w='w'><w:comment><w:p><w:r><w:t>批注一句</w:t></w:r></w:p></w:comment></w:comments>",
                ),
            ],
            "scope.docx",
        );
        let plain = open(&p).unwrap();
        assert_eq!(plain.lines, ["标题一", "正文"], "默认关：批 1 口径不变");
        let ext = open_with_scope(&p, true).unwrap();
        assert_eq!(
            ext.lines,
            [
                "H1 标题一",
                "正文",
                "\u{25C7} 页眉: word/header1.xml",
                "页眉文字",
                "\u{25C7} 批注: word/comments.xml",
                "批注一句",
            ]
        );
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
        assert!(doc.revision_records.is_empty());
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
