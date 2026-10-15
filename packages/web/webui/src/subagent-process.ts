/**
 * The sub-agent process, shaped for display.
 *
 * The server stores a run's steps as a flat, append-only event list: text,
 * thinking, tool starts and ends, turn markers, status notes. The panel needs
 * them as turns with paired tool calls, one line describing each call, and a
 * duration per step, so all of that lives here, away from the React components
 * (and testable without a DOM).
 */

import type { SentinelSubagentEvent, SentinelSubagentRun, SentinelSubagentStatus } from "./types.ts";

export const STATUS_LABELS: Record<SentinelSubagentStatus, string> = {
	running: "运行中",
	done: "已完成",
	error: "失败",
	aborted: "已中止",
};

export type ToolStatus = "running" | "done" | "error";

/**
 * Which argument carries the point of a call, per tool. The sub-agent mounts the
 * coding tools, the gated bash, the hub tools and whatever extensions add, so an
 * unlisted tool falls back to its first scalar argument.
 */
const SUMMARY_FIELDS: Record<string, string[]> = {
	bash: ["command"],
	read: ["path"],
	write: ["path"],
	edit: ["path"],
	ls: ["path"],
	grep: ["pattern", "path"],
	find: ["pattern", "path"],
	glob: ["pattern", "path"],
	web_fetch: ["url"],
	web_search: ["query"],
	spawn_agent: ["task"],
	tool_search: ["query"],
	codemode: ["description", "code"],
	vuln_submit: ["title"],
	vuln_get: ["id"],
	vuln_list: ["target"],
};

/** Compact duration for a step, a turn or a whole run. */
export function formatMs(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const seconds = Math.round((ms % 60000) / 1000);
	return `${Math.floor(ms / 60000)}m${String(seconds).padStart(2, "0")}s`;
}

/** How long a finished run took; empty while it is still running. */
export function durationOf(run: SentinelSubagentRun): string {
	if (!run.endedAt) return "";
	return formatMs(new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime());
}

