//! 对比输入探测与开始时的元数据快照。
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputState {
    pub a_mtime_ms: f64,
    pub a_size: u64,
    pub b_mtime_ms: f64,
    pub b_size: u64,
}

pub fn input_state(a: &Path, b: &Path) -> std::io::Result<InputState> {
    let a = std::fs::metadata(a)?;
    let b = std::fs::metadata(b)?;
    let mtime = |meta: &std::fs::Metadata| -> std::io::Result<f64> {
        Ok(match meta.modified()?.duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_millis() as f64,
            Err(error) => -(error.duration().as_millis() as f64),
        })
    };
    Ok(InputState {
        a_mtime_ms: mtime(&a)?,
        a_size: a.len(),
        b_mtime_ms: mtime(&b)?,
        b_size: b.len(),
    })
}

pub fn inputs_binary(a: &Path, b: &Path) -> std::io::Result<bool> {
    use crate::kind_detect::detect;
    // 复用唯一类型判据（首 4KB 连续 NUL >64）；SVG 仍为文本。
    // Hex 视图移除后判据改为 FileKind.binary（呈现分流见 compare_open 的 binary 字段）。
    let binary = |path: &Path| -> std::io::Result<bool> {
        let kind = detect(path)?;
        Ok(kind.binary
            || (kind.route == crate::kind_detect::ViewRoute::Image && kind.language.is_none()))
    };
    Ok(binary(a)? || binary(b)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_and_input_metadata() {
        let dir = std::env::temp_dir().join(format!("ZiEdit-compare-input-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, b"text\n").unwrap();
        std::fs::write(&b, b"other text\n").unwrap();
        assert!(!inputs_binary(&a, &b).unwrap());
        let state = input_state(&a, &b).unwrap();
        assert_eq!((state.a_size, state.b_size), (5, 11));
        for (path, actual) in [(&a, state.a_mtime_ms), (&b, state.b_mtime_ms)] {
            let expected = std::fs::metadata(path)
                .unwrap()
                .modified()
                .unwrap()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as f64;
            assert!(actual > 0.0);
            assert_eq!(actual, expected);
        }
        let value = serde_json::to_value(state).unwrap();
        assert_eq!(value["aSize"], 5);
        assert_eq!(value["bSize"], 11);
        assert!(value["aMtimeMs"].is_number());
        assert!(value["bMtimeMs"].is_number());
        std::fs::write(&b, [0; 65]).unwrap();
        assert!(inputs_binary(&a, &b).unwrap());
        assert!(inputs_binary(&b, &a).unwrap());
        std::fs::write(&a, [0; 75]).unwrap();
        assert!(inputs_binary(&a, &b).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
