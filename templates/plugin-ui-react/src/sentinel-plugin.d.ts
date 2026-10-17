export interface SentinelPluginContext {
	plugin: { id: string; name: string; version: string; author: string };
	host: { id: string; name: string };
	project: string | null;
	tools: Array<{ name: string; description: string }>;
	configKeys: string[];
}

export interface SentinelPluginApi {
	readonly context: SentinelPluginContext;
	callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
	listArtifacts(): Promise<Array<{ path: string; size: number }>>;
	readArtifact(path: string, encoding?: "text" | "base64"): Promise<unknown>;
	getConfig(): Promise<Record<string, string>>;
	saveConfig(values: Record<string, string>): Promise<unknown>;
	storage: {
		get(key: string): Promise<string | null>;
		set(key: string, value: string): Promise<unknown>;
		delete(key: string): Promise<unknown>;
	};
}

declare global {
	interface Window {
		SentinelPlugin: {
			protocol: 1;
			connect(): Promise<SentinelPluginApi>;
		};
	}
}
