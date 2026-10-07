// ─── License: trial & activation（家族 L6，Rust 侧见 src-tauri/src/license.rs）──
// Vanilla 实现：对话框用 document.createElement 就地构建（Pic2WebP 没有 UI 框架），
// 样式走 index.html 里的既有令牌（--bg-card / --border / .btn-primary 等）。
// 激活协议照 PDF services/engine.ts / MD services/license.ts：前端只做一次
// fetch 换回执，验签与落盘在 Rust（store_receipt）。

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "./i18n.js";

// 产品页：购买与试用说明的唯一入口（与应用内 menuActions.website 同源）。
const BUY_URL = "https://rocktier.com/pic2webp";

// 最近一次 license_status 的结果（LicenseInfo，见 lib.rs）。
let info = null;
// 对话框元素引用（首次打开时构建，之后复用）。
let els = null;

export function getLicenseInfo() { return info; }

// 写命令被授权闸门拦下的统一判据：Rust 的 ensure_write_allowed 返回的错误码固定为
// LICENSE_EXPIRED。各调用点的 catch 用它分流"弹激活对话框"还是"普通失败提示"。
export function isLicenseExpiredError(e) {
  return String(e).includes("LICENSE_EXPIRED");
}

export function isLicenseDialogOpen() {
  return !!(els && !els.overlay.hidden);
}

// 拉取并刷新授权状态，更新头部胶囊。失败不打扰用户（dev/浏览器里没有该命令）。
export async function refreshLicenseStatus() {
  if (!isTauri()) return null;
  try {
    info = await invoke("license_status");
  } catch (e) {
    console.warn("license_status failed:", e);
    return null;
  }
  updatePill();
  return info;
}

// ── 头部授权胶囊：试用剩 N 天 / 未激活；已激活或商店版下隐藏 ──

function updatePill() {
  const pill = document.getElementById("license-pill");
  if (!pill) return;
  const show = info && info.channel === "direct" && info.status !== "licensed";
  pill.hidden = !show;
  if (!show) return;
  if (info.status === "expired") {
    pill.textContent = t("license.expiredChip");
    pill.classList.add("expired");
  } else {
    pill.textContent = t("license.trialChip", { days: info.daysLeft });
    pill.classList.remove("expired");
  }
}

// ── 激活：一次联网换回执，之后离线验签、永不联网 ──

async function activate(code) {
  let payload;
  try {
    /* 上报机器指纹 —— 服务端据此限制「一张码能激活几台设备」。
       取不到时是空串，服务端不计数也不拦激活（见 api/devices.js）。
       指纹只用于设备计数，不含任何硬件序列号原文。 */
    let fingerprint = "";
    try {
      fingerprint = await invoke("machine_fingerprint");
    } catch {
      // Rust 命令不可用（极旧版本）不该阻断激活。
    }
    const res = await fetch("https://rocktier.com/api/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim(), fingerprint, os: (typeof navigator !== "undefined" && navigator.platform) || "" }),
    });
    payload = await res.json();
    if (!res.ok || !payload.receipt) {
      throw new Error(payload.error || `activation failed (${res.status})`);
    }
  } catch (e) {
    // 断网是最常见情形 —— 明说，而不是甩一条 fetch 报错。
    const msg = e instanceof Error && e.message && !e.message.includes("fetch")
      ? e.message
      : "offline";
    throw new Error(msg);
  }
  // 验签与落盘在 Rust：前端拿到的只是一段待验的字符串。
  return invoke("store_receipt", { signed: payload.receipt });
}

// ── 对话框（createElement 实现：遮罩 + 面板 + 输入框 + 按钮）──

function buy() {
  if (isTauri()) {
    openUrl(BUY_URL).catch(() => {});
  } else {
    window.open(BUY_URL, "_blank", "noopener");
  }
}

// 三种失败要分开说，用户的下一步动作不同：没连上网（重试即可）、码属于别的
// 应用（要买对单品或全家桶）、码不对（检查有没有抄错）。
function errorKey(detail) {
  if (detail === "offline") return "license.offline";
  if (detail.includes("WRONG_PRODUCT")) return "license.wrongProduct";
  if (detail.includes("REFUNDED")) return "license.refunded";
  return "license.invalid";
}

function buildDialog() {
  const overlay = document.createElement("div");
  overlay.className = "license-overlay";
  overlay.hidden = true;

  const dialog = document.createElement("div");
  dialog.className = "license-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const header = document.createElement("div");
  header.className = "license-header";
  const title = document.createElement("h3");
  header.appendChild(title);
  const closeX = document.createElement("button");
  closeX.type = "button";
  closeX.className = "license-close";
  closeX.textContent = "×";
  closeX.addEventListener("click", closeLicenseDialog);
  header.appendChild(closeX);

  const body = document.createElement("div");
  body.className = "license-body";

  const footer = document.createElement("div");
  footer.className = "license-footer";

  dialog.append(header, body, footer);
  overlay.appendChild(dialog);
  // 点遮罩 = 取消（与 compare-modal 的既有交互一致）；面板内点击不冒泡。
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeLicenseDialog();
  });
  // Esc 关闭（对话框打开期间生效）。
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closeLicenseDialog();
  });
  document.body.appendChild(overlay);

  els = { overlay, title, body, footer, closeX };
}

function makeButton(className, text, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = text;
  btn.addEventListener("click", onClick);
  return btn;
}

