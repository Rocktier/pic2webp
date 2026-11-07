//! HEIC / HEIF 解码（1.0.1）
//!
//! 这是 Pic2WebP 唯一一处「格式白名单里有、但 image crate 解不了」的格式。
//! 两端都**只调操作系统自带的解码器**，进程内完成，不随包分发 HEVC 实现：
//!
//! - macOS：`ImageIO / CGImageSource`。系统从 10.13 起原生读 HEIC，WWDC17 §511
//!   原话 "CGImageSource just works"。沙箱里读用户选中的文件与现有 `std::fs`
//!   链路同权限，不需要额外的解码器 dylib。
//! - Windows：`WIC`（Windows Imaging Component）。HEIF 解码器由系统里的
//!   「HEIF 图像扩展 / HEVC 视频扩展」提供，本机没装时 WIC 建不出 decoder，
//!   此时返回 `heic_codec_missing`，前端给可操作的安装提示而不是裸错误码。
//!
//! 为什么不用 libheif：LGPL-3.0 + libde265 LGPL + x265 GPL，随包 dylib 在
//! MAS 沙箱 / 公证 /「可替换」义务下很麻烦，HEVC 专利也绕不开 —— PDF Squeeze
//! 的 Ghostscript AGPL 下架（2026-09-18）是家族里已经付过一次的学费。
//!
//! 约束：本模块输出的 `RgbaImage` **已经按 EXIF 方向转正**，调用方不要再
//! `apply_orientation()`，否则竖拍照片会转两次。色彩统一落成 8-bit sRGB-ish
//! RGBA；HEIC 的 Display P3 / 10-bit / HDR 由系统框架在绘制时做色域映射，
//! 这属于有损降级，已单独列在验收项里。

use image::{DynamicImage, RgbaImage};
use std::path::Path;

/// 后端给前端的稳定错误码：系统里没有可用的 HEIF 解码器。
pub const CODEC_MISSING: &str = "heic_codec_missing";

/// 只按扩展名分流。白名单在 `src/formats.js`，两端必须逐字对齐。
pub fn is_heic_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("heic") | Some("heif")
    )
}

/// EXIF orientation 1..8 → 像素变换。用 image crate 的 imageops，不碰
/// `image::metadata::Orientation` 枚举（版本间变体名不稳定）。
fn apply_exif_orientation(img: RgbaImage, o: u8) -> RgbaImage {
    use image::imageops;
    match o {
        2 => imageops::flip_horizontal(&img),
        3 => imageops::rotate180(&img),
        4 => imageops::flip_vertical(&img),
        5 => imageops::flip_horizontal(&imageops::rotate90(&img)),
        6 => imageops::rotate90(&img),
        7 => imageops::flip_horizontal(&imageops::rotate270(&img)),
        8 => imageops::rotate270(&img),
        _ => img,
    }
}

/// 缩略图路径用：等比缩到 `max_edge` 以内（不超过原尺寸也可以）。
fn fit_within(img: RgbaImage, max_edge: u32) -> RgbaImage {
    if max_edge == 0 || (img.width() <= max_edge && img.height() <= max_edge) {
        return img;
    }
    DynamicImage::ImageRgba8(img)
        .resize(max_edge, max_edge, image::imageops::FilterType::Lanczos3)
        .to_rgba8()
}

pub fn decode(path: &Path, max_edge: Option<u32>) -> Result<RgbaImage, String> {
    let img = platform::decode(path)?;
    Ok(match max_edge {
        Some(n) => fit_within(img, n),
        None => img,
    })
}

