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
import { revalidateLicence, refreshLicenseStatus, openLicenseDialog } from "./license.js";

const REPO = "Rocktier/pic2webp";

const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const FALLBACK_URL = `https://github.com/${REPO}/releases/latest`;

let state = "idle"; // idle | checking | uptodate | available | failed
let result = null;
let checking = false;

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
  openUpdateDialog();
  try {
    result = await checkForUpdates();
    state = result.hasUpdate ? "available" : "uptodate";
    /* 顺带吊销复检：同一次点击、同一承诺（只在点击时联网）。revoked → 清回执，
       授权状态回到未激活并弹激活对话框。 */
    const verdict = await revalidateLicence();
    if (verdict === "revoked") {
      void refreshLicenseStatus();
      openLicenseDialog({ revoked: true });
    }
  } catch {
    state = "failed";
  } finally {
    checking = false;
    render();
  }
}

/* ── 对话框（结构照 license.js 的 overlay 模式）──────────────────────────
   入口只在帮助菜单「检查更新…」—— 点击才联网，启动时、工作中、后台都
   不检查。结果一律在这里展示：右下角常驻悬浮入口已移除（用户要求入口
   全部收进菜单；fixed 定位实测还会盖住底部内容，Compressor v0.1.10），
   统一改为菜单 + 弹框。 */
let overlay = null;

function buildDialog() {
  overlay = document.createElement("div");
  overlay.className = "update-overlay";
  overlay.hidden = true;

  const dialog = document.createElement("div");
  dialog.className = "update-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const header = document.createElement("div");
  header.className = "update-header";
  const title = document.createElement("h3");
  title.textContent = t("update.check");
  header.appendChild(title);
  const closeX = document.createElement("button");
  closeX.type = "button";
  closeX.className = "update-close";
  closeX.textContent = "\u00d7";
  closeX.setAttribute("aria-label", t("update.close"));
  closeX.addEventListener("click", closeUpdateDialog);
  header.appendChild(closeX);

  const body = document.createElement("div");
  body.className = "update-body";

  const footer = document.createElement("div");
  footer.className = "update-footer";

  dialog.append(header, body, footer);
  overlay.appendChild(dialog);
  // 点遮罩 = 关闭；面板内点击不冒泡（与 license.js 一致）。
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeUpdateDialog();
  });
  // Esc 关闭（对话框打开期间生效）。
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closeUpdateDialog();
  });
  document.body.appendChild(overlay);
}

function openUpdateDialog() {
  if (!overlay) buildDialog();
  overlay.hidden = false;
  renderDialog();
}

function closeUpdateDialog() {
  if (overlay) overlay.hidden = true;
}

/** 打开外链：桌面端走 Rust 白名单入口。 */
function openUrl(url) {
  invoke("open_url", { url }).catch(() => {});
}

function renderDialog() {
  if (!overlay || overlay.hidden) return;
  const body = overlay.querySelector(".update-body");
  const footer = overlay.querySelector(".update-footer");
  overlay.querySelector("h3").textContent = t("update.check");
  body.textContent = "";
  footer.textContent = "";

  const line = (text, small) => {
    const p = document.createElement("p");
    p.textContent = text;
    if (small) {
      p.appendChild(document.createElement("br"));
      const s = document.createElement("small");
      s.textContent = small;
      p.appendChild(s);
    }
    return p;
  };

  if (state === "checking") {
    body.appendChild(line(t("update.checking"), t("update.privacyNote")));
  } else if (state === "uptodate") {
    body.appendChild(line(t("update.upToDate"), `v${APP_VERSION}`));
  } else if (state === "failed") {
    body.appendChild(line(t("update.failed"), t("update.openReleasesHint")));
  } else if (state === "available" && result) {
    body.appendChild(line(t("update.available", { v: result.latest }), `v${APP_VERSION} \u2192 v${result.latest}`));
  }

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = t("update.close");
  closeBtn.addEventListener("click", closeUpdateDialog);
  footer.appendChild(closeBtn);

  const spacer = document.createElement("span");
  spacer.className = "update-footer-spacer";
  footer.appendChild(spacer);

  if (state === "failed") {
    const releasesBtn = document.createElement("button");
    releasesBtn.type = "button";
    releasesBtn.textContent = t("update.openReleases");
    releasesBtn.addEventListener("click", () => openUrl("https://github.com/Rocktier/pic2webp/releases/latest"));
    footer.appendChild(releasesBtn);
  }
  if (state === "available" && result) {
    const getBtn = document.createElement("button");
    getBtn.type = "button";
    getBtn.className = "update-get-btn";
    getBtn.textContent = t("update.download", { v: result.latest });
    getBtn.addEventListener("click", () => openUrl(result.url));
    footer.appendChild(getBtn);
  }
}

// 语言切换时重渲染对话框文案（license.js 同款事件）
window.addEventListener("lang-changed", renderDialog);
