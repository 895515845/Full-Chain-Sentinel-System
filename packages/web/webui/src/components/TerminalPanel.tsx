/**
 * The operator's terminal: a real shell in the selected project's container.
 *
 * It is the one panel that is not a view of the agent's work — nothing typed here is
 * gated, audited or sent to the model. That is the point: it is where an operator runs
 * the interactive half of an engagement (`nc -lvnp`, `top`, `ssh -t`) without spending
 * context or waiting for an approval.
 *
 * The pty is created inside the container by util-linux `script` (see
 * `packages/web/src/terminal.ts`), so the browser side is a plain xterm. Two
 * consequences are visible here and stated in the UI: the pty size is fixed when the
 * shell starts (`script` cannot resize it afterwards), and the shell outlives this
 * panel — closing it leaves the shell running, reopening replays the scrollback.
 */

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { t } from "../i18n.ts";
import { subscribeTerminal } from "../terminal-bus.ts";
import type { SentinelTerminalSession } from "../types.ts";
import { Overlay } from "./Overlay.tsx";

/** Terminal palette read from the console's own theme, so the panel is not foreign. */
function terminalTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
	const styles = getComputedStyle(document.documentElement);
	const read = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;
	return {
		background: read("--card", "#ffffff"),
		foreground: read("--text", "#000000d9"),
		cursor: read("--accent", "#0960bd"),
		selectionBackground: read("--accent-border", "#0960bd33"),
	};
}

function terminalFont(): string {
	const styles = getComputedStyle(document.documentElement);
	return styles.getPropertyValue("--mono").trim() || "ui-monospace, Menlo, monospace";
}

export function TerminalPanel({
	projectId,
	projectName,
	onOpen,
	onInput,
	onClose,
	onClosePanel,
}: {
	projectId: string;
	projectName: string;
	onOpen: (projectId: string, cols: number, rows: number) => void;
	onInput: (projectId: string, data: string) => void;
	/** Ends the shell on the server. */
	onClose: (projectId: string) => void;
	/** Hides the panel; the shell keeps running. */
	onClosePanel: () => void;
}) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	// The effect below runs once, so the callbacks it needs are read through a ref
	// rather than re-creating the terminal on every render.
	const handlers = useRef({ onOpen, onInput, projectId });
	handlers.current = { onOpen, onInput, projectId };

	const [phase, setPhase] = useState<"idle" | "running" | "exited" | "failed">("idle");
	const [session, setSession] = useState<SentinelTerminalSession | null>(null);
	const [error, setError] = useState<string | null>(null);

	const open = (): void => {
		const term = terminalRef.current;
		const fit = fitRef.current;
		if (!term || !fit) return;
		fit.fit();
		// A host that has not been laid out yet measures as zero columns; asking the
		// server for a 1×1 pty would leave the shell unusable until the panel reopened.
		if (term.cols < 20 || term.rows < 5) return;
		handlers.current.onOpen(handlers.current.projectId, term.cols, term.rows);
	};

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const term = new Terminal({
			theme: terminalTheme(),
			fontFamily: terminalFont(),
			fontSize: 12,
			lineHeight: 1.2,
			cursorBlink: true,
			scrollback: 5000,
			// The pty is created at the size fitted here; xterm keeps that geometry so
			// the two never disagree, and the host scrolls if the panel is made smaller.
			convertEol: false,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		fit.fit();
		terminalRef.current = term;
		fitRef.current = fit;
		const disposeData = term.onData((data) => handlers.current.onInput(handlers.current.projectId, data));

		const unsubscribe = subscribeTerminal((event) => {
			if (event.projectId !== handlers.current.projectId) return;
			if (event.kind === "output") {
				term.write(event.data);
				return;
			}
			if (event.kind === "exit") {
				setPhase("exited");
				term.write(`\r\n\x1b[2m${t("进程已退出（{code}）", { code: event.code ?? "?" })}\x1b[0m\r\n`);
				return;
			}
			if (event.outcome === "opened") {
				setError(null);
				setSession(event.session ?? null);
				setPhase("running");
				if (event.replay) term.write(event.replay);
				term.focus();
				return;
			}
			if (event.outcome === "failed") {
				setError(event.error ?? t("终端不可用"));
				setPhase("failed");
				return;
			}
			// closed: the shell was ended on purpose.
			setSession(null);
			setPhase("idle");
			term.reset();
		});

		// The modal has just been inserted; measure after the browser has laid it out.
		const frame = requestAnimationFrame(() => open());

		return () => {
			cancelAnimationFrame(frame);
			unsubscribe();
			disposeData.dispose();
			term.dispose();
			terminalRef.current = null;
			fitRef.current = null;
		};
		// Mount once: the terminal instance is what the panel is.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const running = phase === "running";
	const subtitle = session
		? `${session.projectName} · ${session.container} · ${
				session.status === "running" ? t("运行中") : t("已退出")
			}`
		: `${projectName} · ${t("未打开")}`;

	return (
		<Overlay
			title={t("终端")}
			subtitle={subtitle}
			className="terminal-panel"
			onClose={onClosePanel}
			actions={
				<span className="terminal-actions">
					<button type="button" className="ghost small" disabled={!running} onClick={() => onClose(projectId)}>
						{t("结束终端")}
					</button>
					<button type="button" className="ghost small" disabled={running} onClick={open}>
						{phase === "exited" ? t("重开") : t("打开终端")}
					</button>
				</span>
			}
		>
			<div className="terminal-shell">
				<div ref={hostRef} className="terminal-host" />
				{phase === "failed" ? (
					<div className="terminal-notice">
						<span>{error}</span>
						<button type="button" className="ghost small" onClick={open}>
							{t("重试")}
						</button>
					</div>
				) : null}
				<p className="terminal-hint">
					{t(
						"这个终端直接敲在项目容器里，不过审批、不进会话记录。窗口大小在打开时确定，全屏程序（top 等）要退出重进才对齐；关掉面板不会结束里面的进程。",
					)}
				</p>
			</div>
		</Overlay>
	);
}
