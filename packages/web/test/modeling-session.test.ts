/**
 * Business modeling over the real WebSocket protocol.
 *
 * This is the invariant the feature exists for, checked where it actually
 * matters: the two modeling tools are declared on a console session so the
 * operator can start modeling by asking for it in the conversation, pressing the
 * button records the run, and the run's record lands in the hub. Nothing here
 * needs Docker or a provider — the configured endpoint is a port nothing listens
 * on, which is enough to observe the declaration, the record and the closing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import { ApiModelStore } from "../src/apimodels.ts";
import type {
	ZGApiModelSummary,
	ZGClientMessage,
	ZGServerMessage,
	ZGStateSnapshot,
	ZGToolInfo,
} from "../src/protocol.ts";
import { startZGServer } from "../src/server.ts";
import { type FakeDocker, installFakeDocker, projectSlug } from "./fake-docker.ts";
import { writeTestModel } from "./model-fixtures.ts";

let tempRoot = "";
let fakeDocker: FakeDocker | undefined;
let closeServer: (() => void) | undefined;
let ws: WebSocket | undefined;

const incoming: ZGServerMessage[] = [];
const waiters: Array<{
	predicate: (message: ZGServerMessage) => boolean;
	resolve: (message: ZGServerMessage) => void;
}> = [];

function dispatch(message: ZGServerMessage): void {
	const index = waiters.findIndex((waiter) => waiter.predicate(message));
	if (index >= 0) {
		const [waiter] = waiters.splice(index, 1);
		waiter.resolve(message);
		return;
	}
	incoming.push(message);
}

function waitFor(predicate: (message: ZGServerMessage) => boolean, timeoutMs = 20000): Promise<ZGServerMessage> {
	const index = incoming.findIndex(predicate);
	if (index >= 0) {
		const [message] = incoming.splice(index, 1);
		return Promise.resolve(message);
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			const position = waiters.indexOf(waiter);
			if (position >= 0) waiters.splice(position, 1);
			reject(new Error(`Timed out waiting for a message. Buffered: ${incoming.map((m) => m.type).join(", ")}`));
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

function snapshotWhere(predicate: (snapshot: ZGStateSnapshot) => boolean, timeoutMs = 20000): Promise<ZGStateSnapshot> {
	return waitFor((message) => message.type === "snapshot" && predicate(message.snapshot), timeoutMs).then(
		(message) => (message as { snapshot: ZGStateSnapshot }).snapshot,
	);
}

/** The mounted tools of the viewed session, as the permissions screen reads them. */
async function mountedTools(): Promise<ZGToolInfo[]> {
	// Drop anything an earlier step left buffered: the list must be this answer.
	incoming.length = 0;
	send({ type: "get_permissions" });
	const message = await waitFor((candidate) => candidate.type === "permissions");
	if (message.type !== "permissions") throw new Error("no permissions message");
	return message.tools;
}

function activeNames(tools: ZGToolInfo[]): string[] {
	return tools.filter((tool) => tool.active).map((tool) => tool.name);
}

async function apiModels(): Promise<ZGApiModelSummary[]> {
	incoming.length = 0;
	send({ type: "list_api_models" });
	const message = await waitFor((candidate) => candidate.type === "api_models");
	if (message.type !== "api_models") throw new Error("no api_models message");
	return message.items;
}

