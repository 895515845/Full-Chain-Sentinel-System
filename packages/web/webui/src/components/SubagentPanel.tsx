import { useEffect, useMemo, useRef, useState } from "react";
import {
	buildTurns,
	durationOf,
	formatMs,
	plainText,
	STATUS_LABELS,
	type Step,
	type TextStep,
	type ToolStep,
	toolStatus,
} from "../subagent-process.ts";
import type { ZGSubagentEvent, ZGSubagentRun } from "../types.ts";
import { CaretDownIcon, CaretRightIcon } from "./icons.tsx";
import { MarkdownText } from "./MessageView.tsx";

function formatClock(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function scalar(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(" ");
	return undefined;
}

/** Structured arguments: the command stands alone, the rest reads as key/value. */
function ToolDetail({
	step,
	onFullscreen,
}: {
	step: ToolStep;
	onFullscreen?: (title: string, output: string) => void;
}) {
	const [copied, setCopied] = useState<"command" | "output" | null>(null);
	const record = step.args !== null && typeof step.args === "object" ? (step.args as Record<string, unknown>) : undefined;
	const command = record ? scalar(record.command) : undefined;
	const entries = record ? Object.entries(record).filter(([key]) => key !== "command") : [];

	const copy = async (kind: "command" | "output", text: string): Promise<void> => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(kind);
			window.setTimeout(() => setCopied(null), 1500);
		} catch {
			// Clipboard permission denied; ignore.
		}
	};

	return (
		<div className="sa-detail">
			{command ? <pre className="sa-command">{command}</pre> : null}
			{entries.length > 0 ? (
				<div className="sa-args">
					{entries.map(([key, value]) => {
						const text = scalar(value);
						return (
							<div key={key} className="sa-arg">
								<span className="sa-arg-key">{key}</span>
								<span className={`sa-arg-value ${text === undefined ? "code" : ""}`}>
									{text ?? JSON.stringify(value, null, 2)}
								</span>
							</div>
						);
					})}
				</div>
			) : null}
			<div className="sa-output-head">
				<span>输出</span>
				<span className="sa-output-actions">
					{command ? (
						<button type="button" className="ghost small" onClick={() => void copy("command", command)}>
							{copied === "command" ? "已复制" : "复制命令"}
						</button>
					) : null}
					{step.output ? (
						<button type="button" className="ghost small" onClick={() => void copy("output", step.output)}>
							{copied === "output" ? "已复制" : "复制输出"}
						</button>
					) : null}
					{step.output && onFullscreen ? (
						<button type="button" className="ghost small" onClick={() => onFullscreen(step.name, step.output)}>
							全屏
						</button>
					) : null}
				</span>
			</div>
			<pre className={`sa-output ${step.output ? "" : "is-empty"}`}>
				{step.output || (step.running ? "等待输出…" : "（无输出）")}
			</pre>
			{step.truncated ? <div className="subagent-truncated">（输出过长，已截断）</div> : null}
		</div>
	);
}

function ToolRow({
	step,
	expanded,
	onToggle,
	onFullscreen,
}: {
	step: ToolStep;
	expanded: boolean;
	onToggle: () => void;
	onFullscreen?: (title: string, output: string) => void;
}) {
	const status = toolStatus(step);
	const duration = step.durationMs === undefined ? "" : formatMs(step.durationMs);
	return (
		<div className={`sa-step sa-tool ${status} ${expanded ? "open" : ""}`} id={`sa-tool-${step.seq}`}>
			<div
				className="sa-tool-row"
				role="button"
				tabIndex={0}
				onClick={onToggle}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") onToggle();
				}}
			>
				<span className="sa-caret">{expanded ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}</span>
				<span className="sa-tool-name">{step.name}</span>
				{step.summary ? <span className={`sa-tool-summary ${step.running ? "live" : ""}`}>{step.summary}</span> : null}
				<span className={`sa-tool-meta ${status}`}>
					{status === "running" ? "运行中" : status === "error" ? "失败" : "✓"}
					{duration ? <span className="sa-tool-duration">{duration}</span> : null}
				</span>
			</div>
			{expanded ? <ToolDetail step={step} onFullscreen={onFullscreen} /> : null}
		</div>
	);
}

