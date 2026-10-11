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
import { DatabaseSync } from "node:sqlite";
import { getDefaultSessionDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import { writeModelConfig } from "../src/model-config.ts";
import type { ZGPermissionsConfig } from "../src/permissions.ts";
import type {
	ZGClientMessage,
	ZGFileEntry,
	ZGFilePreview,
	ZGServerMessage,
	ZGStateSnapshot,
	ZGSubagentEvent,
	ZGSubagentRun,
	ZGVulnerability,
} from "../src/protocol.ts";
import { startZGServer } from "../src/server.ts";
import { type FakeDocker, installFakeDocker, projectSlug } from "./fake-docker.ts";

/** Scripted assistant turns the fake endpoint serves in order. */
type ScriptStep = {
	toolCallCommand?: string;
	secondToolCallCommand?: string;
	text?: string;
	spawnAgent?: { task: string };
	/** A tool call the model makes by name, used for the hub's own tools. */
	toolCall?: { name: string; args: Record<string, unknown> };
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
	// Sub-agent scenario: parent spawns, the sub-agent runs bash, both finish.
	{ spawnAgent: { task: "recon the target" } },
	{ toolCallCommand: "echo zg-subagent-command" },
	{ text: "SUBAGENT_DONE" },
	{ text: "PARENT_SUMMARY" },
	{ text: "SECOND_SESSION_PING" },
	{ text: "FORK_TURN" },
];

/** Project the suite creates; its work directory backs the file-panel assertions. */
const PROJECT_NAME = "e2e-project";

/** Prompt that identifies the sub-agent scenario served out of band. */
const SECOND_SCENARIO_PROMPT = "delegate a read-only recon";
/** Task the sub-agent of that scenario receives. */
const SECOND_SCENARIO_TASK = "recon the second target";
/** Command the second scenario's sub-agent runs, to prove it can execute. */
const SECOND_SCENARIO_COMMAND = "echo zg-subagent-command-2";
/** Output marker of that command, used to detect its tool result. */
const SECOND_SCENARIO_OUTPUT = "zg-subagent-command-2";
/** Marker present in every sub-agent system prompt. */
const SUBAGENT_MARKER = "sub-agent of ZGAgent";

/**
 * Text vuln_submit returns; only used to assert what the tool answered.
 */
const VULN_SUBMITTED_MARKER = "已提交到漏洞中枢";

/** Prompt that only asks which tools the session mounted; answered out of band. */
const TOOLS_PROBE_PROMPT = "check the hub tools";
/** Marker text of that probe run. */
const TOOLS_PROBE_DONE = "TOOLS_PROBE_DONE";

/**
 * Compaction scenario. pi only summarizes when there is something to summarize,
 * so the session is filled past its keep-recent threshold with a few large
 * turns, and then the summarization request itself is held open: a model that
 * never answers is exactly the case where the console must show the wait and
 * offer a cancel.
 */
const COMPACT_FILL_PROMPT = "zg-compact-fill 写一份很长的报告";
const COMPACT_FILL_TEXT = "COMPACT_FILL_MARKER ".repeat(2500);
const COMPACT_FILL_DONE = "COMPACT_FILL_DONE";
/**
 * pi's own summarization prompts. A compaction that cuts inside a turn issues
 * two requests (the history, then the turn prefix), and both have to be stalled
 * for the wait to be the one the operator sees.
 */
const COMPACTION_PROMPT_MARKERS = ["a conversation to summarize", "earlier context from an ongoing conversation"];
const COMPACTION_SUMMARY_TEXT = "COMPACTION_SUMMARY";

/**
 * Hub scenarios, routed by prompt: the first turn calls vuln_submit, the second
 * (recognized by the title already sitting in the transcript) finishes the run.
 * The title doubles as the marker, so nothing depends on script position.
 */
const VULN_SCENARIOS = [
	{
		prompt: "submit the finding to the hub",
		done: "VULN_SUBMIT_DONE",
		args: {
			title: "后台登录处 SQL 注入",
			severity: "medium",
			cvss: 6.5,
			target: "http://10.10.10.5/admin/login",
			category: "SQL 注入",
			description: "登录参数拼接进 SQL，可用布尔盲注绕过认证。",
			packet: "POST /admin/login HTTP/1.1\nHost: 10.10.10.5\n\nuser=admin' AND 1=1--",
			evidence: [
				{
					kind: "command",
					command: "sqlmap -u http://10.10.10.5/admin/login --data user=admin",
					output: "parameter 'user' is vulnerable",
				},
			],
		},
	},
	{
		prompt: "submit a critical finding",
		done: "VULN_CRITICAL_DONE",
		args: {
			title: "命令注入",
			severity: "critical",
			cvss: 9.8,
			target: "http://10.10.10.5/ping",
			category: "命令注入",
			description: "cmd 参数直接进入 shell，可执行任意命令。",
			packet: "GET /ping?cmd=;id HTTP/1.1\nHost: 10.10.10.5",
		},
	},
] as const;

/**
 * Persistent-goal scenarios, routed by the objective sitting in the transcript.
 * A continuation is injected as a custom message, which the model receives as a
 * user message, so the newest user message is no longer the objective: the
 * scenarios match on the whole request body instead.
 */
const GOAL_COMPLETE_PROMPT = "zg-goal-complete 对 10.10.10.5 完成侦察";
const GOAL_LIMIT_PROMPT = "zg-goal-limit 完成全端口扫描";
const GOAL_NOPROGRESS_PROMPT = "zg-goal-noprogress 写出完整报告";
/** Text of the goal_progress tool result, used to recognize the second turn. */
const GOAL_PROGRESS_MARKER = "目标进度已更新";
/** Text of the goal_complete tool result, used to recognize the third turn. */
const GOAL_COMPLETED_MARKER = "目标已完成：";

/**
 * One turn of a goal scenario. The complete scenario reports progress, then
 * completes with the evidence and the criterion the test asked for; the other two
 * only ever answer with prose, which is what trips the budget and the fuse.
 */
function goalStep(body: string): ScriptStep | undefined {
	if (body.includes(GOAL_LIMIT_PROMPT)) return { text: "GOAL_LIMIT_ROUND" };
	if (body.includes(GOAL_NOPROGRESS_PROMPT)) return { text: "GOAL_IDLE_ROUND" };
	if (!body.includes(GOAL_COMPLETE_PROMPT)) return undefined;
	if (body.includes(GOAL_COMPLETED_MARKER)) return { text: "GOAL_COMPLETE_DONE" };
	if (body.includes(GOAL_PROGRESS_MARKER)) {
		return {
			toolCall: {
				name: "goal_complete",
				args: {
					summary: "侦察完成：开放 22/80，未发现可利用点",
					evidence: ["nmap -p- 10.10.10.5：22/tcp open ssh，80/tcp open http"],
					findings: { submitted: 0, note: "全端口扫描后只有默认配置，没有可提交的发现" },
					criteria: [{ criterion: "端口已确认", met: true, evidence: "nmap 输出" }],
				},
			},
		};
	}
	return {
		toolCall: {
			name: "goal_progress",
			args: { done: ["全端口扫描完成"], todo: ["确认 80 端口服务"], blockers: [] },
		},
	};
}

/** Tool names a goal request mounted, so the test can prove the tools are there. */
let goalTools: string[] = [];

let endpoint: Server;
let endpointPort = 0;
let tempRoot = "";
/** Agent directory of the running server; the hub's database lives here. */
let agentDir = "";
let closeServer: (() => void) | undefined;
let serverUrl = "";
let ws: WebSocket | undefined;
let fakeDocker: FakeDocker | undefined;
/** Host directory mounted at /work for the suite's project. */
let workDir = "";
/** Id of the suite's main project, so a test can return to it after switching. */
let mainProjectId = "";
/** Tool names a chat request advertised, in wire order. */
function toolNamesOf(body: string): string[] {
	let parsed: { tools?: Array<{ function?: { name?: string }; name?: string }> };
	try {
		parsed = JSON.parse(body) as typeof parsed;
	} catch {
		return [];
	}
	return (parsed.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? "").filter(Boolean);
}

/** Body of the most recent completion request, for asserting what reached the model. */
let lastRequestBody = "";
/** Tools the newest main-session request advertised. */
let mainTools: string[] = [];
/** Tools the newest sub-agent request advertised. */
let subagentTools: string[] = [];
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

function spawnAgentResponse(id: string, task: string): string {
	const call = functionCall(id, "spawn_agent", { task });
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

/** One named tool call, used to drive the hub's own tools without a real model. */
function namedToolCallResponse(id: string, name: string, args: Record<string, unknown>): string {
	const call = functionCall(id, name, args);
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

/** Text of the newest user message in a chat request. */
function lastUserText(body: string): string {
	let parsed: { messages?: Array<{ role?: string; content?: unknown }> };
	try {
		parsed = JSON.parse(body) as typeof parsed;
	} catch {
		return "";
	}
	const users = (parsed.messages ?? []).filter((message) => message.role === "user");
	const last = users[users.length - 1];
	if (!last) return "";
	if (typeof last.content === "string") return last.content;
	if (Array.isArray(last.content)) {
		return (last.content as Array<{ type?: string; text?: string }>)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join(" ");
	}
	return "";
}

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
			// A compaction's summarization request. `stallCompaction` holds it open
			// forever, which is what a slow or wedged endpoint looks like to pi.
			if (COMPACTION_PROMPT_MARKERS.some((marker) => body.includes(marker))) {
				compactionRequests += 1;
				if (stallCompaction) return;
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				response.end(textResponse("chatcmpl-summary", COMPACTION_SUMMARY_TEXT));
				return;
			}
			// An image turn answers out of band so it does not consume a scripted step.
			// Only the first request carrying an image is special-cased: the image stays
			// in the session history, so later requests also mention one.
			const isImageTurn = !imageTurnServed && body.includes("image_url");
			if (isImageTurn) imageTurnServed = true;
			// The second sub-agent scenario is routed by content rather than by script
			// index, so it does not depend on how many turns the earlier tests used.
			const fromSubagent = body.includes(SUBAGENT_MARKER);
			if (fromSubagent) subagentTools = toolNamesOf(body);
			else mainTools = toolNamesOf(body);
			const inSecondScenario = fromSubagent
				? body.includes(SECOND_SCENARIO_TASK)
				: body.includes(SECOND_SCENARIO_PROMPT);
			const newestPrompt = lastUserText(body);
			// Prompts answered with fixed text: they must not consume the shared
			// scripted steps, which every scenario in this file draws from in order.
			const staticStep: ScriptStep | undefined =
				newestPrompt === "notify me when this finishes"
					? { text: "NOTIFY_RUN_COMPLETE" }
					: newestPrompt === "force a notification"
						? { text: "FORCED_NOTIFY_COMPLETE" }
						: newestPrompt === "stay quiet"
							? { text: "QUIET_RUN_COMPLETE" }
							: newestPrompt === "label this session"
								? { text: "LABEL_RUN_DONE" }
								: undefined;
			// Hub scenarios: the first turn submits, the second recognizes its own
			// tool call (its target is echoed back in the transcript) and finishes.
			// A failed call ends the scenario too, so a disabled tool cannot make
			// the fake model loop on the same tool call forever.
			const vulnScenario = VULN_SCENARIOS.find((scenario) => newestPrompt === scenario.prompt);
			const vulnStep: ScriptStep | undefined = vulnScenario
				? body.includes(vulnScenario.args.target) || body.includes("Tool vuln_submit not found")
					? { text: vulnScenario.done }
					: { toolCall: { name: "vuln_submit", args: vulnScenario.args } }
				: undefined;
			const probeStep: ScriptStep | undefined =
				newestPrompt === TOOLS_PROBE_PROMPT ? { text: TOOLS_PROBE_DONE } : undefined;
			const compactFillStep: ScriptStep | undefined =
				newestPrompt === COMPACT_FILL_PROMPT ? { text: `${COMPACT_FILL_DONE}\n${COMPACT_FILL_TEXT}` } : undefined;
			const goal = goalStep(body);
			if (goal && !fromSubagent) goalTools = toolNamesOf(body);
			const step = isImageTurn
				? { text: "IMAGE_TURN_OK" }
				: staticStep
					? staticStep
					: vulnStep
						? vulnStep
						: probeStep
							? probeStep
							: compactFillStep
								? compactFillStep
								: goal
									? goal
									: inSecondScenario
										? fromSubagent
											? body.includes(SECOND_SCENARIO_OUTPUT)
												? { text: "SECOND_SUBAGENT_DONE" }
												: { toolCallCommand: SECOND_SCENARIO_COMMAND }
											: body.includes("SECOND_SUBAGENT_DONE")
												? { text: "SECOND_PARENT_SUMMARY" }
												: { spawnAgent: { task: SECOND_SCENARIO_TASK } }
										: (SCRIPT[requestCount] ?? SCRIPT[SCRIPT.length - 1]);
			if (!isImageTurn && !inSecondScenario && !staticStep && !vulnStep && !probeStep && !compactFillStep && !goal) {
				requestCount += 1;
			}
			const id = `chatcmpl-${isImageTurn ? "image" : staticStep ? "static" : vulnStep ? "vuln" : probeStep ? "probe" : compactFillStep ? "fill" : goal ? "goal" : inSecondScenario ? "second" : requestCount}`;
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			response.end(
				step.toolCall
					? namedToolCallResponse(id, step.toolCall.name, step.toolCall.args)
					: step.toolCallCommand
						? toolCallResponse(id, step.toolCallCommand, step.secondToolCallCommand)
						: step.spawnAgent
							? spawnAgentResponse(id, step.spawnAgent.task)
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

/** Notifications the fake DingTalk robot received. */
const dingtalk: Array<{ url: string; text: string; title: string }> = [];
let dingtalkServer: Server | undefined;
let dingtalkUrl = "";

/** Set while the test wants a summarization request to hang instead of answering. */
let stallCompaction = false;
/** Summarization requests the fake endpoint saw, so the test can prove one was made. */
let compactionRequests = 0;

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
										compacting: message.snapshot.compacting,
										compactionStartedAt: message.snapshot.compactionStartedAt,
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

function snapshotWhere(
	predicate: (snapshot: ZGStateSnapshot) => boolean,
	timeoutMs?: number,
): Promise<ZGStateSnapshot> {
	return waitFor((message) => message.type === "snapshot" && predicate(message.snapshot), timeoutMs).then(
		(message) => (message as { snapshot: ZGStateSnapshot }).snapshot,
	);
}

/** Wait past the point where a fire-and-forget webhook POST would have landed. */
function settleWebhook(ms = 800): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a local condition: used for out-of-band effects such as a webhook POST. */
function waitUntil(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const tick = (): void => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() - startedAt > timeoutMs) {
				reject(new Error("Timed out waiting for a local condition"));
				return;
			}
			setTimeout(tick, 50);
		};
		tick();
	});
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

/**
 * Run one hub scenario: the fake model calls vuln_submit, the record is pushed
 * to every console, and the run then finishes. Returns the submitted record as
 * the hub read it back.
 */
async function submitViaAgent(prompt: string, done: string): Promise<ZGVulnerability> {
	drainIncoming();
	send({ type: "prompt", text: prompt });

	// The console learns about the finding the moment it is created, before the
	// run ends: that is what makes the hub page live.
	const listed = await waitFor((message) => message.type === "vulns" && message.items.length > 0);
	const first = (listed as { items: Array<{ id: string }> }).items[0];
	expect(first).toBeDefined();

	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes(done),
					),
			),
	);
	// The tool itself answered, not just the scripted finish text.
	expect(toolResultText(settled)).toContain(VULN_SUBMITTED_MARKER);

	drainIncoming();
	send({ type: "get_vuln", id: first?.id ?? "" });
	const fetched = await waitFor((message) => message.type === "vuln");
	return (fetched as { vuln: ZGVulnerability }).vuln;
}

