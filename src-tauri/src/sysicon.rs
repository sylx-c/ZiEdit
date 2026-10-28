//! sysicon —— 树节点系统图标（001 规则 15，P2/W2 清偿）
//! Windows：SHGetFileInfoW 按扩展名取关联图标（SHGFI_USEFILEATTRIBUTES——不要求文件存在），
//! HICON → 32bpp BGRA → BMP 文件字节 → base64 data URL（Chromium 原生支持 BMP data URL，
//! 零新依赖：不引 PNG 编码器）。非 Windows 平台返回 None，前端回退通用 SVG 图标。
//! 语义：**按扩展名**取一次（前端按扩展名缓存，同扩展名图标天然相同），不按逐文件取
//! ——树可能物化成千上万节点，逐文件 IPC 反而违背懒加载初衷。

use crate::error::ZiEditError;

/// 取扩展名的系统关联图标（32×32），返回 `data:image/bmp;base64,...`；无关联/不支持返回 None。
/// `ext` 形如 "txt"（不含点）；空串按无扩展名处理。
/// async + spawn_blocking：SHGetFileInfoW + GetDIBits + base64 不冻结主线程
#[tauri::command]
pub async fn tree_file_icon(ext: String) -> Result<Option<String>, ZiEditError> {
    tauri::async_runtime::spawn_blocking(move || {
        let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
        if ext.is_empty() || !ext.chars().all(|c| c.is_ascii_alphanumeric()) || ext.len() > 39 {
            return Ok(None);
        }
        Ok(icon_for_ext(&ext))
    })
    .await
    .map_err(|e| ZiEditError::Msg(e.to_string()))?
}

#[cfg(windows)]
fn icon_for_ext(ext: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    let file = format!("x.{ext}");
    let wide: Vec<u16> = std::ffi::OsStr::new(&file)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: SHGetFileInfoW 读 wide（含 NUL 终止，长度按元素计）；结构体为零初始化 POD。
    let mut info: SHFILEINFOW = unsafe { std::mem::zeroed() };
    let res = unsafe {
        SHGetFileInfoW(
            wide.as_ptr(),
            FILE_ATTRIBUTE_NORMAL,
            &mut info,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES,
        )
    };
    if res == 0 || info.hIcon.is_null() {
        return None;
    }
    let bmp = unsafe { icon_to_bmp(info.hIcon) };
    unsafe { DestroyIcon(info.hIcon) };
    bmp.map(|b| {
        format!(
            "data:image/bmp;base64,{}",
            crate::commands::misc::base64_encode(&b)
        )
    })
}

/// HICON → BMP 文件字节（32bpp 顶向下、预乘 BGRA 原样保留——浏览器按 straight alpha 合成
/// 略有色偏，可接受；掩码位图（hbmColor=None）返回 None）。
///
/// # Safety
/// hIcon 必须是有效的 GDI 图标句柄；内部只读句柄并释放临时 GDI 对象。
#[cfg(windows)]
unsafe fn icon_to_bmp(hicon: *mut core::ffi::c_void) -> Option<Vec<u8>> {
    let mut icon = ICONINFO {
        fIcon: 0,
        xHotspot: 0,
        yHotspot: 0,
        hbmMask: std::ptr::null_mut(),
        hbmColor: std::ptr::null_mut(),
    };
    // SAFETY: icon 为零初始化 POD，GetIconInfo 成功时填充全部句柄。
    if unsafe { GetIconInfo(hicon, &mut icon) } == 0 {
        return None;
    }
    let result = (|| -> Option<Vec<u8>> {
        if icon.hbmColor.is_null() {
            return None; // 单色掩码图标：树场景罕见，回退 SVG
        }
        let dc = unsafe { GetDC(std::ptr::null_mut()) };
        if dc.is_null() {
            return None;
        }
        let out = (|| -> Option<Vec<u8>> {
            let mut bmp = BITMAP {
                bmType: 0,
                bmWidth: 0,
                bmHeight: 0,
                bmWidthBytes: 0,
                bmPlanes: 0,
                bmBitsPixel: 0,
                bmBits: std::ptr::null_mut(),
            };
            // SAFETY: hbmColor 来自 GetIconInfo；bmp 为 POD 出参。
            if unsafe {
                GetObjectW(
                    icon.hbmColor,
                    std::mem::size_of::<BITMAP>() as i32,
                    (&mut bmp as *mut BITMAP).cast(),
                )
            } == 0
            {
                return None;
            }
            let (w, h) = (bmp.bmWidth, bmp.bmHeight);
            if w <= 0 || h <= 0 || w > 256 || h > 256 {
                return None;
            }
            // 顶向下（正高）32bpp DIB
            let mut bi = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // 负高 = top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0, // BI_RGB
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            };
            let stride = (w as usize) * 4;
            let mut px = vec![0u8; stride * h as usize];
            // SAFETY: dc/hbmColor 有效；bi 为 POD 入参，px 缓冲按 stride×h 足够。
            if unsafe {
                GetDIBits(
                    dc,
                    icon.hbmColor,
                    0,
                    h as u32,
                    px.as_mut_ptr().cast(),
                    &mut bi,
                    DIB_RGB_COLORS,
                )
            } == 0
            {
                return None;
            }
            // BMP 文件头 + DIB 头 + 像素
            let mut out = Vec::with_capacity(14 + 40 + px.len());
            out.extend_from_slice(b"BM");
            out.extend_from_slice(&((14 + 40 + px.len()) as u32).to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&54u32.to_le_bytes());
            let hdr: [u8; 40] = unsafe { std::mem::transmute(bi) };
            out.extend_from_slice(&hdr);
            out.extend_from_slice(&px);
            Some(out)
        })();
        unsafe { ReleaseDC(std::ptr::null_mut(), dc) };
        out
    })();
    // SAFETY: GetIconInfo 取得的两个位图句柄归调用方所有，用毕必须释放。
    unsafe {
        if !icon.hbmColor.is_null() {
            DeleteObject(icon.hbmColor);
        }
        if !icon.hbmMask.is_null() {
            DeleteObject(icon.hbmMask);
        }
    }
    result
}

