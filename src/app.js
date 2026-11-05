import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { initLang, getLang, setLang, t, translateBackendMessage, getLanguages } from "./i18n.js";
import { runUpdateCheck } from "./updates.js";
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

// 瓦片用 innerHTML 拼装，文件名 / 路径 / 后端消息都要过这一层：
// 一个叫 `<img src=x onerror=…>` 的文件就能在 webview 里执行脚本。
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

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
const chkResize = $("#chk-resize");
const resizeW = $("#resize-w");
const resizeH = $("#resize-h");
const resizeMode = $("#resize-mode");
const chkStructure = $("#chk-structure");

// 状态栏（2026-10-30 重构：状态文字必须与真实状态一致，见 updateStatusbar）
const statusDot = $("#status-dot");
const statusText = $("#status-text");
const statusMeta = $("#status-meta");
const fileSummary = $("#file-summary");

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
      // isFolder 必须记下来：后端会把目录展开成若干实际文件，目录行自己
      // 永远收不到进度事件（见 batchEventStatus / finalizeFolderRows）。
      files.push({
        path: p, isFolder, status: "pending", message: "",
        savedBytes: 0, savedPct: 0, size: 0, outputPath: null,
      });
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

function loadThumbnail(path, onDone, onFail, size = 320) {
  if (thumbInFlight.has(path)) return;
  thumbInFlight.add(path);
  const run = () => {
    thumbActive++;
    invoke("generate_thumbnail", { path, size })
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

// ─── 瓦片内容：尺寸行 / 角标 ────────────────────────────────────────
// 不编造数据：原始体积来自 get_file_size，产物体积 = 原始 − saved_bytes
// （saved_bytes 由后端在 convert-progress 里逐文件回报）。

// 目录行的尺寸行：它展开出的文件数（真实事件计数，不是估算）。
function folderNote(f) {
  if (f.folderNote) return f.folderNote;
  const set = batchFolderFiles.get(f.path);
  if (set && set.size > 0) return t("folder-files", { n: set.size });
  return "";
}

function sizeLineText(f) {
  if (f.isFolder) return folderNote(f);
  if (f.savedBytes > 0 && f.size > 0 && f.size > f.savedBytes) {
    return `${formatBytes(f.size)} → ${formatBytes(f.size - f.savedBytes)}`;
  }
  if (f.savedBytes > 0) return t("saved-bytes", { size: formatBytes(f.savedBytes) });
  if (f.message) return translateBackendMessage(f.message) || "";
  if (f.size > 0) return formatBytes(f.size);
  return "";
}

// 缩略图角标（设计稿签名元素）：完成后一枚 −N%；待转/跳过是中性灰状态字。
function pctBadge(f) {
  if (f.isFolder) return null;
  if (f.savedPct > 0) return { cls: "pct-badge", text: `−${f.savedPct}%` };
  if (f.status === "skipped") return { cls: "pct-badge muted", text: t("badge-skipped") };
  if (f.status === "pending" || f.status === "converting") {
    return { cls: "pct-badge muted", text: t("badge-pending") };
  }
  return null;
}

function statusHtml(f) {
  if (f.status === "converting") {
    // 红点旁边永远有文字（家族口径 §一.2）
    return `<span class="file-status status-converting busy"><span class="dot-live" aria-hidden="true"></span>${statusLabel(f.status)}</span>`;
  }
  return `<span class="file-status status-${f.status}">${statusLabel(f.status)}</span>`;
}

// 不用 CSS.escape（它用于 CSS 标识符，不适合属性值），
// 改为遍历查找，兼容 Windows 路径中的反斜杠
function findFileItem(path) {
  for (const el of fileList.querySelectorAll(".file-item")) {
    if (el.dataset.path === path) return el;
  }
  return null;
}

// 目录行的局部刷新：事件密集（每个展开出的文件一条），只改变化的部分，
// 不整表重绘。
function updateFolderRowDom(owner) {
  const item = findFileItem(owner.path);
  if (!item) return;
  const badge = item.querySelector(".file-status");
  if (badge) {
    const cls = `file-status status-${owner.status}` + (owner.status === "converting" ? " busy" : "");
    if (badge.className !== cls) {
      badge.className = cls;
      badge.innerHTML = owner.status === "converting"
        ? `<span class="dot-live" aria-hidden="true"></span>${statusLabel(owner.status)}`
        : statusLabel(owner.status);
    }
  }
  const size = item.querySelector(".file-size");
  if (size) {
    const text = folderNote(owner);
    if (size.textContent !== text) size.textContent = text;
  }
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
    updateFileSummary();
    updateStatusbar();
    updateStatusMeta();
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
    // 占位徽标用中性灰阶层级：扩展名文字本身已标明类型，颜色不承载信息，
    // 且琥珀/蓝/绿在家族令牌里属于 warning/info/success 语义，容易被误读为状态。
    const thumbTints = { jpg: 'rgba(120,120,128,0.22)', jpeg: 'rgba(120,120,128,0.22)', png: 'rgba(120,120,128,0.16)', webp: 'rgba(120,120,128,0.10)' };
    const thumbTint = thumbTints[ext] || 'rgba(120,120,128,0.13)';
    const thumbSrc = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="' + thumbTint + '"/><text x="16" y="22" text-anchor="middle" fill="#8e8e93" font-size="11" font-weight="600">' + ext.toUpperCase() + '</text></svg>')}`;
    // 缓存命中时直接把 data URL 当首帧写进 innerHTML —— 早先版本先查缓存再设
    // `<img>`，但那一刻 innerHTML 还没写入，querySelector 必然拿到 null，
    // 于是任何一次重渲染后缩略图都永久退回灰底扩展名占位符。
    const cachedThumb = isTauri() ? thumbCache.get(f.path) : null;
    // Async load real thumbnail（并发上限 + 缓存去重：一次拖入几百张不再瞬时 N 个 invoke）
    // 2026-10-30 重构：列表改成瓦片网格后缩略图是主视觉，48px 拉到 ~200px 会糊，
    // 改取 320px（generate_thumbnail 按 box 缩放，后端不用动）。
    if (isTauri() && !cachedThumb) {
      loadThumbnail(f.path,
        (dataUrl) => { const el = item.querySelector(".file-thumb"); if (el) el.src = dataUrl; },
        () => { const el = item.querySelector(".file-thumb"); if (el) el.style.opacity = "0.3"; }, 320);
    }

    const retryBtn = f.status === "failed"
      ? `<button class="retry-btn" data-path="${esc(f.path)}" title="${esc(t("retry"))}">↻</button>`
      : "";
    const deleteBtn = `<button class="file-delete-btn" data-path="${esc(f.path)}" title="${esc(t("remove-file"))}">×</button>`;
    const badge = pctBadge(f);
    const badgeHtml = badge ? `<span class="${badge.cls}">${esc(badge.text)}</span>` : "";

    item.innerHTML = `
      <div class="tile-thumb">
        <img class="file-thumb" src="${cachedThumb || thumbSrc}" alt="" />
        ${badgeHtml}
      </div>
      <div class="file-meta">
        <div class="file-name" title="${esc(name)}">${esc(name)}</div>
        <div class="file-size">${esc(sizeLineText(f))}</div>
        ${statusHtml(f)}
      </div>
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
  }

  updateFileSummary();
  updateStatusbar();
  updateStatusMeta();
}

// ─── 状态栏 / 列表摘要：只说真实状态 ─────────────────────────────────
// 本仓发生过「幽灵状态」事故：状态文字必须与真实状态一致，数字只能
// 来自真实计数（files 数组 / 后端 stats），禁止任何估算或假文案。

function updateFileSummary() {
  if (!fileSummary) return;
  if (files.length === 0) { fileSummary.textContent = ""; return; }
  const n = { todo: 0, done: 0, skip: 0, fail: 0 };
  for (const f of files) {
    // 目录行代表它展开出来的若干文件：按事件里的真实状态逐个计数，
    // 否则摘要会与瓦片（1 个目录）对不上，也会与后端统计（展开后的总数）对不上。
    const set = f.isFolder ? batchFolderFiles.get(f.path) : null;
    if (set && set.size > 0) {
      for (const p of set) {
        const st = batchEventStatus.get(p);
        if (st === "done") n.done++;
        else if (st === "skipped") n.skip++;
        else if (st === "failed") n.fail++;
        else n.todo++;
      }
      continue;
    }
    if (f.status === "done") n.done++;
    else if (f.status === "skipped") n.skip++;
    else if (f.status === "failed") n.fail++;
    else n.todo++;
  }
  const parts = [];
  if (n.todo) parts.push(t("summary-todo", { n: n.todo }));
  if (n.done) parts.push(t("summary-done", { n: n.done }));
  if (n.skip) parts.push(t("summary-skip", { n: n.skip }));
  if (n.fail) parts.push(t("summary-fail", { n: n.fail }));
  fileSummary.textContent = parts.join(" · ");
}

function updateStatusbar() {
  if (!statusText) return;
  if (isConverting) {
    const { done, total } = batchTerminalCount();
    if (statusDot) statusDot.hidden = false;
    statusText.textContent = t("statusbar-converting", { done, total });
    return;
  }
  if (statusDot) statusDot.hidden = true;
  if (files.length === 0) {
    statusText.textContent = t("statusbar-idle");
    return;
  }
  const allDone = files.every((f) => f.status === "done" || f.status === "skipped" || f.status === "failed");
  if (allDone && stats) {
    // 计数直接取统计面板上的真实值（updateStats 刚写入的），不二次计算
    statusText.textContent = t("statusbar-done", {
      ok: statSuccess ? statSuccess.textContent : "0",
      skip: statSkip ? statSkip.textContent : "0",
      fail: statFail ? statFail.textContent : "0",
      saved: statSaved ? statSaved.textContent : "0 B",
    });
    return;
  }
  statusText.textContent = t("statusbar-ready", { n: files.length });
}

// 状态栏右侧等宽摘要：当前质量档 · 有损/无损 · 本机处理（全部是真实设置）
function updateStatusMeta() {
  if (!statusMeta) return;
  const q = document.querySelector("#quality-pills .pill-btn.active");
  const parts = [
    q ? q.textContent.trim() : "",
    chkLossless?.checked ? t("lossless") : t("lossy"),
    t("statusbar-local"),
  ];
  statusMeta.textContent = parts.filter(Boolean).join(" · ");
}

function statusLabel(s) {
  const m = {
    pending: t("status-pending"),
    converting: t("status-converting"),
    done: t("status-done"),
    skipped: t("status-skipped"),
    failed: t("status-failed"),
  };
  return m[s] || s;
}

// ─── Update UI for file progress ────────────────────────────────────

function updateFileProgress(filePath, status, message, savedBytes, savedPct, outputPath) {
  // 后端 panic 时用空路径报失败（ERR_INTERNAL_PANIC），不对应任何文件
  if (!filePath) return;
  batchEventStatus.set(filePath, status);
  const f = files.find((x) => x.path === filePath);
  if (!f) {
    // 目录展开出来的文件：列表里没有它的瓦片，归到目录行上
    const owner = folderOwnerOf(filePath);
    if (owner) {
      let set = batchFolderFiles.get(owner.path);
      if (!set) { set = new Set(); batchFolderFiles.set(owner.path, set); }
      set.add(filePath);
      syncFolderRow(owner);
      updateFolderRowDom(owner);
    }
    // 无论归属到哪一行，批次计数都要跟着走
    updateProgress();
    updateFileSummary();
    return;
  }
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
    badge.className = `file-status status-${status}` + (status === "converting" ? " busy" : "");
    // 转换中：红点 + 文字一起出现（家族口径：红点旁永远有文字）
    badge.innerHTML = status === "converting"
      ? `<span class="dot-live" aria-hidden="true"></span>${statusLabel(status)}`
      : statusLabel(status);
    const size = item.querySelector(".file-size");
    size.textContent = sizeLineText(f);
    const pct = item.querySelector(".pct-badge");
    const b = pctBadge(f);
    if (pct) {
      if (b) { pct.className = b.cls; pct.textContent = b.text; }
      else pct.remove();
    }

    // Auto-scroll to the file currently being processed
    if (status === "converting") {
      item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }
  updateProgress();
  // 摘要（待转 / 已完成 / 跳过 / 失败）跟着每个文件的状态走，
  // 否则转换中途它一直停在初始计数
  updateFileSummary();
}

let totalTasks = 0;
// 当前批次：重试只跑其中一部分，进度与状态栏都按批次算，不按整张列表。
// 此前 totalTasks 一直是整表长度，单文件重试时进度条会显示 "9/10" ——
// 用户看到的是「几乎完成」，实际那个文件还在转。
// 总数以后端 convert-total 事件为准（它知道自己要处理几个），批次路径由前端记，
// 用来数「这一批里已经落定的有几个」。
let batchPaths = [];

// 批次台账：进度只认事件流，不认列表长度。
// 目录会被后端展开成若干实际文件（collect_convert_files），展开后的路径
// 不在列表里，目录行自己永远收不到事件 —— 此前目录行永远停在「待转换」，
// 进度条也停在 0/N，整批看上去像卡死。
// batchEventStatus: 路径 → 最后一次事件状态；batchFolderFiles: 目录 → 它展开出的文件。
let batchEventStatus = new Map();
let batchFolderFiles = new Map();
// 批次是否被用户取消：取消时后端直接跳出循环，没开始的文件不会补发事件，
// 目录行不能因此被当成「全部跑完」。
let batchCancelled = false;

function resetBatchLedger() {
  batchEventStatus = new Map();
  batchFolderFiles = new Map();
  batchCancelled = false;
}

// 目录归属：展开出来的文件路径不在列表里，按路径前缀归到最贴切的目录行。
function folderOwnerOf(filePath) {
  const target = filePath.replace(/\\/g, "/");
  let owner = null;
  let best = -1;
  for (const f of files) {
    if (!f.isFolder) continue;
    const prefix = f.path.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
    if (target.startsWith(prefix) && prefix.length > best) {
      owner = f;
      best = prefix.length;
    }
  }
  return owner;
}

function isTerminalStatus(s) {
  return s === "done" || s === "skipped" || s === "failed";
}

// 「点了取消」不等于「确实没跑完」：后端在文件间隙检查标志，
// 若点下去时最后几个文件已经转完，整批其实完整落定了。
function batchActuallyCancelled() {
  if (!batchCancelled) return false;
  if (totalTasks <= 0) return true;
  let terminal = 0;
  for (const s of batchEventStatus.values()) {
    if (isTerminalStatus(s)) terminal++;
  }
  return terminal < totalTasks;
}

// 目录行的状态由它展开出来的文件推导；批次未结束前一律算「转换中」，
// 因为剩下的文件还没开始，不能提前宣布完成。
function syncFolderRow(owner) {
  const set = batchFolderFiles.get(owner.path);
  if (!set || set.size === 0) return;
  const statuses = [...set].map((p) => batchEventStatus.get(p));
  if (statuses.some((s) => s === "failed")) owner.status = "failed";
  else if (isConverting) owner.status = "converting";
  else if (statuses.every(isTerminalStatus)) owner.status = "done";
}

// 批次结束：目录行落账。一个事件都没有 = 后端没展开它
// （递归没开，或目录里没有可转换的图片）。
function finalizeFolderRows() {
  const cancelled = batchActuallyCancelled();
  for (const f of files) {
    if (!f.isFolder) continue;
    const set = batchFolderFiles.get(f.path);
    if (!set || set.size === 0) {
      if (cancelled) {
        // 取消发生在轮到它之前：它还是待转，不是「没有可转换文件」
        f.status = "pending";
        f.folderNote = t("folder-cancelled");
      } else {
        f.status = "skipped";
        f.folderNote = chkRecursive.checked ? t("folder-empty") : t("folder-recursion-off");
      }
      continue;
    }
    const statuses = [...set].map((p) => batchEventStatus.get(p));
    const failedCount = statuses.filter((s) => s === "failed").length;
    if (cancelled) {
      // 与普通文件同口径：取消后回到待转队列。目录没转完，
      // 不能宣布完成；「已处理 N 个」是事件里的真实计数。
      f.status = "pending";
      f.folderNote = t("folder-cancelled-partial", { n: set.size });
      continue;
    }
    if (failedCount > 0) f.status = "failed";
    else if (statuses.every((s) => s === "skipped")) f.status = "skipped";
    else f.status = "done";
    f.folderNote = failedCount > 0
      ? t("folder-files-failed", { n: set.size, m: failedCount })
      : t("folder-files", { n: set.size });
  }
}

function batchTerminalCount() {
  // 已落定的数量 = 事件流里到达终态的路径数（目录展开出来的也算）。
  let done = 0;
  for (const s of batchEventStatus.values()) {
    if (isTerminalStatus(s)) done++;
  }
  const total = totalTasks > 0 ? totalTasks : (batchPaths.length || files.length);
  return { done, total };
}

function updateProgress() {
  const container = document.getElementById("progress-bar-container");
  const fill = document.getElementById("progress-bar-fill");
  const text = document.getElementById("progress-text");
  if (!container || !fill || !text) return;
  if (isConverting) {
    const { done, total } = batchTerminalCount();
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    container.hidden = false;
    fill.style.width = pct + "%";
    text.textContent = `${done}/${total} (${pct}%)`;
  } else {
    container.hidden = true;
    fill.style.width = "0%";
  }
  updateStatusbar();
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
  updateStatusbar();
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
  if (isConverting) return;
  cancelPending = false;
  batchPaths = files.map((f) => f.path);
  totalTasks = 0; // 后端 convert-total 事件会填上真实总数
  resetBatchLedger();

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
    f.folderNote = "";
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
    updateStatusbar();
    // 试用过期被拦：弹激活对话框（不是裸错误）。Rust 同时会 emit license-expired，
    // 这里按错误码再判一次作双保险；openLicenseDialog 重复打开只会刷新内容。
    if (isLicenseExpiredError(e)) { openLicenseDialog(); return; }
    alert(t("convert-failed") + ": " + translateBackendMessage(String(e)));
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
    // +10% 余量：目录元数据、时间戳命名重试都可能放大产物
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

  // 本批只有这一个文件：进度与状态栏按 1 个算，不按整张列表
  batchPaths = [path];
  totalTasks = 0;
  resetBatchLedger();

  // Enter converting state so the button becomes "cancel" and concurrent starts are blocked
  isConverting = true;
  updateConvertBtn();

  f.status = "pending";
  f.message = "";
  f.savedBytes = 0;
  f.savedPct = 0;
  f.folderNote = "";
  renderFiles();

  // 目录行要带递归重跑：不递归的话后端会直接跳过它（它不是文件），
  // 点「重试」会什么都没发生。
  const req = buildRequest([path], { recursive: !!f.isFolder });
  try {
    await invoke("start_convert", { request: req });
  } catch (e) {
    console.warn("Retry failed:", e);
    isConverting = false;
    updateConvertBtn();
    updateStatusbar();
    if (isLicenseExpiredError(e)) { openLicenseDialog(); return; }
    alert(t("convert-failed") + ": " + translateBackendMessage(String(e)));
  }
}

// ─── Retry all failed files (P1-5) ─────────────────────────────────

async function retryAllFailed() {
  retryBase = stats ? { ...stats } : null;
  if (isConverting) return;
  const failedFiles = files.filter((f) => f.status === "failed");
  if (failedFiles.length === 0) return;

  batchPaths = failedFiles.map((f) => f.path);
  totalTasks = 0;
  resetBatchLedger();

  for (const f of failedFiles) {
    f.status = "pending";
    f.message = "";
    f.savedBytes = 0;
    f.savedPct = 0;
    f.folderNote = "";
  }
  renderFiles();

  isConverting = true;
  updateConvertBtn();

  // 递归打开：失败列表里可能有目录行（它代表展开后失败的那些文件），
  // 不递归后端会跳过目录，重试等于没点。
  const req = buildRequest(failedFiles.map((f) => f.path), { recursive: true });
  try {
    await invoke("start_convert", { request: req });
  } catch (e) {
    console.warn("Retry all failed:", e);
    isConverting = false;
    updateConvertBtn();
    updateStatusbar();
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
  updateStatusMeta();
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

// 无损开关影响状态栏的「有损/无损」摘要
chkLossless?.addEventListener("change", updateStatusMeta);

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
/* 2026-10-04 键改名：此前是 "pic2webp-output-dir"，压根不在家族命名空间里。
 * 读取处回落旧键，否则老用户升级后要重选一次输出目录。旧键不删。 */
const OUTPUT_DIR_KEY = "rocktier.output-dir";
const OUTPUT_DIR_KEY_LEGACY = "pic2webp-output-dir";

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
    // 批次被取消：目录行不能按「跑完了」结账（见 finalizeFolderRows）
    batchCancelled = true;
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
    if (f.status === "converting") f.status = "pending";
    if (f.status === "pending") {
        f.message = "";
        f.savedBytes = 0;
        f.savedPct = 0;
      }
    }
    // 目录行落账：它自己收不到事件，状态由展开出来的文件推导。
    // 不落账它就永远停在「待转换」——摘要与状态栏都会说假话。
    finalizeFolderRows();
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

// ─── Family-standard menu ───────────────────────────────────────────
const menuActions = {
  open: () => dropzone.click(),
  clear: () => clearBtn.click(),
  theme: () => themeToggle.click(),
  website: () => openUrl("https://rocktier.com/pic2webp.html").catch(() => {}),
  // 此前菜单项被创建但 menuActions 无分支 → 点了完全无反应（家族审查发现）。
  feedback: () => openUrl("mailto:hello@rocktier.com?subject=Rocktier%20Pic2WebP%20Feedback").catch(() => {}),
  "check-updates": () => runUpdateCheck(),
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
  const savedOutputDir = localStorage.getItem(OUTPUT_DIR_KEY) ?? localStorage.getItem(OUTPUT_DIR_KEY_LEGACY);
  applyOutputDir(savedOutputDir);
  if (!savedOutputDir && isTauri()) {
    // 商店版（macOS 沙箱）写不回源目录，改用 ~/Pictures/Rocktier Pic2WebP；
    // 直链版与 Windows 商店包返回 null，保持「与源文件同目录」。
    invoke("store_default_output_dir").then((dir) => {
      if (dir && !selectedDir) applyOutputDir(dir);
    }).catch(() => {});
  }

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

  // 文件关联（双击 / 「打开方式」）：冷启动路径经 initial_file 拉取，热启动由
  // Rust 的 open-file 事件送达。addFiles 是拖放/选择框共用的装载入口
  // （自带同路径去重与扩展名过滤），复用即可。
  invoke("initial_file").then((p) => {
    if (p) addFiles([p]);
  }).catch(() => {});
  await listen("open-file", (event) => {
    const p = event.payload;
    if (p) addFiles([p]);
  });
}

init();
