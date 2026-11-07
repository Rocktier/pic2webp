/**
 * 空格预览 —— macOS 的 Quick Look 习惯。
 *
 * 为什么要有它：网格里的瓦片只有 ~130px，而「这张转完到底糊没糊」是用户
 * 真正想知道的事。缩略图解决不了，加一个常驻的大图预览面板又会把批量操作
 * 变成单张操作。空格键正好：看细节时按一下，看完按一下回来，主界面不动。
 *
 * 实现上刻意不复用系统 Quick Look（Tauri 里没有直接通道，且我们要显示的是
 * 转换后的 webp 而不是源文件）。这里用后端已有的 generate_thumbnail 要一张
 * 大图，纯前端浮层渲染。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

let overlay, frame, img, nameEl, metaEl;
let currentPath = null;
let paths = [];
let selectedPath = null;
let bigCache = new Map();

const BIG_SIZE = 1600;

function items() {
  return [...document.querySelectorAll("#file-list .file-item")];
}

function pathOf(el) {
  return el?.dataset?.path || null;
}

function indexOfPath(p) {
  return paths.indexOf(p);
}

function applySelection() {
  for (const el of items()) {
    el.classList.toggle("selected", pathOf(el) === selectedPath);
  }
}

function fileName(p) {
  return (p || "").split(/[/\\]/).pop() || "";
}

async function srcFor(p) {
  if (bigCache.has(p)) return bigCache.get(p);
  if (!isTauri()) return null;
  try {
    const url = await invoke("generate_thumbnail", { path: p, size: BIG_SIZE });
    if (url) bigCache.set(p, url);
    return url;
  } catch (_) {
    return null;
  }
}

async function show(p) {
  if (!p) return;
  currentPath = p;
  const url = await srcFor(p);
  // 异步回来时用户可能已经翻到下一张：只认最新的
  if (currentPath !== p) return;
  img.src = url || "";
  img.style.visibility = url ? "visible" : "hidden";
  nameEl.textContent = fileName(p);
  const el = items().find((x) => pathOf(x) === p);
  const size = el?.querySelector(".file-size")?.textContent || "";
  const badge = el?.querySelector(".pct-badge")?.textContent || "";
  metaEl.textContent = [size, badge].filter(Boolean).join(" · ");
  overlay.hidden = false;
  // 下一帧再加 open，让 opacity/scale 的过渡真的跑起来
  requestAnimationFrame(() => overlay.classList.add("open"));
}

function hide() {
  overlay.classList.remove("open");
  const done = () => { overlay.hidden = true; };
  // 等过渡结束；reduced-motion 下过渡被压到 0，setTimeout 兜底
  setTimeout(done, 180);
  currentPath = null;
}

function step(delta) {
  const i = indexOfPath(currentPath);
  if (i === -1) return;
  const next = paths[(i + delta + paths.length) % paths.length];
  if (next) {
    selectedPath = next;
    applySelection();
    show(next);
  }
}

function isTyping(e) {
  const tag = e.target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable;
}

function onKey(e) {
  const open = !overlay.hidden;

  if (open) {
    if (e.key === "Escape" || e.key === " ") { e.preventDefault(); hide(); return; }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); step(1); return; }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); step(-1); return; }
    return;
  }

  if (isTyping(e)) return;
  if (e.key === " ") {
    // 空格在 macOS 里是 Quick Look，不是「滚动一屏」
    e.preventDefault();
    const target = selectedPath && paths.includes(selectedPath) ? selectedPath : paths[0];
    if (target) { selectedPath = target; applySelection(); show(target); }
  }
}

/** @param {{ getPaths: () => string[] }} opts */
export function initQuickLook({ getPaths } = {}) {
  overlay = document.getElementById("ql-overlay");
  frame = document.getElementById("ql-frame");
  img = document.getElementById("ql-image");
  nameEl = document.getElementById("ql-name");
  metaEl = document.getElementById("ql-meta");
  if (!overlay || !img) return;

  const refresh = () => { paths = (getPaths?.() || []).filter(Boolean); };
  refresh();

  // 瓦片点击 = 选中（不打开）。双击 = 直接预览，给不用键盘的人一条路。
  document.getElementById("file-list")?.addEventListener("click", (e) => {
    const item = e.target.closest(".file-item");
    if (!item) return;
    refresh();
    selectedPath = pathOf(item);
    applySelection();
  });
  document.getElementById("file-list")?.addEventListener("dblclick", (e) => {
    const item = e.target.closest(".file-item");
    if (!item) return;
    refresh();
    selectedPath = pathOf(item);
    applySelection();
    show(selectedPath);
  });

  overlay.addEventListener("click", (e) => {
    if (!frame.contains(e.target)) hide();
  });

  document.addEventListener("keydown", onKey);

  // 列表重绘后把选中环补回去：renderFiles 会整块重建 DOM
  const list = document.getElementById("file-list");
  if (list) {
    new MutationObserver(() => {
      refresh();
      if (selectedPath && !paths.includes(selectedPath)) selectedPath = null;
      applySelection();
    }).observe(list, { childList: true });
  }
}
