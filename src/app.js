import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { initLang, getLang, setLang, t, translateBackendMessage, getLanguages } from "./i18n.js";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  initLicense, openLicenseDialog, isLicenseDialogOpen, isLicenseExpiredError,
} from "./license.js";

// ─── State ──────────────────────────────────────────────────────────

let files = [];
let selectedDir = null;
let isConverting = false;
let stats = null;
let namingMode = "webp-suffix";
const BATCH_WARN_COUNT = 200;
const LARGE_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

// ─── DOM refs ───────────────────────────────────────────────────────

const $ = (s) => document.querySelector(s);

const dropzone = $("#dropzone");
const fileList = $("#file-list");
const fileCountText = $("#file-count-text");
const clearBtn = $("#clear-btn");
let qualityValue = 80;
const qualityVal = $("#quality-val");
const chkRecursive = $("#chk-recursive");
const chkDelete = $("#chk-delete");
const outputDir = $("#output-dir");
const dirBtn = $("#dir-btn");
const dirClear = $("#dir-clear");
const namingPills = $("#naming-pills");
const convertBtn = $("#convert-btn");
const btnText = $("#btn-text");
const btnSpinner = $("#btn-spinner");
const statsPanel = $("#stats-panel");
const statSuccess = $("#stat-success");
const statSkip = $("#stat-skip");
const statFail = $("#stat-fail");
const statSaved = $("#stat-saved");

const langToggle = $("#lang-toggle");
const themeToggle = $("#theme-toggle");
const chkLossless = $("#chk-lossless");
const chkTargetSize = $("#chk-target-size");
const targetSizeInput = $("#target-size-input");
const chkResize = $("#chk-resize");
const resizeW = $("#resize-w");
const resizeH = $("#resize-h");
const resizeMode = $("#resize-mode");
const chkStructure = $("#chk-structure");
const compareModal = $("#compare-modal");

// ─── Build convert request ─────────────────────────────────────────
function buildRequest(fileList, { recursive, baseDir } = {}) {
  return {
    files: fileList,
    quality: qualityValue,
    recursive: recursive ?? chkRecursive.checked,
    delete_source: chkDelete.checked,
    naming_mode: namingMode,
    output_dir: selectedDir || null,
    lossless: chkLossless?.checked ?? false,
    preserve_structure: chkStructure?.checked ?? false,
    target_size_kb: chkTargetSize?.checked && targetSizeInput ? parseInt(targetSizeInput.value) || null : null,
    resize_enabled: chkResize?.checked ?? false,
    resize_width: resizeW ? parseInt(resizeW.value) || null : null,
    resize_height: resizeH ? parseInt(resizeH.value) || null : null,
    resize_mode: resizeMode?.value ?? "fit",
    base_dir: baseDir ?? null,
  };
}

// ─── Format helpers ─────────────────────────────────────────────────

