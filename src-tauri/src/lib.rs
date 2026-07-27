use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use image::ImageReader;
use tauri::{AppHandle, Emitter, Manager, State};

// ─── Data types ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertRequest {
    pub files: Vec<String>,
    pub quality: i32,
    pub recursive: bool,
    pub delete_source: bool,
    pub output_dir: Option<String>,
    pub naming_mode: String,
}

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
    let tool_names = ["jpegoptim", "pngquant", "oxipng"];
    let mut map = HashMap::new();
    let mut search_dirs: Vec<PathBuf> = Vec::new();

    if let Ok(res_dir) = app.path().resource_dir() {
        search_dirs.push(res_dir.clone());
        // CR1: also search resource_dir/tools/ (Windows bundle places tools here)
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
            // S2: which auto-searches PATHEXT on Windows, so pass bare name
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
/// Helper: unlock is_converting and return an Err with the given message.
macro_rules! bail_and_unlock {
    ($guard:expr, $msg:expr) => {{
        *$guard = false;
        drop($guard);
        return Err(($msg).into());
    }};
}

#[tauri::command]
fn start_convert(app: AppHandle, state: State<AppState>, request: ConvertRequest) -> Result<(), String> {
    let mut converting = state.is_converting.lock().map_err(|e| e.to_string())?;
    if *converting {
        return Err("ERR_ALREADY_CONVERTING".into());
    }
    *converting = true;

    // Read tool paths (clone before dropping the lock)
    let jpegoptim = state.tool_paths.get("jpegoptim").and_then(|o| o.clone());
    let pngquant = state.tool_paths.get("pngquant").and_then(|o| o.clone());
    let oxipng = state.tool_paths.get("oxipng").and_then(|o| o.clone());

    let quality = request.quality.clamp(10, 100);

    // ── Collect files ──
    let mut all_files: Vec<String> = Vec::new();
    let supported = ["jpg", "jpeg", "png", "webp", "avif"];

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

    // Reset cancel flag for this run
    let cancel_flag = state.cancel_flag.clone();
    cancel_flag.store(false, Ordering::Relaxed);

    // Release the converting lock right before spawning the background thread
    drop(converting);

    std::thread::spawn(move || {
        for src_path in &all_files {
            if cancel_flag.load(Ordering::Relaxed) {
                break;
            }
            let path = Path::new(src_path);
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            let parent = path.parent().unwrap_or(Path::new(""));
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
            // N1: build filename based on naming mode
            let filename = match request.naming_mode.as_str() {
                "overwrite" => format!("{}.webp", stem),
                "webp-suffix" => format!("{}-webp.webp", stem),
                "q-suffix" => format!("{}-q{}.webp", stem, quality),
                "ts-suffix" => {
                    use std::time::{SystemTime, UNIX_EPOCH};
                    let ts = SystemTime::now()
                        .duration_since(UNIX_EPOCH).unwrap_or_default()
                        .as_millis();
                    format!("{}-{}.webp", stem, ts)
                }
                _ => format!("{}.webp", stem),
            };

            // S1: use set_extension instead of format! to avoid panic on {} in filename
            let output_path = match &request.output_dir {
                Some(dir) => {
                    let dir_path = Path::new(dir);
                    std::fs::create_dir_all(dir_path).ok();
                    Path::new(dir).join(&filename)
                }
                None => {
                    parent.join(&filename)
                }
            };
            let output_str = output_path.to_string_lossy().to_string();

            // ── Step 1: pre-compress JPEG ──
            if (ext == "jpg" || ext == "jpeg") && jpegoptim.is_some() {
                emit_progress(&app_handle, src_path, "compressing", "precompress_jpeg", 0, 0);
                let mut cmd = Command::new(jpegoptim.as_ref().unwrap());
                cmd.arg("--strip-all").arg("--all-normal").arg(src_path);
                run_cmd_timeout(&mut cmd, 60, &cancel_flag); // CR11: 60s for jpegoptim
                if cancel_flag.load(Ordering::Relaxed) { continue; }
            }

            // ── Step 2: pre-compress PNG ──
            if ext == "png" {
                emit_progress(&app_handle, src_path, "compressing", "precompress_png", 0, 0);

                // P1: use system temp dir, no path traversal
                // S1: use set_extension to avoid format! panic on {}
                // CR6: stem is a format arg (not template), so {test} filenames are safe
                // CR9: Windows MAX_PATH: temp_dir ~40 chars + prefix ~20 + stem + .pngquant.png
                //      may exceed 260 on extreme filenames (>180 chars), but rare
                let pngquant_output = if let (Some(tool), Some(oxi)) = (&pngquant, &oxipng) {
                    let temp_dir = std::env::temp_dir();
                    let stem = Path::new(src_path).file_stem().and_then(|s| s.to_str()).unwrap_or("temp");
                    debug_assert!(!stem.contains('/') && !stem.contains('\\'), "stem contains path separator");
                    let mut tmp_path = temp_dir.join(format!("pic2webp-{}-{}", std::process::id(), stem));
                    tmp_path.set_extension("pngquant.png");
                    let tmp_str = tmp_path.to_string_lossy().to_string();

                    let mut png_cmd = Command::new(tool);
                    // M7: cap at 85 — pngquant compression above 85 is negligible,
                    // WebP encoder re-encodes anyway. The min bound follows user quality slider.
                    png_cmd.arg("--quality")
                        .arg(format!("{}-100", quality.min(85)))
                        .arg("--force")
                        .arg("--output")
                        .arg(&tmp_str)
                        .arg(src_path);
                    let (code, _) = run_cmd_timeout(&mut png_cmd, 90, &cancel_flag);

                    if code == 0 && tmp_path.exists() {
                        let mut oxi_cmd = Command::new(oxi);
                        oxi_cmd.arg("--strip").arg("safe")
                            .arg("--opt").arg("3")
                            .arg("--out").arg(src_path)
                            .arg(&tmp_str);
                        run_cmd_timeout(&mut oxi_cmd, 120, &cancel_flag);
                        let _ = std::fs::remove_file(&tmp_str);
                        true
                    } else {
                        let _ = std::fs::remove_file(&tmp_str);
                        false
                    }
                } else {
                    false
                };

                if !pngquant_output {
                    // pngquant unavailable or failed — try oxipng directly on original
                    if let Some(ref oxi) = oxipng {
                        let mut oxi_cmd = Command::new(oxi);
                        oxi_cmd.arg("--strip").arg("safe")
                            .arg("--opt").arg("1")
                            .arg(src_path);
                        run_cmd_timeout(&mut oxi_cmd, 120, &cancel_flag);
                    }
                }
            }   // ← CR2: if-ext-png closes here

            // Read original_size AFTER pre-compression (jpegoptim/oxipng modify src in place)
            let original_size = std::fs::metadata(src_path).map(|m| m.len() as i64).unwrap_or(0);
            stats.total_original += original_size;

            // ── Step 3: decode image & encode to WebP (native, no external cwebp) ──
            emit_progress(&app_handle, src_path, "converting", "converting", 0, 0);

            // Check file size and image dimensions before full decode to avoid OOM
            let file_size = std::fs::metadata(src_path).map(|m| m.len()).unwrap_or(0);
            if file_size > 100_000_000 {
                // File > 100MB — skip regardless of dimensions
                stats.fail_count += 1;
                emit_progress(&app_handle, src_path, "skipped",
                    &format!("too_large:{}MB", file_size / 1_000_000), 0, 0);
                let _ = app_handle.emit("convert-stats", &stats);
                continue;
            }
            let dims = ImageReader::open(src_path)
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

            let img = match ImageReader::open(src_path)
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

            let (w, h) = (img.width(), img.height());
            let encode_result = if img.color().has_alpha() {
                let rgba = img.to_rgba8();
                webp::Encoder::from_rgba(rgba.as_raw(), w, h)
                    .encode_simple(false, quality as f32)
            } else {
                let rgb = img.to_rgb8();
                webp::Encoder::from_rgb(rgb.as_raw(), w, h)
                    .encode_simple(false, quality as f32)
            };

            match encode_result {
                Ok(webp_mem) => {
                    let new_size = webp_mem.len() as i64;

                    // Skip if WebP output is not smaller than original
                    if new_size >= original_size && original_size > 0 {
                        stats.skip_count += 1;
                        stats.total_converted += original_size;
                        emit_progress(&app_handle, src_path, "skipped", "skipped", 0, 0);
                    } else if let Err(e) = std::fs::write(&output_str, &*webp_mem) {
                        stats.fail_count += 1;
                        emit_progress(&app_handle, src_path, "failed", &format!("write_fail:{}", e), 0, 0);
                    } else {
                        stats.total_converted += new_size;

                        let saved_bytes = original_size - new_size;
                        let saved_pct = if original_size > 0 {
                            (saved_bytes * 100 / original_size) as i32
                        } else {
                            0
                        };
                        stats.success_count += 1;

                        emit_progress(&app_handle, src_path, "done", &format!("saved:{}kb", new_size / 1024), saved_bytes, saved_pct);

                        if request.delete_source {
                            if let Err(e) = std::fs::remove_file(src_path) {
                                emit_progress(&app_handle, src_path, "done",
                                    &format!("delete_fail:{}", e), saved_bytes, saved_pct);
                            }
                        }
                    }
                }
                Err(e) => {
                    stats.fail_count += 1;
                    emit_progress(&app_handle, src_path, "failed", &format!("encode_fail:{:?}", e), 0, 0);
                }
            }

            let _ = app_handle.emit("convert-stats", &stats);
        }

        stats.saved = stats.total_original - stats.total_converted;
        stats.saved_pct = if stats.total_original > 0 {
            (stats.saved * 100 / stats.total_original) as i32
        } else {
            0
        };

        let _ = app_handle.emit("convert-done", &stats);

        if let Some(state) = app_handle.try_state::<AppState>() {
            if let Ok(mut converting) = state.is_converting.lock() {
                *converting = false;
            }
        }
    });

    Ok(())
}

// ─── Command timeout helper (H2) ──────────────────────────────────

/// Run a command with a timeout. Returns (exit_code, combined stdout+stderr).
/// Kills the process if it exceeds the timeout.
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

    // Wait thread owns child; uses try_wait() so it can respond to kill/cancel signal
    let cancel_flag_w = cancel_flag.clone();
    let exit_tx2 = exit_tx.clone();
    std::thread::spawn(move || {
        loop {
            // Check kill signal from main thread
            match kill_rx.try_recv() {
                Ok(()) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
            // Check cancel flag from user
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

    // Poll for result, also checking cancel_flag for user-initiated cancel
    let start = std::time::Instant::now();
    let result = loop {
        match exit_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(s)) => break Ok(s),
            Ok(Err(_)) => break Err(1i32), // ERR_PROCESS
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if cancel_flag.load(Ordering::Relaxed) {
                    cancelled.store(true, Ordering::Relaxed);
                    let _ = kill_tx.send(());
                    break Err(2i32); // cancelled
                }
                if start.elapsed() >= Duration::from_secs(secs) {
                    break Err(3i32); // timeout
                }
                continue;
            }
            Err(_) => break Err(4i32), // ERR_CHANNEL
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
            // Timeout: kill child via channel only (P1-4: no redundant kill_process)
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
        .invoke_handler(tauri::generate_handler![check_tools, start_convert, cancel_convert, force_close, get_file_size])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
