package browser

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	versionIndexURL = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
	npmmirrorBase   = "https://registry.npmmirror.com/-/binary/chrome-for-testing"
	googleBase      = "https://storage.googleapis.com/chrome-for-testing-public"
	downloadTimeout = 20 * time.Minute
)

// ErrBrowserMissing 表示既没找到系统浏览器，也还没有下载过。
var ErrBrowserMissing = fmt.Errorf("browser: 未找到可用浏览器。" +
	"可设置 REPLAYD_CHROME_PATH 指向 Chrome/Chromium，或调用 POST /api/render/browser/install 自动下载")

// platformKey 返回 chrome-for-testing 的平台标识（如 mac-arm64、linux64、win64）。
func platformKey() (string, error) {
	switch runtime.GOOS {
	case "darwin":
		if runtime.GOARCH == "arm64" {
			return "mac-arm64", nil
		}
		return "mac-x64", nil
	case "linux":
		switch runtime.GOARCH {
		case "arm64":
			return "linux-arm64", nil
		case "amd64":
			return "linux64", nil
		}
	case "windows":
		if runtime.GOARCH == "arm64" {
			return "win-arm64", nil
		}
		return "win64", nil
	}
	return "", fmt.Errorf("browser: 暂不支持自动下载 %s/%s 的 chromium", runtime.GOOS, runtime.GOARCH)
}

func binaryName() string {
	if runtime.GOOS == "windows" {
		return "chrome-headless-shell.exe"
	}
	return "chrome-headless-shell"
}

// systemCandidates 返回各平台常见的浏览器路径。
func systemCandidates() []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
		}
	case "linux":
		return []string{
			"/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
			"/usr/bin/chromium", "/usr/bin/chromium-browser",
			"/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable",
			"/snap/bin/chromium",
		}
	case "windows":
		roots := []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")}
		var out []string
		for _, root := range roots {
			if root == "" {
				continue
			}
			out = append(out,
				filepath.Join(root, `Google\Chrome\Application\chrome.exe`),
				filepath.Join(root, `Microsoft\Edge\Application\msedge.exe`),
				filepath.Join(root, `Chromium\Application\chrome.exe`),
			)
		}
		return out
	}
	return nil
}

// Resolve 解析出可用的浏览器可执行文件路径与来源。
func Resolve(dataDir string) (path string, source string, err error) {
	if env := strings.TrimSpace(os.Getenv("REPLAYD_CHROME_PATH")); env != "" {
		if isExecutable(env) {
			return env, "env", nil
		}
		return "", "", fmt.Errorf("browser: REPLAYD_CHROME_PATH=%q 不是可执行文件", env)
	}
	for _, candidate := range systemCandidates() {
		if isExecutable(candidate) {
			return candidate, "system", nil
		}
	}
	if path, ok := findDownloaded(dataDir); ok {
		return path, "downloaded", nil
	}
	return "", "", ErrBrowserMissing
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode().Perm()&0o111 != 0
}

// findDownloaded 在 dataDir/browser 下递归查找已下载的 chrome-headless-shell（取最新）。
// 递归是必要的：chrome-for-testing 的 zip 内层目录结构会随版本变化
// （chrome-headless-shell-<platform>/chrome-headless-shell-<platform>/…）。
func findDownloaded(dataDir string) (string, bool) {
	root := filepath.Join(dataDir, "browser")
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", false
	}
	name := binaryName()
	var candidates []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return nil
			}
			if d.IsDir() {
				// 限制深度，避免误入深层无关目录
				if rel, relErr := filepath.Rel(dir, path); relErr == nil && strings.Count(rel, string(os.PathSeparator)) > 3 {
					return filepath.SkipDir
				}
				return nil
			}
			if d.Name() == name && isExecutable(path) {
				candidates = append(candidates, path)
			}
			return nil
		})
	}
	if len(candidates) == 0 {
		return "", false
	}
	sort.Slice(candidates, func(i, j int) bool {
		fi, errI := os.Stat(candidates[i])
		fj, errJ := os.Stat(candidates[j])
		if errI != nil || errJ != nil {
			return candidates[i] > candidates[j]
		}
		return fi.ModTime().After(fj.ModTime())
	})
	return candidates[0], true
}

// Install 下载并解压 chrome-headless-shell；progress 用于回报进度（可为 nil）。
func Install(ctx context.Context, dataDir string, progress func(string)) (string, error) {
	if progress == nil {
		progress = func(string) {}
	}
	key, err := platformKey()
	if err != nil {
		return "", err
	}

	urls, version, err := downloadURLs(ctx, key, progress)
	if err != nil {
		return "", err
	}

	var lastErr error
	for _, url := range urls {
		progress("从 " + hostOf(url) + " 下载 chromium-headless-shell（约 100MB）…")
		path, err := downloadAndExtract(ctx, url, dataDir, version, key, progress)
		if err == nil {
			progress("已安装：" + path)
			return path, nil
		}
		lastErr = err
		progress("下载源失败，尝试下一个：" + err.Error())
	}
	return "", fmt.Errorf("browser: 所有下载源都失败: %w", lastErr)
}

