#!/usr/bin/env bash
# One command to install and start SentinelBridge over SSH.
#
#   scripts/install-ios.sh root@192.168.1.50 \
#     --url wss://192.168.1.10:9945/ws/ios \
#     --token ios_xxx [--pin SHA256]
#
# The script asks the device for its dpkg architecture to pick the rootful or
# rootless deb, installs it, writes the config, and bootstraps the LaunchDaemon.
# Requires OpenSSH on the device (Sileo: OpenSSH) and the console host to reach
# it on port 22. --with-deps tries to apt-install tcpdump and appinst too
# (best effort; frida-server is not in the repos and is pushed by ios_frida_setup).
# Add --dry-run to only print the commands.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VERSION:-0.1.3}"
TARGET=""
URL=""
TOKEN=""
PIN=""
ARCH="auto"
DRY_RUN=0
WITH_DEPS=0

usage() {
	sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
	exit "${1:-0}"
}

while [ "$#" -gt 0 ]; do
	case "$1" in
	--url)
		URL="${2:-}"
		shift 2
		;;
	--token)
		TOKEN="${2:-}"
		shift 2
		;;
	--pin)
		PIN="${2:-}"
		shift 2
		;;
	--arch)
		ARCH="${2:-}"
		shift 2
		;;
	--dry-run)
		DRY_RUN=1
		shift
		;;
	--with-deps)
		WITH_DEPS=1
		shift
		;;
	-h | --help)
		usage 0
		;;
	-*)
		echo "error: 未知参数 $1" >&2
		usage 2
		;;
	*)
		TARGET="$1"
		shift
		;;
	esac
done

if [ -z "$TARGET" ]; then
	echo "error: 缺少目标，例如 root@192.168.1.50" >&2
	usage 2
fi
if [ -n "$TOKEN" ] && [ -z "$URL" ]; then
	echo "error: 给了 --token 但没给 --url" >&2
	exit 2
fi
if [ -n "$URL" ]; then
	case "$URL" in
	wss://*) ;;
	*) echo "error: iOS 强制 wss，--url 必须是 wss:// 地址" >&2; exit 1 ;;
	esac
fi

ensure_artifact() {
	if [ "$ARCH" = "auto" ]; then
		# Layout beats architecture: rootless devices mount /var/jb, rootful ones
		# keep /usr/bin. (A rootful iOS 27 VM can report iphoneos-arm64e.)
		local layout
		layout="$(ssh "${SSH_OPTS[@]}" "$TARGET" 'if [ -d /var/jb ]; then echo rootless; else echo rootful; fi' 2>/dev/null || true)"
		case "$layout" in
		rootless | rootful) ARCH="$layout" ;;
		*)
			local detected
			detected="$(ssh "${SSH_OPTS[@]}" "$TARGET" 'dpkg --print-architecture' 2>/dev/null || true)"
			case "$detected" in
			*arm64*) ARCH="rootless" ;;
			*arm*) ARCH="rootful" ;;
			*)
				echo "error: 读不到设备布局/架构；请用 --arch rootless 或 --arch rootful" >&2
				exit 1
				;;
			esac
			;;
		esac
		echo "设备布局：$ARCH"
	fi
	if [ "$ARCH" = "rootless" ]; then
		DEB="$ROOT/build/com.zgsfsec.sentinelbridge_${VERSION}_iphoneos-arm64.deb"
		CONFIG="/var/jb/etc/sentinelbridge.json"
		PLIST="/var/jb/Library/LaunchDaemons/com.zgsfsec.sentinelbridged.plist"
	else
		DEB="$ROOT/build/com.zgsfsec.sentinelbridge_${VERSION}_iphoneos-arm.deb"
		CONFIG="/etc/sentinelbridge.json"
		PLIST="/Library/LaunchDaemons/com.zgsfsec.sentinelbridged.plist"
	fi
	if [ ! -f "$DEB" ]; then
		echo "error: 找不到 $DEB；先运行 scripts/build-ios.sh 与 scripts/build-deb.sh" >&2
		exit 1
	fi
}

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${HOME}/.ssh/known_hosts")

run() {
	if [ "$DRY_RUN" = "1" ]; then
		printf '  ssh %s %q\n' "$TARGET" "$1"
	else
		ssh "${SSH_OPTS[@]}" "$TARGET" "$1"
	fi
}

ensure_artifact

echo "安装 $DEB → $TARGET"
if [ "$DRY_RUN" = "1" ]; then
	printf '  scp %s %s:/tmp/sentinelbridge.deb\n' "$DEB" "$TARGET"
else
	scp "${SSH_OPTS[@]}" "$DEB" "$TARGET:/tmp/sentinelbridge.deb"
fi
run "dpkg -i /tmp/sentinelbridge.deb || dpkg -i --force-architecture /tmp/sentinelbridge.deb"

if [ -n "$URL" ] && [ -n "$TOKEN" ]; then
	JSON="$(printf '{"url":"%s","token":"%s","pinnedCertSha256":"%s"}' "$URL" "$TOKEN" "$PIN")"
	echo "写入配置 $CONFIG"
	run "mkdir -p \"\$(dirname '$CONFIG')\" && printf '%s' '$JSON' > '$CONFIG' && chmod 600 '$CONFIG'"
fi

echo "启动 LaunchDaemon"
run "launchctl bootout system/com.zgsfsec.sentinelbridged 2>/dev/null; launchctl bootstrap system '$PLIST' 2>/dev/null || launchctl load -w '$PLIST' 2>/dev/null; sleep 1; launchctl list | grep sentinelbridge || true; tail -5 /var/log/sentinelbridge.log 2>/dev/null || true"

if [ "$WITH_DEPS" = "1" ]; then
	echo "安装可选依赖（tcpdump / appinst，失败不阻塞）"
	run "if command -v apt-get >/dev/null 2>&1; then apt-get update >/dev/null 2>&1 || true; for pkg in tcpdump appinst; do apt-get install -y --no-install-recommends \"\$pkg\" >/dev/null 2>&1 && echo \"依赖已安装：\$pkg\" || echo \"依赖不可用：\$pkg（可用 Sileo 手动装）\"; done; else echo '设备没有 apt-get，跳过依赖安装'; fi"
fi

if [ -z "$URL" ] || [ -z "$TOKEN" ]; then
	echo
	echo "尚未写入配置：daemon 会进入 setup 模式。"
	echo "在设备 Safari 打开 http://127.0.0.1:9945/setup，输入控制台生成的 6 位配对码。"
	echo "也可以重新执行本脚本并带 --url/--token 直接写配置。"
fi
echo "完成。设备出现在控制台「iOS 设备」页即成功。"
