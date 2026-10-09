/**
 * Endpoint probing for the ZGAgent model configuration screen.
 *
 * Sends a minimal OpenAI-compatible chat request against a candidate config
 * (without saving it) and turns failures into actionable Chinese diagnostics.
 */

import type { ZGModelConfig, ZGTestResult } from "./protocol.ts";

const PROBE_TIMEOUT_MS = 10000;

function chatUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export async function testModelConfig(config: ZGModelConfig): Promise<ZGTestResult> {
	if (!config.baseUrl.trim() || !config.modelId.trim()) {
		return { ok: false, message: "Base URL 和模型 ID 不能为空" };
	}
	const url = chatUrl(config.baseUrl);
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
			},
			body: JSON.stringify({
				model: config.modelId,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 1,
				stream: false,
			}),
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
	} catch (error) {
		const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : "";
		if (error instanceof Error && error.name === "TimeoutError") {
			return {
				ok: false,
				message: `连接超时（${PROBE_TIMEOUT_MS / 1000}s）：${url}`,
				detail: "端点无响应。确认服务已启动、地址端口正确；OpenAI 兼容路径通常以 /v1 结尾。",
			};
		}
		return {
			ok: false,
			message: `无法连接到 ${url}`,
			detail: `${cause || (error instanceof Error ? error.message : String(error))}\n常见原因：地址拼写错误、服务未启动、路径缺少 /v1。`,
		};
	}

	if (response.ok) {
		return {
			ok: true,
			message: `连接成功：端点可用，模型 ${config.modelId} 可调用。`,
		};
	}

	const bodyText = await response.text().catch(() => "");
	const detail = bodyText.slice(0, 400) || undefined;
	switch (response.status) {
		case 401:
		case 403:
			return {
				ok: false,
				message: `认证失败（HTTP ${response.status}）：API Key 无效或未填写。`,
				detail: "本地无鉴权端点请留空 API Key；中转服务请检查令牌。",
			};
		case 404:
			return {
				ok: false,
				message: `路径不存在（404）：${url}`,
				detail: "OpenAI 兼容端点通常需要在 Base URL 末尾加 /v1，例如 http://host:8000/v1。",
			};
		default: {
			if (bodyText.includes("model") && (bodyText.includes("not found") || bodyText.includes("does not exist"))) {
				return {
					ok: false,
					message: `端点可达，但模型 ${config.modelId} 不存在。`,
					detail: "请核对模型 ID（注意大小写和版本后缀）。",
				};
			}
			return {
				ok: false,
				message: `端点返回错误（HTTP ${response.status}）`,
				detail,
			};
		}
	}
}
