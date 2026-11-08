<div align="center">

# Rocktier Pic2WebP

**图片转 WebP · $4.99 一次买断 · 本地处理 · 跨平台**

 JPG / PNG / TIFF / GIF / BMP / HEIC → WebP，质量 75-85 通常比原图小 25-50%

[⬇️ 下载](https://github.com/Rocktier/pic2webp/releases) · [📖 文档](#开发--development) · [🐛 反馈](https://github.com/Rocktier/pic2webp/issues)

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
| 🔒 **本地处理** | 图片永不上传；断网可用，网络请求见「隐私」 |
| 🌐 **中英双语** | 自动检测系统语言，一键切换 |
| 🍎 **macOS 11+** | · | **Windows 10+** |

## ⬇️ 下载

前往 [Releases](https://github.com/Rocktier/pic2webp/releases) 下载对应平台的安装包。

| 平台 | 安装包 | 大小 |
|------|--------|------|
| macOS (Apple Silicon / Intel) | `.dmg` | ~5 MB |
| Windows (x64) | `.exe` (NSIS) | ~5 MB |

### 首次打开

**macOS**：右键点击 App 选「打开」即可。Gatekeeper 会提示「无法验证开发者」，点「仍要打开」继续。

**Windows**：⚠️ 首次运行 SmartScreen 可能提示「已保护你的电脑」，点击「更多信息」→「仍要运行」即可。这是未购买代码签名证书的正常现象，软件本身完全安全。

## 开发

### 前提条件

- [Rust](https://rustup.rs/) 1.70+
- [Node.js](https://nodejs.org/) 18+
- 可选：[ffmpeg](https://ffmpeg.org/) —— 仅在把 GIF 动图转成动画 WebP 时需要；其余格式无需任何外部工具

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

转换全在本机完成。图片、文件名、路径一概不上传；没有遥测、账号、云组件，也没有广告 SDK。

**网络请求（仅官网直发版）**

| 请求 | 触发 | 发送内容 |
|---|---|---|
| `POST https://rocktier.com/api/activate` | 输入激活码 | `code`、用于设备数限制的指纹、`os` |
| `GET https://rocktier.com/api/revalidate?txn=...` | 已有回执时点「检查更新」 | 回执里本就有的交易号 |
| `GET https://api.github.com/repos/Rocktier/pic2webp/releases/latest` | 点「检查更新」 | 无自定义字段，公开 API，不带 body 或 query |

三个请求都不含图片数据、文件名或路径，也不会在启动或后台自动发生。全家族口径见[隐私政策](https://rocktier.com/privacy)。

**Mac App Store 版**：购买由 Apple 处理，没有激活码、没有登录、没有试用。商店渠道（`ROCKTIER_CHANNEL=store`）不构建含「检查更新 / 官方网站」的 Help 菜单，上面三个请求都没有可触发入口，这个版本运行时不发起任何网络请求。

## 📄 协议

[MIT](LICENSE)

---

# English

<div align="center">

**JPG / PNG / TIFF / GIF / BMP / HEIC → WebP converter · $4.99 one-time purchase · Local · Cross-platform**

Reduce image size by 25-50% at quality 75-85

[⬇️ Download](https://github.com/Rocktier/pic2webp/releases) · [📖 Docs](#development) · [🐛 Issues](https://github.com/Rocktier/pic2webp/issues)

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
| 🔒 **Local by default** | Images never uploaded; works offline, see Privacy for the request list |
| 🌐 **Bilingual** | Auto-detect system language, one-click toggle |
| 🍎 **macOS 11+** | · | **Windows 10+** |

## ⬇️ Download

Get the latest release from [Releases](https://github.com/Rocktier/pic2webp/releases).

| Platform | Package | Size |
|----------|---------|------|
| macOS (Apple Silicon / Intel) | `.dmg` | ~5 MB |
| Windows (x64) | `.exe` (NSIS) | ~5 MB |

### First launch

**macOS**: Right-click the app → "Open". Gatekeeper will warn about unverified developer → click "Open anyway".

**Windows**: ⚠️ SmartScreen may show "protected your PC" on first run → click "More info" → "Run anyway". This is normal without a paid code signing certificate — the software is completely safe.

## Development

### Prerequisites

- [Rust](https://rustup.rs/) 1.70+
- [Node.js](https://nodejs.org/) 18+
- Optional: [ffmpeg](https://ffmpeg.org/), needed only to turn an animated GIF into an animated WebP. Every other format works with no external tools
- HEIC/HEIF uses the OS decoder (macOS ImageIO / Windows WIC), never a bundled HEVC codec. Windows needs the free HEIF Image Extensions and HEVC Video Extensions from Microsoft Store; macOS 10.13+ works out of the box

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

All conversion happens on your device. Your images, file names and paths are never uploaded. There is no telemetry, no account, no cloud component, and no advertising SDK.

**Network requests (direct download only)**

| Request | Triggered by | What it sends |
|---|---|---|
| `POST https://rocktier.com/api/activate` | You enter a license code | `code`, a device fingerprint for the activation limit, `os` |
| `GET https://rocktier.com/api/revalidate?txn=...` | You click "Check for updates" while a receipt exists | The transaction id already in that receipt |
| `GET https://api.github.com/repos/Rocktier/pic2webp/releases/latest` | You click "Check for updates" | Nothing custom - a public API with no body or query |

None of these carries image data, file names or paths, and none runs at startup or in the background. See the [privacy policy](https://rocktier.com/privacy) for the family-wide wording.

**Mac App Store build**: your purchase is handled by Apple, so there is no activation code, no sign-in and no trial. The Help menu (which holds "Check for updates" and "Website") is not built in the store channel (`ROCKTIER_CHANNEL=store`), so none of the requests above has a reachable trigger - that build makes no network requests at all.

## 📄 License

[MIT](LICENSE)
