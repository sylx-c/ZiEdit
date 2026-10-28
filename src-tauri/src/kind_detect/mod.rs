//! kind_detect —— 文件类型识别与视图路由（001 子 PRD）
//! 扩展名 → 语言类别映射，数据自研。
//! 有界首部嗅探：ZIP / 连续 NUL / 控制字符占比，UTF-16 豁免占比。

use std::io::Read;
use std::path::Path;

/// 视图路由：文本视图或图片视图
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViewRoute {
    Text,
    Image,
}

/// 识别结果：路由目标 + 语言类别（文本类才有）+ 二进制标记（对比/搜索等按此跳过）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FileKind {
    pub route: ViewRoute,
    pub language: Option<&'static str>,
    #[serde(default)]
    pub binary: bool,
}

/// 内容嗅探窗口：4KB
const SNIFF_LEN: usize = 4 * 1024;
/// 连续 NUL 块判为二进制的阈值（行为基准：64 连续=文本、75 连续=二进制，取 64 为容忍上限）
const NUL_RUN_LIMIT: usize = 64;

/// 扩展名 → 语言（自研映射，覆盖常用子集 + ZiEdit 语言集）
fn language_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "json" | "jsonc" => "JSON",
        "docx" => "Docx",
        "pdf" => "Pdf",
        "xlsx" => "Xlsx",
        "js" | "mjs" | "cjs" | "jsx" => "JavaScript",
        "ts" | "tsx" => "TypeScript",
        "md" | "markdown" => "Markdown",
        "yml" | "yaml" => "YAML",
        "xml" | "xsl" | "xslt" | "svg" | "plist" => "XML",
        "html" | "htm" => "HTML",
        "css" => "CSS",
        "c" | "h" => "C",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" => "C++",
        "py" | "pyw" => "Python",
        "rs" => "Rust",
        "go" => "Go",
        "java" => "Java",
        "sql" => "SQL",
        "sh" | "bash" | "zsh" => "Shell",
        "bat" | "cmd" => "Batch",
        "ps1" | "psm1" => "PowerShell",
        "ini" | "toml" | "cfg" | "conf" | "properties" => "Config",
        "csv" => "CSV",
        "tsv" => "TSV",
        "txt" | "text" => "Text",
        "log" => "Log",
        _ => return None,
    })
}

/// 图片扩展名（批 D-1：路由 ImageView；svg 可经视图菜单切回文本/XML）
fn is_image_ext(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg")
}

/// 已知二进制扩展名（免嗅探直接标记 binary）
fn is_binary_ext(ext: &str) -> bool {
    matches!(
        ext,
        "exe"
            | "dll"
            | "so"
            | "dylib"
            | "ocx"
            | "sys"
            | "pdb"
            | "obj"
            | "lib"
            | "a"
            | "zip"
            | "gz"
            | "bz2"
            | "xz"
            | "7z"
            | "rar"
            | "tar"
            | "cab"
            | "iso"
            | "img"
            | "ico"
            | "tif"
            | "tiff"
            | "mp3"
            | "mp4"
            | "avi"
            | "mkv"
            | "wmv"
            | "flac"
            | "ogg"
            | "wav"
            | "doc"
            | "xls"
            | "ppt"
            | "pptx"
            | "jar"
            | "class"
            | "wasm"
            | "o"
            | "bin"
            | "ttf"
            | "otf"
            | "woff"
            | "woff2"
    )
}

/// 快速识别（仅扩展名，目录列表用，不做 I/O）
pub fn detect_fast(path: &Path) -> FileKind {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if is_image_ext(&ext) {
        // svg 保留 XML 语言：经视图菜单切文本视图时仍有语法高亮
        return FileKind {
            route: ViewRoute::Image,
            language: if ext == "svg" { Some("XML") } else { None },
            binary: false,
        };
    }
    if let Some(lang) = language_of(&ext) {
        return FileKind {
            route: ViewRoute::Text,
            language: Some(lang),
            binary: false,
        };
    }
    if is_binary_ext(&ext) {
        return FileKind {
            route: ViewRoute::Text,
            language: None,
            binary: true,
        };
    }
    FileKind {
        route: ViewRoute::Text,
        language: None,
        binary: false,
    }
}

/// 完整识别（打开文件时用）：扩展名优先，无扩展名/未知时按内容嗅探。
/// 首 4KB：ZIP 头、连续 NUL >64 或控制字符 >10% 判为二进制（标记 binary，呈现仍走文本面）。
/// 嗅探采样与编码探测共享：encoding 侧先读过文件头（64KB）时零 I/O 命中；
/// 否则此处读 ≤4KB 并回填共享缓存，供随后的 text_open 编码探测复用同一段头部字节。
pub fn detect(path: &Path) -> std::io::Result<FileKind> {
    detect_inner(path, None)
}

