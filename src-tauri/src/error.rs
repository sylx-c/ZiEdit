//! error —— 统一错误枚举（RUST-01，审计 db528fd W2；ARCHITECTURE 编码约定：
//! `thiserror` 定义模块错误，command 边界映射可读 `Result`）。
//!
//! 前端契约：错误经 `Serialize` 落为 **可读字符串**（与迁移前的 `Result<T, String>`
//! 逐字兼容）——前端按 `String(err)` 展示、按 `contains` 识别哨兵
//! （EXISTS / TOO_LARGE / INDEXING / EXTERNAL_CHANGED / UNMAPPABLE / E6xxx），
//! i18n 的 `[E####]` 前缀由前端 ERR_CODES 注入，与 Rust 侧无关。
//! 因此：**Display 文本属对外契约，修改须同步前端**。

use serde::Serializer;

/// 编码写回错误（encoding 模块，005 保存/008 规范化另存共用）
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EncodeError {
    #[error("Unknown encoding: {0}")]
    Unknown(String),
    #[error("Characters cannot be written back in this encoding")]
    Unmappable,
}

/// 命令层统一错误。变体名表达语义，Display 保持迁移前字符串不变。
#[derive(Debug, thiserror::Error)]
pub enum ZiEditError {
    /// 裸 I/O 失败（迁移前 `e.to_string()` 路径）
    #[error("{0}")]
    Io(#[from] std::io::Error),
    /// 带上下文的 I/O 失败（迁移前 `format!("{ctx}: {e}")` 族）
    #[error("{ctx}: {err}")]
    IoCtx {
        ctx: String,
        #[source]
        err: std::io::Error,
    },
    /// 目标已存在（不覆盖哨兵，前端 `includes('EXISTS')`）
    #[error("EXISTS")]
    Exists,
    /// 源不存在（前端 NOT_FOUND 哨兵）
    #[error("NOT_FOUND")]
    NotFound,
    /// 超出体量上限（CSV 记录索引哨兵）
    #[error("TOO_LARGE")]
    TooLarge,
    /// 行索引尚在构建（002 按需加载哨兵）
    #[error("INDEXING")]
    Indexing,
    /// 保存前外部变更（E1003 家族哨兵）
    #[error("EXTERNAL_CHANGED: file changed while preparing save")]
    ExternalChanged,
    /// 目标编码无法表示（UNMAPPABLE 哨兵；前端据此弹三键）
    #[error("UNMAPPABLE:{0}")]
    Unmappable(String),
    /// 编码探测/写回
    #[error("{0}")]
    Encode(#[from] EncodeError),
    /// JSON 序列化/解析
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    /// 其余可读消息（各命令特有文案；新代码优先建具名变体）
    #[error("{0}")]
    Msg(String),
    /// 图床 E6xxx 族（s3 模块自带结构化码，原样透出）
    #[error("{0}")]
    S3(String),
}

impl ZiEditError {
    /// 带上下文包装 I/O 错误（迁移前 `map_err(|e| format!("{ctx}: {e}"))` 的类型化形态）
    pub fn ctx(ctx: impl Into<String>, err: impl Into<std::io::Error>) -> Self {
        ZiEditError::IoCtx {
            ctx: ctx.into(),
            err: err.into(),
        }
    }
}

impl From<ZiEditError> for String {
    fn from(e: ZiEditError) -> String {
        e.to_string()
    }
}

/// 前端契约：错误序列化为可读字符串（Tauri command 边界）。
impl serde::Serialize for ZiEditError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_contract_sentinels() {
        // 前端 contains 判据依赖的哨兵文本不可漂移
        assert_eq!(ZiEditError::Exists.to_string(), "EXISTS");
        assert_eq!(ZiEditError::NotFound.to_string(), "NOT_FOUND");
        assert_eq!(ZiEditError::TooLarge.to_string(), "TOO_LARGE");
        assert_eq!(ZiEditError::Indexing.to_string(), "INDEXING");
        assert_eq!(
            ZiEditError::ExternalChanged.to_string(),
            "EXTERNAL_CHANGED: file changed while preparing save"
        );
        assert_eq!(
            ZiEditError::Unmappable("x".into()).to_string(),
            "UNMAPPABLE:x"
        );
        assert_eq!(
            ZiEditError::S3("E6001:bucket".into()).to_string(),
            "E6001:bucket"
        );
    }

    #[test]
    fn display_contract_readable() {
        assert_eq!(
            EncodeError::Unknown("GBK".into()).to_string(),
            "Unknown encoding: GBK"
        );
        assert_eq!(
            EncodeError::Unmappable.to_string(),
            "Characters cannot be written back in this encoding"
        );
        let io = std::io::Error::other("boom");
        assert_eq!(ZiEditError::Io(io).to_string(), "boom");
        assert_eq!(
            ZiEditError::ctx("Read failed", std::io::Error::other("boom")).to_string(),
            "Read failed: boom"
        );
    }

    #[test]
    fn serialize_is_plain_string() {
        let v = serde_json::to_value(ZiEditError::Exists).unwrap();
        assert_eq!(v, serde_json::json!("EXISTS"));
    }
}
