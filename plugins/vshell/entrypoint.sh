#!/bin/sh
# Map plugin config to vshell-mcp flags. The plugin host prefixes every config
# key with PLUGIN_ (PLUGIN_VSHELL_URL, ...), so read that first; the bare names
# are kept for manual docker runs.
set -eu

url="${PLUGIN_VSHELL_URL:-${VSHELL_URL:-}}"
user="${PLUGIN_VSHELL_USERNAME:-${VSHELL_USERNAME:-admin}}"
pass="${PLUGIN_VSHELL_PASSWORD:-${VSHELL_PASSWORD:-}}"
token="${PLUGIN_VSHELL_TOKEN:-${VSHELL_TOKEN:-}}"
prefix="${PLUGIN_VSHELL_API_PREFIX:-${VSHELL_API_PREFIX:-/api}}"
timeout="${PLUGIN_VSHELL_TIMEOUT:-${VSHELL_TIMEOUT:-60}}"

if [ -z "$url" ]; then
	echo "VSHELL_URL 未配置" >&2
	exit 2
fi
url="${url%/}"

set -- -h "$url" -u "$user" -port "${PORT:-7801}" -prefix "$prefix" -timeout "$timeout"

if [ -n "$token" ]; then
	set -- "$@" -token "$token"
else
	if [ -z "$pass" ]; then
		echo "VSHELL_PASSWORD 或 VSHELL_TOKEN 至少配置一个" >&2
		exit 2
	fi
	set -- "$@" -p "$pass"
fi

exec /usr/local/bin/vshell-mcp "$@"
