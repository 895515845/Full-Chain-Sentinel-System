// Package script 实现基于 goja 的 JS 脚本钩子运行时。
//
// 设计要点（docs/SPEC-API.md、docs/PLAN.md §4.4）：
//   - 每次执行新建一个 goja Runtime：脚本之间零共享，不会互相污染；
//   - 默认 3s 超时，用 vm.Interrupt 中断死循环，并把中断归一化为可读错误；
//   - 请求/响应对象支持双向读写：脚本改 header/body 后回传，由调用方重建报文；
//   - 无文件、网络 API；把"脚本是受信代码"写进文档，不做安全沙箱承诺。
package script

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/dop251/goja"
)

const (
	// DefaultTimeout 是单次钩子调用的默认超时。
	DefaultTimeout = 3 * time.Second
	maxLogs        = 500
	maxLogBytes    = 4096
)

// Header 保留原始名称与顺序。
type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Hooks 声明要调用哪些钩子（函数存在但开关关闭时不调用）。
type Hooks struct {
	OnRequest  bool `json:"onRequest"`
	OnResponse bool `json:"onResponse"`
	OnAssert   bool `json:"onAssert"`
}

// DefaultHooks 返回三个钩子全开（脚本未定义某函数时会自动跳过）。
func DefaultHooks() Hooks { return Hooks{OnRequest: true, OnResponse: true, OnAssert: true} }

// Request 是脚本可见的请求视图。
type Request struct {
	Method  string   `json:"method"`
	URL     string   `json:"url"`
	Body    string   `json:"body"`
	Headers []Header `json:"headers"`
}

// Response 是脚本可见的响应视图。
type Response struct {
	Status    int      `json:"status"`
	Body      string   `json:"body"`
	Headers   []Header `json:"headers"`
	Truncated bool     `json:"truncated"`
}

// LogEntry 是脚本输出的一条日志。
type LogEntry struct {
	Level   string `json:"level"`
	Message string `json:"message"`
}

// Assert 是断言结果。
type Assert struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

// Input 是一次脚本执行的输入。
type Input struct {
	Source   string
	Hooks    Hooks
	Request  Request
	Response *Response
	Vars     map[string]string
	Env      map[string]string
	Timeout  time.Duration
}

// Output 是一次脚本执行的结果。
type Output struct {
	Request    Request    `json:"request"`
	Response   *Response  `json:"response,omitempty"`
	Assert     *Assert    `json:"assert,omitempty"`
	Logs       []LogEntry `json:"logs"`
	Error      string     `json:"error,omitempty"`
	DurationMS int64      `json:"durationMs"`
	HooksRun   []string   `json:"hooksRun"`
}

// Engine 执行脚本；零值可用。
type Engine struct {
	Timeout time.Duration
}

// New 创建引擎。
func New() *Engine { return &Engine{Timeout: DefaultTimeout} }

// Session 是一次跨"发包前后"的脚本会话：onRequest 在发送前执行，
// onResponse/onAssert 在收到响应后执行，二者共用同一个 VM、ctx.vars 与日志流。
type Session struct {
	engine   *Engine
	vm       *goja.Runtime
	ctx      context.Context
	timeout  time.Duration
	hooks    Hooks
	logs     *logCollector
	hooksRun []string
	asserted *Assert
	started  time.Time

	ctxObj  *goja.Object
	reqObj  *goja.Object
	syncReq func() Request

	respObj  *goja.Object
	syncResp func() Response
}

