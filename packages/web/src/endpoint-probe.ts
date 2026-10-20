/**
 * Endpoint probing for the Full Chain Sentinel model configuration screen.
 *
 * Sends the protocol's minimal request (Chat Completions, Responses, Anthropic
 * Messages, or Gemini generateContent) against a candidate config without
 * saving it, and turns failures into actionable Chinese diagnostics.
 */

import { DEFAULT_MODEL_API } from "./model-config.ts";
import type { SentinelModelConfig, SentinelTestResult } from "./protocol.ts";

const PROBE_TIMEOUT_MS = 10000;
const PROBE_MAX_TOKENS = 64;

interface ProbeRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
	/** Shown in 404/connection diagnostics, where path conventions differ per protocol. */
	pathHint: string;
}

function buildProbe(config: SentinelModelConfig): ProbeRequest {
	const base = config.baseUrl.replace(/\/+$/, "");
	const apiKey = config.apiKey.trim();
	switch (config.capabilities?.api ?? DEFAULT_MODEL_API) {
		case "anthropic-messages":
			return {
				url: `${base}/v1/messages`,
				headers: {
					"content-type": "application/json",
					"anthropic-version": "2023-06-01",
					...(apiKey ? { "x-api-key": apiKey, authorization: `Bearer ${apiKey}` } : {}),
				},
				body: JSON.stringify({
					model: config.modelId,
					max_tokens: PROBE_MAX_TOKENS,
					messages: [{ role: "user", content: "ping" }],
				}),
				pathHint: "Anthropic 兼容端点的 Base URL 通常是根地址，请求路径固定为 /v1/messages。",
			};
		case "google-generative-ai":
			return {
				url: `${base}/models/${encodeURIComponent(config.modelId)}:generateContent`,
				headers: {
					"content-type": "application/json",
					...(apiKey ? { "x-goog-api-key": apiKey } : {}),
				},
				body: JSON.stringify({
					contents: [{ role: "user", parts: [{ text: "ping" }] }],
					generationConfig: { maxOutputTokens: PROBE_MAX_TOKENS },
				}),
				pathHint: "Google 兼容端点的 Base URL 通常以 /v1beta 结尾，模型 ID 会拼进路径。",
			};
		case "openai-responses":
			return {
				url: `${base}/responses`,
				headers: {
					"content-type": "application/json",
					...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
				},
				body: JSON.stringify({
					model: config.modelId,
					input: "ping",
					max_output_tokens: PROBE_MAX_TOKENS,
					stream: false,
				}),
				pathHint: "OpenAI 兼容端点通常需要 Base URL 以 /v1 结尾，该协议请求 /responses。",
			};
		default:
			return {
				url: `${base}/chat/completions`,
				headers: {
					"content-type": "application/json",
					...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
				},
				body: JSON.stringify({
					model: config.modelId,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
					stream: false,
				}),
				pathHint: "OpenAI 兼容端点通常需要 Base URL 以 /v1 结尾。",
			};
	}
}

export async function testModelConfig(config: SentinelModelConfig): Promise<SentinelTestResult> {
	if (!config.baseUrl.trim() || !config.modelId.trim()) {
		return { ok: false, message: "Base URL 和模型 ID 不能为空" };
	}
	const probe = buildProbe(config);
	let response: Response;
	try {
		response = await fetch(probe.url, {
			method: "POST",
			headers: probe.headers,
			body: probe.body,
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
	} catch (error) {
		const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : "";
		if (error instanceof Error && error.name === "TimeoutError") {
			return {
				ok: false,
				message: `连接超时（${PROBE_TIMEOUT_MS / 1000}s）：${probe.url}`,
				detail: `端点无响应。确认服务已启动、地址端口正确。${probe.pathHint}`,
			};
		}
		return {
			ok: false,
			message: `无法连接到 ${probe.url}`,
			detail: `${cause || (error instanceof Error ? error.message : String(error))}\n常见原因：地址拼写错误、服务未启动。${probe.pathHint}`,
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
				message: `路径不存在（404）：${probe.url}`,
				detail: probe.pathHint,
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