beforeAll(async () => {
	await startFakeEndpoint();
	// Plays the DingTalk custom robot: records the markdown it is sent.
	dingtalkServer = createHttpServer((request, response) => {
		let raw = "";
		request.on("data", (chunk: Buffer) => {
			raw += chunk.toString();
		});
		request.on("end", () => {
			const body = JSON.parse(raw) as { markdown?: { title?: string; text?: string } };
			dingtalk.push({
				url: request.url ?? "",
				text: body.markdown?.text ?? "",
				title: body.markdown?.title ?? "",
			});
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
		});
	});
	await new Promise<void>((resolve) => dingtalkServer?.listen(0, "127.0.0.1", resolve));
	const dingtalkAddress = dingtalkServer.address();
	const dingtalkPort = typeof dingtalkAddress === "object" && dingtalkAddress ? dingtalkAddress.port : 0;
	dingtalkUrl = `http://127.0.0.1:${dingtalkPort}/robot/send?access_token=e2e-token`;
	tempRoot = mkdtempSync(join(tmpdir(), "zgagent-web-e2e-"));
	agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "workspace");
	mkdirSync(cwd, { recursive: true });
	writeModelConfig(agentDir, {
		baseUrl: `http://127.0.0.1:${endpointPort}/v1`,
		apiKey: "test-key",
		modelId: "zg-fake-model",
	});
	// The console refuses to run without a project, and projects need a container.
	// The fake docker supplies one on PATH so the real container scripts still run.
	workDir = join(tempRoot, "projects", projectSlug(PROJECT_NAME));
	fakeDocker = installFakeDocker(tempRoot, workDir);
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

	// Create and enter the project every other test runs inside.
	send({ type: "add_project", name: PROJECT_NAME });
	const created = await waitFor((message) => message.type === "projects" && message.projects.length === 1);
	const projectId = (created as { projects: Array<{ id: string }> }).projects[0]?.id ?? "";
	expect(projectId).not.toBe("");
	mainProjectId = projectId;
	send({ type: "switch_project", id: projectId });
	const entered = await snapshotWhere((snapshot_) => snapshot_.project?.id === projectId);
	expect(entered.project?.name).toBe(PROJECT_NAME);
	drainIncoming();
});

