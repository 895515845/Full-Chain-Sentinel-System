/**
 * Session transcript for the console.
 *
 * `session.messages` is the *model context*: after a compaction it is the
 * summary plus the entries the compaction kept, and everything the summary
 * replaced is gone from it. The console shows the *transcript* instead — every
 * entry on the current branch, in order, with each compaction left in place as a
 * marker row. That is why a compaction does not make the conversation above it
 * disappear, and why the marker row can say how much was summarized.
 *
 * The mapping from entry to message is the SDK's own, so a custom message or a
 * branch summary renders exactly the way the SDK would hand it to a model.
 */

import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

/** The SDK's own message shape for a session entry. */
type TranscriptMessage = ReturnType<typeof sessionEntryToContextMessages>[number];

/**
 * Every message on the branch, compaction markers included. System entries are
 * left out: the console never renders the prompt, and shipping it would put the
 * whole system prompt into every state snapshot.
 */
export function branchTranscript(entries: readonly SessionEntry[]): TranscriptMessage[] {
	const messages: TranscriptMessage[] = [];
	for (const entry of entries) {
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role === "system") continue;
			messages.push(message);
		}
	}
	return messages;
}

/**
 * The branch's operator messages, which are what the console offers as fork
 * points. It must be the same list the transcript is built from: the client
 * pairs them by index, so a fork point that comes from another branch, or from
 * before a compaction, would attach to the wrong message. Every operator message
 * is listed, an empty one included — an image-only prompt has no text at all, and
 * skipping it would shift every fork point after it.
 */
export function branchUserMessages(entries: readonly SessionEntry[]): { entryId: string; text: string }[] {
	const result: { entryId: string; text: string }[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		result.push({ entryId: entry.id, text: messageText(entry.message).trim() });
	}
	return result;
}

/**
 * The live system prompt, in front of a transcript.
 *
 * The prompt is not a session entry: the agent keeps it in `session.messages`,
 * rebuilt for this session's tools and snippets, so a transcript read from the
 * session file has to take it from there. The console never renders it, but the
 * state snapshot has always carried it, and the prompt is what names the tools a
 * session actually has.
 */
export function withSystemPrompt(
	transcript: readonly TranscriptMessage[],
	live: readonly unknown[],
): TranscriptMessage[] {
	const system = live.find((message) => (message as { role?: string }).role === "system");
	return system ? [system as TranscriptMessage, ...transcript] : [...transcript];
}

/** Concatenated text blocks of a message, ignoring thinking and tool calls. */
export function messageText(message: { content?: unknown } | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}
