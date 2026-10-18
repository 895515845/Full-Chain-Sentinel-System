// Package mcp exposes Java Chains CLI capabilities over streamable HTTP MCP.
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/zgsfsec/sentinel-java-chains/internal/chains"
)

type Server struct {
	cli     *chains.CLI
	srv     *server.MCPServer
	history *History
}

func New(cli *chains.CLI, history *History) *Server {
	s := &Server{cli: cli, history: history}
	s.srv = server.NewMCPServer(
		"java-chains",
		"0.2.0",
		server.WithToolCapabilities(false),
		server.WithToolHandlerMiddleware(history.Middleware()),
		server.WithInstructions(
			"Java Chains MCP：查询 payload/gadget/preset，生成 Java 攻击载荷，可选远端服务管理。"+
				"先用 chains_guide 和 chains_inventory 了解清单；生成前优先使用 preset；仅限已授权测试。",
		),
	)
	s.register()
	return s
}

func (s *Server) Start(addr string) error {
	streamable := server.NewStreamableHTTPServer(s.srv, server.WithEndpointPath("/mcp"))
	uiDir := os.Getenv("PLUGIN_UI_DIR")
	if uiDir == "" {
		uiDir = "/app/ui"
	}
	mux := http.NewServeMux()
	mux.Handle("/mcp", streamable)
	mux.Handle("/ui/", http.StripPrefix("/ui/", http.FileServer(http.Dir(uiDir))))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	return http.ListenAndServe(addr, mux)
}

func (s *Server) register() {
	s.srv.AddTool(mcp.NewTool("list_calls",
		mcp.WithDescription("查询 Java Chains MCP 工具的调用历史（不含 list_calls 本身）。"),
		mcp.WithNumber("limit", mcp.Description("返回条数，默认 200，最大 200")),
	), s.handleListCalls)

	s.srv.AddTool(mcp.NewTool("chains_guide",
		mcp.WithDescription("Java Chains 官方 AI 用法契约：执行模式、鉴权、firstRun 流程与命令清单。构造链前先读本契约和 chains_inventory。"),
	), s.handleGuide)

	s.srv.AddTool(mcp.NewTool("chains_inventory",
		mcp.WithDescription("Java Chains 清单：payload、gadget、preset 的完整 JSON。生成前优先查 preset，有匹配的直接用。"),
	), s.handleInventory)

	s.srv.AddTool(mcp.NewTool("chains_describe",
		mcp.WithDescription("查单个 payload 或 gadget 的完整定义：参数、依赖、nextGadgets、别名。自由链构造时用。"),
		mcp.WithString("key", mcp.Required(), mcp.Description("payload 或 gadget 的 key，如 CommonsBeanutils1 / JavaNativePayload")),
		mcp.WithString("kind", mcp.Description("gadget 或 payload；留空先查 gadget 再查 payload")),
	), s.handleDescribe)

	s.srv.AddTool(mcp.NewTool("chains_generate",
		mcp.WithDescription("自由链生成 Java 攻击载荷。构造前用 chains_describe 查各 gadget 参数与 nextGadgets；仅限已授权测试。"),
		mcp.WithString("payload", mcp.Required(), mcp.Description("载体 payload key，如 JavaNativePayload")),
		mcp.WithString("chain", mcp.Required(), mcp.Description("逗号分隔的 gadget 序列，如 CommonsBeanutils1,TemplatesImpl,BytecodeConvert,Exec")),
		mcp.WithArray("args", mcp.Description("节点参数 Owner.field=value，如 [\"Exec.cmd=whoami\"]"), mcp.WithStringItems()),
		mcp.WithString("encode", mcp.Description("载荷编码，默认 base64")),
		mcp.WithString("out", mcp.Description("产物相对路径，默认 java-chains/<时间>.bin")),
	), s.handleGenerate)

	s.srv.AddTool(mcp.NewTool("chains_generate_preset",
		mcp.WithDescription("按预组装 preset 生成 Java 攻击载荷（推荐路径）。返回产物路径和元信息。仅限已授权测试。"),
		mcp.WithString("preset_id", mcp.Required(), mcp.Description("preset id，如 java.cb1.exec")),
		mcp.WithString("payload", mcp.Required(), mcp.Description("载体 payload key，如 JavaNativePayload")),
		mcp.WithArray("inputs", mcp.Description("preset 输入，如 [\"cmd=whoami\"]"), mcp.WithStringItems()),
		mcp.WithString("encode", mcp.Description("载荷编码，默认 base64")),
		mcp.WithString("out", mcp.Description("产物相对路径")),
	), s.handleGeneratePreset)

	s.srv.AddTool(mcp.NewTool("chains_validate_chain",
		mcp.WithDescription("本地校验自由链连通性：逐步检查 gadget 序列是否在上一节点的 nextGadgets 里。"),
		mcp.WithString("chain", mcp.Required(), mcp.Description("逗号分隔的 gadget 序列（可包含 payload）")),
		mcp.WithArray("args", mcp.Description("节点参数 Owner.field=value"), mcp.WithStringItems()),
	), s.handleValidate)

	s.srv.AddTool(mcp.NewTool("chains_exec",
		mcp.WithDescription("Java Chains CLI 透传（高级逃生口）：按 chains_guide 契约执行任意 CLI 命令，自动补 --json。"),
		mcp.WithArray("cli_args", mcp.Required(), mcp.Description("CLI 参数数组，如 [\"catalog\",\"presets\"]（不含 --json）"), mcp.WithStringItems()),
		mcp.WithNumber("timeout_sec", mcp.Description("超时秒数，默认 120")),
	), s.handleExec)

	s.srv.AddTool(mcp.NewTool("chains_services",
		mcp.WithDescription("管理远端 Java Chains 服务端协议服务：list 查询，start/stop/restart 需要 confirm=true。"),
		mcp.WithString("action", mcp.Required(), mcp.Description("list/get/start/stop/restart")),
		mcp.WithString("service", mcp.Description("服务名，get/start/stop/restart 需要")),
		mcp.WithObject("request", mcp.Description("StartRequest：至少 advertisedHost，可传 bindHost/ports/options")),
		mcp.WithBoolean("confirm", mcp.Description("start/stop/restart 必须为 true")),
	), s.handleServices)
}

