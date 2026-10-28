//! 跨文件搜索：后台分块扫描、取消、进度和显式的不完整结果。
use crate::{encoding, file_engine, kind_detect};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use tauri::Emitter;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FifOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FifHit {
    pub line: u64,
    pub col: u64,
    pub text: String,
}
#[derive(Debug, Serialize, Clone)]
pub struct FifFile {
    pub path: String,
    pub hits: Vec<FifHit>,
}
#[derive(Debug, Serialize)]
pub struct FifSkipped {
    pub path: String,
    pub reason: String,
}
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FifResult {
    pub files: Vec<FifFile>,
    pub scanned: usize,
    pub skipped: Vec<FifSkipped>,
    pub skipped_count: usize,
    pub limits: Vec<String>,
    pub cancelled: bool,
}
type Jobs = Mutex<HashMap<String, Arc<AtomicBool>>>;
fn jobs() -> &'static Jobs {
    static JOBS: OnceLock<Jobs> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

fn glob_regex(glob: &str) -> Result<regex::Regex, String> {
    let patterns: Vec<_> = glob
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|p| {
            let mut out = String::from("(?:");
            for ch in p.replace('\\', "/").chars() {
                match ch {
                    '*' => out.push_str(".*"),
                    '?' => out.push('.'),
                    _ => out.push_str(&regex::escape(&ch.to_string())),
                }
            }
            out.push(')');
            out
        })
        .collect();
    let pattern = if patterns.is_empty() {
        ".*".into()
    } else {
        patterns.join("|")
    };
    regex::RegexBuilder::new(&format!("^(?:{pattern})$"))
        .case_insensitive(cfg!(windows))
        .size_limit(1024 * 1024)
        .build()
        .map_err(|e| e.to_string())
}
fn skipped(out: &mut FifResult, path: &Path, reason: impl Into<String>) {
    out.skipped_count += 1;
    if out.skipped.len() < 200 {
        out.skipped.push(FifSkipped {
            path: path.to_string_lossy().into(),
            reason: reason.into(),
        });
    }
}
fn limit(out: &mut FifResult, reason: &str) {
    if !out.limits.iter().any(|x| x == reason) {
        out.limits.push(reason.into());
    }
}

fn search(
    root: &Path,
    needle: &str,
    opts: FifOptions,
    glob: &str,
    max_files: usize,
    cancel: &AtomicBool,
    mut progress: impl FnMut(usize),
) -> Result<FifResult, String> {
    if !root.is_dir() {
        return Err("Search root is not a directory".into());
    }
    let mut out = FifResult::default();
    if needle.is_empty() {
        return Ok(out);
    }
    let re = if opts.regex {
        Some(
            regex::RegexBuilder::new(needle)
                .case_insensitive(!opts.case_sensitive)
                .build()
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };
    let filter = glob_regex(glob)?;
    let mut stack = vec![root.to_path_buf()];
    'scan: while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) => {
                skipped(&mut out, &dir, e.to_string());
                continue;
            }
        };
        for entry in entries {
            if cancel.load(Ordering::Relaxed) {
                break 'scan;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    skipped(&mut out, &dir, e.to_string());
                    continue;
                }
            };
            let p = entry.path();
            let ty = match entry.file_type() {
                Ok(t) => t,
                Err(e) => {
                    skipped(&mut out, &p, e.to_string());
                    continue;
                }
            };
            if ty.is_symlink() {
                skipped(&mut out, &p, "symlink");
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if ty.is_dir() {
                if [
                    "node_modules",
                    ".git",
                    "target",
                    "dist",
                    "EBWebView",
                    "__pycache__",
                    ".venv",
                ]
                .contains(&name.as_str())
                {
                    skipped(&mut out, &p, "excluded-directory");
                } else {
                    stack.push(p);
                }
                continue;
            }
            let relative = p
                .strip_prefix(root)
                .unwrap_or(&p)
                .to_string_lossy()
                .replace('\\', "/");
            if !ty.is_file() || !(filter.is_match(&name) || filter.is_match(&relative)) {
                continue;
            }
            if out.scanned >= 2000 {
                limit(&mut out, "scanned-files:2000");
                break 'scan;
            }
            if out.files.len() >= max_files {
                limit(&mut out, "matching-files:100");
                break 'scan;
            }
            out.scanned += 1;
            progress(out.scanned);
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(e) => {
                    skipped(&mut out, &p, e.to_string());
                    continue;
                }
            };
            if meta.len() > 100 * 1024 * 1024 {
                skipped(&mut out, &p, "size-limit:100MiB");
                continue;
            }
            // 探测缓存：kind/encoding 走 (path,len,mtime) 进程内 LRU，
            // 重复扫描同一项目时探测零 I/O（visit_lines 全文扫描仍是内容主力）
            let kind = match kind_detect::detect_cached(&p) {
                Ok(k) => k,
                Err(e) => {
                    skipped(&mut out, &p, e.to_string());
                    continue;
                }
            };
            // 跳过二进制与图片文件
            if kind.binary || kind.route != kind_detect::ViewRoute::Text {
                skipped(&mut out, &p, "binary");
                continue;
            }
            let enc = match encoding::detect_cached(&p) {
                Ok(e) => e,
                Err(e) => {
                    skipped(&mut out, &p, e.to_string());
                    continue;
                }
            };
            let mut hits = Vec::new();
            let mut hits_limited = false;
            let read = file_engine::visit_lines(&p, &enc.name, 100 * 1024 * 1024, |no, line| {
                if cancel.load(Ordering::Relaxed) {
                    return false;
                }
                let cols = crate::commands::text::find_all_in(
                    line,
                    re.as_ref(),
                    needle,
                    opts.case_sensitive,
                    opts.whole_word,
                );
                if let Some(col) = cols.first() {
                    if hits.len() == 50 {
                        hits_limited = true;
                        return false;
                    }
                    hits.push(FifHit {
                        line: no,
                        col: line[..*col].chars().count() as u64 + 1,
                        text: line.chars().take(200).collect(),
                    });
                }
                true
            });
            if let Err(e) = read {
                skipped(&mut out, &p, e);
            }
            if hits_limited {
                limit(&mut out, "hits-per-file:50");
            }
            if !hits.is_empty() {
                out.files.push(FifFile {
                    path: p.to_string_lossy().into(),
                    hits,
                });
            }
        }
    }
    out.cancelled = cancel.load(Ordering::Relaxed);
    Ok(out)
}