function formatBytes(bytes, decimals = 1) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(decimals)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(decimals)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(decimals)} GB`;
}


// ─── Add files ───────────────────────────────────────────────────────

const SUPPORTED_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff"];

function fileExt(p) {
  const name = p.split(/[/\\]/).pop() || "";
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

async function addFiles(paths) {
  const skippedExt = [];
  for (const p of paths) {
    if (!p || typeof p !== "string") continue;
    // 目录不校验扩展名：递归 / 保留目录结构整条链路依赖目录项能进列表
    let isFolder = false;
    if (isTauri()) {
      try { isFolder = await invoke("is_dir", { path: p }); } catch (_) {}
    }
    if (!isFolder && !SUPPORTED_EXTS.includes(fileExt(p))) {
      skippedExt.push(p);
      continue;
    }
    if (!files.some((f) => f.path === p)) {
      files.push({ path: p, status: "pending", message: "", savedBytes: 0, savedPct: 0, size: 0, outputPath: null });
    }
  }
  renderFiles();
  checkFileWarnings();
  updateConvertBtn();
  if (skippedExt.length > 0) showUnsupportedHint(skippedExt);
  // Best-effort fetch file sizes for large-file detection
  fetchFileSizes();
  checkFolderHint(paths);
  dropzone.classList.remove("empty");
}

// 在文件列表顶部显示一条临时提示：拖入了不支持的文件。
// HEIC 单独说明——它是最常见的"为什么加不进来"（iPhone 默认格式），
// 一句泛泛的"不支持"只会让用户反复重试。
function showUnsupportedHint(skipped) {
  const existing = document.getElementById("batch-warning");
  if (existing) existing.remove();
  const heic = skipped.filter((p) => fileExt(p) === "heic" || fileExt(p) === "heif").length;
  const others = skipped.length - heic;
  let text = "";
  if (heic > 0) text = t("unsupported-heic", { n: heic });
  if (others > 0) text += (text ? " · " : "") + t("unsupported-dropped", { n: others });
  if (!text) return;
  const warn = document.createElement("div");
  warn.id = "batch-warning";
  warn.className = "hint warn";
  warn.textContent = text;
  const header = document.querySelector(".file-list-header");
  if (header) header.insertAdjacentElement("afterend", warn);
}

async function checkFolderHint(paths) {
  if (chkRecursive.checked) {
    const hint = document.getElementById("folder-hint");
    if (hint) hint.hidden = true;
    return;
  }
  if (!isTauri()) return;
  for (const p of paths) {
    try {
      const isFolder = await invoke("is_dir", { path: p });
      if (isFolder) {
        const hint = document.getElementById("folder-hint");
        if (hint) hint.hidden = false;
        return;
      }
    } catch (_) {
      // Ignore and continue checking other paths
    }
  }
}

function computeBaseDir(fileList) {
  if (!chkStructure?.checked) return null;
  if (fileList.length === 0) return null;
  const firstParent = fileList[0].path.split(/[/\\]/).slice(0, -1).join('/');
  const allSame = fileList.every((f) => {
    const parent = f.path.split(/[/\\]/).slice(0, -1).join('/');
    return parent === firstParent;
  });
  return allSame ? firstParent : null;
}

// ─── Batch / size warnings ────────────────────────────────────────────

function checkFileWarnings() {
  // Remove existing warning
  const existing = document.getElementById("batch-warning");
  if (existing) existing.remove();

  if (files.length === 0) return;

  // Check for large individual files
  const largeFiles = files.filter((f) => f.size > 0 && f.size >= LARGE_FILE_BYTES);
  // Check for large batch count
  const tooMany = files.length > BATCH_WARN_COUNT;

  if (largeFiles.length === 0 && !tooMany) return;

  const warn = document.createElement("div");
  warn.id = "batch-warning";
  warn.className = "hint warn";

  if (largeFiles.length > 0) {
    const f = largeFiles[0];
    const name = f.path.split(/[/\\]/).pop();
    warn.textContent = t("large-file-warn", { name, size: formatBytes(f.size) });
  } else if (tooMany) {
    warn.textContent = t("batch-warn", { n: files.length });
  }

  // Insert after file-list-header
  const header = document.querySelector(".file-list-header");
  header.insertAdjacentElement("afterend", warn);
}

// Fetch file sizes via Tauri (non-blocking, best-effort, parallel)
async function fetchFileSizes() {
  if (!isTauri()) return;
  const pending = files.filter((f) => f.size === 0);
  if (pending.length === 0) return;

  // Batch requests to avoid overwhelming the backend (max 10 concurrent)
  const BATCH = 10;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (f) => {
        try {
          f.size = await invoke("get_file_size", { path: f.path });
        } catch (_) {
          // Non-critical, skip
        }
      })
    );
  }
  renderFiles();
  checkFileWarnings();
}

// ─── Render file list ───────────────────────────────────────────────

// ─── 缩略图加载：并发上限 4 + 缓存去重 ───────────────────────────
const THUMB_MAX = 4;
const thumbCache = new Map();
const thumbInFlight = new Set();
let thumbActive = 0;
const thumbWaiting = [];

function loadThumbnail(path, onDone, onFail) {
  if (thumbInFlight.has(path)) return;
  thumbInFlight.add(path);
  const run = () => {
    thumbActive++;
    invoke("generate_thumbnail", { path, size: 48 })
      .then((dataUrl) => { thumbCache.set(path, dataUrl); onDone(dataUrl); })
      .catch((e) => { console.warn("Thumbnail failed for", path, e); if (onFail) onFail(); })
      .finally(() => {
        thumbInFlight.delete(path);
        thumbActive--;
        const next = thumbWaiting.shift();
        if (next) next();
      });
  };
  if (thumbActive < THUMB_MAX) run();
  else thumbWaiting.push(run);
}

function renderFiles() {
  fileList.innerHTML = "";

  if (files.length === 0) {
    fileList.innerHTML = `
      <div class="empty-state" id="empty-state">
        <p class="empty-hint" data-i18n="empty-hint">${t("empty-hint")}</p>
      </div>`;
    fileCountText.textContent = t("file-count", { n: files.length });
    clearBtn.hidden = true;
    dropzone.classList.add("empty");
    
    return;
  }

  fileCountText.textContent = t("file-count", { n: files.length });
  clearBtn.hidden = false;

  for (const f of files) {
    if (!f.path || typeof f.path !== "string") continue;

    const item = document.createElement("div");
    item.className = "file-item";
    item.dataset.path = f.path;

    const name = f.path.split(/[/\\]/).pop();
    const ext = name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
    const thumbColors = { jpg: '#f59e0b', jpeg: '#f59e0b', png: '#3b82f6', webp: '#10b981' };
    const thumbColor = thumbColors[ext] || '#999';
    const thumbSrc = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="' + thumbColor + '"/><text x="16" y="22" text-anchor="middle" fill="white" font-size="11" font-weight="600">' + ext.toUpperCase() + '</text></svg>')}`;
    // Async load real thumbnail（并发上限 + 缓存去重：一次拖入几百张不再瞬时 N 个 invoke）
    if (isTauri()) {
      const cached = thumbCache.get(f.path);
      const thumbEl = () => item.querySelector(".file-thumb");
      if (cached) { const el = thumbEl(); if (el) el.src = cached; }
      else loadThumbnail(f.path,
        (dataUrl) => { const el = thumbEl(); if (el) el.src = dataUrl; },
        () => { const el = thumbEl(); if (el) el.style.opacity = "0.3"; });
    }

    const retryBtn = f.status === "failed"
      ? `<button class="retry-btn" data-path="${f.path}" title="${t("retry")}">↻</button>`
      : "";
    const deleteBtn = `<button class="file-delete-btn" data-path="${f.path}" title="${t("remove-file")}">×</button>`;

    item.innerHTML = `
      <img class="file-thumb" src="${thumbSrc}" alt="" />
      <div class="file-info">
        <div class="file-name" title="${name}">${name}</div>
        <div class="file-size">${f.savedBytes > 0 ? t("saved-bytes", { size: formatBytes(f.savedBytes) }) : translateBackendMessage(f.message) || ""}</div>
      </div>
      <span class="file-status status-${f.status}">${statusLabel(f.status)}</span>
      ${retryBtn}
      ${deleteBtn}
    `;

    fileList.appendChild(item);

    const retry = item.querySelector(".retry-btn");
    if (retry) {
      retry.addEventListener("click", (e) => {
        e.stopPropagation();
        retrySingleFile(retry.dataset.path);
      });
    }

    // Delete button
    const del = item.querySelector(".file-delete-btn");
    if (del) {
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = files.findIndex((x) => x.path === del.dataset.path);
        if (idx !== -1) {
          files.splice(idx, 1);
          renderFiles();
          updateConvertBtn();
        }
      });
    }

    // Double-click for compare
    item.addEventListener("dblclick", () => {
      showCompare(f.path);
    });
  }
}

