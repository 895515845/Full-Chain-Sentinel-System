/**
 * End-to-end smoke test for the ZGAgent web console.
 *
 * Drives the full stack without external services: a local fake OpenAI-compatible
 * endpoint serves scripted responses, the server runs against a temp agent dir,
 * and a WebSocket client plays the operator. Verifies the two core behaviors:
 * review-mode approval with command editing, and auto-mode passthrough.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import { writeModelConfig } from "../src/model-config.ts";
import type { ZGClientMessage, ZGServerMessage, ZGStateSnapshot } from "../src/protocol.ts";
import { startZGServer } from "../src/server.ts";

/** Scripted assistant turns the fake endpoint serves in order. */
type ScriptStep = {
	toolCallCommand?: string;
	secondToolCallCommand?: string;
	text?: string;
	spawnAgent?: { task: string; mode: "explore" | "act" };
};

const SCRIPT: ScriptStep[] = [
	{ toolCallCommand: "echo zg-original-command" },
	{ text: "REVIEW_RUN_COMPLETE" },
	{ toolCallCommand: "echo zg-auto-command" },
	{ text: "AUTO_RUN_COMPLETE" },
	{ toolCallCommand: "echo zg-batch-a", secondToolCallCommand: "echo zg-batch-b" },
	{ text: "BATCH_COMPLETE" },
	{ toolCallCommand: "echo zg-whitelisted-a" },
	{ text: "WHITELIST_FIRST_COMPLETE" },
	{ toolCallCommand: "echo zg-whitelisted-b" },
	{ text: "WHITELIST_SECOND_COMPLETE" },
	// Sub-agent scenario: parent spawns (act mode), sub-agent runs bash, both finish.
	{ spawnAgent: { task: "recon the target", mode: "act" } },
	{ toolCallCommand: "echo zg-subagent-command" },
	{ text: "SUBAGENT_DONE" },
	{ text: "PARENT_SUMMARY" },
	{ text: "SECOND_SESSION_PING" },
	{ text: "FORK_TURN" },
];

let endpoint: Server;
let endpointPort = 0;
let tempRoot = "";
let closeServer: (() => void) | undefined;
let serverUrl = "";
let ws: WebSocket | undefined;
/** Body of the most recent completion request, for asserting what reached the model. */
let lastRequestBody = "";
/** The out-of-band image response is served once, then the script resumes. */
let imageTurnServed = false;

function sseChunk(payload: Record<string, unknown>): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function functionCall(id: string, name: string, args: Record<string, unknown>, index = 0) {
	return {
		index,
		id: `call_${id}${index > 0 ? `_${index}` : ""}`,
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
	};
}

function toolCallResponse(id: string, command: string, secondCommand?: string): string {
	// OpenAI wire format: `arguments` is a JSON *string* containing the args object.
	const calls = [
		functionCall(id, "bash", { command }),
		...(secondCommand ? [functionCall(id, "bash", { command: secondCommand }, 1)] : []),
	];
	return [
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
		}),
		...calls.map((call) =>
			sseChunk({
				id,
				object: "chat.completion.chunk",
				choices: [
					{
						index: 0,
						delta: { tool_calls: [call] },
						finish_reason: null,
					},
				],
			}),
		),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		}),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		}),
		"data: [DONE]\n\n",
	].join("");
}

function spawnAgentResponse(id: string, task: string, mode: "explore" | "act"): string {
	const call = functionCall(id, "spawn_agent", { task, mode });
	return [
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
		}),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }],
		}),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		}),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		}),
		"data: [DONE]\n\n",
	].join("");
}

function textResponse(id: string, text: string): string {
	return [
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
		}),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
		}),
		sseChunk({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
		sseChunk({
			id,
			object: "chat.completion.chunk",
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		}),
		"data: [DONE]\n\n",
	].join("");
}

let requestCount = 0;

