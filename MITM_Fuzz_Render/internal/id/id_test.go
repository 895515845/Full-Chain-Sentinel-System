package id

import (
	"strings"
	"testing"
	"time"
)

func TestNewFormat(t *testing.T) {
	got := New("flw")
	if !strings.HasPrefix(got, "flw_") {
		t.Fatalf("前缀错误: %s", got)
	}
	if len(got) != len("flw_")+26 {
		t.Fatalf("长度 = %d, want %d (%s)", len(got), len("flw_")+26, got)
	}
	for _, r := range got[len("flw_"):] {
		if !strings.ContainsRune(alphabet, r) {
			t.Fatalf("ID 含非法字符 %q: %s", r, got)
		}
	}
}

func TestNewWithoutPrefix(t *testing.T) {
	got := New("")
	if len(got) != 26 {
		t.Fatalf("长度 = %d, want 26", len(got))
	}
}

func TestUnique(t *testing.T) {
	seen := make(map[string]struct{}, 1000)
	for i := 0; i < 1000; i++ {
		v := New("flw")
		if _, ok := seen[v]; ok {
			t.Fatalf("重复 ID: %s", v)
		}
		seen[v] = struct{}{}
	}
}

func TestTimeRoundTrip(t *testing.T) {
	before := time.Now().Add(-time.Millisecond)
	v := New("flw")
	after := time.Now().Add(time.Millisecond)

	got := Time(v)
	if got.IsZero() {
		t.Fatal("Time 返回零值")
	}
	if got.Before(before) || got.After(after) {
		t.Errorf("解析时间 %v 不在 [%v, %v] 内", got, before, after)
	}
}

func TestSortable(t *testing.T) {
	// 同一进程内连续生成，字典序应与时间序一致。
	var ids []string
	for i := 0; i < 50; i++ {
		ids = append(ids, New("flw"))
		time.Sleep(time.Millisecond)
	}
	for i := 1; i < len(ids); i++ {
		if ids[i-1] >= ids[i] {
			t.Fatalf("ID 非递增: %s >= %s", ids[i-1], ids[i])
		}
	}
}

func TestTimeInvalid(t *testing.T) {
	if got := Time("short"); !got.IsZero() {
		t.Errorf("非法 ID 应返回零值, got %v", got)
	}
}
