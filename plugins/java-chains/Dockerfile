# Java Chains MCP plugin: Java Chains CLI + Go streamable-HTTP adapter.
# The CLI jar is fetched at build time; it is ~180MB, so the first install is slow.
ARG GO_IMAGE=docker.1ms.run/library/golang:1.25-alpine
ARG RUNTIME_IMAGE=docker.1ms.run/library/eclipse-temurin:8-jre-jammy
ARG CHAINS_CLI_URL=https://gh-proxy.com/https://github.com/vulhub/java-chains/releases/download/v2.0.0-beta7/java-chains-cli-2.0.0-beta7.tar.gz

FROM ${GO_IMAGE} AS build
ENV GOPROXY=https://goproxy.cn,direct \
	CGO_ENABLED=0
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
COPY internal ./internal
RUN go build -trimpath -ldflags "-s -w" -o /out/chains-adapter .

FROM ${RUNTIME_IMAGE}
ARG CHAINS_CLI_URL
RUN set -eu; \
	apt-get update -qq; \
	apt-get install -y -qq --no-install-recommends curl ca-certificates aria2; \
	rm -rf /var/lib/apt/lists/*; \
	mkdir -p /chains; \
	aria2c --allow-overwrite=true --auto-file-renaming=false --file-allocation=none -x 8 -s 8 -k 1M -d /tmp -o chains-cli.tar.gz "${CHAINS_CLI_URL}" || \
		curl -#fL --retry 5 --retry-delay 3 --connect-timeout 20 -o /tmp/chains-cli.tar.gz "${CHAINS_CLI_URL}"; \
	tar xzf /tmp/chains-cli.tar.gz -C /chains; \
	rm -f /tmp/chains-cli.tar.gz; \
	if [ ! -s /chains/java-chains-cli.jar ]; then \
		jar="$(find /chains -name 'java-chains-cli*.jar' -type f | head -n 1)"; \
		test -n "$jar"; \
		ln -s "$jar" /chains/java-chains-cli.jar; \
	fi; \
	test -s /chains/java-chains-cli.jar
WORKDIR /app
COPY --from=build /out/chains-adapter /usr/local/bin/chains-adapter
COPY ui /app/ui
ENV CHAINS_JAR=/chains/java-chains-cli.jar \
	PLUGIN_PORT=7801 \
	PLUGIN_ARTIFACTS_DIR=/artifacts \
	PLUGIN_DATA_DIR=/data \
	CHAINS_EXECUTION=local
EXPOSE 7801
ENTRYPOINT ["/usr/local/bin/chains-adapter"]