// downloadURLs 返回候选下载地址与版本号（镜像优先）。
func downloadURLs(ctx context.Context, key string, progress func(string)) ([]string, string, error) {
	file := fmt.Sprintf("chrome-headless-shell-%s.zip", key)

	// 显式指定的完整 URL 模板优先（可用 {version} / {platform} 占位）
	if tpl := strings.TrimSpace(os.Getenv("REPLAYD_CHROME_URL")); tpl != "" {
		version := strings.TrimSpace(os.Getenv("REPLAYD_CHROME_VERSION"))
		if version == "" {
			version = fetchStableVersion(ctx, progress)
		}
		url := strings.ReplaceAll(tpl, "{platform}", key)
		url = strings.ReplaceAll(url, "{version}", version)
		return []string{url}, version, nil
	}

	version := fetchStableVersion(ctx, progress)
	if version == "" {
		return nil, "", fmt.Errorf("browser: 无法确定 chromium 版本（版本索引不可达，可用 REPLAYD_CHROME_URL 指定完整下载地址）")
	}
	urls := []string{
		fmt.Sprintf("%s/%s/%s/%s", npmmirrorBase, version, key, file),
		fmt.Sprintf("%s/%s/%s/%s", googleBase, version, key, file),
	}
	return urls, version, nil
}

func fetchStableVersion(ctx context.Context, progress func(string)) string {
	reqCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, versionIndexURL, nil)
	if err != nil {
		return ""
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer func() { _ = resp.Body.Close() }()
	var payload struct {
		Channels struct {
			Stable struct {
				Version string `json:"version"`
			} `json:"Stable"`
		} `json:"channels"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return ""
	}
	if payload.Channels.Stable.Version != "" {
		progress("目标版本：" + payload.Channels.Stable.Version)
	}
	return payload.Channels.Stable.Version
}

func downloadAndExtract(ctx context.Context, url, dataDir, version, key string, progress func(string)) (string, error) {
	if err := os.MkdirAll(filepath.Join(dataDir, "browser"), 0o700); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(filepath.Join(dataDir, "browser"), "download-*.zip")
	if err != nil {
		return "", fmt.Errorf("browser: 创建临时文件失败: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()

	dlCtx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(dlCtx, http.MethodGet, url, nil)
	if err != nil {
		_ = tmp.Close()
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		_ = tmp.Close()
		return "", fmt.Errorf("browser: 下载失败: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		_ = tmp.Close()
		return "", fmt.Errorf("browser: 下载返回 HTTP %d", resp.StatusCode)
	}

	written, lastReport := int64(0), time.Now()
	buf := make([]byte, 1<<20)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := tmp.Write(buf[:n]); werr != nil {
				_ = tmp.Close()
				return "", fmt.Errorf("browser: 写入失败: %w", werr)
			}
			written += int64(n)
			if time.Since(lastReport) > 3*time.Second {
				progress(fmt.Sprintf("已下载 %.1f MB / %.1f MB", float64(written)/1048576, float64(resp.ContentLength)/1048576))
				lastReport = time.Now()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			_ = tmp.Close()
			return "", fmt.Errorf("browser: 下载中断: %w", rerr)
		}
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	progress(fmt.Sprintf("下载完成 %.1f MB，正在解压…", float64(written)/1048576))

	dest := filepath.Join(dataDir, "browser", fmt.Sprintf("chrome-headless-shell-%s-%s", version, key))
	if err := os.MkdirAll(dest, 0o700); err != nil {
		return "", err
	}
	binPath, err := extractZip(tmpName, dest)
	if err != nil {
		return "", err
	}
	if err := os.Chmod(binPath, 0o755); err != nil {
		return "", fmt.Errorf("browser: 设置可执行权限失败: %w", err)
	}
	if out, verr := exec.CommandContext(ctx, binPath, "--version").Output(); verr != nil {
		return "", fmt.Errorf("browser: 解压后的可执行文件无法运行: %w", verr)
	} else {
		progress("校验通过：" + strings.TrimSpace(string(out)))
	}
	return binPath, nil
}

// extractZip 解压并返回可执行文件路径。
func extractZip(zipPath, dest string) (string, error) {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return "", fmt.Errorf("browser: 打开压缩包失败: %w", err)
	}
	defer func() { _ = reader.Close() }()

	var binaryPath string
	for _, f := range reader.File {
		clean := filepath.Clean(f.Name)
		if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
			return "", fmt.Errorf("browser: 压缩包内含非法路径 %q", f.Name)
		}
		target := filepath.Join(dest, clean)
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return "", err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return "", err
		}
		src, err := f.Open()
		if err != nil {
			return "", fmt.Errorf("browser: 读取 %s 失败: %w", f.Name, err)
		}
		mode := f.Mode()
		if mode == 0 {
			mode = 0o644
		}
		dst, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode.Perm())
		if err != nil {
			_ = src.Close()
			return "", err
		}
		if _, err := io.Copy(dst, src); err != nil {
			_ = src.Close()
			_ = dst.Close()
			return "", fmt.Errorf("browser: 写入 %s 失败: %w", f.Name, err)
		}
		_ = src.Close()
		_ = dst.Close()

		if filepath.Base(clean) == binaryName() {
			binaryPath = target
		}
	}
	if binaryPath == "" {
		return "", fmt.Errorf("browser: 压缩包内未找到 %s", binaryName())
	}
	return binaryPath, nil
}

func hostOf(rawURL string) string {
	rest := rawURL
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	if j := strings.IndexByte(rest, '/'); j >= 0 {
		return rest[:j]
	}
	return rest
}