function TextRow({
	step,
	expanded,
	onToggle,
}: {
	step: TextStep;
	expanded: boolean;
	onToggle: () => void;
}) {
	return (
		<div className={`sa-step sa-text ${expanded ? "open" : ""}`}>
			<div
				className="sa-text-body"
				role="button"
				tabIndex={0}
				onClick={onToggle}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") onToggle();
				}}
			>
				{expanded ? <MarkdownText text={step.text} /> : <div className="sa-text-clamp">{plainText(step.text)}</div>}
			</div>
			{step.truncated ? <div className="subagent-truncated">（内容过长，已截断）</div> : null}
		</div>
	);
}

/** The left column: one row per dispatch, newest first. */
function RunList({
	runs,
	selectedId,
	onSelect,
}: {
	runs: ZGSubagentRun[];
	selectedId: string | undefined;
	onSelect: (id: string) => void;
}) {
	return (
		<aside className="subagent-list">
			{runs.map((run) => {
				const duration = durationOf(run);
				return (
					<button
						key={run.id}
						type="button"
						className={`subagent-item ${run.status} ${run.id === selectedId ? "selected" : ""}`}
						onClick={() => onSelect(run.id)}
					>
						<span className="subagent-item-top">
							<span className={`subagent-badge ${run.status}`}>{STATUS_LABELS[run.status]}</span>
							<span className="subagent-item-clock">{formatClock(run.startedAt)}</span>
						</span>
						<span className="subagent-item-task" title={run.task}>
							{run.task}
						</span>
						<span className="subagent-item-meta">
							{run.turns} 轮{duration ? ` · ${duration}` : ""}
						</span>
					</button>
				);
			})}
		</aside>
	);
}

