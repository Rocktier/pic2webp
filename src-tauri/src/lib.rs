use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use image::ImageReader;
use tauri::{AppHandle, Emitter, Manager, State};
use base64::Engine as _;

// 授权：试用状态与回执验签（单一来源 docs/rocktier/license.rs，规程 FAMILY-LICENSE.md）。
// 写命令的拦截在下方 ensure_write_allowed；Pic2WebP 的写命令只有 start_convert
// （转换产出新文件），其余命令（缩略图/磁盘探测/取消等只读或控制操作）一律不拦。
/// 家族内唯一的产品标识，用作试用记录的副存储命名空间。
///
/// 必须与 `tauri.conf.json` 的 `bundle.identifier` 逐字一致 ——
/// 副存储按它分文件，改了会导致老用户的试用记录读不到（等于白送 7 天）。
/// 改动时两处必须同步。
pub const APP_KEY: &str = "Rocktier.RocktierPic2WebP";

pub mod license;
pub mod trial;

/* ── 授权：试用与激活（见 license.rs 的模块说明）────────────────────── */

/// 试用与授权状态的落盘目录。由 `setup()` 注入。
///
/// 用全局而不是给 start_convert 各加一个参数：那会让命令签名多一个与业务无关的
/// 参数，而它也不是业务状态，读它不需要与转换状态同步。
static LICENSE_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// 供闸门发事件用。setup 注入；即使没注入也照样能拦截，只是界面不会自动弹窗。
static APP_HANDLE: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 当前授权状态。
///
/// 目录未注入（setup 失败）时按"试用中、满额天数"处理 —— 失败方向刻意选**放行**：
/// 一个取不到的目录不该变成一次锁死。
fn current_license() -> crate::license::Status {
    let Some(dir) = LICENSE_DIR.get() else {
        return crate::license::Status::Trialing { days_left: crate::license::TRIAL_DAYS };
    };
    let now = now_secs();
/* 试用起点双写（AppData + 副存储）并按机器指纹判定，
       见 trial.rs 的模块说明。app_key 用 bundle identifier ——
       家族内唯一，避免两个产品的副存储互相覆盖。 */
    let started = crate::trial::ensure_started(
        dir,
        crate::APP_KEY,
        now,
        &crate::trial::machine_fingerprint(),
    );
    // 只认本单品与全家桶的回执：别人的回执即使验签通过，也不是本应用的授权。
    let receipt = crate::license::read_valid_receipt(dir, crate::license::PUBLIC_KEY_B64)
        .filter(crate::license::accepts);
    crate::license::status_from(Some(started), receipt.as_ref(), now)
}

/// 写操作的统一闸门。
///
/// 在**命令层**拦，而不是在每个界面路径上判断：界面路径会随功能增长而增加，漏掉一条
/// 就是一道缝；命令层是所有写操作的必经之路。Pic2WebP 的写命令只有 start_convert，
/// 读操作（缩略图、体积探测、目录判断）一律不拦。
///
/// 错误码固定为 `LICENSE_EXPIRED`，前端凭它弹购买/激活框。
fn ensure_write_allowed() -> Result<(), String> {
    if current_license().allows_write(crate::license::enforced()) {
        return Ok(());
    }
    // 让界面主动知道"被拦下了"，而不是在每个动作的 catch 里各判一次错误码 ——
    // 那种写法漏掉一处，用户看到的就只是一个没有解释的失败。
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("license-expired", ());
    }
    Err("LICENSE_EXPIRED".to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseInfo {
    /// `trial` / `expired` / `licensed`。
    pub status: String,
    /// 仅 `trial` 时有意义。
    pub days_left: i64,
    /// 仅 `licensed` 时有值（`WP` 单品 / `FL` 全家桶）。
    pub product: Option<String>,
    /// 当前是否真的会拦截写操作（渠道 + 公钥 + 总开关三者决定）。
    pub enforcing: bool,
    /// `direct`（官网直链）/ `store`（微软商店）。
    pub channel: String,
    /// 本构建是否已配置验签公钥。
    ///
    /// 没配置时**任何人都激活不了**（回执必然验不过）。界面据此如实说明，而不是
    /// 拿"激活码未被接受"去搪塞一位已经付过钱的用户。
    pub activation_configured: bool,
}

fn license_info() -> LicenseInfo {
    let status = current_license();
    LicenseInfo {
        status: status.as_str().to_string(),
        days_left: match &status {
            crate::license::Status::Trialing { days_left } => *days_left,
            _ => 0,
        },
        product: match &status {
            crate::license::Status::Licensed { product } => Some(product.clone()),
            _ => None,
        },
        enforcing: crate::license::enforced(),
        channel: crate::license::channel().to_string(),
        activation_configured: !crate::license::PUBLIC_KEY_B64.trim().is_empty(),
    }
}

/// 供界面展示：剩余试用天数 / 是否已激活 / 当前渠道。
///
/// ⚠️ 不能加 `pub`：Pic2WebP 的命令都定义在 crate 根（lib.rs），而 `#[tauri::command]` 对
/// `pub` 命令会生成 `#[macro_export]`，宏被提升到 crate 根后与本地定义同名冲突
/// （E0255，MD 模板验证发现的坑）。
#[tauri::command]
async fn license_status() -> Result<LicenseInfo, String> {
    Ok(license_info())
}

/// 保存服务端签出的回执并立即验签。
///
/// 联网换回执的那一步在**前端**做（`fetch` 到 rocktier.com/api/activate），
/// 为的是不引入 HTTP 客户端依赖；但**验签与落盘必须在这里** —— 前端拿到的只是一段
/// 待验的字符串，能证明它有效与否的只有公钥。
#[tauri::command]
async fn store_receipt(signed: String) -> Result<LicenseInfo, String> {
    let dir = LICENSE_DIR
        .get()
        .ok_or_else(|| "no app data directory".to_string())?;
    let trimmed = signed.trim();
    let receipt = crate::license::verify_receipt(trimmed, crate::license::PUBLIC_KEY_B64)?;

    // 其它单品的码虽然签名有效，但**不属于**本应用 —— 而且不要落盘：落下去以后
    // 会被当成有效回执读回来，等于自己给自己开后门。
    if !crate::license::accepts(&receipt) {
        return Err("LICENSE_WRONG_PRODUCT".to_string());
    }

    crate::license::save_receipt(dir, trimmed)?;
    Ok(license_info())
}

// ─── Data types ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertRequest {
    pub files: Vec<String>,
    pub quality: i32,
    pub recursive: bool,
    pub delete_source: bool,
    pub output_dir: Option<String>,
    pub naming_mode: String,
    // ── New fields (v1.6.0) ──
    #[serde(default)]
    pub lossless: bool,
    #[serde(default)]
    pub strip_exif: bool,
    #[serde(default)]
    pub preserve_structure: bool,
    #[serde(default)]
    pub target_size_kb: Option<u32>,
    #[serde(default)]
    pub resize_enabled: bool,
    #[serde(default)]
    pub resize_width: Option<u32>,
    #[serde(default)]
    pub resize_height: Option<u32>,
    #[serde(default = "default_resize_mode")]
    pub resize_mode: String, // "fit" | "fill" | "shrink"
    // Base dir for preserve_structure (the root input dir)
    #[serde(default)]
    pub base_dir: Option<String>,
}

