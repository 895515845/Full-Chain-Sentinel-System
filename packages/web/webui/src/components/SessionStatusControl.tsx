/**
 * The operator's manual session status.
 *
 * Ten tasks in flight are indistinguishable in a list sorted by time, so each
 * session carries a label the operator sets: 待跟进 needs a nudge, 进行中 is being
 * worked on, 已完成 can be forgotten, 已忽略 is parked. It lives in the session
 * file as a `custom` entry, so it survives a restart and a fork, and it is never
 * sent to the model — the agent has no business reacting to the operator's own
 * bookkeeping.
 *
 * The chip appears in the session list and the toolbar, and both open the same
 * picker. The picker is `position: fixed` from the trigger's rect: the list is a
 * scroll container and the sider clips, so an absolutely positioned panel would
 * be cut off on the last rows.
 */

import { useEffect, useRef, useState } from "react";
import type { ZGSessionStatus } from "../types.ts";

export const SESSION_STATUSES: readonly ZGSessionStatus[] = ["todo", "active", "done", "ignored"];

export const SESSION_STATUS_LABELS: Record<ZGSessionStatus, string> = {
	todo: "待跟进",
	active: "进行中",
	done: "已完成",
	ignored: "已忽略",
};

/** Amber asks for attention, blue is running, green is finished, grey is parked. */
export const SESSION_STATUS_COLORS: Record<ZGSessionStatus, string> = {
	todo: "#e6a23c",
	active: "#409eff",
	done: "#52c41a",
	ignored: "#8c98a8",
};

const PICKER_WIDTH = 168;

function chipClass(status: ZGSessionStatus | null | undefined): string {
	return `session-status-chip ${status ?? "none"}`;
}

/** The status as a small colored label, or a muted one when it is unset. */
export function SessionStatusChip({ status }: { status?: ZGSessionStatus }) {
	return <span className={chipClass(status)}>{status ? SESSION_STATUS_LABELS[status] : "无状态"}</span>;
}

/**
 * A chip (session list) or button (toolbar) that opens the status picker.
 * `onPick(null)` clears the status.
 */
export function SessionStatusControl({
	status,
	variant,
	onPick,
}: {
	status?: ZGSessionStatus | null;
	variant: "chip" | "toolbar";
	onPick: (status: ZGSessionStatus | null) => void;
}) {
	const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
	const root = useRef<HTMLSpanElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!anchor) return;
		const close = (event: Event) => {
			if (event.type === "mousedown" && root.current?.contains(event.target as Node)) return;
			setAnchor(null);
		};
		// The panel is fixed, so anything that moves the trigger has to close it.
		document.addEventListener("mousedown", close);
		document.addEventListener("scroll", close, true);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("mousedown", close);
			document.removeEventListener("scroll", close, true);
			window.removeEventListener("resize", close);
		};
	}, [anchor]);

	const openPicker = () => {
		const rect = trigger.current?.getBoundingClientRect();
		if (!rect) return;
		const left =
			variant === "toolbar"
				? Math.max(8, Math.min(rect.right - PICKER_WIDTH, window.innerWidth - PICKER_WIDTH - 8))
				: Math.max(8, Math.min(rect.left - 26, window.innerWidth - PICKER_WIDTH - 8));
		setAnchor({ top: rect.bottom + 5, left });
	};

	const pick = (next: ZGSessionStatus | null) => {
		setAnchor(null);
		onPick(next);
	};

	return (
		<span className="session-status-control" ref={root}>
			<button
				ref={trigger}
				type="button"
				className={variant === "toolbar" ? `session-status-trigger ${status ?? "none"}` : chipClass(status)}
				title="人工标记这个会话的状态：只影响控制台显示与过滤，不会告诉模型"
				onClick={(event) => {
					// The session row behind the chip switches sessions on click.
					event.stopPropagation();
					if (anchor) setAnchor(null);
					else openPicker();
				}}
			>
				{variant === "toolbar" ? (
					<>
						<span
							className="session-status-dot"
							style={status ? { background: SESSION_STATUS_COLORS[status] } : undefined}
						/>
						{status ? SESSION_STATUS_LABELS[status] : "无状态"}
						<span className="session-status-caret">▾</span>
					</>
				) : (
					<>
						{status ? SESSION_STATUS_LABELS[status] : "无状态"}
						<span className="session-status-caret">▾</span>
					</>
				)}
			</button>
			{anchor ? (
				<div
					className="session-status-picker"
					style={{ top: anchor.top, left: anchor.left }}
					role="menu"
					// The panel is a DOM child of the session row, whose own click
					// switches sessions: picking a status must not also do that.
					onClick={(event) => event.stopPropagation()}
				>
					<button type="button" className={status ? "" : "on"} onClick={() => pick(null)}>
						<span className="session-status-dot none" />
						无状态
						{status ? null : <span className="session-status-tick">✓</span>}
					</button>
					{SESSION_STATUSES.map((value) => (
						<button key={value} type="button" className={status === value ? "on" : ""} onClick={() => pick(value)}>
							<span className="session-status-dot" style={{ background: SESSION_STATUS_COLORS[value] }} />
							{SESSION_STATUS_LABELS[value]}
							{status === value ? <span className="session-status-tick">✓</span> : null}
						</button>
					))}
				</div>
			) : null}
		</span>
	);
}
