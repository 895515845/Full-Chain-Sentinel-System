#!/usr/bin/env bash
# Build and sign the arm64 daemon with the iPhoneOS SDK.
#
# Prerequisites: Xcode command line tools and ldid (brew install ldid).
# IOS_MIN=14.0 builds the rootful variant; rootless targets 15.0+.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="0.1.7"
IOS_MIN="${IOS_MIN:-14.0}"
OUT="${OUT:-$ROOT/build}"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$OUT/modulecache}"

if ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
	echo "error: 找不到 iPhoneOS SDK；请安装 Xcode 并运行 xcode-select -p" >&2
	exit 1
fi
SDK="$(xcrun --sdk iphoneos --show-sdk-path)"
mkdir -p "$OUT"
BIN="$OUT/sentinelbridged"

echo "building SentinelBridge $VERSION for arm64 iOS $IOS_MIN"
xcrun --sdk iphoneos swiftc \
	-target "arm64-apple-ios$IOS_MIN" \
	-sdk "$SDK" \
	-O \
	-o "$BIN" \
	Sources/SentinelBridge/*.swift

if [ "${SKIP_SIGN:-0}" = "1" ]; then
	echo "warning: SKIP_SIGN=1, the binary is unsigned" >&2
elif command -v ldid >/dev/null 2>&1; then
	ldid -S"$ROOT/entitlements.plist" "$BIN"
else
	echo "error: 需要 ldid 给 daemon 签 entitlements（brew install ldid），或设置 SKIP_SIGN=1 只做编译验证" >&2
	exit 1
fi

file "$BIN"
echo "built $BIN"
