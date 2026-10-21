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
import { t } from "../i18n.ts";
import type { SentinelSessionStatus } from "../types.ts";

export const SESSION_STATUSES: readonly SentinelSessionStatus[] = ["todo", "active", "done", "ignored"];

export const SESSION_STATUS_LABELS: Record<SentinelSessionStatus, string> = {
	todo: t("待跟进"),
	active: t("进行中"),
	done: t("已完成"),
	ignored: t("已忽略"),
};

const PICKER_WIDTH = 168;
/**
 * Panel height for placement: five 30px rows, 2x5px padding, 2px border. The
 * picker is `position: fixed`, so without this the last rows of a session near
 * the window bottom (已完成 / 已忽略) fall outside the viewport and cannot be
 * clicked at all.
 */
const PICKER_HEIGHT = 5 * 30 + 10 + 2;
const VIEWPORT_MARGIN = 8;

function chipClass(status: SentinelSessionStatus | null | undefined): string {
	return `session-status-chip ${status ?? "none"}`;
}

/** The status as a small colored label, or a muted one when it is unset. */
export function SessionStatusChip({ status }: { status?: SentinelSessionStatus }) {
	return <span className={chipClass(status)}>{status ? SESSION_STATUS_LABELS[status] : t("无状态")}</span>;
}

/**
 * How a session row carries its manual status: a 2px rail at the row's left edge
 * whose color matches the status, plus the label for the two terminal statuses.
 *
 * The rail covers every set status — it used to be drawn for 待跟进/进行中 only, so
 * marking a session 已完成/已忽略 changed nothing visible in the list and looked
 * like the mark had not been saved. A color alone cannot tell 已完成 from 已忽略,
 * so those two also carry the label; 待跟进/进行中 stay label-free because the
 * rail is the attention cue there and the list stays compact.
 */
export function SessionStatusRail({ status }: { status?: SentinelSessionStatus | null }) {
	if (!status) return null;
	const terminal = status === "done" || status === "ignored";
	return (
		<>
			<span className={`status-rail rail-${status}`} title={t("人工标记：{status}", { status: SESSION_STATUS_LABELS[status] })} />
			{terminal ? <span className={`session-row-status row-${status}`}>{SESSION_STATUS_LABELS[status]}</span> : null}
		</>
	);
}

/**
 * A chip (session list) or button (toolbar) that opens the status picker.
 * `onPick(null)` clears the status.
 */
export function SessionStatusControl({
	status,
	variant,
	onPick,
	onOpenChange,
}: {
	status?: SentinelSessionStatus | null;
	variant: "chip" | "toolbar";
	onPick: (status: SentinelSessionStatus | null) => void;
	/**
	 * Whether the picker is open. A host that hides itself when the pointer
	 * leaves (the session list's hover card) uses this to stay alive while the
	 * panel is up; without it the card unmounts on the way to the panel and the
	 * statuses cannot be clicked at all.
	 */
	onOpenChange?: (open: boolean) => void;
}) {
	const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
	const root = useRef<HTMLSpanElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		onOpenChange?.(anchor !== null);
	}, [anchor, onOpenChange]);

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
		// Below the trigger when it fits, above it otherwise, so every row of the
		// picker stays inside the viewport.
		const below = rect.bottom + 5;
		const top =
			below + PICKER_HEIGHT <= window.innerHeight - VIEWPORT_MARGIN
				? below
				: Math.max(VIEWPORT_MARGIN, rect.top - 5 - PICKER_HEIGHT);
		setAnchor({ top, left });
	};

	const pick = (next: SentinelSessionStatus | null) => {
		setAnchor(null);
		onPick(next);
	};

	return (
		<span className="session-status-control" ref={root}>
			<button
				ref={trigger}
				type="button"
				className={variant === "toolbar" ? `session-status-trigger ${status ?? "none"}` : chipClass(status)}
				title={t("人工标记这个会话的状态：只影响控制台显示与过滤，不会告诉模型")}
				onClick={(event) => {
					// The session row behind the chip switches sessions on click.
					event.stopPropagation();
					if (anchor) setAnchor(null);
					else openPicker();
				}}
			>
				{variant === "toolbar" ? (
					<>
						<span className={`session-status-dot ${status ?? "none"}`} />
						{status ? SESSION_STATUS_LABELS[status] : t("无状态")}
						<span className="session-status-caret">▾</span>
					</>
				) : (
					<>
						{status ? SESSION_STATUS_LABELS[status] : t("无状态")}
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
						{t("无状态")}
						{status ? null : <span className="session-status-tick">✓</span>}
					</button>
					{SESSION_STATUSES.map((value) => (
						<button
							key={value}
							type="button"
							className={status === value ? "on" : ""}
							onClick={() => pick(value)}
						>
							<span className={`session-status-dot ${value}`} />
							{SESSION_STATUS_LABELS[value]}
							{status === value ? <span className="session-status-tick">✓</span> : null}
						</button>
					))}
				</div>
			) : null}
		</span>
	);
}
