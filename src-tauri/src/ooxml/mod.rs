//! Bounded, offline OOXML extraction. ZIP reads use the file engine's chunk cache.
pub mod docx;
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
pub fn attr(e: &quick_xml::events::BytesStart<'_>, key: &[u8]) -> Result<Option<String>> {
    for a in e.attributes() {
        let a = a.map_err(|e| e.to_string())?;
        if a.key.as_ref() == key {
            return a
                .unescape_value()
                .map(|s| Some(s.into_owned()))
                .map_err(|e| e.to_string());
        }
    }
    Ok(None)
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
