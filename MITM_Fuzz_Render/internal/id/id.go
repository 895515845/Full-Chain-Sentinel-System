// Package id 生成按时间可排序的资源 ID（ULID 布局，无外部依赖）。
//
// 格式：<prefix>_<26 位 Crockford Base32>，前 48 位为毫秒时间戳，
// 后 80 位为随机数。同毫秒内按随机部分排序，跨毫秒按时间排序，
// 因此可以直接用作分页游标的第二排序键。
package id

import (
	crand "crypto/rand"
	"encoding/base32"
	"time"
)

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

var enc = base32.NewEncoding(alphabet).WithPadding(base32.NoPadding)

// New 返回形如 "flw_01JBM3X8Z9K4Q7V2N6R5T0W1Y3" 的 ID。
func New(prefix string) string {
	var b [16]byte
	ms := uint64(time.Now().UnixMilli())
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	if _, err := crand.Read(b[6:]); err != nil {
		// crypto/rand 失败属于系统级故障，不应静默降级为可预测 ID。
		panic("id: crypto/rand failed: " + err.Error())
	}
	s := enc.EncodeToString(b[:])
	if prefix == "" {
		return s
	}
	return prefix + "_" + s
}

// Time 从 ID 中解析毫秒时间戳；格式非法时返回零值。
func Time(v string) time.Time {
	i := len(v) - 26
	if i < 0 {
		return time.Time{}
	}
	raw, err := enc.DecodeString(v[i:])
	if err != nil || len(raw) != 16 {
		return time.Time{}
	}
	ms := uint64(raw[0])<<40 | uint64(raw[1])<<32 | uint64(raw[2])<<24 |
		uint64(raw[3])<<16 | uint64(raw[4])<<8 | uint64(raw[5])
	return time.UnixMilli(int64(ms))
}
