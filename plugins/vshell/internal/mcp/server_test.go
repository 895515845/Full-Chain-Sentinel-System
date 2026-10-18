package mcp

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestArtifactPathStaysInsideArtifacts(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PLUGIN_ARTIFACTS_DIR", root)

	got, err := artifactPath("clients/stage_linux")
	if err != nil {
		t.Fatalf("artifactPath: %v", err)
	}
	if !strings.HasPrefix(got, root+string(filepath.Separator)) {
		t.Fatalf("path %q is outside %q", got, root)
	}
	if _, err := artifactPath("../escape"); err == nil {
		t.Fatal("expected traversal to be rejected")
	}
	if _, err := artifactPath("/tmp/elsewhere"); err == nil {
		t.Fatal("expected absolute path outside artifacts to be rejected")
	}
}
