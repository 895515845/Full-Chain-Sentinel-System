# syntax=docker/dockerfile:1

# ---------- 前端 ----------
FROM node:22-alpine AS web
WORKDIR /app/web
# 依赖层单独缓存：package.json / lock 变化才重新安装
COPY web/package.json web/pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile 2>/dev/null || pnpm install
COPY web/ ./
RUN pnpm build

# ---------- 后端 ----------
FROM golang:1.24-alpine AS builder
WORKDIR /src
ARG VERSION=0.1.0
ARG COMMIT=none
ARG BUILD_TIME=unknown

COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /app/internal/api/dist ./internal/api/dist

RUN CGO_ENABLED=0 go build -tags embedui -trimpath \
    -ldflags "-s -w -X main.version=${VERSION} -X main.commit=${COMMIT} -X main.buildTime=${BUILD_TIME}" \
    -o /out/replayd ./cmd/replayd

# ---------- 运行 ----------
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -H -u 10001 replayd \
 && mkdir -p /data && chown replayd:replayd /data

COPY --from=builder /out/replayd /usr/local/bin/replayd

USER replayd
ENV REPLAYD_LISTEN=0.0.0.0:8899 \
    REPLAYD_DATA_DIR=/data \
    REPLAYD_LOG_FORMAT=json \
    REPLAYD_QUIET=false

VOLUME ["/data"]
EXPOSE 8899 8898

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8899/api/health >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/replayd"]
