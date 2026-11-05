//! Minimal offline PDF text-object reader; deliberately not a layout/font engine.
use super::{PackageReader, Result, TEXT_LIMIT, WINDOW_BYTES, docx::Document};
use std::io::{BufRead, BufReader, Read};

fn byte(r: &mut impl Read) -> Result<Option<u8>> {
    let mut b = [0];
    r.read(&mut b)
        .map(|n| (n != 0).then_some(b[0]))
        .map_err(|e| e.to_string())
}
fn peek(r: &mut impl BufRead) -> Result<Option<u8>> {
    Ok(r.fill_buf().map_err(|e| e.to_string())?.first().copied())
}
fn delimiter(b: u8) -> bool {
    b.is_ascii_whitespace() || b"()<>[]{}/%".contains(&b)
}
enum Token {
    Word(Vec<u8>),
    Text(Vec<u8>),
}
fn token(r: &mut impl BufRead) -> Result<Option<Token>> {
    let first = loop {
        let Some(b) = byte(r)? else { return Ok(None) };
        if b == b'%' {
            while let Some(c) = byte(r)? {
                if c == b'\n' || c == b'\r' {
                    break;
                }
            }
        } else if !b.is_ascii_whitespace() {
            break b;
        }
    };
    let mut out = Vec::new();
    if first == b'(' {
        let mut depth = 1;
        while depth > 0 {
            let b = byte(r)?.ok_or("PDF_UNTERMINATED_STRING")?;
            match b {
                b'\\' => {
                    let c = byte(r)?.ok_or("PDF_UNTERMINATED_ESCAPE")?;
                    match c {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'\n' => {}
                        b'\r' => {
                            if peek(r)? == Some(b'\n') {
                                byte(r)?;
                            }
                        }
                        b'0'..=b'7' => {
                            let mut n = u16::from(c - b'0');
                            for _ in 0..2 {
                                if let Some(d @ b'0'..=b'7') = peek(r)? {
                                    byte(r)?;
                                    n = n * 8 + u16::from(d - b'0');
                                } else {
                                    break;
                                }
                            }
                            out.push(n as u8);
                        }
                        _ => out.push(c),
                    }
                }
                b'(' => {
                    depth += 1;
                    out.push(b);
                }
                b')' => {
                    depth -= 1;
                    if depth > 0 {
                        out.push(b);
                    }
                }
                _ => out.push(b),
            }
            if out.len() > WINDOW_BYTES || depth > 128 {
                return Err("PDF_TOKEN_LIMIT".into());
            }
        }
        return Ok(Some(Token::Text(out)));
    }
    if first == b'<' && peek(r)? != Some(b'<') {
        let mut high = None;
        loop {
            let b = byte(r)?.ok_or("PDF_UNTERMINATED_HEX")?;
            if b == b'>' {
                break;
            }
            if b.is_ascii_whitespace() {
                continue;
            }
            let n = (b as char).to_digit(16).ok_or("PDF_INVALID_HEX")? as u8;
            if let Some(h) = high.take() {
                out.push(h * 16 + n);
            } else {
                high = Some(n);
            }
            if out.len() > WINDOW_BYTES {
                return Err("PDF_TOKEN_LIMIT".into());
            }
        }
        if let Some(h) = high {
            out.push(h * 16);
        }
        return Ok(Some(Token::Text(out)));
    }
    out.push(first);
    // Names must retain '/', so /BT and literal strings cannot act as operators.
    if !delimiter(first) || first == b'/' {
        while let Some(b) = peek(r)? {
            if delimiter(b) {
                break;
            }
            out.push(byte(r)?.unwrap());
            if out.len() > WINDOW_BYTES {
                return Err("PDF_TOKEN_LIMIT".into());
            }
        }
    } else if matches!(first, b'<' | b'>') && peek(r)? == Some(first) {
        out.push(byte(r)?.unwrap());
    }
    Ok(Some(Token::Word(out)))
}
fn decode(bytes: &[u8]) -> Result<String> {
    if bytes.starts_with(&[0xfe, 0xff]) {
        if !bytes.len().is_multiple_of(2) {
            return Err("PDF_INVALID_UTF16".into());
        }
        String::from_utf16(
            &bytes[2..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_be_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
        .map_err(|e| e.to_string())
    } else {
        // Basic one-byte text only; no guessed custom font encodings.
        Ok(bytes.iter().map(|&b| char::from(b)).collect())
    }
}
fn extract(mut r: impl BufRead) -> Result<Document> {
    let mut header = [0; 5];
    r.read_exact(&mut header).map_err(|e| e.to_string())?;
    if &header != b"%PDF-" {
        return Err("PDF_INVALID_HEADER".into());
    }
    let (mut stream, mut text) = (false, false);
    let mut depth = 0usize;
    let mut dictionary = Vec::new();
    let mut pending = String::new();
    let mut output = String::new();
    while let Some(t) = token(&mut r)? {
        match t {
            Token::Text(b) if text => pending.push_str(&decode(&b)?),
            Token::Word(w) => {
                if w == b"<<" {
                    if depth == 0 {
                        dictionary.clear();
                    }
                    depth += 1;
                } else if w == b">>" {
                    depth = depth.saturating_sub(1);
                } else if depth == 1 {
                    if dictionary.len() >= 4096 {
                        return Err("PDF_DICTIONARY_LIMIT".into());
                    }
                    dictionary.push(w.clone());
                }
                match w.as_slice() {
                    b"/Encrypt" => {
                        return Err(
                            "PDF_UNSUPPORTED:compressed or encrypted PDF; use system viewer".into(),
                        );
                    }
                    b"stream" => {
                        let image = dictionary
                            .windows(2)
                            .any(|p| p[0] == b"/Subtype" && p[1] == b"/Image");
                        let filtered = dictionary
                            .windows(2)
                            .any(|p| p[0] == b"/Filter" && p[1] != b"/Identity" && p[1] != b"null");
                        if image {
                            // Binary image bytes are not PDF tokens. Skip without allocating the stream.
                            let marker = b"endstream";
                            let mut window = [0u8; 9];
                            loop {
                                let b = byte(&mut r)?.ok_or("PDF_UNTERMINATED_STREAM")?;
                                window.rotate_left(1);
                                window[8] = b;
                                if &window == marker {
                                    break;
                                }
                            }
                        } else if filtered {
                            return Err(
                                "PDF_UNSUPPORTED:compressed text stream; use system viewer".into(),
                            );
                        } else {
                            stream = true;
                        }
                        dictionary.clear();
                    }
                    b"obj" | b"endobj" => dictionary.clear(),
                    b"endstream" => {
                        if text {
                            return Err("PDF_UNTERMINATED_TEXT".into());
                        }
                        stream = false;
                    }
                    b"BT" if stream => {
                        text = true;
                        pending.clear();
                    }
                    b"ET" if text => {
                        text = false;
                        pending.clear();
                        if !output.ends_with('\n') {
                            output.push('\n');
                        }
                    }
                    b"Tj" | b"TJ" if text => {
                        output.push_str(&pending);
                        pending.clear();
                    }
                    b"Td" | b"TD" | b"T*" if text => {
                        pending.clear();
                        if !output.ends_with('\n') {
                            output.push('\n');
                        }
                    }
                    b"[" | b"]" => {}
                    _ if text
                        && std::str::from_utf8(&w)
                            .ok()
                            .and_then(|s| s.parse::<f64>().ok())
                            .is_none() =>
                    {
                        pending.clear();
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        if output.len() + pending.len() > TEXT_LIMIT {
            return Err("PDF_TEXT_LIMIT:10MiB".into());
        }
    }
    if stream || text {
        return Err("PDF_UNTERMINATED_STREAM".into());
    }
    if output.trim().is_empty() {
        return Err("PDF_NO_TEXT:scanned or unsupported PDF".into());
    }
    if output.len() + output.lines().count() * std::mem::size_of::<String>() > TEXT_LIMIT {
        return Err("PDF_TEXT_LIMIT:10MiB".into());
    }
    let lines: Vec<String> = output.lines().map(str::to_owned).collect();
    if lines.iter().any(|s| s.len() > WINDOW_BYTES) {
        return Err("PDF_LINE_LIMIT:4MiB".into());
    }
    let total_chars = lines.iter().map(|s| s.chars().count()).sum();
    Ok(Document { lines, total_chars })
}
pub fn open(path: &str) -> Result<Document> {
    extract(BufReader::with_capacity(
        crate::file_engine::CHUNK,
        PackageReader::open(path)?,
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_array_hex_and_escapes() {
        let bytes = b"%PDF-1.4\n1 0 obj << /Length 100 >> stream\nBT (Hello\\040PDF) Tj T* [(A) -20 (B\\(C\\))] TJ T* <FEFF4E2D6587> Tj ET\nendstream endobj %%EOF";
        assert_eq!(
            extract(&bytes[..]).unwrap().lines,
            ["Hello PDF", "AB(C)", "中文"]
        );
    }
    #[test]
    fn unsupported_and_malformed_are_explicit() {
        for bytes in [
            b"%PDF-1.4 /Filter /FlateDecode".as_slice(),
            b"%PDF-1.4 /Encrypt 1 0 R",
            b"%PDF-1.4 stream BT (broken",
            b"%PDF-1.4 %%EOF",
        ] {
            assert!(extract(bytes).is_err());
        }
    }
    #[test]
    fn image_filter_does_not_reject_plain_text() {
        let bytes = b"%PDF-1.4\n1 0 obj << /Type /Page /Filter /FlateDecode >> endobj\n2 0 obj << /Subtype /Image /Filter /DCTDecode >> stream\n\xff\xd8(binary < not a token)\xff\xd9\nendstream endobj\n3 0 obj << /Length 30 >> stream\nBT (Readable text) Tj ET\nendstream endobj";
        assert_eq!(extract(&bytes[..]).unwrap().lines, ["Readable text"]);
        let compressed = b"%PDF-1.4\n1 0 obj << /Filter /FlateDecode >> stream\nbinary\nendstream";
        assert!(
            extract(&compressed[..])
                .err()
                .unwrap()
                .contains("PDF_UNSUPPORTED")
        );
    }
    #[test]
    fn text_limit_is_bounded() {
        let mut bytes = b"%PDF-1.4 stream BT ".to_vec();
        for _ in 0..12 {
            bytes.extend_from_slice(format!("({}) Tj ", "x".repeat(1024 * 1024)).as_bytes());
        }
        assert!(
            extract(bytes.as_slice())
                .err()
                .unwrap()
                .contains("TEXT_LIMIT")
        );
    }
    #[test]
    fn chunk_reader_and_package_limit() {
        use std::io::Write;
        let path =
            std::env::temp_dir().join(format!("ZiEdit-pdf-chunks-{}.pdf", std::process::id()));
        let mut file = std::fs::File::create(&path).unwrap();
        let text = "x".repeat(crate::file_engine::CHUNK + 10);
        write!(file, "%PDF-1.4\nstream\nBT ({text}) Tj ET\nendstream").unwrap();
        drop(file);
        assert_eq!(open(path.to_str().unwrap()).unwrap().lines, [text]);
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(100 * 1024 * 1024 + 1).unwrap();
        drop(file);
        assert!(
            open(path.to_str().unwrap())
                .err()
                .unwrap()
                .contains("PACKAGE_LIMIT")
        );
        std::fs::remove_file(path).unwrap();
    }
}
