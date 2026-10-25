/**
 * The operator's terminals: one persistent shell per project container.
 *
 * It is a real pty, because much of what a shell is used for during an engagement is
 * interactive — `nc -lvnp`, `top`, `ssh -t`, meterpreter — and a line-based
 * `docker exec` can run none of it. The pty is created *inside* the container by
 * util-linux `script`, which is already in the toolbox image; that keeps the console
 * free of a native module (it ships as a single-file binary on three platforms) and
 * needs no second image.
 *
 * Each project keeps its own shell. Closing the panel does not end a shell — watching
 * a listener is the point — so each output is kept in a ring buffer and replayed when
 * its panel reopens.
 * Nothing here is audited or gated: it is the operator's own shell, not a tool call.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import { runDocker } from "./docker.ts";
import { t } from "./i18n.ts";

/** Scrollback kept for a panel that was closed and reopened. */
const BUFFER_LIMIT = 256 * 1024;

/** Size used when the panel has not measured itself yet. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

/** The shell a fresh pty runs; `bash` when the image has it, `sh` otherwise. */
const SHELL = "stty rows {rows} cols {cols}; command -v bash >/dev/null 2>&1 && exec bash; exec sh";

export interface SentinelTerminalSession {
	status: "running" | "exited";
	projectId: string;
	projectName: string;
	container: string;
	cols: number;
	rows: number;
	startedAt: number;
	/** Exit code once the shell is gone; null while it runs. */
	code: number | null;
}

export type TerminalOpenResult =
	/** Attached to a live shell (created here, or reopened after the panel closed). */
	{ outcome: "opened"; session: SentinelTerminalSession; replay: string } | { outcome: "failed"; error: string };

export interface TerminalHooks {
	onOutput(projectId: string, data: string): void;
	onExit(projectId: string, code: number | null): void;
}

export interface TerminalDeps {
	/** Whether the container is up, so a stopped one is reported in words. */
	isRunning(container: string): Promise<boolean>;
	/** Starts the shell; injectable so the bookkeeping is testable without Docker. */
	start(container: string, cols: number, rows: number): ChildProcessWithoutNullStreams;
	now(): number;
}

export interface Terminal {
	open(input: {
		projectId: string;
		projectName: string;
		container: string;
		cols: number;
		rows: number;
	}): Promise<TerminalOpenResult>;
	write(projectId: string, data: string): void;
	close(projectId: string): void;
	session(projectId: string): SentinelTerminalSession | null;
	sessions(): SentinelTerminalSession[];
	dispose(): void;
}

interface Live {
	session: SentinelTerminalSession;
	child: ChildProcessWithoutNullStreams;
	decoder: TextDecoder;
	chunks: string[];
	length: number;
}

function clamp(value: number, low: number, high: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(high, Math.max(low, Math.trunc(value)));
}

