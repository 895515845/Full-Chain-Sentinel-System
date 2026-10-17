# MemShellParty plugin: Spring Boot backend + zero-dependency MCP adapter.
#
# The jar is downloaded at build time so the repository does not carry 72 MB of
# binary. Both the Alpine package mirror and the jar URL can be overridden:
#   docker build \
#     --build-arg APK_MIRROR=mirrors.tuna.tsinghua.edu.cn \
#     --build-arg JAR_URL=https://ghfast.top/https://github.com/... \
#     -t ... .
ARG BASE_IMAGE=node:22-alpine
ARG JAR_URL=https://github.com/ReaJason/MemShellParty/releases/download/v2.10.0/boot-2.10.0.jar

FROM ${BASE_IMAGE}

ARG JAR_URL
ARG APK_MIRROR=dl-cdn.alpinelinux.org

RUN if [ "$APK_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
		sed -i "s|dl-cdn.alpinelinux.org|${APK_MIRROR}|g" /etc/apk/repositories; \
	fi \
	&& apk add --no-cache openjdk21-jre-headless curl \
	&& mkdir -p /app

WORKDIR /app
RUN curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -o app.jar "$JAR_URL" \
	&& test -s app.jar

COPY server.mjs entrypoint.sh ./
COPY ui ./ui

ENV MSP_URL=http://127.0.0.1:18080 \
	PORT=7801 \
	PLUGIN_ARTIFACTS_DIR=/artifacts \
	PLUGIN_DATA_DIR=/data

EXPOSE 7801
ENTRYPOINT ["sh", "/app/entrypoint.sh"]