async function showCompare(filePath) {
  if (!isTauri()) return;
  const content = document.getElementById("compare-content");
  if (!content) return;
  content.innerHTML = "";

  let currentMode = "side-by-side";
  let origSrc = null;
  let convSrc = null;

  // Load original thumbnail
  try {
    origSrc = await invoke("generate_thumbnail", { path: filePath, size: 600 });
  } catch (_) {}

  // Find converted file: 优先使用后端转换时回报的真实输出路径
  //（否则在输出目录/-q80/时间戳命名/AVIF 等情况下永远找不到文件）
  const record = files.find((f) => f.path === filePath);
  const webpPath = record?.outputPath || null;
  if (webpPath) {
    try {
      convSrc = await invoke("generate_thumbnail", { path: webpPath, size: 600 });
    } catch (_) {}
  }

  function renderSideBySide() {
    content.innerHTML = "";
    const origDiv = document.createElement("div");
    origDiv.style.position = "relative";
    origDiv.innerHTML = `<div class="compare-label">Original</div><img src="${origSrc || ''}" />`;
    content.appendChild(origDiv);
    const convDiv = document.createElement("div");
    convDiv.style.position = "relative";
    convDiv.innerHTML = `<div class="compare-label">WebP</div><img src="${convSrc || ''}" />`;
    content.appendChild(convDiv);
  }

  function renderSlider() {
    content.innerHTML = `
      <div class="compare-overlay-wrap" id="compare-overlay">
        <img src="${convSrc || ''}" alt="Converted" />
        <div class="compare-top" id="compare-top">
          <img src="${origSrc || ''}" alt="Original" />
        </div>
        <div class="compare-slider-line" id="compare-slider-line">
          <div class="compare-slider-handle"></div>
        </div>
      </div>`;
    
    const overlay = document.getElementById("compare-overlay");
    const top = document.getElementById("compare-top");
    const line = document.getElementById("compare-slider-line");
    if (!overlay || !top || !line) return;
    
    let isDragging = false;

    function setPos(e) {
      const rect = overlay.getBoundingClientRect();
      let x = (e.clientX || e.touches?.[0]?.clientX) - rect.left;
      x = Math.max(0, Math.min(x, rect.width));
      const pct = (x / rect.width) * 100;
      top.style.width = pct + "%";
      line.style.left = pct + "%";
    }

    function onStart(e) {
      isDragging = true;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onEnd);
      document.addEventListener("touchmove", onTouchMove, { passive: true });
      document.addEventListener("touchend", onEnd);
    }

    function onMove(e) { if (isDragging) setPos(e); }
    function onTouchMove(e) { if (isDragging) setPos(e); }
    function onEnd() {
      isDragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onEnd);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onEnd);
    }

    line.addEventListener("mousedown", onStart);
    line.addEventListener("touchstart", onStart, { passive: true });
    // Click to move
    overlay.addEventListener("click", (e) => setPos(e));
  }

  // Initial render
  renderSideBySide();

  // Mode toggle buttons
  const sbsBtn = document.getElementById("compare-mode-sbs");
  const sliderBtn = document.getElementById("compare-mode-slider");
  if (sbsBtn && sliderBtn) {
    sbsBtn.addEventListener("click", () => {
      sbsBtn.classList.add("active");
      sliderBtn.classList.remove("active");
      currentMode = "side-by-side";
      renderSideBySide();
    });
    sliderBtn.addEventListener("click", () => {
      sliderBtn.classList.add("active");
      sbsBtn.classList.remove("active");
      currentMode = "slider";
      renderSlider();
    });
  }

  compareModal.classList.add("visible");
}

