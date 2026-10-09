/**
 * Live registry of sub-agent runs.
 *
 * The spawn_agent tool runs its sub-agent inside the tool call and disposes the
 * session when it finishes, so nothing outside the tool could see progress or
 * stop one run. The registry keeps the live session handle and mirrors every
 * step into the SQLite store, which is what makes a finished run reviewable
 * after its session is gone.
 */

import { randomUUID } from "node:crypto";
import type { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { ZGSubagentEvent, ZGSubagentRun, ZGSubagentStatus } from "./protocol.ts";
import type { SubagentStore } from "./subagent-store.ts";

type LiveSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

export interface SubagentRegistryHooks {
	/** One live step, for streaming to connected consoles. */
	onEvent(runId: string, event: ZGSubagentEvent): void;
	/** A run started or finished; the snapshot's run list changed. */
	onRunChange(): void;
}

/** Handle owned by the spawn_agent tool for the duration of one run. */
export interface SubagentRunHandle {
	id: string;
	/** Record one step; `seq` and `at` are assigned here. */
	push(step: Omit<ZGSubagentEvent, "seq" | "at">): void;
	finish(input: { status: ZGSubagentStatus; result?: string; error?: string }): void;
}

interface LiveRun {
	run: ZGSubagentRun;
	session: LiveSession;
	seq: number;
}

export class SubagentRegistry {
	private readonly store: SubagentStore;
	private readonly hooks: SubagentRegistryHooks;
	private readonly live = new Map<string, LiveRun>();

	constructor(store: SubagentStore, hooks: SubagentRegistryHooks) {
		this.store = store;
		this.hooks = hooks;
		// Runs still marked "running" belong to a previous process.
		this.store.closeOrphanRuns();
	}

	beginRun(input: {
		sessionId: string;
		projectId?: string;
		task: string;
		mode: "explore" | "act";
		session: LiveSession;
	}): SubagentRunHandle {
		const id = randomUUID();
		const startedAt = new Date().toISOString();
		this.store.createRun({
			id,
			sessionId: input.sessionId,
			projectId: input.projectId,
			task: input.task,
			mode: input.mode,
			startedAt,
		});
		const run: ZGSubagentRun = {
			id,
			sessionId: input.sessionId,
			task: input.task,
			mode: input.mode,
			status: "running",
			turns: 0,
			startedAt,
		};
		const entry: LiveRun = { run, session: input.session, seq: 0 };
		this.live.set(id, entry);
		this.hooks.onRunChange();

		return {
			id,
			push: (step) => {
				entry.seq += 1;
				const event: ZGSubagentEvent = { ...step, seq: entry.seq, at: Date.now() };
				if (event.kind === "turn") run.turns += 1;
				this.store.appendEvent(id, event);
				this.hooks.onEvent(id, event);
			},
			finish: ({ status, result, error }) => {
				run.status = status;
				entry.seq += 1;
				this.store.appendEvent(id, {
					kind: "status",
					status,
					...(error ? { note: error } : {}),
					seq: entry.seq,
					at: Date.now(),
				});
				this.store.finishRun(id, {
					status,
					turns: run.turns,
					endedAt: new Date().toISOString(),
					result,
					error,
				});
				this.live.delete(id);
				this.hooks.onRunChange();
			},
		};
	}

	/** Runs of one session, newest first, without their process steps. */
	list(sessionId: string): ZGSubagentRun[] {
		return this.store.listRuns(sessionId).map((run) => this.withLiveState(run));
	}

	/** One run with its full process, from the live buffer when still running. */
	get(id: string): ZGSubagentRun | undefined {
		const run = this.store.getRun(id);
		if (!run) return undefined;
		return { ...this.withLiveState(run), events: this.store.listEvents(id) };
	}

	/** Stop one run without touching the parent or its siblings. */
	async abort(id: string): Promise<boolean> {
		const entry = this.live.get(id);
		if (!entry) return false;
		await entry.session.abort();
		return true;
	}

	/** Queue an instruction into a running sub-agent (pi's steer mechanism). */
	async steer(id: string, text: string): Promise<boolean> {
		const entry = this.live.get(id);
		if (!entry) return false;
		await entry.session.prompt(text, { streamingBehavior: "steer" });
		return true;
	}

	private withLiveState(run: ZGSubagentRun): ZGSubagentRun {
		const entry = this.live.get(run.id);
		return entry ? { ...run, status: "running", turns: entry.run.turns } : run;
	}
}
