import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { initLang, getLang, toggleLang, t, translateBackendMessage } from "./i18n.js";

// ─── State ──────────────────────────────────────────────────────────

let files = [];
let selectedDir = null;
let isConverting = false;
let stats = null;
let namingMode = "webp-suffix";
let lastConvertRequest = null;

// Thresholds
const LARGE_FILE_BYTES = 50 * 1024 * 1024; // 50MB
const BATCH_WARN_COUNT = 200;

// ─── DOM refs ───────────────────────────────────────────────────────

const $ = (s) => document.querySelector(s);

const dropzone = $("#dropzone");
const fileList = $("#file-list");
const fileCountText = $("#file-count-text");
const clearBtn = $("#clear-btn");
const qualitySlider = $("#quality-slider");
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
const donateBtn = $("#donate-btn");
const donateModal = $("#donate-modal");
const modalClose = $("#modal-close");
const langToggle = $("#lang-toggle");
const langZh = $("#lang-zh");
const langEn = $("#lang-en");
const themeToggle = $("#theme-toggle");
const chkLossless = $("#chk-lossless");
const chkTargetSize = $("#chk-target-size");
const targetSizeInput = $("#target-size-input");
const advancedToggle = $("#advanced-toggle");
const advancedSection = $("#advanced-section");
const chkResize = $("#chk-resize");
const resizeW = $("#resize-w");
const resizeH = $("#resize-h");
const resizeMode = $("#resize-mode");
const outputFormat = $("#output-format");
const chkWatermark = $("#chk-watermark");
const watermarkText = $("#watermark-text");
const chkStructure = $("#chk-structure");
const chkExif = $("#chk-exif");
const watchBtn = $("#watch-btn");
const compareModal = $("#compare-modal");

