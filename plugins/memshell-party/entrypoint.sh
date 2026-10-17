#!/bin/sh
# MemShellParty + MCP adapter in one container.
#   :18080  MemShellParty (loopback only, never published)
#   :7801   MCP adapter + UI + /healthz (the plugin port)
set -u

PARTY_PID=""
ADAPTER_PID=""

JAVA_OPTS="${JAVA_OPTS:-} -Djava.security.egd=file:/dev/./urandom -Dfastjson.parser.safeMode=true"
JAVA_OPTS="$JAVA_OPTS --add-opens=java.base/java.util=ALL-UNNAMED"
JAVA_OPTS="$JAVA_OPTS --add-opens=java.xml/com.sun.org.apache.xalan.internal.xsltc.trax=ALL-UNNAMED"
JAVA_OPTS="$JAVA_OPTS --add-opens=java.xml/com.sun.org.apache.xalan.internal.xsltc.runtime=ALL-UNNAMED"

# shellcheck disable=SC2086
java $JAVA_OPTS -jar /app/app.jar --server.port=18080 &
PARTY_PID=$!

node /app/server.mjs &
ADAPTER_PID=$!

term() {
	[ -n "$PARTY_PID" ] && kill "$PARTY_PID" 2>/dev/null
	[ -n "$ADAPTER_PID" ] && kill "$ADAPTER_PID" 2>/dev/null
}
trap term TERM INT

wait "$ADAPTER_PID"
term
