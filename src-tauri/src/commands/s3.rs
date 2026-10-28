//! s3 —— 图床网络例外通道（009 v0.2 / ADR 016：应用唯一两条出网命令）。
//! 写侧 `s3_put_object`：手写 AWS Signature Version 4（服务 s3、UNSIGNED-PAYLOAD 豁免、
//! 单次 PUT Object ≤20MB 不做 multipart）；读侧 `s3_get_image`：对图床公网基址 host 的
//! URL 做普通 HTTPS GET（公开读对象，无需签名，非 S3 API）+ 磁盘缓存（配置目录
//! cache/images/，键 = URL SHA-256 前 16 位，256MB LRU）。
//! 网络例外唯一性（红线级）：仅这两条命令出网，且只访问用户配置的地址——put 侧在
//! 构造请求前校验端点方案（明文 http 需显式豁免），get 侧校验目标 host 与公网基址
//! host 全等（不匹配即拒绝，不发起连接）；HTTP 客户端禁重定向、禁代理。
//! 错误仅返回网络阶段与状态码：移除请求 URL，不回传可能回显认证信息的响应体。
//! E6004 网络错误 / E6005 非 2xx / E6006 403；错误串前缀 E6xxx 交前端呈现。
//! 凭据只在调用参数中过境（前端仅当前会话内存保留）——本模块不落盘、不打日志
//! （log 侧仅对象键脱敏出现在调用方）。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 对象体上限（009 规则 3：单次 PUT ≤20MB，超限拒绝不做 multipart）
pub const MAX_OBJECT_BYTES: usize = 20 * 1024 * 1024;
/// 取图响应体上限（与上传同口径：图床图即上传物，≤20MB）
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// 磁盘缓存总量上限（009 规则 10：256MB，超限 LRU 淘汰）
pub const IMAGE_CACHE_CAP: u64 = 256 * 1024 * 1024;
/// 请求超时（上传与取图同为 30s，009 规则 3/10）
const REQ_TIMEOUT: Duration = Duration::from_secs(30);

