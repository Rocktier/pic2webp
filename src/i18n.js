// ─── i18n: 中英文国际化模块 ─────────────────────────────────────────

const dict = {
  zh: {
    // Header
    "subtitle": "图片转 WebP · 免费 · 本地处理",

    // Dropzone
    "dropzone-text": "拖拽图片到此处",
    "dropzone-hint": "或点击选择文件 · 支持 JPG / PNG / WebP / AVIF",

    // File list
    "file-count": "已选择 {n} 个文件",
    "clear": "清空",

    // Empty state
    "why-webp": "为什么要用 WebP？",
    "why-1": "Google 开发的现代图片格式",
    "why-2": "同等画质体积减少 25-50%",
    "why-3": "支持透明通道，替代 PNG",
    "why-4": "Chrome / Edge / Firefox / Safari 全兼容",
    "how-title": "如何实现？",
    "how-1": "内置 WebP 编码引擎，无需安装任何工具",
    "how-2": "可选 jpegoptim / pngquant 预压缩，进一步减小体积",
    "how-3": "所有处理本地完成，不上传任何文件",
    "how-4": "转换后自动统计节省空间",

    // Batch tips
    "tips-title": "批量处理提示",
    "tips-1": "逐张串行转换，批量拖入不会卡顿",
    "tips-2": "单张建议 < 50MB，超大会占用较多内存",
    "tips-3": "建议单次不超过 200 张，更多请分批处理",

    // Blog
    "blog": "博客",

    // Quality
    "output-quality": "输出质量",
    "quality": "质量",
    "small-file": "小文件",
    "high-quality": "高质量",

    // Options
    "convert-options": "转换选项",
    "recursive": "递归子目录",
    "delete-source": "转换后删除源文件",

    // Output dir
    "output-dir": "输出目录",
    "same-dir": "与源文件同目录",
    "select": "选择",

    // Naming
    "naming-rule": "命名规则",
    "overwrite": "覆盖",
    "timestamp": "时间戳",

    // Stats
    "success": "成功",
    "skip": "跳过",
    "fail": "失败",
    "saved": "节省",

    // Convert button
    "start-convert": "开始转换",
    "converting": "转换中...",
    "cancel-convert": "取消转换",
    "re-convert": "重新转换",

    // Status labels
    "status-pending": "等待中",
    "status-compressing": "压缩中",
    "status-converting": "转换中",
    "status-done": "完成",
    "status-skipped": "跳过",
    "status-failed": "失败",

    // File size messages
    "saved-bytes": "节省 {size}",
    "convert-failed": "启动转换失败",
    "large-file-warn": "⚠️ {name} ({size}) 体积较大，转换可能占用较多内存",
    "batch-warn": "⚠️ 已添加 {n} 个文件，建议分批处理",

    // Dialog
    "select-output-dir": "选择输出目录",

    "no-precompress": "预压缩未启用（可选安装 jpegoptim / pngquant / oxipng）",

    // Donate
    "donate-btn": "请作者喝杯奶茶 ☕",
    "folder-hint": "检测到文件夹，但未开启递归子目录。勾选「递归子目录」以处理其中的图片。",
    "overwrite-warn": "⚠️ 同名 .webp 文件将被直接覆盖，不可恢复",
    "retry": "重试",
    "donate-title": "请作者喝杯奶茶 🧋",
    "donate-hint": "如果 Pic2WebP 帮到了你，欢迎随意打赏",
    "alipay": "支付宝",
    "wechat-pay": "微信支付",

    // Backend message overrides (maps Rust message codes to localized)
    "msg-precompress-jpeg": "JPEG 预压缩...",
    "msg-precompress-png": "PNG 预压缩...",
    "msg-converting": "转换为 WebP...",
    "msg-saved": "已保存 {n} KB",
    "msg-skipped": "WebP 未更小，已跳过",
    "msg-write-fail": "写入失败: {e}",
    "msg-delete-fail": "已转换，但删除源文件失败: {e}",
    "msg-encode-fail": "WebP 编码失败: {e}",
    "msg-open-fail": "无法打开图片: {e}",
    "msg-decode-fail": "解码失败: {e}",
    "msg-too-large": "图片尺寸过大（{e}），已跳过",

    // P0-2/P0-3: Confirmation dialogs
    "confirm-close": "正在转换中，确定要退出吗？",
    "confirm-delete": "⚠️ 转换后将删除原始文件，此操作不可撤销。确定继续吗？",
    "retry-all": "重试全部失败",
    "copy-path": "复制路径",
    "copied": "已复制",
  },

  en: {
    // Header
    "subtitle": "JPG to WebP · Free · Local",

    // Dropzone
    "dropzone-text": "Drop images here",
    "dropzone-hint": "or click to select · JPG / PNG / WebP / AVIF",

    // File list
    "file-count": "{n} file(s) selected",
    "clear": "Clear",

    // Empty state
    "why-webp": "Why WebP?",
    "why-1": "Modern image format by Google",
    "why-2": "25-50% smaller at same quality",
    "why-3": "Supports transparency, replaces PNG",
    "why-4": "Works in all modern browsers",
    "how-title": "How it works",
    "how-1": "Built-in WebP encoder, no extra tools needed",
    "how-2": "Optional jpegoptim / pngquant pre-compression",
    "how-3": "100% local processing — no uploads, no network calls",
    "how-4": "Auto-calculates space savings",

    // Batch tips
    "tips-title": "Batch Tips",
    "tips-1": "Sequential processing — no lag on large batches",
    "tips-2": "Keep each file under 50MB to avoid high memory use",
    "tips-3": "Keep batches under 200 files for best performance",

    // Blog
    "blog": "Blog",

    // Quality
    "output-quality": "Output Quality",
    "quality": "Quality",
    "small-file": "Smaller",
    "high-quality": "Better",

    // Options
    "convert-options": "Options",
    "recursive": "Include subdirectories",
    "delete-source": "Delete source after conversion",

    // Output dir
    "output-dir": "Output Directory",
    "same-dir": "Same as source",
    "select": "Browse",

    // Naming
    "naming-rule": "Naming",
    "overwrite": "Overwrite",
    "timestamp": "Timestamp",

    // Stats
    "success": "Done",
    "skip": "Skip",
    "fail": "Failed",
    "saved": "Saved",

    // Convert button
    "start-convert": "Convert",
    "converting": "Converting...",
    "cancel-convert": "Cancel",
    "re-convert": "Convert Again",

    // Status labels
    "status-pending": "Pending",
    "status-compressing": "Compressing",
    "status-converting": "Converting",
    "status-done": "Done",
    "status-skipped": "Skipped",
    "status-failed": "Failed",

    // File size messages
    "saved-bytes": "Saved {size}",
    "convert-failed": "Failed to start conversion",
    "large-file-warn": "⚠️ {name} ({size}) is large, conversion may use significant memory",
    "batch-warn": "⚠️ {n} files loaded — consider smaller batches",

    // Dialog
    "select-output-dir": "Select output directory",

    "no-precompress": "Pre-compression disabled (optional: jpegoptim / pngquant / oxipng)",

    // Donate
    "donate-btn": "Buy me a coffee ☕",
    "folder-hint": "Folder detected but subdirectory recursion is off. Enable \"Include subdirectories\" to process images inside.",
    "overwrite-warn": "⚠️ Existing .webp files will be overwritten, cannot be undone",
    "retry": "Retry",
    "donate-title": "Buy me a coffee 🧋",
    "donate-hint": "If Pic2WebP helped you, feel free to support",
    "alipay": "Alipay",
    "wechat-pay": "WeChat Pay",

    // Backend message overrides
    "msg-precompress-jpeg": "Pre-compressing JPEG...",
    "msg-precompress-png": "Pre-compressing PNG...",
    "msg-converting": "Converting to WebP...",
    "msg-saved": "Saved {n} KB",
    "msg-skipped": "WebP not smaller, skipped",
    "msg-write-fail": "Write failed: {e}",
    "msg-delete-fail": "Converted, but failed to delete source: {e}",
    "msg-encode-fail": "WebP encoding failed: {e}",
    "msg-open-fail": "Cannot open image: {e}",
    "msg-decode-fail": "Decode failed: {e}",
    "msg-too-large": "Image too large ({e}), skipped",

    // P0-2/P0-3: Confirmation dialogs
    "confirm-close": "Conversion in progress. Are you sure you want to quit?",
    "confirm-delete": "⚠️ Source files will be deleted after conversion. This cannot be undone. Continue?",
    "retry-all": "Retry All Failed",
    "copy-path": "Copy Path",
    "copied": "Copied",
  },
};

