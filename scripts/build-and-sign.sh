#!/bin/bash
# Rocktier Pic2WebP - 构建 + 签名（+ 有证书时公证）
# Tauri 构建完成后，对 DMG 内的 .app 签名再重打包：
#   · 配了 APPLE_CERT_P12 → Developer ID + 硬化运行时 + entitlements，
#     DMG 再走 notarytool 公证并 staple；
#   · 没配 → ad-hoc，arm64 能加载、不出「已损坏」，但下载副本仍会被
#     Gatekeeper 拦（"无法验证开发者"）。
#
# 注：Tauri v2 创建 DMG 后会自动清理 .app，所以需要从 DMG 中提取 .app
#
# 用法: npm run build:release

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

VERSION=$(node -p "require('./package.json').version")
APP_NAME="Rocktier Pic2WebP.app"

DMG_RW="/tmp/pic2webp-rw.dmg"
DMG_OUT="/tmp/pic2webp-signed.dmg"
SIGNED_APP="${SCRIPT_DIR}/src-tauri/target/release/bundle/macos/${APP_NAME}"

echo "=============================================="
echo "  Rocktier Pic2WebP 构建 + ad-hoc 签名"
echo "=============================================="
echo ""

# ── Step 1: Tauri build ────────────────────────────────────────
echo "📦 Tauri build..."
npm run tauri build
echo ""

# ── Step 2: 找到 DMG ───────────────────────────────────────────
DMG_IN=$(find "${SCRIPT_DIR}/src-tauri/target/release/bundle/dmg/" -name "*.dmg" -type f -print -quit 2>/dev/null)
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

# ── Step 4: 签名 .app bundle ───────────────────────────────────
identity=""
if [ -n "${APPLE_CERT_P12:-}" ]; then
    echo "🔏 Developer ID 签名 .app bundle..."
    WORK_TMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
    keychain="$WORK_TMP/rocktier-signing.keychain-db"
    echo "$APPLE_CERT_P12" | base64 --decode > "$WORK_TMP/cert.p12"
    security create-keychain -p "" "$keychain"
    security set-keychain-settings -lut 21600 "$keychain"
    security unlock-keychain -p "" "$keychain"
    security import "$WORK_TMP/cert.p12" -k "$keychain" \
      -P "${APPLE_CERT_PASSWORD:-}" -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple: -k "" "$keychain" >/dev/null
    security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
    identity=$(security find-identity -v -p codesigning "$keychain" \
      | awk '/Developer ID Application/ {print $2; exit}')
    [ -n "$identity" ] || { echo "❌ APPLE_CERT_P12 里没有 Developer ID Application 身份"; exit 1; }
    echo "   签名身份: $identity"
    codesign -s "$identity" --options runtime --timestamp \
      --entitlements "${SCRIPT_DIR}/src-tauri/Entitlements.plist" -fv --deep "$SIGNED_APP" 2>&1
else
    echo "::notice::No Developer ID certificate configured - ad-hoc signing. Downloaded copies will still be flagged by Gatekeeper."
    codesign -s - -fv --deep "$SIGNED_APP" 2>&1
fi
echo "   $(codesign -dvvv "$SIGNED_APP" 2>&1 | grep "Signature=")"

# 正向校验：签名自洽性（ad-hoc 也跑，失败即退出）
codesign --verify --deep --strict "$SIGNED_APP" || { echo "❌ .app 签名校验失败"; exit 1; }
if [ -n "$identity" ]; then
    # hard assertion：Developer ID + secure timestamp（case 而非 grep，
    # 避免 pipefail 下 codesign 被 SIGPIPE 误判成失败）
    info=$(codesign -dv --verbose=4 "$SIGNED_APP" 2>&1 || true)
    case "$info" in *"Authority=Developer ID Application"*) ;; *)
        echo "❌ .app 未使用 Developer ID Application 签名"; exit 1 ;; esac
    case "$info" in *"Timestamp="*) ;; *)
        echo "❌ .app 签名缺少 secure timestamp"; exit 1 ;; esac
fi

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

# ── Step 7: DMG 签名 + 公证（有 Developer ID 时）──────────────
if [ -n "$identity" ]; then
    echo ""
    echo "🔏 签名 + 公证 DMG（notarytool 可能要等几分钟）..."
    codesign -s "$identity" --timestamp -fv "$DMG_OUT"
    xcrun notarytool submit "$DMG_OUT" \
      --apple-id "${APPLE_ID:-}" --team-id "${APPLE_TEAM_ID:-}" \
      --password "${APPLE_APP_PASSWORD:-}" --wait
    xcrun stapler staple "$DMG_OUT"
    xcrun stapler validate "$DMG_OUT"

    info=$(codesign -dv --verbose=4 "$DMG_OUT" 2>&1 || true)
    case "$info" in *"Authority=Developer ID Application"*) ;; *)
        echo "❌ DMG 缺少 Developer ID Application 权威"; exit 1 ;; esac
    case "$info" in *"Timestamp="*) ;; *)
        echo "❌ DMG 签名缺少 secure timestamp"; exit 1 ;; esac
    # Gatekeeper 兜底：用户双击的就是这个 dmg，必须 accepted
    spctl -a -t open --context context:primary-signature -vv "$DMG_OUT" \
      || { echo "❌ Gatekeeper 拒绝了这个已公证的 DMG"; exit 1; }
else
    codesign -s - -fv "$DMG_OUT"
    echo "::notice::ad-hoc DMG: signature assertions and spctl skipped (by design)."
fi
codesign -dvvv "$DMG_OUT" 2>&1 | grep "Signature=" || true

echo ""
echo "=============================================="
echo "  ✅ 签名完成"
echo "=============================================="
echo "  输入:   $DMG_IN"
echo "  签名后: $DMG_OUT"
echo ""
if [ -n "$identity" ]; then
    echo "  签名方式: Developer ID + 公证（$identity）"
    echo "  效果: 从浏览器下载的副本可直接打开，不再被 Gatekeeper 拦"
else
    echo "  签名方式: ad-hoc (codesign -s -)"
    echo "  效果: 本机不报「已损坏，无法打开」；从浏览器下载的副本仍会被"
    echo "        Gatekeeper 拦（未签名开发者），需右键「打开」或 xattr -cr"
    echo "  要真正消除拦截: 提供 APPLE_CERT_P12 / APPLE_CERT_PASSWORD /"
    echo "        APPLE_ID / APPLE_TEAM_ID / APPLE_APP_PASSWORD 后重跑"
fi
echo ""
