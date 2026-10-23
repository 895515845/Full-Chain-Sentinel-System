// Package browser 负责找到（必要时下载）、启动并复用一个无头浏览器，
// 供渲染器通过 CDP 驱动。
//
// 解析优先级：REPLAYD_CHROME_PATH → 系统已装 Chrome/Chromium/Edge → 已下载的
// chromium-headless-shell（自动下载，镜像优先）→ 报错并给出可执行提示。
//
// 进程模型：常驻复用（空闲 idleTimeout 后退出），每个渲染任务使用独立的
// BrowserContext 隔离 cookie/缓存，互不串味。
package browser

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/chinaran404/replayd/internal/cdp"
)

// Options 是启动参数。
type Options struct {
	DataDir     string // 下载与 profile 的落地目录
	Log         *slog.Logger
	IdleTimeout time.Duration // 空闲多久关闭浏览器；<=0 用默认 5 分钟
}

// Manager 管理浏览器进程的生命周期。
type Manager struct {
	dataDir     string
	log         *slog.Logger
	idleTimeout time.Duration

	mu       sync.Mutex
	startMu  sync.Mutex
	client   *cdp.Client
	cmd      *exec.Cmd
	profile  string
	wsURL    string
	binPath  string
	binFrom  string
	version  string
	lastUsed time.Time
	idleStop *time.Timer
	starting bool
	contexts map[string]struct{}
}

// New 创建管理器。
func New(opts Options) *Manager {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.IdleTimeout <= 0 {
		opts.IdleTimeout = 5 * time.Minute
	}
	return &Manager{
		dataDir:     opts.DataDir,
		log:         opts.Log,
		idleTimeout: opts.IdleTimeout,
		contexts:    make(map[string]struct{}),
	}
}

// Status 是浏览器状态快照。
type Status struct {
	Available     bool   `json:"available"`
	Source        string `json:"source,omitempty"` // env | system | downloaded
	Path          string `json:"path,omitempty"`
	Running       bool   `json:"running"`
	Version       string `json:"version,omitempty"`
	IdleSeconds   int    `json:"idleSeconds"`
	ActiveContext int    `json:"activeContexts"`
}

// Status 返回当前状态（不触发下载）。
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := Status{
		Path:          m.binPath,
		Source:        m.binFrom,
		Version:       m.version,
		Running:       m.client != nil,
		ActiveContext: len(m.contexts),
	}
	if !st.Running {
		if path, from, err := Resolve(m.dataDir); err == nil {
			st.Available = true
			st.Path, st.Source = path, from
		}
		return st
	}
	st.Available = true
	st.IdleSeconds = int(time.Since(m.lastUsed).Seconds())
	return st
}

// Client 返回可用的 CDP 客户端，必要时启动浏览器。
func (m *Manager) Client(ctx context.Context) (*cdp.Client, error) {
	m.mu.Lock()
	if m.client != nil {
		m.touchLocked()
		client := m.client
		m.mu.Unlock()
		return client, nil
	}
	m.mu.Unlock()

	// 串行化启动，避免并发渲染各起一个浏览器
	m.startMu.Lock()
	defer m.startMu.Unlock()

	m.mu.Lock()
	if m.client != nil {
		m.touchLocked()
		client := m.client
		m.mu.Unlock()
		return client, nil
	}
	m.mu.Unlock()

	return m.start(ctx)
}

func (m *Manager) start(ctx context.Context) (*cdp.Client, error) {
	binPath, from, err := Resolve(m.dataDir)
	if err != nil {
		return nil, err
	}

	profile, err := os.MkdirTemp(filepath.Join(m.dataDir, "browser"), "profile-*")
	if err != nil {
		// 目录可能还不存在
		if mkErr := os.MkdirAll(filepath.Join(m.dataDir, "browser"), 0o700); mkErr == nil {
			profile, err = os.MkdirTemp(filepath.Join(m.dataDir, "browser"), "profile-*")
		}
		if err != nil {
			return nil, fmt.Errorf("browser: 创建临时 profile 失败: %w", err)
		}
	}

	args := launchArgs(profile)
	m.log.Info("启动无头浏览器", "path", binPath, "source", from, "headless", true)
	cmd := exec.Command(binPath, args...)
	cmd.Env = append(os.Environ(), "HOME="+profile)

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("browser: 读取 stderr 失败: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("browser: 读取 stdout 失败: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("browser: 启动失败: %w", err)
	}

	wsCh := make(chan string, 1)
	go scanForWSURL(stderr, wsCh)
	go func() { _, _ = io.Copy(io.Discard, stdout) }()
	go func() {
		if err := cmd.Wait(); err != nil {
			m.log.Debug("浏览器进程退出", "err", err)
		}
		m.mu.Lock()
		m.client = nil
		m.cmd = nil
		m.contexts = make(map[string]struct{})
		m.mu.Unlock()
	}()

	// 等待 DevTools 端点（--remote-debugging-port=0 会打印到 stderr）
	var wsURL string
	select {
	case wsURL = <-wsCh:
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		return nil, errors.New("browser: 30s 内未拿到 DevTools 端点，可能是该可执行文件不支持 --remote-debugging-port")
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		return nil, ctx.Err()
	}

	client, err := cdp.Dial(ctx, wsURL)
	if err != nil {
		_ = cmd.Process.Kill()
		return nil, err
	}

	m.mu.Lock()
	m.client = client
	m.cmd = cmd
	m.profile = profile
	m.wsURL = wsURL
	m.binPath = binPath
	m.binFrom = from
	m.version = probeVersion(cmd.Process.Pid, profile, binPath)
	m.lastUsed = time.Now()
	m.scheduleIdleLocked()
	m.mu.Unlock()

	go func() {
		<-client.Closed()
		m.mu.Lock()
		if m.client == client {
			m.client = nil
			m.contexts = make(map[string]struct{})
		}
		m.mu.Unlock()
	}()

	return client, nil
}

