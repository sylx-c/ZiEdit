//! OOXML IPC: bounded extraction caches, metadata invalidation and window-only replies.
use crate::{
    error::ZiEditError,
    ooxml::{self, docx, pdf, xlsx},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::Manager;

enum Content {
    Docx(docx::Document),
    Xlsx(xlsx::Workbook),
    Pdf(docx::Document),
}
struct Entry {
    len: u64,
    modified: Option<std::time::SystemTime>,
    content: Arc<Content>,
}
#[derive(Default)]
pub struct OoxmlRegistry(Mutex<HashMap<String, Entry>>);
/// 二次加锁的发布决策（纯逻辑可单测）：
/// 已有条目 meta（len/mtime）与本次**不同** → 注册表里是更新请求写回的新版本，
/// 晚到的旧解析结果不覆盖不淘汰，直接返回本次 Arc（下次访问因 meta 失配触发重解析）；
/// 仅无条目或 meta 相同才插入（同 meta 不同 kind 变体的解析竞争照旧覆盖，无害）。
fn publish_entry(
    entries: &mut HashMap<String, Entry>,
    path: &str,
    len: u64,
    modified: Option<std::time::SystemTime>,
    content: Arc<Content>,
) -> Arc<Content> {
    if let Some(entry) = entries.get(path)
        && (entry.len != len || entry.modified != modified)
    {
        return content; // 晚到旧请求：不覆盖更新版本
    }
    if !entries.contains_key(path)
        && entries.len() >= 4
        && let Some(victim) = entries.keys().next().cloned()
    {
        entries.remove(&victim);
    }
    entries.insert(
        path.into(),
        Entry {
            len,
            modified,
            content: content.clone(),
        },
    );
    content
}

/// 解析并缓存（sync 命令线程内经 spawn_blocking 调用，绝不占主线程）。
/// 锁只护 map 读写：缓存命中查询在锁内；未命中先解锁做完整 ZIP+XML 解析
/// （docx/xlsx/pdf::open 可达数百 ms，持锁会把并发 lines 查询挡在锁外），
/// 再二次加锁经 [`publish_entry`] 做失效校验 + 淘汰 + 插入；
/// len/mtime 失效语义与 4 份淘汰上限不变。
fn load(registry: &OoxmlRegistry, path: &str, kind: u8) -> Result<Arc<Content>, ZiEditError> {
    let meta = std::fs::metadata(path)?;
    let modified = meta.modified().ok();
    {
        let entries = registry
            .0
            .lock()
            .map_err(|e| ZiEditError::Msg(e.to_string()))?;
        if let Some(entry) = entries.get(path)
            && entry.len == meta.len()
            && entry.modified == modified
            && matches!(
                (&*entry.content, kind),
                (Content::Docx(_), 0) | (Content::Xlsx(_), 1) | (Content::Pdf(_), 2)
            )
        {
            return Ok(entry.content.clone());
        }
    }
    let content = Arc::new(if kind == 2 {
        Content::Pdf(pdf::open(path).map_err(ZiEditError::Msg)?)
    } else if kind == 1 {
        Content::Xlsx(xlsx::open(path).map_err(ZiEditError::Msg)?)
    } else {
        Content::Docx(docx::open(path).map_err(ZiEditError::Msg)?)
    });
    let mut entries = registry
        .0
        .lock()
        .map_err(|e| ZiEditError::Msg(e.to_string()))?;
    // 失效校验：并发同路径解析已插入等价条目时直接复用，避免无谓淘汰
    if let Some(entry) = entries.get(path)
        && entry.len == meta.len()
        && entry.modified == modified
        && matches!(
            (&*entry.content, kind),
            (Content::Docx(_), 0) | (Content::Xlsx(_), 1) | (Content::Pdf(_), 2)
        )
    {
        return Ok(entry.content.clone());
    }
    Ok(publish_entry(
        &mut entries,
        path,
        meta.len(),
        modified,
        content,
    ))
}
#[tauri::command]
pub async fn docx_open(
    app: tauri::AppHandle,
    path: String,
) -> Result<docx::OpenResult, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<OoxmlRegistry>();
        match &*load(&registry, &path, 0)? {
            Content::Docx(doc) => Ok(doc.info()),
            _ => unreachable!(),
        }
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}
#[derive(Serialize)]
pub struct Line {
    no: usize,
    text: String,
}
#[derive(Serialize)]
pub struct LinesResult {
    lines: Vec<Line>,
    total: usize,
}
#[tauri::command]
pub async fn docx_lines(
    app: tauri::AppHandle,
    path: String,
    from: u64,
    to: u64,
) -> Result<LinesResult, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<OoxmlRegistry>();
        document_lines(&registry, &path, from, to, 0)
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}
#[tauri::command]
pub async fn pdf_open(
    app: tauri::AppHandle,
    path: String,
) -> Result<docx::OpenResult, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<OoxmlRegistry>();
        match &*load(&registry, &path, 2)? {
            Content::Pdf(doc) => Ok(doc.info()),
            _ => unreachable!(),
        }
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