// ── 哈希基元（自研 HMAC-SHA256，零新依赖；sha2 已在依赖面） ──

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// HMAC-SHA256（RFC 2104，块长 64；超长密钥先哈希）
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const B: usize = 64;
    let mut k = [0u8; B];
    if key.len() > B {
        k[..32].copy_from_slice(&sha256(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let (mut ipad, mut opad) = ([0x36u8; B], [0x5cu8; B]);
    for i in 0..B {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let ih = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(ih);
    outer.finalize().into()
}

// ── AWS Signature Version 4（纯函数，官方向量锁单测） ──

/// SigV4 签名入参：headers 为完整签名头集合（含 host / x-amz-date / 逐案追加头），
/// 函数内部按名排序；payload_hash 为规范请求末行（S3 生产路径恒 UNSIGNED-PAYLOAD，
/// 官方向量用实际哈希——两种口径都经此参数覆盖）。
pub struct SigV4<'a> {
    pub method: &'a str,
    pub canonical_uri: &'a str,
    pub query: &'a str,
    pub headers: &'a [(String, String)],
    pub payload_hash: &'a str,
    pub amz_date: &'a str,
    pub date_stamp: &'a str,
    pub region: &'a str,
    pub service: &'a str,
    pub access_key: &'a str,
    pub secret: &'a str,
}

/// 规范请求（调试与向量断言用）
pub fn sigv4_canonical_request(r: &SigV4) -> String {
    let mut hs = r.headers.to_vec();
    hs.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_headers: String = hs.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers = hs
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        r.method, r.canonical_uri, r.query, canonical_headers, signed_headers, r.payload_hash
    )
}

/// Authorization 头（AWS4-HMAC-SHA256 …）
pub fn sigv4_authorization(r: &SigV4) -> String {
    let canonical = sigv4_canonical_request(r);
    let cr_hash = hex_lower(&sha256(canonical.as_bytes()));
    let k_date = hmac_sha256(
        format!("AWS4{}", r.secret).as_bytes(),
        r.date_stamp.as_bytes(),
    );
    let k_region = hmac_sha256(&k_date, r.region.as_bytes());
    let k_service = hmac_sha256(&k_region, r.service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let sts = format!(
        "AWS4-HMAC-SHA256\n{}\n{}/{}/{}/aws4_request\n{}",
        r.amz_date, r.date_stamp, r.region, r.service, cr_hash
    );
    let signature = hex_lower(&hmac_sha256(&k_signing, sts.as_bytes()));
    let mut hs = r.headers.to_vec();
    hs.sort_by(|a, b| a.0.cmp(&b.0));
    let signed_headers = hs
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{}/{}/{}/aws4_request, SignedHeaders={}, Signature={}",
        r.access_key, r.date_stamp, r.region, r.service, signed_headers, signature
    )
}

/// SigV4 URI 编码：保留 A-Za-z0-9 - . _ ~；其余按 UTF-8 百分号大写十六进制。
/// keep_slash=true（对象键路径模式）保留 '/'；false 时 '/' 亦编码（查询值模式）。
pub fn uri_encode(s: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            b'/' if keep_slash => out.push('/'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// UTC 时间 → x-amz-date（YYYYMMDDTHHMMSSZ）/ date_stamp（YYYYMMDD）。
/// 手写民用历换算（Howard Hinnant civil_from_days），零时区依赖；本地时区的 {date}
/// 命名模板由前端生成（Rust 侧只需 UTC 签名时间）。
pub fn amz_timestamps_from_unix(secs: u64) -> (String, String) {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (hh, mm, ss) = (rem / 3600, rem % 3600 / 60, rem % 60);
    // civil_from_days：1970-03-01 起算的 Era 算法（避免闰年特判表）
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (
        format!("{:04}{:02}{:02}T{:02}{:02}{:02}Z", y, m, d, hh, mm, ss),
        format!("{:04}{:02}{:02}", y, m, d),
    )
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── PUT 请求构造（纯函数，测试锁行为） ──

/// 端点解析结果：scheme 与 host[:port]（非默认端口显式保留——Host 头与 URL 必须一致）
pub struct ParsedEndpoint {
    pub scheme: String,
    pub host_header: String,
    pub is_https: bool,
}

pub fn parse_endpoint(endpoint: &str) -> Result<ParsedEndpoint, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|e| format!("E6001:endpoint:{e}"))?;
    let scheme = url.scheme().to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return Err(format!("E6001:endpoint:scheme {scheme}"));
    }
    let mut host_header = url.host_str().ok_or("E6001:endpoint:no host")?.to_string();
    if let Some(p) = url.port() {
        host_header.push(':');
        host_header.push_str(&p.to_string());
    }
    let is_https = scheme == "https";
    Ok(ParsedEndpoint {
        scheme,
        host_header,
        is_https,
    })
}

/// PUT 请求三要素：完整 URL / Host 头 / 规范 URI（对象键按 SigV4 编码）
pub fn build_put_parts(
    endpoint: &str,
    bucket: &str,
    key: &str,
    address_style: &str,
) -> Result<(String, String, String), String> {
    let ep = parse_endpoint(endpoint)?;
    let enc_key = uri_encode(key, true);
    let bucket_ok = !bucket.is_empty() && !bucket.contains('/') && !bucket.contains('\\');
    if !bucket_ok {
        return Err("E6001:bucket".into());
    }
    let parts = match address_style {
        "virtual-host" => {
            let host = format!("{}.{}", bucket, ep.host_header);
            (
                format!("{}://{}/{}", ep.scheme, host, enc_key),
                host,
                format!("/{}", enc_key),
            )
        }
        // 默认 path（009 规则 2：MinIO/R2/自建端点兼容面最广）
        _ => (
            format!("{}://{}/{}/{}", ep.scheme, ep.host_header, bucket, enc_key),
            ep.host_header,
            format!("/{}/{}", bucket, enc_key),
        ),
    };
    Ok(parts)
}

/// 上传前静态校验（发起任何连接之前拒绝；E6001/E6002/E6003）
pub fn validate_put(endpoint: &str, allow_insecure: bool, size: usize) -> Result<(), String> {
    let ep = parse_endpoint(endpoint)?;
    if !ep.is_https && !allow_insecure {
        // 明文 http 端点须显式豁免（局域网 MinIO）；拒绝发生在建连前——零网络口径
        return Err("E6002".into());
    }
    if size > MAX_OBJECT_BYTES {
        return Err(format!("E6003:{}", size));
    }
    Ok(())
}

// ── 写侧命令（009 规则 3/4：唯一出网命令之一，仅显式上传动作时被调） ──

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3PutRequest {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// 对象键（含前缀与模板展开结果；扩展名由前端按 MIME 映射附加）
    pub key: String,
    pub content_base64: String,
    pub content_type: String,
    /// "path" | "virtual-host"（默认 path，009 规则 2）
    pub address_style: String,
    /// 明文 http 豁免（默认关；E6002 判定用）
    pub allow_insecure: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3PutResult {
    pub status: u16,
    pub etag: Option<String>,
}

/// 阶段标签（009 规则 3：dns/connect/tls/write/read/timeout——reqwest 错误面按
/// kind 与源链 best-effort 归类；对外错误移除 URL）
fn stage_of(err: &reqwest::Error) -> &'static str {
    if err.is_timeout() {
        "timeout"
    } else if err.is_connect() {
        let s = err.to_string().to_ascii_lowercase();
        if s.contains("dns") {
            "dns"
        } else if s.contains("tls") {
            "tls"
        } else {
            "connect"
        }
    } else {
        "read"
    }
}

fn network_error(err: reqwest::Error) -> String {
    format!("E6004:{}:{}", stage_of(&err), err.without_url())
}

fn response_error(status: u16) -> String {
    let code = if status == 403 { "E6006" } else { "E6005" };
    format!("{code}:{status}")
}

/// 禁重定向、禁代理客户端（零网络例外边界：目标只能是用户配置地址，绝不跟随跳转
/// 或环境代理）
fn guarded_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQ_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|e| format!("E6004:client:{}", e))
}

