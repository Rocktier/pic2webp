// ─── i18n: 中英双语模块（2026-10-13 起，全家收敛为 en/zh 两门）────────────────────────────────────────

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
];

const dict = {
  en: {
    "subtitle": "Images to WebP · A Rocktier tool",
    "themeBtn": "Theme",
    "theme-mode-auto": "Follow system",
    "theme-mode-light": "Light",
    "theme-mode-dark": "Dark",
    "dropzone-text": "Drop images here",
    "dropzone-hint": "or click to select · JPG / PNG / GIF / BMP / TIFF / WebP",
    "empty-hint": "Drop images here to start · WebP output, processed locally",
    "file-count": "{n} file(s) selected",
    "clear": "Clear",
    "output-quality": "Output Quality",
    "quality": "Quality",
    "small-file": "Smaller",
    "q-balanced": "Balanced",
    "high-quality": "Better",
    "convert-options": "Options",
    "recursive": "Include subdirectories",
    "delete-source": "Delete source",
    "output-dir": "Output Directory",
    "same-dir": "Same as source",
    "select": "Browse",
    "naming-rule": "Naming",
    "overwrite": "Overwrite",
    "timestamp": "Timestamp",
    "success": "Done",
    "skip": "Skip",
    "fail": "Failed",
    "saved": "Saved",
    "start-convert": "Convert",
    "converting": "Converting...",
    "cancel-convert": "Cancel",
    "re-convert": "Convert Again",
    "status-pending": "Pending",
    "status-converting": "Converting",
    "status-done": "Done",
    "status-skipped": "Skipped",
    "status-failed": "Failed",
    "converting_no_anim": "Converting (no animation support)",
    "saved-bytes": "Saved {size}",
    "convert-failed": "Failed to start conversion",
    "large-file-warn": "⚠️ {name} ({size}) is large, conversion may use significant memory",
    "batch-warn": "⚠️ {n} files loaded — consider smaller batches",
    "select-output-dir": "Select output directory",
    "select-folder": "Select Folder",
    "folder-hint": "Folder detected but subdirectory recursion is off. Enable \"Include subdirectories\" to process images inside.",
    "overwrite-warn": "⚠️ Existing .webp files will be overwritten, cannot be undone",
    "retry": "Retry",
    "msg-converting": "Converting to WebP...",
    "msg-already-converting": "Already converting. Wait for the current batch to finish.",
    "msg-saved": "Saved {n} KB",
    "msg-skipped": "WebP not smaller, skipped",
    "msg-write-fail": "Write failed: {e}",
    "msg-delete-fail": "Converted, but failed to delete source: {e}",
    "msg-encode-fail": "WebP encoding failed: {e}",
    "msg-open-fail": "Cannot open image: {e}",
    "msg-decode-fail": "Decode failed: {e}",
    "msg-ext-mismatch": "This file is named .{ext} but is actually {actual} data. It was read as {actual} — rename it to .{actual} to stop seeing this.",
    "msg-too-large": "Image too large ({e}), skipped",
    "msg-gif-fail": "Animated GIF conversion failed",
    "msg-format-fail": "Unrecognized image format: {e}",
    "msg-target-unreachable": "Lowest quality reached, still {n} KB (target not met)",
    "unsupported-dropped": "{n} unsupported file(s) ignored",
    "confirm-close": "Conversion in progress. Are you sure you want to quit?",
    "confirm-delete": "⚠️ Source files will be deleted after conversion. This cannot be undone. Continue?",
    "confirm-disk-space": "⚠️ Only {free} free on the destination drive — this batch could need up to {need}. Continue anyway?",
    "unsupported-heic": "{n} HEIC file(s) ignored — HEIC/HEIF is not supported; export as JPG first (Preview, Photos, …)",
    "retry-all": "Retry All Failed",
    "lossless": "Lossless",
    "target-size": "Target Size",
    "advanced": "Advanced",
    "resize": "Resize",
    "resize-width": "W",
    "resize-height": "H",
    "resize-fit": "Fit",
    "resize-fill": "Fill",
    "resize-shrink": "Shrink only",
    "preserve-structure": "Preserve folder structure",
    "remove-file": "Remove",
    "compare-side-by-side": "Side by Side",
    "compare-slider": "Slider",
    "license.title": "License",
    "license.loading": "Checking…",
    "license.trialLeft": "Free trial — {days} day(s) left.",
    "license.trialChip": "Trial · {days}d",
    "license.expiredChip": "Not activated",
    "license.expired": "Your trial has ended. Browsing and previewing still work; converting needs a license.",
    "license.revokedNotice": "This licence has been revoked — usually after a refund or a payment dispute. Your licence status has been reset. Activate again below to continue, or write to hello@rocktier.com (with your order number) if you believe this is a mistake.",
    "license.licensed": "Licensed. Thank you.",
    "license.licensedFamily": "Licensed — family bundle. Every Rocktier app is unlocked.",
    "license.licensedNote": "This copy is activated. No further checks, and no network access.",
    "license.storeNote": "This copy came from the Microsoft Store, so the Store handles the license for it.",
    "license.notConfigured": "This build cannot activate a code yet — it carries no verification key. Please write to hello@rocktier.com.",
    "license.codeLabel": "Activation code",
    "license.codePlaceholder": "RKT-…",
    "license.activate": "Activate",
    "license.activating": "Activating…",
    "license.buy": "Buy — $4.99",
    "license.close": "Close",
    "license.invalid": "That code was not accepted. Check it for a typo — the code is not case-sensitive.",
    "license.wrongProduct": "That code belongs to a different Rocktier app. Each app has its own code — or the family bundle, which unlocks all of them.",
    "license.refunded": "That code was refunded, so it no longer unlocks anything. If this is a mistake, write to hello@rocktier.com with your order number.",
    "license.offline": "Could not reach rocktier.com. Activating needs one connection; after that the app stays offline.",
    "license.deviceLimit": "This code has reached its device limit. Deactivate a device at rocktier.com/license, then try again.",
    "update.check": "Check for updates",
    "update.checking": "Checking…",
    "update.upToDate": "You're up to date",
    "update.available": "Version {v} is available",
    "update.failed": "Couldn't check for updates",
    "update.lastChecked": "Last checked {date}",
    "update.never": "Never",
    "update.download": "Get {v}",
    "update.privacyNote": "Only checks when you click — the app never checks on its own",
    "update.close": "Close",
    "update.openReleases": "Open releases",
    "update.openReleasesHint": "You can also open the releases page directly.",
    "license.whereToFind": "Your code was shown on the page right after payment, and is in the purchase email too.",
    "license.privacyNote": "Activating sends the code to rocktier.com once and stores the signed reply locally. Nothing else is sent.",
  },

  zh: {
    "subtitle": "图片转 WebP · 免费 · 本地处理",
    "themeBtn": "主题",
    "theme-mode-auto": "跟随系统",
    "theme-mode-light": "浅色",
    "theme-mode-dark": "深色",
    "dropzone-text": "拖拽图片到此处",
    "dropzone-hint": "或点击选择文件 · 支持 JPG / PNG / GIF / BMP / TIFF / WebP",
    "empty-hint": "拖入图片即可开始 · 输出 WebP，本地处理不上传",
    "file-count": "已选择 {n} 个文件",
    "clear": "清空",
    "output-quality": "输出质量",
    "quality": "质量",
    "small-file": "小文件",
    "q-balanced": "均衡",
    "high-quality": "高质量",
    "convert-options": "转换选项",
    "recursive": "递归子目录",
    "delete-source": "删除源文件",
    "output-dir": "输出目录",
    "same-dir": "与源文件同目录",
    "select": "选择",
    "naming-rule": "命名规则",
    "overwrite": "覆盖",
    "timestamp": "时间戳",
    "success": "成功",
    "skip": "跳过",
    "fail": "失败",
    "saved": "节省",
    "start-convert": "开始转换",
    "converting": "转换中...",
    "cancel-convert": "取消转换",
    "re-convert": "重新转换",
    "status-pending": "等待中",
    "status-converting": "转换中",
    "status-done": "完成",
    "status-skipped": "跳过",
    "status-failed": "失败",
    "converting_no_anim": "转换中（无动画支持）",
    "saved-bytes": "节省 {size}",
    "convert-failed": "启动转换失败",
    "large-file-warn": "⚠️ {name} ({size}) 体积较大，转换可能占用较多内存",
    "batch-warn": "⚠️ 已添加 {n} 个文件，建议分批处理",
    "select-output-dir": "选择输出目录",
    "select-folder": "选择文件夹",
    "folder-hint": "检测到文件夹，但未开启递归子目录。勾选「递归子目录」以处理其中的图片。",
    "overwrite-warn": "⚠️ 同名 .webp 文件将被直接覆盖，不可恢复",
    "retry": "重试",
    "msg-converting": "转换为 WebP...",
    "msg-already-converting": "正在转换中。请等当前这批处理完。",
    "msg-saved": "已保存 {n} KB",
    "msg-skipped": "WebP 未更小，已跳过",
    "msg-write-fail": "写入失败: {e}",
    "msg-delete-fail": "已转换，但删除源文件失败: {e}",
    "msg-encode-fail": "WebP 编码失败: {e}",
    "msg-open-fail": "无法打开图片: {e}",
    "msg-decode-fail": "解码失败: {e}",
    "msg-ext-mismatch": "此文件扩展名是 .{ext}，实际内容是 {actual} 格式。已按 {actual} 读取 —— 改名为 .{actual} 即可不再看到此提示。",
    "msg-too-large": "图片尺寸过大（{e}），已跳过",
    "msg-gif-fail": "动图 GIF 转换失败",
    "msg-format-fail": "图片格式无法识别：{e}",
    "msg-target-unreachable": "已用最低质量，仍为 {n} KB（未达目标体积）",
    "unsupported-dropped": "已忽略 {n} 个不支持的文件",
    "confirm-close": "正在转换中，确定要退出吗？",
    "confirm-delete": "⚠️ 转换后将删除原始文件，此操作不可撤销。确定继续吗？",
    "confirm-disk-space": "⚠️ 目标磁盘仅剩 {free}，本批最多可能写入 {need}。仍要继续吗？",
    "unsupported-heic": "已忽略 {n} 个 HEIC 文件——暂不支持 HEIC/HEIF（专利许可限制），请先在预览/照片中导出为 JPG",
    "retry-all": "重试全部失败",
    "lossless": "无损",
    "target-size": "目标大小",
    "advanced": "高级选项",
    "resize": "缩放",
    "resize-width": "宽",
    "resize-height": "高",
    "resize-fit": "等比",
    "resize-fill": "填充",
    "resize-shrink": "仅缩小",
    "preserve-structure": "保留目录结构",
    "remove-file": "移除",
    "compare-side-by-side": "并排对比",
    "compare-slider": "叠加对比",
    "license.title": "许可与激活",
    "license.loading": "正在检查…",
    "license.trialLeft": "免费试用中 —— 还剩 {days} 天。",
    "license.trialChip": "试用 · {days} 天",
    "license.expiredChip": "未激活",
    "license.expired": "试用已结束。浏览与预览仍可用；转换需要激活。",
    "license.revokedNotice": "该许可已被吊销 —— 通常是退款或支付争议导致。授权状态已重置。在下方重新激活即可继续使用；若你认为这是误判，请把订单号发到 hello@rocktier.com。",
    "license.licensed": "已激活。谢谢。",
    "license.licensedFamily": "已激活 —— 全家桶，所有 Rocktier 应用均已解锁。",
    "license.licensedNote": "此副本已激活。此后不再有任何校验，也不联网。",
    "license.storeNote": "此副本购自微软商店，许可由商店负责。",
    "license.notConfigured": "此构建尚未配置验签公钥，暂时无法激活。请写信到 hello@rocktier.com。",
    "license.codeLabel": "激活码",
    "license.codePlaceholder": "RKT-…",
    "license.activate": "激活",
    "license.activating": "正在激活…",
    "license.buy": "购买 — $4.99",
    "license.close": "关闭",
    "license.invalid": "该激活码未被接受。请检查是否输错（不区分大小写）。",
    "license.wrongProduct": "这个激活码属于另一个 Rocktier 应用。每个应用各有自己的码，或者用全家桶（可解锁全部）。",
    "license.refunded": "这个激活码对应的购买已退款，因此不能再解锁。如属误判，请把订单号发到 hello@rocktier.com。",
    "license.offline": "连不上 rocktier.com。激活需要一次联网，之后便不再联网。",
    "license.deviceLimit": "这张激活码的设备数已达上限。请先到 rocktier.com/license 解绑一台设备，再重试。",
    "update.check": "检查更新",
    "update.checking": "正在检查…",
    "update.upToDate": "已是最新版本",
    "update.available": "有新版本 {v}",
    "update.failed": "检查失败，请稍后再试",
    "update.lastChecked": "上次检查：{date}",
    "update.never": "从未检查",
    "update.download": "获取 {v}",
    "update.privacyNote": "点击才会联网，应用不会自动检查",
    "update.close": "关闭",
    "update.openReleases": "打开发布页",
    "update.openReleasesHint": "也可以直接打开发布页查看。",
    "license.whereToFind": "付款后页面上会显示激活码，购买确认邮件里也有一份。",
    "license.privacyNote": "激活会把激活码发送到 rocktier.com 一次，并把签名回执保存在本机。除此之外不传输任何内容。",
    /* 2026-10-04 清掉 4 个死键。
     *
     * `failed` 在 zh 块内、其余 7 个语种都没有；`source`/`image`/`format` 的缩进是
     * 2 空格 —— 与 `zh:`/`ja:` 同级，也就是**漂在所有语言块之外**。
     * t() 的兜底链是 `langDict[key] || dict.en[key] || dict.zh[key] || key`，
     * 所以漂在外面的键取不到任何翻译，会把**键名本身**当文案显示出来。
     *
     * 而这 4 个键一次都没被引用过（t("failed") / t("source") / … 全为 0 处），
     * 属于纯粹的字典垃圾 —— 与其补齐 8 份翻译，不如直接删。
     * 顺带说明：family-check 的 i18n 对账此前 8 年如一日报「适配表未取到键」，
     * 从没真正比对过，所以这几个错位一直没被发现（见 tools/family-check.mjs
     * blockKeysFor 的转义陷阱注释）。 */
},
};

