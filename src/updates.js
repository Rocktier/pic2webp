// 更新检查 —— 只在用户主动要求时才联网。
//
// ── 为什么不用 Tauri 的 updater 插件 ──────────────────────────────
//
// 家族对外的承诺是「除非你要求，应用不会联网」，且「绝不在未经询问的
// 情况下下载或安装任何东西」（privacy.html 的 Update checks 一节）。
//
// Tauri updater 插件会在应用里常驻一个「下载并替换自身」的通道，需要
// 为每款产品维护签名密钥对与 CI secret。而我们并不需要它：用户想要的是
// 「有没有新版本，去哪下」，不是「静默替我装好」。
//
// 所以这里只做一件事：请求一个列出最新版本的公开文件，比对版本号，
// 把结果和官方发布页链接交给用户。下载与安装由用户自己决定。
// 全程零 Rust 改动、零密钥、零新增依赖。
//
// ── 请求里有什么 ──────────────────────────────────────────────────
//
// 只有 GitHub Releases 的公开 API 地址。不含许可证码、设备标识、
// 机器信息，或与文件有关的任何内容。这也是它能被写进隐私政策的理由。

import { invoke } from "@tauri-apps/api/core";
import pkg from "../package.json";
import { t } from "./i18n.js";

const REPO = "Rocktier/pic2webp";

const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const FALLBACK_URL = `https://github.com/${REPO}/releases/latest`;
const STORE_KEY = "rocktier.updateCheckedAt";

let state = "idle"; // idle | checking | uptodate | available | failed
let result = null;
let lastCheckedAt = loadLastChecked();
let checking = false;
let corner = null;

/** 打包时写死，与 tag 同源 —— 不会出现系统里装着新版本而代码里写着旧版本的错位。 */
const APP_VERSION = pkg.version;

function parse(version) {
  return String(version)
    .replace(/^v/i, "")
    .split(".")
    .map((p) => parseInt(p, 10) || 0);
}

function isNewer(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function loadLastChecked() {
  try {
    const n = Number(localStorage.getItem(STORE_KEY));
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

function formatCheckedAt(ts) {
  try {
    const loc = (document.documentElement.lang || "en").indexOf("zh") === 0 ? "zh-CN" : "en";
    return new Date(ts).toLocaleDateString(loc);
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/** 检查一次更新。**只在用户点击时调用** —— 这是隐私承诺的落点。 */
async function checkForUpdates() {
  const res = await fetch(API, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const latest = String(data.tag_name || "").replace(/^v/i, "");
  if (!latest) throw new Error("release has no tag_name");
  return {
    latest,
    url: data.html_url || FALLBACK_URL,
    hasUpdate: isNewer(latest, APP_VERSION),
    checkedAt: Date.now(),
  };
}

export async function runUpdateCheck() {
  if (checking) return;
  checking = true;
  state = "checking";
  render();
  try {
    result = await checkForUpdates();
    lastCheckedAt = result.checkedAt;
    try { localStorage.setItem(STORE_KEY, String(result.checkedAt)); } catch { /* 隐私模式下忽略 */ }
    state = result.hasUpdate ? "available" : "uptodate";
  } catch {
    state = "failed";
  } finally {
    checking = false;
    render();
  }
}

function ensureCorner() {
  if (corner) return;
  corner = document.createElement("div");
  corner.className = "update-corner";
  corner.innerHTML =
    '<button type="button" class="update-line">' +
    '<span class="update-ver"></span>' +
    '<span class="update-sep" aria-hidden="true">·</span>' +
    '<span class="update-action"></span>' +
    "</button>" +
    '<div class="update-note" role="status" aria-live="polite"></div>';
  document.body.appendChild(corner);
  corner.querySelector(".update-line").addEventListener("click", () => void runUpdateCheck());
  render();
}

function render() {
  if (!corner) return;
  corner.classList.toggle("has-update", state === "available");
  corner.querySelector(".update-ver").textContent = `v${APP_VERSION}`;
  corner.querySelector(".update-line").disabled = state === "checking";
  corner.querySelector(".update-line").title = t("update.privacyNote");
  corner.querySelector(".update-action").textContent =
    state === "checking" ? t("update.checking") : t("update.check");
  const note = corner.querySelector(".update-note");
  note.textContent = "";
  if (state === "uptodate") {
    note.textContent = t("update.upToDate");
  } else if (state === "failed") {
    note.textContent = t("update.failed");
  } else if (state === "available" && result) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "update-get";
    btn.textContent = t("update.download", { v: result.latest });
    btn.title = t("update.available", { v: result.latest });
    btn.addEventListener("click", () => {
      invoke("open_url", { url: result.url }).catch(() => {});
    });
    note.appendChild(btn);
  } else {
    note.textContent = t("update.lastChecked", {
      date: lastCheckedAt ? formatCheckedAt(lastCheckedAt) : t("update.never"),
    });
  }
}

ensureCorner();
// 语言切换时重渲染角落文案（license.js 同款事件）
window.addEventListener("lang-changed", render);
