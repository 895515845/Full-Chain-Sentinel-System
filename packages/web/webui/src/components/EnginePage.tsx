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
	SentinelDoctrineView,
	SentinelEngine,
	SentinelEngineGateMode,
	SentinelEngineLimits,
	SentinelEngineTask,
	SentinelEngineTaskStatus,
	SentinelModelConfig,
	SentinelPresetView,
	SentinelSubagentEvent,
} from "../types.ts";

const TASK_STATUS_LABELS: Record<SentinelEngineTaskStatus, string> = {
	queued: "排队中",
	running: "运行中",
	done: "已完成",
	failed: "失败",
	blocked: "已阻塞",
	aborted: "已中止",
	paused: "已暂停",
};

const TASK_STATUS_CLASS: Record<SentinelEngineTaskStatus, string> = {
	queued: "tag-queued",
	running: "tag-running",
	done: "tag-done",
	failed: "tag-failed",
	blocked: "tag-blocked",
	aborted: "tag-aborted",
	paused: "tag-paused",
};

const ENGINE_STATUS_LABELS: Record<SentinelEngine["status"], string> = {
	running: "运行中",
	paused: "已暂停",
	completed: "已完成",
	stopped: "已终止",
};

const ENGINE_STATUS_CLASS: Record<SentinelEngine["status"], string> = {
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
	engines: SentinelEngine[];
	doctrines: SentinelDoctrineView[];
	/** Enabled presets the commander may dispatch with, for the whitelist controls. */
	presets: SentinelPresetView[];
	commanderConfig: SentinelModelConfig | null;
	onSend: (message: unknown) => void;
	onError: (message: string) => void;
	commanderEvents: Record<string, SentinelSubagentEvent[]>;
	taskEvents: Record<string, SentinelSubagentEvent[]>;
	onOpenTaskEvents: (taskId: string) => void;
	onOpenCommanderEvents: (engineId: string) => void;
	hasProject: boolean;
	/** Whether a judge endpoint resolves, so the create form can offer AI 裁判. */
	judgeAvailable: boolean;
}

type View = "list" | "board" | "create" | "doctrines" | "commander-config";