function startFakeEndpoint(): Promise<void> {
	endpoint = createHttpServer((request, response) => {
		if (!(request.method === "POST" && request.url?.includes("/chat/completions"))) {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			// Consume the request so keep-alive does not stall.
			lastRequestBody = body;
			// An image turn answers out of band so it does not consume a scripted step.
			// Only the first request carrying an image is special-cased: the image stays
			// in the session history, so later requests also mention one.
			const isImageTurn = !imageTurnServed && body.includes("image_url");
			if (isImageTurn) imageTurnServed = true;
			const step = isImageTurn ? { text: "IMAGE_TURN_OK" } : (SCRIPT[requestCount] ?? SCRIPT[SCRIPT.length - 1]);
			const id = `chatcmpl-${isImageTurn ? "image" : ++requestCount}`;
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.end(
				step.toolCallCommand
					? toolCallResponse(id, step.toolCallCommand, step.secondToolCallCommand)
					: step.spawnAgent
						? spawnAgentResponse(id, step.spawnAgent.task, step.spawnAgent.mode)
						: textResponse(id, step.text ?? ""),
			);
		});
	});
	return new Promise((resolve) => {
		endpoint.listen(0, "127.0.0.1", () => {
			endpointPort = (endpoint.address() as { port: number }).port;
			resolve();
		});
	});
}

/** Queue of incoming server messages plus waiters. */
const incoming: ZGServerMessage[] = [];
const waiters: Array<{
	predicate: (message: ZGServerMessage) => boolean;
	resolve: (message: ZGServerMessage) => void;
}> = [];

function dispatch(message: ZGServerMessage): void {
	console.error(`[dispatch] ${message.type} waiters=${waiters.length} incoming=${incoming.length}`);
	const index = waiters.findIndex((waiter) => waiter.predicate(message));
	if (index >= 0) {
		const [waiter] = waiters.splice(index, 1);
		waiter.resolve(message);
		return;
	}
	incoming.push(message);
}

function waitFor(predicate: (message: ZGServerMessage) => boolean, timeoutMs = 30000): Promise<ZGServerMessage> {
	const index = incoming.findIndex(predicate);
	if (index >= 0) {
		const [message] = incoming.splice(index, 1);
		return Promise.resolve(message);
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			const position = waiters.indexOf(waiter);
			if (position >= 0) waiters.splice(position, 1);
			void fetch(`${serverUrl}/api/health`)
				.then((r) => r.text())
				.then((t) => console.log("DIAG health during timeout:", t))
				.catch((e) => console.log("DIAG health failed:", String(e)));
			reject(
				new Error(
					`Timed out (ws readyState=${ws?.readyState}). Received: ${JSON.stringify(
						incoming.map((message) =>
							message.type === "snapshot"
								? {
										type: "snapshot",
										mode: message.snapshot.mode,
										streaming: message.snapshot.streaming,
										approvals: message.snapshot.pendingApprovals.map((a) => a.command),
										toolText: toolResultText(message.snapshot).slice(0, 120),
										messages: message.snapshot.messages.length,
									}
								: message.type === "session_event"
									? {
											type: "session_event",
											event: (message.event as { type?: string }).type,
											stop:
												(message.event as { message?: { stopReason?: string; errorMessage?: string } })
													.message?.stopReason ?? undefined,
											err:
												(
													message.event as { message?: { errorMessage?: string } }
												).message?.errorMessage?.slice(0, 200) ?? undefined,
										}
									: { type: message.type, ...(message.type === "error" ? { message: message.message } : {}) },
						),
						null,
						1,
					)}`,
				),
			);
		}, timeoutMs);
		const waiter = {
			predicate,
			resolve: (message: ZGServerMessage) => {
				clearTimeout(timer);
				resolve(message);
			},
		};
		waiters.push(waiter);
	});
}

function send(message: ZGClientMessage): void {
	ws?.send(JSON.stringify(message));
}

/** Drop buffered server messages so a new test only sees fresh state. */
function drainIncoming(): void {
	incoming.length = 0;
}

function snapshotWhere(predicate: (snapshot: ZGStateSnapshot) => boolean): Promise<ZGStateSnapshot> {
	return waitFor((message) => message.type === "snapshot" && predicate(message.snapshot)).then(
		(message) => (message as { snapshot: ZGStateSnapshot }).snapshot,
	);
}

