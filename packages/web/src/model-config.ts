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
/** Separate provider entry for the engineering-mode commander; may point at a cheaper model. */
export const ZG_COMMANDER_PROVIDER_ID = "zg-commander";

/** Bearer placeholder for unauthenticated endpoints; written so Pi treats the provider as credentialed. */
export const NO_AUTH_PLACEHOLDER_KEY = "zgagent-no-auth";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

/**
 * Capabilities declared for the configured model. Pi drops image attachments for
 * models whose `input` omits "image" (the provider-model default is text only), so
 * a vision-capable endpoint must opt in here or screenshots never reach it. A
 * text-only endpoint that receives an image reports it upstream.
 */
const DEFAULT_MODEL_INPUT = ["text", "image"];

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
	return readProviderConfig(agentDir, ZG_PROVIDER_ID);
}

/**
 * The commander's endpoint. When none is configured the engine falls back to
 * the main endpoint, so engineering mode works out of the box.
 */
export function readCommanderModelConfig(agentDir: string): ZGModelConfig | null {
	return readProviderConfig(agentDir, ZG_COMMANDER_PROVIDER_ID);
}

export function writeCommanderModelConfig(agentDir: string, config: ZGModelConfig | null): void {
	// null removes the commander entry, which restores the fallback to the main endpoint.
	if (config === null) {
		const path = modelsJsonPath(agentDir);
		if (!existsSync(path)) return;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelsJson;
			if (parsed.providers) delete parsed.providers[ZG_COMMANDER_PROVIDER_ID];
			writeFileSync(path, `${JSON.stringify(parsed, null, "\t")}\n`, { mode: 0o600 });
		} catch {
			// A corrupt file is left alone; the fallback endpoint still works.
		}
		return;
	}
	writeProviderConfig(agentDir, ZG_COMMANDER_PROVIDER_ID, "ZGAgent Commander", config);
}

function readProviderConfig(agentDir: string, providerId: string): ZGModelConfig | null {
	const path = modelsJsonPath(agentDir);
	if (!existsSync(path)) return null;
	let parsed: ModelsJson;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelsJson;
	} catch {
		return null;
	}
	const provider = parsed.providers?.[providerId];
	const model = provider?.models?.[0];
	if (!provider?.baseUrl || !model || typeof model.id !== "string") return null;
	return {
		baseUrl: provider.baseUrl,
		apiKey: provider.apiKey ?? "",
		modelId: model.id,
	};
}

function writeProviderConfig(agentDir: string, providerId: string, name: string, config: ZGModelConfig): void {
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
	const previous = parsed.providers[providerId];
	parsed.providers[providerId] = {
		name,
		baseUrl: config.baseUrl,
		// Pi requires a credential before it will prompt. Unauthenticated local
		// endpoints get a placeholder bearer, which they ignore (same trick the
		// pi docs recommend for Ollama). An empty string would be invalid.
		apiKey: config.apiKey || NO_AUTH_PLACEHOLDER_KEY,
		api: "openai-completions",
		...(previous?.headers ? { headers: previous.headers } : {}),
		models: [
			{
				id: config.modelId,
				name: config.modelId,
				contextWindow: DEFAULT_CONTEXT_WINDOW,
				maxTokens: DEFAULT_MAX_TOKENS,
				// An operator-edited capability list is kept as-is.
				input: previous?.models?.[0]?.input ?? DEFAULT_MODEL_INPUT,
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

/** Persist the endpoint config, merging into any existing models.json. */
export function writeModelConfig(agentDir: string, config: ZGModelConfig): void {
	writeProviderConfig(agentDir, ZG_PROVIDER_ID, "ZGAgent Endpoint", config);
}
