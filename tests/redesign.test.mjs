// 结构契约 —— 重设计后的界面与 app.js 接线必须对得上。
//
// 为什么需要它：这一版把 814 行内联样式换成了新壳，同时删掉了 8 个控件。
// 「删了控件但 app.js 还在用」不会让 vite 构建失败，也不会让 CI 报错 ——
// 只会在用户拖进第一张图的时候抛 null 异常，页面白掉。2026-10-21 的
// v1.9.14 事故就是这一类（body 被删、构建照绿）。
//
// 判据全部是静态文本比对，零依赖，node --test 直接跑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const html = read("src/index.html");
const app = read("src/app.js");
const css = read("src/styles/macos.css");
const i18n = read("src/i18n.js");
const quicklook = read("src/quicklook.js");

/** app.js 里 $("#id") 静态取到的所有 id */
function referencedIds() {
  const ids = new Set();
  for (const m of app.matchAll(/\$\("#([a-zA-Z0-9_-]+)"\)/g)) ids.add(m[1]);
  return ids;
}

/** index.html 里声明过的所有 id */
function declaredIds() {
  const ids = new Set();
  for (const m of html.matchAll(/\sid="([a-zA-Z0-9_-]+)"/g)) ids.add(m[1]);
  return ids;
}

test("app.js 取用的每个 id 都存在于 index.html", () => {
  const declared = declaredIds();
  // 这些是运行时才创建的元素，或由别处注入
  const runtimeOnly = new Set(["more-menu", "batch-warning", "ql-frame"]);
  const missing = [...referencedIds()].filter(
    (id) => !declared.has(id) && !runtimeOnly.has(id),
  );
  assert.deepEqual(missing, [], `index.html 缺这些元素: ${missing.join(", ")}`);
});

test("已移除的旧控件不得在界面里复活", () => {
  const removed = [
    "quality-pills",   // 三颗药丸 → 一个系统下拉
    "quality-val",     // 质量数值由下拉文字承担
    "chk-recursive",   // → 拖入文件夹时问一次
    "chk-delete",      // → ⋯ 菜单 + 转换前确认
    "chk-structure",   // → 与递归绑定，不再独立
    "chk-lossless",    // → 质量下拉第四项
    "naming-pills",    // → 固定 basename + 撞名确认
    "output-dir",      // → 底栏路径摘要
    "dir-btn",
    "dir-clear",
    "dropzone",        // → 拖放走窗口级事件，整窗都是投放区
    "stats-panel",     // → 检查器 · Batch
    "file-list-header",
  ];
  const survivors = removed.filter((id) => html.includes(`id="${id}"`));
  assert.deepEqual(survivors, [], `这些旧控件还在 index.html 里: ${survivors.join(", ")}`);
});

test("经典控件在新壳里都在位", () => {
  const required = [
    "quality-menu", "status-dot", "file-list", "file-count-text", "clear-btn",
    "folder-btn", "convert-btn", "btn-text", "progress-bar-container",
    "progress-bar-fill", "progress-text", "path-btn", "path-text",
    "inspector", "inspector-btn", "chk-resize", "resize-w", "resize-h",
    "resize-mode", "stat-saved", "stat-success", "stat-skip", "stat-fail",
    "retry-all-btn", "status-text", "status-meta", "lang-toggle", "theme-toggle",
    "ql-overlay", "ql-image",
  ];
  const declared = declaredIds();
  const missing = required.filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `新壳缺这些元素: ${missing.join(", ")}`);
});

test("两个 module 入口仍在（2026-10-21 白屏事故的判据）", () => {
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\/updates\.js"><\/script>/);
  assert.match(html, /<\/body>\s*<\/html>/);
});

test("样式加载顺序：母版快照在前，数值层在后", () => {
  const iTokens = html.indexOf("./styles/tokens.css");
  const iMac = html.indexOf("./styles/macos.css");
  assert.ok(iTokens > -1 && iMac > -1, "两份样式表都要引用");
  assert.ok(iTokens < iMac, "macos.css 必须在 tokens.css 之后，否则覆盖不生效");
});

test("数值层确实换成了 macOS 档（圆角 / 时长 / 系统色）", () => {
  assert.match(css, /--radius-sm:\s*5\.5px/);
  assert.match(css, /--radius-md:\s*8px/);
  assert.match(css, /--dur-hover:\s*100ms/);
  assert.match(css, /--dur-state:\s*160ms/);
  assert.match(css, /--accent:\s*#007aff/i);
  assert.match(css, /--red:\s*#ff3b30/i);
});

test("红点三档语义齐备", () => {
  assert.match(css, /\.dot-live\.idle\s*\{[^}]*animation:\s*none/);
  assert.match(css, /@keyframes\s+dotSettle/);
  assert.match(css, /2\.4s/);
  // 呼吸与收束都必须能被 prefers-reduced-motion 关掉
  assert.match(css, /prefers-reduced-motion[\s\S]*\.dot-live\s*\{\s*animation:\s*none/);
});

test("数值层不得复刻 .icon-btn 基座（家族闸门规则 2b）", () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const hit = stripped.match(/^(?:button)?\.icon-btn(?::[\w-]+|::[\w-]+|\[[^\]]*\])*(?:\s+svg)?\s*\{/m);
  assert.equal(hit, null, ".icon-btn 只允许在 tokens.css 快照里定义");
});

test("quicklook 模块导出初始化函数，且被 app.js 调用", () => {
  assert.match(quicklook, /export function initQuickLook/);
  assert.match(app, /initQuickLook\(\{/);
});

test("中英词条键集合一致（新增串必须两边都有）", () => {
  const pick = (block) => [...block.matchAll(/^\s*"([a-zA-Z0-9_-]+)":/gm)].map((m) => m[1]);
  const enStart = i18n.indexOf("en: {");
  const zhStart = i18n.indexOf("zh: {");
  assert.ok(enStart > -1 && zhStart > enStart, "i18n 里找不到 en/zh 两个块");
  const en = new Set(pick(i18n.slice(enStart, zhStart)));
  const zh = new Set(pick(i18n.slice(zhStart)));
  const missingZh = [...en].filter((k) => !zh.has(k));
  const missingEn = [...zh].filter((k) => !en.has(k));
  assert.deepEqual(missingZh, [], `中文缺词条: ${missingZh.join(", ")}`);
  assert.deepEqual(missingEn, [], `英文缺词条: ${missingEn.join(", ")}`);
});

test("重设计新增的词条都在", () => {
  const keys = ["convert-n", "add-images", "confirm-recursive", "mi-clear-all",
    "mi-include-subfolders", "mi-remove-originals", "section-size",
    "section-batch", "section-images", "section-source"];
  const missing = keys.filter((k) => !i18n.includes(`"${k}":`));
  assert.deepEqual(missing, [], `缺词条: ${missing.join(", ")}`);
});

test("app.js 里 t(\"…\") 用到的每个键都在字典里", () => {
  // 拼错词条不会抛错，只会把键名原样显示给用户（本次就把 update.check
  // 写成了 check-update，界面会冒出「check-update」这行字）。
  const en = i18n.slice(i18n.indexOf("en: {"), i18n.indexOf("zh: {"));
  const used = new Set([...app.matchAll(/\bt\("([a-zA-Z0-9_.-]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((k) => !en.includes(`"${k}":`));
  assert.deepEqual(missing, [], `这些键在 en 字典里不存在: ${missing.join(", ")}`);
});
