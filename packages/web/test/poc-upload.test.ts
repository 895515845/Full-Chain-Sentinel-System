/**
 * The POC upload endpoint: the raw body is one template file, the response is a
 * job id, and the job is polled until the async import settles.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { PocImportJobView } from "../src/poc-import.ts";
import { startSentinelServer } from "../src/server.ts";

const TEMPLATE = `id: upload-test
info:
  name: Upload test
  severity: high
http:
  - method: GET
    path:
      - "{{BaseURL}}"
`;

let root = "";
let closeServer: (() => void) | undefined;
let base = "";

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "sentinel-poc-upload-"));
	const started = await startSentinelServer({
		cwd: join(root, "workspace"),
		agentDir: join(root, "agent"),
		host: "127.0.0.1",
		port: 0,
		auth: false,
	});
	closeServer = started.close;
	base = started.url;
});

afterAll(() => {
	closeServer?.();
	if (root) rmSync(root, { recursive: true, force: true });
});

test("streams a raw template through an HTTP upload job", async () => {
	const uploaded = await fetch(`${base}/api/pocs/import?name=upload-test.yaml`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: TEMPLATE,
	});
	expect(uploaded.status).toBe(202);
	const accepted = (await uploaded.json()) as { id?: string };
	expect(typeof accepted.id).toBe("string");
	if (!accepted.id) return;

	let job: PocImportJobView | null = null;
	for (let attempt = 0; attempt < 300; attempt += 1) {
		const response = await fetch(`${base}/api/pocs/import/${accepted.id}`);
		expect(response.status).toBe(200);
		job = (await response.json()) as PocImportJobView;
		if (job && (job.status === "done" || job.status === "error")) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(job).toMatchObject({
		status: "done",
		progress: { processed: 1 },
		outcome: { imported: 1, replaced: 0, skipped: [] },
	});
});
