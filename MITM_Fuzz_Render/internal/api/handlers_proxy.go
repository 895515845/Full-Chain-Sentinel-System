package api

import (
	"crypto/tls"
	"encoding/base64"
	"net"
	"net/http"
	"time"
)

type proxyStartRequest struct {
	Listen string `json:"listen"`
}

type proxyConfigRequest struct {
	On bool `json:"on"`
}

type bypassRequest struct {
	Host string `json:"host"`
	On   bool   `json:"on"`
}

type proxyStatusResponse struct {
	Running          bool     `json:"running"`
	Listen           string   `json:"listen"`
	CAReady          bool     `json:"caReady"`
	Captured         int64    `json:"captured"`
	Bypass           []string `json:"bypass"`
	InsecureUpstream bool     `json:"insecureUpstream"`
	CAFingerprint    string   `json:"caFingerprint,omitempty"`
	CASubject        string   `json:"caSubject,omitempty"`
	CANotAfter       string   `json:"caNotAfter,omitempty"`
}

func (s *Server) handleProxyStatus(w http.ResponseWriter, r *http.Request) {
	s.writeJSON(w, http.StatusOK, s.proxyStatus())
}

func (s *Server) proxyStatus() proxyStatusResponse {
	out := proxyStatusResponse{
		Listen:  s.cfg.ProxyListen,
		CAReady: s.ca != nil,
		Bypass:  []string{},
	}
	if s.proxy != nil {
		st := s.proxy.Status()
		out.Running = st.Running
		if st.Listen != "" {
			out.Listen = st.Listen
		}
		out.Captured = st.Captured
		out.Bypass = s.proxy.BypassList()
		out.InsecureUpstream = s.proxy.InsecureUpstream()
	}
	if s.ca != nil {
		out.CAFingerprint = s.ca.Fingerprint()
		out.CASubject = s.ca.Subject()
		out.CANotAfter = s.ca.NotAfter().Format(time.RFC3339)
	}
	return out
}

func (s *Server) handleProxyStart(w http.ResponseWriter, r *http.Request) {
	var in proxyStartRequest
	_ = decodeJSONBody(r, &in) // 空请求体合法
	listen := in.Listen
	if listen == "" {
		listen = s.cfg.ProxyListen
	}
	if err := s.proxy.Start(listen); err != nil {
		s.writeError(w, http.StatusConflict, "conflict", err.Error(), nil)
		return
	}
	s.writeJSON(w, http.StatusOK, s.proxyStatus())
}

func (s *Server) handleProxyStop(w http.ResponseWriter, r *http.Request) {
	if err := s.proxy.Stop(); err != nil {
		s.writeError(w, http.StatusConflict, "conflict", err.Error(), nil)
		return
	}
	s.writeJSON(w, http.StatusOK, s.proxyStatus())
}

func (s *Server) handleProxyInsecure(w http.ResponseWriter, r *http.Request) {
	var in proxyConfigRequest
	if err := decodeJSONBody(r, &in); err != nil {
		s.writeError(w, http.StatusBadRequest, "bad_request", "请求体不合法", nil)
		return
	}
	s.proxy.SetInsecureUpstream(in.On)
	s.writeJSON(w, http.StatusOK, s.proxyStatus())
}

func (s *Server) handleProxyBypass(w http.ResponseWriter, r *http.Request) {
	var in bypassRequest
	if err := decodeJSONBody(r, &in); err != nil || in.Host == "" {
		s.writeError(w, http.StatusBadRequest, "bad_request", "需要 host 字段", nil)
		return
	}
	s.proxy.SetBypass(in.Host, in.On)
	s.writeJSON(w, http.StatusOK, s.proxyStatus())
}

// ---------------------------------------------------------------- CA 下载

func (s *Server) handleProxyCAPEM(w http.ResponseWriter, r *http.Request) {
	s.serveCA(w, "replayd-ca.pem", "application/x-pem-file", s.ca.CAPEM())
}

func (s *Server) handleProxyCACRT(w http.ResponseWriter, r *http.Request) {
	s.serveCA(w, "replayd-ca.crt", "application/x-x509-ca-cert", s.ca.CADER())
}