fn default_resize_mode() -> String { "fit".into() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileProgress {
    pub file: String,
    pub status: String,
    pub message: String,
    pub saved_bytes: i64,
    pub saved_pct: i32,
    /// 实际写入的输出文件路径（done 时携带，供前端“对比”功能使用）
    #[serde(default)]
    pub output_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertResult {
    pub success_count: u32,
    pub skip_count: u32,
    pub fail_count: u32,
    pub total_original: i64,
    pub total_converted: i64,
    pub saved: i64,
    pub saved_pct: i32,
}

// ─── App state ──────────────────────────────────────────────────────

pub struct AppState {
    pub is_converting: Mutex<bool>,
    pub tool_paths: HashMap<String, Option<String>>,
    pub cancel_flag: Arc<AtomicBool>,
    pub should_close: Arc<AtomicBool>,
}

// ─── Tool resolution ────────────────────────────────────────────────

fn tool_exe_name(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{}.exe", name)
    } else {
        name.to_string()
    }
}

fn resolve_tools(app: &AppHandle) -> HashMap<String, Option<String>> {
    let tool_names = ["ffmpeg"];
    let mut map = HashMap::new();
    let mut search_dirs: Vec<PathBuf> = Vec::new();

    if let Ok(res_dir) = app.path().resource_dir() {
        search_dirs.push(res_dir.clone());
        search_dirs.push(res_dir.join("tools"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            search_dirs.push(parent.join("tools"));
        }
    }

    let homebrew_paths = if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]
    } else {
        vec![]
    };

    for name in &tool_names {
        let exe_name = tool_exe_name(name);
        let mut found: Option<String> = None;

        for dir in &search_dirs {
            let candidate = dir.join(&exe_name);
            if candidate.exists() {
                found = Some(candidate.to_string_lossy().to_string());
                break;
            }
        }
        if found.is_none() {
            for dir in &homebrew_paths {
                let candidate = dir.join(&exe_name);
                if candidate.exists() {
                    found = Some(candidate.to_string_lossy().to_string());
                    break;
                }
            }
        }
        if found.is_none() {
            found = which::which(name)
                .ok()
                .map(|p| p.to_string_lossy().to_string());
        }
        map.insert(name.to_string(), found);
    }
    map
}

// ─── Commands ───────────────────────────────────────────────────────

#[tauri::command]
fn cancel_convert(state: State<AppState>) -> Result<(), String> {
    state.cancel_flag.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn force_close(state: State<AppState>, app: AppHandle) -> Result<(), String> {
    state.cancel_flag.store(true, Ordering::Relaxed);
    state.should_close.store(true, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
    Ok(())
}

#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}

/// Free space (bytes) of the volume holding `path`.
///
/// The whole batch lands on one volume, so a pre-flight check here turns a
/// run of per-file `write_fail`s into one honest yes/no before any image is
/// touched.  `path` need not exist yet (the output dir may still have to be
/// created) — we walk up to the first existing ancestor and probe that.
#[tauri::command]
fn check_disk_space(path: String) -> Result<u64, String> {
    let mut probe = Path::new(&path).to_path_buf();
    while !probe.exists() {
        match probe.parent() {
            Some(p) if !p.as_os_str().is_empty() => probe = p.to_path_buf(),
            _ => return Err("path does not exist".into()),
        }
    }
    // is_dir() follows symlinks; a dir is a fine probe point either way.
    if !probe.is_dir() {
        if let Some(p) = probe.parent() { probe = p.to_path_buf(); }
    }
    fs2::available_space(&probe).map_err(|e| e.to_string())
}

#[tauri::command]
fn is_dir(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).is_dir())
}

/// Generate a base64 thumbnail for a file
#[tauri::command]
fn generate_thumbnail(path: String, size: Option<u32>) -> Result<String, String> {
    let sz = size.unwrap_or(48);
    let img = ImageReader::open(&path)
        .map_err(|e| format!("open_fail:{}", e))?
        .with_guessed_format()
        .map_err(|e| format!("format_fail:{}", e))?
        .decode()
        .map_err(|e| format!("decode_fail:{}", e))?;
    let thumb = img.resize(sz, sz, image::imageops::FilterType::Lanczos3);
    let mut buf = Cursor::new(Vec::new());
    thumb.write_to(&mut buf, image::ImageFormat::WebP)
        .map_err(|e| format!("encode_fail:{}", e))?;
    let base64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    Ok(format!("data:image/webp;base64,{}", base64))
}

/// Helper: unlock is_converting and return an Err with the given message.
macro_rules! bail_and_unlock {
    ($guard:expr, $msg:expr) => {{
        *$guard = false;
        drop($guard);
        return Err(($msg).into());
    }};
}

// ─── Image processing helpers ───────────────────────────────────────