// Start 加载脚本并执行 onRequest；返回会话与阶段性结果。
//
// out.Error 非空时 sess 可能为 nil（脚本无法加载）。调用方应先检查 out.Error。
func (e *Engine) Start(ctx context.Context, in Input) (*Session, Output) {
	start := time.Now()
	timeout := in.Timeout
	if timeout <= 0 {
		timeout = e.Timeout
	}
	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	out := Output{Request: in.Request, Logs: []LogEntry{}, HooksRun: []string{}}
	vm := goja.New()
	logs := &logCollector{}
	sess := &Session{
		engine:  e,
		vm:      vm,
		ctx:     ctx,
		timeout: timeout,
		hooks:   in.Hooks,
		logs:    logs,
		started: start,
	}

	// ---- 全局对象：console / ctx / helpers / assert ----
	ctxObj := vm.NewObject()
	varsObj := vm.NewObject()
	for k, v := range in.Vars {
		_ = varsObj.Set(k, v)
	}
	envObj := vm.NewObject()
	for k, v := range in.Env {
		_ = envObj.Set(k, v)
	}
	logFn := func(call goja.FunctionCall) goja.Value {
		logs.add("info", joinArgs(call))
		return goja.Undefined()
	}
	errFn := func(call goja.FunctionCall) goja.Value {
		logs.add("error", joinArgs(call))
		return goja.Undefined()
	}
	_ = ctxObj.Set("vars", varsObj)
	_ = ctxObj.Set("env", envObj)
	_ = ctxObj.Set("log", logFn)
	_ = ctxObj.Set("logError", errFn)

	consoleObj := vm.NewObject()
	_ = consoleObj.Set("log", logFn)
	_ = consoleObj.Set("warn", logFn)
	_ = consoleObj.Set("error", errFn)

	_ = vm.Set("console", consoleObj)
	_ = vm.Set("ctx", ctxObj)
	_ = vm.Set("helpers", helpersObject(vm))
	_ = vm.Set("assert", func(call goja.FunctionCall) goja.Value {
		ok := call.Argument(0).ToBoolean()
		msg := ""
		if len(call.Arguments) > 1 {
			msg = call.Argument(1).String()
		}
		sess.asserted = &Assert{OK: ok, Message: msg}
		return goja.Undefined()
	})
	sess.ctxObj = ctxObj

	// ---- 加载脚本（定义函数）----
	if err := guarded(vm, ctx, timeout, func() error {
		_, err := vm.RunString(in.Source)
		return err
	}); err != nil {
		out.Error = formatErr("脚本加载失败", err)
		out.Logs = logs.snapshot()
		out.DurationMS = time.Since(start).Milliseconds()
		return nil, out
	}

	// ---- onRequest ----
	sess.reqObj, sess.syncReq = bindRequest(vm, in.Request)
	if in.Hooks.OnRequest {
		if fn := callable(vm, "onRequest"); fn != nil {
			if err := guarded(vm, ctx, timeout, func() error {
				_, err := fn(goja.Undefined(), sess.reqObj, ctxObj)
				return err
			}); err != nil {
				out.Error = formatErr("onRequest", err)
				out.Request = sess.syncReq()
				out.Logs = logs.snapshot()
				out.DurationMS = time.Since(start).Milliseconds()
				return sess, out
			}
			sess.hooksRun = append(sess.hooksRun, "onRequest")
		}
	}
	out.Request = sess.syncReq()
	out.HooksRun = append(out.HooksRun, sess.hooksRun...)
	out.Logs = logs.snapshot()
	out.DurationMS = time.Since(start).Milliseconds()
	return sess, out
}

// Response 执行 onResponse 与 onAssert，并给出会话的完整结果。
func (s *Session) Response(resp Response) Output {
	out := Output{Request: s.syncReq(), Logs: []LogEntry{}, HooksRun: []string{}}

	s.respObj, s.syncResp = bindResponse(s.vm, resp)
	if s.hooks.OnResponse {
		if fn := callable(s.vm, "onResponse"); fn != nil {
			if err := guarded(s.vm, s.ctx, s.timeout, func() error {
				_, err := fn(goja.Undefined(), s.respObj, s.ctxObj)
				return err
			}); err != nil {
				out.Error = formatErr("onResponse", err)
				out.Request = s.syncReq()
				out.Logs = s.logs.snapshot()
				out.HooksRun = append(out.HooksRun, s.hooksRun...)
				out.DurationMS = time.Since(s.started).Milliseconds()
				return out
			}
			s.hooksRun = append(s.hooksRun, "onResponse")
		}
	}
	synced := s.syncResp()
	out.Response = &synced

	if s.hooks.OnAssert {
		if fn := callable(s.vm, "onAssert"); fn != nil {
			var returned goja.Value
			err := guarded(s.vm, s.ctx, s.timeout, func() error {
				v, cerr := fn(goja.Undefined(), s.reqObj, s.respObj, s.ctxObj)
				returned = v
				return cerr
			})
			if err != nil {
				out.Error = formatErr("onAssert", err)
			} else {
				s.hooksRun = append(s.hooksRun, "onAssert")
				out.Assert = interpretAssert(s.vm, returned, s.asserted)
			}
		} else if s.asserted != nil {
			out.Assert = s.asserted
		}
	} else if s.asserted != nil {
		out.Assert = s.asserted
	}

	out.HooksRun = append([]string{}, s.hooksRun...)
	out.Logs = s.logs.snapshot()
	out.DurationMS = time.Since(s.started).Milliseconds()
	return out
}