// ─── State ──────────────────────────────────────────────────────────

let currentLang = "zh";

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Initialize language from localStorage or system locale
 */
export function initLang() {
  const saved = localStorage.getItem("pic2webp-lang");
  if (saved === "zh" || saved === "en") {
    currentLang = saved;
  } else {
    // Detect system language
    const sysLang = navigator.language || navigator.userLanguage || "zh";
    currentLang = sysLang.startsWith("zh") ? "zh" : "en";
  }
  applyLang();
}

/**
 * Get current language
 */
export function getLang() {
  return currentLang;
}

/**
 * Toggle between zh and en
 */
export function toggleLang() {
  currentLang = currentLang === "zh" ? "en" : "zh";
  localStorage.setItem("pic2webp-lang", currentLang);
  applyLang();
  return currentLang;
}

/**
 * Translate a key with optional template params
 * @param {string} key - dictionary key
 * @param {object} params - { n: 5, size: "12 KB" } etc.
 * @returns {string}
 */
export function t(key, params = {}) {
  const langDict = dict[currentLang] || dict.zh;
  let str = langDict[key] || dict.zh[key] || key;
  for (const [k, v] of Object.entries(params)) {
    str = str.replace(`{${k}}`, v);
  }
  return str;
}

/**
 * Apply translations to all [data-i18n] elements in the DOM
 * Called on init and on language toggle
 */