func (s *Server) handleListCalls(_ context.Context, r mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	limit := int(r.GetFloat("limit", 200))
	raw, err := json.Marshal(map[string]any{"calls": s.history.List(limit)})
	if err != nil {
		return mcp.NewToolResultError("序列化历史失败: " + err.Error()), nil
	}
	return mcp.NewToolResultText(string(raw)), nil
}

func (s *Server) handleGuide(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return s.run(ctx, []string{"ai"})
}

func (s *Server) handleInventory(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := []string{"ai", "bootstrap"}
	if s.cli.Server != "" {
		args = append(args, "--execution", "remote", "--server", s.cli.Server, "--token-env", "CHAINS_API_TOKEN")
	} else {
		args = append(args, "--execution", "local")
	}
	return s.run(ctx, args)
}

func (s *Server) handleDescribe(ctx context.Context, r mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	key := strings.TrimSpace(r.GetString("key", ""))
	kind := strings.TrimSpace(r.GetString("kind", ""))
	if key == "" {
		return mcp.NewToolResultError("缺少 key"), nil
	}
	switch kind {
	case "gadget", "payload":
		return s.run(ctx, []string{"describe", kind, key})
	case "":
		raw, err := s.run(ctx, []string{"describe", "gadget", key})
		if err == nil && !failed(raw) {
			return raw, nil
		}
		return s.run(ctx, []string{"describe", "payload", key})
	default:
		return mcp.NewToolResultError("kind 只能是 gadget / payload"), nil
	}
}

func (s *Server) handleGenerate(ctx context.Context, r mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	payload := strings.TrimSpace(r.GetString("payload", ""))
	chain := strings.TrimSpace(r.GetString("chain", ""))
	if payload == "" || chain == "" {
		return mcp.NewToolResultError("缺少 payload 或 chain"), nil
	}
	out, err := s.cli.Artifact(r.GetString("out", ""))
	if err != nil {
		return mcp.NewToolResultError("产物路径非法: " + err.Error()), nil
	}
	args := []string{"generate", "--payload", payload, "--chain", chain, "--out", out, "--out-format", "raw"}
	for _, arg := range r.GetStringSlice("args", nil) {
		args = append(args, "--arg", arg)
	}
	if encode := strings.TrimSpace(r.GetString("encode", "")); encode != "" {
		args = append(args, "--encode", encode)
	}
	return s.run(ctx, s.cli.WithExecution(args))
}