afterAll(() => {
	ws?.close();
	closeServer?.();
	dingtalkServer?.close();
	endpoint?.close();
	fakeDocker?.restore();
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

// Runs after the sub-agent scenarios above, which is what puts a finished run in
// this session's history.
test("sub-agent runs stream live, keep their process, and stay readable as history", async () => {
	drainIncoming();
	send({ type: "prompt", text: "delegate a read-only recon" });

	// The panel is fed live, before the run finishes.
	const live = await waitFor((message) => message.type === "subagent_event");
	const liveEvent = (live as { event: ZGSubagentEvent }).event;
	expect(liveEvent.kind).toBeTruthy();
	expect(liveEvent.seq).toBeGreaterThan(0);

	// A sub-agent's command lands in the shared approval queue, labeled as a
	// sub-agent request.
	const gated = await snapshotWhere((snapshot_) => snapshot_.pendingApprovals.length > 0);
	expect(gated.pendingApprovals[0]?.source).toBe("子代理");
	expect(gated.pendingApprovals[0]?.command).toContain(SECOND_SCENARIO_OUTPUT);
	send({ type: "decide", decision: { id: gated.pendingApprovals[0]?.id ?? "", approved: true } });

	const settled = await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("SECOND_PARENT_SUMMARY"),
					),
			),
	);

	// The snapshot carries the run list for the active session, newest first.
	const runs = settled.subagents;
	expect(runs.length).toBeGreaterThanOrEqual(2);
	const newest = runs[0];
	expect(newest.status).toBe("done");
	expect(newest.task).toContain("recon the second target");
	expect(newest.turns).toBeGreaterThanOrEqual(1);
	// Summaries stay small: process steps are fetched per run.
	expect(newest.events).toBeUndefined();

	// Expanding one run loads its recorded process.
	send({ type: "get_subagent", id: newest.id });
	const loaded = await waitFor((message) => message.type === "subagent_run" && message.run.id === newest.id);
	const events = (loaded as { run: ZGSubagentRun }).run.events ?? [];
	expect(events[0]?.kind).toBe("status");
	expect(events.some((event) => event.kind === "turn")).toBe(true);
	// The sub-agent's command ran: the recorded process holds the bash call and
	// its output.
	expect(events.some((event) => event.kind === "tool_start" && event.toolName === "bash")).toBe(true);
	expect(
		events.some(
			(event) =>
				event.kind === "tool_end" &&
				event.toolName === "bash" &&
				(event.output ?? "").includes(SECOND_SCENARIO_OUTPUT),
		),
	).toBe(true);
	// The finished call carries how long it ran, which the panel shows next to it.
	const bashEnd = events.find((event) => event.kind === "tool_end" && event.toolName === "bash");
	expect(typeof bashEnd?.durationMs).toBe("number");
	expect(bashEnd?.durationMs).toBeGreaterThanOrEqual(0);
	expect(events.some((event) => event.kind === "text" && (event.text ?? "").includes("SECOND_SUBAGENT_DONE"))).toBe(
		true,
	);
	expect(events[events.length - 1]?.kind).toBe("status");
	expect(events[events.length - 1]?.status).toBe("done");

	// A sub-agent is offered the same tools as the session that spawned it, which
	// includes what the loaded extensions contribute. spawn_agent is the one
	// exception, and withholding it is what stops delegation from recursing.
	for (const name of ["read", "bash", "edit", "write", "codemode", "tool_search"]) {
		expect(subagentTools).toContain(name);
	}
	expect(subagentTools).not.toContain("spawn_agent");
	// The parent keeps it, so the difference is the sub-agent's, not a global one.
	expect(mainTools).toContain("spawn_agent");

	// The first scenario's run kept its tool calls, so a finished run is reviewable
	// long after its in-memory session was disposed.
	const firstRun = runs.find((run) => run.task.includes("recon the target"));
	expect(firstRun).toBeDefined();
	send({ type: "get_subagent", id: firstRun?.id ?? "" });
	const firstLoaded = await waitFor((message) => message.type === "subagent_run" && message.run.id === firstRun?.id);
	const firstEvents = (firstLoaded as { run: ZGSubagentRun }).run.events ?? [];
	const started = firstEvents.find((event) => event.kind === "tool_start" && event.toolName === "bash");
	expect(started).toBeDefined();
	const finished = firstEvents.find((event) => event.kind === "tool_end" && event.toolCallId === started?.toolCallId);
	expect(finished?.output ?? "").toContain("zg-subagent-command");

	// Reading it again returns the same steps: the record is durable, not a buffer.
	send({ type: "get_subagent", id: firstRun?.id ?? "" });
	const reread = await waitFor((message) => message.type === "subagent_run" && message.run.id === firstRun?.id);
	expect(((reread as { run: ZGSubagentRun }).run.events ?? []).length).toBe(firstEvents.length);
});

