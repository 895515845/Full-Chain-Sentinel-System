package cert

import (
	"crypto/tls"
	"crypto/x509"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func newManager(t *testing.T) *Manager {
	t.Helper()
	m, err := Load(t.TempDir())
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return m
}

func TestGenerateAndReload(t *testing.T) {
	dir := t.TempDir()
	m1, err := Load(dir)
	if err != nil {
		t.Fatalf("首次 Load: %v", err)
	}
	if m1.Fingerprint() == "" {
		t.Fatal("指纹不应为空")
	}
	if !m1.NotAfter().After(time.Now().AddDate(9, 0, 0)) {
		t.Errorf("CA 有效期应约 10 年: %v", m1.NotAfter())
	}

	m2, err := Load(dir)
	if err != nil {
		t.Fatalf("二次 Load: %v", err)
	}
	if m1.Fingerprint() != m2.Fingerprint() {
		t.Error("同一数据目录的 CA 应保持不变")
	}

	// key 文件权限必须是 0600
	if info, err := dirStat(dir, caKeyFile); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("ca.key 权限错误: %v", err)
	}
}

func TestLeafHandshakeWithCAPool(t *testing.T) {
	m := newManager(t)

	// 起一个用我们 leaf 证书的本地 TLS 服务
	cfg, err := m.TLSConfig("target.test")
	if err != nil {
		t.Fatalf("TLSConfig: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			tc := tls.Server(conn, cfg)
			_ = tc.Handshake()
			_ = tc.Close()
		}
	}()

	// 用我们的 CA 池校验 → 应握手成功
	dialer := &tls.Dialer{Config: &tls.Config{RootCAs: m.Pool(), ServerName: "target.test"}}
	conn, err := dialer.DialContext(t.Context(), "tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("用 CA 池握手失败: %v", err)
	}
	_ = conn.Close()

	// 用系统池校验 → 必须失败（CA 尚未安装）
	_, err = tls.DialWithDialer(&net.Dialer{Timeout: 2 * time.Second}, "tcp",
		ln.Addr().String(), &tls.Config{ServerName: "target.test"})
	if err == nil {
		t.Fatal("系统池不应信任我们的 CA")
	}
}

func TestLeafCache(t *testing.T) {
	m := newManager(t)
	a, err := m.LeafFor("a.test")
	if err != nil {
		t.Fatal(err)
	}
	a2, _ := m.LeafFor("a.test")
	if a != a2 {
		t.Error("同一 host 应命中缓存（同一指针）")
	}
	b, _ := m.LeafFor("b.test")
	if a == b {
		t.Error("不同 host 证书应不同")
	}
}

func TestLeafForIP(t *testing.T) {
	m := newManager(t)
	leaf, err := m.LeafFor("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(leaf.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(cert.IPAddresses) != 1 || cert.IPAddresses[0].String() != "127.0.0.1" {
		t.Errorf("IP host 应写入 IP SAN: %+v", cert.IPAddresses)
	}
	if len(cert.DNSNames) != 0 {
		t.Errorf("IP host 不应写 DNS SAN: %+v", cert.DNSNames)
	}
}

func TestLRUEviction(t *testing.T) {
	m := newManager(t)
	for i := 0; i < maxLeafs+50; i++ {
		if _, err := m.LeafFor("host" + itoa(i) + ".test"); err != nil {
			t.Fatalf("签发 #%d: %v", i, err)
		}
	}
	m.mu.RLock()
	size := len(m.leafs)
	m.mu.RUnlock()
	if size != maxLeafs {
		t.Errorf("缓存应封顶 %d, got %d", maxLeafs, size)
	}
}

func TestRegenerate(t *testing.T) {
	dir := t.TempDir()
	m1, _ := Load(dir)
	old := m1.Fingerprint()
	if err := m1.Regenerate(); err != nil {
		t.Fatalf("Regenerate: %v", err)
	}
	if m1.Fingerprint() == old {
		t.Error("重建后指纹应变化")
	}
	m2, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if m2.Fingerprint() != m1.Fingerprint() {
		t.Error("重建结果应持久化")
	}
}

func TestLeafWorksWithHTTPServer(t *testing.T) {
	m := newManager(t)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	srv.TLS = func() *tls.Config {
		cfg, err := m.TLSConfig("upstream.test")
		if err != nil {
			t.Fatal(err)
		}
		return cfg
	}()
	srv.StartTLS()
	defer srv.Close()

	// 目标服务自身用我们的 CA —— 模拟 MITM 后的"客户端视角"
	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{RootCAs: m.Pool(), ServerName: "upstream.test"},
		},
	}
	resp, err := client.Get(srv.URL + "/")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("status = %d", resp.StatusCode)
	}
}

func dirStat(dir, name string) (fs.FileInfo, error) {
	return os.Stat(dir + "/" + name)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