/// Apply resize to a DynamicImage
fn apply_resize(img: image::DynamicImage, req: &ConvertRequest) -> image::DynamicImage {
    if !req.resize_enabled {
        return img;
    }
    let (w, h) = (img.width(), img.height());
    let target_w = req.resize_width.unwrap_or(0);
    let target_h = req.resize_height.unwrap_or(0);
    if target_w == 0 && target_h == 0 {
        return img;
    }
    let filter = image::imageops::FilterType::Lanczos3;
    match req.resize_mode.as_str() {
        "shrink" => {
            // Only shrink, never enlarge
            let scale_w = if target_w > 0 { target_w as f64 / w as f64 } else { 1.0 };
            let scale_h = if target_h > 0 { target_h as f64 / h as f64 } else { 1.0 };
            let scale = scale_w.min(scale_h);
            if scale >= 1.0 {
                return img;
            }
            img.resize_exact(
                (w as f64 * scale) as u32,
                (h as f64 * scale) as u32,
                filter,
            )
        }
        "fill" => {
            // Fill exactly target dimensions (may distort aspect ratio)
            if target_w > 0 && target_h > 0 {
                img.resize_exact(target_w, target_h, filter)
            } else {
                img
            }
        }
        _ => {
            // "fit" — fit within target dimensions preserving aspect ratio
            if target_w > 0 && target_h > 0 {
                img.resize(target_w, target_h, filter)
            } else if target_w > 0 {
                img.resize(target_w, u32::MAX, filter)
            } else if target_h > 0 {
                img.resize(u32::MAX, target_h, filter)
            } else {
                img
            }
        }
    }
}

/// Encode image to WebP with given quality (or lossless)
fn encode_webp(img: &image::DynamicImage, quality: i32, lossless: bool) -> Result<Vec<u8>, String> {
    let (w, h) = (img.width(), img.height());
    if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        let enc = webp::Encoder::from_rgba(rgba.as_raw(), w, h);
        if lossless { Ok(enc.encode_lossless().to_vec()) }
        else { enc.encode_simple(false, quality as f32).map(|m| m.to_vec()).map_err(|e| format!("encode_fail:{:?}", e)) }
    } else {
        let rgb = img.to_rgb8();
        let enc = webp::Encoder::from_rgb(rgb.as_raw(), w, h);
        if lossless { Ok(enc.encode_lossless().to_vec()) }
        else { enc.encode_simple(false, quality as f32).map(|m| m.to_vec()).map_err(|e| format!("encode_fail:{:?}", e)) }
    }
}

/// Encode with target size (binary search over quality).
/// 返回 (编码结果, 是否达成了目标体积)。目标不可达时返回**体积最小**的那次编码，
/// 而不是初始 q80 的结果——旧行为会静默输出比可达最小值大一个数量级的文件。
fn encode_target_size(img: &image::DynamicImage, target_kb: u32, lossless: bool) -> Result<(Vec<u8>, bool), String> {
    if lossless {
        return Ok((encode_webp(img, 100, true)?, false));
    }
    let target_bytes = (target_kb as u64) * 1024;
    let mut best: Option<Vec<u8>> = None;       // ≤ 目标的最大质量结果
    let mut fallback: Option<Vec<u8>> = None;   // 超出目标时体积最小的一次结果
    let mut lo = 10i32;
    let mut hi = 100i32;

    while lo <= hi {
        let mid = (lo + hi) / 2;
        let encoded = encode_webp(img, mid, false)?;
        if encoded.len() as u64 <= target_bytes {
            best = Some(encoded);
            lo = mid + 1;
        } else {
            if fallback.as_ref().map_or(true, |f| encoded.len() < f.len()) {
                fallback = Some(encoded);
            }
            hi = mid - 1;
        }
    }
    match (best, fallback) {
        (Some(b), _) => Ok((b, true)),
        (None, Some(f)) => Ok((f, false)),
        (None, None) => encode_webp(img, 80, false).map(|b| (b, false)),
    }
}

// ─── File collection helper ──────────────────────────────────────────

