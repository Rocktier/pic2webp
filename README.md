# Pic2WebP

把 JPG / PNG / WebP 一键压成更小的 WebP，质量 75-85 通常比原图小 25-50%。

跨平台桌面工具，Tauri v2 + Rust，完全离线，无网络请求。

> **[⬇️ 下载最新版](https://github.com/old-Dang/pic2webp/releases)**

## 特性

- 🖼️ **拖拽即用** — 把图片拖到窗口，剩下交给它
- 📁 **递归子目录** — 勾上后整棵目录树一并处理
- 🗑️ **删除源文件** — 转换成功可自动清理原图
- 📊 **实时统计** — 节省了多少 MB、压缩比多少
- 🎯 **质量可调** — 10-100 滑块，建议 75-85
- 🛠️ **原生 WebP 编码** — 内置 libwebp，无需安装 cwebp；jpegoptim / pngquant / oxipng 可选增强
- 🔒 **完全离线** — 不发任何网络请求
- 🌐 **中英双语** — 自动检测系统语言，一键切换
- 🍎 **macOS 11+** · **Windows 10+**

## 下载

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
# 在项目根目录执行

# 安装前端依赖
npm install

# 开发模式（热更新）
npm run tauri dev

# 构建发布版
npm run tauri build
```

### 产物

| 平台 | 路径 |
|---|---|
| macOS | `src-tauri/target/release/bundle/dmg/Pic2WebP_*_aarch64.dmg` |
| Windows | `src-tauri/target/release/bundle/nsis/Pic2WebP_*_x64-setup.exe` |

### 国内镜像加速（可选）

如果下载依赖较慢，可手动配置国内镜像：

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

## 隐私

100% 本地工具。**不收集任何数据，不发起任何网络请求。**

## 协议

[MIT](LICENSE)
