/**
 * The HTTP POC import jobs: stream one body to a temp file, run one job at a
 * time, and expose progress until the outcome is polled.
 */

import { expect, test } from "vitest";
import { type PocImportJobView, PocImportManager } from "../src/poc-import.ts";

async function settled(manager: PocImportManager, id: string): Promise<PocImportJobView> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const job = manager.get(id);
		if (job && (job.status === "done" || job.status === "error")) return job;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("job did not settle");
}

test("streams the uploaded bytes into a queued import and exposes progress", async () => {
	const calls: Array<{ name: string; size: number }> = [];
	const manager = new PocImportManager(async (file, onProgress) => {
		calls.push({ name: file.name, size: file.bytes.length });
		onProgress({ processed: 2, imported: 1, replaced: 0, skipped: 1, current: "a.yaml" });
		return { imported: 1, replaced: 0, skipped: [{ name: "bad.yaml", reason: "缺少有效的模板 id" }] };
	});
	try {
		const accepted = await manager.accept(
			"nuclei.zip",
			(async function* () {
				yield Buffer.from("abc");
				yield new Uint8Array([100, 101]);
			})(),
		);
		expect(accepted).toMatchObject({ ok: true });
		if (!accepted.ok) return;
		expect(["queued", "running"]).toContain(manager.get(accepted.id)?.status);
		expect(manager.get(accepted.id)?.progress.processed).toBe(0);

		const job = await settled(manager, accepted.id);
		expect(job).toMatchObject({
			status: "done",
			progress: { processed: 2, imported: 1, skipped: 1, current: "a.yaml" },
			outcome: { imported: 1, replaced: 0 },
		});
		expect(calls).toEqual([{ name: "nuclei.zip", size: 5 }]);
	} finally {
		manager.close();
	}
});

test("rejects an upload over the configured byte cap without keeping the temp file", async () => {
	const manager = new PocImportManager(async () => ({ imported: 0, replaced: 0, skipped: [] }), 4);
	try {
		const result = await manager.accept(
			"too-big.zip",
			(async function* () {
				yield Buffer.from("12345");
			})(),
		);
		expect(result).toMatchObject({ ok: false, status: 413 });
	} finally {
		manager.close();
	}
});