/** The right column: the selected run's process, result and controls. */
function RunDetail({
	run,
	events,
	onAbort,
	onSteer,
	onFullscreen,
}: {
	run: ZGSubagentRun;
	events: ZGSubagentEvent[];
	onAbort: (id: string) => void;
	onSteer: (id: string, text: string) => void;
	onFullscreen?: (title: string, output: string) => void;
}) {
	const turns = useMemo(() => buildTurns(events), [events]);
	const steps = useMemo(() => turns.flatMap((turn) => turn.steps), [turns]);
	const [tab, setTab] = useState<"process" | "result">(run.status === "running" ? "process" : "result");
	const [query, setQuery] = useState("");
	const [failuresOnly, setFailuresOnly] = useState(false);
	const [steerText, setSteerText] = useState("");
	// Only the operator's explicit choices are stored; a running call defaults to
	// expanded so the step being executed is visible, a finished one to collapsed.
	const [overrides, setOverrides] = useState<Map<number, boolean>>(() => new Map());
	const [expandedText, setExpandedText] = useState<Set<number>>(() => {
		const last = [...steps].reverse().find((step) => step.kind === "text");
		return new Set(last ? [last.seq] : []);
	});
	const [follow, setFollow] = useState(true);
	const bodyRef = useRef<HTMLDivElement | null>(null);

	const needle = query.trim().toLowerCase();
	const filtering = needle !== "" || failuresOnly;

	// Follow the newest step while the run is live, until the operator scrolls up.
	useEffect(() => {
		if (!follow || tab !== "process") return;
		const body = bodyRef.current;
		if (!body) return;
		body.scrollTop = body.scrollHeight;
	}, [follow, tab, events.length]);

	const visible = (step: Step): boolean => {
		if (step.kind === "tool") {
			if (failuresOnly && !step.isError) return false;
			if (needle === "") return true;
			return `${step.name} ${step.summary} ${step.output}`.toLowerCase().includes(needle);
		}
		if (failuresOnly) return false;
		if (needle === "") return true;
		if (step.kind === "text" || step.kind === "thinking") return step.text.toLowerCase().includes(needle);
		return step.note.toLowerCase().includes(needle);
	};

	const shownTurns = filtering
		? turns.map((turn) => ({ ...turn, steps: turn.steps.filter(visible) })).filter((turn) => turn.steps.length > 0)
		: turns;
	const toolCount = turns.reduce((sum, turn) => sum + turn.tools, 0);
	const failureCount = turns.reduce((sum, turn) => sum + turn.failures, 0);
	const firstFailure = steps.find((step): step is ToolStep => step.kind === "tool" && step.isError);
	const isExpanded = (step: ToolStep): boolean => overrides.get(step.seq) ?? step.running;
	const toggleTool = (step: ToolStep): void => {
		setOverrides((prev) => new Map(prev).set(step.seq, !(prev.get(step.seq) ?? step.running)));
	};

	const duration = durationOf(run);

	return (
		<div className="subagent-detail">
			<div className="subagent-detail-head">
				<div className="subagent-detail-title" title={run.task}>
					{run.task}
				</div>
				<div className="subagent-detail-meta">
					<span className={`subagent-badge ${run.status}`}>{STATUS_LABELS[run.status]}</span>
					<span>
						{run.turns} 轮{duration ? ` · ${duration}` : ""} · {formatClock(run.startedAt)}
					</span>
				</div>
			</div>
			<div className="subagent-tabs">
				<button type="button" className={tab === "process" ? "on" : ""} onClick={() => setTab("process")}>
					过程
					<span className="subagent-tab-count">{toolCount}</span>
					{/* Visible from the result tab too: a failed step is why the operator
					    opens the process in the first place. */}
					{failureCount > 0 ? <span className="subagent-tab-fail">{failureCount} 个失败</span> : null}
				</button>
				<button type="button" className={tab === "result" ? "on" : ""} onClick={() => setTab("result")}>
					结果
				</button>
				{tab === "process" ? (
					<span className="subagent-tools">
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="搜索命令、输出…"
							spellCheck={false}
						/>
						<button
							type="button"
							className={`ghost small ${failuresOnly ? "on" : ""}`}
							onClick={() => setFailuresOnly((prev) => !prev)}
						>
							只看失败
						</button>
						{firstFailure ? (
							<button
								type="button"
								className="ghost small"
								onClick={() => {
									// A filter could be hiding the row, so clear it first and
									// scroll after the list has been re-rendered.
									setQuery("");
									setFailuresOnly(false);
									window.requestAnimationFrame(() =>
										document.getElementById(`sa-tool-${firstFailure.seq}`)?.scrollIntoView({ block: "center" }),
									);
								}}
							>
								跳到第一个失败
							</button>
						) : null}
						<button
							type="button"
							className={`ghost small ${follow ? "on" : ""}`}
							title="跟随最新步骤"
							onClick={() => setFollow((prev) => !prev)}
						>
							跟随
						</button>
					</span>
				) : null}
			</div>
			<div
				className="subagent-detail-body"
				ref={bodyRef}
				onScroll={(event) => {
					const body = event.currentTarget;
					setFollow(body.scrollHeight - body.scrollTop - body.clientHeight < 24);
				}}
			>
				{tab === "result" ? (
					<div className="subagent-result">
						{run.error ? <div className="subagent-error">{run.error}</div> : null}
						{run.result ? (
							<MarkdownText text={run.result} />
						) : (
							<div className="subagent-empty">{run.status === "running" ? "运行中，还没有产出结果" : "（没有结果）"}</div>
						)}
					</div>
				) : events.length === 0 ? (
					<div className="subagent-empty">暂无过程记录</div>
				) : shownTurns.length === 0 ? (
					<div className="subagent-empty">没有匹配的步骤</div>
				) : (
					<div className="subagent-process">
						{shownTurns.map((turn) => (
							<div key={turn.index} className="sa-turn">
								<div className="sa-turn-head">
									<span className="sa-turn-label">第 {turn.index} 轮</span>
									<span className="sa-turn-meta">
										{turn.tools} 个工具{turn.durationMs > 0 ? ` · ${formatMs(turn.durationMs)}` : ""}
									</span>
									{turn.failures > 0 ? <span className="sa-turn-fail">{turn.failures} 个失败</span> : null}
								</div>
								{turn.steps.map((step) => {
									if (step.kind === "tool") {
										return (
											<ToolRow
												key={step.seq}
												step={step}
												expanded={isExpanded(step)}
												onToggle={() => toggleTool(step)}
												onFullscreen={onFullscreen}
											/>
										);
									}
									if (step.kind === "text") {
										return (
											<TextRow
												key={step.seq}
												step={step}
												expanded={expandedText.has(step.seq)}
												onToggle={() =>
													setExpandedText((prev) => {
														const next = new Set(prev);
														if (next.has(step.seq)) next.delete(step.seq);
														else next.add(step.seq);
														return next;
													})
												}
											/>
										);
									}
									if (step.kind === "thinking") {
										return (
											<div key={step.seq} className="sa-step sa-block">
												<details className="thinking">
													<summary>思考 · {step.text.length} 字</summary>
													<pre>{step.text}</pre>
												</details>
											</div>
										);
									}
									return (
										<div key={step.seq} className={`sa-step sa-status ${step.status ?? ""}`}>
											{step.note}
										</div>
									);
								})}
							</div>
						))}
					</div>
				)}
			</div>
			{run.status === "running" ? (
				<div className="subagent-controls">
					<button type="button" className="danger" onClick={() => onAbort(run.id)}>
						中止该子代理
					</button>
					<input
						value={steerText}
						placeholder="给该子代理追加指令…"
						onChange={(event) => setSteerText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && steerText.trim()) {
								onSteer(run.id, steerText.trim());
								setSteerText("");
							}
						}}
					/>
					<button
						type="button"
						disabled={!steerText.trim()}
						onClick={() => {
							onSteer(run.id, steerText.trim());
							setSteerText("");
						}}
					>
						追加
					</button>
				</div>
			) : null}
		</div>
	);
}