// handleProxyCAMobileconfig 生成 iOS/macOS 描述文件（包裹 DER 证书的最小 plist）。
func (s *Server) handleProxyCAMobileconfig(w http.ResponseWriter, r *http.Request) {
	b64 := base64.StdEncoding.EncodeToString(s.ca.CADER())
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>replayd-ca</string>
      <key>PayloadContent</key>
      <data>` + b64 + `</data>
      <key>PayloadDescription</key><string>replayd 本地抓包根证书（安装后需在 设置→通用→关于本机→证书信任设置 中手动开启完全信任）</string>
      <key>PayloadDisplayName</key><string>replayd Local CA</string>
      <key>PayloadIdentifier</key><string>dev.replayd.ca</string>
      <key>PayloadOrganization</key><string>replayd</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>7C9DE4F2-3B34-4F55-9A61-replaydca0001</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key><string>replayd Local CA</string>
  <key>PayloadIdentifier</key><string>dev.replayd.ca.profile</string>
  <key>PayloadOrganization</key><string>replayd</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>7C9DE4F2-3B34-4F55-9A61-replaydca0002</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`
	s.serveCA(w, "replayd-ca.mobileconfig", "application/x-apple-aspen-config", []byte(plist))
}

func (s *Server) serveCA(w http.ResponseWriter, filename, contentType string, data []byte) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// ---------------------------------------------------------------- 诊断

type diagnoseResponse struct {
	Trusted      bool     `json:"trusted"`
	Probe        string   `json:"probe"`
	Fingerprint  string   `json:"fingerprint"`
	Subject      string   `json:"subject"`
	NotAfter     string   `json:"notAfter"`
	Instructions []string `json:"instructions"`
}

// handleProxyDiagnose 探测本机系统证书库是否信任我们的 CA：
// 用 leaf 证书起一个一次性本地 TLS 服务，再用**系统证书池**去连它——
// 握手成功即说明系统已安装并信任 replayd CA。
func (s *Server) handleProxyDiagnose(w http.ResponseWriter, r *http.Request) {
	trusted := false
	probe := "未执行"

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err == nil {
		cfg, cerr := s.ca.TLSConfig("127.0.0.1")
		if cerr == nil {
			go func() {
				conn, aerr := ln.Accept()
				if aerr != nil {
					return
				}
				tc := tls.Server(conn, cfg)
				_ = tc.SetDeadline(time.Now().Add(3 * time.Second))
				_ = tc.Handshake()
				_, _ = tc.Write([]byte("ok"))
				_ = tc.Close()
			}()
			dialer := &net.Dialer{Timeout: 3 * time.Second}
			td := &tls.Dialer{NetDialer: dialer, Config: &tls.Config{}} // 空配置 = 系统证书池
			conn, derr := td.DialContext(r.Context(), "tcp", ln.Addr().String())
			if derr == nil {
				trusted = true
				probe = "本机系统证书库已信任 replayd CA"
				_ = conn.Close()
			} else {
				probe = "系统证书库尚未信任 replayd CA: " + derr.Error()
			}
		} else {
			probe = "生成探测证书失败: " + cerr.Error()
		}
		_ = ln.Close()
	}

	s.writeJSON(w, http.StatusOK, diagnoseResponse{
		Trusted:     trusted,
		Probe:       probe,
		Fingerprint: s.ca.Fingerprint(),
		Subject:     s.ca.Subject(),
		NotAfter:    s.ca.NotAfter().Format(time.RFC3339),
		Instructions: []string{
			"Windows（管理员）: certutil -addstore -f ROOT replayd-ca.crt",
			"macOS: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain replayd-ca.crt",
			"Linux (Debian/Ubuntu): sudo cp replayd-ca.crt /usr/local/share/ca-certificates/replayd-ca.crt && sudo update-ca-certificates",
			"Firefox: 设置 → 隐私与安全 → 证书 → 查看证书 → 导入（Firefox 使用独立证书库）",
			"iOS: 安装描述文件后，到 设置 → 通用 → 关于本机 → 证书信任设置 手动开启完全信任",
		},
	})
}

// handleProxyRegenerate 重建 CA（需 confirm）。
func (s *Server) handleProxyRegenerate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Confirm bool `json:"confirm"`
	}
	if err := decodeJSONBody(r, &in); err != nil || !in.Confirm {
		s.writeError(w, http.StatusBadRequest, "bad_request",
			"重建 CA 会使已安装证书失效，需要 {\"confirm\": true}", nil)
		return
	}
	if err := s.ca.Regenerate(); err != nil {
		s.writeError(w, http.StatusInternalServerError, "internal", "重建 CA 失败: "+err.Error(), nil)
		return
	}
	s.writeJSON(w, http.StatusOK, s.proxyStatus())
}
