package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	sessionCookie = "replayd_session"
	sessionTTL    = 30 * 24 * time.Hour
	// sessionContext 标记本次请求的鉴权方式（cookie / bearer / query）。
	sessionContext key = "replayd.auth.via"
)

type key string

type authVia string

func sessionValue(token string) string {
	m := hmac.New(sha256.New, []byte(token))
	_, _ = m.Write([]byte("replayd/session/v1"))
	return hex.EncodeToString(m.Sum(nil))
}

func (s *Server) tokenEqual(got string) bool {
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.Token)) == 1
}

func (s *Server) sessionEqual(got string) bool {
	return subtle.ConstantTimeCompare([]byte(got), []byte(sessionValue(s.cfg.Token))) == 1
}

// authenticate 校验 Bearer / cookie / query token，并对 cookie 鉴权的写请求做同源校验。
func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		via := authVia("")

		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			if s.tokenEqual(strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))) {
				via = "bearer"
			}
		}
		if via == "" {
			if c, err := r.Cookie(sessionCookie); err == nil && s.sessionEqual(c.Value) {
				via = "cookie"
			}
		}
		if via == "" {
			if t := r.URL.Query().Get("token"); t != "" && s.tokenEqual(t) {
				via = "query"
			}
		}
		if via == "" {
			s.writeError(w, http.StatusUnauthorized, "unauthorized", "需要访问令牌：请使用启动日志中的 URL 打开界面", nil)
			return
		}
		if via == "cookie" && !isSafeMethod(r.Method) && !sameOrigin(r) {
			s.writeError(w, http.StatusForbidden, "forbidden", "跨站请求被拒绝（Origin 校验失败）", nil)
			return
		}

		ctx := context.WithValue(r.Context(), sessionContext, via)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func isSafeMethod(m string) bool {
	switch m {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	}
	return false
}

// sameOrigin 放宽处理：浏览器发起的跨站写请求一定带 Origin；
// 不带 Origin 的视为非浏览器客户端（curl/CLI/Agent），放行。
func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// loginLimiter 限制 token 猜测：每 IP 每分钟最多 10 次失败。
type loginLimiter struct {
	mu   sync.Mutex
	fail map[string]*failWindow
	now  func() time.Time
}

type failWindow struct {
	count int
	until time.Time
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{fail: make(map[string]*failWindow), now: time.Now}
}

func (l *loginLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.fail[ip]
	if !ok {
		return true
	}
	if l.now().After(w.until) {
		delete(l.fail, ip)
		return true
	}
	return w.count < 10
}

func (l *loginLimiter) failed(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.fail[ip]
	if !ok || l.now().After(w.until) {
		l.fail[ip] = &failWindow{count: 1, until: l.now().Add(time.Minute)}
		return
	}
	w.count++
}

func (l *loginLimiter) succeeded(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.fail, ip)
}
