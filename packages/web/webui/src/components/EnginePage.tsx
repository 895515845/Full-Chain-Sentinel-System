/**
 * 工程模式页面：工程列表 → 工程看板。
 *
 * Visual language follows the console: light page cards with ws-panel headers,
 * data-table rows for the engine list and the task board, tag badges for
 * statuses, and dark blocks only for terminal output. Layout per the approved
 * mockup (variant A): the list is a table, the board splits 7:5 between the
 * task board and the commander's light conversation feed, task details open in
 * a vulnerability-style modal, and the create form is a full page.
 */

import { useEffect, useMemo, useState } from "react";
import type {
	ZGDoctrineView,
	ZGEngine,
	ZGEngineLimits,
	ZGEngineTask,
	ZGEngineTaskStatus,
	ZGModelConfig,
	ZGSubagentEvent,
} from "../types.ts";

const TASK_STATUS_LABELS: Record<ZGEngineTaskStatus, string> = {
	queued: "排队中",
	running: "运行中",
	done: "已完成",
	failed: "失败",
	blocked: "已阻塞",
	aborted: "已中止",
	paused: "已暂停",
};

const TASK_STATUS_CLASS: Record<ZGEngineTaskStatus, string> = {
	queued: "tag-queued",
	running: "tag-running",
	done: "tag-done",
	failed: "tag-failed",
	blocked: "tag-blocked",
	aborted: "tag-aborted",
	paused: "tag-paused",
};

const ENGINE_STATUS_LABELS: Record<ZGEngine["status"], string> = {
	running: "运行中",
	paused: "已暂停",
	completed: "已完成",
	stopped: "已终止",
};

const ENGINE_STATUS_CLASS: Record<ZGEngine["status"], string> = {
	running: "tag-running",
	paused: "tag-paused",
	completed: "tag-done",
	stopped: "tag-stopped",
};

function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60000);
	if (minutes < 60) return `${minutes} 分钟`;
	return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function formatUsage(total: number | null | undefined): string {
	if (!total) return "—";
	if (total < 1000) return String(total);
	if (total < 1_000_000) return `${(total / 1000).toFixed(1)}k`;
	return `${(total / 1_000_000).toFixed(1)}M`;
}

