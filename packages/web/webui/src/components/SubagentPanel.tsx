import { useState } from "react";
import type { ZGSubagentEvent, ZGSubagentRun, ZGSubagentStatus } from "../types.ts";
import { MarkdownText } from "./MessageView.tsx";
import { ToolCard } from "./ToolCard.tsx";

const STATUS_LABELS: Record<ZGSubagentStatus, string> = {
	running: "运行中",
	done: "已完成",
	error: "失败",
	aborted: "已中止",
};

function formatClock(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function durationOf(run: ZGSubagentRun): string {
	if (!run.endedAt) return "";
	const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
	if (!Number.isFinite(ms) || ms < 0) return "";
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function argsOf(event: ZGSubagentEvent): string {
	if (event.args === undefined) return "";
	try {
		return JSON.stringify(event.args, null, 2);
	} catch {
		return String(event.args);
	}
}

/** Timeline of one run's normalized steps, in the order the sub-agent produced them. */
function RunTimeline({ events }: { events: ZGSubagentEvent[] }) {
	if (events.length === 0) return <div className="subagent-empty">暂无过程记录</div>;
	return (
		<div className="subagent-timeline">
			{events.map((event) => {
				if (event.kind === "text") {
					return (
						<div key={event.seq} className="subagent-text">
							<MarkdownText text={event.text ?? ""} />
							{event.truncated ? <div className="subagent-truncated">（内容过长，已截断）</div> : null}
						</div>
					);
				}
				if (event.kind === "thinking") {
					return (
						<details key={event.seq} className="thinking">
							<summary>思考</summary>
							<pre>{event.text}</pre>
						</details>
					);
				}
				if (event.kind === "tool_start" || event.kind === "tool_end") {
					const paired = events.find(
						(candidate) => candidate.kind === "tool_end" && candidate.toolCallId === event.toolCallId,
					);
					if (event.kind === "tool_start") {
						const finished = paired !== undefined;
						return (
							<div key={event.seq}>
								<ToolCard
									name={event.toolName ?? "tool"}
									status={finished ? (paired?.isError ? "error" : "done") : "running"}
									command={argsOf(event)}
									output={paired?.output ?? ""}
								/>
								{paired?.truncated ? <div className="subagent-truncated">（输出过长，已截断）</div> : null}
							</div>
						);
					}
					return null;
				}
				if (event.kind === "turn") {
					return (
						<div key={event.seq} className="subagent-turn">
							{event.text}
						</div>
					);
				}
				return (
					<div key={event.seq} className={`subagent-status ${event.status ?? ""}`}>
						{event.note ?? (event.status ? STATUS_LABELS[event.status] : "")}
					</div>
				);
			})}
		</div>
	);
}

export function SubagentPanel({
	runs,
	transcripts,
	onLoad,
	onAbort,
	onSteer,
}: {
	runs: ZGSubagentRun[];
	/** Process steps by run id; a run absent here has not been expanded yet. */
	transcripts: Record<string, ZGSubagentEvent[]>;
	onLoad: (id: string) => void;
	onAbort: (id: string) => void;
	onSteer: (id: string, text: string) => void;
}) {
	const [openId, setOpenId] = useState<string | null>(null);
	const [steerText, setSteerText] = useState("");

	const toggle = (id: string) => {
		if (openId === id) {
			setOpenId(null);
			return;
		}
		setOpenId(id);
		if (!transcripts[id]) onLoad(id);
	};

	return (
		<div className="subagent-panel">
			{runs.length === 0 ? (
				<div className="subagent-empty">
					当前会话还没有子代理。让主代理用 spawn_agent 派发独立任务后，这里会显示它的实时过程。
				</div>
			) : null}
			{runs.map((run) => {
				const open = openId === run.id;
				return (
					<div key={run.id} className={`subagent-run ${open ? "open" : ""}`}>
						<button type="button" className="subagent-head" onClick={() => toggle(run.id)}>
							<span className={`subagent-badge ${run.status}`}>{STATUS_LABELS[run.status]}</span>
							<span className="subagent-mode">{run.mode === "act" ? "act" : "explore"}</span>
							<span className="subagent-task" title={run.task}>
								{run.task}
							</span>
							<span className="subagent-meta">
								{run.turns} 轮{durationOf(run) ? ` · ${durationOf(run)}` : ""} · {formatClock(run.startedAt)}
							</span>
						</button>
						{open ? (
							<div className="subagent-body">
								<RunTimeline events={transcripts[run.id] ?? []} />
								{run.result ? (
									<div className="subagent-result">
										<div className="subagent-result-title">结果</div>
										<MarkdownText text={run.result} />
									</div>
								) : null}
								{run.error ? <div className="subagent-error">{run.error}</div> : null}
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
						) : null}
					</div>
				);
			})}
		</div>
	);
}