fn collect_convert_files(request: &ConvertRequest) -> Vec<String> {
    let supported = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff"];
    let mut files = Vec::new();
    for file in &request.files {
        let path = Path::new(file);
        if !path.exists() { continue; }
        if path.is_dir() && request.recursive {
            for entry in walkdir::WalkDir::new(path)
                .follow_links(false).into_iter().filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
            {
                let ext = entry.path().extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if supported.contains(&ext.as_str()) {
                    files.push(entry.path().to_string_lossy().to_string());
                }
            }
        } else if path.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if supported.contains(&ext.as_str()) {
                files.push(file.clone());
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    files.retain(|f| seen.insert(f.clone()));
    files
}

// ─── Single-file conversion ──────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn convert_single_file(
    src_path: &str,
    request: &ConvertRequest,
    stats: &mut ConvertResult,
    used_outputs: &mut std::collections::HashSet<String>,
    app_handle: &AppHandle,
    cancel_flag: &Arc<AtomicBool>,
    ffmpeg: &Option<String>,
    quality: i32,
) {
    // 取消必须单文件内也生效：只在批次间隙检查标志的话，一张 100MB /
    // 25M 像素大图的解码+编码要好几分钟，那段时间里点取消毫无反应。
    if cancel_flag.load(Ordering::Relaxed) { return; }

    let path = Path::new(src_path);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let parent = path.parent().unwrap_or(Path::new(""));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");

    // ── GIF: use ffmpeg for animated WebP ──
    if ext == "gif" {
        if let Some(ff) = ffmpeg {
            emit_progress(app_handle, src_path, "converting", "converting", 0, 0);
            let out_name = build_output_name(stem, "webp", &request.naming_mode, quality);
            let out_path = dedup_output_path(build_output_path(&out_name, request, parent, src_path), used_outputs);
            let out_str = out_path.to_string_lossy().to_string();

            let original_size = std::fs::metadata(src_path).map(|m| m.len() as i64).unwrap_or(0);

            let mut cmd = Command::new(ff);
            cmd.arg("-y").arg("-i").arg(src_path)
                .arg("-c:v").arg("libwebp")
                .arg("-lossless").arg(if request.lossless { "1" } else { "0" })
                .arg("-q:v").arg(quality.to_string())
                .arg("-loop").arg("0").arg(&out_str);
            let (code, _) = run_cmd_timeout(&mut cmd, 120, cancel_flag);
            if cancel_flag.load(Ordering::Relaxed) { return; }

            if code == 0 && std::path::Path::new(&out_str).exists() {
                let new_size = std::fs::metadata(&out_str).map(|m| m.len() as i64).unwrap_or(0);
                // 只在产出结果后才计入体积统计，失败文件不污染总节省
                stats.total_original += original_size;
                stats.total_converted += new_size;
                stats.success_count += 1;
                let saved = original_size - new_size;
                let pct = if original_size > 0 { (saved * 100 / original_size) as i32 } else { 0 };
                emit_progress_with_output(app_handle, src_path, "done", &format!("saved:{}kb", new_size / 1024), saved, pct, Some(out_str.clone()));
                if request.delete_source && !is_same_file(src_path, Path::new(&out_str)) {
                    // 与非 GIF 分支保持一致：删不掉要报，不能悄悄吞掉，
                    // 否则用户以为源文件已经没了，其实还在原地。
                    if let Err(e) = std::fs::remove_file(src_path) {
                        emit_progress(app_handle, src_path, "done", &format!("delete_fail:{}", e), saved, pct);
                    }
                }
            } else {
                stats.fail_count += 1;
                emit_progress(app_handle, src_path, "failed", "gif_convert_fail", 0, 0);
            }
            let _ = app_handle.emit("convert-stats", stats.clone());
            return;
        } else {
            emit_progress(app_handle, src_path, "converting", "converting_no_anim", 0, 0);
        }
    }

    // ── Build output filename & path ──
    let out_ext = "webp";
    let filename = build_output_name(stem, out_ext, &request.naming_mode, quality);
    let output_path = dedup_output_path(build_output_path(&filename, request, parent, src_path), used_outputs);
    let output_str = output_path.to_string_lossy().to_string();

    let work_path = Path::new(src_path).to_path_buf();
    let original_size = std::fs::metadata(src_path).map(|m| m.len() as i64).unwrap_or(0);

    // 「覆盖」模式 + `.webp` 输入时，输出路径解析出来就是源文件本身。那种情况下
    // 继续走就是拿用户的原始文件做一次不可逆的重编码（还可能是无损→有损），
    // 而且没有任何退路。在写盘之前直接跳过——旧代码只在写完之后才用
    // `same_as_source` 阻止删源，那时原件已经被覆盖了。
    if is_same_file(src_path, &output_path) {
        stats.skip_count += 1;
        stats.total_original += original_size;
        stats.total_converted += original_size;
        emit_progress(app_handle, src_path, "skipped", "skipped", 0, 0);
        let _ = app_handle.emit("convert-stats", stats.clone());
        return;
    }

    // ── Decode ──
    emit_progress(app_handle, src_path, "converting", "converting", 0, 0);

    let file_size = std::fs::metadata(src_path).map(|m| m.len()).unwrap_or(0);
    if file_size > 100_000_000 {
        // 过大被跳过：计入 skip，不计入体积统计，也不是失败
        stats.skip_count += 1;
        emit_progress(app_handle, src_path, "skipped", &format!("too_large:{}MB", file_size / 1_000_000), 0, 0);
        let _ = app_handle.emit("convert-stats", stats.clone());
        return;
    }
    let dims = ImageReader::open(&work_path).ok().and_then(|r| r.into_dimensions().ok());
    if let Some((w, h)) = dims {
        if w as u64 * h as u64 > 25_000_000 {
            stats.skip_count += 1;
            emit_progress(app_handle, src_path, "skipped", &format!("too_large:{}x{}", w, h), 0, 0);
            let _ = app_handle.emit("convert-stats", stats.clone());
            return;
        }
    }

    let reader = match ImageReader::open(&work_path)
        .map_err(|e| format!("open_fail:{}", e))
        .and_then(|r| r.with_guessed_format().map_err(|e| format!("open_fail:{}", e)))
    {
        Ok(r) => r,
        Err(e) => {
            stats.fail_count += 1;
            emit_progress(app_handle, src_path, "failed", &e, 0, 0);
            let _ = app_handle.emit("convert-stats", stats.clone());
            return;
        }
    };

    // 扩展名与实际内容不符 —— 真实世界极常见（微信 / 网页「另存为」、各类导出
    // 工具都会产生），典型症状是「名为 .jpg 实为 PNG」，老版本按扩展名选解码器时
    // 会报 `Illegal start bytes:8950` 这种**用户完全看不懂**的十六进制错误。
    // 这里先把嗅探到的格式留档：万一后续解码仍失败（嗅探与解码器行为不一致、或
    // 文件损坏），用它给出一条**可操作**的提示而不是裸错误串。
    let sniffed_format = reader.format();

    /// 把扩展名映射到 image 的格式枚举，供 mismatch 文案使用。
    fn format_from_ext(ext: &str) -> Option<image::ImageFormat> {
        match ext.to_ascii_lowercase().as_str() {
            "jpg" | "jpeg" => Some(image::ImageFormat::Jpeg),
            "png" => Some(image::ImageFormat::Png),
            "webp" => Some(image::ImageFormat::WebP),
            "gif" => Some(image::ImageFormat::Gif),
            "bmp" => Some(image::ImageFormat::Bmp),
            "tif" | "tiff" => Some(image::ImageFormat::Tiff),
            _ => None,
        }
    }
    /// 格式枚举 → 稳定的短名（不用 Debug 的 `Jpeg`/`Png`，与前端词表对齐）。
    fn format_slug(f: image::ImageFormat) -> &'static str {
        match f {
            image::ImageFormat::Jpeg => "jpeg",
            image::ImageFormat::Png => "png",
            image::ImageFormat::WebP => "webp",
            image::ImageFormat::Gif => "gif",
            image::ImageFormat::Bmp => "bmp",
            image::ImageFormat::Tiff => "tiff",
            _ => "unknown",
        }
    }

    // 解码失败时决定用哪条文案：扩展名与内容不符时给可操作提示，否则给原始错误。
    let decode_error = |e: String| -> String {
        let ext = work_path
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        // 嗅探优先；嗅探为 None 时退回按扩展名判断（文件可能连头都读不出来）
        let actual = sniffed_format.or_else(|| format_from_ext(&ext));
        match actual {
            Some(f) if format_from_ext(&ext).is_some_and(|x| x != f) => {
                // 扩展名说 A、内容是 B —— 用户改个扩展名就能用，必须说清楚
                format!(
                    "ext_mismatch:{}:{}",
                    format_slug(f),
                    ext
                )
            }
            _ => format!("decode_fail:{e}"),
        }
    };
    // EXIF 方向：image 不会自动应用，必须手动，否则 iPhone 竖拍导出后全部横躺（P0-21）。
    // 注意：image 0.25.5 的 ImageReader 没有 orientation() 方法（该方法 0.25.6+ 才有，
    // 53a0086 引入的写法从未编译通过）。此处经由 into_decoder() 的 ImageDecoder trait
    // 方法读取（无 EXIF 的格式返回默认 NoTransforms），再用 apply_orientation 校正。
    let mut decoder = match reader.into_decoder().map_err(|e| decode_error(e.to_string())) {
        Ok(d) => d,
        Err(e) => {
            stats.fail_count += 1;
            emit_progress(app_handle, src_path, "failed", &e, 0, 0);
            let _ = app_handle.emit("convert-stats", stats.clone());
            return;
        }
    };
    let orientation = image::ImageDecoder::orientation(&mut decoder)
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = match image::DynamicImage::from_decoder(decoder).map_err(|e| decode_error(e.to_string())) {
        Ok(img) => img,
        Err(e) => {
            stats.fail_count += 1;
            emit_progress(app_handle, src_path, "failed", &e, 0, 0);
            let _ = app_handle.emit("convert-stats", stats.clone());
            return;
        }
    };
    img.apply_orientation(orientation);

    // 解码是最大的单文件耗时点；取消赶在这里就不要再编码、更不要写盘。
    if cancel_flag.load(Ordering::Relaxed) { return; }
    img = apply_resize(img, request);

    // ── Encode ──
    let mut target_met = true;
    let webp_mem: Vec<u8> = if let Some(target_kb) = request.target_size_kb {
        match encode_target_size(&img, target_kb, request.lossless) {
            Ok((b, met)) => { target_met = met; b }
            Err(e) => { stats.fail_count += 1; emit_progress(app_handle, src_path, "failed", &e, 0, 0); let _ = app_handle.emit("convert-stats", stats.clone()); return; }
        }
    } else {
        match encode_webp(&img, quality, request.lossless) {
            Ok(b) => b, Err(e) => { stats.fail_count += 1; emit_progress(app_handle, src_path, "failed", &e, 0, 0); let _ = app_handle.emit("convert-stats", stats.clone()); return; }
        }
    };

    // ── Write result ──
    // 目标大小模式会编码多个候选，耗时同样集中在这里；写盘前再让取消一次。
    if cancel_flag.load(Ordering::Relaxed) { return; }
    let new_size = webp_mem.len() as i64;
    // 产出比原图大（无论常规还是目标大小模式——后者最容易「达标即变大」）
    // 都没有写盘的意义：跳过并计入 skipped，不再谎报成功。
    if new_size >= original_size && original_size > 0 {
        stats.skip_count += 1;
        stats.total_original += original_size;
        stats.total_converted += original_size;
        emit_progress(app_handle, src_path, "skipped", "skipped", 0, 0);
    } else if let Err(e) = write_atomically(&output_str, &webp_mem) {
        stats.fail_count += 1;
        emit_progress(app_handle, src_path, "failed", &format!("write_fail:{}", e), 0, 0);
    } else {
        // P0 修复：输出与源是同一个文件（如“覆盖”模式 + webp 输入）时，
        // 绝不能执行 delete_source —— 否则刚写好的输出会被当作“源文件”删掉，
        // 原图与结果双双丢失。此处只跳过删除，不做其他行为改变。
        let same_as_source = is_same_file(src_path, Path::new(&output_str));
        stats.total_original += original_size;
        stats.total_converted += new_size;
        let saved_bytes = (original_size - new_size).max(0);
        let saved_pct = if original_size > 0 { (saved_bytes * 100 / original_size) as i32 } else { 0 };
        stats.success_count += 1;
        let done_msg = if !target_met {
            format!("target_unreachable:{}kb", new_size / 1024)
        } else {
            format!("saved:{}kb", new_size / 1024)
        };
        emit_progress_with_output(app_handle, src_path, "done", &done_msg, saved_bytes, saved_pct, Some(output_str.clone()));

        if request.delete_source && !same_as_source {
            if let Err(e) = std::fs::remove_file(src_path) {
                emit_progress(app_handle, src_path, "done", &format!("delete_fail:{}", e), saved_bytes, saved_pct);
            }
        }
    }
    let _ = app_handle.emit("convert-stats", stats.clone());
}

