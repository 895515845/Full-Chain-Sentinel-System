//go:build !embedui

package api

import "io/fs"

// 未带 embedui 标签构建时（如 `go build ./...`、单元测试），不嵌入前端，
// 由 serveFallback 返回构建指引页面。这样新克隆的仓库无需先构建前端即可编译。
func staticFS() (fs.FS, bool) { return nil, false }
