//! Revocable session scope, independent of Tauri's append-only asset scope.
use crate::error::ZiEditError;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

static SCOPE: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn validate(path: &str) -> Result<PathBuf, ZiEditError> {
    crate::paths::reject_device_path(path)?;
    let p = std::fs::canonicalize(path)?;
    if p.parent().is_none() {
        return Err(ZiEditError::Msg(
            "Asset root directories are forbidden".into(),
        ));
    }
    for name in [
        "SystemRoot",
        "WINDIR",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
    ] {
        if let Some(root) = std::env::var_os(name)
            && let Ok(root) = std::fs::canonicalize(root)
            && (p
                .to_string_lossy()
                .to_lowercase()
                .starts_with(&format!("{}\\", root.to_string_lossy().to_lowercase()))
                || p.to_string_lossy()
                    .eq_ignore_ascii_case(&root.to_string_lossy()))
        {
            return Err(ZiEditError::Msg("System asset paths are forbidden".into()));
        }
    }
    Ok(p)
}

#[tauri::command]
pub fn zasset_allow(path: String) -> Result<(), ZiEditError> {
    let path = validate(&path)?;
    SCOPE.lock().unwrap_or_else(|e| e.into_inner()).insert(path);
    Ok(())
}

#[tauri::command]
pub fn zasset_reset(paths: Vec<String>) -> Result<(), ZiEditError> {
    // Invalid/deleted tabs must not prevent revocation of the previous session.
    let mut next = HashSet::new();
    for path in paths {
        if let Ok(path) = validate(&path) {
            next.insert(path);
        }
    }
    *SCOPE.lock().unwrap_or_else(|e| e.into_inner()) = next;
    Ok(())
}

fn permitted(scope: &HashSet<PathBuf>, path: &Path) -> bool {
    scope
        .iter()
        .any(|root| path == root || (root.is_dir() && path.starts_with(root)))
}

fn decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut result = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            result.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            result.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(result).ok()
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

pub fn respond(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let response = |status, mime, body| {
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", mime)
            .header("Access-Control-Allow-Origin", "*")
            .header("X-Content-Type-Options", "nosniff")
            .body(body)
            .expect("static response headers")
    };
    let Some(path) = decode(
        request
            .uri()
            .path()
            .strip_prefix('/')
            .unwrap_or(request.uri().path()),
    ) else {
        return response(403, "text/plain", Vec::new());
    };
    let Ok(path) = std::fs::canonicalize(path) else {
        return response(404, "text/plain", Vec::new());
    };
    // Keep the lock through the read: reset cannot race an authorized read.
    let scope = SCOPE.lock().unwrap_or_else(|e| e.into_inner());
    if !permitted(&scope, &path) {
        return response(403, "text/plain", Vec::new());
    }
    match std::fs::read(&path) {
        Ok(bytes) => response(200, content_type(&path), bytes),
        Err(_) => response(404, "text/plain", Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scope_rebuild_and_response() {
        let dir = std::env::temp_dir().join(format!("zasset-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test.png");
        std::fs::write(&file, b"png").unwrap();
        let request = || {
            tauri::http::Request::builder()
                .uri(format!(
                    "http://zasset.localhost/{}",
                    file.to_string_lossy().replace('\\', "/")
                ))
                .body(Vec::new())
                .unwrap()
        };
        zasset_reset(vec![]).unwrap();
        assert_eq!(respond(request()).status(), 403);
        zasset_allow(dir.to_string_lossy().into()).unwrap();
        let result = respond(request());
        assert_eq!(result.status(), 200);
        assert_eq!(result.headers()["Content-Type"], "image/png");
        zasset_reset(vec![file.to_string_lossy().into()]).unwrap();
        assert_eq!(respond(request()).status(), 200);
        zasset_reset(vec![]).unwrap();
        assert_eq!(respond(request()).status(), 403);
        assert!(validate(if cfg!(windows) { "C:\\" } else { "/" }).is_err());
        if let Ok(system) = std::env::var("SystemRoot") {
            assert!(validate(&system).is_err());
        }
        assert_eq!(decode("%E4%B8%AD%20%23%25"), Some("中 #%".into()));
        assert_eq!(content_type(Path::new("a.PDF")), "application/pdf");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