/// 主转换的 25 MP 保护要能覆盖 HEIC；读不到就返回 None（退化为不检查），
/// 不许因为读不到尺寸就把文件判成失败。
pub fn dimensions(path: &Path) -> Option<(u32, u32)> {
    platform::dimensions(path)
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS：ImageIO 纯 C ABI。不引入 objc2 / core-foundation 等 crate。
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod platform {
    use super::{CODEC_MISSING, apply_exif_orientation};
    use image::RgbaImage;
    use std::ffi::c_void;
    use std::path::Path;

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFURLRef = *const c_void;
    type CFDictionaryRef = *const c_void;
    type CGImageSourceRef = *const c_void;
    type CGImageRef = *const c_void;
    type CGContextRef = *const c_void;
    type CGColorSpaceRef = *const c_void;

    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_CF_URL_POSIX_PATH_STYLE: isize = 0;
    const K_CF_NUMBER_INT_TYPE: isize = 9;
    // kCGImageAlphaNoneSkipLast (5) | kCGBitmapByteOrder32Big (4 << 12)
    // ⇒ 在 little-endian 的 macOS 上，内存布局就是 RGBA8。
    const BITMAP_INFO_RGBA8: u32 = 5 | (4 << 12);

    // 一个 extern 块只挂一个 framework：多 `#[link]` 叠加时 rustc 只认其中一个，
    // 在链接期会缺符号，而本机没有 Rust 工具链、只能靠 CI 暴露（准则 §14 #7）。
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: CFTypeRef);
        fn CFStringCreateWithBytes(
            allocator: CFTypeRef,
            bytes: *const u8,
            num_bytes: isize,
            encoding: u32,
            is_external_rep: u8,
        ) -> CFStringRef;
        fn CFURLCreateWithFileSystemPath(
            allocator: CFTypeRef,
            file_path: CFStringRef,
            path_style: isize,
            is_directory: u8,
        ) -> CFURLRef;
        fn CFDictionaryGetValue(dict: CFDictionaryRef, key: CFTypeRef) -> CFTypeRef;
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFNumberGetValue(number: CFTypeRef, number_type: isize, value: *mut c_void) -> u8;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGImageGetWidth(image: CGImageRef) -> usize;
        fn CGImageGetHeight(image: CGImageRef) -> usize;
        fn CGColorSpaceCreateDeviceRGB() -> CGColorSpaceRef;
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: CGColorSpaceRef,
            bitmap_info: u32,
        ) -> CGContextRef;
        fn CGContextDrawImage(context: CGContextRef, rect: CGRect, image: CGImageRef);
        fn CGContextRelease(context: CGContextRef);
        fn CGColorSpaceRelease(space: CGColorSpaceRef);
    }

    #[link(name = "ImageIO", kind = "framework")]
    unsafe extern "C" {
        fn CGImageSourceCreateWithURL(
            url: CFURLRef,
            options: CFDictionaryRef,
        ) -> CGImageSourceRef;
        fn CGImageSourceGetCount(source: CGImageSourceRef) -> usize;
        fn CGImageSourceCreateImageAtIndex(
            source: CGImageSourceRef,
            index: usize,
            options: CFDictionaryRef,
        ) -> CGImageRef;
        fn CGImageSourceCopyPropertiesAtIndex(
            source: CGImageSourceRef,
            index: usize,
            options: CFDictionaryRef,
        ) -> CFDictionaryRef;
        static kCGImagePropertyOrientation: CFStringRef;
        static kCGImagePropertyPixelWidth: CFStringRef;
        static kCGImagePropertyPixelHeight: CFStringRef;
    }

    /// 路径 → CFURL。ImageIO 只认 CFURL，不直接吃 POSIX 路径字符串。
    fn make_url(path: &Path) -> Option<CFURLRef> {
        let s = path.to_string_lossy();
        unsafe {
            let cf_path = CFStringCreateWithBytes(
                std::ptr::null(),
                s.as_bytes().as_ptr(),
                s.as_bytes().len() as isize,
                K_CF_STRING_ENCODING_UTF8,
                0,
            );
            if cf_path.is_null() {
                return None;
            }
            let url = CFURLCreateWithFileSystemPath(
                std::ptr::null(),
                cf_path,
                K_CF_URL_POSIX_PATH_STYLE,
                0,
            );
            CFRelease(cf_path);
            if url.is_null() { None } else { Some(url) }
        }
    }

    /// 把 CGImage 重绘进一块固定的 RGBA8 缓冲。
    /// 不能直接读 `CGImageGetDataProvider` —— HEIC 解码出来的像素格式、
    /// 字节序、alpha 预乘状态都不保证，重绘是唯一确定的路径。
    unsafe fn cgimage_to_rgba(image: CGImageRef) -> Option<RgbaImage> {
        let w = CGImageGetWidth(image);
        let h = CGImageGetHeight(image);
        if w == 0 || h == 0 || w > 20_000 || h > 20_000 {
            return None;
        }
        let stride = w.checked_mul(4)?;
        let len = stride.checked_mul(h)?;
        let mut buf = vec![0u8; len];
        let space = CGColorSpaceCreateDeviceRGB();
        if space.is_null() {
            return None;
        }
        let ctx = CGBitmapContextCreate(
            buf.as_mut_ptr() as *mut c_void,
            w,
            h,
            8,
            stride,
            space,
            BITMAP_INFO_RGBA8,
        );
        if !ctx.is_null() {
            CGContextDrawImage(
                ctx,
                CGRect {
                    origin: CGPoint { x: 0.0, y: 0.0 },
                    size: CGSize {
                        width: w as f64,
                        height: h as f64,
                    },
                },
                image,
            );
            CGContextRelease(ctx);
        }
        CGColorSpaceRelease(space);
        if ctx.is_null() {
            return None;
        }
        RgbaImage::from_raw(w as u32, h as u32, buf)
    }

    /// 从 ImageIO 属性字典里读一个 CFNumber；读不到就返回 None。
    unsafe fn cfnumber_u32(dict: CFDictionaryRef, key: CFStringRef) -> Option<u32> {
        if dict.is_null() {
            return None;
        }
        let v = CFDictionaryGetValue(dict, key);
        if v.is_null() || CFGetTypeID(v) != CFNumberGetTypeID() {
            return None;
        }
        let mut n: i32 = 0;
        let ok = CFNumberGetValue(
            v,
            K_CF_NUMBER_INT_TYPE,
            &mut n as *mut i32 as *mut c_void,
        );
        if ok == 0 { None } else { u32::try_from(n).ok() }
    }

    pub(super) fn dimensions(path: &Path) -> Option<(u32, u32)> {
        unsafe {
            let url = make_url(path)?;
            let src = CGImageSourceCreateWithURL(url, std::ptr::null());
            CFRelease(url);
            if src.is_null() || CGImageSourceGetCount(src) == 0 {
                if !src.is_null() {
                    CFRelease(src);
                }
                return None;
            }
            let props = CGImageSourceCopyPropertiesAtIndex(src, 0, std::ptr::null());
            let pair = cfnumber_u32(props, kCGImagePropertyPixelWidth)
                .zip(cfnumber_u32(props, kCGImagePropertyPixelHeight));
            if !props.is_null() {
                CFRelease(props);
            }
            CFRelease(src);
            pair
        }
    }

    pub(super) fn decode(path: &Path) -> Result<RgbaImage, String> {
        unsafe {
            let url = make_url(path)
                .ok_or_else(|| format!("heic_decode_fail:bad_path:{}", path.display()))?;
            let src = CGImageSourceCreateWithURL(url, std::ptr::null());
            CFRelease(url);
            if src.is_null() {
                return Err(format!("{CODEC_MISSING}:source"));
            }
            if CGImageSourceGetCount(src) == 0 {
                CFRelease(src);
                return Err(format!("{CODEC_MISSING}:no_frame"));
            }

            // 不做「内嵌缩略图」捷径。两条理由：
            // ① 主转换和缩略图共用本函数，一旦优先取内嵌图，转换出来的 WebP
            //    会是一张 320 px 的小图（D-121 同型的「规格对、内容是空壳」）；
            // ② 内嵌缩略图是否已应用 EXIF 方向由编码方决定，不能假设。
            // 全解码 + 方向修正是唯一确定的语义；缩略图慢一点，留到 1.0.2
            // 再用 CGImageSourceCreateThumbnailAtIndex 做独立优化。
            let image = CGImageSourceCreateImageAtIndex(src, 0, std::ptr::null());
            if image.is_null() {
                CFRelease(src);
                // 走到这里 = 系统里没有这个编码的解码器（或被沙箱挡住）。
                return Err(format!("{CODEC_MISSING}:cgimage"));
            }
            let props = CGImageSourceCopyPropertiesAtIndex(src, 0, std::ptr::null());
            let orientation = cfnumber_u32(props, kCGImagePropertyOrientation)
                .unwrap_or(1)
                .clamp(1, 8) as u8;
            if !props.is_null() {
                CFRelease(props);
            }
            let rgba = cgimage_to_rgba(image);
            CFRelease(image);
            CFRelease(src);
            let img = rgba.ok_or("heic_decode_fail:bitmap_context")?;
            Ok(apply_exif_orientation(img, orientation))
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows：WIC。`windows` crate 本来就在依赖树里（Tauri 传递依赖），
// 这里只多开几个官方绑定的 feature，不引入任何解码实现。
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    use super::{CODEC_MISSING, apply_exif_orientation};
    use image::RgbaImage;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows::Win32::Foundation::GENERIC_READ;
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PropVariantClear};
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    };
    use windows::Win32::System::Variant::{VT_UI2, VT_UI4};
    use windows::core::{IUnknown, PCWSTR};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// WIC 只在 COM 已初始化的线程上工作。Tauri 的 WebView2 通常已经初始化，
    /// 这里再调一次是幂等的（返回 S_FALSE / RPC_E_CHANGED_MODE 都忽略）。
    fn ensure_com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
    }

    fn factory() -> Result<IWICImagingFactory, String> {
        unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None::<&IUnknown>, CLSCTX_INPROC_SERVER) }
            .map_err(|e| format!("{CODEC_MISSING}:factory:{e}"))
    }

    fn open_frame(
        path: &Path,
    ) -> Result<(IWICImagingFactory, IWICBitmapDecoder, IWICBitmapFrameDecode), String> {
        ensure_com();
        let factory = factory()?;
        let filename = wide_path(path);
        let decoder = unsafe {
            factory.CreateDecoderFromFilename(
                PCWSTR(filename.as_ptr()),
                None,
                GENERIC_READ,
                WICDecodeMetadataCacheOnDemand,
            )
        }
        .map_err(|e| format!("{CODEC_MISSING}:decoder:{e}"))?;
        let frame = unsafe { decoder.GetFrame(0) }
            .map_err(|e| format!("{CODEC_MISSING}:frame:{e}"))?;
        Ok((factory, decoder, frame))
    }

    /// WIC 不自动应用 EXIF 方向；从 metadata 里读 `System.Photo.Orientation`。
    /// 有些 HEIF 解码器不带 metadata，读不到就当 1（不旋转），绝不猜。
    fn orientation(frame: &IWICBitmapFrameDecode) -> u8 {
        let reader = match unsafe { frame.GetMetadataQueryReader() } {
            Ok(r) => r,
            Err(_) => return 1,
        };
        let name = wide("System.Photo.Orientation");
        let mut pv: PROPVARIANT = unsafe { std::mem::zeroed() };
        let ok = unsafe { reader.GetMetadataByName(PCWSTR(name.as_ptr()), &mut pv) }.is_ok();
        let value = if ok {
            unsafe {
                let inner = &pv.Anonymous.Anonymous;
                let vt = inner.vt.0;
                if vt == VT_UI2.0 {
                    inner.Anonymous.uiVal as u32
                } else if vt == VT_UI4.0 {
                    inner.Anonymous.ulVal
                } else {
                    1
                }
            }
        } else {
            1
        };
        unsafe {
            let _ = PropVariantClear(&mut pv);
        }
        if (1..=8).contains(&value) { value as u8 } else { 1 }
    }

    pub(super) fn dimensions(path: &Path) -> Option<(u32, u32)> {
        let (_factory, _decoder, frame) = open_frame(path).ok()?;
        let (mut w, mut h) = (0u32, 0u32);
        unsafe { frame.GetSize(&mut w, &mut h) }.ok()?;
        Some((w, h))
    }

    pub(super) fn decode(path: &Path) -> Result<RgbaImage, String> {
        let (factory, _decoder, frame) = open_frame(path)?;
        let o = orientation(&frame);
        let converter = unsafe { factory.CreateFormatConverter() }
            .map_err(|e| format!("heic_decode_fail:converter:{e}"))?;
        // 32bppBGRA 是 WIC 里所有 codec 都保证能转到的格式。
        unsafe {
            converter.Initialize(
                &frame,
                &GUID_WICPixelFormat32bppBGRA,
                WICBitmapDitherTypeNone,
                None::<&IWICPalette>,
                0.0,
                WICBitmapPaletteTypeMedianCut,
            )
        }
        .map_err(|e| format!("{CODEC_MISSING}:convert:{e}"))?;

        let (mut w, mut h) = (0u32, 0u32);
        unsafe { converter.GetSize(&mut w, &mut h) }
            .map_err(|e| format!("heic_decode_fail:size:{e}"))?;
        let stride = w.checked_mul(4).ok_or("heic_decode_fail:stride")?;
        let len = (stride as usize)
            .checked_mul(h as usize)
            .ok_or("heic_decode_fail:buffer")?;
        let mut buf = vec![0u8; len];
        let rect = WICRect {
            X: 0,
            Y: 0,
            Width: w as i32,
            Height: h as i32,
        };
        unsafe { converter.CopyPixels(&rect, stride, &mut buf) }
            .map_err(|e| format!("heic_decode_fail:pixels:{e}"))?;

        // WIC 给的是 BGRA，image crate / webp 编码器要 RGBA。
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        let img = RgbaImage::from_raw(w, h, buf).ok_or("heic_decode_fail:from_raw")?;
        Ok(apply_exif_orientation(img, o))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::CODEC_MISSING;
    use image::RgbaImage;
    use std::path::Path;

    pub(super) fn dimensions(_path: &Path) -> Option<(u32, u32)> {
        None
    }

    pub(super) fn decode(_path: &Path) -> Result<RgbaImage, String> {
        Err(format!("{CODEC_MISSING}:unsupported_platform"))
    }
}