#[tauri::command]
pub async fn find_in_files(
    app: tauri::AppHandle,
    root: String,
    needle: String,
    opts: FifOptions,
    max_files: Option<usize>,
    job_id: String,
    glob: Option<String>,
) -> Result<FifResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut registry = jobs().lock().map_err(|e| e.to_string())?;
        if registry.len() >= 4 || registry.contains_key(&job_id) {
            return Err("Search already running or job limit reached".into());
        }
        registry.insert(job_id.clone(), cancel.clone());
    }
    let id = job_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut last = Instant::now() - Duration::from_secs(1);
        search(
            &PathBuf::from(root),
            &needle,
            opts,
            glob.as_deref().unwrap_or("*"),
            max_files.unwrap_or(100).clamp(1, 100),
            &cancel,
            |scanned| {
                if last.elapsed() >= Duration::from_millis(100) {
                    let _ = app.emit(
                        "find-progress",
                        serde_json::json!({ "jobId": id, "scanned": scanned }),
                    );
                    last = Instant::now();
                }
            },
        )
    })
    .await
    .map_err(|e| e.to_string());
    jobs().lock().map_err(|e| e.to_string())?.remove(&job_id);
    result?
}
#[tauri::command]
pub fn find_cancel(job_id: String) -> Result<(), String> {
    if let Some(cancel) = jobs().lock().map_err(|e| e.to_string())?.get(&job_id) {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encoding_filter_limits_and_cancellation() {
        let root = std::env::temp_dir().join(format!("ZiEdit-search-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let utf16: Vec<_> = [0xff, 0xfe]
            .into_iter()
            .chain(
                "cat\r\nconcatenate\r\nCAT"
                    .encode_utf16()
                    .flat_map(u16::to_le_bytes),
            )
            .collect();
        std::fs::write(root.join("utf16.txt"), utf16).unwrap();
        std::fs::write(root.join("plain.log"), "cat\n".repeat(60)).unwrap();
        std::fs::write(root.join("binary.dll"), b"cat").unwrap();
        let cancel = AtomicBool::new(false);
        let options = || FifOptions {
            case_sensitive: false,
            whole_word: true,
            regex: true,
        };
        let result = search(&root, "cat", options(), "*.txt;*.log", 100, &cancel, |_| {}).unwrap();
        assert_eq!(result.files.len(), 2);
        assert!(result.limits.contains(&"hits-per-file:50".into()));
        let utf16 = result
            .files
            .iter()
            .find(|f| f.path.ends_with("utf16.txt"))
            .unwrap();
        assert_eq!(
            utf16.hits.iter().map(|h| h.line).collect::<Vec<_>>(),
            vec![1, 3]
        );
        let result = search(&root, "cat", options(), "*", 100, &cancel, |_| {}).unwrap();
        assert!(result.skipped.iter().any(|s| s.reason == "binary"));
        let result = search(&root, "cat", options(), "*", 100, &cancel, |_| {
            cancel.store(true, Ordering::Relaxed)
        })
        .unwrap();
        assert!(result.cancelled);
        assert!(result.scanned <= 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// W2 清偿（006-FIF/OUT，AC-7）：逐文件按编码搜索（GBK）、跨 64KB 分块流式扫描、
    /// 文件名与相对路径双口径通配（`*` 前缀目录段 / `?` 单字符）。
    #[test]
    fn gbk_multichunk_and_relative_glob() {
        let root = std::env::temp_dir().join(format!("ZiEdit-search2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        // GBK 无 BOM 文件：命中依赖 detect→按 GBK 解码（非 UTF-8 直读必失真）
        let cn = "小猫在窗台上晒太阳，屋里屋外都很安静。\
                  这是一段足够长的中文文本，用来让编码探测器给出稳定的高置信度判断，\
                  避免启发式结果随样本长度波动。猫咪还在打盹。\n\
                  第二行没有目标词，只是普通叙述。\n";
        let (gbk, _, had_errors) = encoding_rs::GBK.encode(cn);
        assert!(!had_errors);
        std::fs::write(root.join("sub").join("gbk.txt"), gbk.as_ref()).unwrap();
        // >64KB（跨 ≥3 个 CHUNK）文件：唯一命中压在文件尾，锁分块流式扫描不静默截断
        let mut big = String::new();
        while big.len() < 200_000 {
            big.push_str("filler line without the needle\n");
        }
        big.push_str("the tail says cat now\n");
        std::fs::write(root.join("sub").join("big.log"), big).unwrap();
        std::fs::write(root.join("sub").join("ab.log"), "cat\n").unwrap();
        std::fs::write(root.join("skiproot.log"), "cat\n").unwrap();
        let cancel = AtomicBool::new(false);
        let options = |whole_word: bool| FifOptions {
            case_sensitive: false,
            whole_word,
            regex: false,
        };
        // 相对路径通配：sub/*.log 只扫子目录，根下 skiproot.log 不进结果
        let r = search(
            &root,
            "cat",
            options(true),
            "sub/*.log",
            100,
            &cancel,
            |_| {},
        )
        .unwrap();
        let names: Vec<String> = r
            .files
            .iter()
            .map(|f| {
                f.path
                    .replace('\\', "/")
                    .rsplit('/')
                    .next()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert!(names.contains(&"big.log".to_string()));
        assert!(names.contains(&"ab.log".to_string()));
        assert!(!names.contains(&"skiproot.log".to_string()));
        assert!(!names.contains(&"gbk.txt".to_string()));
        assert_eq!(r.scanned, 2);
        let big_hit = r
            .files
            .iter()
            .find(|f| f.path.ends_with("big.log"))
            .unwrap();
        assert_eq!(big_hit.hits.len(), 1);
        assert!(big_hit.hits[0].text.contains("cat now"));
        // 文件名通配 ?：a?.log 匹配 ab.log（两字符），不匹配 skiproot.log
        let r = search(&root, "cat", options(true), "a?.log", 100, &cancel, |_| {}).unwrap();
        assert_eq!(r.files.len(), 1);
        assert!(r.files[0].path.replace('\\', "/").ends_with("sub/ab.log"));
        // GBK 逐文件按编码搜索：中文词命中且行号/摘要在解码后的文本口径
        let r = search(&root, "猫咪", options(false), "*.txt", 100, &cancel, |_| {}).unwrap();
        assert_eq!(r.files.len(), 1);
        assert!(r.files[0].path.ends_with("gbk.txt"));
        assert_eq!(r.files[0].hits.len(), 1);
        assert_eq!(r.files[0].hits[0].line, 1);
        assert!(r.files[0].hits[0].text.contains("猫咪"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