// ─── Build convert request ─────────────────────────────────────────
function buildRequest(fileList, { recursive, baseDir } = {}) {
  return {
    files: fileList,
    quality: Math.max(10, Math.min(100, parseInt(qualitySlider.value) || 80)),
    recursive: recursive ?? chkRecursive.checked,
    delete_source: chkDelete.checked,
    naming_mode: namingMode,
    output_dir: selectedDir || null,
    lossless: chkLossless?.checked ?? false,
    strip_exif: chkExif?.checked ?? false,
    preserve_structure: chkStructure?.checked ?? false,
    target_size_kb: chkTargetSize?.checked && targetSizeInput ? parseInt(targetSizeInput.value) || null : null,
    output_format: outputFormat?.value ?? "webp",
    resize_enabled: chkResize?.checked ?? false,
    resize_width: resizeW ? parseInt(resizeW.value) || null : null,
    resize_height: resizeH ? parseInt(resizeH.value) || null : null,
    resize_mode: resizeMode?.value ?? "fit",
    watermark_text: chkWatermark?.checked && watermarkText ? watermarkText.value : null,
    watermark_opacity: 0.5,
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

// ─── Tool check ─────────────────────────────────────────────────────

let toolCheck = null;

async function checkTools() {
  if (!isTauri()) {
    updateConvertBtn();
    return;
  }
  try {
    toolCheck = await invoke("check_tools");
    updateToolStatus();
  } catch (e) {
    console.warn("Tool check failed:", e);
  }
  updateConvertBtn();
}

function updateToolStatus() {
  const el = document.getElementById("tool-status");
  if (!el || !toolCheck) return;

  const tools = [
    { name: "jpegoptim", available: toolCheck.jpegoptim },
    { name: "pngquant", available: toolCheck.pngquant },
    { name: "oxipng", available: toolCheck.oxipng },
    { name: "ffmpeg", available: toolCheck.ffmpeg },
  ];

  const anyAvailable = tools.some((tt) => tt.available);
  if (!anyAvailable) {
    el.textContent = t("no-precompress");
    el.hidden = false;
    return;
  }

  el.textContent = tools
    .map((tt) => `${tt.available ? "✓" : "✗"} ${tt.name}`)
    .join(" · ");
  el.hidden = false;
}

// ─── Add files ───────────────────────────────────────────────────────

function addFiles(paths) {
  for (const p of paths) {
    if (!p || typeof p !== "string") continue;
    if (!files.some((f) => f.path === p)) {
      files.push({ path: p, status: "pending", message: "", savedBytes: 0, savedPct: 0, size: 0 });
    }
  }
  renderFiles();
  checkFileWarnings();
  updateConvertBtn();
  // Best-effort fetch file sizes for large-file detection
  fetchFileSizes();
  checkFolderHint(paths);
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

function renderFiles() {
  fileList.innerHTML = "";

  if (files.length === 0) {
    fileList.innerHTML = `
      <div class="empty-state">
        <div class="info-section">
          <p data-i18n="why-webp">${t("why-webp")}</p>
          <ul>
            <li data-i18n="why-1">${t("why-1")}</li>
            <li data-i18n="why-2">${t("why-2")}</li>
            <li data-i18n="why-3">${t("why-3")}</li>
            <li data-i18n="why-4">${t("why-4")}</li>
          </ul>
        </div>
        <div class="info-section">
          <p data-i18n="how-title">${t("how-title")}</p>
          <ul>
            <li data-i18n="how-1">${t("how-1")}</li>
            <li data-i18n="how-2">${t("how-2")}</li>
            <li data-i18n="how-3">${t("how-3")}</li>
            <li data-i18n="how-4">${t("how-4")}</li>
          </ul>
        </div>
        <div class="info-section">
          <p data-i18n="tips-title">${t("tips-title")}</p>
          <ul>
            <li data-i18n="tips-1">${t("tips-1")}</li>
            <li data-i18n="tips-2">${t("tips-2")}</li>
            <li data-i18n="tips-3">${t("tips-3")}</li>
          </ul>
        </div>
      </div>`;
    fileCountText.textContent = t("file-count", { n: files.length });
    clearBtn.hidden = true;
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
    // Async load real thumbnail
    if (isTauri()) {
      invoke("generate_thumbnail", { path: f.path, size: 48 }).then((dataUrl) => {
        const imgEl = item.querySelector(".file-thumb");
        if (imgEl) imgEl.src = dataUrl;
      }).catch((e) => {
        const imgEl = item.querySelector(".file-thumb");
        if (imgEl) imgEl.style.opacity = "0.3";
        console.warn("Thumbnail failed for", f.path, e);
      });
    }

    const retryBtn = f.status === "failed"
      ? `<button class="retry-btn" data-path="${f.path}" title="${t("retry")}">↻</button>`
      : "";

    item.innerHTML = `
      <img class="file-thumb" src="${thumbSrc}" alt="" />
      <div class="file-info">
        <div class="file-name" title="${name}">${name}</div>
        <div class="file-size">${f.savedBytes > 0 ? t("saved-bytes", { size: formatBytes(f.savedBytes) }) : translateBackendMessage(f.message) || ""}</div>
      </div>
      <span class="file-status status-${f.status}">${statusLabel(f.status)}</span>
      ${retryBtn}
    `;

    fileList.appendChild(item);

    const retry = item.querySelector(".retry-btn");
    if (retry) {
      retry.addEventListener("click", (e) => {
        e.stopPropagation();
        retrySingleFile(retry.dataset.path);
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

  // Original image
  const origImg = document.createElement("div");
  origImg.style.position = "relative";
  origImg.innerHTML = `<div class="compare-label">Original</div><img src="" id="compare-orig" />`;
  content.appendChild(origImg);

  // Converted image (thumbnail as preview)
  const convImg = document.createElement("div");
  convImg.style.position = "relative";
  convImg.innerHTML = `<div class="compare-label">WebP</div><img src="" id="compare-conv" />`;
  content.appendChild(convImg);

  // Load original thumbnail
  try {
    const origThumb = await invoke("generate_thumbnail", { path: filePath, size: 400 });
    const el = document.getElementById("compare-orig");
    if (el) el.src = origThumb;
  } catch (_) {}

  // Find converted file
  const name = filePath.split(/[/\\]/).pop();
  const stem = name.replace(/\.[^.]+$/, "");
  const parent = filePath.replace(/[/\\][^/\\]+$/, "");
  const webpPath = `${parent}/${stem}-webp.webp`;
  try {
    const convThumb = await invoke("generate_thumbnail", { path: webpPath, size: 400 });
    const el = document.getElementById("compare-conv");
    if (el) el.src = convThumb;
  } catch (_) {}

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

function updateFileProgress(filePath, status, message, savedBytes, savedPct) {
  const f = files.find((x) => x.path === filePath);
  if (!f) return;
  f.status = status;
  f.message = message;
  f.savedBytes = savedBytes;
  f.savedPct = savedPct;

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
}

// ─── Update stats ───────────────────────────────────────────────────

function updateStats(s) {
  stats = s;
  statsPanel.hidden = false;
  statSuccess.textContent = s.success_count;
  statSkip.textContent = s.skip_count;
  statFail.textContent = s.fail_count;
  statSaved.textContent = formatBytes(s.saved);
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

async function startConvert() {
  if (isConverting) return;

  // P0-3: Confirm before deleting source files
  if (chkDelete.checked) {
    const yes = await ask(t("confirm-delete"), { title: "Pic2WebP", kind: "warning" });
    if (!yes) return;
  }

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
  lastConvertRequest = req;
  try {
    await invoke("start_convert", { request: req });
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
    alert(t("convert-failed") + ": " + e);
  }
}

// ─── Retry single failed file ──────────────────────────────────────

async function retrySingleFile(path) {
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

  const req = lastConvertRequest
    ? { ...lastConvertRequest, files: [path], recursive: false }
    : buildRequest([path], { recursive: false });
  try {
    await invoke("start_convert", { request: req });
  } catch (e) {
    console.warn("Retry failed:", e);
    isConverting = false;
    updateConvertBtn();
    alert(t("convert-failed") + ": " + e);
  }
}

// ─── Retry all failed files (P1-5) ─────────────────────────────────

async function retryAllFailed() {
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

  const req = lastConvertRequest
    ? { ...lastConvertRequest, files: failedFiles.map((f) => f.path), recursive: false }
    : buildRequest(failedFiles.map((f) => f.path), { recursive: false });
  try {
    await invoke("start_convert", { request: req });
  } catch (e) {
    console.warn("Retry all failed:", e);
    isConverting = false;
    updateConvertBtn();
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

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => f.path)
      .filter(Boolean);
    if (paths.length > 0) addFiles(paths);
  }
});

dropzone.addEventListener("click", async () => {
  try {
    const result = await open({
      multiple: true,
      filters: [
        { name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "avif"] }
      ]
    });
    if (result && Array.isArray(result)) {
      addFiles(result);
    } else if (typeof result === "string") {
      addFiles([result]);
    }
  } catch (e) {
    console.warn("Dialog not available:", e);
  }
});

clearBtn.addEventListener("click", () => {
  files = [];
  stats = null;
  statsPanel.hidden = true;
  lastConvertRequest = null;
  const warn = document.getElementById("batch-warning");
  if (warn) warn.remove();
  renderFiles();
  updateConvertBtn();
});

// Quality slider — update value + q-suffix pill label
function setQuality(v) {
  const val = Math.max(10, Math.min(100, parseInt(v) || 80));
  qualitySlider.value = val;
  qualityVal.textContent = val;
  const qPill = namingPills.querySelector('[data-value="q-suffix"]');
  if (qPill) qPill.textContent = `-q${val}`;
}

qualitySlider.addEventListener("input", () => setQuality(qualitySlider.value));

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

// Output dir
dirBtn.addEventListener("click", async () => {
  try {
    const dir = await open({ directory: true, title: t("select-output-dir") });
    if (dir) {
      selectedDir = dir;
      outputDir.value = dir;
      dirClear.hidden = false;
      const dirCopy = document.getElementById("dir-copy");
      if (dirCopy) dirCopy.hidden = false;
    }
  } catch (e) {
    console.log("Dialog not available:", e);
  }
});

dirClear.addEventListener("click", () => {
  selectedDir = null;
  outputDir.value = "";
  dirClear.hidden = true;
  const dirCopy = document.getElementById("dir-copy");
  if (dirCopy) dirCopy.hidden = true;
});

convertBtn.addEventListener("click", () => {
  if (isConverting) {
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

// P1-6: Copy output dir path
const dirCopy = document.getElementById("dir-copy");
if (dirCopy) {
  dirCopy.addEventListener("click", async () => {
    if (!selectedDir) return;
    try {
      await navigator.clipboard.writeText(selectedDir);
      const orig = dirCopy.textContent;
      dirCopy.textContent = t("copied");
      setTimeout(() => { dirCopy.textContent = orig; }, 1500);
    } catch (_) {}
  });
}

donateBtn.addEventListener("click", () => { donateModal.classList.add("visible"); });
modalClose.addEventListener("click", () => { donateModal.classList.remove("visible"); });
donateModal.addEventListener("click", (e) => { if (e.target === donateModal) donateModal.classList.remove("visible"); });

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  // P2: Don't trigger conversion when typing in inputs, textareas, or when modal is visible
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (donateModal && donateModal.classList.contains("visible")) return;
  if (convertBtn && !convertBtn.disabled) startConvert();
});

// ─── Tauri event listeners ──────────────────────────────────────────

async function setupListeners() {
  // Watch folder auto-convert
  await listen("watch-auto-convert", (event) => {
    const req = event.payload;
    if (req && req.files) {
      invoke("start_convert", { request: req }).catch((e) => console.warn("Watch convert failed:", e));
    }
  });

  // P0-2: Close window confirmation during conversion
  await listen("confirm-close", async () => {
    const yes = await ask(t("confirm-close"), { title: "Pic2WebP", kind: "warning" });
    if (yes) {
      await invoke("force_close").catch((e) => console.warn("force_close failed:", e));
    }
  });

  await listen("convert-progress", (event) => {
    const p = event.payload;
    updateFileProgress(p.file, p.status, p.message, p.saved_bytes, p.saved_pct);
  });

  await listen("convert-stats", (event) => {
    updateStats(event.payload);
  });

  await listen("convert-done", (event) => {
    isConverting = false;
    // Restore unprocessed files to pending
    for (const f of files) {
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
  langZh.classList.toggle("active", lang === "zh");
  langEn.classList.toggle("active", lang === "en");
}

// ── Dark mode ──
if (themeToggle) {
  const savedTheme = localStorage.getItem("pic2webp-theme");
  if (savedTheme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
    themeToggle.textContent = "☀️";
  }
  themeToggle.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    if (cur === "dark") {
      document.documentElement.removeAttribute("data-theme");
      themeToggle.textContent = "🌙";
      localStorage.setItem("pic2webp-theme", "light");
    } else {
      document.documentElement.setAttribute("data-theme", "dark");
      themeToggle.textContent = "☀️";
      localStorage.setItem("pic2webp-theme", "dark");
    }
  });
}

// ── Advanced section toggle ──
if (advancedToggle) {
  advancedToggle.addEventListener("click", () => {
    advancedToggle.classList.toggle("open");
    advancedSection.classList.toggle("open");
  });
}

// ── Target size toggle ──
if (chkTargetSize) {
  chkTargetSize.addEventListener("change", () => {
    targetSizeInput.style.display = chkTargetSize.checked ? "inline-block" : "none";
  });
}

// ── Watch folder ──
let isWatching = false;
if (watchBtn) {
  watchBtn.addEventListener("click", async () => {
    if (isWatching) {
      await invoke("stop_watch").catch(() => {});
      isWatching = false;
      watchBtn.classList.remove("active");
      watchBtn.textContent = t("watch-folder");
      return;
    }
    if (!selectedDir) {
      const dir = await open({ directory: true, title: t("watch-folder") });
      if (!dir) return;
      selectedDir = dir;
      outputDir.value = dir;
    }
    const req = buildRequest([selectedDir]);
    try {
      await invoke("watch_folder", { dir: selectedDir, request: req });
      isWatching = true;
      watchBtn.classList.add("active");
      watchBtn.textContent = t("stop-watch");
    } catch (e) {
      console.warn("Watch failed:", e);
    }
  });
}

// ── Compare modal ──
if (compareModal) {
  compareModal.addEventListener("click", (e) => {
    if (e.target === compareModal) compareModal.classList.remove("visible");
  });
}

if (langToggle) {
  langToggle.addEventListener("click", () => {
    toggleLang();
    updateLangToggle();
    // Re-render file list to update dynamic text
    renderFiles();
    updateConvertBtn();
  });
}

// ─── Init ────────────────────────────────────────────────────────────

async function init() {
  initLang();
  updateLangToggle();

  // Re-render on language change (for dynamic content not covered by applyLang)
  window.addEventListener("lang-changed", () => {
    renderFiles();
    updateConvertBtn();
  });

  await checkTools();

  if (!isTauri()) return;

  await setupListeners();

  await listen("tauri://drag-drop", (event) => {
    const raw = event.payload.paths || [];
    const paths = raw.map((p) => (typeof p === "string" ? p : p && p.path)).filter(Boolean);
    if (paths.length > 0) addFiles(paths);
  });
}

init();
