// Package chains runs the Java Chains CLI and normalizes its JSON envelopes.
package chains

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// CLI is a thin wrapper around `java -jar java-chains-cli.jar`.
type CLI struct {
	Jar       string
	Server    string
	Token     string
	Execution string
	Timeout   time.Duration
	Artifacts string
}

func NewFromEnv() *CLI {
	jar := firstEnv("PLUGIN_CHAINS_JAR", "CHAINS_JAR", "/chains/java-chains-cli.jar")
	execution := firstEnv("PLUGIN_CHAINS_EXECUTION", "CHAINS_EXECUTION", "local")
	timeout := 120
	if raw := firstEnv("PLUGIN_CHAINS_TIMEOUT", "CHAINS_TIMEOUT", ""); raw != "" {
		if parsed, err := time.ParseDuration(raw + "s"); err == nil {
			timeout = int(parsed.Seconds())
		}
	}
	return &CLI{
		Jar:       jar,
		Server:    strings.TrimRight(firstEnv("PLUGIN_CHAINS_SERVER", "CHAINS_SERVER", ""), "/"),
		Token:     firstEnv("PLUGIN_CHAINS_API_TOKEN", "CHAINS_API_TOKEN", ""),
		Execution: execution,
		Timeout:   time.Duration(timeout) * time.Second,
		Artifacts: firstEnv("PLUGIN_ARTIFACTS_DIR", "PLUGIN_ARTIFACTS_DIR", "/artifacts"),
	}
}

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

// Invocation is one CLI call. Args excludes the jar and the trailing --json.
func (c *CLI) Invocation(args []string) ([]byte, error) {
	return c.InvocationWithTimeout(args, c.Timeout)
}

func (c *CLI) InvocationWithTimeout(args []string, timeout time.Duration) ([]byte, error) {
	if len(args) == 0 {
		return nil, errors.New("CLI 参数为空")
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmdArgs := append([]string{"-jar", c.Jar}, args...)
	if !contains(cmdArgs, "--json") {
		cmdArgs = append(cmdArgs, "--json")
	}
	cmd := exec.CommandContext(ctx, "java", cmdArgs...)
	cmd.Env = append(os.Environ(), "CHAINS_API_TOKEN="+c.Token, "CHAINS_SERVER="+c.Server)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return stdout.Bytes(), fmt.Errorf("CLI 超时（%s）", timeout)
	}
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = strings.TrimSpace(stdout.String())
		}
		return stdout.Bytes(), fmt.Errorf("CLI 退出失败: %w: %s", err, truncate(message, 1200))
	}
	return stdout.Bytes(), nil
}

func (c *CLI) WithRemote(args []string) []string {
	if c.Server == "" {
		return args
	}
	out := append([]string{}, args...)
	if !contains(args, "--server") {
		out = append(out, "--server", c.Server, "--token-env", "CHAINS_API_TOKEN")
	}
	return out
}

func (c *CLI) WithExecution(args []string) []string {
	if c.Execution == "" || contains(args, "--execution") {
		return args
	}
	return append(args, "--execution", c.Execution)
}

func (c *CLI) Artifact(name string) (string, error) {
	root, err := filepath.Abs(c.Artifacts)
	if err != nil {
		return "", err
	}
	if name == "" {
		name = fmt.Sprintf("java-chains-%d.bin", time.Now().Unix())
	}
	path := name
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, name)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("产物路径必须位于 %s 下", c.Artifacts)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", err
	}
	return abs, nil
}

// Envelope is the common success/error shape of the CLI.
type Envelope struct {
	Success   bool            `json:"success"`
	Envelope  string          `json:"envelope"`
	HTTP      int             `json:"httpStatus"`
	Execution json.RawMessage `json:"execution"`
	Data      json.RawMessage `json:"data"`
	Error     json.RawMessage `json:"error"`
	Message   string          `json:"message"`
}

func ParseEnvelope(raw []byte) (Envelope, error) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return env, err
	}
	return env, nil
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