// Run 是单次调用辅助：加载脚本 → onRequest → （若给了 Response）onResponse/onAssert。
func (e *Engine) Run(ctx context.Context, in Input) Output {
	sess, out := e.Start(ctx, in)
	if sess == nil || out.Error != "" || in.Response == nil {
		return out
	}
	return sess.Response(*in.Response)
}

// ---------------------------------------------------------------- 对象绑定

func bindRequest(vm *goja.Runtime, in Request) (*goja.Object, func() Request) {
	state := in
	obj := vm.NewObject()
	_ = obj.Set("method", state.Method)
	_ = obj.Set("url", state.URL)
	_ = obj.Set("body", state.Body)
	headers := state.Headers
	_ = obj.Set("headers", bindHeaders(vm, &headers))
	return obj, func() Request {
		out := state
		out.Method = readString(vm, obj, "method", state.Method)
		out.URL = readString(vm, obj, "url", state.URL)
		out.Body = readString(vm, obj, "body", state.Body)
		out.Headers = headers
		return out
	}
}

func bindResponse(vm *goja.Runtime, in Response) (*goja.Object, func() Response) {
	state := in
	obj := vm.NewObject()
	_ = obj.Set("status", state.Status)
	_ = obj.Set("body", state.Body)
	_ = obj.Set("truncated", state.Truncated)
	headers := state.Headers
	_ = obj.Set("headers", bindHeaders(vm, &headers))
	return obj, func() Response {
		out := state
		if v := obj.Get("status"); v != nil && !goja.IsUndefined(v) && !goja.IsNull(v) {
			out.Status = int(v.ToInteger())
		}
		out.Body = readString(vm, obj, "body", state.Body)
		out.Headers = headers
		return out
	}
}

// bindHeaders 返回带 get/set/add/remove/all 的头集合对象（大小写不敏感）。
func bindHeaders(vm *goja.Runtime, headers *[]Header) *goja.Object {
	obj := vm.NewObject()
	_ = obj.Set("get", func(name string) string {
		for _, h := range *headers {
			if strings.EqualFold(h.Name, name) {
				return h.Value
			}
		}
		return ""
	})
	_ = obj.Set("set", func(name, value string) {
		out := make([]Header, 0, len(*headers)+1)
		replaced := false
		for _, h := range *headers {
			if strings.EqualFold(h.Name, name) {
				if !replaced {
					out = append(out, Header{Name: h.Name, Value: value})
					replaced = true
				}
				continue // 同名重复项只保留一个
			}
			out = append(out, h)
		}
		if !replaced {
			out = append(out, Header{Name: name, Value: value})
		}
		*headers = out
	})
	_ = obj.Set("add", func(name, value string) {
		*headers = append(*headers, Header{Name: name, Value: value})
	})
	_ = obj.Set("remove", func(name string) {
		out := (*headers)[:0]
		for _, h := range *headers {
			if !strings.EqualFold(h.Name, name) {
				out = append(out, h)
			}
		}
		*headers = out
	})
	_ = obj.Set("all", func() []map[string]string {
		out := make([]map[string]string, 0, len(*headers))
		for _, h := range *headers {
			out = append(out, map[string]string{"name": h.Name, "value": h.Value})
		}
		return out
	})
	return obj
}

func readString(vm *goja.Runtime, obj *goja.Object, key, def string) string {
	v := obj.Get(key)
	if v == nil || goja.IsUndefined(v) || goja.IsNull(v) {
		return def
	}
	return v.String()
}

func callable(vm *goja.Runtime, name string) goja.Callable {
	v := vm.Get(name)
	if v == nil {
		return nil
	}
	fn, ok := goja.AssertFunction(v)
	if !ok {
		return nil
	}
	return fn
}

