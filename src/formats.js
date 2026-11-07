// 文件对话框认哪些后缀 —— 单一来源。
//
// 普通格式以后端 image crate features 为准（jpeg / png / webp / gif /
// bmp / tiff 都开着，解码走内容嗅探，不看后缀）；HEIC / HEIF 是唯一例外 ——
// image crate 解不了，由 src-tauri/src/heic.rs 调系统解码器
// （macOS ImageIO / Windows WIC），不随包分发 HEVC 实现。
// 这里只管「让用户在面板里选得到」，但**选得到 ≠ 解得开**：
// 反向判据在 tests/heic.test.mjs，白名单里每种格式都必须有解码实现。
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
  // iPhone 默认照片格式。后缀必须同时给 heic / heif：AirDrop 与 iCloud
  // 照片保持 HEIC，部分相机 / 转换工具则写 .heif（Apple 116944）。
  heic: ["heic", "heif"],
};

/** 传给 Tauri dialog `filters.extensions`：小写、无前导点、无重复。 */
export const DIALOG_IMAGE_EXTENSIONS = Object.values(FORMAT_ALIASES).flat();
