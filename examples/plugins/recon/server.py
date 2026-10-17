#!/usr/bin/env python3
"""subfinder + naabu as one MCP plugin.

The wrapper is deliberately thin: it validates the arguments, runs the pinned
binary without a shell, writes the full output under /artifacts, and returns a
truncated summary plus the artifact path. A plugin that streams hundreds of
thousands of lines into the model is worse than one that writes a file and tells
the model where it is.

Arguments are validated before they reach the binary. `subprocess` without a
shell already prevents command injection, but a value starting with `-` would
still be parsed as a flag, so hosts and domains are restricted to characters that
cannot do that.
"""

import json
import os
import re
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "7801"))
ARTIFACTS = os.environ.get("PLUGIN_ARTIFACTS_DIR", "/artifacts")
DEFAULT_RATE = int(os.environ.get("PLUGIN_DEFAULT_RATE", "1000"))
PROTOCOL_VERSION = "2025-03-26"

DOMAIN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")
HOST = re.compile(r"^[A-Za-z0-9.:\[\]-]{1,255}$")
TOP_PORTS = re.compile(r"^\d{1,5}$")

TOOLS = [
    {
        "name": "subfinder_enum",
        "description": "用 subfinder 枚举一个域名的子域名，完整结果写入 /artifacts。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "domain": {"type": "string", "description": "根域名，例如 example.com"},
                "timeout_seconds": {"type": "number", "description": "子进程超时，默认 120，最大 600"},
            },
            "required": ["domain"],
        },
    },
    {
        "name": "naabu_scan",
        "description": "用 naabu 扫描主机的前 N 个端口，完整结果写入 /artifacts。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "host": {"type": "string", "description": "IP 或域名"},
                "top_ports": {"type": "string", "description": "端口数量，默认 100"},
                "rate": {"type": "number", "description": "每秒包数，默认取插件配置"},
                "timeout_seconds": {"type": "number", "description": "子进程超时，默认 180，最大 600"},
            },
            "required": ["host"],
        },
    },
]

SUMMARY_LINES = 300


def json_response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json; charset=utf-8")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def rpc_result(request_id, result):
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def rpc_error(request_id, code, message):
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def run_command(args, timeout):
    try:
        completed = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env={**os.environ, "NO_COLOR": "1"},
        )
        return completed.returncode, completed.stdout, completed.stderr
    except FileNotFoundError:
        return 127, "", f"{args[0]} 不在镜像里"
    except subprocess.TimeoutExpired:
        return 124, "", f"命令超过 {timeout} 秒"


def write_artifact(run_id, name, text):
    directory = os.path.join(ARTIFACTS, run_id)
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    return f"{run_id}/{name}"


def summarize(title, stdout, stderr, code):
    lines = stdout.splitlines()
    shown = lines[:SUMMARY_LINES]
    text = title + "\n" + "\n".join(shown)
    if len(lines) > len(shown):
        text += f"\n... 共 {len(lines)} 行，完整结果见产物"
    if code != 0:
        text += f"\n退出码 {code}: {stderr.strip()[:600]}"
    return text


def call_tool(name, args):
    run_id = time.strftime("run-%Y%m%d-%H%M%S")
    if name == "subfinder_enum":
        domain = str(args.get("domain", ""))
        if not DOMAIN.match(domain) or domain.startswith("-"):
            return {"isError": True, "content": [{"type": "text", "text": "domain 非法"}]}
        timeout = min(600, max(5, int(args.get("timeout_seconds") or 120)))
        code, stdout, stderr = run_command(
            ["subfinder", "-d", domain, "-silent", "-no-color", "-timeout", "30"],
            timeout,
        )
        artifact = write_artifact(run_id, "subfinder.txt", stdout)
        return {
            "content": [{"type": "text", "text": summarize(f"subfinder {domain}", stdout, stderr, code)}],
            "_meta": {"artifacts": [artifact]},
        }
    if name == "naabu_scan":
        host = str(args.get("host", ""))
        if not HOST.match(host) or host.startswith("-"):
            return {"isError": True, "content": [{"type": "text", "text": "host 非法"}]}
        top_ports = str(args.get("top_ports") or "100")
        if not TOP_PORTS.match(top_ports):
            return {"isError": True, "content": [{"type": "text", "text": "top_ports 必须是数字"}]}
        rate = min(100000, max(1, int(args.get("rate") or DEFAULT_RATE)))
        timeout = min(600, max(5, int(args.get("timeout_seconds") or 180)))
        code, stdout, stderr = run_command(
            ["naabu", "-host", host, "-top-ports", top_ports, "-rate", str(rate), "-silent", "-no-color"],
            timeout,
        )
        artifact = write_artifact(run_id, "naabu.txt", stdout)
        return {
            "content": [{"type": "text", "text": summarize(f"naabu {host} top {top_ports}", stdout, stderr, code)}],
            "_meta": {"artifacts": [artifact]},
        }
    return None


def handle_rpc(message):
    if not isinstance(message, dict):
        return rpc_error(None, -32600, "invalid request")
    request_id = message.get("id")
    method = message.get("method")
    if method == "initialize":
        requested = (message.get("params") or {}).get("protocolVersion")
        return rpc_result(
            request_id,
            {
                "protocolVersion": requested or PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "sentinel-recon", "version": "0.1.0"},
            },
        )
    if method == "ping":
        return rpc_result(request_id, {})
    if method == "tools/list":
        return rpc_result(request_id, {"tools": TOOLS})
    if method == "tools/call":
        params = message.get("params") or {}
        called = call_tool(params.get("name"), params.get("arguments") or {})
        if called is None:
            return rpc_error(request_id, -32602, f"unknown tool {params.get('name')}")
        return rpc_result(request_id, called)
    if method in ("resources/list", "prompts/list"):
        key = "resources" if method == "resources/list" else "prompts"
        return rpc_result(request_id, {key: []})
    if request_id is None:
        return None
    return rpc_error(request_id, -32601, f"method not found: {method}")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)

    def do_GET(self):
        if self.path == "/healthz":
            json_response(self, 200, {"ok": True})
            return
        json_response(self, 404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/mcp":
            json_response(self, 404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            json_response(self, 400, rpc_error(None, -32700, "parse error"))
            return
        if isinstance(payload, list):
            answers = [answer for answer in (handle_rpc(entry) for entry in payload) if answer is not None]
            if not answers:
                self.send_response(202)
                self.send_header("content-length", "0")
                self.end_headers()
                return
            json_response(self, 200, answers)
            return
        answer = handle_rpc(payload)
        if answer is None:
            self.send_response(202)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        json_response(self, 200, answer)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"recon plugin listening on :{PORT}", flush=True)
    server.serve_forever()