#[tauri::command]
pub async fn s3_put_object(req: S3PutRequest) -> Result<S3PutResult, String> {
    let bytes = super::misc::base64_decode(&req.content_base64)
        .map_err(|e| format!("E6001:content:{e}"))?;
    validate_put(&req.endpoint, req.allow_insecure, bytes.len())?;
    let (url, host, canonical_uri) =
        build_put_parts(&req.endpoint, &req.bucket, &req.key, &req.address_style)?;
    let (amz_date, date_stamp) = amz_timestamps_from_unix(now_unix());
    let auth = sigv4_authorization(&SigV4 {
        method: "PUT",
        canonical_uri: &canonical_uri,
        query: "",
        headers: &[
            ("host".into(), host.clone()),
            ("x-amz-content-sha256".into(), "UNSIGNED-PAYLOAD".into()),
            ("x-amz-date".into(), amz_date.clone()),
        ],
        payload_hash: "UNSIGNED-PAYLOAD",
        amz_date: &amz_date,
        date_stamp: &date_stamp,
        region: &req.region,
        service: "s3",
        access_key: &req.access_key_id,
        secret: &req.secret_access_key,
    });
    // 禁重定向、禁代理：目标只能是用户配置端点，绝不跟随跳转或环境代理
    let client = guarded_client()?;
    let resp = client
        .put(&url)
        .header("Authorization", auth)
        .header("x-amz-date", &amz_date)
        .header("x-amz-content-sha256", "UNSIGNED-PAYLOAD")
        .header(reqwest::header::CONTENT_TYPE, &req.content_type)
        .body(bytes)
        .send()
        .await
        .map_err(network_error)?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(response_error(status));
    }
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_matches('"').to_string());
    Ok(S3PutResult { status, etag })
}