#[cfg(windows)]
mod win {
    // 最小声明面：仅本模块用到的六个 GDI/Shell 入口，避免整份 windows-rs 依赖。
    #![allow(non_snake_case, non_camel_case_types, clippy::upper_case_acronyms)]

    pub type HANDLE = *mut core::ffi::c_void;

    #[repr(C)]
    pub struct SHFILEINFOW {
        pub hIcon: HANDLE,
        pub iIcon: i32,
        pub dwAttributes: u32,
        pub szDisplayName: [u16; 260],
        pub szTypeName: [u16; 80],
    }

    #[repr(C)]
    pub struct ICONINFO {
        pub fIcon: i32,
        pub xHotspot: u32,
        pub yHotspot: u32,
        pub hbmMask: HANDLE,
        pub hbmColor: HANDLE,
    }

    #[repr(C)]
    pub struct BITMAP {
        pub bmType: i32,
        pub bmWidth: i32,
        pub bmHeight: i32,
        pub bmWidthBytes: u32,
        pub bmPlanes: u16,
        pub bmBitsPixel: u16,
        pub bmBits: HANDLE,
    }

    #[repr(C)]
    pub struct BITMAPINFOHEADER {
        pub biSize: u32,
        pub biWidth: i32,
        pub biHeight: i32,
        pub biPlanes: u16,
        pub biBitCount: u16,
        pub biCompression: u32,
        pub biSizeImage: u32,
        pub biXPelsPerMeter: i32,
        pub biYPelsPerMeter: i32,
        pub biClrUsed: u32,
        pub biClrImportant: u32,
    }

    pub const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    pub const SHGFI_ICON: u32 = 0x100;
    pub const SHGFI_LARGEICON: u32 = 0x0;
    pub const SHGFI_USEFILEATTRIBUTES: u32 = 0x10;
    pub const DIB_RGB_COLORS: u32 = 0;

    #[link(name = "shell32")]
    unsafe extern "system" {
        pub fn SHGetFileInfoW(
            pszPath: *const u16,
            dwFileAttributes: u32,
            psfi: *mut SHFILEINFOW,
            cbFileInfo: u32,
            uFlags: u32,
        ) -> usize;
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        pub fn DestroyIcon(hIcon: HANDLE) -> i32;
        pub fn GetIconInfo(hIcon: HANDLE, piconinfo: *mut ICONINFO) -> i32;
        pub fn GetDC(hwnd: HANDLE) -> HANDLE;
        pub fn ReleaseDC(hwnd: HANDLE, hdc: HANDLE) -> i32;
    }

    #[link(name = "gdi32")]
    unsafe extern "system" {
        pub fn GetObjectW(h: HANDLE, c: i32, pv: *mut core::ffi::c_void) -> i32;
        pub fn GetDIBits(
            hdc: HANDLE,
            hbm: HANDLE,
            start: u32,
            cLines: u32,
            lpvBits: *mut core::ffi::c_void,
            lpbmi: *mut BITMAPINFOHEADER,
            usage: u32,
        ) -> i32;
        pub fn DeleteObject(h: HANDLE) -> i32;
    }
}
#[cfg(windows)]
use win::*;

#[cfg(not(windows))]
fn icon_for_ext(_ext: &str) -> Option<String> {
    None // 非 Windows：无 Shell 关联图标，前端回退 SVG
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext_sanitized() {
        // 越界/怪异输入一律 None（不发起 Shell 调用）
        let r = tauri::async_runtime::block_on(tree_file_icon("".into())).unwrap();
        assert!(r.is_none());
        let r = tauri::async_runtime::block_on(tree_file_icon(".exe".into())).unwrap();
        if cfg!(windows) {
            // Windows 上 .exe 有关联图标（形状不锁，只锁 BMP data URL 前缀）
            if let Some(url) = r {
                assert!(url.starts_with("data:image/bmp;base64,"));
            }
        } else {
            assert!(r.is_none());
        }
    }

    #[cfg(windows)]
    #[test]
    fn bmp_header_shape() {
        // 纯函数部分：手工构造 1×1 像素路径没法走（icon_to_bmp 依赖句柄），
        // 以真实 .txt 图标锁定文件头形状：BM 魔数 + 偏移 14+40 + DIB 头 32bpp 顶向下。
        if let Some(url) = icon_for_ext("txt") {
            let b64 = url.strip_prefix("data:image/bmp;base64,").unwrap();
            let bytes = crate::commands::misc::base64_decode(b64).unwrap();
            assert_eq!(&bytes[0..2], b"BM");
            let data_off = u32::from_le_bytes(bytes[10..14].try_into().unwrap()) as usize;
            assert_eq!(data_off, 54);
            let w = i32::from_le_bytes(bytes[18..22].try_into().unwrap());
            let h = i32::from_le_bytes(bytes[22..26].try_into().unwrap());
            assert!(w > 0 && w <= 256);
            assert!(h < 0 && (-256..=-1).contains(&h), "负高 = 顶向下");
            assert_eq!(u16::from_le_bytes(bytes[28..30].try_into().unwrap()), 32);
        }
    }
}
