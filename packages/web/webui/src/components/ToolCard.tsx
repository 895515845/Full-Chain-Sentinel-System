import { useEffect, useRef, useState } from "react";

/** First non-empty line of a text block, truncated for the collapsed summary row. */
function summaryLine(text: string, max = 110): string {
	const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function ToolCard({
	name,
	status,
	durationMs,
	command,
	output,
	onFullscreen,
}: {
	name: string;
	status: "running" | "done" | "error";
	durationMs?: number;
	command?: string;
	output: string;
	onFullscreen?: (command: string | undefined, output: string) => void;
}) {
	// Running tools stream their output expanded; finished tools collapse to one
	// row so long sessions stay readable.
	const [expanded, setExpanded] = useState(status === "running");
	const wasRunning = useRef(status === "running");
	const [copied, setCopied] = useState<"command" | "output" | null>(null);

	useEffect(() => {
		if (status === "running") {
			wasRunning.current = true;
			setExpanded(true);
		} else if (wasRunning.current) {
			wasRunning.current = false;
			setExpanded(false);
		}
	}, [status]);

	const copy = async (kind: "command" | "output", text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(kind);
			window.setTimeout(() => setCopied(null), 1500);
		} catch {
			// Clipboard permission denied; ignore.
		}
	};

	const preview = summaryLine(output || command || "");

	return (
		<div className={`tool-card ${status} ${expanded ? "expanded" : "collapsed"}`}>
			<div
				className="tool-head"
				onClick={() => setExpanded((prev) => !prev)}
				role="button"
				tabIndex={0}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") setExpanded((prev) => !prev);
				}}
			>
				<span className="tool-caret">{expanded ? "▾" : "▸"}</span>
				<span className="tool-name">{name}</span>
				{!expanded && preview ? <span className="tool-summary">{preview}</span> : null}
				<span className="tool-actions">
					<span className="tool-status">
						{status === "running" ? "执行中…" : status === "error" ? "出错" : "完成"}
						{durationMs !== undefined ? ` ${(durationMs / 1000).toFixed(1)}s` : ""}
					</span>
					{expanded && command ? (
						<button
							type="button"
							className="ghost small"
							onClick={(event) => {
								event.stopPropagation();
								copy("command", command);
							}}
						>
							{copied === "command" ? "已复制" : "复制命令"}
						</button>
					) : null}
					{expanded && output ? (
						<>
							<button
								type="button"
								className="ghost small"
								onClick={(event) => {
									event.stopPropagation();
									copy("output", output);
								}}
							>
								{copied === "output" ? "已复制" : "复制输出"}
							</button>
							{onFullscreen ? (
								<button
									type="button"
									className="ghost small"
									onClick={(event) => {
										event.stopPropagation();
										onFullscreen(command, output);
									}}
								>
									全屏查看
								</button>
							) : null}
						</>
					) : null}
				</span>
			</div>
			{expanded ? (
				<>
					{command ? <pre className="tool-command">{command}</pre> : null}
					{output ? <pre className="tool-output">{output}</pre> : null}
				</>
			) : null}
		</div>
	);
}

export function OutputViewer({
	title,
	output,
	onClose,
}: {
	title: string;
	output: string;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const lines = output.split("\n");
	const matched = query
		? lines.map((line, index) => ({ line, index })).filter(({ line }) => line.toLowerCase().includes(query.toLowerCase()))
		: null;

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal output-viewer" onClick={(event) => event.stopPropagation()}>
				<h2>{title}</h2>
				<div className="viewer-toolbar">
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="搜索输出（过滤匹配行）…"
						spellCheck={false}
					/>
					<span className="viewer-count">
						{matched ? `${matched.length}/${lines.length} 行匹配` : `${lines.length} 行`}
					</span>
					<button type="button" onClick={onClose}>
						关闭
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
