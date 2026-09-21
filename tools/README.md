# 外部工具

## WebP 编码：内置，无需安装

WebP 编码由 Rust 原生 `webp` crate（libwebp 绑定）完成，编译时静态链接，**不需要任何外部工具**。
JPEG、PNG、AVIF 等静态图片的转换全走这条路。

## ffmpeg：可选，仅 GIF 动图需要

| 工具 | macOS | Windows | 用途 |
|---|---|---|---|
| **ffmpeg** | `brew install ffmpeg` | [ffmpeg.org/download](https://ffmpeg.org/download.html) | 把 GIF 动图转成**动画** WebP |

这是唯一的可选外部依赖。动画 WebP 的编码能力在 libwebp 之外，所以这一条路径调用
ffmpeg；它不在时，GIF 会走静态转换（只取首帧），其余格式不受影响。

其余一切都不需要外部工具。