function oneLine(value: string, max = 130): string {
	const line = value.split("\n").find((candidate) => candidate.trim().length > 0) ?? value;
	const text = line.trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function lastLine(value: string, max = 130): string {
	const lines = value.split("\n").filter((candidate) => candidate.trim().length > 0);
	const text = (lines[lines.length - 1] ?? "").trim();
	return text.length > max ? `…${text.slice(-max)}` : text;
}

function scalar(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(" ");
	return undefined;
}

/** One line saying what a call did, so a row reads without expanding it. */
export function toolSummary(name: string, args: unknown, output: string, status: ToolStatus): string {
	const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
	if (record) {
		const named = (SUMMARY_FIELDS[name] ?? [])
			.map((field) => scalar(record[field]))
			.filter((value): value is string => value !== undefined && value !== "");
		if (named.length > 0) return oneLine(named.join(" "));
		const first = Object.values(record)
			.map(scalar)
			.find((value): value is string => value !== undefined && value !== "");
		if (first !== undefined) return oneLine(first);
		return oneLine(JSON.stringify(record));
	}
	// A call with no arguments still says something: where a running one got to,
	// or what a finished one returned.
	return status === "running" ? lastLine(output) : oneLine(output);
}

/** Markdown source without the syntax that reads as noise inside a two-line clamp. */
export function plainText(text: string): string {
	return (
		text
			.replace(/```[^\n]*\n?/g, "")
			// [ \t], not \s: with the m flag \s would also eat the blank line above a
			// heading or list item, collapsing the paragraph break with it.
			.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
			.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, "")
			.replace(/\*\*|__|`/g, "")
			.trim()
	);
}

export interface TextStep {
	kind: "text";
	seq: number;
	at: number;
	text: string;
	truncated: boolean;
}

export interface ThinkingStep {
	kind: "thinking";
	seq: number;
	at: number;
	text: string;
}

export interface ToolStep {
	kind: "tool";
	seq: number;
	at: number;
	name: string;
	args: unknown;
	output: string;
	isError: boolean;
	running: boolean;
	durationMs?: number;
	truncated: boolean;
	summary: string;
}

export interface StatusStep {
	kind: "status";
	seq: number;
	at: number;
	note: string;
	status?: SentinelSubagentStatus;
}

export type Step = TextStep | ThinkingStep | ToolStep | StatusStep;

export interface TurnGroup {
	index: number;
	steps: Step[];
	tools: number;
	failures: number;
	durationMs: number;
}

export function toolStatus(step: ToolStep): ToolStatus {
	return step.running ? "running" : step.isError ? "error" : "done";
}

function toolStepFrom(event: SentinelSubagentEvent, end: SentinelSubagentEvent | undefined): ToolStep {
	const name = event.toolName ?? "tool";
	const output = end?.output ?? "";
	const status: ToolStatus = end === undefined ? "running" : end.isError ? "error" : "done";
	return {
		kind: "tool",
		seq: event.seq,
		at: event.at,
		name,
		args: event.args,
		output,
		isError: end?.isError === true,
		running: end === undefined,
		durationMs: end?.durationMs,
		truncated: end?.truncated === true,
		summary: toolSummary(name, event.args, output, status),
	};
}

/**
 * A run's steps grouped by turn.
 *
 * The events of a turn are pushed as they happen and the `turn` marker closes
 * them, so a marker ends the group being built; whatever trails the last marker
 * is the turn still in flight. A `tool_end` is folded into its `tool_start`, so
 * one call is one row.
 */
export function buildTurns(events: SentinelSubagentEvent[]): TurnGroup[] {
	const ends = new Map<string, SentinelSubagentEvent>();
	const started = new Set<string>();
	for (const event of events) {
		if (event.kind === "tool_end" && event.toolCallId) ends.set(event.toolCallId, event);
		if (event.kind === "tool_start" && event.toolCallId) started.add(event.toolCallId);
	}

	const groups: TurnGroup[] = [];
	let current: Step[] = [];
	let lastIndex = 0;

	const flush = (markerIndex: number | undefined, endedAt: number): void => {
		if (markerIndex !== undefined) lastIndex = Math.max(lastIndex, markerIndex);
		if (current.length === 0) return;
		const index = markerIndex ?? lastIndex + 1;
		lastIndex = Math.max(lastIndex, index);
		const tools = current.filter((step): step is ToolStep => step.kind === "tool");
		groups.push({
			index,
			steps: current,
			tools: tools.length,
			failures: tools.filter((step) => step.isError).length,
			durationMs: endedAt - (current[0]?.at ?? endedAt),
		});
		current = [];
	};

	for (const event of events) {
		if (event.kind === "turn") {
			const marker = /第\s*(\d+)\s*轮/.exec(event.text ?? "")?.[1];
			flush(marker === undefined ? undefined : Number(marker), event.at);
			continue;
		}
		if (event.kind === "text") {
			current.push({
				kind: "text",
				seq: event.seq,
				at: event.at,
				text: event.text ?? "",
				truncated: event.truncated === true,
			});
			continue;
		}
		if (event.kind === "thinking") {
			current.push({ kind: "thinking", seq: event.seq, at: event.at, text: event.text ?? "" });
			continue;
		}
		if (event.kind === "tool_start") {
			current.push(toolStepFrom(event, event.toolCallId ? ends.get(event.toolCallId) : undefined));
			continue;
		}
		if (event.kind === "tool_end") {
			// Paired with its start above; an unpaired end is all the record there is.
			if (event.toolCallId && started.has(event.toolCallId)) continue;
			current.push(toolStepFrom(event, event));
			continue;
		}
		current.push({
			kind: "status",
			seq: event.seq,
			at: event.at,
			note: event.note ?? (event.status ? STATUS_LABELS[event.status] : ""),
			status: event.status,
		});
	}
	flush(undefined, current[current.length - 1]?.at ?? Date.now());
	return groups;
}
