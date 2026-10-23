// Package cert 管理 replayd 的本地 CA 与按 host 动态签发的 MITM 叶子证书。
//
// 设计要点（docs/PLAN.md §4.2）：
//   - Root CA：ECDSA P-256，有效期 10 年，私钥 0600 存数据目录 ca/ 下；
//   - Leaf：per-host 动态签发，SAN 含 DNS（与 IP，若 host 是 IP），
//     LRU 缓存 1000 张，避免每次握手都做签名运算；
//   - 握手路径上不做磁盘 IO：CA 与叶子全部常驻内存。
package cert

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	caCertFile = "ca.crt"
	caKeyFile  = "ca.key"
	leafTTL    = 825 * 24 * time.Hour // 与公共 CA 上限一致，兼容最挑剔的客户端
	maxLeafs   = 1000
)

// Manager 持有 CA 并签发叶子证书。
type Manager struct {
	dir string

	mu       sync.RWMutex
	caCert   *x509.Certificate
	caKey    *ecdsa.PrivateKey
	caPEM    []byte
	leafs    map[string]*tls.Certificate
	lruOrder []string // 简易 LRU：尾部最新
}

// Load 打开（必要时生成）数据目录 ca/ 下的 CA。
func Load(dir string) (*Manager, error) {
	m := &Manager{
		dir:   dir,
		leafs: make(map[string]*tls.Certificate),
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("cert: 创建 CA 目录失败: %w", err)
	}
	certPath := filepath.Join(dir, caCertFile)
	keyPath := filepath.Join(dir, caKeyFile)

	certPEM, errCert := os.ReadFile(certPath)
	keyPEM, errKey := os.ReadFile(keyPath)
	switch {
	case errCert == nil && errKey == nil:
		if err := m.load(certPEM, keyPEM); err != nil {
			return nil, err
		}
		return m, nil
	case errors.Is(errCert, os.ErrNotExist) && errors.Is(errKey, os.ErrNotExist):
		if err := m.generate(); err != nil {
			return nil, err
		}
		if err := m.persist(certPath, keyPath); err != nil {
			return nil, err
		}
		return m, nil
	default:
		return nil, fmt.Errorf("cert: 读取 CA 失败: cert=%v key=%v", errCert, errKey)
	}
}

// load 从 PEM 装入已有 CA。
func (m *Manager) load(certPEM, keyPEM []byte) error {
	block, _ := pem.Decode(certPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return errors.New("cert: ca.crt 不是合法 PEM 证书")
	}
	ca, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return fmt.Errorf("cert: 解析 ca.crt 失败: %w", err)
	}
	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return errors.New("cert: ca.key 不是合法 PEM 私钥")
	}
	key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		return fmt.Errorf("cert: 解析 ca.key 失败: %w", err)
	}
	if !ca.IsCA {
		return errors.New("cert: ca.crt 不是 CA 证书")
	}
	m.caCert, m.caKey, m.caPEM = ca, key, certPEM
	return nil
}

// generate 新建自签 CA。
func (m *Manager) generate() error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("cert: 生成 CA 私钥失败: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return err
	}
	tpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "replayd Local CA", Organization: []string{"replayd"}},
		NotBefore:             time.Now().Add(-24 * time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            1,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return fmt.Errorf("cert: 自签 CA 失败: %w", err)
	}
	ca, err := x509.ParseCertificate(der)
	if err != nil {
		return fmt.Errorf("cert: 解析自签 CA 失败: %w", err)
	}
	m.caCert, m.caKey = ca, key
	m.caPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	return nil
}