function toolResultText(snapshot: ZGStateSnapshot): string {
	return snapshot.messages
		.filter((message) => (message as { role?: string }).role === "toolResult")
		.map((message) => {
			const content = (message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
			return content.map((block) => block.text ?? "").join("");
		})
		.join("\n");
}

beforeAll(async () => {
	await startFakeEndpoint();
	tempRoot = mkdtempSync(join(tmpdir(), "zgagent-web-e2e-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "workspace");
	mkdirSync(cwd, { recursive: true });
	writeModelConfig(agentDir, {
		baseUrl: `http://127.0.0.1:${endpointPort}/v1`,
		apiKey: "test-key",
		modelId: "zg-fake-model",
	});
	const started = await startZGServer({ cwd, agentDir, host: "127.0.0.1", port: 0 });
	closeServer = started.close;
	serverUrl = started.url;
	ws = new WebSocket(serverUrl.replace("http://", "ws://").concat("/ws"));
	ws.on("message", (data) => {
		const text = String(data);
		if (text.includes("sessions")) console.error(`[cli-dbg] recv ${text.length}B: ${text.slice(0, 60)}`);
		dispatch(JSON.parse(text) as ZGServerMessage);
	});
	await new Promise<void>((resolve, reject) => {
		if (!ws) throw new Error("no socket");
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
});

afterAll(() => {
	ws?.close();
	closeServer?.();
	endpoint?.close();
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test("starts configured with review mode and the custom endpoint model", async () => {
	send({ type: "get_state" });
	const snapshot = await snapshotWhere((snapshot_) => snapshot_.modelConfigured);
	expect(snapshot.mode).toBe("review");
	expect(snapshot.model?.provider).toBe("zg-endpoint");
	expect(snapshot.model?.id).toBe("zg-fake-model");
});

test("review mode gates bash, executes the edited command, and streams the final answer", async () => {
	drainIncoming();
	send({ type: "prompt", text: "run the recon echo" });

	const gated = await snapshotWhere((snapshot_) => snapshot_.pendingApprovals.length > 0);
	expect(gated.pendingApprovals[0]?.command).toContain("zg-original-command");

	send({
		type: "decide",
		decision: { id: gated.pendingApprovals[0]?.id ?? "", approved: true, command: "echo zg-edited-command" },
	});

	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming && snapshot_.pendingApprovals.length === 0 && toolResultText(snapshot_).length > 0,
	);
	expect(toolResultText(settled)).toContain("zg-edited-command");
	expect(toolResultText(settled)).not.toContain("zg-original-command");

	const finalText = settled.messages
		.filter((message) => (message as { role?: string }).role === "assistant")
		.map((message) =>
			((message as { content?: Array<{ type?: string; text?: string }> }).content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join(""),
		)
		.join("\n");
	expect(finalText).toContain("REVIEW_RUN_COMPLETE");
});

// Depends on the previous test having prompted: pi appends the system message on
// the first prompt, not at session creation.
test("the session keeps the default coding tools and lists them in the system prompt", async () => {
	drainIncoming();
	send({ type: "get_state" });
	const snapshot = await snapshotWhere((snapshot_) =>
		snapshot_.messages.some((message) => (message as { role?: string }).role === "system"),
	);
	const system = snapshot.messages.find((message) => (message as { role?: string }).role === "system") as
		| { sections?: Record<string, string> }
		| undefined;
	const tools = system?.sections?.tools ?? "";
	// The runtime replaces the base tool set to gate bash, so it must name the
	// default coding tools explicitly. Passing only bash leaves the session without
	// the file tools and drops every snippet except the custom tools'.
	for (const name of ["read", "bash", "edit", "write"]) {
		expect(tools).toContain(`- ${name}:`);
	}
	expect(tools).toContain("spawn_agent");
});

test("auto mode executes bash without approval", async () => {
	drainIncoming();
	send({ type: "set_mode", mode: "auto" });
	await snapshotWhere((snapshot_) => snapshot_.mode === "auto");

	send({ type: "prompt", text: "run it again" });

	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.mode === "auto" &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("AUTO_RUN_COMPLETE"),
					),
			),
	);
	expect(toolResultText(settled)).toContain("zg-auto-command");
	// No approval was ever requested in auto mode: no request broadcast arrived
	// while the run was active.
	expect(settled.pendingApprovals).toEqual([]);
});

test("queued approvals show every pending command and decide_all approves them all", async () => {
	drainIncoming();
	send({ type: "get_state" });
	const before = await snapshotWhere(() => true);
	if (before.mode !== "review") {
		send({ type: "set_mode", mode: "review" });
		await snapshotWhere((snapshot_) => snapshot_.mode === "review");
	}
	drainIncoming();
	send({ type: "prompt", text: "run both" });

	const gated = await snapshotWhere((snapshot_) => snapshot_.pendingApprovals.length >= 2);
	const commands = gated.pendingApprovals.map((request) => request.command).sort();
	expect(commands).toEqual(["echo zg-batch-a", "echo zg-batch-b"]);

	send({ type: "decide_all", approved: true });

	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.pendingApprovals.length === 0 &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("BATCH_COMPLETE"),
					),
			),
	);
	const text = toolResultText(settled);
	expect(text).toContain("zg-batch-a");
	expect(text).toContain("zg-batch-b");
});

test("alwaysAllowPrefix skips the queue for later commands with the same first word", async () => {
	drainIncoming();
	send({ type: "get_state" });
	const before = await snapshotWhere(() => true);
	if (before.mode !== "review") {
		send({ type: "set_mode", mode: "review" });
		await snapshotWhere((snapshot_) => snapshot_.mode === "review");
	}
	drainIncoming();
	send({ type: "prompt", text: "first whitelisted run" });
	const gated = await snapshotWhere((snapshot_) => snapshot_.pendingApprovals.length > 0);
	expect(gated.pendingApprovals[0]?.command).toContain("zg-whitelisted-a");

	send({
		type: "decide",
		decision: {
			id: gated.pendingApprovals[0]?.id ?? "",
			approved: true,
			command: "echo zg-whitelisted-a",
			alwaysAllowPrefix: true,
		},
	});

	const firstSettled = await snapshotWhere(
		(snapshot_) => !snapshot_.streaming && snapshot_.allowedPrefixes.includes("echo"),
	);
	expect(toolResultText(firstSettled)).toContain("zg-whitelisted-a");

	send({ type: "prompt", text: "second whitelisted run" });

	const secondSettled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("WHITELIST_SECOND_COMPLETE"),
					),
			),
	);
	// The second `echo` command never entered the approval queue.
	expect(secondSettled.pendingApprovals).toEqual([]);
	expect(toolResultText(secondSettled)).toContain("zg-whitelisted-b");

	// Cleanup: drop the prefix so later flows are not affected.
	send({ type: "remove_allowed_prefix", prefix: "echo" });
	await snapshotWhere((snapshot_) => !snapshot_.allowedPrefixes.includes("echo"));
});