// ── 读侧命令（009 规则 10：普通 HTTPS GET + 磁盘缓存；非 S3 API，无签名） ──

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3GetImageResult {
    pub mime: String,
    pub data_base64: String,
    pub cached: bool,
}

/// URL → host[:port]（小写 host；端口保留参与全等比较——公网基址带端口的配置合法）
fn url_host(url: &str) -> Result<(String, String), String> {
    let u = reqwest::Url::parse(url).map_err(|e| format!("E6010:url:{e}"))?;
    let scheme = u.scheme().to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return Err(format!("E6010:scheme {scheme}"));
    }
    let mut host = u.host_str().ok_or("E6010:no host")?.to_ascii_lowercase();
    if let Some(p) = u.port() {
        host.push(':');
        host.push_str(&p.to_string());
    }
    Ok((scheme, host))
}

/// host 全等校验（读侧零请求边界：目标 host 必须与公网基址 host 全等，不匹配即拒绝）
pub fn host_allowed(url: &str, allowed_base: &str) -> Result<bool, String> {
    let (_, uh) = url_host(url)?;
    let (_, ah) = url_host(allowed_base)?;
    Ok(uh == ah)
}

/// 魔数嗅探（缓存命中无 Content-Type 时的 MIME 判定；不识别返回 None → 调用方拒缓存）
pub fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && &bytes[8..12] == b"avif" {
        return Some("image/avif");
    }
    // SVG 文本嗅探（容忍 BOM/空白/XML 声明前导；S3 错误页同为 XML 但根非 <svg>——
    // 只认文档根是 <svg> 的，错误页不误判）
    let lossy = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    let head = lossy.trim_start_matches('\u{feff}').trim_start();
    let root = match head.find("?>") {
        Some(end) if head.starts_with("<?xml") => head[end + 2..].trim_start(),
        _ => head,
    };
    if root.starts_with("<svg") {
        return Some("image/svg+xml");
    }
    None
}

/// 缓存文件名：URL SHA-256 前 16 位十六进制（009 规则 10）
pub fn cache_key(url: &str) -> String {
    hex_lower(&sha256(url.as_bytes()))[..16].to_string()
}

/// 缓存目录（配置目录 cache/images/；调用方负责建目录）
pub fn image_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::config_dir(app)?.join("cache").join("images"))
}

/// LRU 触摸：仅更新修改时间不写内容（append 打开不落盘新字节）
fn touch(path: &Path) {
    if let Ok(f) = std::fs::File::options().append(true).open(path) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
}

/// LRU 淘汰到上限内（按修改时间最旧先删；脏读容忍——并发写 tmp 文件不参与：
/// 只统计最终命名 `<sha16>` 形态的缓存文件）
pub fn trim_cache_lru(dir: &Path, cap_bytes: u64) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<(PathBuf, u64, std::time::SystemTime)> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_string_lossy().to_string();
            // 只认缓存键形态（16 位十六进制；.tmp 写入中文件不碰）
            if name.len() != 16 || !name.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((p, meta.len(), meta.modified().ok()?))
        })
        .collect();
    let total: u64 = entries.iter().map(|(_, l, _)| *l).sum();
    if total <= cap_bytes {
        return;
    }
    entries.sort_by_key(|(_, _, m)| *m);
    let mut over = total - cap_bytes;
    for (p, l, _) in entries {
        if over == 0 {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            over = over.saturating_sub(l);
        }
    }
}