// ─── State ──────────────────────────────────────────────────────────

let currentLang = "en";

// ─── Public API ─────────────────────────────────────────────────────

export function getLanguages() {
  return LANGUAGES;
}

export function initLang() {
  const saved = localStorage.getItem("rocktier.lang");
  const codes = LANGUAGES.map((l) => l.code);
  // 家族约定：无保存偏好时默认英文，不跟随系统语言
  currentLang = codes.includes(saved) ? saved : "en";
  applyLang();
}

export function getLang() { return currentLang; }

export function setLang(code) {
  const codes = LANGUAGES.map((l) => l.code);
  if (codes.includes(code)) {
    currentLang = code;
    localStorage.setItem("rocktier.lang", currentLang);
    applyLang();
  }
}

export function toggleLang() {
  const codes = LANGUAGES.map((l) => l.code);
  const idx = codes.indexOf(currentLang);
  currentLang = codes[(idx + 1) % codes.length];
  localStorage.setItem("rocktier.lang", currentLang);
  applyLang();
  return currentLang;
}

export function t(key, params = {}) {
  const langDict = dict[currentLang] || dict.en;
  let str = langDict[key] || dict.en[key] || dict.zh[key] || key;
  for (const [k, v] of Object.entries(params)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }
  return str;
}

export function applyLang() {
  const langCode = currentLang === "zh" ? "zh-CN" : currentLang;
  document.documentElement.lang = langCode;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const paramsAttr = el.getAttribute("data-i18n-params");
    let params = {};
    if (paramsAttr) { try { params = JSON.parse(paramsAttr); } catch (_) {} }
    el.textContent = t(key, params);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
  });
  window.dispatchEvent(new CustomEvent("lang-changed", { detail: currentLang }));
}