test("a finished sub-agent cannot be aborted or steered", async () => {
	drainIncoming();
	send({ type: "get_state" });
	const snapshot = await snapshotWhere((snapshot_) => snapshot_.subagents.length > 0);
	const done = snapshot.subagents.find((run) => run.status !== "running");
	expect(done).toBeDefined();

	send({ type: "abort_subagent", id: done?.id ?? "" });
	const aborted = await waitFor((message) => message.type === "subagent_result" && message.action === "中止");
	expect((aborted as { ok: boolean }).ok).toBe(false);

	send({ type: "steer_subagent", id: done?.id ?? "", text: "keep going" });
	const steered = await waitFor((message) => message.type === "subagent_result" && message.action === "追加指令");
	expect((steered as { ok: boolean }).ok).toBe(false);
});

test("the file panel reads and writes inside the container work directory", async () => {
	drainIncoming();
	const listWork = async (path: string): Promise<ZGFileEntry[]> => {
		send({ type: "list_files", path });
		const listed = await waitFor((message) => message.type === "files" && message.path === path);
		return (listed as { entries: ZGFileEntry[] }).entries;
	};
	const preview = async (path: string): Promise<ZGFilePreview> => {
		send({ type: "read_file", path });
		const read = await waitFor((message) => message.type === "file_preview" && message.preview.path === path);
		return (read as { preview: ZGFilePreview }).preview;
	};
	const expectOk = async (action: string): Promise<void> => {
		const result = await waitFor((message) => message.type === "file_result" && message.action === action);
		expect((result as { ok: boolean; error?: string }).error ?? "").toBe("");
		expect((result as { ok: boolean }).ok).toBe(true);
	};

	// Write, including parent directories the panel has to create itself.
	send({ type: "write_file", path: "/work/reports/notes.txt", text: "hello zg" });
	await expectOk("保存");
	expect(await listWork("/work")).toEqual([expect.objectContaining({ name: "reports", type: "dir" })]);
	expect(await listWork("/work/reports")).toEqual([
		expect.objectContaining({ name: "notes.txt", type: "file", size: 8 }),
	]);

	// Preview returns the text, and editing replaces it.
	const first = await preview("/work/reports/notes.txt");
	expect(first.kind).toBe("text");
	expect(first.text).toBe("hello zg");
	expect(first.truncated).toBe(false);
	send({ type: "write_file", path: "/work/reports/notes.txt", text: "edited by the panel" });
	await expectOk("保存");
	expect((await preview("/work/reports/notes.txt")).text).toBe("edited by the panel");

	// Upload decodes base64 into the container, and binary files are flagged.
	const binary = Buffer.from([0x00, 0x01, 0x02, 0xff]).toString("base64");
	send({ type: "upload_file", path: "/work/reports/blob.bin", data: binary });
	await expectOk("上传");
	const uploaded = await preview("/work/reports/blob.bin");
	expect(uploaded.kind).toBe("binary");
	expect(uploaded.size).toBe(4);

	// Download round-trips the bytes back out.
	send({ type: "download_file", path: "/work/reports/blob.bin" });
	const downloaded = await waitFor((message) => message.type === "file_download");
	expect((downloaded as { data: string }).data).toBe(binary);
	expect((downloaded as { size: number }).size).toBe(4);

	// Rename moves the entry; an existing target is refused rather than overwritten.
	send({ type: "rename_path", from: "/work/reports/blob.bin", to: "/work/reports/renamed.bin" });
	await expectOk("重命名");
	expect((await listWork("/work/reports")).map((entry) => entry.name)).toContain("renamed.bin");
	send({ type: "rename_path", from: "/work/reports/renamed.bin", to: "/work/reports/notes.txt" });
	const refused = await waitFor((message) => message.type === "file_result" && message.action === "重命名");
	expect((refused as { ok: boolean; error?: string }).error).toContain("目标已存在");

	// Delete removes files and directories recursively.
	send({ type: "delete_path", path: "/work/reports" });
	await expectOk("删除");
	expect(await listWork("/work")).toEqual([]);
});