export function applyLang() {
  document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const paramsAttr = el.getAttribute("data-i18n-params");
    let params = {};
    if (paramsAttr) {
      try { params = JSON.parse(paramsAttr); } catch (_) {}
    }
    el.textContent = t(key, params);
  });

  // Update placeholders
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    el.placeholder = t(key);
  });

  // Notify other modules that language changed
  window.dispatchEvent(new CustomEvent("lang-changed", { detail: currentLang }));
}

/**
 * Translate a backend message string
 * Tries to match known patterns, falls back to original
 */
export function translateBackendMessage(message) {
  if (!message) return "";

  // Match backend message codes (English codes sent from Rust)
  const patterns = [
    { regex: /^precompress_jpeg$/, key: "msg-precompress-jpeg" },
    { regex: /^precompress_png$/, key: "msg-precompress-png" },
    { regex: /^converting$/, key: "msg-converting" },
    { regex: /^skipped$/, key: "msg-skipped" },
    { regex: /^saved:(\d+)kb$/, key: "msg-saved", extract: (m) => ({ n: m[1] }) },
    { regex: /^write_fail:(.+)$/, key: "msg-write-fail", extract: (m) => ({ e: m[1] }) },
    { regex: /^encode_fail:(.+)$/, key: "msg-encode-fail", extract: (m) => ({ e: m[1] }) },
    { regex: /^open_fail:(.+)$/, key: "msg-open-fail", extract: (m) => ({ e: m[1] }) },
    { regex: /^decode_fail:(.+)$/, key: "msg-decode-fail", extract: (m) => ({ e: m[1] }) },
    { regex: /^delete_fail:(.+)$/, key: "msg-delete-fail", extract: (m) => ({ e: m[1] }) },
    { regex: /^too_large:(.+)$/, key: "msg-too-large", extract: (m) => ({ e: m[1] }) },
  ];

  for (const p of patterns) {
    const m = message.match(p.regex);
    if (m) {
      return t(p.key, p.extract ? p.extract(m) : {});
    }
  }

  return message;
}
