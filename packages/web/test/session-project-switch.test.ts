/**
 * A session keeps its own project after the operator switches away.
 *
 * The console used to read the project from runtime-wide fields while building
 * tool contexts, so a session that kept running in the background wrote its
 * audit rows, evidence and records into whichever project was on screen. This
 * test drives the real WebSocket protocol: project A's turn is held open inside
 * the model endpoint, the console switches to project B, and only then is the
 * tool call released. The gate audit row must still name project A.
 *
 * No Docker and no provider are needed: `installFakeDocker` stands in for the
 * container, and the endpoint is a local HTTP server this test controls.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import type {
	SentinelClientMessage,
	SentinelGateDecision,
	SentinelProjectInfo,
	SentinelServerMessage,
	SentinelStateSnapshot,
} from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";
import { type FakeDocker, installFakeDocker } from "./fake-docker.ts";
import { writeTestModel } from "./model-fixtures.ts";

let tempRoot = "";
let fakeDocker: FakeDocker | undefined;
let closeServer: (() => void) | undefined;
let ws: WebSocket | undefined;
let endpoint: Server | undefined;

const incoming: SentinelServerMessage[] = [];
const waiters: Array<{
	predicate: (message: SentinelServerMessage) => boolean;
	resolve: (message: SentinelServerMessage) => void;
}> = [];

function dispatch(message: SentinelServerMessage): void {
	const index = waiters.findIndex((waiter) => waiter.predicate(message));
	if (index >= 0) {
		const [waiter] = waiters.splice(index, 1);
		waiter.resolve(message);
		return;
	}
	incoming.push(message);
}

function waitFor(
	predicate: (message: SentinelServerMessage) => boolean,
	timeoutMs = 20000,
): Promise<SentinelServerMessage> {
	const buffered = incoming.findIndex(predicate);
	if (buffered >= 0) {
		const [message] = incoming.splice(buffered, 1);
		return Promise.resolve(message);
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			const position = waiters.indexOf(waiter);
			if (position >= 0) waiters.splice(position, 1);
			reject(new Error(`Timed out. Buffered: ${incoming.map((m) => m.type).join(", ")}`));
		}, timeoutMs);
		const waiter = {
			predicate,
			resolve: (message: SentinelServerMessage) => {
				clearTimeout(timer);
				resolve(message);
			},
		};
		waiters.push(waiter);
	});
}

function send(message: SentinelClientMessage): void {
	ws?.send(JSON.stringify(message));
}

function snapshotWhere(
	predicate: (snapshot: SentinelStateSnapshot) => boolean,
	timeoutMs = 20000,
): Promise<SentinelStateSnapshot> {
	return waitFor((message) => message.type === "snapshot" && predicate(message.snapshot), timeoutMs).then(
		(message) => (message as { snapshot: SentinelStateSnapshot }).snapshot,
	);
}

function sseChunk(payload: Record<string, unknown>): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

let releaseTurn: () => void = () => {};
const turnGate = new Promise<void>((resolve) => {
	releaseTurn = resolve;
});
let noteFirstRequest: () => void = () => {};
const firstRequest = new Promise<void>((resolve) => {
	noteFirstRequest = resolve;
});
let requestCount = 0;
let baseUrl = "";

/** One bash tool call, in the OpenAI streaming wire format. */
function bashToolCall(id: string, command: string): string {
	const call = {
		index: 0,
		id: `call_${id}`,
		type: "function",
		function: { name: "bash", arguments: JSON.stringify({ command }) },
	};
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
		sseChunk({ id, object: "chat.completion.chunk", choices: [] }),
	].join("");
}

/** A plain assistant turn, for the request that follows the tool result. */
function plainText(id: string, text: string): string {
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
	].join("");
}

async function startProvider(): Promise<void> {
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
			void body;
			requestCount += 1;
			const id = `chatcmpl-${requestCount}`;
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if (requestCount === 1) {
				// A's turn: answered only after the test switched projects.
				noteFirstRequest();
				void turnGate.then(() => response.end(bashToolCall(id, "id")));
				return;
			}
			response.end(plainText(id, "已完成"));
		});
	});
	await new Promise<void>((resolve) => endpoint?.listen(0, "127.0.0.1", resolve));
	const address = endpoint?.address();
	if (!address || typeof address === "string") throw new Error("no provider port");
	baseUrl = `http://127.0.0.1:${address.port}/v1`;
}

async function gateRows(): Promise<SentinelGateDecision[]> {
	incoming.length = 0;
	send({ type: "gate_audit_query", pageSize: 50 });
	const message = await waitFor((candidate) => candidate.type === "gate_audit");
	return message.type === "gate_audit" ? message.page.items : [];
}

async function waitForGateRow(command: string): Promise<SentinelGateDecision> {
	const deadline = Date.now() + 15000;
	for (;;) {
		const hit = (await gateRows()).find((item) => item.command === command);
		if (hit) return hit;
		if (Date.now() > deadline) throw new Error(`no gate audit row for ${command}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

beforeAll(async () => {
	tempRoot = mkdtempSync(join(tmpdir(), "sentinel-web-project-switch-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "workspace");
	await startProvider();
	writeTestModel(agentDir, { baseUrl, apiKey: "test-key", modelId: "sentinel-switch-model" });
	fakeDocker = installFakeDocker(tempRoot, join(tempRoot, "projects"));
	const started = await startSentinelServer({ cwd, agentDir, host: "127.0.0.1", port: 0, auth: false });
	closeServer = started.close;
	ws = new WebSocket(started.url.replace("http://", "ws://").concat("/ws"));
	ws.on("message", (data) => dispatch(JSON.parse(String(data)) as SentinelServerMessage));
	await new Promise<void>((resolve, reject) => {
		ws?.once("open", () => resolve());
		ws?.once("error", reject);
	});
});

afterAll(() => {
	ws?.close();
	closeServer?.();
	endpoint?.close();
	fakeDocker?.restore();
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test("a session that keeps running after a switch still audits to its own project", async () => {
	send({ type: "add_project", name: "项目 A" });
	const afterA = await waitFor((message) => message.type === "projects" && message.projects.length === 1);
	const projectA = (afterA as { projects: SentinelProjectInfo[] }).projects[0] as SentinelProjectInfo;
	send({ type: "add_project", name: "项目 B" });
	const afterB = await waitFor((message) => message.type === "projects" && message.projects.length === 2);
	const projectB = (afterB as { projects: SentinelProjectInfo[] }).projects.find((item) => item.id !== projectA.id);
	expect(projectB).toBeDefined();

	send({ type: "switch_project", id: projectA.id });
	const onA = await snapshotWhere(
		(snapshot) => snapshot.project?.id === projectA.id && snapshot.activeSessionId !== null,
	);
	const sessionA = onA.activeSessionId;
	send({ type: "set_global_mode", mode: "auto" });
	await snapshotWhere((snapshot) => snapshot.mode === "auto");

	// A's turn reaches the endpoint and is held there.
	send({ type: "prompt", text: "run the scoped check" });
	await firstRequest;

	// The operator leaves A for B while A's turn is still open.
	send({ type: "switch_project", id: projectB?.id ?? "" });
	const onB = await snapshotWhere((snapshot) => snapshot.project?.id === projectB?.id);
	expect(onB.activeSessionId).not.toBeNull();

	// Releasing the endpoint runs A's tool call while B is the project on screen.
	releaseTurn();

	const row = await waitForGateRow("id");
	expect(row.projectId).toBe(projectA.id);
	expect(row.projectName).toBe(projectA.name);
	expect(row.sessionId).toBe(sessionA);
});
