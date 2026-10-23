SHELL := /bin/bash
.DEFAULT_GOAL := help

GO      ?= go
PNPM    ?= pnpm
BIN     := replayd
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo 0.1.0-dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
BUILT   ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT) -X main.buildTime=$(BUILT)
TAGS    := embedui
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

.PHONY: help web build dev run test vet fmt lint dist docker clean

help: ## 显示可用命令
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

web: ## 构建前端（输出到 internal/api/dist）
	cd web && $(PNPM) install --config.confirmModulesPurge=false
	cd web && $(PNPM) build

build: web ## 构建单二进制（内嵌前端）
	CGO_ENABLED=0 $(GO) build -tags $(TAGS) -trimpath -ldflags "$(LDFLAGS)" -o bin/$(BIN) ./cmd/replayd
	@echo "已生成 bin/$(BIN)"

dev: build ## 构建并启动（自动打开浏览器）
	./bin/$(BIN) -open

run: ## 直接运行（不重新构建，前端已内嵌时可用）
	./bin/$(BIN)

test: ## 运行全部 Go 测试
	CGO_ENABLED=0 $(GO) test ./...

vet: ## go vet
	$(GO) vet ./...

fmt: ## 格式化
	gofmt -w $$($(GO) list -f '{{.Dir}}' ./...)

lint: vet ## 静态检查（vet + gofmt 校验）
	@out=$$(gofmt -l $$($(GO) list -f '{{.Dir}}' ./...)); \
	if [ -n "$$out" ]; then echo "以下文件未格式化:"; echo "$$out"; exit 1; fi

dist: web ## 交叉编译六平台产物到 dist/
	@mkdir -p dist
	@for p in $(PLATFORMS); do \
		os=$${p%/*}; arch=$${p#*/}; ext=""; \
		[ "$$os" = "windows" ] && ext=".exe"; \
		echo "  building $$os/$$arch"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch $(GO) build -tags $(TAGS) -trimpath \
			-ldflags "$(LDFLAGS)" -o dist/replayd_$${os}_$${arch}$${ext} ./cmd/replayd || exit 1; \
	done
	@cd dist && (command -v sha256sum >/dev/null && sha256sum * || shasum -a 256 *) > checksums.txt
	@ls -lh dist

docker: ## 构建 Docker 镜像
	docker build -t replayd:dev .

clean: ## 清理构建产物
	rm -rf bin dist internal/api/dist
