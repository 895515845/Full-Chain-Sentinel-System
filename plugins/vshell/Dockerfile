# VShell MCP plugin: Go adapter + v_shell API client.
# All images and modules use mainland China mirrors.
ARG GO_IMAGE=docker.1ms.run/library/golang:1.25-alpine
ARG RUNTIME_IMAGE=docker.1ms.run/library/alpine:3.22

FROM ${GO_IMAGE} AS build
ENV GOPROXY=https://goproxy.cn,direct \
	CGO_ENABLED=0
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
COPY internal ./internal
COPY ui ./ui
RUN go build -trimpath -ldflags "-s -w" -o /out/vshell-mcp .

FROM ${RUNTIME_IMAGE}
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /src/ui /app/ui
COPY --from=build /out/vshell-mcp /usr/local/bin/vshell-mcp
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/vshell-mcp /usr/local/bin/entrypoint.sh
WORKDIR /app
ENV PORT=7801
EXPOSE 7801
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