export function EnginePage(props: EnginePageProps) {
	const [view, setView] = useState<View>("list");
	const [boardId, setBoardId] = useState<string | null>(null);
	const [openTaskId, setOpenTaskId] = useState<string | null>(null);
	const [report, setReport] = useState<{ markdown: string; filename: string } | null>(null);

	const board = useMemo(() => props.engines.find((engine) => engine.id === boardId) ?? null, [props.engines, boardId]);

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
					presets={props.presets}
					hasProject={props.hasProject}
					judgeAvailable={props.judgeAvailable}
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
						<span className={`tag ${ENGINE_STATUS_CLASS[board.status]}`}>
							{ENGINE_STATUS_LABELS[board.status]}
						</span>
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
							<button
								type="button"
								onClick={() => setReport({ markdown: board.report ?? "", filename: `${board.name}-总报告.md` })}
							>
								查看总报告
							</button>
						) : null}
						{board.status === "running" ? (
							<button type="button" onClick={() => send({ type: "engine_pause", id: board.id })}>
								暂停
							</button>
						) : null}
						{board.status === "paused" ? (
							<button
								type="button"
								className="primary"
								onClick={() => send({ type: "engine_resume", id: board.id })}
							>
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
					<EngineStats
						engine={board}
						judgeAvailable={props.judgeAvailable}
						onSetGateMode={(gateMode) => send({ type: "engine_set_gate_mode", id: board.id, gateMode })}
					/>
					<EnginePresetWhitelist
						engine={board}
						presets={props.presets}
						onChange={(presetIds) => send({ type: "engine_set_presets", id: board.id, presetIds })}
						onChangeOptional={(optional) => send({ type: "engine_set_preset_optional", id: board.id, optional })}
					/>
					{(board.status === "running" || board.status === "paused") && (
						<TargetsBox engineId={board.id} onSend={send} />
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
						<CommanderFeed
							engineId={board.id}
							running={board.status === "running"}
							events={props.commanderEvents[board.id] ?? []}
							onSend={send}
						/>
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
						{props.hasProject
							? `${props.engines[0]?.projectName ?? ""} · ${props.engines.length} 个工程`
							: "请先选择项目"}
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
							const elapsed =
								(engine.endedAt ?? (engine.status === "running" ? Date.now() : engine.createdAt)) -
								engine.createdAt;
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
										<span className={`tag ${ENGINE_STATUS_CLASS[engine.status]}`}>
											{ENGINE_STATUS_LABELS[engine.status]}
										</span>
									</span>
									<span className="data-mono">
										{engine.targets.length} / {engine.tasks.length}
									</span>
									<span>{parts.join(" · ") || "—"}</span>
									<span>{engine.tasks.reduce((sum, task) => sum + task.vulns, 0)} 条</span>
									<span>{formatDuration(elapsed)}</span>
									<span className="data-mono">
										{new Date(engine.createdAt).toLocaleString("zh-CN", { hour12: false })}
									</span>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}

function EngineStats({
	engine,
	judgeAvailable,
	onSetGateMode,
}: {
	engine: SentinelEngine;
	judgeAvailable: boolean;
	onSetGateMode: (mode: SentinelEngineGateMode) => void;
}) {
	const count = (status: SentinelEngineTaskStatus) => engine.tasks.filter((task) => task.status === status).length;
	const vulns = engine.tasks.reduce((sum, task) => sum + task.vulns, 0);
	// The server refuses a change while a worker is in flight, because each task
	// session captures its gate when it is created.
	const busy = engine.tasks.some((task) => task.status === "running" || task.status === "queued");
	const gateLockedReason = busy ? "有任务正在运行或排队，等它们结束再改" : undefined;
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
			<span className="mode-switch engine-gate-switch" title={gateLockedReason ?? "worker 命令的守门方式"}>
				<button
					type="button"
					className={engine.gateMode === "auto" ? "on" : ""}
					disabled={busy}
					onClick={() => onSetGateMode("auto")}
				>
					自动执行
				</button>
				<button
					type="button"
					className={engine.gateMode === "ai" ? "on" : ""}
					disabled={busy || !judgeAvailable}
					title={judgeAvailable ? undefined : "未配置守门模型端点"}
					onClick={() => onSetGateMode("ai")}
				>
					AI 裁判
				</button>
			</span>
			{engine.pauseNote ? <span className="ws-panel__sub">{engine.pauseNote}</span> : null}
		</div>
	);
}

/**
 * The engine's preset whitelist, and whether a task may go without one. Unlike the
 * gate mode both stay editable while the engine runs, because they only narrow what
 * the commander may pick for the tasks it has not dispatched yet.
 */
function EnginePresetWhitelist({
	engine,
	presets,
	onChange,
	onChangeOptional,
}: {
	engine: SentinelEngine;
	presets: SentinelPresetView[];
	onChange(presetIds: string[]): void;
	onChangeOptional(optional: boolean): void;
}) {
	const enabled = presets.filter((preset) => preset.enabled);
	const selected = engine.presetIds;
	const allowed =
		selected.length === 0 ? enabled.length : selected.filter((id) => enabled.some((p) => p.id === id)).length;
	// A required preset with nothing to pick from cannot dispatch at all: the
	// commander would be refused on every attempt.
	const stuck = !engine.presetOptional && allowed === 0;
	return (
		<div className="engine-presets">
			<div className="engine-presets__head">
				<span className="engine-presets__title">预设 Agent 白名单</span>
				<span className={selected.length === 0 ? "engine-presets__state is-open" : "engine-presets__state"}>
					{selected.length === 0 ? "未限制：指挥官可使用全部已启用的预设" : `已限制为 ${selected.length} 个预设`}
				</span>
			</div>
			<p className="form-hint">
				勾选指挥官可以使用的预设；未勾选任何一项 = 不限制（指挥官可用全部已启用的预设）。
				运行中也能修改，只影响之后派发的任务；已停用或已删除的预设不会出现在上面，也不会再被派发。
			</p>
			<div className="engine-presets__list">
				{enabled.length === 0 ? (
					<span className="engine-presets__empty">还没有启用的预设 Agent，可到 设置 → 预设 Agent 创建。</span>
				) : (
					enabled.map((preset) => (
						<label className="engine-preset-item" key={preset.id} title={preset.description || undefined}>
							<input
								type="checkbox"
								checked={selected.includes(preset.id)}
								onChange={(event) =>
									onChange(
										event.target.checked
											? [...selected, preset.id]
											: selected.filter((id) => id !== preset.id),
									)
								}
							/>
							<span className="engine-preset-name">{preset.name}</span>
							<span className="engine-preset-tokens">粗估 {preset.tokens} tokens</span>
						</label>
					))
				)}
			</div>
			<label className="engine-preset-optional">
				<input
					type="checkbox"
					checked={engine.presetOptional}
					onChange={(event) => onChangeOptional(event.target.checked)}
				/>
				<span>允许任务不指定预设（没有合适预设时，指挥官可以省略 preset，让任务用默认 Agent 执行）</span>
			</label>
			<p className={`form-hint${stuck ? " is-warn" : ""}`}>
				{engine.presetOptional
					? "关掉它，指挥官就必须为每个任务指定一个预设；没有合适的时候也不能退回默认 Agent，派发会被拒绝。"
					: stuck
						? "已要求每个任务都必须指定预设，但当前没有可用预设：指挥官无法派发任何任务，请勾选上面的预设，或重新允许使用默认 Agent。"
						: `已要求每个任务都必须指定预设（当前可选 ${allowed} 个）；省略 preset 的派发会被拒绝，不会产生任务。`}
			</p>
		</div>
	);
}

function TargetsBox({ engineId, onSend }: { engineId: string; onSend: (message: unknown) => void }) {
	const [appendText, setAppendText] = useState("");
	return (
		<div className="steer-box">
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

function TaskBoard(props: { engine: SentinelEngine; onOpenTask(taskId: string): void; onAbortTask(taskId: string): void }) {
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
									<span className={`tag ${TASK_STATUS_CLASS[task.status]}`}>
										{TASK_STATUS_LABELS[task.status]}
									</span>
								</span>
								<span className="data-name">
									<span className="task-name-text">{task.title}</span>
									<span
										className={`tag tag-preset ${task.presetName ? "" : "is-default"}`}
										title={task.presetName ? `预设 Agent：${task.presetName}` : "默认 Agent：未指定预设"}
									>
										{task.presetName ?? "默认"}
									</span>
								</span>
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
function toolArgSummary(event: SentinelSubagentEvent): string {
	const args = (event.args ?? {}) as Record<string, unknown>;
	for (const key of ["title", "task_id", "instruction", "reason"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	const text = JSON.stringify(args);
	return text === "{}" ? "" : text;
}

function CommanderFeed({
	engineId,
	running,
	events,
	onSend,
}: {
	engineId: string;
	running: boolean;
	events: SentinelSubagentEvent[];
	onSend: (message: unknown) => void;
}) {
	const [openThinking, setOpenThinking] = useState<Set<number>>(new Set());
	const [draft, setDraft] = useState("");
	const containerRef = useState<{ current: HTMLDivElement | null }>({ current: null })[0];
	useEffect(() => {
		if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
	}, [events.length, containerRef]);
	const sendDraft = (): void => {
		const text = draft.trim();
		if (!text || !running) return;
		onSend({ type: "engine_steer_commander", id: engineId, text });
		setDraft("");
	};
	return (
		<div className="board-col">
			<div className="board-col__head">
				<span className="board-col__title">指挥官</span>
				<span className="ws-panel__sub">对话 · 决策日志</span>
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
						if (event.kind === "text" && event.from === "operator") {
							return (
								<div key={event.seq} className="commander-msg commander-msg--operator">
									<div className="commander-msg__meta">你 · {formatClock(event.at)}</div>
									<div className="commander-msg__bubble">{event.text}</div>
								</div>
							);
						}
						if (event.kind === "text") {
							return (
								<div key={event.seq} className="commander-item">
									<div className="commander-item__meta">{formatClock(event.at)} · 指挥官</div>
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
			<div className="commander-composer">
				<textarea
					rows={2}
					value={draft}
					disabled={!running}
					placeholder={running ? "和指挥官对话…Enter 发送，Shift+Enter 换行" : "工程未运行，暂时不能对话"}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							sendDraft();
						}
					}}
				/>
				<button type="button" disabled={!running || !draft.trim()} onClick={sendDraft}>
					发送
				</button>
			</div>
		</div>
	);
}

function TaskModal(props: {
	task: SentinelEngineTask | null;
	events: SentinelSubagentEvent[];
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
							<span>预设 Agent：{task.presetName ?? "默认 Agent"}</span>
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
	doctrines: SentinelDoctrineView[];
	presets: SentinelPresetView[];
	hasProject: boolean;
	/** Whether a judge endpoint resolves; `ai` is only offered when it does. */
	judgeAvailable: boolean;
	onCancel(): void;
	onSubmit(input: {
		name: string;
		targets: string;
		doctrines: string[];
		presetIds: string[];
		presetOptional: boolean;
		limits: SentinelEngineLimits;
		gateMode: SentinelEngineGateMode;
	}): void;
}) {
	const [name, setName] = useState("");
	const [targets, setTargets] = useState("");
	const [selected, setSelected] = useState<string[]>(props.doctrines.length === 1 ? [props.doctrines[0].id] : []);
	/** Preset whitelist; empty means "no restriction" and is the default. */
	const [selectedPresets, setSelectedPresets] = useState<string[]>([]);
	/** A task may run without a preset; allowing it is the default. */
	const [presetOptional, setPresetOptional] = useState(true);
	const [concurrency, setConcurrency] = useState(3);
	const [roundLimit, setRoundLimit] = useState(5);
	const [maxRetries, setMaxRetries] = useState(1);
	const [tokenLimit, setTokenLimit] = useState("");
	const [timeLimitMin, setTimeLimitMin] = useState("");
	const [gateMode, setGateMode] = useState<SentinelEngineGateMode>("auto");

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
								presetIds: selectedPresets,
								presetOptional,
								limits: {
									concurrency,
									roundLimit,
									maxRetries,
									tokenLimit: tokenLimit.trim() ? Number.parseInt(tokenLimit, 10) : null,
									timeLimitMin: timeLimitMin.trim() ? Number.parseInt(timeLimitMin, 10) : null,
								},
								gateMode,
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
						<input
							type="text"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="如：内网一批 Web 目标"
						/>
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
												event.target.checked
													? [...prev, doctrine.id]
													: prev.filter((id) => id !== doctrine.id),
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
						<label>
							预设 Agent 白名单{" "}
							<span className="hint">未勾选任何一项 = 不限制（指挥官可用全部已启用的预设）</span>
						</label>
						<div className="check-group">
							{props.presets.filter((preset) => preset.enabled).length === 0 ? (
								<span className="engine-presets__empty">
									还没有启用的预设 Agent：保持全不勾选即为不限制，指挥官用默认 Agent 派发任务； 也可以先到 设置
									→ 预设 Agent 创建。
								</span>
							) : (
								props.presets
									.filter((preset) => preset.enabled)
									.map((preset) => (
										<label key={preset.id} className="check-item">
											<input
												type="checkbox"
												checked={selectedPresets.includes(preset.id)}
												onChange={(event) =>
													setSelectedPresets((prev) =>
														event.target.checked
															? [...prev, preset.id]
															: prev.filter((id) => id !== preset.id),
													)
												}
											/>
											<span className="cname">{preset.name}</span>
											<span className="ctext">
												{preset.description ? `${preset.description} · ` : ""}粗估 {preset.tokens} tokens
											</span>
										</label>
									))
							)}
						</div>
						<label className="engine-preset-optional">
							<input
								type="checkbox"
								checked={presetOptional}
								onChange={(event) => setPresetOptional(event.target.checked)}
							/>
							<span>允许任务不指定预设（没有合适预设时，指挥官可以省略 preset，让任务用默认 Agent 执行）</span>
						</label>
						<p className="form-hint">
							{presetOptional
								? "关掉它，指挥官就必须为每个任务指定一个预设；没有合适的时候也不能退回默认 Agent，派发会被拒绝。创建后可在工程详情页修改。"
								: "已要求每个任务都必须指定预设：省略 preset 的派发会被拒绝，不会产生任务；创建后可在工程详情页修改。"}
						</p>
					</div>
					<div className="form-field">
						<label>上限设置</label>
						<div className="limit-grid">
							<div className="form-field">
								<label>最大并发</label>
								<input
									type="number"
									min={1}
									max={20}
									value={concurrency}
									onChange={(event) => setConcurrency(Number(event.target.value))}
								/>
							</div>
							<div className="form-field">
								<label>单任务轮数上限</label>
								<input
									type="number"
									min={1}
									max={99}
									value={roundLimit}
									onChange={(event) => setRoundLimit(Number(event.target.value))}
								/>
							</div>
							<div className="form-field">
								<label>重试上限（每目标）</label>
								<input
									type="number"
									min={0}
									max={10}
									value={maxRetries}
									onChange={(event) => setMaxRetries(Number(event.target.value))}
								/>
							</div>
							<div className="form-field">
								<label>token 上限（留空不限）</label>
								<input
									type="number"
									min={0}
									value={tokenLimit}
									onChange={(event) => setTokenLimit(event.target.value)}
									placeholder="如 2000000"
								/>
							</div>
							<div className="form-field">
								<label>时间上限分钟（留空不限）</label>
								<input
									type="number"
									min={1}
									value={timeLimitMin}
									onChange={(event) => setTimeLimitMin(event.target.value)}
									placeholder="如 60"
								/>
							</div>
						</div>
					</div>
					<div className="form-field">
						<label>
							命令守门 <span className="hint">决定 worker 的每条命令是否先交给守门模型判定</span>
						</label>
						<div className="check-group">
							<label className="check-item">
								<input type="radio" checked={gateMode === "auto"} onChange={() => setGateMode("auto")} />
								<span className="cname">自动执行</span>
								<span className="ctext">worker 的命令直接执行，不做任何拦截（最快）。</span>
							</label>
							<label className="check-item">
								<input
									type="radio"
									checked={gateMode === "ai"}
									disabled={!props.judgeAvailable}
									onChange={() => setGateMode("ai")}
								/>
								<span className="cname">AI 裁判</span>
								<span className="ctext">
									{props.judgeAvailable
										? "每条命令先由守门模型判定，拦截时把理由回给 worker 换一条路（会慢一些，判定失败放行）。"
										: "未配置守门模型端点：请先到 设置 → 模型 配置守门模型（或指挥官模型）。"}
								</span>
							</label>
						</div>
					</div>
					<p className="form-hint">
						启动后指挥官全权调度（免审），各任务在项目容器内自动执行命令；
						{gateMode === "ai"
							? "worker 的命令先经守门模型判定，判定结果记录在「守门审计」。"
							: "无人拦截直接执行。"}
						人保留暂停 / 终止 / 追加目标与 steer。
					</p>
				</div>
			</div>
		</>
	);
}

function DoctrineManager(props: {
	doctrines: SentinelDoctrineView[];
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
						<input
							type="text"
							placeholder="思路名称"
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
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
	config: SentinelModelConfig | null;
	onClose(): void;
	onSave(config: SentinelModelConfig | null): void;
}) {
	const [baseUrl, setBaseUrl] = useState(props.config?.baseUrl ?? "");
	const [apiKey, setApiKey] = useState(props.config?.apiKey ?? "");
	const [modelId, setModelId] = useState(props.config?.modelId ?? "");
	return (
		<>
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					指挥官端点
					<span className="ws-panel__sub">
						{props.config ? "当前：已配置专用端点" : "当前：使用主 Agent 端点"}
					</span>
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
						<input
							type="text"
							value={baseUrl}
							onChange={(event) => setBaseUrl(event.target.value)}
							placeholder="http://127.0.0.1:8000/v1"
						/>
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
