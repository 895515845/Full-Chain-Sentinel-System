/**
 * The shared transport primitives: frame size, stream assembly, pending
 * requests. These are the pieces both device gateways rely on, so they are
 * tested without any socket at all.
 */

import { expect, test } from "vitest";
import {
	DEVICE_MAX_FRAME_BYTES,
	DEVICE_MAX_STREAM_BYTES,
	encodeFrame,
	PendingRequests,
	StreamAssembler,
} from "../src/device-transport.ts";

test("encodeFrame accepts a normal frame", () => {
	const encoded = encodeFrame({ t: "exec", cmd: "id" });
	expect(encoded.ok).toBe(true);
	expect(JSON.parse(encoded.text as string)).toEqual({ t: "exec", cmd: "id" });
});

test("encodeFrame refuses a frame over the ceiling instead of letting the phone OOM", () => {
	const encoded = encodeFrame({ t: "push", b64: "x".repeat(DEVICE_MAX_FRAME_BYTES) });
	expect(encoded.ok).toBe(false);
	expect(encoded.error).toContain("超过");
});

test("the assembler concatenates chunks in order and frees them on take", () => {
	const assembler = new StreamAssembler();
	expect(assembler.push("r1", 0, Buffer.from("he").toString("base64")).ok).toBe(true);
	expect(assembler.push("r1", 1, Buffer.from("llo").toString("base64")).ok).toBe(true);
	expect(assembler.take("r1")?.toString()).toBe("hello");
	expect(assembler.take("r1")).toBeUndefined();
});

test("the assembler refuses an out-of-order chunk", () => {
	const assembler = new StreamAssembler();
	const outcome = assembler.push("r2", 3, Buffer.from("x").toString("base64"));
	expect(outcome.ok).toBe(false);
	expect(outcome.error).toContain("乱序");
});

test("the assembler enforces the stream size ceiling", () => {
	const assembler = new StreamAssembler();
	const outcome = assembler.push("r3", 0, Buffer.from("abc").toString("base64"), { limitBytes: 2 });
	expect(outcome.ok).toBe(false);
	expect(outcome.error).toContain("大小上限");
});

test("buffer=false yields the chunk without keeping it", () => {
	const assembler = new StreamAssembler();
	const outcome = assembler.push("r4", 0, Buffer.from("aa").toString("base64"), { buffer: false });
	expect(outcome.ok).toBe(true);
	expect(outcome.chunk?.toString()).toBe("aa");
	// No buffered chunks were kept, so take returns an empty buffer, not the payload.
	expect(assembler.take("r4")?.length).toBe(0);
});

test("a pending request times out with the caller's value and runs its cleanup", async () => {
	const pending = new PendingRequests<string>();
	let cleaned = false;
	const result = await new Promise<string>((resolve) => {
		pending.add("r5", "d1", {
			timeoutMs: 30,
			timeoutValue: "timeout",
			resolve,
			onTimeout: () => {
				cleaned = true;
			},
		});
		expect(pending.has("r5")).toBe(true);
	});
	expect(result).toBe("timeout");
	expect(cleaned).toBe(true);
	expect(pending.has("r5")).toBe(false);
});

test("failDevice resolves exactly the calls of one device", async () => {
	const pending = new PendingRequests<string>();
	const one = new Promise<string>((resolve) => {
		pending.add("r6", "d1", { timeoutMs: 5000, timeoutValue: "timeout", resolve });
	});
	const two = new Promise<string>((resolve) => {
		pending.add("r7", "d1", { timeoutMs: 5000, timeoutValue: "timeout", resolve });
	});
	new Promise<string>((resolve) => {
		pending.add("r8", "d2", { timeoutMs: 5000, timeoutValue: "timeout", resolve });
	});
	expect(pending.failDevice("d1", "disconnected")).toBe(2);
	expect(await one).toBe("disconnected");
	expect(await two).toBe("disconnected");
	expect(pending.has("r8")).toBe(true);
	pending.clear();
	expect(pending.size).toBe(0);
});

test("a settled request is removed and cannot be settled twice", () => {
	const pending = new PendingRequests<string>();
	let resolved = 0;
	pending.add("r9", "d1", {
		timeoutMs: 5000,
		timeoutValue: "timeout",
		resolve: () => {
			resolved += 1;
		},
	});
	expect(pending.settle("r9")).toBeDefined();
	expect(pending.settle("r9")).toBeUndefined();
	expect(pending.fail("r9", "late")).toBe(false);
	expect(resolved).toBe(0);
	expect(DEVICE_MAX_STREAM_BYTES).toBeGreaterThan(0);
});
