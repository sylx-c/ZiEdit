//! Bounded, offline OOXML extraction. ZIP reads use the file engine's chunk cache.
pub mod docx;
pub mod ods;
pub mod pdf;
pub mod xlsx;

use crate::file_engine::{CHUNK, ChunkCache};
use quick_xml::{Reader, events::Event};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

pub const TEXT_LIMIT: usize = 10 * 1024 * 1024;
pub const WINDOW_BYTES: usize = 4 * 1024 * 1024;
pub type Result<T> = std::result::Result<T, String>;

pub struct PackageReader {
    cache: ChunkCache,
    position: u64,
}
impl PackageReader {
    pub fn open(path: &str) -> Result<Self> {
        let cache = ChunkCache::open(Path::new(path)).map_err(|e| e.to_string())?;
        if cache.len() > 100 * 1024 * 1024 {
            return Err("PACKAGE_LIMIT:100MiB".into());
        }
        Ok(Self { cache, position: 0 })
    }
}
impl Read for PackageReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.position >= self.cache.len() || out.is_empty() {
            return Ok(0);
        }
        let block = self.cache.read_chunk(self.position / CHUNK as u64)?;
        let offset = self.position as usize % CHUNK;
        let n = out.len().min(block.len() - offset);
        out[..n].copy_from_slice(&block[offset..offset + n]);
        self.position += n as u64;
        Ok(n)
    }
}
impl Seek for PackageReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let next = match pos {
            SeekFrom::Start(n) => i128::from(n),
            SeekFrom::End(n) => i128::from(self.cache.len()) + i128::from(n),
            SeekFrom::Current(n) => i128::from(self.position) + i128::from(n),
        };
        self.position =
            u64::try_from(next).map_err(|_| std::io::Error::other("invalid ZIP seek"))?;
        Ok(self.position)
    }
}
pub type Package = zip::ZipArchive<PackageReader>;
pub fn package(path: &str) -> Result<Package> {
    let cache = ChunkCache::open(Path::new(path)).map_err(|e| e.to_string())?;
    if cache.len() > 100 * 1024 * 1024 {
        return Err("OOXML_PACKAGE_LIMIT:100MiB".into());
    }
    zip::ZipArchive::new(PackageReader { cache, position: 0 }).map_err(|e| e.to_string())
}

pub fn xml(
    zip: &mut Package,
    name: &str,
    limit: u64,
    mut visit: impl FnMut(Event<'_>) -> Result<()>,
) -> Result<()> {
    let entry = zip
        .by_name(name)
        .map_err(|e| format!("OOXML_ENTRY:{name}: {e}"))?;
    if entry.size() > limit {
        return Err(format!("OOXML_XML_LIMIT:{name}"));
    }
    let mut reader = Reader::from_reader(BufReader::with_capacity(CHUNK, entry.take(limit + 1)));
    reader.config_mut().expand_empty_elements = true;
    let mut buf = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buf)
            .map_err(|e| format!("OOXML_XML:{e}"))?;
        if matches!(event, Event::Eof) {
            break;
        }
        if matches!(event, Event::DocType(_)) {
            return Err("OOXML_DTD_UNSUPPORTED".into());
        }
        visit(event)?;
        buf.clear();
    }
    Ok(())
}
pub fn attr(e: &quick_xml::events::BytesStart<'_>, key: &str) -> Result<Option<String>> {
    for a in e.attributes() {
        let a = a.map_err(|e| e.to_string())?;
        if a.key.as_ref() == key {
            return a
                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .map(|s| Some(s.into_owned()))
                .map_err(|e| e.to_string());
        }
    }
    Ok(None)
}

/// quick-xml 0.42 起 Reader 把实体引用拆成独立的 `Event::GeneralRef`（内容为 `&` 与 `;` 之间的名称），
/// 文本回调必须显式解码，否则 `&amp;` 等实体会被静默丢弃。命名实体走预定义解析器，
/// 数字引用（`#N` / `#xH`）按码位还原；未定义实体有界报错，不猜测。
pub fn resolve_ref(name: &str) -> Result<String> {
    if let Some(text) = quick_xml::escape::resolve_xml_entity(name) {
        return Ok(text.to_owned());
    }
    let code = name.strip_prefix('#').ok_or("OOXML_UNKNOWN_ENTITY")?;
    let code_point = if let Some(hex) = code.strip_prefix('x').or_else(|| code.strip_prefix('X')) {
        u32::from_str_radix(hex, 16).map_err(|_| "OOXML_UNKNOWN_ENTITY")?
    } else {
        code.parse::<u32>().map_err(|_| "OOXML_UNKNOWN_ENTITY")?
    };
    char::from_u32(code_point)
        .map(|c| c.to_string())
        .ok_or("OOXML_UNKNOWN_ENTITY".into())
}
/// WPS 私有格式哨兵（批 4）：.wps/.et/.dps 扩展但容器非 ZIP（OLE/私有二进制）
/// → 显式「另存为」指引（WPS 打开 → 另存为 docx/xlsx/pptx），不猜测解析、
/// 不静默。PK 头（实为 OOXML/ODF 包，WPS 新格式或改名文件）照常走对应管线。
pub fn reject_legacy_wps(path: &str) -> Result<()> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !matches!(ext.as_str(), "wps" | "et" | "dps") {
        return Ok(());
    }
    use std::io::Read as _;
    let mut head = [0u8; 2];
    let read = std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head).map(|()| 2usize))
        .unwrap_or(0);
    if read == 2 && &head != b"PK" {
        return Err("WPS_LEGACY_PACKAGE:请用 WPS 打开后另存为 docx/xlsx/pptx 再试".into());
    }
    Ok(())
}

pub fn window(from: u64, to: u64) -> Result<std::ops::Range<usize>> {
    if from == 0 || to < from {
        return Err("OOXML_WINDOW:1-based, to >= from".into());
    }
    Ok(usize::try_from(from - 1).map_err(|e| e.to_string())?
        ..usize::try_from(to.min(from.saturating_add(4999))).map_err(|e| e.to_string())?)
}

#[cfg(test)]
pub fn fixture(entries: &[(&str, &str)], name: &str) -> String {
    use std::io::Write;
    let dir = std::env::temp_dir().join(format!("ZiEdit-ooxml-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    for (name, text) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(text.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 批 4：WPS 私有容器哨兵——.wps/.et/.dps 非 ZIP → 显式另存为指引；
    /// PK 头（OOXML/ODF 内容）与其它扩展不受影响。
    #[test]
    fn legacy_wps_package_rejected_with_guidance() {
        let dir = std::env::temp_dir().join("ZiEdit-wps-sniff");
        std::fs::create_dir_all(&dir).unwrap();
        let ole = dir.join("old.wps");
        std::fs::write(&ole, [0xD0u8, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]).unwrap();
        let err = reject_legacy_wps(ole.to_str().unwrap()).err().unwrap();
        assert!(err.starts_with("WPS_LEGACY_PACKAGE:"), "{err}");
        assert!(err.contains("另存为"));
        // PK 头的 .wps（OOXML/ODF 内容）：放行走对应管线
        let pk = dir.join("new.et");
        std::fs::write(&pk, b"PK\x03\x04 rest").unwrap();
        assert!(reject_legacy_wps(pk.to_str().unwrap()).is_ok());
        // 其它扩展不判
        let doc = dir.join("a.doc");
        std::fs::write(&doc, [0xD0u8, 0xCF]).unwrap();
        assert!(reject_legacy_wps(doc.to_str().unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
