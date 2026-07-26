# Pic2WebP 构建指南

## macOS

```bash
# 安装依赖
npm install

# 开发模式
npm run tauri dev

# 构建 + ad-hoc 签名（推荐发布）
npm run build:release

# 仅构建，不签名
npm run tauri build
```

构建产物: `src-tauri/target/release/bundle/dmg/Pic2WebP_<version>_aarch64.dmg`

### 签名说明

发布时 `npm run build:release` 会自动对 DMG 内的 `.app` 做 ad-hoc 签名，
消除 Gatekeeper "已损坏，无法打开" 提示，**不需要苹果开发者账号，免费**。

如果想要正式签名（消除"仍要打开"弹窗），需在 `tauri.conf.json` 配置：

```json
"bundle": {
  "macOS": {
    "signing": {
      "apple-id": "your@email.com",
      "team-id": "XXXXXXXXXX"
    }
  }
}
```

## Windows

```powershell
cd pic2webp
npm install
npm run tauri build
```

WebP 编码已内置（libwebp 静态链接），无需下载 cwebp.exe。
构建产物: `src-tauri/target/release/bundle/nsis/Pic2WebP_<version>_x64-setup.exe`