/// Writes bytes to `path` atomically: temp file in the same directory, fsync, rename.
///
/// A plain `fs::write` truncates the target in place. A crash or a full disk then
/// leaves a truncated `.webp` — and a truncated webp is *itself valid input*, so the
/// next batch would happily re-encode the corpse and damage it further. The temp
/// name carries a per-process sequence number so concurrent writers cannot collide.
fn write_atomically(path: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    let target = Path::new(path);
    let dir = target.parent().ok_or_else(|| "invalid path".to_string())?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;
    let tmp = dir.join(format!(
        ".{}.{}.{}.tmp",
        name,
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    // Persist the rename itself, so the directory entry survives a crash too.
    // rename() 只发布了新名字，目录项本身可能还在页缓存里。
    #[cfg(unix)]
    {
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// Makes each concurrent write use its own temp file. See `write_atomically`.
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// ─── Main conversion command ────────────────────────────────────────

#[tauri::command]
fn start_convert(app: AppHandle, state: State<AppState>, request: ConvertRequest) -> Result<(), String> {
    // 转换是本应用唯一产出新文件的写操作：受授权闸门保护（FAMILY-LICENSE.md §2）。
    // 放在锁 is_converting 之前：过期用户不该进入"转换中"状态。
    ensure_write_allowed()?;
    let mut converting = state.is_converting.lock().map_err(|e| e.to_string())?;
    if *converting { return Err("ERR_ALREADY_CONVERTING".into()); }
    *converting = true;

    let ffmpeg = state.tool_paths.get("ffmpeg").and_then(|o| o.clone());
    let quality = request.quality.clamp(10, 100);

    let all_files = collect_convert_files(&request);
    if all_files.is_empty() { bail_and_unlock!(converting, "ERR_NO_FILES"); }

    let mut stats = ConvertResult {
        success_count: 0, skip_count: 0, fail_count: 0,
        total_original: 0, total_converted: 0, saved: 0, saved_pct: 0,
    };

    let app_handle = app.clone();
    let cancel_flag = state.cancel_flag.clone();
    cancel_flag.store(false, Ordering::Relaxed);
    drop(converting);

    std::thread::spawn(move || {
        // 转换总任务数（目录/递归展开后的真实数量）——前端进度条以此为分母
        let _ = app_handle.emit("convert-total", all_files.len());

        // 一次 panic（例如某张图让 libwebp 编码器炸掉）以前会把 is_converting 永久留在
        // true：转换按钮失效、关窗被拦，只能杀进程。catch_unwind 把 panic 降级为一次失败
        // 上报，下面的收尾必定执行；panic hook 会在控制台留下原因。
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // 同批输出路径去重：a.jpg / a.png 这类同名不同扩展会解析出同一输出
            // 路径，后写者静默盖掉先写者而双双报成功——先到先得，后续加序号。
            let mut used_outputs: std::collections::HashSet<String> = std::collections::HashSet::new();
            for src_path in all_files.iter() {
                if cancel_flag.load(Ordering::Relaxed) { break; }
                convert_single_file(src_path, &request, &mut stats, &mut used_outputs, &app_handle,
                    &cancel_flag, &ffmpeg, quality);
            }

            // 目标大小模式下产物可能比原图大；总量与单文件口径保持一致（不让步到负数）
            stats.saved = (stats.total_original - stats.total_converted).max(0);
            stats.saved_pct = if stats.total_original > 0 { (stats.saved * 100 / stats.total_original) as i32 } else { 0 };
        }));
        if outcome.is_err() {
            stats.fail_count += 1;
            emit_progress(&app_handle, "", "failed", "ERR_INTERNAL_PANIC", 0, 0);
        }
        let _ = app_handle.emit("convert-done", &stats);
        // 无论成功、失败还是 panic，都必须解锁——这是上面那条 panic 修复的意义所在。
        if let Some(state) = app_handle.try_state::<AppState>() {
            if let Ok(mut converting) = state.is_converting.lock() { *converting = false; }
        }
    });

    Ok(())
}

// ─── Output path helpers ────────────────────────────────────────────

/// 判断两个路径是否指向同一个文件。优先 canonicalize（可解析大小写、符号链接、
/// `..` 段）；任一侧解析失败时退回规范化字符串比较（Windows 大小写不敏感）。
fn is_same_file(a: &str, b: &Path) -> bool {
    let bp = Path::new(a);
    if let (Ok(ca), Ok(cb)) = (std::fs::canonicalize(bp), std::fs::canonicalize(b)) {
        return ca == cb;
    }
    let norm = |s: &str| {
        let s = s.replace('/', "\\");
        if cfg!(target_os = "windows") { s.to_lowercase() } else { s }
    };
    norm(a) == norm(&b.to_string_lossy())
}

fn build_output_name(stem: &str, ext: &str, naming_mode: &str, quality: i32) -> String {
    match naming_mode {
        "overwrite" => format!("{}.{}", stem, ext),
        "webp-suffix" => format!("{}-webp.{}", stem, ext),
        "q-suffix" => format!("{}-q{}.{}", stem, quality, ext),
        "ts-suffix" => {
            use std::time::{SystemTime, UNIX_EPOCH};
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH).unwrap_or_default()
                .as_millis();
            format!("{}-{}.{}", stem, ts, ext)
        }
        _ => format!("{}.{}", stem, ext),
    }
}