/// `key`：调用方已持有探测键时复用（`detect_cached` 免二次 stat）。
fn detect_inner(path: &Path, key: Option<crate::encoding::ProbeKey>) -> std::io::Result<FileKind> {
    let fast = detect_fast(path);
    if matches!(fast.language, Some("Docx" | "Xlsx" | "Pdf")) {
        return Ok(fast);
    }
    match fast.route {
        ViewRoute::Image => Ok(fast),
        ViewRoute::Text => {
            if fast.binary {
                return Ok(fast);
            }
            if fast.language.is_some() {
                // 已知文本扩展名：仍嗅探 NUL 块（"伪文本"文件判为二进制，001-AC-4 兄弟用例）
            }
            let key = match key {
                Some(k) => k,
                None => crate::encoding::probe_key(path)?,
            };
            let sample = crate::encoding::shared_head_sample(&key, SNIFF_LEN, || {
                let mut f = std::fs::File::open(path)?;
                let mut buf = [0u8; SNIFF_LEN];
                let n = f.read(&mut buf)?;
                Ok(buf[..n].to_vec())
            })?;
            let sample = &sample[..sample.len().min(SNIFF_LEN)];
            let utf16 = sample.starts_with(&[0xff, 0xfe])
                || sample.starts_with(&[0xfe, 0xff])
                || crate::encoding::utf16_without_bom(sample).is_some();
            let controls = sample
                .iter()
                .filter(|&&b| matches!(b, 0x00..=0x08 | 0x0e..=0x1f))
                .count();
            if sample.starts_with(b"PK\x03\x04")
                || max_nul_run(sample) > NUL_RUN_LIMIT
                || (!utf16 && controls * 10 > sample.len())
            {
                return Ok(FileKind {
                    route: ViewRoute::Text,
                    language: None,
                    binary: true,
                });
            }
            Ok(fast)
        }
    }
}

/// 连续 NUL 块的最大长度
fn max_nul_run(buf: &[u8]) -> usize {
    buf.iter()
        .fold((0usize, 0usize), |(best, cur), &b| {
            if b == 0 {
                (best.max(cur + 1), cur + 1)
            } else {
                (best, 0)
            }
        })
        .0
}

/// 类型识别缓存：`(path, len, mtime)` LRU（容量 32），
/// 跨文件搜索/目录扫描等高频路径重复识别零 I/O；外部修改自动失效（键含 len+mtime）。
fn kind_cache()
-> &'static std::sync::Mutex<crate::encoding::ProbeLru<crate::encoding::ProbeKey, FileKind>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<crate::encoding::ProbeLru<crate::encoding::ProbeKey, FileKind>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(crate::encoding::ProbeLru::new(32)))
}

