# 外部工具

## WebP 编码 ✅ 内置

WebP 编码由 Rust 原生 `webp` crate（libwebp 绑定）完成，编译时静态链接，**无需任何外部工具**。

## 可选增强工具

| 工具 | macOS | Windows | 作用 |
|---|---|---|---|
| **jpegoptim** | `brew install jpegoptim` | 需下载 | JPEG 预压缩（可选） |
| **pngquant** | `brew install pngquant` | 需下载 | PNG 有损压缩（可选） |
| **oxipng** | `brew install oxipng` | 需下载 | PNG 无损优化（可选） |

可选工具缺失时自动跳过，不影响核心功能。