export function translateBackendMessage(message) {
  if (!message) return "";
  const patterns = [
    { regex: /^converting$/, key: "msg-converting" },
    { regex: /^converting_no_anim$/, key: "converting_no_anim" },
    { regex: /^skipped$/, key: "msg-skipped" },
    { regex: /^saved:(\d+)kb$/, key: "msg-saved", extract: (m) => ({ n: m[1] }) },
    { regex: /^write_fail:(.+)$/, key: "msg-write-fail", extract: (m) => ({ e: m[1] }) },
    { regex: /^encode_fail:(.+)$/, key: "msg-encode-fail", extract: (m) => ({ e: m[1] }) },
    { regex: /^open_fail:(.+)$/, key: "msg-open-fail", extract: (m) => ({ e: m[1] }) },
    { regex: /^decode_fail:(.+)$/, key: "msg-decode-fail", extract: (m) => ({ e: m[1] }) },
    // 扩展名与实际内容不符（微信/网页「另存为」的典型产物：名为 .jpg 实为 PNG）。
    // 这类错误原先会漏出 `Illegal start bytes:8950` 这种十六进制，用户完全看不懂，
    // 也不知道「改个扩展名就能用」—— 所以给一条可操作的提示。
    { regex: /^ext_mismatch:([a-z]+):([a-z0-9]+)$/, key: "msg-ext-mismatch", extract: (m) => ({ actual: m[1], ext: m[2] }) },
    { regex: /^delete_fail:(.+)$/, key: "msg-delete-fail", extract: (m) => ({ e: m[1] }) },
    { regex: /^too_large:(.+)$/, key: "msg-too-large", extract: (m) => ({ e: m[1] }) },
    { regex: /^gif_convert_fail$/, key: "msg-gif-fail" },
    { regex: /^format_fail:(.+)$/, key: "msg-format-fail", extract: (m) => ({ e: m[1] }) },
    { regex: /^target_unreachable:(\d+)kb$/, key: "msg-target-unreachable", extract: (m) => ({ n: m[1] }) },
    // 转换互斥锁被占用（lib.rs convert 入口）。正常点不到 —— 前端按钮已禁用 ——
    // 属防御路径，但防御路径也要说人话：重复点击时用户看到的是「已在转换」，
    // 而不是 ERR_ALREADY_CONVERTING 这种内部码。
    { regex: /^ERR_ALREADY_CONVERTING$/, key: "msg-already-converting" },
  ];
  for (const p of patterns) {
    const m = message.match(p.regex);
    if (m) return t(p.key, p.extract ? p.extract(m) : {});
  }
  return message;
}