export function SubagentPanel({
	runs,
	transcripts,
	onLoad,
	onAbort,
	onSteer,
	onFullscreen,
}: {
	runs: ZGSubagentRun[];
	/** Process steps by run id; a run absent here has not been loaded yet. */
	transcripts: Record<string, ZGSubagentEvent[]>;
	onLoad: (id: string) => void;
	onAbort: (id: string) => void;
	onSteer: (id: string, text: string) => void;
	onFullscreen?: (title: string, output: string) => void;
}) {
	const [pickedId, setPickedId] = useState<string | undefined>(undefined);
	// Nothing picked yet: the newest live run is what the operator wants to watch.
	const selected = runs.find((run) => run.id === pickedId) ?? runs.find((run) => run.status === "running") ?? runs[0];
	const selectedId = selected?.id;
	const loaded = selectedId !== undefined && transcripts[selectedId] !== undefined;

	// Load the process once, the first time a run is shown. Keyed on the selection
	// rather than on `transcripts`/`onLoad`, which are rebuilt on every snapshot.
	useEffect(() => {
		if (selectedId !== undefined && !loaded) onLoad(selectedId);
	}, [selectedId, loaded, onLoad]);

	if (runs.length === 0) {
		return (
			<div className="subagent-panel empty">
				<div className="subagent-empty">
					当前会话还没有子代理。让主代理用 spawn_agent 派发独立任务后，这里会显示它的实时过程。
				</div>
			</div>
		);
	}

	return (
		<div className="subagent-panel">
			<RunList runs={runs} selectedId={selectedId} onSelect={setPickedId} />
			{selected ? (
				<RunDetail
					key={selected.id}
					run={selected}
					events={transcripts[selected.id] ?? []}
					onAbort={onAbort}
					onSteer={onSteer}
					onFullscreen={onFullscreen}
				/>
			) : null}
		</div>
	);
}