function statusLabel(s) {
  const m = {
    pending: t("status-pending"),
    compressing: t("status-compressing"),
    converting: t("status-converting"),
    done: t("status-done"),
    skipped: t("status-skipped"),
    failed: t("status-failed"),
  };
  return m[s] || s;
}

// ─── Update UI for file progress ────────────────────────────────────

function updateFileProgress(filePath, status, message, savedBytes, savedPct, outputPath) {
  const f = files.find((x) => x.path === filePath);
  if (!f) return;
  f.status = status;
  f.message = message;
  f.savedBytes = savedBytes;
  f.savedPct = savedPct;
  if (outputPath) f.outputPath = outputPath;

  // 不用 CSS.escape（它用于 CSS 标识符，不适合属性值），
  // 改为遍历查找，兼容 Windows 路径中的反斜杠
  const items = fileList.querySelectorAll(".file-item");
  let item = null;
  for (const el of items) {
    if (el.dataset.path === filePath) { item = el; break; }
  }
  if (item) {
    const badge = item.querySelector(".file-status");
    badge.className = `file-status status-${status}`;
    badge.textContent = statusLabel(status);
    const size = item.querySelector(".file-size");
    size.textContent = savedBytes > 0 ? t("saved-bytes", { size: formatBytes(savedBytes) }) : translateBackendMessage(message) || "";

    // Auto-scroll to the file currently being processed
    if (status === "compressing" || status === "converting") {
      item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }
  updateProgress();
}

let totalTasks = 0;

function updateProgress() {
  const container = document.getElementById("progress-bar-container");
  const fill = document.getElementById("progress-bar-fill");
  const text = document.getElementById("progress-text");
  if (!container || !fill || !text) return;
  if (isConverting) {
    const total = totalTasks > 0 ? totalTasks : files.length;
    const done = files.filter(f => f.status === 'done' || f.status === 'skipped' || f.status === 'failed').length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    container.hidden = false;
    fill.style.width = pct + "%";
    text.textContent = `${done}/${total} (${pct}%)`;
  } else {
    container.hidden = true;
    fill.style.width = "0%";
  }
}

// ─── Update stats ───────────────────────────────────────────────────

// 重试只统计本次批次，界面统计要叠加，否则之前成功的文件会从面板上消失
let retryBase = null;

function updateStats(s) {
  stats = s;
  statsPanel.hidden = false;
  const b = retryBase || { success_count: 0, skip_count: 0, fail_count: 0, saved: 0 };
  statSuccess.textContent = (b.success_count || 0) + (s.success_count || 0);
  statSkip.textContent = (b.skip_count || 0) + (s.skip_count || 0);
  statFail.textContent = (b.fail_count || 0) + (s.fail_count || 0);
  statSaved.textContent = formatBytes((b.saved || 0) + (s.saved || 0));
}

// ─── Convert button state ───────────────────────────────────────────

function updateConvertBtn() {
  if (isConverting) {
    convertBtn.disabled = false;
    btnText.textContent = t("cancel-convert");
    btnSpinner.hidden = true;
    convertBtn.classList.add("cancel-mode");
    return;
  }
  convertBtn.classList.remove("cancel-mode");
  btnSpinner.hidden = true;

  if (files.length === 0) {
    convertBtn.disabled = true;
    btnText.textContent = t("start-convert");
    return;
  }

  const allDone = files.every((f) => f.status === "done" || f.status === "skipped" || f.status === "failed");
  if (allDone && files.length > 0) {
    btnText.textContent = t("re-convert");
  } else {
    btnText.textContent = t("start-convert");
  }

  convertBtn.disabled = false;
}

// ─── Start conversion ───────────────────────────────────────────────

// 取消在 IPC 往返途中点击时，后端会在 start_convert 里把取消标志清零
// （防止上一轮的残留取消杀掉新批次）。Promise 解析发生在清零之后，
// 所以这里记住这笔取消，由 startConvert 在 await 之后补发一次。
let cancelPending = false;

async function startConvert() {
  retryBase = null;
  totalTasks = files.length;
  if (isConverting) return;
  cancelPending = false;

  // P0-3: Confirm before deleting source files
  if (chkDelete.checked) {
    const yes = await ask(t("confirm-delete"), { title: "Pic2WebP", kind: "warning" });
    if (!yes) return;
  }

  // P0-C1: 整批产物落在同一个卷上。先确认目标卷装得下这一批，
  // 否则会一个接一个 write_fail，用户看到的是一片红色失败。
  if (!(await confirmDiskSpace())) return;

  isConverting = true;
  updateConvertBtn();

  for (const f of files) {
    f.status = "pending";
    f.message = "";
    f.savedBytes = 0;
    f.savedPct = 0;
  }
  renderFiles();

  stats = null;
  statsPanel.hidden = true;
  const retryAllBtn = document.getElementById("retry-all-btn");
  if (retryAllBtn) retryAllBtn.hidden = true;

  const baseDir = computeBaseDir(files);
  const req = buildRequest(files.map((f) => f.path), { baseDir });
  try {
    await invoke("start_convert", { request: req });
    // 见 cancelPending：取消若赶在后端清零之前点击，这里补刀。
    if (cancelPending) {
      cancelPending = false;
      invoke("cancel_convert").catch((e) => console.warn("Cancel failed:", e));
    }
  } catch (e) {
    for (const f of files) {
      f.status = "pending";
      f.message = "";
      f.savedBytes = 0;
      f.savedPct = 0;
    }
    renderFiles();
    isConverting = false;
    updateConvertBtn();
    // 试用过期被拦：弹激活对话框（不是裸错误）。Rust 同时会 emit license-expired，
    // 这里按错误码再判一次作双保险；openLicenseDialog 重复打开只会刷新内容。
    if (isLicenseExpiredError(e)) { openLicenseDialog(); return; }
    alert(t("convert-failed") + ": " + e);
  }
}

// P0-C1: 目标卷剩余空间能否容纳本批。返回 false = 用户叫停。
// 探测失败不阻塞（宁漏报不误报），写盘时报错一样看得见。
async function confirmDiskSpace() {
  if (!isTauri()) return true;
  const need = files.reduce((sum, f) => sum + (f.size > 0 ? f.size : 0), 0);
  if (need <= 0) return true; // 体积未知（目录项/未取到大小）——无法估算，跳过
  const dest = selectedDir || (files[0]?.path
    ? files[0].path.split(/[/\\]/).slice(0, -1).join("/")
    : null);
  if (!dest) return true;
  try {
    const free = await invoke("check_disk_space", { path: dest });
    // +10% 余量：目录元数据、时间戳命名重试、目标大小模式都可能放大产物
    if (typeof free === "number" && free < need * 1.1) {
      return await ask(t("confirm-disk-space", {
        free: formatBytes(free),
        need: formatBytes(need),
      }), { title: "Pic2WebP", kind: "warning" });
    }
  } catch (e) {
    console.warn("Disk space probe failed:", e);
  }
  return true;
}

// ─── Retry single failed file ──────────────────────────────────────

async function retrySingleFile(path) {
  retryBase = stats ? { ...stats } : null;
  if (isConverting) return;
  const f = files.find((x) => x.path === path);
  if (!f) return;

  // Enter converting state so the button becomes "cancel" and concurrent starts are blocked
  isConverting = true;
  updateConvertBtn();

  f.status = "pending";
  f.message = "";
  f.savedBytes = 0;
  f.savedPct = 0;
  renderFiles();

  const req = buildRequest([path], { recursive: false });
  try {
    await invoke("start_convert", { request: req });
  } catch (e) {
    console.warn("Retry failed:", e);
    isConverting = false;
    updateConvertBtn();
    if (isLicenseExpiredError(e)) { openLicenseDialog(); return; }
    alert(t("convert-failed") + ": " + e);
  }
}

// ─── Retry all failed files (P1-5) ─────────────────────────────────

async function retryAllFailed() {
  retryBase = stats ? { ...stats } : null;
  if (isConverting) return;
  const failedFiles = files.filter((f) => f.status === "failed");
  if (failedFiles.length === 0) return;

  for (const f of failedFiles) {
    f.status = "pending";
    f.message = "";
    f.savedBytes = 0;
    f.savedPct = 0;
  }
  renderFiles();

  isConverting = true;
  updateConvertBtn();

  const req = buildRequest(failedFiles.map((f) => f.path), { recursive: false });
  try {
    await invoke("start_convert", { request: req });
  } catch (e) {
    console.warn("Retry all failed:", e);
    isConverting = false;
    updateConvertBtn();
    if (isLicenseExpiredError(e)) openLicenseDialog();
  }
}

// ─── Event listeners ────────────────────────────────────────────────

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragover");
});