test("saving a config with an empty API key keeps the model usable", async () => {
	drainIncoming();
	send({ type: "get_config" });
	const config = await waitFor((message) => message.type === "config").then(
		(message) => (message as { config: { baseUrl: string; apiKey: string; modelId: string } | null }).config,
	);
	expect(config).not.toBeNull();
	send({
		type: "save_config",
		config: { baseUrl: config?.baseUrl ?? "", apiKey: "", modelId: config?.modelId ?? "" },
	});
	const snapshot = await snapshotWhere((snapshot_) => snapshot_.modelConfigured === true);
	expect(snapshot.model?.id).toBe("zg-fake-model");
});

test("spawn_agent delegates to a sub-agent whose bash goes through the same approval gate", async () => {
	send({ type: "get_state" });
	const before = await snapshotWhere(() => true);
	if (before.mode !== "review") {
		send({ type: "set_mode", mode: "review" });
		await snapshotWhere((snapshot_) => snapshot_.mode === "review");
	}
	drainIncoming();
	send({ type: "prompt", text: "delegate recon" });

	// The sub-agent's bash command lands in the shared queue, labeled as sub-agent.
	const gated = await snapshotWhere((snapshot_) => snapshot_.pendingApprovals.length > 0);
	expect(gated.pendingApprovals[0]?.source).toBe("子代理");
	expect(gated.pendingApprovals[0]?.command).toContain("zg-subagent-command");

	send({
		type: "decide",
		decision: { id: gated.pendingApprovals[0]?.id ?? "", approved: true },
	});

	// The parent receives the sub-agent result and finishes with its summary.
	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string; toolName?: string }).role === "toolResult" &&
					(message as { toolName?: string }).toolName === "spawn_agent" &&
					JSON.stringify(message).includes("SUBAGENT_DONE"),
			) &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("PARENT_SUMMARY"),
					),
			),
	);
	// The spawn_agent result carries the sub-agent's run details. The approved
	// bash execution itself is proven by the sub-agent reaching its next turn
	// (SUBAGENT_DONE) — the loop only continues after a tool result.
	const spawnResult = settled.messages.find(
		(message) =>
			(message as { role?: string; toolName?: string }).role === "toolResult" &&
			(message as { toolName?: string }).toolName === "spawn_agent",
	);
	expect(JSON.stringify(spawnResult)).toContain('"turns":2');
});