test("the file panel refuses paths outside /work", async () => {
	drainIncoming();
	const expectRejected = async (send: () => void): Promise<void> => {
		drainIncoming();
		send();
		const error = await waitFor((message) => message.type === "error" || message.type === "file_result");
		const text = error.type === "error" ? error.message : ((error as { error?: string }).error ?? "");
		expect(text).toMatch(/路径越界|不允许操作|已存在/);
	};

	await expectRejected(() => send({ type: "read_file", path: "/work/../etc/passwd" }));
	await expectRejected(() => send({ type: "list_files", path: "/etc" }));
	await expectRejected(() => send({ type: "write_file", path: "/work/../../tmp/zg-escape.txt", text: "nope" }));
	await expectRejected(() => send({ type: "delete_path", path: "/work" }));
	await expectRejected(() => send({ type: "make_directory", path: "/work" }));
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

test("a session carries an operator status, from the toolbar and into the session list", async () => {
	// The previous test deleted the viewed session, so start from a fresh one. It
	// needs one real run first: an empty session is not written to disk at all, and
	// the session list reads statuses from files.
	send({ type: "new_session" });
	await snapshotWhere((snapshot_) => snapshot_.activeSessionId !== null && snapshot_.messages.length === 0);
	drainIncoming();
	send({ type: "prompt", text: "label this session" });
	const settled = await snapshotWhere((snapshot_) => !snapshot_.streaming && snapshot_.messages.length > 0);
	expect(settled.sessionStatus).toBeNull();
	const sessionId = settled.activeSessionId;

	// No path: this is the toolbar entry point, which labels the active session.
	drainIncoming();
	send({ type: "set_session_status", status: "todo" });
	expect((await snapshotWhere((snapshot_) => snapshot_.sessionStatus === "todo")).sessionStatus).toBe("todo");

	// The list carries the label, and the raw custom state stays on the server.
	drainIncoming();
	send({ type: "list_sessions" });
	const listed = await waitFor((message) => message.type === "sessions");
	const rows = (listed as { sessions: Array<{ id: string; status?: string; customState?: unknown }> }).sessions;
	const row = rows.find((session) => session.id === sessionId);
	expect(row?.status).toBe("todo");
	expect(row?.customState).toBeUndefined();

	// It is a session entry, so clearing it is written the same way.
	drainIncoming();
	send({ type: "set_session_status", status: null });
	expect((await snapshotWhere((snapshot_) => snapshot_.sessionStatus === null)).sessionStatus).toBeNull();

	// A path outside the session directory is refused.
	drainIncoming();
	send({ type: "set_session_status", path: "/etc/passwd", status: "todo" });
	await waitFor((message) => message.type === "error" && message.message.includes("拒绝"));
});

test("a finished run notifies the DingTalk group, and the composer flag can force one", async () => {
	// The session-management test deleted the viewed session, so start a fresh one.
	send({ type: "new_session" });
	await snapshotWhere((snapshot_) => snapshot_.activeSessionId !== null && snapshot_.messages.length === 0);
	drainIncoming();

	// Nothing has been sent yet: notifications are off by default.
	send({ type: "get_notify_config" });
	const initial = await waitFor((message) => message.type === "notify_config");
	expect((initial as { config: { enabled: boolean } }).config.enabled).toBe(false);
	expect(dingtalk).toHaveLength(0);

	// Enable notifications against the local robot.
	drainIncoming();
	send({
		type: "save_notify_config",
		config: { enabled: true, webhook: dingtalkUrl, secret: "SECe2e", keyword: "ZGAgent", summaryLimit: 2000 },
	});
	const saved = await waitFor((message) => message.type === "notify_config");
	expect((saved as { config: { enabled: boolean; keyword: string } }).config).toMatchObject({
		enabled: true,
		keyword: "ZGAgent",
	});

	// One ordinary run. The send is fire-and-forget, so wait on the robot.
	send({ type: "prompt", text: "notify me when this finishes" });
	await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("NOTIFY_RUN_COMPLETE"),
					),
			),
	);
	await waitUntil(() => dingtalk.length > 0);
	const notice = dingtalk[0];
	expect(notice?.title).toBe("ZGAgent 任务完成");
	// The keyword rides along for a keyword-secured robot, and the signature is added.
	expect(notice?.text.startsWith("ZGAgent\n")).toBe(true);
	expect(notice?.text).toContain("**状态**：完成");
	expect(notice?.text).toContain(`**项目**：${PROJECT_NAME}`);
	expect(notice?.text).toContain("**耗时**：");
	expect(notice?.text).toContain("NOTIFY_RUN_COMPLETE");
	expect(notice?.url).toContain("timestamp=");
	expect(notice?.url).toContain("sign=");

	// The settings screen learns the outcome.
	const reported = await waitFor((message) => message.type === "notify_config" && message.status.at !== null);
	expect((reported as { status: { ok: boolean; subject?: string } }).status).toMatchObject({
		ok: true,
		subject: "ZGAgent 任务完成",
	});

	// An explicit opt-out wins even while the switch is on.
	dingtalk.length = 0;
	drainIncoming();
	send({ type: "prompt", text: "stay quiet", notify: false });
	await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes("QUIET_RUN_COMPLETE"),
					),
			),
	);
	// The POST is fire-and-forget: give it time to land before asserting absence.
	await settleWebhook();
	expect(dingtalk).toHaveLength(0);

	// With the switch off, the composer flag still forces a notification.
	dingtalk.length = 0;
	drainIncoming();
	send({
		type: "save_notify_config",
		config: { enabled: false, webhook: dingtalkUrl, secret: "", keyword: "", summaryLimit: 2000 },
	});
	await waitFor((message) => message.type === "notify_config" && !message.config.enabled);
	send({ type: "prompt", text: "force a notification", notify: true });
	await waitUntil(() => dingtalk.length > 0);
	expect(dingtalk[0]?.text).toContain("**状态**：完成");
});