dropzone.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => f.path)
      .filter(Boolean);
    if (paths.length > 0) await addFiles(paths);
  }
});

// 键盘可达：Tab 聚焦拖放区后 Enter/Space 打开文件选择器（原为纯 div，键盘用户无法添加文件）
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
    e.preventDefault();
    dropzone.click();
  }
});

dropzone.addEventListener("click", async () => {
  try {
    const result = await open({
      multiple: true,
      filters: [
        { name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff"] }
      ]
    });
    if (result && Array.isArray(result)) {
      await addFiles(result);
    } else if (typeof result === "string") {
      await addFiles([result]);
    }
  } catch (e) {
    console.warn("Dialog not available:", e);
  }
});

clearBtn.addEventListener("click", () => {
  files = [];
  stats = null;
  statsPanel.hidden = true;
  const warn = document.getElementById("batch-warning");
  if (warn) warn.remove();
  renderFiles();
  updateConvertBtn();
});

// Quality presets — update value + q-suffix pill label (no slider)
function setQuality(v) {
  qualityValue = Math.max(10, Math.min(100, parseInt(v) || 80));
  qualityVal.textContent = qualityValue;
  const qPill = namingPills.querySelector('[data-value="q-suffix"]');
  if (qPill) qPill.textContent = `-q${qualityValue}`;
  document.querySelectorAll("#quality-pills .pill-btn").forEach((b) => {
    b.classList.toggle("active", parseInt(b.dataset.q) === qualityValue);
  });
}

document.querySelectorAll("#quality-pills .pill-btn").forEach((b) => {
  b.addEventListener("click", () => setQuality(b.dataset.q));
});

chkRecursive.addEventListener("change", () => {
  if (chkRecursive.checked) {
    const hint = document.getElementById("folder-hint");
    if (hint) hint.hidden = true;
  }
});

// Naming mode — pill buttons
namingPills.querySelectorAll(".pill-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    namingPills.querySelectorAll(".pill-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    namingMode = btn.dataset.value;
    const warn = document.getElementById("overwrite-warning");
    if (warn) warn.hidden = namingMode !== "overwrite";
  });
});

