#!/bin/bash
# Pic2WebP - 构建 + ad-hoc 签名
# Tauri 构建完成后，对 DMG 内的 .app 做 ad-hoc codesign，
# 消除 Gatekeeper "已损坏，无法打开" 拦截。
#
# 注：Tauri v2 创建 DMG 后会自动清理 .app，所以需要从 DMG 中提取 .app
#
# 用法: npm run build:release

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

VERSION=$(node -p "require('./package.json').version")
APP_NAME="Pic2WebP.app"

DMG_RW="/tmp/pic2webp-rw.dmg"
DMG_OUT="/tmp/pic2webp-signed.dmg"
SIGNED_APP="${SCRIPT_DIR}/src-tauri/target/release/bundle/macos/${APP_NAME}"

echo "=============================================="
echo "  Pic2WebP 构建 + ad-hoc 签名"
echo "=============================================="
echo ""

# ── Step 1: Tauri build ────────────────────────────────────────
echo "📦 Tauri build..."
npm run tauri build
echo ""

# ── Step 2: 找到 DMG ───────────────────────────────────────────
DMG_IN=$(find "${SCRIPT_DIR}/src-tauri/target/release/bundle/dmg/" -name "*.dmg" -type f 2>/dev/null | head -1)
if [ -z "$DMG_IN" ]; then
    echo "❌ 找不到 DMG 文件"
    ls -la src-tauri/target/release/bundle/dmg/ 2>/dev/null || echo "DMG 目录不存在"
    exit 1
fi
echo "✅ 构建产物: $(basename "$DMG_IN")"

# ── Step 3: 从 DMG 中提取 .app（Tauri v2 构建 DMG 后会清理 .app）──
echo ""
echo "📦 从 DMG 提取 .app..."
EXTRACT_DIR=$(mktemp -d /tmp/pic2webp-extract-XXXXXX)
hdiutil attach "$DMG_IN" -readonly -nobrowse -mountpoint "$EXTRACT_DIR" -quiet
mkdir -p "$(dirname "$SIGNED_APP")"
rm -rf "$SIGNED_APP"
cp -R "${EXTRACT_DIR}/${APP_NAME}" "$SIGNED_APP"
hdiutil detach "$EXTRACT_DIR" -quiet
rm -rf "$EXTRACT_DIR"
echo "   ✅ 已提取: $SIGNED_APP"

# ── Step 4: 对 .app bundle 做 ad-hoc 签名 ─────────────────────
echo "🔏 ad-hoc 签名 .app bundle..."
codesign -s - -fv --deep "$SIGNED_APP" 2>&1
echo "   $(codesign -dvvv "$SIGNED_APP" 2>&1 | grep "Signature=")"

# ── Step 5: 用已签名的 .app 替换 DMG 里的 .app ───────────────
echo ""
echo "📦 重打包 DMG..."
echo "   1/4 转为可写格式..."
hdiutil convert "$DMG_IN" -format UDRW -o "$DMG_RW" -quiet

echo "   2/4 挂载..."
MOUNT_DIR=$(mktemp -d /tmp/pic2webp-rwmount-XXXXXX)
hdiutil attach "$DMG_RW" -readwrite -nobrowse -mountpoint "$MOUNT_DIR" -quiet

echo "   3/4 替换 .app..."
rm -rf "$MOUNT_DIR/${APP_NAME}"
cp -R "$SIGNED_APP" "$MOUNT_DIR/"

echo "   4/4 卸载 + 压缩..."
hdiutil detach "$MOUNT_DIR" -quiet
rm -rf "$MOUNT_DIR"
hdiutil convert "$DMG_RW" -format UDZO -o "$DMG_OUT" -quiet
rm -f "$DMG_RW"

# ── Step 6: 验证 ───────────────────────────────────────────────
echo ""
echo "🔍 验证签名..."
MOUNT_DIR2=$(mktemp -d /tmp/pic2webp-verify-XXXXXX)
hdiutil attach "$DMG_OUT" -readonly -nobrowse -mountpoint "$MOUNT_DIR2" -quiet
codesign -dvvv "${MOUNT_DIR2}/${APP_NAME}" 2>&1 | grep -E "Signature=|Identifier="
hdiutil detach "$MOUNT_DIR2" -quiet
rm -rf "$MOUNT_DIR2"

echo ""
echo "=============================================="
echo "  ✅ 签名完成"
echo "=============================================="
echo "  输入:   $DMG_IN"
echo "  签名后: $DMG_OUT"
echo ""
echo "  签名方式: ad-hoc (codesign -s -)"
echo "  开发者账号: ❌ 不需要"
echo "  费用: 免费"
echo "  效果: 消除 \"已损坏，无法打开\" 提示"
echo ""