#[tauri::command]
pub async fn pdf_lines(
    app: tauri::AppHandle,
    path: String,
    from: u64,
    to: u64,
) -> Result<LinesResult, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<OoxmlRegistry>();
        document_lines(&registry, &path, from, to, 2)
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}
fn document_lines(
    registry: &OoxmlRegistry,
    path: &str,
    from: u64,
    to: u64,
    kind: u8,
) -> Result<LinesResult, ZiEditError> {
    let range = ooxml::window(from, to).map_err(ZiEditError::Msg)?;
    let doc = load(registry, path, kind)?;
    let (Content::Docx(doc) | Content::Pdf(doc)) = &*doc else {
        unreachable!()
    };
    let mut lines = Vec::new();
    let mut bytes = 0;
    for i in range.take_while(|i| *i < doc.lines.len()) {
        let text = &doc.lines[i];
        if text.len() > ooxml::WINDOW_BYTES {
            return Err(ZiEditError::Msg("OOXML_LINE_LIMIT:4MiB".into()));
        }
        if bytes + text.len() > ooxml::WINDOW_BYTES {
            break;
        }
        bytes += text.len();
        lines.push(Line {
            no: i + 1,
            text: text.clone(),
        });
    }
    Ok(LinesResult {
        lines,
        total: doc.lines.len(),
    })
}
#[tauri::command]
pub async fn xlsx_open(
    app: tauri::AppHandle,
    path: String,
) -> Result<xlsx::OpenResult, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<OoxmlRegistry>();
        match &*load(&registry, &path, 1)? {
            Content::Xlsx(book) => Ok(book.info()),
            _ => unreachable!(),
        }
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

#[tauri::command]
pub async fn xlsx_records(
    app: tauri::AppHandle,
    path: String,
    sheet: usize,
    from: u64,
    to: u64,
) -> Result<xlsx::RecordsResult, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<OoxmlRegistry>();
        xlsx_records_impl(&registry, &path, sheet, from, to)
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

fn xlsx_records_impl(
    registry: &OoxmlRegistry,
    path: &str,
    sheet: usize,
    from: u64,
    to: u64,
) -> Result<xlsx::RecordsResult, ZiEditError> {
    let range = ooxml::window(from, to).map_err(ZiEditError::Msg)?;
    let book = load(registry, path, 1)?;
    let Content::Xlsx(book) = &*book else {
        unreachable!()
    };
    let rows = &book
        .sheets
        .get(sheet)
        .ok_or_else(|| ZiEditError::Msg("XLSX_SHEET_NOT_FOUND:zero-based".into()))?
        .records;
    let mut records = Vec::new();
    let mut bytes = 0;
    for i in range.take_while(|i| *i < rows.len()) {
        let size: usize = rows[i].iter().map(String::len).sum();
        if size > ooxml::WINDOW_BYTES {
            return Err(ZiEditError::Msg("XLSX_RECORD_LIMIT:4MiB".into()));
        }
        if bytes + size > ooxml::WINDOW_BYTES {
            break;
        }
        bytes += size;
        records.push(super::csv::CsvRecord {
            no: (i + 1) as u64,
            cells: rows[i].clone(),
        });
    }
    Ok(xlsx::RecordsResult {
        records,
        total: rows.len(),
    })
}
#[tauri::command]
pub fn ooxml_close(
    registry: tauri::State<'_, OoxmlRegistry>,
    path: String,
) -> Result<(), ZiEditError> {
    registry
        .0
        .lock()
        .map_err(|e| ZiEditError::Msg(e.to_string()))?
        .remove(&path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc_content(tag: &str) -> Arc<Content> {
        Arc::new(Content::Docx(docx::Document {
            lines: vec![tag.into()],
            total_chars: tag.len(),
        }))
    }

    /// ：晚到的旧版本解析结果不得覆盖注册表内更新版本，也不触发淘汰
    #[test]
    fn late_old_request_does_not_overwrite_newer_entry() {
        let mut entries = HashMap::new();
        // 旧请求先启动（v1 meta），新请求已完成并写回 v2 条目
        let (v1_len, v1_mtime) = (100u64, Some(std::time::SystemTime::UNIX_EPOCH));
        let (v2_len, v2_mtime) = (
            200u64,
            Some(std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(9_000)),
        );
        let v2 = doc_content("newer");
        entries.insert(
            "a.docx".into(),
            Entry {
                len: v2_len,
                modified: v2_mtime,
                content: v2.clone(),
            },
        );
        // 晚到的 v1 结果发布：不覆盖（注册表仍是 v2）、返回本次 Arc
        let v1 = doc_content("older");
        let returned = publish_entry(&mut entries, "a.docx", v1_len, v1_mtime, v1.clone());
        assert!(std::sync::Arc::ptr_eq(&returned, &v1), "返回本次解析结果");
        let entry = entries.get("a.docx").unwrap();
        assert_eq!(entry.len, v2_len, "注册表内更新版本不被覆盖");
        assert!(std::sync::Arc::ptr_eq(&entry.content, &v2));

        // meta 相同（重解析竞争）：照旧插入覆盖
        let again = doc_content("same-meta");
        publish_entry(&mut entries, "a.docx", v2_len, v2_mtime, again.clone());
        assert!(std::sync::Arc::ptr_eq(
            &entries.get("a.docx").unwrap().content,
            &again
        ));

        // 无条目：正常插入；容量 4 淘汰照旧
        let cap_fill = |entries: &mut HashMap<String, Entry>, n: usize| {
            for i in 0..n {
                entries.insert(
                    format!("f{i}.docx"),
                    Entry {
                        len: i as u64,
                        modified: None,
                        content: doc_content(&format!("f{i}")),
                    },
                );
            }
        };
        let mut fresh = HashMap::new();
        cap_fill(&mut fresh, 4);
        let inserted = doc_content("newpath");
        let ret = publish_entry(&mut fresh, "new.docx", 1, None, inserted.clone());
        assert!(std::sync::Arc::ptr_eq(&ret, &inserted));
        assert!(fresh.contains_key("new.docx"));
        assert_eq!(fresh.len(), 4, "满容量插入淘汰一个旧条目");
    }
}