// Output dir —— 记住上次选择（localStorage），不必每次开应用重选
const OUTPUT_DIR_KEY = "pic2webp-output-dir";

function applyOutputDir(dir) {
  selectedDir = dir || null;
  outputDir.value = dir || "";
  dirClear.hidden = !dir;
  if (dir) localStorage.setItem(OUTPUT_DIR_KEY, dir);
  else localStorage.removeItem(OUTPUT_DIR_KEY);
}

dirBtn.addEventListener("click", async () => {
  try {
    const dir = await open({ directory: true, title: t("select-output-dir") });
    if (dir) applyOutputDir(dir);
  } catch (e) {
    console.log("Dialog not available:", e);
  }
});

dirClear.addEventListener("click", () => {
  applyOutputDir(null);
});

convertBtn.addEventListener("click", () => {
  if (isConverting) {
    // latch：取消若赶在后端清零之前，startConvert 在 await 之后补发
    cancelPending = true;
    invoke("cancel_convert").catch((e) => console.warn("Cancel failed:", e));
  } else {
    startConvert();
  }
});

// P1-5: Retry all failed button
const retryAllBtn = document.getElementById("retry-all-btn");
if (retryAllBtn) {
  retryAllBtn.addEventListener("click", retryAllFailed);
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  // 激活对话框打开时不触发全局转换快捷键（输入框自身的 Enter 走激活流程）
  if (isLicenseDialogOpen()) return;
  const tag = e.target.tagName;
  // 排除表单元素与按钮：按钮自带 Enter 激活，全局再触发一次会双重开始转换
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
  if (convertBtn && !convertBtn.disabled) startConvert();
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  
  // Escape close compare modal
  if (e.key === "Escape") {
    if (compareModal.classList.contains("visible")) {
      compareModal.classList.remove("visible");
    }
  }
  
  // Cmd+Backspace clear all files
  if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
    if (files.length > 0) {
      files = [];
      stats = null;
      statsPanel.hidden = true;
      const warn = document.getElementById("batch-warning");
      if (warn) warn.remove();
      renderFiles();
      updateConvertBtn();
    }
  }
});

