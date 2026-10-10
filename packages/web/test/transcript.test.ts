/**
 * Unit tests for the console transcript.
 *
 * The console shows the session branch, not the model context: after a
 * compaction the model only sees the summary plus the kept entries, while the
 * console has to keep showing what the summary replaced. These tests pin that
 * difference, plus the fork points that have to line up with it.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { branchTranscript, branchUserMessages, messageText, withSystemPrompt } from "../src/transcript.ts";

const at = (seconds: number) => new Date(seconds * 1000).toISOString();

/** A message entry, as the session file stores it. */
function messageEntry(id: string, parentId: string | null, message: unknown, seconds = 1): SessionEntry {
	return { type: "message", id, parentId, timestamp: at(seconds), message } as unknown as SessionEntry;
}

test("branchTranscript keeps the entries a compaction replaced", () => {
	const entries: SessionEntry[] = [
		messageEntry("u1", null, { role: "user", content: "先侦察 10.10.10.5", timestamp: 1000 }, 1),
		messageEntry("a1", "u1", { role: "assistant", content: [{ type: "text", text: "开始" }], timestamp: 2000 }, 2),
		{
			type: "compaction",
			id: "c1",
			parentId: "a1",
			timestamp: at(3),
			summary: "已侦察 10.10.10.5，开放 22/80/443",
			firstKeptEntryId: "u2",
			tokensBefore: 42000,
		} as SessionEntry,
		messageEntry("u2", "c1", { role: "user", content: "继续", timestamp: 4000 }, 4),
		messageEntry("a2", "u2", { role: "assistant", content: [{ type: "text", text: "继续中" }], timestamp: 5000 }, 5),
	];

	const messages = branchTranscript(entries);
	expect(messages.map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"compactionSummary",
		"user",
		"assistant",
	]);
	// The summarized messages are still there, and the marker says how much they
	// were worth; that is the whole point of the transcript view.
	expect(messages[0]).toMatchObject({ role: "user", content: "先侦察 10.10.10.5" });
	expect(messages[2]).toMatchObject({
		role: "compactionSummary",
		summary: "已侦察 10.10.10.5，开放 22/80/443",
		tokensBefore: 42000,
		timestamp: 3000,
	});
});

test("branchTranscript leaves out state entries and the system prompt", () => {
	const entries: SessionEntry[] = [
		{ type: "session_info", id: "s0", parentId: null, timestamp: at(1), name: "侦察" } as SessionEntry,
		messageEntry("sys", "s0", { role: "system", content: "You are a pentest agent." }, 2),
		messageEntry("u1", "sys", { role: "user", content: "hi", timestamp: 3000 }, 3),
		{
			type: "usage",
			id: "g1",
			parentId: "u1",
			timestamp: at(4),
			kind: "cache_warm",
			provider: "p",
			model: "m",
			usage: {},
		} as SessionEntry,
		{ type: "model_change", id: "m1", parentId: "g1", timestamp: at(5), provider: "p", modelId: "m" } as SessionEntry,
		{ type: "label", id: "l1", parentId: "m1", timestamp: at(6), targetId: "u1", label: "起点" } as SessionEntry,
		{
			type: "context_edit",
			id: "e1",
			parentId: "l1",
			timestamp: at(7),
			targetId: "u1",
			replacement: null,
		} as SessionEntry,
	];

	// The system prompt is dropped (the console never renders it, and it would
	// ride in every snapshot), state entries contribute nothing, and a context
	// edit does not erase the history it removed from the model's context.
	expect(branchTranscript(entries).map((message) => message.role)).toEqual(["user"]);
});

test("branchTranscript renders a branch summary and a custom message", () => {
	const entries: SessionEntry[] = [
		{
			type: "branch_summary",
			id: "b1",
			parentId: null,
			timestamp: at(1),
			fromId: "x",
			summary: "另一条分支",
		} as SessionEntry,
		{
			type: "custom_message",
			id: "cm1",
			parentId: "b1",
			timestamp: at(2),
			customType: "note",
			content: "扩展注入",
			display: true,
		} as SessionEntry,
	];

	expect(branchTranscript(entries)).toEqual([
		{ role: "branchSummary", summary: "另一条分支", fromId: "x", timestamp: 1000 },
		{ role: "custom", customType: "note", content: "扩展注入", display: true, details: undefined, timestamp: 2000 },
	]);
});

test("branchUserMessages lists the branch's prompts, in transcript order", () => {
	const entries: SessionEntry[] = [
		messageEntry("u1", null, { role: "user", content: "第一条", timestamp: 1000 }, 1),
		messageEntry("a1", "u1", { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2000 }, 2),
		{
			type: "compaction",
			id: "c1",
			parentId: "a1",
			timestamp: at(3),
			summary: "摘要",
			firstKeptEntryId: "u2",
			tokensBefore: 100,
		} as SessionEntry,
		messageEntry("u2", "c1", { role: "user", content: [{ type: "text", text: "第二条" }], timestamp: 4000 }, 4),
		// An image-only prompt has no text, and is still a fork point.
		messageEntry(
			"u3",
			"u2",
			{ role: "user", content: [{ type: "image", data: "AA", mimeType: "image/png" }], timestamp: 5000 },
			5,
		),
	];

	expect(branchUserMessages(entries)).toEqual([
		{ entryId: "u1", text: "第一条" },
		{ entryId: "u2", text: "第二条" },
		{ entryId: "u3", text: "" },
	]);
	// The pairing is by index, so the counts must match exactly: one fork point
	// per operator message in the transcript, in the same order.
	const prompts = branchTranscript(entries).filter((message) => message.role === "user");
	expect(prompts.map((message) => messageText(message).trim())).toEqual(["第一条", "第二条", ""]);
	expect(branchUserMessages(entries).length).toBe(prompts.length);
});

test("withSystemPrompt puts the live prompt in front of the transcript", () => {
	const transcript = branchTranscript([messageEntry("u1", null, { role: "user", content: "hi", timestamp: 1000 }, 1)]);
	const live = [
		{ role: "system", content: "You are a pentest agent." },
		{ role: "user", content: "hi" },
	];

	expect(withSystemPrompt(transcript, live).map((message) => message.role)).toEqual(["system", "user"]);
	// A session whose context has no prompt yet stays a plain transcript.
	expect(withSystemPrompt(transcript, [{ role: "user", content: "hi" }])).toEqual(transcript);
});

test("messageText reads string and block content", () => {
	expect(messageText({ content: "plain" })).toBe("plain");
	expect(
		messageText({
			content: [
				{ type: "text", text: "a" },
				{ type: "thinking", thinking: "b" },
				{ type: "text", text: "c" },
			],
		}),
	).toBe("ac");
	expect(messageText({})).toBe("");
	expect(messageText(undefined)).toBe("");
});
