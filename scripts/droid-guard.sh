#!/usr/bin/env bash
#
# DroidBridge guard: keeps the bridge process alive on an emulator that freezes
# or kills it.
#
# MuMu SIGSTOPs the whole app when it decides the app should not be running:
# every thread stops, the TCP connection stays ESTABLISHED, and the console sees
# a device that answers nothing. No code inside the app can undo that — SIGCONT
# has to come from outside, and the emulator freezes the whole package, so a
# second in-app process would be stopped as well. This runs on the host and pokes
# the guest through adb:
#
#   no process, package not force-stopped -> am start-foreground-service
#   process stopped (STAT contains T)     -> kill -CONT
#   package force-stopped (stopped=true)  -> leave it alone, the operator meant it
#
# It cannot prevent the freeze, only cut it to one interval (10s). The console
# holds the other half: `DroidGateway`'s liveness watchdog marks the device
# 无响应 and fails the calls that would otherwise wait out their own timeout.
#
#   scripts/droid-guard.sh             one pass (what launchd runs)
#   scripts/droid-guard.sh --status    print what it sees, change nothing
#   scripts/droid-guard.sh --install   install the launchd agent (every 10s, at login)
#   scripts/droid-guard.sh --uninstall
#
# Env overrides: DROID_GUARD_ADB, DROID_GUARD_SERIAL, DROID_GUARD_PORTS,
# DROID_GUARD_LOG, DROID_GUARD_PKG.
set -u

PKG="${DROID_GUARD_PKG:-com.zgagent.droidbridge}"
SERVICE="$PKG/.DroidService"
LABEL="com.zgagent.droidguard"
LOG="${DROID_GUARD_LOG:-$HOME/Library/Logs/zgagent-droid-guard.log}"
# Marks the current "deliberately not running" episode, see stand_down.
SKIP_MARK="$LOG.stand-down"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# MuMu exposes its guest on these ports; a USB phone needs neither of them.
PORTS="${DROID_GUARD_PORTS:-127.0.0.1:16384 127.0.0.1:5555}"
# launchd hands a job almost no PATH, so adb has to be found explicitly.
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
ADB="${DROID_GUARD_ADB:-$(command -v adb || true)}"
[ -n "$ADB" ] || ADB=/opt/homebrew/bin/adb
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

log() {
	# One line per action; rotate before it can grow forever.
	if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 262144 ]; then
		mv -f "$LOG" "$LOG.1"
	fi
	printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"
}

devices() {
	"$ADB" devices | awk '$2 == "device" { print $1 }'
}

# The serial to talk to. An emulator wins: this guard exists for the emulator
# freeze, and a USB phone plugged in beside it has no root to send SIGCONT with.
resolve_serial() {
	if [ -n "${DROID_GUARD_SERIAL:-}" ]; then
		printf '%s' "$DROID_GUARD_SERIAL"
		return
	fi
	serial="$(devices | grep -m1 '^emulator' || true)"
	[ -n "$serial" ] || serial="$(devices | head -1)"
	if [ -z "$serial" ]; then
		for port in $PORTS; do
			"$ADB" connect "$port" >/dev/null 2>&1
			serial="$(devices | head -1)"
			[ -n "$serial" ] && break
		done
	fi
	printf '%s' "$serial"
}

adb_shell() {
	"$ADB" -s "$serial" shell "$@" 2>/dev/null | tr -d '\r'
}

stopped_flag() {
	adb_shell dumpsys package "$PKG" | grep -m1 -o 'stopped=[a-z]*' | cut -d= -f2
}

# `ps -o STAT=` still prints a blank header line on this toybox, so take the first
# line that carries a field at all.
stat_of() {
	adb_shell ps -o STAT= -p "$1" | awk 'NF { print $1; exit }'
}

# A reason to do nothing, said once per episode rather than once per 10s tick:
# an app left force-stopped overnight must not fill the log with one sentence.
stand_down() {
	[ -f "$SKIP_MARK" ] && return 0
	log "不拉起：$1"
	touch "$SKIP_MARK"
}

guard_pass() {
	# launchd gives a job almost no PATH, so a missing adb has to say so rather
	# than look like a healthy guard with nothing to do.
	[ -x "$ADB" ] || {
		stand_down "找不到 adb（${ADB}）"
		exit 0
	}
	serial="$(resolve_serial)"
	# No emulator and no phone: nothing to guard. Staying silent matters, the log
	# would otherwise gain thousands of lines a day on a machine not running MuMu.
	[ -n "$serial" ] || exit 0

	pid="$(adb_shell pidof "$PKG" | awk '{ print $1 }')"
	if [ -z "$pid" ]; then
		# Restart only when the missing process was not the operator's decision.
		if [ -z "$(adb_shell pm path "$PKG")" ]; then
			stand_down "${PKG} 未安装"
		elif [ "$(stopped_flag)" = "true" ]; then
			stand_down "${PKG} 被 force-stop（操作员主动停止）"
		else
			rm -f "$SKIP_MARK"
			adb_shell am start-foreground-service -n "$SERVICE" >/dev/null
			log "进程不在，已拉起前台服务（${serial}）"
		fi
		return 0
	fi

	rm -f "$SKIP_MARK"
	state="$(stat_of "$pid")"
	case "$state" in
	*T*)
		adb_shell kill -CONT "$pid" >/dev/null
		log "进程 ${pid} 被冻住（STAT=${state}），已 SIGCONT（${serial}）"
		;;
	esac
}

show_status() {
	if [ ! -x "$ADB" ]; then
		echo "找不到 adb：${ADB}"
		return 0
	fi
	serial="$(resolve_serial)"
	if [ -z "$serial" ]; then
		echo "没有 adb 设备（守护进程会在设备出现后自动接管）"
	else
		pid="$(adb_shell pidof "$PKG" | awk '{ print $1 }')"
		if [ -n "$pid" ]; then
			echo "设备 ${serial} · ${PKG} pid=${pid} STAT=$(stat_of "$pid") stopped=$(stopped_flag)"
		else
			echo "设备 ${serial} · ${PKG} 未运行（stopped=$(stopped_flag)）"
		fi
	fi
	echo "adb=${ADB}"
	echo "日志=${LOG}"
	if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
		echo "launchd=已加载"
	else
		echo "launchd=未加载"
	fi
}

install_agent() {
	mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
	cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$SCRIPT_PATH</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StartInterval</key>
	<integer>10</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>$LOG</string>
	<key>StandardErrorPath</key>
	<string>$LOG</string>
</dict>
</plist>
PLIST
	launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
	if ! launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
		echo "加载失败：$PLIST" >&2
		return 1
	fi
	launchctl enable "gui/$(id -u)/$LABEL" >/dev/null 2>&1
	echo "已安装 ${PLIST}（每 10s 一次，登录自启）"
}

uninstall_agent() {
	launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
	rm -f "$PLIST"
	echo "已卸载（日志保留在 ${LOG}）"
}

case "${1:-}" in
--install) install_agent ;;
--uninstall) uninstall_agent ;;
--status) show_status ;;
"" | --run) guard_pass ;;
*)
	echo "用法: $0 [--run|--status|--install|--uninstall]" >&2
	exit 2
	;;
esac