func (m *Manager) persist(certPath, keyPath string) error {
	keyDER, err := x509.MarshalECPrivateKey(m.caKey)
	if err != nil {
		return fmt.Errorf("cert: 序列化 CA 私钥失败: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(filepath.Join(m.dir, caCertFile), m.caPEM, 0o644); err != nil {
		return fmt.Errorf("cert: 写入 ca.crt 失败: %w", err)
	}
	if err := os.WriteFile(filepath.Join(m.dir, caKeyFile), keyPEM, 0o600); err != nil {
		return fmt.Errorf("cert: 写入 ca.key 失败: %w", err)
	}
	_ = certPath
	return nil
}

// LeafFor 返回 host 专用的 TLS 证书（缓存命中则直接复用）。
func (m *Manager) LeafFor(host string) (*tls.Certificate, error) {
	m.mu.RLock()
	if leaf, ok := m.leafs[host]; ok {
		m.mu.RUnlock()
		return leaf, nil
	}
	m.mu.RUnlock()

	m.mu.Lock()
	defer m.mu.Unlock()
	if leaf, ok := m.leafs[host]; ok { // 双检
		return leaf, nil
	}
	leaf, err := m.signLeaf(host)
	if err != nil {
		return nil, err
	}
	if len(m.lruOrder) >= maxLeafs {
		oldest := m.lruOrder[0]
		m.lruOrder = m.lruOrder[1:]
		delete(m.leafs, oldest)
	}
	m.leafs[host] = leaf
	m.lruOrder = append(m.lruOrder, host)
	return leaf, nil
}

// TLSConfig 返回用于指定 host 的服务端握手配置。
func (m *Manager) TLSConfig(host string) (*tls.Config, error) {
	leaf, err := m.LeafFor(host)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{*leaf},
		NextProtos:   []string{"http/1.1"}, // v1 不做 h2 MITM，浏览器会自动回退
		MinVersion:   tls.VersionTLS12,
	}, nil
}

func (m *Manager) signLeaf(host string) (*tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("cert: 生成叶子私钥失败: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, err
	}
	tpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: host, Organization: []string{"replayd"}},
		NotBefore:    time.Now().Add(-1 * time.Hour),
		NotAfter:     time.Now().Add(leafTTL),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if ip := net.ParseIP(host); ip != nil {
		tpl.IPAddresses = []net.IP{ip}
	} else {
		tpl.DNSNames = []string{host}
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, m.caCert, &key.PublicKey, m.caKey)
	if err != nil {
		return nil, fmt.Errorf("cert: 签发叶子证书失败: %w", err)
	}
	leafPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	pair, err := tls.X509KeyPair(leafPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("cert: 装载叶子证书对失败: %w", err)
	}
	return &pair, nil
}

// CADER 返回 CA 证书 DER。
func (m *Manager) CADER() []byte { return m.caCert.Raw }

// CAPEM 返回 CA 证书 PEM。
func (m *Manager) CAPEM() []byte { return m.caPEM }

// Fingerprint 返回 CA 证书 SHA-256 指纹（冒号分隔的大写 hex）。
func (m *Manager) Fingerprint() string {
	sum := sha256.Sum256(m.caCert.Raw)
	out := make([]string, 0, len(sum))
	for _, b := range sum {
		out = append(out, fmt.Sprintf("%02X", b))
	}
	return strings.Join(out, ":")
}

// Subject 返回 CA 主题。
func (m *Manager) Subject() string { return m.caCert.Subject.String() }

// NotAfter 返回 CA 过期时间。
func (m *Manager) NotAfter() time.Time { return m.caCert.NotAfter }

// Pool 返回仅含本 CA 的校验池（诊断用）。
func (m *Manager) Pool() *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(m.caCert)
	return pool
}

// Regenerate 撤销并重建 CA（清空叶子缓存）。
func (m *Manager) Regenerate() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.generate(); err != nil {
		return err
	}
	if err := m.persist(filepath.Join(m.dir, caCertFile), filepath.Join(m.dir, caKeyFile)); err != nil {
		return err
	}
	m.leafs = make(map[string]*tls.Certificate)
	m.lruOrder = nil
	return nil
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	n, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, fmt.Errorf("cert: 生成序列号失败: %w", err)
	}
	return n, nil
}
