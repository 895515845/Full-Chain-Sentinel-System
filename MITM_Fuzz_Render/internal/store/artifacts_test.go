package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestArtifactRoundTrip(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	meta, _ := json.Marshal(map[string]any{"url": "https://a.test/", "width": 1440, "height": 3200})
	png := append([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}, bytes.Repeat([]byte{0x42}, 1024)...)
	art := &Artifact{
		JobID:       "job_1",
		Kind:        ArtifactScreenshotFull,
		ContentType: "image/png",
		Meta:        meta,
	}
	if err := s.InsertArtifact(ctx, art, png); err != nil {
		t.Fatalf("InsertArtifact: %v", err)
	}
	if art.ID == "" || art.Size != int64(len(png)) {
		t.Fatalf("应回填 ID/大小: %+v", art)
	}

	got, data, err := s.GetArtifact(ctx, art.ID)
	if err != nil {
		t.Fatalf("GetArtifact: %v", err)
	}
	if !bytes.Equal(data, png) {
		t.Error("内容不一致")
	}
	if got.Kind != ArtifactScreenshotFull || got.ContentType != "image/png" || got.JobID != "job_1" {
		t.Errorf("元数据不一致: %+v", got)
	}
	if !json.Valid(got.Meta) {
		t.Errorf("meta 不是合法 JSON: %s", got.Meta)
	}
}

func TestArtifactDedupSameContent(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	data := []byte("same rendered text")

	for i := 0; i < 3; i++ {
		if err := s.InsertArtifact(ctx, &Artifact{Kind: ArtifactText, ContentType: "text/plain"}, data); err != nil {
			t.Fatalf("InsertArtifact #%d: %v", i, err)
		}
	}
	var blobs, refs int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(1), MAX(refcount) FROM blobs`).Scan(&blobs, &refs); err != nil {
		t.Fatal(err)
	}
	if blobs != 1 {
		t.Errorf("相同内容应只存一份 blob, got %d", blobs)
	}
	if refs != 3 {
		t.Errorf("引用计数 = %d, want 3", refs)
	}

	count, size, err := s.CountArtifacts(ctx)
	if err != nil || count != 3 || size != int64(len(data))*3 {
		t.Errorf("CountArtifacts = %d/%d err=%v", count, size, err)
	}
}

func TestArtifactListFilterAndDelete(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	png := &Artifact{Kind: ArtifactScreenshotViewport, ContentType: "image/png"}
	txt := &Artifact{Kind: ArtifactText, ContentType: "text/plain"}
	if err := s.InsertArtifact(ctx, png, []byte("png-bytes")); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertArtifact(ctx, txt, []byte("text-bytes")); err != nil {
		t.Fatal(err)
	}

	all, err := s.ListArtifacts(ctx, "", 10)
	if err != nil || len(all) != 2 {
		t.Fatalf("ListArtifacts 全部 = %d, err=%v", len(all), err)
	}
	shots, err := s.ListArtifacts(ctx, ArtifactScreenshotViewport, 10)
	if err != nil || len(shots) != 1 || shots[0].ID != png.ID {
		t.Fatalf("按 kind 过滤失败: %d 条, err=%v", len(shots), err)
	}

	if err := s.DeleteArtifact(ctx, png.ID); err != nil {
		t.Fatalf("DeleteArtifact: %v", err)
	}
	if _, _, err := s.GetArtifact(ctx, png.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("删除后应 ErrNotFound, got %v", err)
	}
	// 被引用的 blob 应只剩 1 个（另一个引用计数归零，文件留待日后 GC）
	var alive int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(1) FROM blobs WHERE refcount > 0`).Scan(&alive); err != nil {
		t.Fatal(err)
	}
	if alive != 1 {
		t.Errorf("删除后应只剩 1 个被引用 blob, got %d", alive)
	}
	if err := s.DeleteArtifact(ctx, png.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("重复删除应 ErrNotFound, got %v", err)
	}
}

func TestArtifactRejectsBadMeta(t *testing.T) {
	s := newTestStore(t)
	err := s.InsertArtifact(context.Background(), &Artifact{Kind: ArtifactText, Meta: json.RawMessage("{not json")}, []byte("x"))
	if err == nil {
		t.Fatal("非法 meta 应报错")
	}
}