#[tauri::command]
pub async fn s3_get_image(
    app: tauri::AppHandle,
    url: String,
    allowed_base: String,
) -> Result<S3GetImageResult, String> {
    if !host_allowed(&url, &allowed_base)? {
        // 非公网基址 host：拒绝且不发起任何连接（009 规则 10 / AC-12 零请求边界）
        return Err("E6010:host not allowed".into());
    }
    let dir = image_cache_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("E6011:cache:{e}"))?;
    let key = cache_key(&url);
    let path = dir.join(&key);
    // 命中：touch（LRU 序）+ 嗅探 MIME 返回（AC-13 离线命中零新请求）
    if let Ok(bytes) = std::fs::read(&path) {
        if let Some(mime) = sniff_image_mime(&bytes) {
            touch(&path);
            return Ok(S3GetImageResult {
                mime: mime.to_string(),
                data_base64: super::misc::base64_encode(&bytes),
                cached: true,
            });
        }
        // 内容不再是可识别图片（损坏/半写残留）→ 删除走网络
        let _ = std::fs::remove_file(&path);
    }
    let client = guarded_client()?;
    let mut resp = client.get(&url).send().await.map_err(network_error)?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        // 读侧失败静默降级交前端占位（009 规则 10）——错误串仅作日志线索
        return Err(format!("E6005:{}", status));
    }
    if let Some(cl) = resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        && cl > MAX_IMAGE_BYTES
    {
        return Err(format!("E6003:{}", cl));
    }
    // 分块累加上限钳制（无 Content-Length 头的流式响应同口径防超大体）
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("E6004:read:{}", e.without_url()))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err(format!("E6003:{}", bytes.len()));
        }
    }
    // 只缓存可识别图片（错误页 XML/HTML 不入缓存，下次渲染自然重试）
    let mime = sniff_image_mime(&bytes)
        .map(|m| m.to_string())
        .or_else(|| {
            resp.headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("image/").map(|_| v.to_string()))
        })
        .ok_or_else(|| "E6007:not an image".to_string())?;
    // 原子落盘：tmp + rename（并发同 URL 双写不致半写可见）
    let tmp = dir.join(format!("{key}.tmp"));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("E6011:cache:{e}"))?;
    match std::fs::rename(&tmp, &path) {
        Ok(()) => {}
        // Windows 上目标被并发命中读取时 rename 可能失败——退化为覆盖写
        Err(_) => std::fs::write(&path, &bytes).map_err(|e| format!("E6011:cache:{e}"))?,
    }
    trim_cache_lru(&dir, IMAGE_CACHE_CAP);
    Ok(S3GetImageResult {
        mime,
        data_base64: super::misc::base64_encode(&bytes),
        cached: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_errors_do_not_expose_request_urls() {
        let sensitive_url = reqwest::Url::parse(
            "https://sample-user:sample-password@example.test/private?token=sample-token#sample-fragment",
        )
        .unwrap();
        let err = reqwest::Client::new()
            .get("http://[")
            .build()
            .unwrap_err()
            .with_url(sensitive_url);
        let message = network_error(err);
        assert!(message.starts_with("E6004:"));
        for sensitive in [
            "sample-user",
            "sample-password",
            "sample-token",
            "sample-fragment",
            "example.test",
            "/private",
        ] {
            assert!(!message.contains(sensitive));
        }
    }

    #[test]
    fn response_errors_keep_status_without_echoing_server_content() {
        assert_eq!(response_error(403), "E6006:403");
        assert_eq!(response_error(404), "E6005:404");
        assert_eq!(response_error(500), "E6005:500");
    }

    /// AWS General Reference 官方示例（sigv4-signed-request-examples）：
    /// GET https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08 全量锁——
    /// 规范请求哈希 / 最终签名两段均为官方发布值（009 AC-10）。
    #[test]
    fn sigv4_official_iam_vector() {
        let headers = vec![
            (
                "content-type".to_string(),
                "application/x-www-form-urlencoded; charset=utf-8".to_string(),
            ),
            ("host".to_string(), "iam.amazonaws.com".to_string()),
            ("x-amz-date".to_string(), "20150830T123600Z".to_string()),
        ];
        let r = SigV4 {
            method: "GET",
            canonical_uri: "/",
            query: "Action=ListUsers&Version=2010-05-08",
            headers: &headers,
            payload_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            amz_date: "20150830T123600Z",
            date_stamp: "20150830",
            region: "us-east-1",
            service: "iam",
            access_key: "AKIDEXAMPLE",
            secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        };
        // 规范请求与待签串的官方发布哈希（两中间值一并对锁——签名碰撞时中间值定位错误层）
        let canonical = sigv4_canonical_request(&r);
        assert_eq!(
            hex_lower(&sha256(canonical.as_bytes())),
            "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59",
            "canonical request hash (official)"
        );
        let auth = sigv4_authorization(&r);
        assert!(
            auth.ends_with(
                ", Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
            ),
            "official signature, got: {auth}"
        );
        assert!(auth.starts_with(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date,"
        ));
    }

    /// 生产签名面冻结向量（S3 PUT + UNSIGNED-PAYLOAD，本仓 s3_put_object 实际头集）：
    /// 输入构造与官方向量同一实现路径，期望值经独立 Python 参照实现（同规范步骤、
    /// 官方向量校准）冻结；path 风格 / virtual-host 风格 / 含中文与空格对象键三形。
    /// 修正旧冻结期望：依据 AWS S3 文档 sig-v4-header-based-auth 的 Task 1–3，
    /// CanonicalHeaders 末尾换行后仍有字段分隔换行，末行使用字面量 UNSIGNED-PAYLOAD；
    /// 对规范请求取 SHA256，再以日期 / 区域 / 服务 / aws4_request 派生密钥签待签串。
    /// 三组签名由 Python hashlib / hmac 独立重算，并以官方 IAM 向量校准；规范见：
    /// https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
    #[test]
    fn sigv4_s3_put_frozen_vectors() {
        let sign_put = |uri: &str, host: &str| {
            let headers = vec![
                ("host".to_string(), host.to_string()),
                (
                    "x-amz-content-sha256".to_string(),
                    "UNSIGNED-PAYLOAD".to_string(),
                ),
                ("x-amz-date".to_string(), "20261017T083000Z".to_string()),
            ];
            sigv4_authorization(&SigV4 {
                method: "PUT",
                canonical_uri: uri,
                query: "",
                headers: &headers,
                payload_hash: "UNSIGNED-PAYLOAD",
                amz_date: "20261017T083000Z",
                date_stamp: "20261017",
                region: "cn-north-1",
                service: "s3",
                access_key: "AKIDEXAMPLE",
                secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            })
        };
        assert!(
            sign_put(
                "/ZiEdit-bucket/2026-10-17/e3b0c44298fc.png",
                "s3.example.local"
            )
            .ends_with(
                "Signature=88bf04a7bf30705c6b436e5f5fd99251a2e6e1a64d8f8df2705b6de6d8acce44"
            )
        );
        assert!(
            sign_put(
                "/img/2026-10-17/e3b0c44298fc.png",
                "ZiEdit-bucket.s3.example.local"
            )
            .ends_with(
                "Signature=0329ab41fc59482126a04dacf40a7643e5113077bab4c76be6aaae517f3712dc"
            )
        );
        assert!(
            sign_put(
                "/ZiEdit-bucket/img/2026-10-17/%E6%88%AA%E5%9B%BE%20A.png",
                "s3.example.local"
            )
            .ends_with(
                "Signature=ddd6e68abcae9e90a42a510a44bafc8dd5f4e6670e539cbcb33e8303ed252c1d"
            )
        );
    }

    #[test]
    fn uri_encode_sigv4_rules() {
        // 非保留字符原样；空格 %20（非 '+'）；UTF-8 百分号大写；斜杠按模式
        assert_eq!(uri_encode("aA1-._~", true), "aA1-._~");
        assert_eq!(uri_encode("a b", true), "a%20b");
        assert_eq!(uri_encode("截图 A.png", true), "%E6%88%AA%E5%9B%BE%20A.png");
        assert_eq!(
            uri_encode("img/截图.png", true),
            "img/%E6%88%AA%E5%9B%BE.png"
        );
        assert_eq!(uri_encode("a/b", false), "a%2Fb");
    }

    #[test]
    fn amz_timestamps_civil_calendar() {
        // 期望值经 Python datetime（权威时区库）核对：纪元 / 闰日 / 2100 世纪非闰年
        assert_eq!(
            amz_timestamps_from_unix(0),
            ("19700101T000000Z".into(), "19700101".into())
        );
        assert_eq!(
            amz_timestamps_from_unix(951782400),
            ("20000229T000000Z".into(), "20000229".into())
        );
        assert_eq!(
            amz_timestamps_from_unix(4102444800),
            ("21000101T000000Z".into(), "21000101".into())
        );
    }

    #[test]
    fn build_put_parts_styles_and_port() {
        // path 风格（默认）：bucket 进路径
        let (url, host, cu) = build_put_parts(
            "https://s3.example.local",
            "bucket",
            "2026-10-17/ab.png",
            "path",
        )
        .unwrap();
        assert_eq!(url, "https://s3.example.local/bucket/2026-10-17/ab.png");
        assert_eq!(host, "s3.example.local");
        assert_eq!(cu, "/bucket/2026-10-17/ab.png");
        // virtual-host：bucket 进 host
        let (url, host, cu) = build_put_parts(
            "https://s3.example.local",
            "bucket",
            "2026-10-17/ab.png",
            "virtual-host",
        )
        .unwrap();
        assert_eq!(url, "https://bucket.s3.example.local/2026-10-17/ab.png");
        assert_eq!(host, "bucket.s3.example.local");
        assert_eq!(cu, "/2026-10-17/ab.png");
        // 非默认端口：Host 头与 URL 一致携带
        let (url, host, _) =
            build_put_parts("http://minio.local:9000", "b", "k.png", "path").unwrap();
        assert_eq!(url, "http://minio.local:9000/b/k.png");
        assert_eq!(host, "minio.local:9000");
        // 对象键非 ASCII：URL 与规范 URI 同用 SigV4 编码
        let (url, _, cu) =
            build_put_parts("https://s3.example.local", "b", "截图 A.png", "path").unwrap();
        assert_eq!(url, "https://s3.example.local/b/%E6%88%AA%E5%9B%BE%20A.png");
        assert_eq!(cu, "/b/%E6%88%AA%E5%9B%BE%20A.png");
        // 非法 bucket（空 / 含路径分隔符）拒绝
        assert!(build_put_parts("https://s3.example.local", "", "k", "path").is_err());
        assert!(build_put_parts("https://s3.example.local", "a/b", "k", "path").is_err());
    }

    #[test]
    fn validate_put_guards_before_connection() {
        // E6002：明文 http 未豁免（校验发生在任何网络动作之前——纯函数即证明）
        assert_eq!(
            validate_put("http://minio.local", false, 10),
            Err("E6002".to_string())
        );
        assert!(validate_put("http://minio.local", true, 10).is_ok());
        assert!(validate_put("https://s3.example.local", false, 10).is_ok());
        // E6003：超 20MB 上传前拒绝
        assert!(validate_put("https://s3.example.local", false, MAX_OBJECT_BYTES).is_ok());
        assert!(
            validate_put("https://s3.example.local", false, MAX_OBJECT_BYTES + 1)
                .unwrap_err()
                .starts_with("E6003:")
        );
        // 非法端点（无 scheme）
        assert!(validate_put("minio.local", false, 10).is_err());
    }

    #[test]
    fn host_allowed_strict_equality() {
        assert!(
            host_allowed(
                "https://cdn.example.org/a/b.png",
                "https://cdn.example.org/"
            )
            .unwrap()
        );
        // 大小写归一
        assert!(host_allowed("https://CDN.Example.org/a.png", "https://cdn.example.org").unwrap());
        // 端口参与全等
        assert!(
            !host_allowed(
                "https://cdn.example.org:8443/a.png",
                "https://cdn.example.org"
            )
            .unwrap()
        );
        // 子域/他域一律拒绝（AC-12 零请求边界）
        assert!(
            !host_allowed(
                "https://evil.com/cdn.example.org/a.png",
                "https://cdn.example.org"
            )
            .unwrap()
        );
        assert!(
            !host_allowed("https://x.cdn.example.org/a.png", "https://cdn.example.org").unwrap()
        );
    }

    #[test]
    fn sniff_and_cache_key() {
        assert_eq!(
            sniff_image_mime(&[0x89, b'P', b'N', b'G', 0, 0]),
            Some("image/png")
        );
        assert_eq!(
            sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some("image/jpeg")
        );
        assert_eq!(sniff_image_mime(b"GIF89a"), Some("image/gif"));
        assert_eq!(
            sniff_image_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(
            sniff_image_mime(b"<svg xmlns=\"x\"></svg>"),
            Some("image/svg+xml")
        );
        assert_eq!(
            sniff_image_mime(b"<?xml version=\"1.0\"?><svg/>"),
            Some("image/svg+xml")
        );
        // AVIF：偏移 4..8 = "ftyp"、8..12 = 主 brand "avif"
        assert_eq!(
            sniff_image_mime(&[
                0x00, 0x00, 0x00, 0x20, b'f', b't', b'y', b'p', b'a', b'v', b'i', b'f', 0x00
            ]),
            Some("image/avif")
        );
        // S3 错误页 XML（根非 <svg>）不识别——不入缓存
        assert_eq!(
            sniff_image_mime(b"<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code></Error>"),
            None
        );
        assert_eq!(sniff_image_mime(b"hello"), None);
        // 缓存键 = URL SHA-256 前 16 位；空串为 SHA-256 公知向量
        assert_eq!(cache_key(""), "e3b0c44298fc1c14");
        assert_eq!(cache_key("https://x/a.png").len(), 16);
        assert_ne!(cache_key("https://x/a.png"), cache_key("https://x/b.png"));
    }

    #[test]
    fn cache_lru_trim_oldest_first() {
        let dir = std::env::temp_dir().join("ZiEdit-s3-lru-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 三个合法键文件（各 10B）+ 一个 tmp 写入中文件（不应参与统计/删除）
        for (i, name) in ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"]
            .iter()
            .enumerate()
        {
            let p = dir.join(name);
            std::fs::write(&p, vec![0u8; 10]).unwrap();
            // i 越大越新（aaaa 最旧）
            let t = std::time::SystemTime::now() + std::time::Duration::from_secs(i as u64 * 100);
            let f = std::fs::File::options().append(true).open(&p).unwrap();
            f.set_modified(t).unwrap();
        }
        std::fs::write(dir.join("dddddddddddddddd.tmp"), vec![0u8; 10]).unwrap();
        // 上限 25B < 30B：最旧的 aaaa 被逐出；tmp 不动
        trim_cache_lru(&dir, 25);
        assert!(!dir.join("aaaaaaaaaaaaaaaa").exists(), "oldest evicted");
        assert!(dir.join("bbbbbbbbbbbbbbbb").exists());
        assert!(dir.join("dddddddddddddddd.tmp").exists(), "tmp untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_roundtrip_with_misc() {
        // 上传路径 base64 解码与 misc 侧编码互逆（含空/填充边界）
        for case in [
            "" as &str,
            "f",
            "fo",
            "foo",
            "foob",
            "fooba",
            "foobar",
            "\u{4e2d}\u{6587}",
        ] {
            let enc = super::super::misc::base64_encode(case.as_bytes());
            let dec = super::super::misc::base64_decode(&enc).unwrap();
            assert_eq!(dec, case.as_bytes());
        }
        assert!(super::super::misc::base64_decode("!!!").is_err());
    }
}
