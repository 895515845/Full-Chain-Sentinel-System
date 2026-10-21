import { useState } from "react";
import { t } from "../i18n.ts";
import { CaretDownIcon, CaretRightIcon } from "./icons.tsx";

/** First non-empty line of a text block, truncated for the collapsed summary row. */
function summaryLine(text: string, max = 110): string {
	const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Last non-empty line, so a running command shows where it got to. */
function tailLine(text: string, max = 110): string {
	const lines = text.split("\n").filter((candidate) => candidate.trim().length > 0);
	const line = lines[lines.length - 1] ?? "";
	return line.length > max ? `…${line.slice(-max)}` : line;
}

function durationLabel(durationMs: number | undefined): string {
	return durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : "";
}

/**
 * One tool call. Collapsed it is a quiet row in the run's timeline: the dot on
 * the left rail (drawn by the run body), the tool name, one line of the command
 * or its latest output, and the outcome on the right. Expanded it becomes the
 * dark terminal block, because that is where raw output belongs.
 */
export function ToolCard({
	name,
	status,
	time,
	durationMs,
	command,
	output,
	onFullscreen,
}: {
	name: string;
	status: "running" | "done" | "error";
	/** Wall-clock time of the call, so a live card reads like a finished step. */
	time?: string;
	durationMs?: number;
	command?: string;
	output: string;
	onFullscreen?: (command: string | undefined, output: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState<"command" | "output" | null>(null);

	const copy = async (kind: "command" | "output", text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(kind);
			window.setTimeout(() => setCopied(null), 1500);
		} catch {
			// Clipboard permission denied; ignore.
		}
	};

	const toggle = () => setExpanded((prev) => !prev);
	const onBarKey = (event: React.KeyboardEvent) => {
		if (event.key === "Enter" || event.key === " ") toggle();
	};
	// Running calls show where they got to; finished ones show what was run.
	const preview =
		status === "running" ? tailLine(output) || summaryLine(command ?? "") : summaryLine(command || output);
	const duration = durationLabel(durationMs);

	if (!expanded) {
		return (
			<div className={`tool-card ${status}`}>
				<div className="tool-row" role="button" tabIndex={0} onClick={toggle} onKeyDown={onBarKey}>
					{time ? <span className="tool-time">{time}</span> : null}
					<span className="tool-name">{name}</span>
					{preview ? (
						<span className={`tool-summary ${status === "running" ? "live" : ""}`}>{preview}</span>
					) : null}
					<span className={`tool-meta ${status}`}>
						{status === "running" ? t("运行中") : status === "error" ? t("失败") : "✓"}
						{duration ? <span className="tool-duration">{duration}</span> : null}
					</span>
					<span className="tool-caret">
						<CaretRightIcon size={11} />
					</span>
				</div>
			</div>
		);
	}

	return (
		<div className={`tool-card ${status} expanded`}>
			<div className="ws-console">
				<div className="ws-console__bar" role="button" tabIndex={0} onClick={toggle} onKeyDown={onBarKey}>
					<span className="ws-console__bar-title">
						<CaretDownIcon size={11} />
						<span className="tool-name">{name}</span>
						<span className={`tool-status ${status}`}>
							{status === "running" ? t("执行中…") : status === "error" ? t("出错") : t("完成")}
							{duration ? ` ${duration}` : ""}
						</span>
					</span>
					<span className="ws-console__bar-actions">
						{command ? (
							<button
								type="button"
								className="console-btn"
								onClick={(event) => {
									event.stopPropagation();
									void copy("command", command);
								}}
							>
								{copied === "command" ? t("已复制") : t("复制命令")}
							</button>
						) : null}
						{output ? (
							<>
								<button
									type="button"
									className="console-btn"
									onClick={(event) => {
										event.stopPropagation();
										void copy("output", output);
									}}
								>
									{copied === "output" ? t("已复制") : t("复制输出")}
								</button>
								{onFullscreen ? (
									<button
										type="button"
										className="console-btn"
										onClick={(event) => {
											event.stopPropagation();
											onFullscreen(command, output);
										}}
									>
										{t("全屏")}
									</button>
								) : null}
							</>
						) : null}
					</span>
				</div>
				{command ? <pre className="ws-console__body tool-command">{command}</pre> : null}
				{output ? (
					<pre className="ws-console__body">{output}</pre>
				) : (
					<pre className="ws-console__body is-empty">{status === "running" ? t("等待输出…") : t("（无输出）")}</pre>
				)}
			</div>
		</div>
	);
}

export function OutputViewer({ title, output, onClose }: { title: string; output: string; onClose: () => void }) {
	const [query, setQuery] = useState("");
	const lines = output.split("\n");
	const matched = query
		? lines
				.map((line, index) => ({ line, index }))
				.filter(({ line }) => line.toLowerCase().includes(query.toLowerCase()))
		: null;

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal output-viewer" onClick={(event) => event.stopPropagation()}>
				<h2>{title}</h2>
				<div className="viewer-toolbar">
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("搜索输出（过滤匹配行）…")}
						spellCheck={false}
					/>
					<span className="viewer-count">
						{matched ? t("{matched}/{total} 行匹配", { matched: matched.length, total: lines.length }) : t("{count} 行", { count: lines.length })}
					</span>
					<button type="button" onClick={onClose}>
						{t("关闭")}
					</button>
				</div>
				<pre className="viewer-body">
					{matched
						? matched.map(({ line, index }) => (
								<div key={index}>
									<span className="line-number">{index + 1}</span>
									{line}
								</div>
							))
						: output}
				</pre>
			</div>
		</div>
	);
}
