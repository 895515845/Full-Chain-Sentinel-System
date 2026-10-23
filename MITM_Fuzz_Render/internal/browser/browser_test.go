package browser

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// writeExecutable 造一个可执行文件（内容不重要，只要权限位对）。
func writeExecutable(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestResolvePriority(t *testing.T) {
	dataDir := t.TempDir()

	// 1) 环境变量优先
	envPath := filepath.Join(t.TempDir(), "my-chrome")
	writeExecutable(t, envPath)
	t.Setenv("REPLAYD_CHROME_PATH", envPath)
	got, source, err := Resolve(dataDir)
	if err != nil || got != envPath || source != "env" {
		t.Fatalf("环境变量优先失败: %q %q %v", got, source, err)
	}

	// 2) 环境变量指向不存在的文件 → 明确报错（而不是静默换别的）
	t.Setenv("REPLAYD_CHROME_PATH", filepath.Join(dataDir, "nope"))
	if _, _, err := Resolve(dataDir); err == nil {
		t.Error("环境变量非法时应报错")
	}

	// 3) 没有环境变量时：按设计「系统浏览器优先于下载版」
	t.Setenv("REPLAYD_CHROME_PATH", "")
	name := binaryName()
	downloaded := filepath.Join(dataDir, "browser", "chrome-headless-shell-999.0.0-test", "chrome-headless-shell-"+runtime.GOOS, name)
	writeExecutable(t, downloaded)

	got, source, err = Resolve(dataDir)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	switch source {
	case "system":
		// 本机装了 Chrome，按设计应优先使用；同时确认下载版能被发现
		if found, ok := findDownloaded(dataDir); !ok || found != downloaded {
			t.Errorf("下载版应可被发现: %q ok=%v", found, ok)
		}
	case "downloaded":
		if got != downloaded {
			t.Errorf("路径不对: %q != %q", got, downloaded)
		}
	default:
		t.Errorf("来源意外: %q (%s)", got, source)
	}
}

func TestResolveMissingBrowser(t *testing.T) {
	t.Setenv("REPLAYD_CHROME_PATH", "")
	// 用一个空数据目录；若本机确实装了 Chrome，这里会命中 system，则跳过断言
	path, source, err := Resolve(t.TempDir())
	if err == nil {
		if source != "system" {
			t.Errorf("应为 system 来源, got %q (%s)", source, path)
		}
		t.Skip("本机装有系统浏览器，跳过缺失断言")
	}
	if !strings.Contains(err.Error(), "REPLAYD_CHROME_PATH") {
		t.Errorf("错误信息应给出可执行的解决方式: %v", err)
	}
}

func TestExtractZip(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	dir := &zip.FileHeader{Name: "chrome-headless-shell-linux64/"}
	dir.SetMode(os.ModeDir | 0o755)
	if _, err := zw.CreateHeader(dir); err != nil {
		t.Fatal(err)
	}

	header := &zip.FileHeader{Name: "chrome-headless-shell-linux64/" + binaryName()}
	header.SetMode(0o755)
	entry, err := zw.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte("fake-binary")); err != nil {
		t.Fatal(err)
	}

	readme, err := zw.Create("chrome-headless-shell-linux64/README")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readme.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	zipPath := filepath.Join(t.TempDir(), "pkg.zip")
	if err := os.WriteFile(zipPath, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	dest := filepath.Join(t.TempDir(), "out")
	binPath, err := extractZip(zipPath, dest)
	if err != nil {
		t.Fatalf("extractZip: %v", err)
	}
	if filepath.Base(binPath) != binaryName() {
		t.Errorf("应返回二进制路径, got %q", binPath)
	}
	data, err := os.ReadFile(binPath)
	if err != nil || string(data) != "fake-binary" {
		t.Errorf("解压内容不对: %q %v", data, err)
	}
	if info, err := os.Stat(binPath); err != nil || info.Mode().Perm()&0o111 == 0 {
		t.Errorf("可执行位应保留: %v", info.Mode())
	}
}

func TestExtractZipRejectsTraversal(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	evil, err := zw.Create("../evil.sh")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := evil.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	zipPath := filepath.Join(t.TempDir(), "evil.zip")
	if err := os.WriteFile(zipPath, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := extractZip(zipPath, filepath.Join(t.TempDir(), "out")); err == nil {
		t.Fatal("含 ../ 的压缩包应被拒绝")
	}
}

func TestFindDownloadedPicksNewest(t *testing.T) {
	dataDir := t.TempDir()
	name := binaryName()
	older := filepath.Join(dataDir, "browser", "chrome-headless-shell-100", name)
	newer := filepath.Join(dataDir, "browser", "chrome-headless-shell-200", name)
	writeExecutable(t, older)
	writeExecutable(t, newer)

	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(older, past, past); err != nil {
		t.Fatal(err)
	}
	got, ok := findDownloaded(dataDir)
	if !ok || got != newer {
		t.Errorf("应选最新的下载版本: %q (ok=%v)", got, ok)
	}

	// 空目录
	if _, ok := findDownloaded(t.TempDir()); ok {
		t.Error("空目录不应命中")
	}
}

func TestPlatformKey(t *testing.T) {
	key, err := platformKey()
	switch runtime.GOOS {
	case "darwin", "linux", "windows":
		if err != nil || key == "" {
			t.Fatalf("应返回平台标识: %q %v", key, err)
		}
	default:
		if err == nil {
			t.Errorf("不支持的平台应报错，实际 %q", key)
		}
	}
}

func TestBinariesWithoutChrome(t *testing.T) {
	// --version 失败时必须报错（避免把非浏览器可执行文件当成浏览器用）
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	notBrowser := filepath.Join(t.TempDir(), "not-a-browser")
	if err := os.WriteFile(notBrowser, []byte("not a browser"), 0o755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		t.Skip("Windows 上无法用脚本模拟")
	}
	_ = ctx
	if out := probeVersion(0, "", notBrowser); out != "" {
		t.Errorf("非浏览器可执行文件应探测不到版本, got %q", out)
	}
}

func TestStatusWithoutBrowser(t *testing.T) {
	t.Setenv("REPLAYD_CHROME_PATH", "")
	mgr := New(Options{DataDir: t.TempDir(), Log: silentLogger(), IdleTimeout: time.Minute})
	defer mgr.Close()

	st := mgr.Status()
	if st.Running {
		t.Error("未启动时 running 应为 false")
	}
	if mgr.DataDir() == "" {
		t.Error("DataDir 不应为空")
	}
}

func TestHostOf(t *testing.T) {
	cases := map[string]string{
		"https://storage.googleapis.com/a/b.zip":    "storage.googleapis.com",
		"https://registry.npmmirror.com/-/binary/x": "registry.npmmirror.com",
		"plain-host/path":                           "plain-host",
		"https://a.test":                            "a.test",
	}
	for in, want := range cases {
		if got := hostOf(in); got != want {
			t.Errorf("hostOf(%q) = %q, want %q", in, got, want)
		}
	}
}
