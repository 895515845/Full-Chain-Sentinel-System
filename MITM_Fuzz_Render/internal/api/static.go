package api

import (
	"io"
	"net/http"
	"path"
	"strings"
)

// handleStatic 提供 SPA 静态资源，并处理 `/?token=` 首次引导。
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if isAPIPath(r.URL.Path) {
		s.writeError(w, http.StatusNotFound, "not_found", "接口不存在", r.URL.Path)
		return
	}

	// 首次引导：/?token=xxx → 种 cookie → 跳回干净 URL。
	if t := r.URL.Query().Get("token"); t != "" {
		if !s.tokenEqual(t) {
			s.writeError(w, http.StatusUnauthorized, "unauthorized", "令牌无效", nil)
			return
		}
		http.SetCookie(w, s.newSessionCookie(r))
		q := r.URL.Query()
		q.Del("token")
		target := r.URL.Path
		if enc := q.Encode(); enc != "" {
			target += "?" + enc
		}
		http.Redirect(w, r, target, http.StatusFound)
		return
	}

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		s.writeError(w, http.StatusMethodNotAllowed, "bad_request", "方法不允许", nil)
		return
	}

	fsys, ok := staticFS()
	if !ok {
		s.serveFallback(w, r)
		return
	}

	rel := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if rel == "" {
		rel = "index.html"
	}

	f, err := fsys.Open(rel)
	if err == nil {
		if info, statErr := f.Stat(); statErr == nil && info.IsDir() {
			_ = f.Close()
			rel = path.Join(rel, "index.html")
			f, err = fsys.Open(rel)
		}
	}
	if err != nil {
		// 带扩展名说明是资源请求，缺了就 404；否则交给 SPA 路由。
		if path.Ext(rel) != "" {
			http.NotFound(w, r)
			return
		}
		rel = "index.html"
		f, err = fsys.Open(rel)
		if err != nil {
			s.serveFallback(w, r)
			return
		}
	}
	defer func() { _ = f.Close() }()

	info, err := f.Stat()
	if err != nil {
		s.serveFallback(w, r)
		return
	}
	seeker, ok := f.(io.ReadSeeker)
	if !ok {
		s.serveFallback(w, r)
		return
	}

	if strings.HasPrefix(rel, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, rel, info.ModTime(), seeker)
}

// serveFallback 在未嵌入前端时给出可执行的指引，而不是空白页。
func (s *Server) serveFallback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, fallbackHTML)
}

const fallbackHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>replayd · 前端未构建</title>
<style>
  html,body{height:100%;margin:0}
  body{background:#0b0f14;color:#e5e7eb;font:14px/1.7 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
       display:flex;align-items:center;justify-content:center;padding:32px}
  main{max-width:620px;border:1px solid #1f2a37;background:#111823;border-radius:8px;padding:28px 32px}
  h1{font-size:18px;margin:0 0 6px;color:#34d399}
  p{color:#94a3b8;margin:8px 0}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#0e141d;border:1px solid #1f2a37;
       border-radius:4px;padding:2px 6px;color:#e5e7eb}
  pre{background:#0e141d;border:1px solid #1f2a37;border-radius:6px;padding:12px;overflow:auto}
  a{color:#34d399}
</style>
</head>
<body>
<main data-testid="ui-not-built">
  <h1>replayd 已启动，但前端资源尚未构建</h1>
  <p>后端 API 已可用，可先访问 <a href="/api/health">/api/health</a> 验证。</p>
  <p>构建前端：</p>
  <pre>cd web
pnpm install
pnpm build
cd ..
make build</pre>
  <p>或者直接运行 <code>make dev</code>（构建 + 启动一条命令）。</p>
</main>
</body>
</html>
`
