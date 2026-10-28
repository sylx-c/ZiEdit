// paths —— 应用目录裁决（ADR 014：开发态配置隔离）
// dev（debug 构建）与安装版共用标识 dev.ziedit.app：若不隔离，`npm run tauri dev` 的
// 会话/最近打开/收藏/设置/恢复快照会写进真实配置目录，安装版启动即恢复开发残留
// （实测：安装首启直接恢复了开发时打开的标签组与目录跟随树根）。
// debug 构成的配置目录一律加 `-dev` 后缀；release 原样（用户真实数据不动）。
// 日志目录不隔离：tauri-plugin-log 的 targets 在 AppHandle 就绪前构建取不到
// app_log_dir，而日志不参与启动恢复，共享无用户可见后果（权衡记录见 ADR 014）。
use std::path::PathBuf;
use tauri::Manager;

/// 配置目录后缀（纯函数便于单测）：debug → `<dir>-dev`；release → 原样
pub fn with_profile(path: PathBuf) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let mut s = path.into_os_string();
        s.push("-dev");
        PathBuf::from(s)
    }
    #[cfg(not(debug_assertions))]
    {
        path
    }
}

/// 应用配置目录（会话/设置/最近/恢复快照/备份的唯一根）
pub fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, crate::error::ZiEditError> {
    app.path()
        .app_config_dir()
        .map(with_profile)
        .map_err(|e| crate::error::ZiEditError::Msg(format!("Cannot get config directory: {e}")))
}

#[cfg(test)]
mod tests {
    use super::with_profile;
    use std::path::PathBuf;

    #[test]
    fn debug_profile_suffix() {
        // cargo test 默认 debug 构建：断言 -dev 后缀生效。
        // release 分支被 cfg 编译剔除，无法在同一次运行中断言——属预期（行为由 cfg 保证）。
        #[cfg(debug_assertions)]
        {
            assert_eq!(
                with_profile(PathBuf::from(r"C:\Users\x\AppData\Roaming\dev.ziedit.app")),
                PathBuf::from(r"C:\Users\x\AppData\Roaming\dev.ziedit.app-dev")
            );
        }
    }
}