func (s *Server) handleGeneratePreset(ctx context.Context, r mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	preset := strings.TrimSpace(r.GetString("preset_id", ""))
	payload := strings.TrimSpace(r.GetString("payload", ""))
	if preset == "" || payload == "" {
		return mcp.NewToolResultError("缺少 preset_id 或 payload"), nil
	}
	if s.cli.Server == "" {
		return mcp.NewToolResultError("preset 生成需要 CHAINS_SERVER；离线模式请用 chains_generate 自由链"), nil
	}
	out, err := s.cli.Artifact(r.GetString("out", ""))
	if err != nil {
		return mcp.NewToolResultError("产物路径非法: " + err.Error()), nil
	}
	inputs := r.GetStringSlice("inputs", nil)
	encode := strings.TrimSpace(r.GetString("encode", ""))
	args := []string{"generate", "preset", "--preset-id", preset, "--payload", payload, "--out", out, "--out-format", "raw"}
	for _, input := range inputs {
		args = append(args, "--input", input)
	}
	if encode != "" {
		args = append(args, "--encode", encode)
	}
	raw, err := s.cli.Invocation(s.cli.WithExecution(args))
	if err == nil && !cliFailed(raw) {
		return resultText(raw)
	}
	// Preset metadata is readable with a read-only token even when the remote
	// generate endpoint is not available. Expand the preset to a local chain.
	if s.cli.Server != "" {
		if local, fallbackErr := s.generatePresetLocal(preset, payload, inputs, out, encode); fallbackErr == nil {
			return resultText(local)
		} else if err == nil {
			err = fallbackErr
		}
	}
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return resultText(raw)
}

