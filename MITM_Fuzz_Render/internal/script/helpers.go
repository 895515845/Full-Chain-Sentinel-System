package script

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/dop251/goja"
)

// helpersObject 暴露给脚本的 tools.helpers。
//
// 全部为纯函数、无 IO；出错时抛 JS 异常（脚本可 try/catch），不做静默降级。
func helpersObject(vm *goja.Runtime) *goja.Object {
	obj := vm.NewObject()

	_ = obj.Set("b64encode", func(s string) string {
		return base64.StdEncoding.EncodeToString([]byte(s))
	})
	_ = obj.Set("b64decode", func(s string) string {
		data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
		if err != nil {
			panic(vm.NewTypeError("b64decode: " + err.Error()))
		}
		return string(data)
	})
	_ = obj.Set("b64urlencode", func(s string) string {
		return base64.RawURLEncoding.EncodeToString([]byte(s))
	})
	_ = obj.Set("b64urldecode", func(s string) string {
		data, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(s))
		if err != nil {
			panic(vm.NewTypeError("b64urldecode: " + err.Error()))
		}
		return string(data)
	})
	_ = obj.Set("hexEncode", func(s string) string {
		return hex.EncodeToString([]byte(s))
	})
	_ = obj.Set("hexDecode", func(s string) string {
		data, err := hex.DecodeString(strings.TrimSpace(s))
		if err != nil {
			panic(vm.NewTypeError("hexDecode: " + err.Error()))
		}
		return string(data)
	})
	_ = obj.Set("urlencode", func(s string) string { return url.QueryEscape(s) })
	_ = obj.Set("urldecode", func(s string) string {
		out, err := url.QueryUnescape(s)
		if err != nil {
			panic(vm.NewTypeError("urldecode: " + err.Error()))
		}
		return out
	})
	_ = obj.Set("sha256Hex", func(s string) string {
		sum := sha256.Sum256([]byte(s))
		return hex.EncodeToString(sum[:])
	})
	_ = obj.Set("md5Hex", func(s string) string {
		sum := md5.Sum([]byte(s))
		return hex.EncodeToString(sum[:])
	})
	// hmacSHA256Hex(key, data) / hmacSHA256B64(key, data)
	_ = obj.Set("hmacSHA256Hex", func(key, data string) string {
		mac := hmac.New(sha256.New, []byte(key))
		_, _ = mac.Write([]byte(data))
		return hex.EncodeToString(mac.Sum(nil))
	})
	_ = obj.Set("hmacSHA256B64", func(key, data string) string {
		mac := hmac.New(sha256.New, []byte(key))
		_, _ = mac.Write([]byte(data))
		return base64.StdEncoding.EncodeToString(mac.Sum(nil))
	})
	// aesEncryptCBC(keyB64, ivB64, plain) -> base64
	_ = obj.Set("aesEncryptCBC", func(keyB64, ivB64, plain string) string {
		key, iv, err := decodeKeyIV(keyB64, ivB64)
		if err != nil {
			panic(vm.NewTypeError("aesEncryptCBC: " + err.Error()))
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			panic(vm.NewTypeError("aesEncryptCBC: " + err.Error()))
		}
		data := pkcs7Pad([]byte(plain), block.BlockSize())
		out := make([]byte, len(data))
		cipher.NewCBCEncrypter(block, iv).CryptBlocks(out, data)
		return base64.StdEncoding.EncodeToString(out)
	})
	// aesDecryptCBC(keyB64, ivB64, dataB64) -> 明文
	_ = obj.Set("aesDecryptCBC", func(keyB64, ivB64, dataB64 string) string {
		key, iv, err := decodeKeyIV(keyB64, ivB64)
		if err != nil {
			panic(vm.NewTypeError("aesDecryptCBC: " + err.Error()))
		}
		data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(dataB64))
		if err != nil {
			panic(vm.NewTypeError("aesDecryptCBC: " + err.Error()))
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			panic(vm.NewTypeError("aesDecryptCBC: " + err.Error()))
		}
		if len(data) == 0 || len(data)%block.BlockSize() != 0 {
			panic(vm.NewTypeError("aesDecryptCBC: 密文长度不是块大小的整数倍"))
		}
		out := make([]byte, len(data))
		cipher.NewCBCDecrypter(block, iv).CryptBlocks(out, data)
		unpadded, err := pkcs7Unpad(out, block.BlockSize())
		if err != nil {
			panic(vm.NewTypeError("aesDecryptCBC: " + err.Error()))
		}
		return string(unpadded)
	})
	// timestamp() / timestampMs() 便于做签名
	_ = obj.Set("timestampSec", func() int64 { return nowUnix() })
	_ = obj.Set("timestampMs", func() int64 { return nowUnixMilli() })

	return obj
}

func decodeKeyIV(keyB64, ivB64 string) ([]byte, []byte, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(keyB64))
	if err != nil {
		return nil, nil, err
	}
	iv, err := base64.StdEncoding.DecodeString(strings.TrimSpace(ivB64))
	if err != nil {
		return nil, nil, err
	}
	return key, iv, nil
}

func pkcs7Pad(data []byte, blockSize int) []byte {
	pad := blockSize - len(data)%blockSize
	out := make([]byte, len(data)+pad)
	copy(out, data)
	for i := len(data); i < len(out); i++ {
		out[i] = byte(pad)
	}
	return out
}

func pkcs7Unpad(data []byte, blockSize int) ([]byte, error) {
	if len(data) == 0 || len(data)%blockSize != 0 {
		return nil, errInvalidPadding
	}
	pad := int(data[len(data)-1])
	if pad == 0 || pad > blockSize || pad > len(data) {
		return nil, errInvalidPadding
	}
	for _, b := range data[len(data)-pad:] {
		if int(b) != pad {
			return nil, errInvalidPadding
		}
	}
	return data[:len(data)-pad], nil
}

var errInvalidPadding = errors.New("PKCS#7 填充不合法")

func nowUnix() int64      { return time.Now().Unix() }
func nowUnixMilli() int64 { return time.Now().UnixMilli() }
