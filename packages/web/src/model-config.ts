/**
 * OpenAI-compatible endpoint configuration stored in models.json.
 *
 * ZGAgent drives a self-hosted or proxied endpoint declared under the provider
 * id "zg-endpoint" with api "openai-completions". Other providers in the file
 * are preserved on write.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ZGModelConfig } from "./protocol.ts";

export const ZG_PROVIDER_ID = "zg-endpoint";

/** Bearer placeholder for unauthenticated endpoints; written so Pi treats the provider as credentialed. */
export const NO_AUTH_PLACEHOLDER_KEY = "zgagent-no-auth";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

interface ModelsJson {
	$schema?: string;
	providers: Record<
		string,
		{
			name?: string;
			baseUrl?: string;
			apiKey?: string;
			api?: string;
			headers?: Record<string, string>;
			models?: Array<Record<string, unknown>>;
			[k: string]: unknown;
		}
	>;
}

export function modelsJsonPath(agentDir: string): string {
	return `${agentDir}/models.json`;
}

/** Read the persisted endpoint config, if a model entry exists. */
export function readModelConfig(agentDir: string): ZGModelConfig | null {
	const path = modelsJsonPath(agentDir);
	if (!existsSync(path)) return null;
	let parsed: ModelsJson;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelsJson;
	} catch {
		return null;
	}
	const provider = parsed.providers?.[ZG_PROVIDER_ID];
	const model = provider?.models?.[0];
	if (!provider?.baseUrl || !model || typeof model.id !== "string") return null;
	return {
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKey ?? "",
		modelId: model.id,
	};
}

/** Persist the endpoint config, merging into any existing models.json. */
export function writeModelConfig(agentDir: string, config: ZGModelConfig): void {
	const path = modelsJsonPath(agentDir);
	let parsed: ModelsJson = { providers: {} };
	if (existsSync(path)) {
		try {
			parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelsJson;
		} catch {
			parsed = { providers: {} };
		}
	}
	if (!parsed.providers || typeof parsed.providers !== "object") parsed.providers = {};
	parsed.providers[ZG_PROVIDER_ID] = {
		name: "ZGAgent Endpoint",
		baseUrl: config.baseUrl,
		// Pi requires a credential before it will prompt. Unauthenticated local
		// endpoints get a placeholder bearer, which they ignore (same trick the
		// pi docs recommend for Ollama). An empty string would be invalid.
		apiKey: config.apiKey || NO_AUTH_PLACEHOLDER_KEY,
		api: "openai-completions",
		...(parsed.providers[ZG_PROVIDER_ID]?.headers ? { headers: parsed.providers[ZG_PROVIDER_ID]?.headers } : {}),
		models: [
			{
				id: config.modelId,
				name: config.modelId,
				contextWindow: DEFAULT_CONTEXT_WINDOW,
				maxTokens: DEFAULT_MAX_TOKENS,
			},
		],
	};
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(parsed, null, "\t")}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// chmod is best-effort (some filesystems reject it)
	}
}