/// 同批输出去重：同批内撞名时追加 -2/-3 序号（跨批覆盖属命名模式的既有语义，不动）。
fn dedup_output_path(path: PathBuf, used: &mut std::collections::HashSet<String>) -> PathBuf {
    if used.insert(path.to_string_lossy().to_string()) {
        return path;
    }
    let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("output").to_string();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("webp").to_string();
    for n in 2..1000 {
        let cand = dir.join(format!("{}-{}.{}", stem, n, ext));
        if used.insert(cand.to_string_lossy().to_string()) {
            return cand;
        }
    }
    path
}

fn build_output_path(filename: &str, request: &ConvertRequest, parent: &Path, src_path: &str) -> PathBuf {
    match &request.output_dir {
        Some(dir) => {
            let dir_path = Path::new(dir);
            std::fs::create_dir_all(dir_path).ok();
            
            if request.preserve_structure {
                // Compute relative path from base_dir to src file's parent
                let base = request.base_dir.as_deref().unwrap_or("");
                let base_path = Path::new(base);
                let src_parent = Path::new(src_path).parent().unwrap_or(Path::new(""));
                if let Ok(rel) = src_parent.strip_prefix(base_path) {
                    let full_dir = dir_path.join(rel);
                    std::fs::create_dir_all(&full_dir).ok();
                    return full_dir.join(filename);
                }
            }
            dir_path.join(filename)
        }
        None => parent.join(filename),
    }
}

// ─── Command timeout helper ─────────────────────────────────────────

