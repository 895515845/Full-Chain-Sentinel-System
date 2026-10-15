/**
 * Operator approval gate for bash commands.
 *
 * In "review" mode every bash tool call resolves here first: requests are
 * broadcast to connected consoles and execution waits for a decision (approve,
 * approve an edited command, or reject). Commands whose first word matches an
 * operator-allowed prefix (e.g. "nmap") execute without a prompt, unless the
 * command is compound (&&, ;, |, substitution) — those always require a human.
 */

import type { SentinelApprovalRequest } from "./protocol.ts";

export interface ApprovalOutcome {
	approved: boolean;
	/** Command to execute; present only when approved. May differ from the original. */
	command?: string;
	/** Why the command was not executed. */
	reason?: string;
}

interface PendingEntry {
	request: SentinelApprovalRequest;
	finalize: (outcome: ApprovalOutcome) => void;
	abortListener: () => void;
	signal: AbortSignal | undefined;
}

/** Characters that make a command compound; prefix rules never apply to these. */
const COMPOUND_COMMAND_PATTERN = /&&|\|\||;|\||`|\$\(|>\s*\(/;

/** The prefix a command resolves to for allow-listing: its first word. */
export function commandPrefix(command: string): string {
	const trimmed = command.trim();
	const index = trimmed.search(/\s/);
	return index === -1 ? trimmed : trimmed.slice(0, index);
}

function isCompound(command: string): boolean {
	return COMPOUND_COMMAND_PATTERN.test(command);
}

export class ApprovalGate {
	private pending = new Map<string, PendingEntry>();
	private counter = 0;
	private allowedPrefixes: string[] = [];
	private readonly onChange: () => void;

	constructor(onChange: () => void) {
		this.onChange = onChange;
	}

	/** True when the command may run without approval under the current prefix rules. */
	isAutoAllowed(command: string): boolean {
		if (this.allowedPrefixes.length === 0 || isCompound(command)) return false;
		return this.allowedPrefixes.includes(commandPrefix(command));
	}

	allowPrefix(prefix: string): void {
		const normalized = prefix.trim();
		if (!normalized || this.allowedPrefixes.includes(normalized)) return;
		this.allowedPrefixes.push(normalized);
		this.onChange();
	}

	removeAllowedPrefix(prefix: string): void {
		this.allowedPrefixes = this.allowedPrefixes.filter((item) => item !== prefix);
		this.onChange();
	}

	getAllowedPrefixes(): string[] {
		return [...this.allowedPrefixes];
	}

	/** Wait for an operator decision on `command`. Prefix hits and aborts resolve immediately. */
	async request(
		command: string,
		cwd: string,
		signal: AbortSignal | undefined,
		source = "主代理",
	): Promise<ApprovalOutcome> {
		if (this.isAutoAllowed(command)) return { approved: true, command };
		return new Promise<ApprovalOutcome>((resolve) => {
			const id = `approval-${Date.now().toString(36)}-${++this.counter}`;
			const settle = (outcome: ApprovalOutcome): void => resolve(outcome);
			const entry: PendingEntry = {
				request: { id, command, cwd, source },
				signal,
				abortListener: () => settle({ approved: false, reason: "aborted" }),
				finalize: settle,
			};
			if (signal?.aborted) {
				resolve({ approved: false, reason: "aborted" });
				return;
			}
			signal?.addEventListener("abort", entry.abortListener, { once: true });
			this.pending.set(id, entry);
			this.onChange();
		});
	}

	/** Apply one operator decision. Unknown ids are ignored. */
	decide(id: string, approved: boolean, editedCommand?: string, alwaysAllowPrefix = false): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		this.pending.delete(id);
		entry.signal?.removeEventListener("abort", entry.abortListener);
		const command = approved ? (editedCommand?.trim() ? editedCommand : entry.request.command) : undefined;
		if (approved && alwaysAllowPrefix && command) this.allowPrefix(commandPrefix(command));
		this.onChange();
		entry.finalize(approved ? { approved: true, command } : { approved: false, reason: "rejected by operator" });
		return true;
	}

	/** Approve or reject every pending request at once. Returns how many were decided. */
	decideAll(approved: boolean): number {
		const entries = [...this.pending.values()];
		for (const entry of entries) {
			this.pending.delete(entry.request.id);
			entry.signal?.removeEventListener("abort", entry.abortListener);
			entry.finalize(
				approved
					? { approved: true, command: entry.request.command }
					: { approved: false, reason: "rejected by operator" },
			);
		}
		if (entries.length > 0) this.onChange();
		return entries.length;
	}

	listPending(): SentinelApprovalRequest[] {
		return [...this.pending.values()].map((entry) => entry.request);
	}

	/** Reject everything pending, e.g. when the session is being replaced. */
	rejectAll(reason: string): void {
		const entries = [...this.pending.values()];
		for (const entry of entries) {
			this.pending.delete(entry.request.id);
			entry.signal?.removeEventListener("abort", entry.abortListener);
			entry.finalize({ approved: false, reason });
		}
		if (entries.length > 0) this.onChange();
	}
}