// ─── Tauri event listeners ──────────────────────────────────────────

async function setupListeners() {
  // P0-2: Close window confirmation during conversion
  await listen("confirm-close", async () => {
    const yes = await ask(t("confirm-close"), { title: "Pic2WebP", kind: "warning" });
    if (yes) {
      await invoke("force_close").catch((e) => console.warn("force_close failed:", e));
    }
  });

  await listen("convert-progress", (event) => {
    const p = event.payload;
    updateFileProgress(p.file, p.status, p.message, p.saved_bytes, p.saved_pct, p.output_path);
  });

  await listen("convert-stats", (event) => {
    updateStats(event.payload);
  });

  await listen("convert-done", (event) => {
    isConverting = false;
  for (const f of files) {
    // 取消时后端不再为被中断的文件补发状态，否则会永久卡在"转换中"
    if (f.status === "converting" || f.status === "compressing") f.status = "pending";
    if (f.status === "pending") {
        f.message = "";
        f.savedBytes = 0;
        f.savedPct = 0;
      }
    }
    renderFiles();
    updateStats(event.payload);
    updateConvertBtn();
    // P1-5: Show retry-all button if there are failed files
    const retryAllBtn = document.getElementById("retry-all-btn");
    if (retryAllBtn) {
      retryAllBtn.hidden = (event.payload.fail_count === 0);
    }
    // Pulse the stats panel to draw attention to results
    statsPanel.classList.add("pulse");
    setTimeout(() => statsPanel.classList.remove("pulse"), 1000);
  });
}

// ─── Language toggle ─────────────────────────────────────────────────

function updateLangToggle() {
  const lang = getLang();
  const langs = getLanguages();
  if (!langToggle) return;
  // Only populate options once
  if (langToggle.options.length === 0) {
    langs.forEach((l) => {
      const opt = document.createElement("option");
      opt.value = l.code;
      opt.textContent = l.label;
      langToggle.appendChild(opt);
    });
  }
  langToggle.value = lang;
}