fn run_cmd_timeout(cmd: &mut Command, secs: u64, cancel_flag: &Arc<AtomicBool>) -> (i32, String) {
    let mut child = match cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (-1, format!("spawn_fail:{}", e)),
    };

    let _pid = child.id();
    let (exit_tx, exit_rx) = mpsc::channel();
    let (out_tx, out_rx) = mpsc::channel();
    let (err_tx, err_rx) = mpsc::channel();
    let (kill_tx, kill_rx) = mpsc::channel();
    let cancelled = Arc::new(AtomicBool::new(false));

    if let Some(stdout) = child.stdout.take() {
        let cancelled_r = cancelled.clone();
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = std::io::BufReader::new(stdout).read_to_string(&mut buf);
            if !cancelled_r.load(Ordering::Relaxed) {
                let _ = out_tx.send(buf);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let cancelled_r = cancelled.clone();
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = std::io::BufReader::new(stderr).read_to_string(&mut buf);
            if !cancelled_r.load(Ordering::Relaxed) {
                let _ = err_tx.send(buf);
            }
        });
    }

    let cancel_flag_w = cancel_flag.clone();
    let exit_tx2 = exit_tx.clone();
    std::thread::spawn(move || {
        loop {
            match kill_rx.try_recv() {
                Ok(()) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
            if cancel_flag_w.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let _ = exit_tx2.send(Ok(status));
                    break;
                }
                Ok(None) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    let _ = exit_tx2.send(Err(e));
                    break;
                }
            }
        }
    });

    let start = std::time::Instant::now();
    let result = loop {
        match exit_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(s)) => break Ok(s),
            Ok(Err(_)) => break Err(1i32),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if cancel_flag.load(Ordering::Relaxed) {
                    cancelled.store(true, Ordering::Relaxed);
                    let _ = kill_tx.send(());
                    break Err(2i32);
                }
                if start.elapsed() >= Duration::from_secs(secs) {
                    break Err(3i32);
                }
                continue;
            }
            Err(_) => break Err(4i32),
        }
    };
    match result {
        Ok(s) => {
            let code = s.code().unwrap_or(-1);
            let out = out_rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default();
            let err = err_rx.recv_timeout(Duration::from_secs(3)).unwrap_or_default();
            let _ = kill_tx.send(());
            (code, format!("{}{}", out, err))
        }
        Err(2) => {
            std::thread::sleep(Duration::from_millis(100));
            (-1, "cancelled".into())
        }
        Err(1) => (-1, "ERR_PROCESS".into()),
        Err(4) => (-1, "ERR_CHANNEL".into()),
        Err(_) => {
            cancelled.store(true, Ordering::Relaxed);
            let _ = kill_tx.send(());
            std::thread::sleep(Duration::from_millis(200));
            (-1, format!("timeout:{}s", secs))
        }
    }
}

fn emit_progress(app: &AppHandle, file: &str, status: &str, message: &str, saved_bytes: i64, saved_pct: i32) {
    emit_progress_with_output(app, file, status, message, saved_bytes, saved_pct, None);
}

fn emit_progress_with_output(
    app: &AppHandle,
    file: &str,
    status: &str,
    message: &str,
    saved_bytes: i64,
    saved_pct: i32,
    output_path: Option<String>,
) {
    let progress = FileProgress {
        file: file.to_string(),
        status: status.to_string(),
        message: message.to_string(),
        saved_bytes,
        saved_pct,
        output_path,
    };
    let _ = app.emit("convert-progress", &progress);
}

// ─── CLI mode ───────────────────────────────────────────────────────

pub fn run_cli(args: &[String]) {
    eprintln!("Pic2WebP CLI mode — v1.7.0");
    eprintln!("Usage: pic2webp --cli <files...> [--quality 80] [--lossless] [--resize 1920] [--output-dir dir]");
    eprintln!();
    
    let mut files: Vec<String> = Vec::new();
    let mut quality = 80i32;
    let mut lossless = false;
    let mut resize_w: Option<u32> = None;
    let mut output_dir: Option<String> = None;
    let mut recursive = false;
    
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--quality" | "-q" => {
                i += 1;
                if i < args.len() { quality = args[i].parse().unwrap_or(80); }
            }
            "--lossless" | "-l" => lossless = true,
            "--resize" | "-r" => {
                i += 1;
                if i < args.len() { resize_w = args[i].parse().ok(); }
            }
            "--output-dir" | "-o" => {
                i += 1;
                if i < args.len() { output_dir = Some(args[i].clone()); }
            }
            "--recursive" => recursive = true,
            "--help" | "-h" => {
                eprintln!("Options:");
                eprintln!("  -q, --quality N     Quality (10-100, default 80)");
                eprintln!("  -l, --lossless      Lossless encoding");
                eprintln!("  -r, --resize W      Resize to width W (preserves aspect ratio)");
                eprintln!("  -o, --output-dir D  Output directory");
                eprintln!("      --recursive     Process subdirectories");
                return;
            }
            _ => {
                if !args[i].starts_with('-') {
                    files.push(args[i].clone());
                }
            }
        }
        i += 1;
    }
    
    if files.is_empty() {
        eprintln!("Error: no input files specified");
        return;
    }
    
    // Collect all files
    let supported = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff"];
    let mut all_files: Vec<String> = Vec::new();
    for f in &files {
        let path = Path::new(f);
        if path.is_dir() && recursive {
            for entry in walkdir::WalkDir::new(path)
                .into_iter().filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
            {
                let ext = entry.path().extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if supported.contains(&ext.as_str()) {
                    all_files.push(entry.path().to_string_lossy().to_string());
                }
            }
        } else if path.is_file() {
            all_files.push(f.clone());
        }
    }
    
    eprintln!("Processing {} files...", all_files.len());
    let mut success = 0u32;
    let mut fail = 0u32;
    let mut total_saved: i64 = 0;
    
    for src in &all_files {
        let path = Path::new(src);
        let _ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
        let parent = path.parent().unwrap_or(Path::new(""));
        
        let out_name = format!("{}-webp.webp", stem);
        let out_path = match &output_dir {
            Some(d) => { std::fs::create_dir_all(d).ok(); Path::new(d).join(&out_name) }
            None => parent.join(&out_name),
        };
        
        let original_size = std::fs::metadata(src).map(|m| m.len() as i64).unwrap_or(0);
        
        // Decode
        let img = match ImageReader::open(src)
            .map_err(|e| format!("open_fail:{}", e))
            .and_then(|r| r.with_guessed_format().map_err(|e| format!("format_fail:{}", e)))
            .and_then(|r| r.decode().map_err(|e| format!("decode_fail:{}", e)))
        {
            Ok(img) => img,
            Err(e) => { eprintln!("  FAIL: {} — {}", src, e); fail += 1; continue; }
        };
        
        // Resize
        let img = if let Some(w) = resize_w {
            img.resize(w, u32::MAX, image::imageops::FilterType::Lanczos3)
        } else { img };
        
        // Encode
        let (iw, ih) = (img.width(), img.height());
        let result = if img.color().has_alpha() {
            let rgba = img.to_rgba8();
            let enc = webp::Encoder::from_rgba(rgba.as_raw(), iw, ih);
            if lossless { Ok(enc.encode_lossless()) }
            else { enc.encode_simple(false, quality as f32) }
        } else {
            let rgb = img.to_rgb8();
            let enc = webp::Encoder::from_rgb(rgb.as_raw(), iw, ih);
            if lossless { Ok(enc.encode_lossless()) }
            else { enc.encode_simple(false, quality as f32) }
        };

        match result {
            Ok(mem) => {
                let new_size = mem.len() as i64;
                if let Err(e) = std::fs::write(&out_path, &*mem) {
                    eprintln!("  FAIL: {} — write error: {}", src, e);
                    fail += 1;
                } else {
                    let saved = original_size - new_size;
                    total_saved += saved;
                    success += 1;
                    eprintln!("  OK: {} → {} ({}KB → {}KB, saved {}KB)",
                        src, out_path.display(),
                        original_size / 1024, new_size / 1024, saved / 1024);
                }
            }
            Err(e) => { eprintln!("  FAIL: {} — encode error: {:?}", src, e); fail += 1; }
        }
    }
    
    eprintln!("\nDone: {} success, {} failed, total saved: {}KB", success, fail, total_saved / 1024);
}