function spawnShell(container: string, cols: number, rows: number): ChildProcessWithoutNullStreams {
	const command = SHELL.replace("{rows}", String(rows)).replace("{cols}", String(cols));
	// `script` gives the shell a pty inside the container; `-q` keeps its own banner
	// off the screen, `-f` flushes so output is not held back in blocks, and the
	// `/dev/null` typescript file is what util-linux wants as an argument.
	return spawn(
		"docker",
		["exec", "-i", "-e", "TERM=xterm-256color", "-w", "/work", container, "script", "-qfc", command, "/dev/null"],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
}

const defaultDeps: TerminalDeps = {
	isRunning: async (container) => {
		const state = await runDocker(["inspect", "-f", "{{.State.Running}}", container], { timeoutMs: 15000 });
		return state.code === 0 && state.stdout.trim() === "true";
	},
	start: spawnShell,
	now: () => Date.now(),
};

export function createTerminal(hooks: TerminalHooks, deps: TerminalDeps = defaultDeps): Terminal {
	const live = new Map<string, Live>();

	const replay = (entry: Live): string => entry.chunks.join("");

	const append = (entry: Live, text: string): void => {
		if (!text) return;
		entry.chunks.push(text);
		entry.length += text.length;
		// Trim whole chunks so the buffer never splits an escape sequence.
		while (entry.length > BUFFER_LIMIT && entry.chunks.length > 1) {
			const dropped = entry.chunks.shift();
			entry.length -= dropped?.length ?? 0;
		}
	};

	const stop = (entry: Live | undefined): void => {
		if (!entry) return;
		// Marked before the kill so the close handler below knows this exit was
		// deliberate: the panel already learned about it from `terminal_state closed`
		// and would otherwise print "process exited" over the reset screen.
		entry.session.status = "exited";
		entry.child.stdin.end();
		entry.child.kill("SIGTERM");
	};

	const start = (input: {
		projectId: string;
		projectName: string;
		container: string;
		cols: number;
		rows: number;
	}): Live => {
		const child = deps.start(input.container, input.cols, input.rows);
		const entry: Live = {
			session: {
				status: "running",
				projectId: input.projectId,
				projectName: input.projectName,
				container: input.container,
				cols: input.cols,
				rows: input.rows,
				startedAt: deps.now(),
				code: null,
			},
			child,
			// A chunk boundary can fall inside a multi-byte character; the streaming
			// decoder keeps the tail until the rest arrives.
			decoder: new TextDecoder("utf-8"),
			chunks: [],
			length: 0,
		};
		const onData = (chunk: Buffer): void => {
			const text = entry.decoder.decode(chunk, { stream: true });
			append(entry, text);
			hooks.onOutput(entry.session.projectId, text);
		};
		child.stdout.on("data", onData);
		// The Docker CLI's own failures ("no such container", "container is not
		// running") arrive here; showing them in the terminal beats a silent panel.
		child.stderr.on("data", onData);
		child.stdin.on("error", () => {
			// The shell may exit before the last keystroke is written; the exit code
			// is what the panel reports.
		});
		child.on("error", (error) => {
			append(entry, `\r\n${String(error)}\r\n`);
			hooks.onOutput(entry.session.projectId, `\r\n${String(error)}\r\n`);
		});
		child.on("close", (code) => {
			const deliberate = entry.session.status === "exited";
			entry.session.status = "exited";
			entry.session.code = code;
			if (!deliberate) hooks.onExit(entry.session.projectId, code);
		});
		return entry;
	};

	return {
		async open(input) {
			const cols = clamp(input.cols, 20, 500, DEFAULT_COLS);
			const rows = clamp(input.rows, 5, 200, DEFAULT_ROWS);

			const existing = live.get(input.projectId);
			if (existing?.session.status === "running" && existing.session.container === input.container) {
				return { outcome: "opened", session: existing.session, replay: replay(existing) };
			}
			if (existing) {
				// An exited shell, or a replaced project container, has nothing to preserve.
				stop(existing);
				live.delete(input.projectId);
			}
			if (!(await deps.isRunning(input.container))) {
				return { outcome: "failed", error: t("项目容器未运行：{container}", { container: input.container }) };
			}
			const entry = start({ ...input, cols, rows });
			live.set(input.projectId, entry);
			return { outcome: "opened", session: entry.session, replay: "" };
		},

		write(projectId, data) {
			const entry = live.get(projectId);
			if (!entry || entry.session.status !== "running" || entry.child.stdin.destroyed) return;
			entry.child.stdin.write(data);
		},

		close(projectId) {
			const entry = live.get(projectId);
			if (!entry) return;
			stop(entry);
			live.delete(projectId);
		},

		session(projectId) {
			return live.get(projectId)?.session ?? null;
		},

		sessions() {
			return [...live.values()].map((entry) => entry.session);
		},

		dispose() {
			for (const entry of live.values()) stop(entry);
			live.clear();
		},
	};
}
