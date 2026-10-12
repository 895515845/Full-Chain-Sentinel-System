/**
 * Provider entries in models.json.
 *
 * The file belongs to the Pi SDK: one provider per model-library entry, keyed by
 * the entry id, api "openai-completions". What the SDK schema has no place for
 * (display names, role assignments, the reviewer switch) lives in
 * model-library.json; see model-library.ts.
 *
 * Three ids are leftovers from the fixed-slot layout. `zg-endpoint` and
 * `zg-judge` are read only by the one-time migration, which reuses them as entry
 * ids so a downgrade still finds its slots. `zg-commander` is still live:
 * engineering mode keeps its own endpoint, configured in the engine page.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ZGModelConfig } from "./protocol.ts";

/** Legacy main-endpoint provider id. */
export const ZG_PROVIDER_ID = "zg-endpoint";
/** The engineering commander's own endpoint; may point at a cheaper model. */
export const ZG_COMMANDER_PROVIDER_ID = "zg-commander";
/** Legacy judge provider id. */
export const ZG_JUDGE_PROVIDER_ID = "zg-judge";

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

/** The commander's endpoint. When none is configured the engine falls back to the main role. */
export function readCommanderModelConfig(agentDir: string): ZGModelConfig | null {
	return readProviderModelConfig(agentDir, ZG_COMMANDER_PROVIDER_ID);
}

export function writeCommanderModelConfig(agentDir: string, config: ZGModelConfig | null): void {
	// null removes the commander entry, which restores the fallback to the main role.
	if (config === null) {
		removeProviderModelConfig(agentDir, ZG_COMMANDER_PROVIDER_ID);
		return;
	}
	writeProviderModelConfig(agentDir, ZG_COMMANDER_PROVIDER_ID, "ZGAgent Commander", config);
}

/** One provider entry, or null when it is missing or incomplete. */
export function readProviderModelConfig(agentDir: string, providerId: string): ZGModelConfig | null {
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

/** Write one provider entry, merging into any existing models.json. */
export function writeProviderModelConfig(
	agentDir: string,
	providerId: string,
	name: string,
	config: ZGModelConfig,
): void {
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

/** Drop one provider entry. A corrupt file is left alone. */
export function removeProviderModelConfig(agentDir: string, providerId: string): void {
	const path = modelsJsonPath(agentDir);
	if (!existsSync(path)) return;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelsJson;
		if (parsed.providers) delete parsed.providers[providerId];
		writeFileSync(path, `${JSON.stringify(parsed, null, "\t")}\n`, { mode: 0o600 });
	} catch {
		// A corrupt file is left alone; the endpoint still works.
	}
}