// NewContext 创建一个隔离的 BrowserContext；proxyServer 非空时该上下文的所有
// 流量都会走指定代理（例如我们自己的 MITM 代理）。
func (m *Manager) NewContext(ctx context.Context, proxyServer string) (string, error) {
	client, err := m.Client(ctx)
	if err != nil {
		return "", err
	}
	params := map[string]any{}
	if proxyServer != "" {
		params["proxyServer"] = proxyServer
		// Chrome 默认对回环地址绕过代理（localhost/127.0.0.1），
		// 而攻防演练里内网/本机目标恰恰是主力，所以显式取消回环绕过。
		params["proxyBypassList"] = "<-loopback>"
	}
	var res cdp.CreateBrowserContextResult
	if err := client.Call(ctx, "", "Target.createBrowserContext", params, &res); err != nil {
		// 老版本不支持带代理的上下文：退化为不带代理
		if proxyServer != "" {
			if retryErr := client.Call(ctx, "", "Target.createBrowserContext", map[string]any{}, &res); retryErr != nil {
				return "", fmt.Errorf("browser: 创建浏览器上下文失败: %w", retryErr)
			}
			m.log.Warn("该浏览器不支持按上下文设置代理，已退化为直连", "version", m.Status().Version)
		} else {
			return "", fmt.Errorf("browser: 创建浏览器上下文失败: %w", err)
		}
	}
	m.mu.Lock()
	m.contexts[res.BrowserContextID] = struct{}{}
	m.touchLocked()
	m.mu.Unlock()
	return res.BrowserContextID, nil
}

// DisposeContext 释放上下文。
func (m *Manager) DisposeContext(ctx context.Context, contextID string) {
	client, err := m.Client(ctx)
	if err != nil {
		return
	}
	_ = client.Call(ctx, "", "Target.disposeBrowserContext",
		map[string]any{"browserContextId": contextID}, nil)
	m.mu.Lock()
	delete(m.contexts, contextID)
	m.mu.Unlock()
}

// Install 下载 chrome-headless-shell 到本实例的数据目录（progress 可为 nil）。
func (m *Manager) Install(ctx context.Context, progress func(string)) (string, error) {
	path, err := Install(ctx, m.dataDir, progress)
	if err == nil {
		m.log.Info("已安装无头浏览器", "path", path)
	}
	return path, err
}

// DataDir 返回数据目录。
func (m *Manager) DataDir() string { return m.dataDir }

// Close 关闭浏览器（服务退出时调用）。
func (m *Manager) Close() {
	m.mu.Lock()
	client := m.client
	cmd := m.cmd
	profile := m.profile
	m.client = nil
	m.cmd = nil
	m.contexts = make(map[string]struct{})
	if m.idleStop != nil {
		m.idleStop.Stop()
	}
	m.mu.Unlock()

	if client != nil {
		_ = client.Close()
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	if profile != "" {
		_ = os.RemoveAll(profile) // 用完即焚临时 profile
	}
}

/* -------------------------------------------------------------------------- */
/* 内部                                                                        */
/* -------------------------------------------------------------------------- */

func (m *Manager) touchLocked() {
	m.lastUsed = time.Now()
	m.scheduleIdleLocked()
}

func (m *Manager) scheduleIdleLocked() {
	if m.idleStop != nil {
		m.idleStop.Stop()
	}
	if m.idleTimeout <= 0 {
		return
	}
	m.idleStop = time.AfterFunc(m.idleTimeout, func() {
		m.mu.Lock()
		idle := time.Since(m.lastUsed)
		busy := len(m.contexts) > 0
		m.mu.Unlock()
		if idle < m.idleTimeout || busy {
			return // 有任务在跑或刚被使用，交给下次使用再计时
		}
		m.log.Info("无头浏览器空闲超时，关闭以省资源", "idle", idle.Round(time.Second))
		m.Close()
	})
}

func launchArgs(profile string) []string {
	args := []string{
		"--headless=new",
		"--remote-debugging-port=0",
		"--user-data-dir=" + profile,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		"--disable-extensions",
		"--disable-sync",
		"--disable-translate",
		"--disable-component-update",
		"--mute-audio",
		"--hide-scrollbars",
		"--window-size=1440,900",
	}
	if runtime.GOOS == "linux" {
		args = append(args, "--disable-dev-shm-usage")
		if os.Geteuid() == 0 {
			// 容器里以 root 运行时 Chromium 需要这个开关
			args = append(args, "--no-sandbox")
		}
	}
	return args
}

// scanForWSURL 从浏览器 stderr 里抓 "DevTools listening on ws://..."。
func scanForWSURL(r io.Reader, out chan<- string) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if idx := strings.Index(line, "DevTools listening on ws://"); idx >= 0 {
			url := strings.TrimSpace(line[idx+len("DevTools listening on "):])
			select {
			case out <- url:
			default:
			}
		}
	}
}

// probeVersion 通过 --version 拿到浏览器版本（失败则留空）。
func probeVersion(_ int, _ string, binPath string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, binPath, "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