func interpretAssert(vm *goja.Runtime, returned goja.Value, asserted *Assert) *Assert {
	if returned != nil && !goja.IsUndefined(returned) && !goja.IsNull(returned) {
		if obj := returned.ToObject(vm); obj != nil {
			if okVal := obj.Get("ok"); okVal != nil && !goja.IsUndefined(okVal) {
				msg := ""
				if m := obj.Get("message"); m != nil && !goja.IsUndefined(m) {
					msg = m.String()
				}
				return &Assert{OK: okVal.ToBoolean(), Message: msg}
			}
		}
		if b, ok := returned.Export().(bool); ok {
			msg := ""
			if asserted != nil {
				msg = asserted.Message
			}
			return &Assert{OK: b, Message: msg}
		}
	}
	if asserted != nil {
		return asserted
	}
	return &Assert{OK: true, Message: "脚本未做断言"}
}

// ---------------------------------------------------------------- 超时与错误

// guarded 在超时或 ctx 取消时中断脚本执行。
func guarded(vm *goja.Runtime, ctx context.Context, timeout time.Duration, fn func() error) error {
	timer := time.AfterFunc(timeout, func() {
		vm.Interrupt(fmt.Sprintf("脚本超时（%dms）已中断", timeout.Milliseconds()))
	})
	defer timer.Stop()

	done := make(chan struct{})
	if ctx != nil {
		go func() {
			select {
			case <-ctx.Done():
				vm.Interrupt("请求已取消")
			case <-done:
			}
		}()
	}
	defer close(done)

	return fn()
}

func formatErr(prefix string, err error) string {
	if err == nil {
		return ""
	}
	var interrupted *goja.InterruptedError
	if errors.As(err, &interrupted) {
		if msg, isStr := interrupted.Value().(string); isStr && msg != "" {
			return fmt.Sprintf("%s: %s", prefix, msg)
		}
		return fmt.Sprintf("%s: 脚本被中断", prefix)
	}
	var syntaxErr *goja.CompilerSyntaxError
	if errors.As(err, &syntaxErr) {
		return fmt.Sprintf("%s: 语法错误: %v", prefix, err)
	}
	var compileErr *goja.CompilerReferenceError
	if errors.As(err, &compileErr) {
		return fmt.Sprintf("%s: 引用错误: %v", prefix, err)
	}
	var exc *goja.Exception
	if errors.As(err, &exc) {
		return fmt.Sprintf("%s: 运行时异常: %v", prefix, err)
	}
	return fmt.Sprintf("%s: %v", prefix, err)
}

// ---------------------------------------------------------------- 日志

type logCollector struct {
	entries []LogEntry
}

func (l *logCollector) add(level, message string) {
	if len(l.entries) >= maxLogs {
		return
	}
	if len(message) > maxLogBytes {
		message = message[:maxLogBytes] + "…"
	}
	l.entries = append(l.entries, LogEntry{Level: level, Message: message})
}

func (l *logCollector) snapshot() []LogEntry {
	if l.entries == nil {
		return []LogEntry{}
	}
	out := make([]LogEntry, len(l.entries))
	copy(out, l.entries)
	return out
}

func joinArgs(call goja.FunctionCall) string {
	parts := make([]string, 0, len(call.Arguments))
	for _, arg := range call.Arguments {
		switch v := arg.Export().(type) {
		case string:
			parts = append(parts, v)
		case nil:
			parts = append(parts, "null")
		case []byte:
			parts = append(parts, base64.StdEncoding.EncodeToString(v))
		default:
			parts = append(parts, fmt.Sprintf("%v", v))
		}
	}
	return strings.Join(parts, " ")
}

// RawRequest 把（可能被脚本改过的）请求视图重建为原始报文文本。
// fallbackTarget 用于 URL 无法解析出主机时保留原 target。
func (r Request) RawRequest(fallbackTarget string) string {
	target := fallbackTarget
	if u, err := url.Parse(r.URL); err == nil && u.Host != "" {
		target = u.RequestURI()
	}
	if target == "" {
		target = "/"
	}
	method := r.Method
	if method == "" {
		method = "GET"
	}
	var b strings.Builder
	b.WriteString(method)
	b.WriteByte(' ')
	b.WriteString(target)
	b.WriteString(" HTTP/1.1\r\n")
	for _, h := range r.Headers {
		if h.Name == "" {
			continue
		}
		b.WriteString(h.Name)
		b.WriteString(": ")
		b.WriteString(h.Value)
		b.WriteString("\r\n")
	}
	b.WriteString("\r\n")
	b.WriteString(r.Body)
	return b.String()
}
