// 文件对话框格式白名单的判据。
//
// 背景（2026-11-07）：拖放区文案承诺支持 TIFF，`src-tauri/Cargo.toml` 的 image
// features 也确实开了 tiff，但 `open()` 的 filters 里只写了 "tiff" 没写 "tif"。
// macOS 上老的 TIFF 文件后缀几乎都是 `.tif`，于是它们在文件面板里被判灰、点不动，
// 只有拖放能进。真机导入四个样张时只进来三个，就是这一行造成的。
//
// 判据不是「文案里写了 TIFF 就算支持」，而是「文案承诺的每一种格式，
// 对话框白名单里都要有它实际会出现的后缀」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DIALOG_IMAGE_EXTENSIONS, FORMAT_ALIASES } from "../src/formats.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

/** Cargo.toml 里 image crate 实际开着的 features —— 后端真能解码的格式。 */
function enabledImageFeatures() {
  const cargo = readFileSync(join(repo, "src-tauri/Cargo.toml"), "utf8");
  const line = cargo.split("\n").find((l) => /^image\s*=/.test(l) || /^image=/.test(l));
  assert.ok(line, "src-tauri/Cargo.toml 里找不到 image 依赖");
  const m = line.match(/features\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, `image 依赖没有写 features：${line}`);
  return m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

test("TIFF 的两种后缀都要在对话框白名单里（.tif 曾漏过）", () => {
  assert.ok(
    DIALOG_IMAGE_EXTENSIONS.includes("tif"),
    "白名单缺 .tif —— macOS 上的 TIFF 文件多数是 .tif，会变成灰色不可选",
  );
  assert.ok(DIALOG_IMAGE_EXTENSIONS.includes("tiff"), "白名单缺 .tiff");
});

test("后端开着的每种图片格式，白名单里都要有对应后缀", () => {
  const features = enabledImageFeatures();
  const missing = features.filter((f) => !DIALOG_IMAGE_EXTENSIONS.includes(f));
  assert.deepEqual(
    missing,
    [],
    `Cargo.toml 的 image features 开了 ${missing.join(", ")}，但文件对话框不认这些后缀`,
  );
});

test("别名表里的每个后缀都在白名单里（防止只改一处）", () => {
  for (const [canonical, aliases] of Object.entries(FORMAT_ALIASES)) {
    for (const ext of aliases) {
      assert.ok(
        DIALOG_IMAGE_EXTENSIONS.includes(ext),
        `${canonical} 的别名 .${ext} 没进白名单`,
      );
    }
  }
});

test("白名单没有重复项、没有前导点", () => {
  assert.equal(
    new Set(DIALOG_IMAGE_EXTENSIONS).size,
    DIALOG_IMAGE_EXTENSIONS.length,
    "白名单里有重复项",
  );
  const bad = DIALOG_IMAGE_EXTENSIONS.filter((e) => e.startsWith(".") || e !== e.toLowerCase());
  assert.deepEqual(bad, [], "后缀要小写且不带前导点（Tauri filters 的格式要求）");
});
