// 文件对话框认哪些后缀 —— 单一来源。
//
// 后端能力以 src-tauri/Cargo.toml 的 image crate features 为准
// （jpeg / png / webp / gif / bmp / tiff 都开着，解码走内容嗅探，不看后缀）。
// 这里只管「让用户在面板里选得到」。
//
// 2026-11-07 事故：这张表当时写在 app.js 的 open() 里，TIFF 只写了 "tiff"。
// macOS 上的老 TIFF 文件后缀绝大多数是 `.tif`，于是在面板里被判灰、点不动 ——
// 拖放能进、点选进不来。四个样张第一次只导进来三个，就是这一行。
// 判据见 tests/formats.test.mjs。
export const FORMAT_ALIASES = {
  jpeg: ["jpg", "jpeg"],
  png: ["png"],
  webp: ["webp"],
  gif: ["gif"],
  bmp: ["bmp"],
  tiff: ["tif", "tiff"],
};

/** 传给 Tauri dialog `filters.extensions`：小写、无前导点、无重复。 */
export const DIALOG_IMAGE_EXTENSIONS = Object.values(FORMAT_ALIASES).flat();