test("the agent's finding lands in the hub as pending, and the operator reviews and exports it", async () => {
	const scenario = VULN_SCENARIOS[0];
	const vuln = await submitViaAgent(scenario.prompt, scenario.done);

	// What the agent submitted is stored verbatim, and it is never the agent's
	// record to approve: it starts as 待确认.
	expect(vuln.status).toBe("pending");
	expect(vuln.label).toBe("E2E-PROJECT-0001");
	expect(vuln.severity).toBe("medium");
	expect(vuln.cvss).toBe(6.5);
	expect(vuln.source).toBe("主代理");
	expect(vuln.packet).toContain("user=admin' AND 1=1--");
	expect(vuln.evidence).toHaveLength(1);
	expect(vuln.evidence[0]?.output).toContain("vulnerable");
	expect(vuln.notes).toHaveLength(1);
	expect(vuln.notes[0]?.author).toBe("agent");
	expect(vuln.severityMismatch).toBe(false);

	// The page's list view is a plain round trip, with the project's counts.
	drainIncoming();
	send({ type: "list_vulns" });
	const listed = await waitFor((message) => message.type === "vulns");
	expect((listed as { items: unknown[] }).items).toHaveLength(1);
	expect((listed as { stats: { total: number; bySeverity: Record<string, number> } }).stats.total).toBe(1);
	expect((listed as { stats: { bySeverity: Record<string, number> } }).stats.bySeverity.medium).toBe(1);

	// Review: a status change, a corrected score, and a note.
	drainIncoming();
	send({ type: "update_vuln", id: vuln.id, patch: { status: "confirmed", cvss: 9.1, note: "已在目标上复现" } });
	const updated = await waitFor((message) => message.type === "vuln" && message.vuln.id === vuln.id);
	const record = (updated as { vuln: ZGVulnerability }).vuln;
	expect(record.status).toBe("confirmed");
	expect(record.cvss).toBe(9.1);
	// The score now disagrees with the bucket: flagged, not rejected.
	expect(record.severityMismatch).toBe(true);
	expect(record.notes).toHaveLength(2);
	expect(record.notes.at(-1)?.author).toBe("operator");
	expect(record.notes.at(-1)?.statusFrom).toBe("pending");
	expect(record.notes.at(-1)?.statusTo).toBe("confirmed");
	const ack = await waitFor((message) => message.type === "vuln_result" && message.action === "复核");
	expect((ack as { ok: boolean }).ok).toBe(true);

	// Export is generated on the server and carries the reviewed state.
	drainIncoming();
	send({ type: "export_vulns" });
	const exported = await waitFor((message) => message.type === "vulns_export");
	const report = exported as { filename: string; markdown: string };
	expect(report.filename).toMatch(/^E2E-PROJECT-vulnerability-report-\d{12}\.md$/);
	expect(report.markdown).toContain("# 漏洞报告 — e2e-project");
	expect(report.markdown).toContain(vuln.label);
	expect(report.markdown).toContain("已确认");
	expect(report.markdown).toContain("user=admin' AND 1=1--");

	// An unknown id is reported rather than silently succeeding.
	drainIncoming();
	send({ type: "get_vuln", id: "E2E-PROJECT-9999" });
	await waitFor((message) => message.type === "error" && message.message.includes("不存在"));
});

test("a critical finding is pushed to DingTalk the moment it is submitted", async () => {
	// The notification test above left the switch off.
	drainIncoming();
	send({
		type: "save_notify_config",
		config: { enabled: true, webhook: dingtalkUrl, secret: "SECe2e", keyword: "ZGAgent", summaryLimit: 2000 },
	});
	await waitFor((message) => message.type === "notify_config" && message.config.enabled);
	dingtalk.length = 0;

	const scenario = VULN_SCENARIOS[1];
	const vuln = await submitViaAgent(scenario.prompt, scenario.done);
	expect(vuln.severity).toBe("critical");
	expect(vuln.label).toBe("E2E-PROJECT-0002");

	await waitUntil(() => dingtalk.some((entry) => entry.title.includes("严重")));
	const notice = dingtalk.find((entry) => entry.title.includes("严重"));
	expect(notice?.title).toBe("ZGAgent 发现严重漏洞");
	expect(notice?.text).toContain(vuln.label);
	expect(notice?.text).toContain("CVSS 9.8");
	expect(notice?.text).toContain("**原始数据包**");
	expect(notice?.text).toContain("GET /ping?cmd=;id HTTP/1.1");

	// Restore the quiet default for any later run.
	drainIncoming();
	send({
		type: "save_notify_config",
		config: { enabled: false, webhook: dingtalkUrl, secret: "", keyword: "", summaryLimit: 2000 },
	});
	await waitFor((message) => message.type === "notify_config" && !message.config.enabled);
});

test("turning vuln_submit off removes the tool, while reading the hub stays available", async () => {
	drainIncoming();
	send({ type: "get_permissions" });
	const current = await waitFor((message) => message.type === "permissions");
	const config = (current as { config: ZGPermissionsConfig }).config;
	const relaxed: ZGPermissionsConfig = {
		main: { ...config.main, vuln_submit: false },
		subagent: { ...config.subagent },
		commander: { ...config.commander },
	};

	drainIncoming();
	send({ type: "save_permissions", config: relaxed });
	await waitFor((message) => message.type === "permissions" && !message.config.main.vuln_submit);

	// A new run asks the model for its tools: the disabled one is not advertised
	// at all, while the read-only pair still is.
	drainIncoming();
	send({ type: "prompt", text: TOOLS_PROBE_PROMPT });
	await snapshotWhere(
		(snapshot_) =>
			!snapshot_.streaming &&
			snapshot_.messages.some(
				(message) =>
					(message as { role?: string }).role === "assistant" &&
					((message as { content?: Array<{ type?: string; text?: string }> }).content ?? []).some((block) =>
						block.text?.includes(TOOLS_PROBE_DONE),
					),
			),
	);
	expect(mainTools).toContain("vuln_list");
	expect(mainTools).toContain("vuln_get");
	expect(mainTools).not.toContain("vuln_submit");

	// The switch only removes the ability to write: the hub is still readable.
	drainIncoming();
	send({ type: "list_vulns" });
	const listed = await waitFor((message) => message.type === "vulns");
	expect((listed as { items: unknown[] }).items).toHaveLength(2);

	// Restore the full set so the remaining tests see the default.
	drainIncoming();
	send({
		type: "save_permissions",
		config: { main: { ...config.main }, subagent: { ...config.subagent }, commander: { ...config.commander } },
	});
	await waitFor((message) => message.type === "permissions" && message.config.main.vuln_submit);
});

test("deleting a project deletes its findings and reports the count first", async () => {
	const cascadeName = "cascade-project";
	drainIncoming();
	send({ type: "add_project", name: cascadeName });
	const created = await waitFor(
		(message) => message.type === "projects" && message.projects.some((project) => project.name === cascadeName),
	);
	const cascade = (created as { projects: Array<{ id: string; name: string; vulnCount?: number }> }).projects.find(
		(project) => project.name === cascadeName,
	);
	expect(cascade?.vulnCount).toBe(0);

	drainIncoming();
	send({ type: "switch_project", id: cascade?.id ?? "" });
	await snapshotWhere((snapshot_) => snapshot_.project?.id === cascade?.id);

	// A finding submitted inside the new project is numbered inside that project.
	const vuln = await submitViaAgent(VULN_SCENARIOS[0].prompt, VULN_SCENARIOS[0].done);
	expect(vuln.label).toBe("CASCADE-PROJECT-0001");
	expect(vuln.projectId).toBe(cascade?.id);

	// The project list carries the count, which is what the delete warning shows.
	drainIncoming();
	send({ type: "list_projects" });
	const withCount = await waitFor((message) => message.type === "projects");
	expect(
		(withCount as { projects: Array<{ name: string; vulnCount?: number }> }).projects.find(
			(project) => project.name === cascadeName,
		)?.vulnCount,
	).toBe(1);

	drainIncoming();
	send({ type: "remove_project", id: cascade?.id ?? "", confirmName: cascadeName });
	await waitFor(
		(message) => message.type === "projects" && !message.projects.some((project) => project.name === cascadeName),
	);

	// The rows are gone from the hub's database, not merely hidden by the
	// missing project: a finding cannot outlive the scope it was found in.
	const db = new DatabaseSync(join(agentDir, "vulnerabilities.db"));
	try {
		const rows = db
			.prepare("SELECT COUNT(*) AS count FROM vulnerabilities WHERE project_id = ?")
			.get(cascade?.id ?? "") as { count: number };
		expect(Number(rows.count)).toBe(0);
		const notes = db
			.prepare(
				"SELECT COUNT(*) AS count FROM vulnerability_notes WHERE vuln_id NOT IN (SELECT id FROM vulnerabilities)",
			)
			.get() as { count: number };
		expect(Number(notes.count)).toBe(0);
	} finally {
		db.close();
	}

	// The other project's findings survived the deletion.
	drainIncoming();
	send({ type: "switch_project", id: mainProjectId });
	await snapshotWhere((snapshot_) => snapshot_.project?.id === mainProjectId);
	send({ type: "list_vulns" });
	const listed = await waitFor((message) => message.type === "vulns");
	expect((listed as { items: unknown[] }).items).toHaveLength(2);
});