test("an image attachment reaches the model and the turn completes", async () => {
	drainIncoming();
	// 4x4 PNG. pi re-encodes prompt images, so the assertion checks the wire shape
	// rather than the exact payload the operator sent.
	const png =
		"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR42mNUTX7NAANMDEgANwcASLQBeyNXiAIAAAAASUVORK5CYII=";
	send({
		type: "prompt",
		text: "look at this screenshot",
		images: [{ type: "image", data: png, mimeType: "image/png" }],
	});

	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("IMAGE_TURN_OK"),
					),
			),
	);
	// The image survived the wire hop and reached the provider as an OpenAI image part.
	expect(lastRequestBody).toContain('"type":"image_url"');
	expect(lastRequestBody).toContain("data:image/png;base64,");
	// The operator's own message keeps the attachment for rendering.
	const userMessage = settled.messages.find(
		(message) =>
			(message as { role?: string }).role === "user" && JSON.stringify(message).includes("look at this screenshot"),
	);
	expect(JSON.stringify(userMessage)).toContain('"type":"image"');
});

test("thinking level is reported, validated, and changeable", async () => {
	drainIncoming();
	send({ type: "get_state" });
	const snapshot = await snapshotWhere((snapshot_) => snapshot_.modelConfigured);
	expect(snapshot.availableThinkingLevels.length).toBeGreaterThan(0);
	expect(snapshot.availableThinkingLevels).toContain(snapshot.thinkingLevel);

	// A level the model does not accept is rejected instead of silently clamped.
	send({ type: "set_thinking_level", level: "max" });
	if (!snapshot.availableThinkingLevels.includes("max")) {
		const error = await waitFor((message) => message.type === "error" && message.message.includes("思考等级"));
		expect((error as { message: string }).message).toContain("max");
	}

	drainIncoming();
	send({ type: "set_thinking_level", level: snapshot.thinkingLevel });
	await snapshotWhere((snapshot_) => snapshot_.thinkingLevel === snapshot.thinkingLevel);
});

test("compact reports a readable message when the session has nothing to compact", async () => {
	drainIncoming();
	send({ type: "compact" });
	// The fake session is far below the compaction threshold, so pi refuses; the
	// point is that the refusal reaches the operator as a Chinese message.
	const error = await waitFor((message) => message.type === "error");
	expect((error as { message: string }).message).toContain("无需压缩");
});

test("sessions can be renamed and deleted from the sidebar", async () => {
	// An empty active session is intentionally not persisted, so operate on the
	// most recent listed session instead.
	send({ type: "list_sessions" });
	const listed = await waitFor((message) => message.type === "sessions");
	const sessions = (listed as { sessions: Array<{ path: string; id: string; name?: string }> }).sessions;
	expect(sessions.length).toBeGreaterThanOrEqual(1);
	const target = sessions[0];
	drainIncoming();

	// Rename.
	send({ type: "rename_session", path: target.path, name: "zg-renamed-session" });
	const renamed = await waitFor((message) => message.type === "sessions");
	expect(
		(renamed as { sessions: Array<{ path: string; name?: string }> }).sessions.some(
			(session) => session.path === target.path && session.name === "zg-renamed-session",
		),
	).toBe(true);

	// Delete it.
	drainIncoming();
	send({ type: "delete_session", path: target.path });
	const afterDelete = await waitFor((message) => message.type === "sessions");
	expect((afterDelete as { sessions: Array<{ path: string }> }).sessions.some((s) => s.path === target.path)).toBe(
		false,
	);

	// Foreign paths are rejected.
	drainIncoming();
	send({ type: "delete_session", path: "/etc/passwd" });
	await waitFor((message) => message.type === "error" && message.message.includes("拒绝"));
});
