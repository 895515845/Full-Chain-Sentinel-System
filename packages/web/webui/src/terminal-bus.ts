/**
 * The terminal's data path.
 *
 * A shell writes thousands of small chunks — a scanner prints a line per host — and the
 * panel has to hand each one to xterm as it lands. Routing that through React state
 * would re-render the chat page per chunk, so the socket messages go through this tiny
 * bus instead: `App.tsx` publishes what arrived, the open panel subscribes.
 *
 * Nothing is buffered here. The server keeps the scrollback and replays it when a panel
 * opens, which is also what makes a closed panel harmless.
 */

import type { SentinelTerminalSession } from "./types.ts";

export type TerminalEvent =
	| {
		kind: "state";
		projectId: string;
		outcome: "opened" | "failed" | "closed";
			session?: SentinelTerminalSession;
			/** Scrollback from while the panel was closed. */
			replay?: string;
			error?: string;
	  }
	| { kind: "output"; projectId: string; data: string }
	| { kind: "exit"; projectId: string; code: number | null };

type Listener = (event: TerminalEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe the panel; returns the unsubscribe function for its effect cleanup. */
export function subscribeTerminal(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Called from the socket handler for every terminal message. */
export function publishTerminal(event: TerminalEvent): void {
	for (const listener of listeners) listener(event);
}
