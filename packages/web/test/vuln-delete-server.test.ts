/**
 * Batch deletion of findings, over the console's own protocol.
 *
 * The hub now deletes only through selection, so the flow is: ask what the
 * deletion would take (a preview the dialog renders), then confirm it. What is
 * pinned here: the preview reports counts without deleting anything, the confirm
 * deletes exactly the selected records, the caller learns how many went, and the
 * project's list comes back without them.
 *
 * No Docker and no provider are needed: findings are written straight into the
 * store the console opened, and the fake docker only stands in for the container
 * the project needs to exist.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import WebSocket from "ws";
import type { SentinelClientMessage, SentinelServerMessage, SentinelVulnSummary } from "../src/protocol.ts";
import { startSentinelServer } from "../src/server.ts";
import { VulnerabilityStore } from "../src/vulnerabilities.ts";
import { type FakeDocker, installFakeDocker } from "./fake-docker.ts";

let tempRoot = "";
let agentDir = "";
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
	timeoutMs = 20000,
): Promise<SentinelServerMessage> {
	const buffered = incoming.findIndex(predicate);
	if (buffered >= 0) {
		const [message] = incoming.splice(buffered, 1);
		return Promise.resolve(message);
	}
	return new Promise((resolve, reject) => {
		const waiter = { predicate, resolve: () => {} } as (typeof waiters)[number];
		const timer = setTimeout(() => {
			const position = waiters.indexOf(waiter);
			if (position >= 0) waiters.splice(position, 1);
			reject(new Error(`Timed out. Buffered: ${incoming.map((message) => message.type).join(", ")}`));
		}, timeoutMs);
		waiter.resolve = (message) => {
			clearTimeout(timer);
			resolve(message);
		};
		waiters.push(waiter);
	});
}

function send(message: SentinelClientMessage): void {
	ws?.send(JSON.stringify(message));
}

function vulns(): Promise<SentinelVulnSummary[]> {
	return waitFor((message) => message.type === "vulns").then(
		(message) => (message as { items: SentinelVulnSummary[] }).items,
	);
}

beforeAll(async () => {
	tempRoot = mkdtempSync(join(tmpdir(), "sentinel-vuln-delete-"));
	agentDir = join(tempRoot, "agent");
	mkdirSync(agentDir, { recursive: true });
	fakeDocker = installFakeDocker(tempRoot, join(tempRoot, "projects"));
	const started = await startSentinelServer({
		cwd: join(tempRoot, "workspace"),
		agentDir,
		host: "127.0.0.1",
		port: 0,
		auth: false,
	});
	closeServer = started.close;
	ws = new WebSocket(started.url.replace("http://", "ws://").concat("/ws"));
	ws.on("message", (data) => dispatch(JSON.parse(String(data)) as SentinelServerMessage));
	await new Promise<void>((resolve, reject) => {
		ws?.once("open", () => resolve());
		ws?.once("error", (error) => reject(error));
	});
});

afterAll(() => {
	ws?.close();
	closeServer?.();
	fakeDocker?.restore();
	rmSync(tempRoot, { recursive: true, force: true });
});

test("a preview reports the impact, and confirming deletes exactly the selection", async () => {
	// A project to hold the findings; the container itself is the fake's business.
	send({ type: "add_project", name: "删除靶场" });
	// The connection already broadcast the (empty) list, so wait for the one that
	// actually carries the new project.
	const project = await waitFor(
		(message) => message.type === "projects" && message.projects.some((entry) => entry.name === "删除靶场"),
	).then((message) =>
		(message as { projects: { id: string; name: string }[] }).projects.find((entry) => entry.name === "删除靶场"),
	);
	expect(project).toBeDefined();
	send({ type: "switch_project", id: project?.id ?? "" });
	await waitFor((message) => message.type === "projects" && message.activeProjectId === (project?.id ?? ""));

	// Seed three findings, one with two pieces of evidence and a review note.
	const store = new VulnerabilityStore(join(agentDir, "vulnerabilities.db"));
	try {
		const make = (suffix: string, evidence: number) =>
			store.create({
				projectId: project?.id ?? "",
				projectName: "删除靶场",
				sessionId: "s1",
				source: "主代理",
				title: `发现 ${suffix}`,
				severity: "medium",
				cvss: 5,
				target: "10.0.0.7",
				description: "描述",
				packet: "GET /",
				evidence: Array.from({ length: evidence }, (_unused, index) => ({
					kind: "command" as const,
					command: `cmd-${index}`,
					output: "out",
				})),
			}).id;
		const first = make("A", 2);
		const second = make("B", 0);
		store.update(first, { note: "复核备注" });
		const keep = make("C", 1);

		send({ type: "list_vulns", filters: {} });
		expect(await vulns()).toHaveLength(3);

		send({ type: "preview_vuln_delete", ids: [first, second] });
		const preview = (await waitFor((message) => message.type === "vuln_delete_preview")) as {
			count: number;
			evidence: number;
			notes: number;
		};
		// Two submission notes plus the review note added to the first record.
		expect(preview).toMatchObject({ count: 2, evidence: 2, notes: 3 });

		// The preview deletes nothing.
		send({ type: "list_vulns", filters: {} });
		expect(await vulns()).toHaveLength(3);

		send({ type: "delete_vulns", ids: [first, second] });
		expect((await waitFor((message) => message.type === "vulns_deleted")) as { count: number }).toMatchObject({
			count: 2,
		});

		send({ type: "list_vulns", filters: {} });
		const left = await vulns();
		expect(left.map((item) => item.id)).toEqual([keep]);
	} finally {
		store.close();
	}
});
