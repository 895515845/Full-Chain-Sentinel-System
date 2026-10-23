package httpreplay

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

var (
	errInvalidHost   = errors.New("缺少主机名")
	errInvalidScheme = errors.New("仅支持 http/https")
	errInvalidPort   = errors.New("端口不合法")
)

// readChunkedBody 解析 chunked 编码 body。
// 返回解包后的 body、是否被截断、以及解析警告（trailer、异常格式仍尽量容错）。
func readChunkedBody(br *bufio.Reader, limit int64) ([]byte, bool, []Warning) {
	var out bytes.Buffer
	var warnings []Warning
	truncated := false

	for {
		line, err := readLineCapped(br, maxHeaderLine)
		if err != nil {
			truncated = true
			warnings = append(warnings, Warning{
				Code:    "chunked_truncated",
				Message: "chunked body 未正常结束（连接中断）",
			})
			break
		}
		t := strings.TrimSpace(strings.TrimRight(line, "\r\n"))
		if t == "" {
			continue
		}
		// chunk-size[;extension]
		sizeStr, _, _ := strings.Cut(t, ";")
		size, perr := strconv.ParseInt(strings.TrimSpace(sizeStr), 16, 64)
		if perr != nil || size < 0 {
			warnings = append(warnings, Warning{
				Code:    "chunked_malformed",
				Message: fmt.Sprintf("非法 chunk 大小行 %q，按原文截断处理", truncate(t, 40)),
			})
			truncated = true
			break
		}
		if size == 0 {
			// trailer 部分：读到空行为止
			for {
				tl, terr := readLineCapped(br, maxHeaderLine)
				if terr != nil || strings.TrimRight(tl, "\r\n") == "" {
					break
				}
			}
			break
		}
		if int64(out.Len())+size > limit {
			// 超限：读满剩余空间后停止
			remain := limit - int64(out.Len())
			if remain > 0 {
				chunk := make([]byte, remain)
				_, _ = io.ReadFull(br, chunk)
				out.Write(chunk)
			}
			truncated = true
			break
		}
		chunk := make([]byte, size)
		if _, err := io.ReadFull(br, chunk); err != nil {
			out.Write(chunk[:0])
			truncated = true
			break
		}
		out.Write(chunk)
		// chunk 之后的 CRLF
		_, _ = br.Discard(2)
	}
	return out.Bytes(), truncated, warnings
}

// readN 最多读 n 字节（用于超大 Content-Length 的截断读取）。
func readN(br *bufio.Reader, n int64) ([]byte, bool) {
	buf := make([]byte, n)
	read, err := io.ReadFull(br, buf)
	truncated := err != nil
	return buf[:read], truncated
}
