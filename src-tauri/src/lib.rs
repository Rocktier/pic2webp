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
    let supported = ["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "tiff"];
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
    app_handle: &AppHandle,
    cancel_flag: &Arc<AtomicBool>,
    ffmpeg: &Option<String>,
    quality: i32,
) {
    let path = Path::new(src_path);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let parent = path.parent().unwrap_or(Path::new(""));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");

    // ── GIF: use ffmpeg for animated WebP ──
    if ext == "gif" {
        if let Some(ff) = ffmpeg {
            emit_progress(app_handle, src_path, "converting", "converting", 0, 0);
            let out_name = build_output_name(stem, "webp", &request.naming_mode, quality);
            let out_path = build_output_path(&out_name, request, parent, src_path);
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
    let output_path = build_output_path(&filename, request, parent, src_path);
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

    // ── Decode ──    // ── Decode ──
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

    let mut img = match ImageReader::open(&work_path)
        .map_err(|e| format!("open_fail:{}", e))
        .and_then(|r| r.decode().map_err(|e| format!("decode_fail:{}", e)))
    {
        Ok(img) => img,
        Err(e) => {
            stats.fail_count += 1;
            emit_progress(app_handle, src_path, "failed", &e, 0, 0);
            let _ = app_handle.emit("convert-stats", stats.clone());
            return;
        }
    };

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
    let new_size = webp_mem.len() as i64;
    if new_size >= original_size && original_size > 0 && request.target_size_kb.is_none() {
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
            for src_path in all_files.iter() {
                if cancel_flag.load(Ordering::Relaxed) { break; }
                convert_single_file(src_path, &request, &mut stats, &app_handle,
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
    let supported = ["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "tiff"];
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
            is_dir, generate_thumbnail, build_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 前端挂载后（及语言切换时）按 UI 语言重建菜单。
#[tauri::command]
fn build_menu(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    menu::build(&app, &lang).map_err(|e| e.to_string())
}