function formatClock(at: number): string {
	return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

export interface EnginePageProps {
	engines: ZGEngine[];
	doctrines: ZGDoctrineView[];
	commanderConfig: ZGModelConfig | null;
	onSend: (message: unknown) => void;
	onError: (message: string) => void;
	commanderEvents: Record<string, ZGSubagentEvent[]>;
	taskEvents: Record<string, ZGSubagentEvent[]>;
	onOpenTaskEvents: (taskId: string) => void;
	onOpenCommanderEvents: (engineId: string) => void;
	hasProject: boolean;
}

type View = "list" | "board" | "create" | "doctrines" | "commander-config";

export function EnginePage(props: EnginePageProps) {
	const [view, setView] = useState<View>("list");
	const [boardId, setBoardId] = useState<string | null>(null);
	const [openTaskId, setOpenTaskId] = useState<string | null>(null);
	const [report, setReport] = useState<{ markdown: string; filename: string } | null>(null);

	const board = useMemo(
		() => props.engines.find((engine) => engine.id === boardId) ?? null,
		[props.engines, boardId],
	);

	const openBoard = (id: string) => {
		setBoardId(id);
		setView("board");
		props.onOpenCommanderEvents(id);
	};

	const send = props.onSend;

	if (view === "create") {
		return (
			<div className="page-card">
				<CreateEngineForm
					doctrines={props.doctrines}
					hasProject={props.hasProject}
					onCancel={() => setView("list")}
					onSubmit={(input) => {
						send({ type: "engine_create", input });
						setView("list");
					}}
				/>
			</div>
		);
	}

	if (view === "doctrines") {
		return (
			<div className="page-card">
				<DoctrineManager
					doctrines={props.doctrines}
					onClose={() => setView("list")}
					onSave={(input) => send({ type: "save_doctrine", input })}
					onDelete={(id) => send({ type: "delete_doctrine", id })}
				/>
			</div>
		);
	}

	if (view === "commander-config") {
		return (
			<div className="page-card">
				<CommanderConfigPanel
					config={props.commanderConfig}
					onClose={() => setView("list")}
					onSave={(config) => send({ type: "save_commander_config", config })}
				/>
			</div>
		);
	}

	if (view === "board" && board) {
		return (
			<div className="page-card">
				<div className="ws-panel__head">
					<div className="ws-panel__title engine-subline">
						<button type="button" onClick={() => setView("list")}>
							← 返回
						</button>
						{board.name}
						<span className={`tag ${ENGINE_STATUS_CLASS[board.status]}`}>{ENGINE_STATUS_LABELS[board.status]}</span>
						<span className="ws-panel__sub">
							{board.projectName} · 创建于 {new Date(board.createdAt).toLocaleString("zh-CN", { hour12: false })}
							{board.endedAt
								? ` · 历时 ${formatDuration(board.endedAt - board.createdAt)}`
								: board.status === "running"
									? ` · 已运行 ${formatDuration(Date.now() - board.createdAt)}`
									: ""}
						</span>
					</div>
					<div className="ws-panel__actions">
						<button type="button" onClick={() => send({ type: "engine_report_snapshot", id: board.id })}>
							进度快照
						</button>
						{board.report ? (
							<button type="button" onClick={() => setReport({ markdown: board.report ?? "", filename: `${board.name}-总报告.md` })}>
								查看总报告
							</button>
						) : null}
						{board.status === "running" ? (
							<button type="button" onClick={() => send({ type: "engine_pause", id: board.id })}>
								暂停
							</button>
						) : null}
						{board.status === "paused" ? (
							<button type="button" className="primary" onClick={() => send({ type: "engine_resume", id: board.id })}>
								继续
							</button>
						) : null}
						{board.status === "running" || board.status === "paused" ? (
							<button type="button" onClick={() => send({ type: "engine_abort", id: board.id })}>
								终止
							</button>
						) : (
							<button
								type="button"
								onClick={() => {
									if (window.confirm(`删除工程「${board.name}」？任务记录将一并删除。`)) {
										send({ type: "engine_delete", id: board.id });
										setView("list");
									}
								}}
							>
								删除
							</button>
						)}
					</div>
				</div>
				<div className="ws-panel__body">
					<EngineStats engine={board} />
					{(board.status === "running" || board.status === "paused") && (
						<SteerBox engineId={board.id} running={board.status === "running"} onSend={send} />
					)}
					<div className="board">
						<TaskBoard
							engine={board}
							onOpenTask={(taskId) => {
								setOpenTaskId(taskId);
								props.onOpenTaskEvents(taskId);
							}}
							onAbortTask={(taskId) => send({ type: "engine_abort_task", taskId })}
						/>
						<CommanderFeed events={props.commanderEvents[board.id] ?? []} />
					</div>
				</div>
				{openTaskId ? (
					<TaskModal
						task={board.tasks.find((task) => task.id === openTaskId) ?? null}
						events={props.taskEvents[openTaskId] ?? []}
						onClose={() => setOpenTaskId(null)}
						onAbort={(taskId) => send({ type: "engine_abort_task", taskId })}
						onOpenInChat={(taskId) => {
							send({ type: "engine_open_task_session", taskId });
							setOpenTaskId(null);
						}}
					/>
				) : null}
				{report ? (
					<div className="modal-backdrop" onClick={() => setReport(null)}>
						<div className="modal modal--wide" onClick={(event) => event.stopPropagation()}>
							<div className="vuln-detail__head">
								<div className="vuln-detail__title">{report.filename}</div>
								<div className="ws-panel__actions">
									<button type="button" onClick={() => void navigator.clipboard.writeText(report.markdown)}>
										复制
									</button>
									<button type="button" className="primary" onClick={() => setReport(null)}>
										关闭
									</button>
								</div>
							</div>
							<pre className="report-preview">{report.markdown}</pre>
						</div>
					</div>
				) : null}
			</div>
		);
	}

	// list view
	return (
		<div className="page-card">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					工程
					<span className="ws-panel__sub">
						{props.hasProject ? `${props.engines[0]?.projectName ?? ""} · ${props.engines.length} 个工程` : "请先选择项目"}
					</span>
				</div>
				<div className="ws-panel__actions">
					<button type="button" onClick={() => setView("doctrines")}>
						指挥思路
					</button>
					<button type="button" onClick={() => setView("commander-config")}>
						指挥官端点
					</button>
					<button type="button" className="primary" disabled={!props.hasProject} onClick={() => setView("create")}>
						新建工程
					</button>
				</div>
			</div>
			<div className="ws-panel__body">
				{props.engines.length === 0 ? (
					<div className="ws-empty">
						{props.hasProject
							? "还没有工程。点「新建工程」，贴入目标清单并选择指挥思路即可开始。"
							: "工程属于项目：请先在侧栏顶部选择或创建一个项目。"}
					</div>
				) : (
					<div className="data-table engines-table">
						<div className="data-row data-head">
							<span>工程</span>
							<span>状态</span>
							<span>目标 / 任务</span>
							<span>进度</span>
							<span>中枢提交</span>
							<span>耗时</span>
							<span>创建时间</span>
						</div>
						{props.engines.map((engine) => {
							const running = engine.tasks.filter((task) => task.status === "running").length;
							const queued = engine.tasks.filter((task) => task.status === "queued").length;
							const done = engine.tasks.filter((task) => task.status === "done").length;
							const failed = engine.tasks.filter((task) => ["failed", "blocked"].includes(task.status)).length;
							const parts = [
								`${done} 完成`,
								running > 0 ? `${running} 运行` : "",
								queued > 0 ? `${queued} 排队` : "",
								failed > 0 ? `${failed} 失败` : "",
							].filter(Boolean);
							const elapsed = (engine.endedAt ?? (engine.status === "running" ? Date.now() : engine.createdAt)) - engine.createdAt;
							return (
								<div
									key={engine.id}
									className="data-row"
									onClick={() => openBoard(engine.id)}
									role="button"
									tabIndex={0}
									onKeyDown={(event) => {
										if (event.key === "Enter") openBoard(engine.id);
									}}
								>
									<span className="data-name">{engine.name}</span>
									<span>
										<span className={`tag ${ENGINE_STATUS_CLASS[engine.status]}`}>{ENGINE_STATUS_LABELS[engine.status]}</span>
									</span>
									<span className="data-mono">
										{engine.targets.length} / {engine.tasks.length}
									</span>
									<span>{parts.join(" · ") || "—"}</span>
									<span>{engine.tasks.reduce((sum, task) => sum + task.vulns, 0)} 条</span>
									<span>{formatDuration(elapsed)}</span>
									<span className="data-mono">{new Date(engine.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}

function EngineStats({ engine }: { engine: ZGEngine }) {
	const count = (status: ZGEngineTaskStatus) => engine.tasks.filter((task) => task.status === status).length;
	const vulns = engine.tasks.reduce((sum, task) => sum + task.vulns, 0);
	return (
		<div className="engine-stats">
			<span className="tag tag-running">运行 {count("running")}</span>
			<span className="tag tag-queued">排队 {count("queued")}</span>
			<span className="tag tag-done">完成 {count("done")}</span>
			<span className="tag tag-failed">失败 {count("failed")}</span>
			<span className="tag tag-blocked">阻塞 {count("blocked")}</span>
			<span>
				· 中枢提交 <span className="stat-num">{vulns}</span> 条
			</span>
			<span>
				· 并发 <span className="stat-num">{engine.limits.concurrency}</span>
			</span>
			<span>
				轮数 <span className="stat-num">{engine.limits.roundLimit}</span>
			</span>
			<span>
				重试 <span className="stat-num">{engine.limits.maxRetries}</span>
			</span>
			{engine.limits.tokenLimit ? (
				<span>
					token 上限 <span className="stat-num">{formatUsage(engine.limits.tokenLimit)}</span>
				</span>
			) : null}
			{engine.limits.timeLimitMin ? (
				<span>
					时间上限 <span className="stat-num">{engine.limits.timeLimitMin} 分</span>
				</span>
			) : null}
			{engine.pauseNote ? <span className="ws-panel__sub">{engine.pauseNote}</span> : null}
		</div>
	);
}

function SteerBox({ engineId, running, onSend }: { engineId: string; running: boolean; onSend: (message: unknown) => void }) {
	const [steerText, setSteerText] = useState("");
	const [appendText, setAppendText] = useState("");
	const sendSteer = () => {
		if (!steerText.trim() || !running) return;
		onSend({ type: "engine_steer_commander", id: engineId, text: steerText.trim() });
		setSteerText("");
	};
	return (
		<div className="steer-box">
			<input
				type="text"
				placeholder="给指挥官追加指令（steer）…"
				value={steerText}
				onChange={(event) => setSteerText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") sendSteer();
				}}
			/>
			<button type="button" disabled={!steerText.trim() || !running} onClick={sendSteer}>
				发送
			</button>
			<input
				type="text"
				placeholder="追加目标（一行一个，可带备注）…"
				value={appendText}
				onChange={(event) => setAppendText(event.target.value)}
			/>
			<button
				type="button"
				disabled={!appendText.trim()}
				onClick={() => {
					onSend({ type: "engine_add_targets", id: engineId, targets: appendText });
					setAppendText("");
				}}
			>
				追加
			</button>
		</div>
	);
}

function TaskBoard(props: {
	engine: ZGEngine;
	onOpenTask(taskId: string): void;
	onAbortTask(taskId: string): void;
}) {
	const tasks = props.engine.tasks;
	return (
		<div className="board-col">
			<div className="board-col__head">
				<span className="board-col__title">任务看板</span>
				<span className="ws-panel__sub">{tasks.length} 个任务 · 点行看详情</span>
			</div>
			<div className="board-col__body">
				{tasks.length === 0 ? (
					<div className="ws-empty">还没有任务。指挥官启动后会在这里派发。</div>
				) : (
					<div className="data-table tasks-table">
						<div className="data-row data-head">
							<span>状态</span>
							<span>任务</span>
							<span>目标</span>
							<span>次数</span>
							<span>用量</span>
							<span>结论</span>
							<span />
						</div>
						{tasks.map((task) => (
							<div
								key={task.id}
								className="data-row"
								role="button"
								tabIndex={0}
								onClick={() => props.onOpenTask(task.id)}
								onKeyDown={(event) => {
									if (event.key === "Enter") props.onOpenTask(task.id);
								}}
							>
								<span>
									<span className={`tag ${TASK_STATUS_CLASS[task.status]}`}>{TASK_STATUS_LABELS[task.status]}</span>
								</span>
								<span className="data-name">{task.title}</span>
								<span className="data-mono">{task.target ?? "—"}</span>
								<span>第 {task.attempt} 次</span>
								<span className="data-mono">{formatUsage(task.usage?.total)}</span>
								<span className="task-summary">{task.summary ?? task.error ?? ""}</span>
								<span>
									{task.status === "running" || task.status === "queued" ? (
										<button
											type="button"
											className="mini-btn"
											onClick={(event) => {
												event.stopPropagation();
												props.onAbortTask(task.id);
											}}
										>
											中止
										</button>
									) : null}
								</span>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/** Tool-call summary for one feed row: name plus the most useful argument. */
function toolArgSummary(event: ZGSubagentEvent): string {
	const args = (event.args ?? {}) as Record<string, unknown>;
	for (const key of ["title", "task_id", "instruction", "reason"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	const text = JSON.stringify(args);
	return text === "{}" ? "" : text;
}

function CommanderFeed({ events }: { events: ZGSubagentEvent[] }) {
	const [openThinking, setOpenThinking] = useState<Set<number>>(new Set());
	const containerRef = useState<{ current: HTMLDivElement | null }>({ current: null })[0];
	useEffect(() => {
		if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
	}, [events.length, containerRef]);
	return (
		<div className="board-col">
			<div className="board-col__head">
				<span className="board-col__title">指挥官</span>
				<span className="ws-panel__sub">决策日志</span>
			</div>
			<div className="board-col__body" ref={containerRef}>
				<div className="commander-feed">
					{events.length === 0 ? <div className="ws-empty">指挥官还没有动作。</div> : null}
					{events.map((event) => {
						if (event.kind === "thinking") {
							const isOpen = openThinking.has(event.seq);
							return (
								<div key={event.seq} className="commander-item">
									<div className="commander-item__meta">{formatClock(event.at)} · 思考</div>
									<button
										type="button"
										className="commander-item__thinking"
										onClick={() =>
											setOpenThinking((prev) => {
												const next = new Set(prev);
												if (next.has(event.seq)) next.delete(event.seq);
												else next.add(event.seq);
												return next;
											})
										}
									>
										思考 · {(event.text ?? "").length} 字（点{isOpen ? "起" : "开"}）
									</button>
									{isOpen ? <div className="commander-thinking-open">{event.text}</div> : null}
								</div>
							);
						}
						if (event.kind === "text") {
							return (
								<div key={event.seq} className="commander-item">
									<div className="commander-item__meta">{formatClock(event.at)} · 决策</div>
									<div className="commander-item__text">{event.text}</div>
								</div>
							);
						}
						if (event.kind === "tool_start") {
							return (
								<div key={event.seq} className="commander-item">
									<div className="commander-item__meta">{formatClock(event.at)}</div>
									<div className="commander-tool-row">
										<span className="tname">{event.toolName}</span>
										<span className="targ">{toolArgSummary(event)}</span>
									</div>
								</div>
							);
						}
						if (event.kind === "tool_end") {
							return (
								<div key={event.seq} className="commander-item">
									<div className="commander-item__meta">{formatClock(event.at)}</div>
									<div className={`commander-tool-row${event.isError ? " is-error" : ""}`}>
										<span className="tname">{event.toolName}</span>
										<span className="targ">{(event.output ?? "").trim().slice(0, 200)}</span>
										<span className={event.isError ? "terr" : "tok"}>{event.isError ? "✕" : "✓"}</span>
									</div>
								</div>
							);
						}
						if (event.kind === "status") {
							return (
								<div key={event.seq} className="commander-sep">
									{event.note ?? event.status ?? ""}
								</div>
							);
						}
						return null;
					})}
				</div>
			</div>
		</div>
	);
}

function TaskModal(props: {
	task: ZGEngineTask | null;
	events: ZGSubagentEvent[];
	onClose(): void;
	onAbort(taskId: string): void;
	onOpenInChat(taskId: string): void;
}) {
	const task = props.task;
	if (!task) return null;
	return (
		<div className="modal-backdrop" onClick={props.onClose}>
			<div className="modal engine-task-modal" onClick={(event) => event.stopPropagation()}>
				<div className="vuln-detail__head">
					<div>
						<div className="vuln-detail__title">
							{task.title}
							<span className={`tag ${TASK_STATUS_CLASS[task.status]}`} style={{ marginLeft: 8 }}>
								{TASK_STATUS_LABELS[task.status]}
							</span>
						</div>
						<div className="vuln-detail__meta">
							<span>目标：{task.target ?? "—"}</span>
							<span>第 {task.attempt} 次派发</span>
							<span>轮数上限 {task.roundLimit}</span>
							<span>工作目录 /work/tasks/{task.workspace}</span>
						</div>
					</div>
					<div className="ws-panel__actions">
						{task.sessionId ? (
							<button type="button" onClick={() => props.onOpenInChat(task.id)}>
								在对话中打开
							</button>
						) : null}
						{task.status === "running" || task.status === "queued" ? (
							<button type="button" onClick={() => props.onAbort(task.id)}>
								中止任务
							</button>
						) : null}
						<button type="button" className="primary" onClick={props.onClose}>
							关闭
						</button>
					</div>
				</div>
				<div className="vuln-meta-grid">
					<div>
						<span>耗时</span>
						<span>{task.startedAt ? formatDuration((task.endedAt ?? Date.now()) - task.startedAt) : "—"}</span>
					</div>
					<div>
						<span>用量</span>
						<span>{formatUsage(task.usage?.total)} tokens</span>
					</div>
					<div>
						<span>中枢提交</span>
						<span>{task.vulns} 条</span>
					</div>
					<div>
						<span>任务 ID</span>
						<span>{task.id}</span>
					</div>
				</div>
				<h3>{task.status === "running" ? "当前结论" : "结论"}</h3>
				{task.error ? <div className="engine-task-error">{task.error}</div> : null}
				<div className="engine-task-summary">{task.summary ?? "（暂无）"}</div>
				<h3>任务指令（指挥官原文）</h3>
				<pre className="ws-console__body">{task.objective}</pre>
				<h3>执行过程 · {props.events.length} 步</h3>
				<div className="engine-task-events">
					{props.events.slice(-30).map((event) => (
						<div key={event.seq} className="engine-task-event">
							<div className="engine-task-event__head">
								<span>{formatClock(event.at)}</span>
								{event.kind === "text" ? (
									<span>✎ {(event.text ?? "").slice(0, 160)}</span>
								) : event.kind === "thinking" ? (
									<span>思考 · {(event.text ?? "").length} 字</span>
								) : event.kind === "tool_start" ? (
									<span className="tname">▸ {event.toolName}</span>
								) : event.kind === "tool_end" ? (
									<span className={`tname${event.isError ? " is-error" : ""}`}>
										{event.isError ? "✕" : "✓"} {event.toolName}
									</span>
								) : (
									<span>— {event.note ?? event.status ?? ""} —</span>
								)}
							</div>
							{event.kind === "tool_end" && (event.output ?? "").trim() ? (
								<pre className="ws-console__body">{event.output}</pre>
							) : null}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

function CreateEngineForm(props: {
	doctrines: ZGDoctrineView[];
	hasProject: boolean;
	onCancel(): void;
	onSubmit(input: { name: string; targets: string; doctrines: string[]; limits: ZGEngineLimits }): void;
}) {
	const [name, setName] = useState("");
	const [targets, setTargets] = useState("");
	const [selected, setSelected] = useState<string[]>(props.doctrines.length === 1 ? [props.doctrines[0].id] : []);
	const [concurrency, setConcurrency] = useState(3);
	const [roundLimit, setRoundLimit] = useState(5);
	const [maxRetries, setMaxRetries] = useState(1);
	const [tokenLimit, setTokenLimit] = useState("");
	const [timeLimitMin, setTimeLimitMin] = useState("");

	const targetCount = targets.split("\n").filter((line) => line.trim()).length;

	return (
		<>
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					新建工程
					<span className="ws-panel__sub">指挥官只分配任务，不执行任何操作</span>
				</div>
				<div className="ws-panel__actions">
					<button type="button" onClick={props.onCancel}>
						取消
					</button>
					<button
						type="button"
						className="primary"
						disabled={!name.trim() || targetCount === 0 || selected.length === 0}
						onClick={() =>
							props.onSubmit({
								name: name.trim(),
								targets,
								doctrines: selected,
								limits: {
									concurrency,
									roundLimit,
									maxRetries,
									tokenLimit: tokenLimit.trim() ? Number.parseInt(tokenLimit, 10) : null,
									timeLimitMin: timeLimitMin.trim() ? Number.parseInt(timeLimitMin, 10) : null,
								},
							})
						}
					>
						启动工程
					</button>
				</div>
			</div>
			<div className="ws-panel__body">
				<div className="form-grid">
					<div className="form-field">
						<label>工程名称</label>
						<input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="如：内网一批 Web 目标" />
					</div>
					<div className="form-field">
						<label>
							目标清单 <span className="hint">一行一个：目标 + 可选备注 · 共 {targetCount} 个</span>
						</label>
						<textarea
							value={targets}
							onChange={(event) => setTargets(event.target.value)}
							placeholder={"10.0.0.1 这台是 Web 服务器\n10.0.0.2\nhttp://target.example.com 只测登录功能"}
						/>
					</div>
					<div className="form-field">
						<label>
							指挥思路 <span className="hint">可多选叠加，合并注入指挥官</span>
						</label>
						<div className="check-group">
							{props.doctrines.map((doctrine) => (
								<label key={doctrine.id} className="check-item">
									<input
										type="checkbox"
										checked={selected.includes(doctrine.id)}
										onChange={(event) =>
											setSelected((prev) =>
												event.target.checked ? [...prev, doctrine.id] : prev.filter((id) => id !== doctrine.id),
											)
										}
									/>
									<span className="cname">{doctrine.name}</span>
									<span className="ctext">{doctrine.text.slice(0, 120)}</span>
								</label>
							))}
						</div>
					</div>
					<div className="form-field">
						<label>上限设置</label>
						<div className="limit-grid">
							<div className="form-field">
								<label>最大并发</label>
								<input type="number" min={1} max={20} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} />
							</div>
							<div className="form-field">
								<label>单任务轮数上限</label>
								<input type="number" min={1} max={99} value={roundLimit} onChange={(event) => setRoundLimit(Number(event.target.value))} />
							</div>
							<div className="form-field">
								<label>重试上限（每目标）</label>
								<input type="number" min={0} max={10} value={maxRetries} onChange={(event) => setMaxRetries(Number(event.target.value))} />
							</div>
							<div className="form-field">
								<label>token 上限（留空不限）</label>
								<input type="number" min={0} value={tokenLimit} onChange={(event) => setTokenLimit(event.target.value)} placeholder="如 2000000" />
							</div>
							<div className="form-field">
								<label>时间上限分钟（留空不限）</label>
								<input type="number" min={1} value={timeLimitMin} onChange={(event) => setTimeLimitMin(event.target.value)} placeholder="如 60" />
							</div>
						</div>
					</div>
					<p className="form-hint">
						启动后指挥官全权调度（免审），各任务在项目容器内自动执行命令、无人拦截；人保留暂停 / 终止 / 追加目标与 steer。
					</p>
				</div>
			</div>
		</>
	);
}

function DoctrineManager(props: {
	doctrines: ZGDoctrineView[];
	onClose(): void;
	onSave(input: { id?: string; name: string; text: string }): void;
	onDelete(id: string): void;
}) {
	const [name, setName] = useState("");
	const [text, setText] = useState("");
	return (
		<>
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					指挥思路
					<span className="ws-panel__sub">命名的文本模板，创建工程时多选叠加注入指挥官</span>
				</div>
				<div className="ws-panel__actions">
					<button type="button" onClick={props.onClose}>
						返回
					</button>
				</div>
			</div>
			<div className="ws-panel__body">
				{props.doctrines.map((doctrine) => (
					<div key={doctrine.id} className="doctrine-row" style={{ marginBottom: 10 }}>
						<div className="doctrine-row__head">
							<strong>{doctrine.name}</strong>
							{doctrine.builtin ? <span className="tag tag-queued">内置</span> : null}
							{!doctrine.builtin ? (
								<button
									type="button"
									onClick={() => {
										if (window.confirm(`删除思路「${doctrine.name}」？`)) props.onDelete(doctrine.id);
									}}
								>
									删除
								</button>
							) : null}
						</div>
						<pre>{doctrine.text}</pre>
					</div>
				))}
				<div className="doctrine-new">
					<div className="form-field">
						<label>新增思路</label>
						<input type="text" placeholder="思路名称" value={name} onChange={(event) => setName(event.target.value)} />
					</div>
					<div className="form-field">
						<label>思路内容（纯文本，注入指挥官系统指令）</label>
						<textarea rows={6} value={text} onChange={(event) => setText(event.target.value)} />
					</div>
					<div>
						<button
							type="button"
							className="primary"
							disabled={!name.trim() || !text.trim()}
							onClick={() => {
								props.onSave({ name: name.trim(), text: text.trim() });
								setName("");
								setText("");
							}}
						>
							保存
						</button>
					</div>
				</div>
			</div>
		</>
	);
}

function CommanderConfigPanel(props: {
	config: ZGModelConfig | null;
	onClose(): void;
	onSave(config: ZGModelConfig | null): void;
}) {
	const [baseUrl, setBaseUrl] = useState(props.config?.baseUrl ?? "");
	const [apiKey, setApiKey] = useState(props.config?.apiKey ?? "");
	const [modelId, setModelId] = useState(props.config?.modelId ?? "");
	return (
		<>
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					指挥官端点
					<span className="ws-panel__sub">{props.config ? "当前：已配置专用端点" : "当前：使用主 Agent 端点"}</span>
				</div>
				<div className="ws-panel__actions">
					<button type="button" onClick={props.onClose}>
						返回
					</button>
					<button
						type="button"
						className="primary"
						onClick={() =>
							props.onSave(
								baseUrl.trim() && modelId.trim()
									? { baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), modelId: modelId.trim() }
									: null,
							)
						}
					>
						保存
					</button>
				</div>
			</div>
			<div className="ws-panel__body">
				<p className="form-hint">
					指挥官可以使用单独的 OpenAI 兼容端点（例如便宜模型指挥、强模型干活）。清空并保存则回退到主 Agent 端点。
				</p>
				<div className="form-grid">
					<div className="form-field">
						<label>Base URL</label>
						<input type="text" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://127.0.0.1:8000/v1" />
					</div>
					<div className="form-field">
						<label>API Key（本地端点可留空）</label>
						<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
					</div>
					<div className="form-field">
						<label>模型 ID</label>
						<input type="text" value={modelId} onChange={(event) => setModelId(event.target.value)} />
					</div>
				</div>
			</div>
		</>
	);
}