// 每次打开/状态变化都整块重建正文：文案走 t()，语言切换后也总是当前语言。
function renderDialog() {
  if (!els) buildDialog();
  const { title, body, footer } = els;
  // 语言切换重建时保住已输入的激活码
  const prevInput = body.querySelector("#license-code");
  const savedCode = prevInput ? prevInput.value : "";

  title.textContent = t("license.title");
  els.closeX.setAttribute("aria-label", t("license.close"));
  body.textContent = "";
  footer.textContent = "";

  const status = document.createElement("p");

  if (!info) {
    status.textContent = t("license.loading");
    body.appendChild(status);
    footer.appendChild(makeButton("btn-secondary", t("license.close"), closeLicenseDialog));
    return;
  }

  const licensed = info.status === "licensed";
  const isStore = info.channel === "store";
  // 没有公钥就没人激活得了。如实说明，而不是让付过钱的用户看到"激活码未被接受"。
  const canActivate = info.activationConfigured !== false;
  const statusLine = () =>
    info.status === "expired" ? t("license.expired") : t("license.trialLeft", { days: info.daysLeft });

  if (licensed) {
    status.textContent = info.product === "FL" ? t("license.licensedFamily") : t("license.licensed");
    body.appendChild(status);
    const note = document.createElement("small");
    note.textContent = t("license.licensedNote");
    body.appendChild(note);
  } else if (!canActivate) {
    status.textContent = statusLine();
    body.appendChild(status);
    const note = document.createElement("small");
    note.textContent = t("license.notConfigured");
    body.appendChild(note);
  } else if (isStore) {
    status.textContent = statusLine();
    body.appendChild(status);
    // 商店版：说明授权由商店负责，不提供任何站外购买入口（微软政策 10.8.2/10.8.4）。
    const note = document.createElement("small");
    note.textContent = t("license.storeNote");
    body.appendChild(note);
  } else {
    status.textContent = statusLine();
    body.appendChild(status);

    const field = document.createElement("div");
    field.className = "license-field";
    const label = document.createElement("label");
    label.htmlFor = "license-code";
    label.textContent = t("license.codeLabel");
    const input = document.createElement("input");
    input.id = "license-code";
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = t("license.codePlaceholder");
    input.value = savedCode;
    field.append(label, input);
    body.appendChild(field);

    const where = document.createElement("small");
    where.textContent = t("license.whereToFind");
    body.appendChild(where);

    const privacy = document.createElement("small");
    privacy.textContent = t("license.privacyNote");
    body.appendChild(privacy);

    const activateBtn = makeButton("btn-primary", t("license.activate"), submitActivation);
    activateBtn.disabled = !savedCode.trim();
    const syncActivate = () => { activateBtn.disabled = !input.value.trim(); };
    input.addEventListener("input", syncActivate);
    // 输入框里 Enter = 激活（全局 Enter 转换快捷键对 INPUT 目标不生效，见 app.js）
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitActivation();
    });
    footer.appendChild(makeButton("btn-secondary", t("license.close"), closeLicenseDialog));
    footer.appendChild(makeButton("btn-secondary", t("license.buy"), buy));
    footer.appendChild(activateBtn);
    // 打开即聚焦输入框
    setTimeout(() => input.focus(), 0);
  }

  // 其余分支（loading/已激活/未配钥/商店版）只需要一个关闭按钮
  if (!footer.querySelector("button")) {
    footer.appendChild(makeButton("btn-secondary", t("license.close"), closeLicenseDialog));
  }
}

let submitting = false;

async function submitActivation() {
  if (!els || submitting) return;
  const input = els.body.querySelector("#license-code");
  const activateBtn = els.footer.querySelector(".btn-primary");
  const code = input ? input.value.trim() : "";
  if (!code) return;

  submitting = true;
  if (activateBtn) {
    activateBtn.disabled = true;
    activateBtn.textContent = t("license.activating");
  }
  // 旧错误清掉再试
  els.body.querySelectorAll(".license-error").forEach((n) => n.remove());
  try {
    info = await activate(code);
    updatePill();
    // 激活成功立刻反映为已激活，无需重启即可继续转换
    renderDialog();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const err = document.createElement("p");
    err.className = "license-error";
    err.textContent = t(errorKey(detail));
    els.body.appendChild(err);
    if (activateBtn) {
      activateBtn.textContent = t("license.activate");
      activateBtn.disabled = !(input && input.value.trim());
    }
  } finally {
    submitting = false;
  }
}

export function openLicenseDialog() {
  if (!els) buildDialog();
  // 先用现有状态渲染（首次为检查中）
  renderDialog();
  els.overlay.hidden = false;
  // 再拉最新状态：试用可能刚好在今天到期；到达后若对话框还开着就重绘。
  refreshLicenseStatus().then(() => {
    if (isLicenseDialogOpen()) renderDialog();
  });
}

export function closeLicenseDialog() {
  if (els) els.overlay.hidden = true;
}

// ── 接线：胶囊点击、license-expired 事件、语言切换重绘 ──

export function initLicense() {
  const pill = document.getElementById("license-pill");
  if (pill) pill.addEventListener("click", openLicenseDialog);

  window.addEventListener("lang-changed", () => {
    updatePill();
    if (isLicenseDialogOpen()) renderDialog();
  });

  if (!isTauri()) return;
  listen("license-expired", () => openLicenseDialog()).catch(() => {});
  refreshLicenseStatus();
}
