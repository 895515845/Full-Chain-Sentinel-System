/**
 * The operator's terminal: the session bookkeeping around a pty it does not own.
 *
 * What is pinned here is what the panel depends on and what Docker cannot be asked in
 * a unit test: that reopening attaches instead of starting a second shell, that the
 * scrollback a closed panel missed is replayed, that another project's live shell is
 * reported rather than silently replaced, and that a stopped container says so in
 * words. The pty itself is `docker exec` + util-linux `script` inside the container,
 * verified by hand against a real container.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { createTerminal, type TerminalDeps } from "../src/terminal.ts";

interface FakeShell {
	stdout: PassThrough;
	stderr: PassThrough;
	stdin: PassThrough;
	kill(signal?: string): boolean;
	/** Ends the shell as Docker would when the process exits. */
	exit(code: number | null): void;
}

function fakeShell(): FakeShell & EventEmitter {
	const emitter = new EventEmitter() as EventEmitter & FakeShell;
	emitter.stdout = new PassThrough();
	emitter.stderr = new PassThrough();
	emitter.stdin = new PassThrough();
	emitter.kill = () => {
		emitter.exit(143);
		return true;
	};
	emitter.exit = (code) => emitter.emit("close", code);
	return emitter;
}

function harness(overrides: Partial<TerminalDeps> = {}): {
	terminal: ReturnType<typeof createTerminal>;
	shells: Array<FakeShell & EventEmitter>;
	output: string[];
	exits: Array<number | null>;
	starts: Array<{ container: string; cols: number; rows: number }>;
} {
	const shells: Array<FakeShell & EventEmitter> = [];
	const output: string[] = [];
	const exits: Array<number | null> = [];
	const starts: Array<{ container: string; cols: number; rows: number }> = [];
	const deps: TerminalDeps = {
		isRunning: async () => true,
		start: (container, cols, rows) => {
			starts.push({ container, cols, rows });
			const shell = fakeShell();
			shells.push(shell);
			return shell as unknown as ReturnType<TerminalDeps["start"]>;
		},
		now: () => 1000,
		...overrides,
	};
	const terminal = createTerminal(
		{
			onOutput: (_projectId, data) => output.push(data),
			onExit: (_projectId, code) => exits.push(code),
		},
		deps,
	);
	return { terminal, shells, output, exits, starts };
}

const project = (container: string) => ({ projectId: `p-${container}`, projectName: container, cols: 100, rows: 30 });

test("reopening the panel attaches to the shell that is still running", async () => {
	const { terminal, shells, starts } = harness();
	const first = await terminal.open({ ...project("c1"), container: "c1" });
	expect(first.outcome).toBe("opened");
	shells[0]?.stdout.write("hello\r\n");
	const again = await terminal.open({ ...project("c1"), container: "c1" });
	expect(again.outcome).toBe("opened");
	// One shell, and the second open replays what the first one printed.
	expect(starts).toHaveLength(1);
	expect(again.outcome === "opened" ? again.replay : "").toContain("hello");
	expect(again.outcome === "opened" ? again.session.startedAt : 0).toBe(1000);
});

test("a closed panel's scrollback is replayed, and input reaches the shell", async () => {
	const { terminal, shells } = harness();
	await terminal.open({ ...project("c1"), container: "c1" });
	shells[0]?.stdout.write("line one\r\n");
	terminal.write("p-c1", "whoami\r\n");
	expect(shells[0]?.stdin.read()?.toString()).toBe("whoami\r\n");
	shells[0]?.stdout.write("root\r\n");
	// Reopening is what a closed panel does; nothing was killed in between.
	const reopened = await terminal.open({ ...project("c1"), container: "c1" });
	expect(reopened.outcome === "opened" ? reopened.replay : "").toContain("root");
});

test("a shell that exited is replaced by the next open", async () => {
	const { terminal, shells, exits, starts } = harness();
	await terminal.open({ ...project("c1"), container: "c1" });
	shells[0]?.exit(0);
	expect(exits).toEqual([0]);
	expect(terminal.session("p-c1")?.status).toBe("exited");
	expect(terminal.session("p-c1")?.code).toBe(0);
	// A dead shell has nothing to preserve: the next open starts a fresh one.
	await terminal.open({ ...project("c1"), container: "c1" });
	expect(starts).toHaveLength(2);
});

test("different projects can keep independent live shells", async () => {
	const { terminal, starts, shells } = harness();
	await terminal.open({ ...project("c1"), container: "c1" });
	const other = await terminal.open({ ...project("c2"), container: "c2" });
	expect(other.outcome).toBe("opened");
	expect(starts).toHaveLength(2);
	expect(terminal.sessions().map((session) => session.projectId)).toEqual(["p-c1", "p-c2"]);
	terminal.write("p-c2", "id\r\n");
	expect(shells[0]?.stdin.read()).toBeNull();
	expect(shells[1]?.stdin.read()?.toString()).toBe("id\r\n");
	terminal.close("p-c1");
	expect(terminal.session("p-c1")).toBeNull();
	expect(terminal.session("p-c2")?.status).toBe("running");
});

test("a stopped container is reported in words, and no shell is started", async () => {
	const { terminal, starts } = harness({ isRunning: async () => false });
	const opened = await terminal.open({ ...project("c1"), container: "c1" });
	expect(opened.outcome).toBe("failed");
	expect(opened.outcome === "failed" ? opened.error : "").toContain("c1");
	expect(starts).toHaveLength(0);
});

test("the scrollback is capped and keeps the newest output", async () => {
	const { terminal, shells } = harness();
	await terminal.open({ ...project("c1"), container: "c1" });
	const chunk = `${"x".repeat(60 * 1024)}\r\n`;
	for (let index = 0; index < 8; index += 1) shells[0]?.stdout.write(chunk);
	shells[0]?.stdout.write("THE END\r\n");
	const reopened = await terminal.open({ ...project("c1"), container: "c1" });
	const replay = reopened.outcome === "opened" ? reopened.replay : "";
	expect(replay).toContain("THE END");
	// 8 × 60KB written, 256KB kept: the oldest chunks are gone, the newest are not.
	expect(replay.length).toBeLessThanOrEqual(256 * 1024 + chunk.length);
	expect(replay.startsWith("x")).toBe(true);
});

test("a character split across two chunks is not mangled", async () => {
	const { terminal, shells, output } = harness();
	await terminal.open({ ...project("c1"), container: "c1" });
	const bytes = Buffer.from("中");
	shells[0]?.stdout.write(bytes.subarray(0, 2));
	shells[0]?.stdout.write(bytes.subarray(2));
	expect(output.join("")).toBe("中");
});

test("closing ends the shell, forgets it, and is not reported as an exit", async () => {
	const { terminal, shells, exits } = harness();
	await terminal.open({ ...project("c1"), container: "c1" });
	terminal.close("p-c1");
	// The panel already handled `terminal_state closed`; an exit event would print
	// "process exited" over the screen it just reset.
	expect(exits).toEqual([]);
	expect(terminal.session("p-c1")).toBeNull();
	expect(shells[0]?.stdin.writableEnded).toBe(true);
});