// ── 主题：auto → light → dark 三态循环（家族 §6.5 唯一状态机）────────
// 存储键沿用既有的 "rocktier.theme"：无值 = auto（跟随系统），light/dark 显式。
// 改键会让老用户的主题偏好丢失，所以这里只扩值域、不换键。
const THEME_KEY = "rocktier.theme";
const THEME_CYCLE = ["auto", "light", "dark"];
if (themeToggle) {
  const lightMq = window.matchMedia("(prefers-color-scheme: light)");

  function systemTheme() {
    return lightMq.matches ? "light" : "dark";
  }

  /** auto 落成实际生效值 —— data-theme 只接受 light/dark。 */
  function resolveTheme(mode) {
    return mode === "auto" ? systemTheme() : mode;
  }

  function readMode() {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "auto";
  }

  function syncButton(mode) {
    themeToggle.dataset.mode = mode;
    const label = t(`theme-mode-${mode}`);
    themeToggle.title = `${t("themeBtn")} · ${label}`;
    themeToggle.setAttribute("aria-label", `${t("themeBtn")}: ${label}`);
  }

  function applyTheme(mode) {
    document.documentElement.setAttribute("data-theme", resolveTheme(mode));
    syncButton(mode);
  }

  applyTheme(readMode());

  // auto 态下系统外观变了要跟着变；light/dark 是用户明确选择，不动。
  lightMq.addEventListener("change", () => {
    if (readMode() === "auto") applyTheme("auto");
  });

  themeToggle.addEventListener("click", () => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(readMode()) + 1) % THEME_CYCLE.length];
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (e) {
      // 隐私模式：本次会话仍然生效
    }
    applyTheme(next);
  });

  // 语言切换后重算 title / aria-label
  window.addEventListener("lang-changed", () => syncButton(readMode()));
}

// ── Target size toggle ──
if (chkTargetSize) {
  chkTargetSize.addEventListener("change", () => {
    targetSizeInput.style.display = chkTargetSize.checked ? "inline-block" : "none";
  });
}

// 选择文件夹（部分平台拖不进目录，给一个显式入口）
const folderBtn = document.getElementById("folder-btn");
if (folderBtn) {
  folderBtn.addEventListener("click", async () => {
    try {
      const dir = await open({ directory: true, title: t("select-folder") });
      if (dir) await addFiles([dir]);
    } catch (e) {
      console.warn("Folder dialog not available:", e);
    }
  });
}

// ── Compare modal ──
if (compareModal) {
  compareModal.addEventListener("click", (e) => {
    if (e.target === compareModal) compareModal.classList.remove("visible");
  });
}

// ─── Family-standard menu ───────────────────────────────────────────
const menuActions = {
  open: () => dropzone.click(),
  clear: () => clearBtn.click(),
  theme: () => themeToggle.click(),
  website: () => openUrl("https://rocktier.com/pic2webp.html").catch(() => {}),
  // 此前菜单项被创建但 menuActions 无分支 → 点了完全无反应（家族审查发现）。
  feedback: () => openUrl("mailto:hello@rocktier.com?subject=Rocktier%20Pic2WebP%20Feedback").catch(() => {}),
};

if (isTauri()) {
  listen("menu-action", (e) => menuActions[e.payload]?.()).catch(() => {});
  // 菜单必须在 initLang() 之后构建，否则保存的语言偏好不生效（见 init()）
}

if (langToggle) {
  langToggle.addEventListener("change", () => {
    setLang(langToggle.value);
    updateLangToggle();
    if (isTauri()) invoke("build_menu", { lang: getLang() }).catch(() => {});
    // Re-render file list to update dynamic text
    renderFiles();
    updateConvertBtn();
  });
}

// ─── Init ────────────────────────────────────────────────────────────

async function init() {
  initLang();
  updateLangToggle();
  // 语言已就绪：此刻构建菜单才能用上用户保存的语言
  if (isTauri()) invoke("build_menu", { lang: getLang() }).catch(() => {});

  // 恢复上次的输出目录（目录后来被删掉也没关系：后端 create_dir_all 会建回来）
  applyOutputDir(localStorage.getItem(OUTPUT_DIR_KEY));

  // First render so the empty-state guide toggle gets its click listener bound
  renderFiles();

  // Re-render on language change (for dynamic content not covered by applyLang)
  window.addEventListener("lang-changed", () => {
    renderFiles();
    updateConvertBtn();
  });

  updateConvertBtn();

  if (!isTauri()) return;

  await setupListeners();

  // 授权（家族 L6）：启动拉状态更新胶囊；订阅 license-expired 开激活对话框
  initLicense();

  await listen("convert-total", (event) => {
    totalTasks = Number(event.payload) || 0;
  });

  await listen("tauri://drag-drop", async (event) => {
    const raw = event.payload.paths || [];
    const paths = raw.map((p) => (typeof p === "string" ? p : p && p.path)).filter(Boolean);
    if (paths.length > 0) await addFiles(paths);
  });
}

init();