// Last on purpose: it adds a session file to the project's session directory, so
// the sidebar assertions above have to have run already.
test("a compacted session keeps the history its summary replaced", async () => {
	const manager = SessionManager.create(workDir, getDefaultSessionDir(workDir, agentDir));
	const firstId = manager.appendMessage({
		role: "user",
		content: "侦察 10.10.10.5",
		timestamp: Date.now() - 60000,
	});
	const keptId = manager.appendMessage({
		role: "user",
		content: "继续扫描 443",
		timestamp: Date.now(),
	});
	manager.appendCompaction("已侦察 10.10.10.5，开放 22/80", keptId, 42000);
	const sessionPath = manager.getSessionFile();
	expect(sessionPath).toBeTruthy();

	drainIncoming();
	send({ type: "switch_session", path: sessionPath ?? "" });
	const snapshot = await snapshotWhere((snapshot_) =>
		snapshot_.messages.some((message) => (message as { role?: string }).role === "compactionSummary"),
	);

	// The model only sees the summary plus what the compaction kept; the console
	// still shows the instructions the summary replaced, with the marker after
	// them (the file appends the compaction entry when it runs).
	const shown = snapshot.messages.filter((message) => (message as { role?: string }).role !== "system");
	expect(shown.map((message) => (message as { role?: string }).role)).toEqual(["user", "user", "compactionSummary"]);
	expect((shown[0] as { content?: unknown }).content).toBe("侦察 10.10.10.5");
	const marker = shown[2] as { summary?: string; tokensBefore?: number };
	expect(marker.summary).toBe("已侦察 10.10.10.5，开放 22/80");
	expect(marker.tokensBefore).toBe(42000);

	// One fork point per operator message, in the same order: the button under the
	// first instruction forks from that instruction, not from the one after it.
	send({ type: "get_tree" });
	const tree = await waitFor((message) => message.type === "tree");
	const points = (tree as { forkPoints: Array<{ entryId: string; text: string }> }).forkPoints;
	expect(points.map((point) => point.entryId)).toEqual([firstId, keptId]);
	expect(points.map((point) => point.text)).toEqual(["侦察 10.10.10.5", "继续扫描 443"]);
});

/** Goal rows of a snapshot, in transcript order. */
function goalRows(snapshot: ZGStateSnapshot): unknown[] {
	return snapshot.messages.filter(
		(message) =>
			(message as { role?: string }).role === "custom" &&
			(message as { customType?: string }).customType === "zg-goal",
	);
}

/**
 * A fresh session with no goal, in auto mode. Setting the mode is only awaited
 * when it actually changes: the server broadcasts nothing for a no-op switch, so
 * waiting for one would hang on whatever snapshot happens to come next.
 */
async function freshGoalSession(): Promise<void> {
	drainIncoming();
	send({ type: "new_session" });
	const fresh = await snapshotWhere((snapshot) => snapshot.goal === null && !snapshot.streaming);
	if (fresh.mode === "auto") return;
	send({ type: "set_mode", mode: "auto" });
	await snapshotWhere((snapshot) => snapshot.mode === "auto");
}

/** Switch modes, waiting only when the switch changes something. */
async function setModeAndWait(mode: "auto" | "review"): Promise<void> {
	drainIncoming();
	send({ type: "get_state" });
	const current = await snapshotWhere(() => true);
	if (current.mode === mode) return;
	send({ type: "set_mode", mode });
	await snapshotWhere((snapshot) => snapshot.mode === mode);
}

test("a persistent goal runs its tools and ends on goal_complete", async () => {
	await freshGoalSession();

	send({
		type: "start_goal",
		objective: GOAL_COMPLETE_PROMPT,
		criteria: ["端口已确认"],
		roundLimit: 2,
	});
	const done = await snapshotWhere(
		(snapshot) => snapshot.goal?.status === "completed" && snapshot.goal.rounds[0]?.outcome === "completed",
	);
	const goal = done.goal;
	expect(goal?.objective).toBe(GOAL_COMPLETE_PROMPT);
	expect(goal?.criteria).toEqual(["端口已确认"]);
	// The completion happens inside the initial run, so it costs no continuation.
	expect(goal?.roundsUsed).toBe(0);
	expect(goal?.roundLimit).toBe(2);
	expect(goal?.rounds).toHaveLength(1);
	expect(goal?.rounds[0].outcome).toBe("completed");
	expect(goal?.rounds[0].toolCalls).toBe(2);
	expect(goal?.rounds[0].summary).toContain("已完成：全端口扫描完成");
	expect(goal?.rounds[0].summaryFromTool).toBe(true);
	expect(goal?.completion?.submitted).toBe(0);
	expect(goal?.completion?.criteria[0]).toEqual({ criterion: "端口已确认", met: true, evidence: "nmap 输出" });
	expect(goal?.usage.total).toBeGreaterThan(0);
	expect(goal?.id.startsWith("goal-")).toBe(true);

	// The contract is a visible row of its own, and no continuation was injected.
	expect(goalRows(done)).toHaveLength(1);
	expect((goalRows(done)[0] as { content?: string }).content).toContain("【持续目标已启动】");
	// The contract precedes the operator's own message, which stays a real user
	// message so the transcript keeps their exact words and its fork point.
	const shown = done.messages.filter((message) => (message as { role?: string }).role !== "system");
	expect(shown.map((message) => (message as { role?: string }).role).slice(0, 2)).toEqual(["custom", "user"]);
	expect(JSON.stringify((shown[1] as { content?: unknown }).content)).toContain(GOAL_COMPLETE_PROMPT);
	const assistant = done.messages
		.filter((message) => (message as { role?: string }).role === "assistant")
		.map((message) => JSON.stringify((message as { content?: unknown }).content))
		.join("");
	expect(assistant).toContain("GOAL_COMPLETE_DONE");

	// The main session mounted the goal tools; sub-agents never do.
	expect(goalTools).toContain("goal_progress");
	expect(goalTools).toContain("goal_complete");
	expect(goalTools).toContain("goal_blocked");
	expect(subagentTools).not.toContain("goal_progress");
});

