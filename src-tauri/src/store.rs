//! store —— JSON 持久化（决策 005：分文件、原子写、损坏自愈）
//! 会话 session.json / 最近 recent.json / 收藏 favorites.json / 设置 settings.json

use serde::Serialize;
use serde::de::DeserializeOwned;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 读取 JSON；解析失败把原文件改名为 .corrupt-<ts> 保留一份，返回默认值。
pub fn load_or_default<T: Default + DeserializeOwned>(path: &Path) -> T {
    match std::fs::read_to_string(path) {
        Ok(s) => match serde_json::from_str::<T>(&s) {
            Ok(v) => v,
            Err(_) => {
                quarantine(path);
                T::default()
            }
        },
        Err(_) => T::default(),
    }
}

static WRITE_ID: AtomicU64 = AtomicU64::new(1);

/// 同目录独占临时文件，完整写入并同步后替换；失败时保留原文件。
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let permissions = match std::fs::metadata(path) {
        Ok(meta) if meta.permissions().readonly() => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "File is read-only",
            ));
        }
        Ok(meta) => Some(meta.permissions()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("Missing file name"))?;
    let mut temp_name = name.to_os_string();
    temp_name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        WRITE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let tmp = path.with_file_name(temp_name);
    let mut created = false;
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        created = true;
        file.write_all(bytes)?;
        if let Some(permissions) = permissions {
            file.set_permissions(permissions)?;
        }
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    // 只清理由本次操作创建的文件，不触及碰巧同名的外部文件。
    if result.is_err() && created {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// 原子写入 JSON。
pub fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), crate::error::ZiEditError> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(value)?;
    atomic_write(path, json.as_bytes())?;
    Ok(())
}

fn quarantine(path: &Path) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    let backup = path.with_file_name(format!("{}.corrupt-{}", stem, ts));
    let _ = std::fs::rename(path, backup);
}

/// 拼配置目录下的文件路径
pub fn config_file(dir: &Path, name: &str) -> PathBuf {
    dir.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Default, Serialize, Deserialize, PartialEq, Debug)]
    struct Demo {
        items: Vec<String>,
    }

    fn tmp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("ZiEdit-store-test");
        std::fs::create_dir_all(&dir).unwrap();
        // 每个测试独立文件名，避免并发互踩
        dir.join(format!("{}-{}.json", name, std::process::id()))
    }

    #[test]
    fn save_load_roundtrip() {
        let p = tmp_path("rt");
        let d = Demo {
            items: vec!["a".into(), "b".into()],
        };
        save(&p, &d).unwrap();
        let back: Demo = load_or_default(&p);
        assert_eq!(back, d);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn corrupt_self_heals() {
        let p = tmp_path("corrupt");
        std::fs::write(&p, "{ not valid json !!").unwrap();
        let d: Demo = load_or_default(&p);
        assert_eq!(d, Demo::default());
        // 原文件被改名隔离，主路径不再存在
        assert!(!p.exists());
        // 清理隔离产物
        if let Ok(rd) = std::fs::read_dir(p.parent().unwrap()) {
            for e in rd {
                let e = e.unwrap().path();
                if e.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .contains("corrupt-")
                {
                    std::fs::remove_file(e).ok();
                }
            }
        }
    }

    #[test]
    fn missing_file_returns_default() {
        let p = tmp_path("missing");
        std::fs::remove_file(&p).ok();
        let d: Demo = load_or_default(&p);
        assert_eq!(d, Demo::default());
    }

    #[test]
    fn parallel_same_stem_writes_do_not_collide_and_failure_keeps_original() {
        let root = tmp_path("parallel").with_extension("dir");
        std::fs::create_dir_all(&root).unwrap();
        std::thread::scope(|scope| {
            for (name, byte) in [("a.txt", b'x'), ("a.md", b'y')] {
                let path = root.join(name);
                scope.spawn(move || {
                    for _ in 0..20 {
                        atomic_write(&path, &vec![byte; 65536]).unwrap();
                    }
                });
            }
        });
        assert_eq!(
            std::fs::read(root.join("a.txt")).unwrap(),
            vec![b'x'; 65536]
        );
        assert_eq!(std::fs::read(root.join("a.md")).unwrap(), vec![b'y'; 65536]);
        let path = root.join("a.txt");
        let original = std::fs::metadata(&path).unwrap().permissions();
        let mut readonly = original.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&path, readonly).unwrap();
        assert!(atomic_write(&path, b"overwrite").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), vec![b'x'; 65536]);
        std::fs::set_permissions(&path, original).unwrap();
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }
}