beforeAll(async () => {
	tempRoot = mkdtempSync(join(tmpdir(), "zgagent-web-modeling-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "workspace");
	// A model is configured so entering the project can build a session. The port
	// is closed on purpose: the turn the button starts fails immediately, and what
	// this file asserts is the mounting, the record and the unmounting.
	writeTestModel(agentDir, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "test-key", modelId: "zg-unused-model" });
	fakeDocker = installFakeDocker(tempRoot, join(tempRoot, "projects", projectSlug("modeling-test")));
	const started = await startZGServer({ cwd, agentDir, host: "127.0.0.1", port: 0, auth: false });
	closeServer = started.close;
	ws = new WebSocket(started.url.replace("http://", "ws://").concat("/ws"));
	ws.on("message", (data) => dispatch(JSON.parse(String(data)) as ZGServerMessage));
	await new Promise<void>((resolve, reject) => {
		if (!ws) throw new Error("no socket");
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});

	send({ type: "add_project", name: "modeling-test" });
	const created = await waitFor((message) => message.type === "projects" && message.projects.length === 1);
	const project = (created as { projects: Array<{ id: string }> }).projects[0];
	send({ type: "switch_project", id: project?.id ?? "" });
	await snapshotWhere((snapshot) => snapshot.project !== null && snapshot.activeSessionId !== null);
});

afterAll(() => {
	ws?.close();
	closeServer?.();
	fakeDocker?.restore();
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test("a fresh session carries the modeling tools active, with no run", async () => {
	const snapshot = await snapshotWhere(() => true);
	expect(snapshot.modeling).toBeNull();

	const tools = await mountedTools();
	const modeling = tools.filter((tool) => tool.name.startsWith("api_model_"));
	expect(modeling.map((tool) => tool.name).sort()).toEqual(["api_model_done", "api_model_read", "api_model_submit"]);
	// The two run tools are declared in every session, so the operator can start
	// modeling by asking for it in the conversation instead of pressing a button.
	// What keeps modeling out of ordinary work is the wording both tools carry: the
	// unit tests pin that every description and first guideline say not to call
	// them unless the operator asked.
	expect(activeNames(tools)).toContain("api_model_submit");
	expect(activeNames(tools)).toContain("api_model_done");
	// The read tool is the one that still follows the session's attached records.
	expect(activeNames(tools)).not.toContain("api_model_read");
});

test("the button records the run; the tools stay declared when it ends", async () => {
	send({ type: "start_modeling" });
	const started = await snapshotWhere((snapshot) => snapshot.modeling !== null);
	expect(started.modeling?.pathCount).toBe(0);
	expect(started.modeling?.runId).toBeTruthy();

	// The active set is the source of truth for the system prompt too: the SDK
	// rebuilds the prompt's tool section from exactly this list
	// (`_rebuildSystemPrompt(tools.map(name))`), so a name that is not active here
	// cannot appear in what the model is told it has.
	const mounted = await mountedTools();
	expect(activeNames(mounted)).toEqual(expect.arrayContaining(["api_model_submit", "api_model_done"]));

	// The record exists before the agent has submitted anything, so the page can
	// show work in progress.
	const records = await apiModels();
	expect(records).toHaveLength(1);
	expect(records[0].status).toBe("modeling");
	expect(records[0].pathCount).toBe(0);
	expect(records[0].projectId).toBe(started.project?.id);

	// The configured endpoint is closed, so the turn the button started fails at
	// once. Either way the run must be closable.
	await snapshotWhere((snapshot) => !snapshot.streaming);
	if ((await snapshotWhere(() => true)).modeling !== null) {
		send({ type: "end_modeling" });
		await snapshotWhere((snapshot) => snapshot.modeling === null);
	}
	// Ending a run does not take the tools away any more — they are declared in
	// every session, and the closing marker is what tells the model to stop using
	// them. Only the run state changes.
	const after = await mountedTools();
	expect(activeNames(after)).toEqual(expect.arrayContaining(["api_model_submit", "api_model_done"]));

	const closed = await apiModels();
	expect(closed[0].status === "manual" || closed[0].status === "failed").toBe(true);
	expect(closed[0].doneAt).not.toBeNull();

	// Ending a run that is already over is refused with a reason, not silently.
	send({ type: "end_modeling" });
	const refused = await waitFor((message) => message.type === "error");
	expect((refused as { message: string }).message).toContain("没有进行中的业务建模");
});

test("带建模数据 on a fresh conversation injects the catalog once and mounts the read tool", async () => {
	// A record to attach: written through a second handle on the same database, the
	// way an earlier conversation's run would have left it.
	incoming.length = 0;
	send({ type: "get_state" });
	const state = await snapshotWhere(() => true);
	const projectId = state.project?.id as string;
	const beforeId = state.activeSessionId;
	const seed = new ApiModelStore(join(tempRoot, "agent", "apimodels.db"));
	const created = seed.beginRun({ projectId, sessionId: "seed", sessionPath: null, title: "旧站点还原" });
	seed.submit(created.id, {
		target: "https://old.example.com",
		paths: { "/api/users": { get: { summary: "用户列表" } } },
		entities: [{ name: "用户", fields: [{ name: "id", type: "integer" }] }],
	});
	seed.close();

	send({ type: "new_session" });
	await snapshotWhere(
		(snapshot) =>
			snapshot.activeSessionId !== null && snapshot.activeSessionId !== beforeId && snapshot.messages.length === 0,
	);

	send({ type: "prompt", text: "结合之前建模的接口继续", attachModelIds: [created.id] });
	const attached = await snapshotWhere((snapshot) => snapshot.modelingAttached.length === 1, 30000);
	expect(attached.modelingAttached[0]?.id).toBe(created.id);

	// The read tool is part of this conversation's tool list.
	expect(activeNames(await mountedTools())).toContain("api_model_read");

	// The catalog reached the transcript as one foldable row before the prompt.
	const catalog = await snapshotWhere((snapshot) =>
		snapshot.messages.some(
			(message) =>
				(message as { customType?: string }).customType === "zg-modeling-attach" &&
				JSON.stringify((message as { content?: unknown }).content ?? "").includes("已带入 1 份"),
		),
	);
	const row = catalog.messages.find(
		(message) => (message as { customType?: string }).customType === "zg-modeling-attach",
	);
	const text = JSON.stringify((row as { content?: unknown }).content);
	expect(text).toContain("api_model_read");
	expect(text).toContain("/api/users");
	expect(text).toContain("用户");

	// Removing the attachment takes the tool away again — after the run settled,
	// exactly as the console refuses to detach under a live run.
	await snapshotWhere((snapshot) => !snapshot.streaming, 30000);
	send({ type: "detach_modeling" });
	const detached = await snapshotWhere((snapshot) => snapshot.modelingAttached.length === 0, 30000);
	expect(detached.modelingAttached).toEqual([]);
	expect(activeNames(await mountedTools())).not.toContain("api_model_read");
});

test("a prompt without attachModelIds attaches nothing", async () => {
	incoming.length = 0;
	send({ type: "new_session" });
	await snapshotWhere(
		(snapshot) => !snapshot.messages.some((message) => (message as { role?: string }).role === "user"),
	);
	send({ type: "prompt", text: "普通的第一条消息" });
	await snapshotWhere((snapshot) =>
		snapshot.messages.some((message) => (message as { role?: string }).role === "user"),
	);
	const snapshot = await snapshotWhere(() => true);
	expect(snapshot.modelingAttached).toEqual([]);
	expect(activeNames(await mountedTools())).not.toContain("api_model_read");
});