test("a goal pauses at the round budget, and resuming adds rounds", async () => {
	await freshGoalSession();

	send({ type: "start_goal", objective: GOAL_LIMIT_PROMPT, roundLimit: 1 });
	const paused = await snapshotWhere(
		(snapshot) => snapshot.goal?.status === "paused" && snapshot.goal.rounds.length === 2,
	);
	expect(paused.goal?.pauseReason).toBe("limit");
	expect(paused.goal?.pauseNote).toContain("1 轮");
	expect(paused.goal?.roundsUsed).toBe(1);
	expect(paused.goal?.rounds).toHaveLength(2);
	expect(paused.goal?.rounds.map((round) => round.kind)).toEqual(["initial", "continue"]);
	expect(paused.goal?.rounds.map((round) => round.outcome)).toEqual(["continued", "continued"]);
	// The initial contract plus the one continuation, each a foldable row.
	expect(goalRows(paused)).toHaveLength(2);

	// Resuming adds the requested rounds and immediately starts the next one; the
	// added budget runs out the same way.
	send({ type: "resume_goal", extraRounds: 1 });
	const again = await snapshotWhere(
		(snapshot) =>
			snapshot.goal?.status === "paused" && snapshot.goal.roundLimit === 2 && snapshot.goal.rounds.length === 3,
	);
	expect(again.goal?.roundsUsed).toBe(2);
	expect(again.goal?.rounds).toHaveLength(3);
	expect(goalRows(again)).toHaveLength(3);
});

test("three rounds without a tool call trip the no-progress fuse", async () => {
	await freshGoalSession();

	send({ type: "start_goal", objective: GOAL_NOPROGRESS_PROMPT, roundLimit: 5 });
	const paused = await snapshotWhere(
		(snapshot) => snapshot.goal?.status === "paused" && snapshot.goal.rounds.length === 3,
	);
	expect(paused.goal?.pauseReason).toBe("no-progress");
	expect(paused.goal?.noProgressStreak).toBe(3);
	expect(paused.goal?.roundsUsed).toBe(2);
	expect(paused.goal?.rounds).toHaveLength(3);
	expect(paused.goal?.rounds.every((round) => round.toolCalls === 0)).toBe(true);

	// Clearing removes the bar and the stored state.
	drainIncoming();
	send({ type: "clear_goal" });
	const cleared = await snapshotWhere((snapshot) => snapshot.goal === null);
	expect(goalRows(cleared)).toHaveLength(3);
});

test("a goal cannot start in review mode, and leaving auto mode pauses it", async () => {
	await freshGoalSession();
	await setModeAndWait("review");

	send({ type: "start_goal", objective: GOAL_LIMIT_PROMPT, roundLimit: 1 });
	await waitFor((message) => message.type === "error" && message.message.includes("自动模式"));

	// In auto mode it starts; switching back to review pauses it with a reason.
	await setModeAndWait("auto");
	send({ type: "start_goal", objective: GOAL_NOPROGRESS_PROMPT, roundLimit: 5 });
	await snapshotWhere((snapshot) => snapshot.goal?.status === "active");
	send({ type: "set_mode", mode: "review" });
	const paused = await snapshotWhere((snapshot) => snapshot.goal?.status === "paused");
	expect(paused.goal?.pauseReason).toBe("manual");
	expect(paused.goal?.pauseNote).toContain("审批模式");

	// The round in flight still ends, but it does not start another one.
	const settled = await snapshotWhere(
		(snapshot) =>
			!snapshot.streaming &&
			snapshot.goal?.status === "paused" &&
			snapshot.goal.rounds.some((round) => round.endedAt !== undefined),
	);
	expect(settled.goal?.status).toBe("paused");
});

test("a compaction that stalls is visible, refuses prompts in Chinese, and can be cancelled", async () => {
	await freshGoalSession();
	// Fill the context past the keep-recent threshold: pi refuses to summarize a
	// session with nothing to summarize, and the stall is what this test is about.
	const fillTurns = (snapshot: ZGStateSnapshot): number =>
		snapshot.messages.filter((message) =>
			JSON.stringify((message as { content?: unknown }).content ?? "").includes(COMPACT_FILL_DONE),
		).length;
	for (let turn = 1; turn <= 3; turn += 1) {
		send({ type: "prompt", text: COMPACT_FILL_PROMPT });
		await snapshotWhere((snapshot) => !snapshot.streaming && fillTurns(snapshot) >= turn);
	}
	const requestsBefore = compactionRequests;

	stallCompaction = true;
	send({ type: "compact" });
	const busy = await snapshotWhere((snapshot) => snapshot.compacting);
	// The console knows when it started, so the operator sees how long it has been.
	expect(busy.compactionStartedAt).toBeGreaterThan(0);
	// The summary request is the thing that is stuck; wait for it to be issued.
	await waitUntil(() => compactionRequests > requestsBefore);

	// A prompt during the compaction is refused with a Chinese reason, not pi's
	// English "Cannot submit a prompt while compaction is in progress".
	send({ type: "prompt", text: "should be refused while compacting" });
	const refused = await waitFor((message) => message.type === "error");
	expect((refused as { message: string }).message).toContain("正在压缩上下文");
	expect((refused as { message: string }).message).not.toContain("Cannot submit a prompt");

	// The operator gives up on it: the wait ends and the session takes prompts
	// again. The endpoint stops stalling first, so a summarization pi retries
	// after the cancel is answered instead of holding the test open.
	stallCompaction = false;
	send({ type: "abort_compaction" });
	await snapshotWhere((snapshot) => !snapshot.compacting && snapshot.compactionStartedAt === null);

	// The session takes prompts again. This deliberately oversized transcript can
	// make pi start its own threshold compaction right after a run, so a refused
	// prompt is retried instead of failing the test: what is being proven is that
	// the cancel left the session usable, not that pi never compacts on its own.
	const answered = async (): Promise<boolean> => {
		const outcome = await Promise.race([
			snapshotWhere(
				(snapshot) =>
					!snapshot.compacting &&
					snapshot.messages.some((message) =>
						JSON.stringify((message as { content?: unknown }).content ?? "").includes("NOTIFY_RUN_COMPLETE"),
					),
				15000,
			)
				.then(() => true)
				.catch(() => false),
			waitFor((message) => message.type === "error", 15000)
				.then(() => false)
				.catch(() => true),
		]);
		return outcome;
	};
	let accepted = false;
	for (let attempt = 0; attempt < 3 && !accepted; attempt += 1) {
		send({ type: "prompt", text: "notify me when this finishes" });
		accepted = await answered();
		if (!accepted) await snapshotWhere((snapshot) => !snapshot.compacting, 15000).catch(() => undefined);
	}
	expect(accepted).toBe(true);
});