func (s *Server) handleValidate(ctx context.Context, r mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	chain := strings.TrimSpace(r.GetString("chain", ""))
	if chain == "" {
		return mcp.NewToolResultError("缺少 chain"), nil
	}
	parts := strings.Split(chain, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	body, _ := json.Marshal(map[string]any{
		"chain":               parts,
		"requirePayloadStart": true,
		"requireEnd":          true,
	})
	file, err := os.CreateTemp("", "chains-validate-*.json")
	if err != nil {
		return mcp.NewToolResultError("创建校验请求失败: " + err.Error()), nil
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err := file.Write(body); err != nil {
		file.Close()
		return mcp.NewToolResultError("写入校验请求失败: " + err.Error()), nil
	}
	file.Close()
	return s.run(ctx, s.cli.WithExecution([]string{"chain", "validate", "--request", name}))
}

func (s *Server) handleExec(ctx context.Context, r mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := r.GetStringSlice("cli_args", nil)
	if len(args) == 0 {
		return mcp.NewToolResultError("缺少 cli_args"), nil
	}
	timeout := time.Duration(r.GetFloat("timeout_sec", 120)) * time.Second
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	raw, err := s.cli.InvocationWithTimeout(args, timeout)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return resultText(raw)
}

func (s *Server) handleServices(ctx context.Context, r mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if s.cli.Server == "" {
		return mcp.NewToolResultError("未配置 CHAINS_SERVER，无法管理远端服务"), nil
	}
	action := strings.TrimSpace(r.GetString("action", ""))
	service := strings.TrimSpace(r.GetString("service", ""))
	args := []string{"services", action}
	if service != "" {
		args = append(args, service)
	}
	if action == "start" || action == "stop" || action == "restart" {
		if !r.GetBool("confirm", false) {
			return mcp.NewToolResultError("启停远端服务需要 confirm=true"), nil
		}
		request, _ := r.GetArguments()["request"].(map[string]any)
		if action != "stop" && (request == nil || request["advertisedHost"] == nil) {
			return mcp.NewToolResultError("start/restart 需要 request.advertisedHost（目标可达的地址）"), nil
		}
		if request != nil {
			file, err := os.CreateTemp("", "chains-service-*.json")
			if err != nil {
				return mcp.NewToolResultError("创建服务请求失败: " + err.Error()), nil
			}
			name := file.Name()
			defer os.Remove(name)
			if err := json.NewEncoder(file).Encode(request); err != nil {
				file.Close()
				return mcp.NewToolResultError("写入服务请求失败: " + err.Error()), nil
			}
			file.Close()
			args = append(args, "--request", name)
		}
		args = append(args, "--yes")
	}
	return s.run(ctx, s.cli.WithRemote(args))
}

func (s *Server) run(ctx context.Context, args []string) (*mcp.CallToolResult, error) {
	raw, err := s.cli.Invocation(args)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return resultText(raw)
}

type presetInventory struct {
	Data struct {
		Live struct {
			Presets struct {
				Presets []presetDefinition `json:"presets"`
			} `json:"presets"`
		} `json:"live"`
	} `json:"data"`
}

type presetDefinition struct {
	ID    string `json:"id"`
	Chain []struct {
		Gadget string         `json:"gadget"`
		Args   map[string]any `json:"args"`
	} `json:"chain"`
	Inputs []struct {
		Key          string `json:"key"`
		DefaultValue any    `json:"defaultValue"`
		Targets      []struct {
			Step  string `json:"step"`
			Field string `json:"field"`
		} `json:"targets"`
	} `json:"inputs"`
}

func (s *Server) generatePresetLocal(presetID, payload string, inputs []string, out, encode string) ([]byte, error) {
	raw, err := s.cli.Invocation([]string{"ai", "bootstrap", "--execution", "remote", "--server", s.cli.Server, "--token-env", "CHAINS_API_TOKEN"})
	if err != nil {
		return nil, err
	}
	var inventory presetInventory
	if err := json.Unmarshal(raw, &inventory); err != nil {
		return nil, err
	}
	var preset *presetDefinition
	for i := range inventory.Data.Live.Presets.Presets {
		if inventory.Data.Live.Presets.Presets[i].ID == presetID {
			preset = &inventory.Data.Live.Presets.Presets[i]
			break
		}
	}
	if preset == nil {
		return nil, fmt.Errorf("preset 不存在: %s", presetID)
	}
	values := map[string]string{}
	for _, input := range preset.Inputs {
		if input.DefaultValue != nil {
			values[input.Key] = fmt.Sprint(input.DefaultValue)
		}
	}
	for _, line := range inputs {
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	// Input key -> chain step -> gadget.field.
	argsByStep := map[string]map[string]string{}
	for _, input := range preset.Inputs {
		for _, target := range input.Targets {
			if target.Step == "" || target.Field == "" {
				continue
			}
			if argsByStep[target.Step] == nil {
				argsByStep[target.Step] = map[string]string{}
			}
			argsByStep[target.Step][target.Field] = values[input.Key]
		}
	}
	gadgets := make([]string, 0, len(preset.Chain))
	args := []string{}
	for _, step := range preset.Chain {
		gadgets = append(gadgets, step.Gadget)
		merged := map[string]string{}
		for key, value := range step.Args {
			merged[key] = fmt.Sprint(value)
		}
		for key, value := range argsByStep[step.Gadget] {
			if value != "" {
				merged[key] = value
			}
		}
		keys := make([]string, 0, len(merged))
		for key := range merged {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			args = append(args, "--arg", step.Gadget+"."+key+"="+merged[key])
		}
	}
	generateArgs := []string{"generate", "--execution", "local", "--payload", payload, "--chain", strings.Join(gadgets, ","), "--out", out, "--out-format", "raw"}
	for _, arg := range args {
		generateArgs = append(generateArgs, arg)
	}
	if encode != "" {
		generateArgs = append(generateArgs, "--encode", encode)
	}
	return s.cli.Invocation(generateArgs)
}

func cliFailed(raw []byte) bool {
	var probe struct {
		Success *bool `json:"success"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return false
	}
	return probe.Success != nil && !*probe.Success
}

func resultText(raw []byte) (*mcp.CallToolResult, error) {
	var probe struct {
		Success *bool `json:"success"`
		Error   any   `json:"error"`
	}
	_ = json.Unmarshal(raw, &probe)
	if probe.Success != nil && !*probe.Success {
		message := strings.TrimSpace(string(raw))
		return mcp.NewToolResultError("Java Chains 返回失败: " + message), nil
	}
	return mcp.NewToolResultText(string(raw)), nil
}

func failed(result *mcp.CallToolResult) bool {
	return result != nil && result.IsError
}
