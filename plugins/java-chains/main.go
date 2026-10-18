// Java Chains MCP adapter: wraps java-chains-cli.jar as streamable HTTP MCP.
package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/zgsfsec/sentinel-java-chains/internal/chains"
	"github.com/zgsfsec/sentinel-java-chains/internal/mcp"
)

func main() {
	cli := chains.NewFromEnv()
	if _, err := os.Stat(cli.Jar); err != nil {
		log.Fatalf("找不到 Java Chains CLI jar: %s", cli.Jar)
	}
	port := firstEnv("PORT", "PLUGIN_PORT", "7801")
	if !strings.HasPrefix(port, ":") {
		port = ":" + port
	}
	mode := "local"
	if cli.Server != "" {
		mode = "remote " + cli.Server
	}
	dataDir := firstEnv("PLUGIN_DATA_DIR", "CHAINS_DATA_DIR", "/data")
	history := mcp.NewHistory(filepath.Join(dataDir, "java-chains-history.json"))
	fmt.Printf("java-chains MCP listening on %s (mode=%s, jar=%s)\n", port, mode, cli.Jar)
	if err := mcp.New(cli, history).Start(port); err != nil {
		log.Fatalf("MCP HTTP server failed: %v", err)
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
