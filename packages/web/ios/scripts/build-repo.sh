#!/usr/bin/env bash
# Build the Sileo repository served by GitHub Pages.
#
#   scripts/build-repo.sh                 # generate docs/repo from build/*.deb
#   scripts/build-repo.sh --build         # build rootless+rootful debs first
#
# The generated tree is static:
#   docs/repo/Packages
#   docs/repo/Release
#   docs/repo/pool/*.deb
#
# Sileo source URL after Pages deploys:
#   https://zgsfsec.github.io/Full-Chain-Sentinel-System/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/../../.." && pwd)"
VERSION="${VERSION:-0.1.0}"
OUT="${OUT:-$REPO_ROOT/docs/repo}"
BUILD=0

while [ "$#" -gt 0 ]; do
	case "$1" in
	--build)
		BUILD=1
		shift
		;;
	--output)
		OUT="${2:?--output 需要目录}"
		shift 2
		;;
	-h | --help)
		sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		echo "error: 未知参数 $1" >&2
		exit 2
		;;
	esac
done

if [ "$BUILD" = "1" ]; then
	(cd "$ROOT" && IOS_MIN=15.0 scripts/build-ios.sh && scripts/build-deb.sh rootless)
	(cd "$ROOT" && IOS_MIN=14.0 scripts/build-ios.sh && scripts/build-deb.sh rootful)
fi

mkdir -p "$OUT/pool"
rm -f "$OUT/Packages" "$OUT/Packages.gz" "$OUT/Release"
: >"$OUT/Packages"

found=0
for arch_glob in iphoneos-arm64 iphoneos-arm; do
	for deb in "$ROOT/build/com.zgsfsec.sentinelbridge_${VERSION}_${arch_glob}.deb"; do
		[ -f "$deb" ] || continue
		found=1
		name="$(basename "$deb")"
		cp "$deb" "$OUT/pool/$name"
		size="$(wc -c <"$deb" | tr -d ' ')"
		size_kb=$((size / 1024))
		sha="$(shasum -a 256 "$deb" | awk '{print $1}')"
		if [ "$arch_glob" = "iphoneos-arm64" ]; then min="15.0"; else min="14.0"; fi
		cat >>"$OUT/Packages" <<CONTROL
Package: com.zgsfsec.sentinelbridge
Name: SentinelBridge
Version: $VERSION
Architecture: $arch_glob
Section: Development
Priority: optional
Maintainer: zgsfsec
Author: zgsfsec
Depends: firmware (>= $min)
Installed-Size: $size_kb
Filename: pool/$name
Size: $size
SHA256: $sha
Description: Root daemon for Full Chain Sentinel iOS testing
CONTROL
		printf '\n' >>"$OUT/Packages"
	done
done
if [ "$found" = "0" ]; then
	echo "error: 没有找到 $ROOT/build/com.zgsfsec.sentinelbridge_${VERSION}_*.deb；先运行 --build" >&2
	exit 1
fi

cat >"$OUT/Release" <<RELEASE
Origin: Full Chain Sentinel
Label: Full Chain Sentinel
Suite: stable
Version: 1.0
Codename: ios
Architectures: iphoneos-arm iphoneos-arm64
Components: main
Description: SentinelBridge packages for Full Chain Sentinel
RELEASE
# Drop the final blank separator; parsers accept it, but keep the file tidy.
perl -0pi -e 's/\n+\z/\n/' "$OUT/Packages"
gzip -9 -c "$OUT/Packages" >"$OUT/Packages.gz"
: >"$OUT/.nojekyll"
cat >"$OUT/index.html" <<HTML
<!doctype html><meta charset="utf-8"><title>Full Chain Sentinel iOS repo</title>
<h1>Full Chain Sentinel iOS repo</h1>
<p>Sileo 添加源：<code>$(python3 - <<'PY'
import os
print(os.environ.get("SILEO_URL", "https://zgsfsec.github.io/Full-Chain-Sentinel-System/"))
PY
)</code></p>
<p>包目录：<a href="Packages">Packages</a></p>
HTML

echo "repo written to $OUT"
echo "Sileo source: ${SILEO_URL:-https://zgsfsec.github.io/Full-Chain-Sentinel-System/}"