pub mod menu;

// ─── App builder ────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_menu_event(|app, event| {
            let _ = app.emit("menu-action", event.id().0.clone());
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let tool_paths = resolve_tools(app.handle());
            app.manage(AppState {
                is_converting: Mutex::new(false),
                tool_paths,
                cancel_flag: Arc::new(AtomicBool::new(false)),
                should_close: Arc::new(AtomicBool::new(false)),
            });
            // 授权状态的落盘目录。取不到就留空，current_license() 会按"不拦截"处理
            // —— 宁可少拦一次，也不能因为一个目录取不到把用户锁在外面（与 MD/PDF 同款）。
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = LICENSE_DIR.set(dir);
            }
            let _ = APP_HANDLE.set(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.try_state::<AppState>() {
                    if let Ok(converting) = state.is_converting.lock() {
                        if *converting && !state.should_close.load(Ordering::Relaxed) {
                            api.prevent_close();
                            let _ = window.emit("confirm-close", ());
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_convert, cancel_convert, force_close, get_file_size,
            check_disk_space, is_dir, generate_thumbnail, build_menu,
            license_status, store_receipt
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 前端挂载后（及语言切换时）按 UI 语言重建菜单。
#[tauri::command]
fn build_menu(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    menu::build(&app, &lang).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_probe_walks_up_from_missing_path() {
        // 输出目录可能还不存在：探测应上溯到第一个存在的祖先（此处即临时目录）
        let missing = std::env::temp_dir().join("pic2webp-probe-nope/deeper/still-nope");
        let free = check_disk_space(missing.to_string_lossy().to_string());
        assert!(free.is_ok(), "probe failed: {:?}", free.err());
        assert!(free.unwrap() > 0);
    }

    #[test]
    fn disk_probe_existing_dir() {
        let free = check_disk_space(std::env::temp_dir().to_string_lossy().to_string());
        assert!(free.is_ok(), "probe failed: {:?}", free.err());
        assert!(free.unwrap() > 0);
    }

    #[test]
    fn disk_probe_file_probes_its_parent() {
        // 传一个文件路径也应可用（取其所在卷）
        let f = std::env::temp_dir().join("pic2webp-probe-file.bin");
        std::fs::write(&f, b"x").unwrap();
        let free = check_disk_space(f.to_string_lossy().to_string());
        assert!(free.is_ok(), "probe failed: {:?}", free.err());
        assert!(free.unwrap() > 0);
        std::fs::remove_file(&f).ok();
    }

    /// 验收（FAMILY-LICENSE.md §6）：把试用起始时间改到过期后，
    /// 写命令的闸门 `ensure_write_allowed` 必须返回含 `LICENSE_EXPIRED` 的错误。
    /// 构造法照 license.rs 既有测试：直接往状态目录里写起始时间戳。
    #[test]
    fn an_expired_trial_makes_the_write_gate_return_license_expired() {
        // 闸门真实生效的前提：ENFORCE + 直链渠道 + 公钥已配（测试构建三条都成立，
        // 与 license.rs 的 a_configured_key_in_the_direct_channel_engages_the_gate 同源）。
        assert!(
            license::enforced(),
            "测试前提：ENFORCE=true、直链渠道、公钥已配时 enforced() 应为 true"
        );

        let dir = std::env::temp_dir().join(format!("rt-wp-license-gate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // LICENSE_DIR 是进程级单例：本测试是唯一设置它的测试。若将来有人加第二条，
        // 后到的 set 会失败 —— 那时合并两条测试，不要让闸门测试静默跑偏。
        if LICENSE_DIR.set(dir.clone()).is_err() {
            panic!("LICENSE_DIR 已被其他测试设置，闸门测试无法控制状态目录");
        }

        // 试用期第一天：写操作放行。
        let now = now_secs();
        // 文件名即 license.rs 的 STATE_FILE（模块私有常量，这里按值写）。
        std::fs::write(dir.join("state.bin"), now.to_string()).unwrap();
        assert_eq!(ensure_write_allowed(), Ok(()), "试用期内写操作必须放行");

        // 把试用起始时间改到 30 天前：状态 = Expired，必须被拦，错误码固定。
        std::fs::write(dir.join("state.bin"), (now - 30 * 86_400).to_string()).unwrap();
        let err = ensure_write_allowed().unwrap_err();
        assert!(
            err.contains("LICENSE_EXPIRED"),
            "过期后写操作应返回 LICENSE_EXPIRED，实际为 {err}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