/// 完整识别（带进程内缓存）：同内容同判定语义不变
pub fn detect_cached(path: &Path) -> std::io::Result<FileKind> {
    let key = crate::encoding::probe_key(path)?;
    if let Ok(mut cache) = kind_cache().lock()
        && let Some(hit) = cache.get(&key)
    {
        return Ok(hit.clone());
    }
    let kind = detect_inner(path, Some(key.clone()))?;
    if let Ok(mut cache) = kind_cache().lock() {
        cache.put(key, kind.clone());
    }
    Ok(kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn touch(name: &str, content: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("ZiEdit-kind-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content).unwrap();
        p
    }

    #[test]
    fn ext_text() {
        assert_eq!(detect_fast(Path::new("a.jsonc")).language, Some("JSON"));
        for (name, language) in [("a.docx", "Docx"), ("a.xlsx", "Xlsx"), ("a.pdf", "Pdf")] {
            let p = touch(name, &[0; 100]);
            assert_eq!(detect(&p).unwrap().language, Some(language));
            assert_eq!(detect(&p).unwrap().route, ViewRoute::Text);
        }
        let p = touch("a.json", b"{}");
        assert_eq!(detect_fast(&p).language, Some("JSON"));
        assert_eq!(detect_fast(&p).route, ViewRoute::Text);
        let p2 = touch("b.js", b"let x=1");
        assert_eq!(detect_fast(&p2).language, Some("JavaScript"));
    }

    #[test]
    fn ext_binary() {
        let p = touch("c.dll", b"MZ...");
        let k = detect_fast(&p);
        assert_eq!(k.route, ViewRoute::Text); // 二进制扩展名同样走文本面，仅以 binary 标记区分
        assert!(k.binary);
        assert_eq!(k.language, None);
    }

    #[test]
    fn ext_image_routes_image_view() {
        // 批 D-1：png/jpg/gif/webp/bmp/svg 路由 ImageView；svg 保留 XML 语言供文本切换
        for name in [
            "a.png", "b.jpg", "c.jpeg", "d.gif", "e.webp", "f.bmp", "g.svg",
        ] {
            let p = touch(name, b"\x89PNG fake");
            let k = detect(&p).unwrap();
            assert_eq!(k.route, ViewRoute::Image, "{}", name);
        }
        let p = touch("g.svg", b"<svg/>");
        let k = detect(&p).unwrap();
        assert_eq!(k.route, ViewRoute::Image);
        assert_eq!(k.language, Some("XML"));
    }

    #[test]
    fn sniff_single_nul_is_text() {
        // 单 NUL（头/中）占比不超过 10% 按文本打开；更短样本遵循占比新规则。
        let p = touch("noext", b"hello\x00world");
        let k = detect(&p).unwrap();
        assert_eq!(k.route, ViewRoute::Text);
        let p2 = touch("noext2", b"\x00head null");
        let k2 = detect(&p2).unwrap();
        assert_eq!(k2.route, ViewRoute::Text);
    }

    #[test]
    fn sniff_dispersed_nuls_is_text() {
        // 100 个分散 NUL（约 2%）仍判文本
        let mut buf = Vec::new();
        for _ in 0..100 {
            buf.extend_from_slice(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x00");
        }
        let p = touch("noext3", &buf);
        let k = detect(&p).unwrap();
        assert_eq!(k.route, ViewRoute::Text);
    }

    #[test]
    fn sniff_nul_run_boundary() {
        // 边界回归：64 连续=文本、75 连续=二进制（阈值取 >64）
        let base = b"padding line for the sniff test\n".repeat(10);
        let mut b64 = base.clone();
        b64.extend_from_slice(&[0u8; 64]);
        b64.extend_from_slice(&base);
        let p64 = touch("run64", &b64);
        assert_eq!(detect(&p64).unwrap().route, ViewRoute::Text);

        let mut b75 = base;
        b75.extend_from_slice(&[0u8; 75]);
        b75.extend_from_slice(b"tail");
        let p75 = touch("run75", &b75);
        let k75 = detect(&p75).unwrap();
        assert_eq!(k75.route, ViewRoute::Text);
        assert!(k75.binary);

        let mut buf = b"some header text\n".to_vec();
        buf.extend_from_slice(&[0u8; 128]);
        let p = touch("fake.txt", &buf);
        let k = detect(&p).unwrap();
        assert_eq!(k.route, ViewRoute::Text);
        assert!(k.binary); // 伪文本（已知文本扩展名但内容为二进制）
    }

    #[test]
    fn sniff_zip_and_control_ratio() {
        for name in ["container.unknown", "document.odt", "book.epub"] {
            assert!(
                detect(&touch(name, b"PK\x03\x04zip payload"))
                    .unwrap()
                    .binary
            );
        }
        assert_eq!(
            detect(&touch("control-boundary", b"abcdefghi\x01"))
                .unwrap()
                .route,
            ViewRoute::Text
        );
        let k = detect(&touch("control-over", b"abcdefgh\x01\x02")).unwrap();
        assert_eq!(k.route, ViewRoute::Text);
        assert!(k.binary);
        // 非二进制文本显式断言 binary=false
        assert!(!detect(&touch("plain.txt", b"just text")).unwrap().binary);
        assert_eq!(
            detect(&touch("utf8-control", "中文文本\n正常\t显示".as_bytes()))
                .unwrap()
                .route,
            ViewRoute::Text
        );
        for name in ["UTF-16LE", "UTF-16BE"] {
            let bytes = crate::encoding::encode("中文 Hello 123\n世界 sample 456\n", name).unwrap();
            assert_eq!(detect(&touch(name, &bytes)).unwrap().route, ViewRoute::Text);
        }
    }

    /// 探测缓存：命中同判定；外部修改（len/mtime 基线变化）失效重探测
    #[test]
    fn detect_cached_invalidates_on_change() {
        let p = touch("cache-kind", b"plain text here");
        let first = detect_cached(&p).unwrap();
        assert!(!first.binary);
        assert_eq!(detect_cached(&p).unwrap(), first); // 缓存命中
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&p, [b't'; 4096]).unwrap();
        // 写入含大量 NUL 的“伪文本”：len/mtime 变化 → 失效 → 重嗅探判二进制
        let mut zeros = b"header\n".to_vec();
        zeros.extend_from_slice(&[0u8; 128]);
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&p, &zeros).unwrap();
        assert!(detect_cached(&p).unwrap().binary);
    }
}
