//go:build embedui

package api

import (
	"embed"
	"io/fs"
)

// 构建时通过 `-tags embedui` 嵌入前端产物（web/ 构建到 internal/api/dist）。
//
//go:embed all:dist
var embeddedDist embed.FS

func staticFS() (fs.FS, bool) {
	sub, err := fs.Sub(embeddedDist, "dist")
	if err != nil {
		return nil, false
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil, false
	}
	return sub, true
}
