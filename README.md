<div align="center">

# Pic2WebP

**图片转 WebP · 免费 · 本地处理 · 跨平台**

 JPG / PNG / WebP / AVIF → WebP，质量 75-85 通常比原图小 25-50%

[⬇️ 下载](https://github.com/old-Dang/pic2webp/releases) · [📖 文档](#开发--development) · [🐛 反馈](https://github.com/old-Dang/pic2webp/issues)

</div>

---

> 🌐 **中文** | [English](#english)

## ✨ 特性

| | |
|---|---|
| 🖼️ **拖拽即用** | 把图片拖到窗口，剩下交给它 |
| 📁 **递归子目录** | 勾上后整棵目录树一并处理 |
| 🗑️ **删除源文件** | 转换成功可自动清理原图 |
| 📊 **实时统计** | 节省了多少 MB、压缩比多少 |
| 🎯 **质量可调** | 10-100 滑块，建议 75-85 |
| ⏹️ **一键取消** | 批量转换中途可随时取消 |
| 🔄 **失败重试** | 单个文件转换失败后可单独重试 |
| 🛠️ **原生 WebP 编码** | 内置 WebP 引擎，无需安装任何工具 |
| 🔧 **可选预压缩** | jpegoptim / pngquant / oxipng 自动检测并展示状态 |
| 🔒 **完全离线** | 不发任何网络请求，不上传任何文件 |
| 🌐 **中英双语** | 自动检测系统语言，一键切换 |
| 🍎 **macOS 11+** | · | **Windows 10+** |

## ⬇️ 下载

前往 [Releases](https://github.com/old-Dang/pic2webp/releases) 下载对应平台的安装包。

| 平台 | 安装包 | 大小 |
|------|--------|------|
| macOS (Apple Silicon) | `.dmg` | ~5 MB |
| Windows (x64) | `.exe` (NSIS) | ~5 MB |

### 首次打开

**macOS**：右键点击 App 选「打开」即可。Gatekeeper 会提示「无法验证开发者」，点「仍要打开」继续。

**Windows**：⚠️ 首次运行 SmartScreen 可能提示「已保护你的电脑」，点击「更多信息」→「仍要运行」即可。这是未购买代码签名证书的正常现象，软件本身完全安全。

## 开发

### 前提条件

- [Rust](https://rustup.rs/) 1.70+
- [Node.js](https://nodejs.org/) 18+
- 可选：jpegoptim / pngquant / oxipng（macOS: `brew install`）

### 启动

```bash
npm install          # 安装前端依赖
npm run tauri dev    # 开发模式（热更新）
npm run tauri build  # 构建发布版
```

### 构建产物

| 平台 | 路径 |
|------|------|
| macOS | `src-tauri/target/release/bundle/dmg/Pic2WebP_*_aarch64.dmg` |
| Windows | `src-tauri/target/release/bundle/nsis/Pic2WebP_*_x64-setup.exe` |

### 国内镜像加速（可选）

<details>
<summary>点击展开</summary>

**npm**：
```bash
npm config set registry https://registry.npmmirror.com
```

**Cargo**（`~/.cargo/config.toml`）：
```toml
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
```

</details>

## 🔒 隐私

100% 本地工具。**不收集任何数据，不发起任何网络请求。**

## 📄 协议

[MIT](LICENSE)

---

# English

<div align="center">

**JPG / PNG / WebP / AVIF → WebP converter · Free · Local · Cross-platform**

Reduce image size by 25-50% at quality 75-85

[⬇️ Download](https://github.com/old-Dang/pic2webp/releases) · [📖 Docs](#development) · [🐛 Issues](https://github.com/old-Dang/pic2webp/issues)

</div>

## ✨ Features

| | |
|---|---|
| 🖼️ **Drag & drop** | Drop images into the window, done |
| 📁 **Recursive** | Process entire directory trees |
| 🗑️ **Delete source** | Optionally remove originals after conversion |
| 📊 **Live stats** | See space saved and compression ratio |
| 🎯 **Quality slider** | 10-100, recommended 75-85 |
| ⏹️ **Cancel anytime** | Stop batch conversion mid-process |
| 🔄 **Retry failed** | Retry individual failed files |
| 🛠️ **Native WebP** | Built-in encoder, no extra tools needed |
| 🔧 **Optional pre-compression** | jpegoptim / pngquant / oxipng auto-detected and shown |
| 🔒 **Fully offline** | No network requests, no uploads |
| 🌐 **Bilingual** | Auto-detect system language, one-click toggle |
| 🍎 **macOS 11+** | · | **Windows 10+** |

## ⬇️ Download

Get the latest release from [Releases](https://github.com/old-Dang/pic2webp/releases).

| Platform | Package | Size |
|----------|---------|------|
| macOS (Apple Silicon) | `.dmg` | ~5 MB |
| Windows (x64) | `.exe` (NSIS) | ~5 MB |

### First launch

**macOS**: Right-click the app → "Open". Gatekeeper will warn about unverified developer → click "Open anyway".

**Windows**: ⚠️ SmartScreen may show "protected your PC" on first run → click "More info" → "Run anyway". This is normal without a paid code signing certificate — the software is completely safe.

## Development

### Prerequisites

- [Rust](https://rustup.rs/) 1.70+
- [Node.js](https://nodejs.org/) 18+
- Optional: jpegoptim / pngquant / oxipng (macOS: `brew install`)

### Quick start

```bash
npm install          # Install frontend deps
npm run tauri dev    # Dev mode (hot reload)
npm run tauri build  # Production build
```

### Build output

| Platform | Path |
|----------|------|
| macOS | `src-tauri/target/release/bundle/dmg/Pic2WebP_*_aarch64.dmg` |
| Windows | `src-tauri/target/release/bundle/nsis/Pic2WebP_*_x64-setup.exe` |

## 🔒 Privacy

100% local tool. **No data collection, no network requests.**

## 📄 License

[MIT](LICENSE)
