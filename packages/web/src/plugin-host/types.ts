/**
 * Small shared types of the plugin host.
 *
 * The Docker runner is an interface so the host's lifecycle tests can drive the
 * state machine without a daemon, and so the production path stays the CLI.
 */

export interface DockerResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type DockerRunner = (args: string[], options?: { timeoutMs?: number }) => Promise<DockerResult>;

/** One `tools/call` outcome, as the console bridge forwards it. */
export interface McpToolOutcome {
	content: unknown[];
	isError: boolean;
	meta: unknown;
}
