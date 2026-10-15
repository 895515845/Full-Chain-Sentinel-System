/**
 * The console has no default directory: without a project there is no container,
 * so the chat must be unavailable rather than silently running on the host.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import type { SentinelClientMessage, SentinelServerMessage, SentinelStateSnapshot } from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";
import { type FakeDocker, installFakeDocker, projectSlug } from "./fake-docker.ts";
import { writeTestModel } from "./model-fixtures.ts";

let tempRoot = "";
let fakeDocker: FakeDocker | undefined;
let closeServer: (() => void) | undefined;
let ws: WebSocket | undefined;

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
	timeoutMs = 15000,
): Promise<SentinelServerMessage> {
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

function snapshotWhere(predicate: (snapshot: SentinelStateSnapshot) => boolean): Promise<SentinelStateSnapshot> {
	return waitFor((message) => message.type === "snapshot" && predicate(message.snapshot)).then(
		(message) => (message as { snapshot: SentinelStateSnapshot }).snapshot,
	);
}

beforeAll(async () => {
	tempRoot = mkdtempSync(join(tmpdir(), "sentinel-web-noproject-"));
	const agentDir = join(tempRoot, "agent");
	const cwd = join(tempRoot, "workspace");
	// A model is configured so that entering a project can build a session; no
	// request is ever sent, so the endpoint does not need to exist.
	writeTestModel(agentDir, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "test-key", modelId: "sentinel-unused-model" });
	fakeDocker = installFakeDocker(tempRoot, join(tempRoot, "projects", projectSlug("noproject-test")));
	const started = await startSentinelServer({ cwd, agentDir, host: "127.0.0.1", port: 0, auth: false });
	closeServer = started.close;
	ws = new WebSocket(started.url.replace("http://", "ws://").concat("/ws"));
	ws.on("message", (data) => dispatch(JSON.parse(String(data)) as SentinelServerMessage));
	await new Promise<void>((resolve, reject) => {
		if (!ws) throw new Error("no socket");
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
});

afterAll(() => {
	ws?.close();
	closeServer?.();
	fakeDocker?.restore();
	if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test("a fresh console has no project and no chat session", async () => {
	send({ type: "get_state" });
	const snapshot = await snapshotWhere(() => true);
	expect(snapshot.project).toBeNull();
	expect(snapshot.activeSessionId).toBeNull();
	expect(snapshot.messages).toEqual([]);
	expect(snapshot.subagents).toEqual([]);
});

test("prompting and file access are refused until a project exists", async () => {
	send({ type: "prompt", text: "scan 10.10.10.5" });
	const refused = await waitFor((message) => message.type === "error");
	expect((refused as { message: string }).message).toContain("请先创建或选择一个项目");

	// The refusal is immediate: the session never started, so nothing is streaming.
	send({ type: "get_state" });
	const snapshot = await snapshotWhere((snapshot_) => snapshot_.streaming === false);
	expect(snapshot.messages).toEqual([]);
	expect(snapshot.activeSessionId).toBeNull();
});

test("creating a project makes the chat available", async () => {
	send({ type: "add_project", name: "noproject-test" });
	const created = await waitFor((message) => message.type === "projects" && message.projects.length === 1);
	const project = (created as { projects: Array<{ id: string; name: string }> }).projects[0];
	expect(project?.name).toBe("noproject-test");

	send({ type: "switch_project", id: project?.id ?? "" });
	const entered = await snapshotWhere((snapshot_) => snapshot_.project !== null);
	expect(entered.project?.id).toBe(project?.id);
	expect(entered.activeSessionId).not.toBeNull();
	// The work directory is where the panel will look; it is created on entry.
	expect(entered.project?.cwd).toBe(join(tempRoot, "projects", projectSlug("noproject-test")));
});
