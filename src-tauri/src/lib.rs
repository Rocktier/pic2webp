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
use notify::Watcher;

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
    #[serde(default = "default_output_format")]
    pub output_format: String, // "webp" | "avif" | "both"
    #[serde(default)]
    pub resize_enabled: bool,
    #[serde(default)]
    pub resize_width: Option<u32>,
    #[serde(default)]
    pub resize_height: Option<u32>,
    #[serde(default = "default_resize_mode")]
    pub resize_mode: String, // "fit" | "fill" | "shrink"
    #[serde(default)]
    pub watermark_text: Option<String>,
    #[serde(default = "default_watermark_opacity")]
    pub watermark_opacity: f32,
    // Base dir for preserve_structure (the root input dir)
    #[serde(default)]
    pub base_dir: Option<String>,
}

fn default_output_format() -> String { "webp".into() }
fn default_resize_mode() -> String { "fit".into() }
fn default_watermark_opacity() -> f32 { 0.5 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileProgress {
    pub file: String,
    pub status: String,
    pub message: String,
    pub saved_bytes: i64,
    pub saved_pct: i32,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCheck {
    pub jpegoptim: bool,
    pub pngquant: bool,
    pub oxipng: bool,
    pub ffmpeg: bool,
}

// ─── App state ──────────────────────────────────────────────────────

pub struct AppState {
    pub is_converting: Mutex<bool>,
    pub tool_paths: HashMap<String, Option<String>>,
    pub cancel_flag: Arc<AtomicBool>,
    pub should_close: Arc<AtomicBool>,
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
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
    let tool_names = ["jpegoptim", "pngquant", "oxipng", "ffmpeg"];
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
fn check_tools(state: State<AppState>) -> ToolCheck {
    ToolCheck {
        jpegoptim: state.tool_paths.get("jpegoptim").and_then(|o| o.as_ref()).is_some(),
        pngquant: state.tool_paths.get("pngquant").and_then(|o| o.as_ref()).is_some(),
        oxipng: state.tool_paths.get("oxipng").and_then(|o| o.as_ref()).is_some(),
        ffmpeg: state.tool_paths.get("ffmpeg").and_then(|o| o.as_ref()).is_some(),
    }
}

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

/// Start watching a folder for new images
#[tauri::command]
fn watch_folder(
    app: AppHandle,
    state: State<AppState>,
    dir: String,
    request: ConvertRequest,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res { let _ = tx.send(event); }
    }).map_err(|e| format!("watch_init_fail:{}", e))?;

    let watch_path = Path::new(&dir);
    watcher.watch(&watch_path, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("watch_fail:{}", e))?;

    // Store watcher
    *state.watcher.lock().map_err(|e| e.to_string())? = Some(watcher);

    let app_h = app.clone();
    let cancel_w = state.cancel_flag.clone();
    let supported = ["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "tiff"];

    std::thread::spawn(move || {
        while !cancel_w.load(Ordering::Relaxed) {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(event) => {
                    for path in &event.paths {
                        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                            if supported.contains(&ext.to_lowercase().as_str()) {
                                let path_str = path.to_string_lossy().to_string();
                                let _ = app_h.emit("watch-new-file", &path_str);
                                // Auto-convert: build a single-file request
                                let mut req = request.clone();
                                req.files = vec![path_str.clone()];
                                req.recursive = false;
                                // Emit to frontend to handle conversion
                                let _ = app_h.emit("watch-auto-convert", &req);
                            }
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(())
}

/// Stop watching
#[tauri::command]
fn stop_watch(state: State<AppState>) -> Result<(), String> {
    *state.watcher.lock().map_err(|e| e.to_string())? = None;
    Ok(())
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

/// Apply text watermark to an image
fn apply_watermark(img: &mut image::DynamicImage, text: &str, opacity: f32) {
    // Try to load a system font
    let font_data = get_system_font();
    let font_data = match font_data {
        Some(d) => d,
        None => return, // No font available, skip watermark
    };
    let font = match ab_glyph::FontRef::try_from_slice(&font_data) {
        Ok(f) => f,
        Err(_) => return,
    };

    let (w, h) = (img.width(), img.height());
    let font_size = (w.min(h) as f32 * 0.04).clamp(16.0, 64.0);
    
    use ab_glyph::{Font, ScaleFont};
    let scaled = font.as_scaled(font_size);
    
    // Calculate text width
    let mut text_w = 0.0;
    let mut last_id = None;
    for c in text.chars() {
        let glyph_id = font.glyph_id(c);
        if let Some(last) = last_id {
            text_w += scaled.kern(last, glyph_id);
        }
        let glyph = glyph_id.with_scale(font_size);
        text_w += scaled.h_advance(glyph_id);
        last_id = Some(glyph_id);
    }
    
    // Position: bottom-right with padding
    let padding = (w.min(h) as f32 * 0.02).max(8.0);
    let x_start = (w as f32 - text_w - padding).max(padding);
    let y_start = h as f32 - padding;

    let rgba = img.to_rgba8();
    let mut raw: Vec<u8> = rgba.into_raw();

    
    // Render each glyph
    let mut x = x_start;
    let mut last_id = None;
    for c in text.chars() {
        let glyph_id = font.glyph_id(c);
        if let Some(last) = last_id {
            x += scaled.kern(last, glyph_id);
        }
        let glyph = glyph_id.with_scale_and_position(font_size, ab_glyph::Point { x, y: y_start });
        if let Some(outlined) = scaled.outline_glyph(glyph) {
            let bounds = outlined.px_bounds();
            outlined.draw(|px_x, px_y, v| {
                let gx = bounds.min.x as i32 + px_x as i32;
                let gy = bounds.min.y as i32 + px_y as i32;
                if gx >= 0 && gy >= 0 && (gx as u32) < w && (gy as u32) < h {
                    let idx = (gy as usize * w as usize + gx as usize) * 4;
                    let alpha = (v * opacity).clamp(0.0, 1.0);
                    raw[idx] = ((raw[idx] as f32) * (1.0 - alpha) + 255.0 * alpha) as u8;
                    raw[idx + 1] = ((raw[idx + 1] as f32) * (1.0 - alpha) + 255.0 * alpha) as u8;
                    raw[idx + 2] = ((raw[idx + 2] as f32) * (1.0 - alpha) + 255.0 * alpha) as u8;
                    raw[idx + 3] = 255;
                }
            });
        }
        x += scaled.h_advance(glyph_id);
        last_id = Some(glyph_id);
    }
    let new_rgba = image::ImageBuffer::from_raw(w, h, raw).unwrap();
    *img = image::DynamicImage::ImageRgba8(new_rgba);
}

fn get_system_font() -> Option<Vec<u8>> {
    let candidates: Vec<&str> = if cfg!(target_os = "macos") {
        vec![
            "/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/SFNS.ttf",
            "/Library/Fonts/Arial.ttf",
        ]
    } else if cfg!(target_os = "windows") {
        vec![
            "C:\\Windows\\Fonts\\arial.ttf",
            "C:\\Windows\\Fonts\\segoeui.ttf",
        ]
    } else {
        vec![
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
            "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        ]
    };
    for path in candidates {
        if let Ok(data) = std::fs::read(path) {
            return Some(data);
        }
    }
    None
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

/// Encode with target size (binary search quality)
fn encode_target_size(img: &image::DynamicImage, target_kb: u32, lossless: bool) -> Result<Vec<u8>, String> {
    if lossless {
        return encode_webp(img, 100, true);
    }
    let target_bytes = (target_kb as u64) * 1024;
    let mut lo = 10i32;
    let mut hi = 100i32;
    let mut best = encode_webp(img, 80, false)?;
    
    for _ in 0..6 {
        if lo >= hi { break; }
        let mid = (lo + hi) / 2;
        let encoded = encode_webp(img, mid, false)?;
        if encoded.len() as u64 <= target_bytes {
            best = encoded;
            lo = mid + 1; // Try higher quality
        } else {
            hi = mid - 1; // Need lower quality
        }
    }
    Ok(best)
}

/// Encode to AVIF using image crate
fn encode_avif(img: &image::DynamicImage, _quality: i32) -> Result<Vec<u8>, String> {
    let mut buf = Cursor::new(Vec::new());
    // image crate's AVIF encoder uses ravif
    img.write_to(&mut buf, image::ImageFormat::Avif)
        .map_err(|e| format!("avif_fail:{}", e))?;
    Ok(buf.into_inner())
}

// ─── Main conversion command ────────────────────────────────────────

#[tauri::command]
fn start_convert(app: AppHandle, state: State<AppState>, request: ConvertRequest) -> Result<(), String> {
    let mut converting = state.is_converting.lock().map_err(|e| e.to_string())?;
    if *converting {
        return Err("ERR_ALREADY_CONVERTING".into());
    }
    *converting = true;

    let jpegoptim = state.tool_paths.get("jpegoptim").and_then(|o| o.clone());
    let pngquant = state.tool_paths.get("pngquant").and_then(|o| o.clone());
    let oxipng = state.tool_paths.get("oxipng").and_then(|o| o.clone());
    let ffmpeg = state.tool_paths.get("ffmpeg").and_then(|o| o.clone());

    let quality = request.quality.clamp(10, 100);

    // ── Collect files ──
    let mut all_files: Vec<String> = Vec::new();
    let supported = ["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "tiff"];

    for file in &request.files {
        let path = Path::new(file);
        if !path.exists() {
            continue;
        }
        if path.is_dir() && request.recursive {
            for entry in walkdir::WalkDir::new(path)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
            {
                let ext = entry.path().extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if supported.contains(&ext.as_str()) {
                    all_files.push(entry.path().to_string_lossy().to_string());
                }
            }
        } else if path.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if supported.contains(&ext.as_str()) {
                all_files.push(file.clone());
            }
        }
    }

    // Deduplicate
    let mut seen = std::collections::HashSet::new();
    all_files.retain(|f| seen.insert(f.clone()));

    if all_files.is_empty() {
        bail_and_unlock!(converting, "ERR_NO_FILES");
    }

    let mut stats = ConvertResult {
        success_count: 0,
        skip_count: 0,
        fail_count: 0,
        total_original: 0,
        total_converted: 0,
        saved: 0,
        saved_pct: 0,
    };

    let app_handle = app.clone();
    let cancel_flag = state.cancel_flag.clone();
    cancel_flag.store(false, Ordering::Relaxed);

    drop(converting);

    std::thread::spawn(move || {
        // Scratch dir for non-destructive pre-compression; removed at the end of this batch.
        let scratch_root = std::env::temp_dir().join(format!(
            "pic2webp-scratch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let _ = std::fs::create_dir_all(&scratch_root);

        for (idx, src_path) in all_files.iter().enumerate() {
            if cancel_flag.load(Ordering::Relaxed) {
                break;
            }
            let path = Path::new(src_path);
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            let parent = path.parent().unwrap_or(Path::new(""));
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");

            // ── GIF: use ffmpeg for animated WebP ──
            if ext == "gif" {
                if let Some(ref ff) = ffmpeg {
                    emit_progress(&app_handle, src_path, "converting", "converting", 0, 0);
                    let out_name = build_output_name(&stem, "webp", &request.naming_mode, quality);
                    let out_path = build_output_path(&out_name, &request, parent, src_path);
                    let out_str = out_path.to_string_lossy().to_string();

                    let original_size = std::fs::metadata(src_path).map(|m| m.len() as i64).unwrap_or(0);
                    stats.total_original += original_size;

                    let mut cmd = Command::new(ff);
                    cmd.arg("-y")
                        .arg("-i").arg(src_path)
                        .arg("-c:v").arg("libwebp")
                        .arg("-lossless").arg(if request.lossless { "1" } else { "0" })
                        .arg("-q:v").arg(quality.to_string())
                        .arg("-loop").arg("0")
                        .arg(&out_str);
                    let (code, _) = run_cmd_timeout(&mut cmd, 120, &cancel_flag);

                    if cancel_flag.load(Ordering::Relaxed) { continue; }

                    if code == 0 && std::path::Path::new(&out_str).exists() {
                        let new_size = std::fs::metadata(&out_str).map(|m| m.len() as i64).unwrap_or(0);
                        stats.total_converted += new_size;
                        stats.success_count += 1;
                        let saved = original_size - new_size;
                        let pct = if original_size > 0 { (saved * 100 / original_size) as i32 } else { 0 };
                        emit_progress(&app_handle, src_path, "done", &format!("saved:{}kb", new_size / 1024), saved, pct);
                        if request.delete_source {
                            let _ = std::fs::remove_file(src_path);
                        }
                    } else {
                        stats.fail_count += 1;
                        emit_progress(&app_handle, src_path, "failed", "gif_convert_fail", 0, 0);
                    }
                    let _ = app_handle.emit("convert-stats", &stats);
                    continue;
                } else {
                    // No ffmpeg — try image crate (static only, first frame)
                    emit_progress(&app_handle, src_path, "converting", "converting_no_anim", 0, 0);
                }
            }

            // ── Build output filename ──
            let out_ext = match request.output_format.as_str() {
                "avif" => "avif",
                _ => "webp",
            };
            let filename = build_output_name(&stem, out_ext, &request.naming_mode, quality);

            // ── Build output path (with optional preserve_structure) ──
            let output_path = build_output_path(&filename, &request, parent, src_path);
            let output_str = output_path.to_string_lossy().to_string();

            // ── Working file for pre-compression; defaults to the source and is never mutated ──
            let mut work_path = Path::new(src_path).to_path_buf();

            // Original size measured BEFORE any pre-compression, so savings are computed against the real source
            let original_size = std::fs::metadata(src_path).map(|m| m.len() as i64).unwrap_or(0);
            stats.total_original += original_size;

            // ── Step 1: pre-compress JPEG into scratch (source file untouched) ──
            if (ext == "jpg" || ext == "jpeg") && jpegoptim.is_some() {
                emit_progress(&app_handle, src_path, "compressing", "precompress_jpeg", 0, 0);
                let work_dir = scratch_root.join(idx.to_string());
                let _ = std::fs::create_dir_all(&work_dir);
                let mut cmd = Command::new(jpegoptim.as_ref().unwrap());
                cmd.arg("--strip-all")
                    .arg("--all-normal")
                    .arg("--dest").arg(&work_dir)
                    .arg(src_path);
                let (code, _) = run_cmd_timeout(&mut cmd, 60, &cancel_flag);
                if cancel_flag.load(Ordering::Relaxed) { continue; }
                // jpegoptim writes into work_dir keeping the original basename
                if code == 0 {
                    if let Some(name) = Path::new(src_path).file_name() {
                        let out = work_dir.join(name);
                        if out.exists() { work_path = out; }
                    }
                }
            }

            // ── Step 2: pre-compress PNG into scratch (source file untouched) ──
            if ext == "png" {
                emit_progress(&app_handle, src_path, "compressing", "precompress_png", 0, 0);
                let work_dir = scratch_root.join(idx.to_string());
                let _ = std::fs::create_dir_all(&work_dir);

                if let (Some(qtool), Some(oxi)) = (&pngquant, &oxipng) {
                    let qpath = work_dir.join("a.png");
                    let mut png_cmd = Command::new(qtool);
                    png_cmd.arg("--quality")
                        .arg(format!("{}-100", quality.min(85)))
                        .arg("--force")
                        .arg("--output").arg(&qpath)
                        .arg(src_path);
                    let (code, _) = run_cmd_timeout(&mut png_cmd, 90, &cancel_flag);
                    if cancel_flag.load(Ordering::Relaxed) { continue; }
                    if code == 0 && qpath.exists() {
                        // oxipng optimizes the scratch file in place (safe: it is our temp file)
                        let mut oxi_cmd = Command::new(oxi);
                        oxi_cmd.arg("--strip").arg("safe")
                            .arg("--opt").arg("3")
                            .arg(&qpath);
                        run_cmd_timeout(&mut oxi_cmd, 120, &cancel_flag);
                        if cancel_flag.load(Ordering::Relaxed) { continue; }
                        if qpath.exists() { work_path = qpath; }
                    } else {
                        // pngquant bailed (e.g. truecolor/alpha) — fall back to oxipng onto a copy
                        let opath = work_dir.join("b.png");
                        let mut oxi_cmd = Command::new(oxi);
                        oxi_cmd.arg("--strip").arg("safe")
                            .arg("--opt").arg("1")
                            .arg("--out").arg(&opath)
                            .arg(src_path);
                        run_cmd_timeout(&mut oxi_cmd, 120, &cancel_flag);
                        if cancel_flag.load(Ordering::Relaxed) { continue; }
                        if opath.exists() { work_path = opath; }
                    }
                } else if let Some(ref oxi) = oxipng {
                    let opath = work_dir.join("b.png");
                    let mut oxi_cmd = Command::new(oxi);
                    oxi_cmd.arg("--strip").arg("safe")
                        .arg("--opt").arg("1")
                        .arg("--out").arg(&opath)
                        .arg(src_path);
                    run_cmd_timeout(&mut oxi_cmd, 120, &cancel_flag);
                    if cancel_flag.load(Ordering::Relaxed) { continue; }
                    if opath.exists() { work_path = opath; }
                }
            }

            // ── Step 3: decode ──
            emit_progress(&app_handle, src_path, "converting", "converting", 0, 0);

            let file_size = std::fs::metadata(src_path).map(|m| m.len()).unwrap_or(0);
            if file_size > 100_000_000 {
                stats.fail_count += 1;
                emit_progress(&app_handle, src_path, "skipped",
                    &format!("too_large:{}MB", file_size / 1_000_000), 0, 0);
                let _ = app_handle.emit("convert-stats", &stats);
                continue;
            }
            let dims = ImageReader::open(&work_path)
                .ok()
                .and_then(|r| r.into_dimensions().ok());
            if let Some((w, h)) = dims {
                if w as u64 * h as u64 > 25_000_000 {
                    stats.fail_count += 1;
                    emit_progress(&app_handle, src_path, "skipped",
                        &format!("too_large:{}x{}", w, h), 0, 0);
                    let _ = app_handle.emit("convert-stats", &stats);
                    continue;
                }
            }

            let mut img = match ImageReader::open(&work_path)
                .map_err(|e| format!("open_fail:{}", e))
                .and_then(|r| r.decode().map_err(|e| format!("decode_fail:{}", e)))
            {
                Ok(img) => img,
                Err(e) => {
                    stats.fail_count += 1;
                    emit_progress(&app_handle, src_path, "failed", &e, 0, 0);
                    let _ = app_handle.emit("convert-stats", &stats);
                    continue;
                }
            };

            // ── Resize ──
            img = apply_resize(img, &request);

            // ── Watermark ──
            if let Some(ref wm_text) = request.watermark_text {
                if !wm_text.is_empty() {
                    apply_watermark(&mut img, wm_text, request.watermark_opacity);
                }
            }

            // ── Encode ──
            let use_avif = request.output_format == "avif";
            let webp_mem: Vec<u8> = if use_avif {
                match encode_avif(&img, quality) {
                    Ok(b) => b,
                    Err(e) => {
                        stats.fail_count += 1;
                        emit_progress(&app_handle, src_path, "failed", &e, 0, 0);
                        let _ = app_handle.emit("convert-stats", &stats);
                        continue;
                    }
                }
            } else if let Some(target_kb) = request.target_size_kb {
                match encode_target_size(&img, target_kb, request.lossless) {
                    Ok(b) => b,
                    Err(e) => {
                        stats.fail_count += 1;
                        emit_progress(&app_handle, src_path, "failed", &e, 0, 0);
                        let _ = app_handle.emit("convert-stats", &stats);
                        continue;
                    }
                }
            } else {
                match encode_webp(&img, quality, request.lossless) {
                    Ok(b) => b,
                    Err(e) => {
                        stats.fail_count += 1;
                        emit_progress(&app_handle, src_path, "failed", &e, 0, 0);
                        let _ = app_handle.emit("convert-stats", &stats);
                        continue;
                    }
                }
            };

            // ── Write result ──
            let new_size = webp_mem.len() as i64;

            if new_size >= original_size && original_size > 0 && request.target_size_kb.is_none() {
                stats.skip_count += 1;
                stats.total_converted += original_size;
                emit_progress(&app_handle, src_path, "skipped", "skipped", 0, 0);
            } else if let Err(e) = std::fs::write(&output_str, &webp_mem) {
                stats.fail_count += 1;
                emit_progress(&app_handle, src_path, "failed", &format!("write_fail:{}", e), 0, 0);
            } else {
                stats.total_converted += new_size;
                let saved_bytes = original_size - new_size;
                let saved_pct = if original_size > 0 {
                    (saved_bytes * 100 / original_size) as i32
                } else { 0 };
                stats.success_count += 1;
                emit_progress(&app_handle, src_path, "done", &format!("saved:{}kb", new_size / 1024), saved_bytes, saved_pct);

                // AVIF "both" mode: also save .avif
                if request.output_format == "both" {
                    let avif_path = format!("{}.avif", output_str.trim_end_matches(".webp"));
                    if let Ok(avif_mem) = encode_avif(&img, quality) {
                        let _ = std::fs::write(&avif_path, &avif_mem);
                    }
                }

                if request.delete_source {
                    if let Err(e) = std::fs::remove_file(src_path) {
                        emit_progress(&app_handle, src_path, "done",
                            &format!("delete_fail:{}", e), saved_bytes, saved_pct);
                    }
                }
            }

            let _ = app_handle.emit("convert-stats", &stats);
        }

        // Clean up the batch scratch dir regardless of how the loop exited
        let _ = std::fs::remove_dir_all(&scratch_root);

        stats.saved = stats.total_original - stats.total_converted;
        stats.saved_pct = if stats.total_original > 0 {
            (stats.saved * 100 / stats.total_original) as i32
        } else { 0 };

        let _ = app_handle.emit("convert-done", &stats);

        if let Some(state) = app_handle.try_state::<AppState>() {
            if let Ok(mut converting) = state.is_converting.lock() {
                *converting = false;
            }
        }
    });

    Ok(())
}

// ─── Output path helpers ────────────────────────────────────────────

fn build_output_name(stem: &str, ext: &str, naming_mode: &str, quality: i32) -> String {
    match naming_mode {
        "overwrite" => format!("{}.{}", stem, ext),
        "webp-suffix" => format!("{}-{}.{}", stem, ext, ext),
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
    let progress = FileProgress {
        file: file.to_string(),
        status: status.to_string(),
        message: message.to_string(),
        saved_bytes,
        saved_pct,
    };
    let _ = app.emit("convert-progress", &progress);
}

// ─── CLI mode ───────────────────────────────────────────────────────

pub fn run_cli(args: &[String]) {
    eprintln!("Pic2WebP CLI mode — v1.6.4");
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

// ─── App builder ────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let tool_paths = resolve_tools(app.handle());
            app.manage(AppState {
                is_converting: Mutex::new(false),
                tool_paths,
                cancel_flag: Arc::new(AtomicBool::new(false)),
                should_close: Arc::new(AtomicBool::new(false)),
                watcher: Mutex::new(None),
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
            check_tools, start_convert, cancel_convert, force_close, get_file_size,
            generate_thumbnail, watch_folder, stop_watch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
