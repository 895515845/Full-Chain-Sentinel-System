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

import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n.ts";
import type {
	SentinelDoctrineView,
	SentinelEngine,
	SentinelEngineGateMode,
	SentinelEngineLimits,
	SentinelEngineSchedule,
	SentinelEngineScheduleAction,
	SentinelEngineScheduleInput,
	SentinelEngineTask,
	SentinelEngineTaskStatus,
	SentinelPresetView,
	SentinelSubagentEvent,
} from "../types.ts";

const TASK_STATUS_LABELS: Record<SentinelEngineTaskStatus, string> = {
	queued: t("排队中"),
	running: t("运行中"),
	done: t("已完成"),
	failed: t("失败"),
	blocked: t("已阻塞"),
	aborted: t("已中止"),
	paused: t("已暂停"),
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
	scheduled: t("已计划"),
	running: t("运行中"),
	paused: t("已暂停"),
	completed: t("已完成"),
	stopped: t("已终止"),
};

const ENGINE_STATUS_CLASS: Record<SentinelEngine["status"], string> = {
	scheduled: "tag-scheduled",
	running: "tag-running",
	paused: "tag-paused",
	completed: "tag-done",
	stopped: "tag-stopped",
};

function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60000);
	if (minutes < 60) return t("{minutes} 分钟", { minutes });
	return t("{hours} 小时 {rest} 分", { hours: Math.floor(minutes / 60), rest: minutes % 60 });
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

const SCHEDULE_PHASE_LABELS: Record<SentinelEngineSchedule["phase"], string> = {
	waiting_start: t("等待开始"),
	running: t("计划运行中"),
	paused: t("计划暂停中"),
	finished: t("计划已结束"),
};

const SCHEDULE_FINISH_LABELS: Record<NonNullable<SentinelEngineSchedule["finishedReason"]>, string> = {
	completed: t("工程已完成，后续计划取消"),
	deadline: t("到达最晚停止时间，工程未完成，已暂停"),
	manual: t("操作员手动操作，后续计划已停用"),
	canceled: t("计划已取消"),
	start_failed: t("定时启动或恢复失败，计划已停用"),
	missed: t("错过开始时间超过 10 分钟，计划未自动补跑"),
	restart: t("服务重启，计划已停用，等待操作员继续"),
};

const SCHEDULE_ACTION_LABELS: Record<SentinelEngineScheduleAction, string> = {
	start: t("启动"),
	pause: t("暂停"),
	resume: t("恢复"),
	deadline: t("最晚停止"),
};

function browserTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatZonedDateTime(at: number, timezone: string): string {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
			hourCycle: "h23",
		}).formatToParts(new Date(at));
		const value = (type: Intl.DateTimeFormatPartTypes): string =>
			parts.find((part) => part.type === type)?.value ?? "";
		return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
	} catch {
		return new Date(at).toLocaleString("zh-CN", { hour12: false });
	}
}

function toLocalInputValue(at: number): string {
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseLocalInput(value: string): number | null {
	if (!value) return null;
	const at = new Date(value).getTime();
	return Number.isFinite(at) ? at : null;
}

interface ScheduleDraft {
	startAt: string;
	pauseEnabled: boolean;
	pauseAt: string;
	resumeAt: string;
	deadlineEnabled: boolean;
	deadlineAt: string;
}

function emptyScheduleDraft(now = Date.now()): ScheduleDraft {
	const start = now + 30 * 60_000;
	return {
		startAt: toLocalInputValue(start),
		pauseEnabled: false,
		pauseAt: toLocalInputValue(start + 4 * 60 * 60_000),
		resumeAt: toLocalInputValue(start + 8 * 60 * 60_000),
		deadlineEnabled: false,
		deadlineAt: toLocalInputValue(start + 10 * 60 * 60_000),
	};
}

function draftFromSchedule(schedule: SentinelEngineSchedule): ScheduleDraft {
	return {
		startAt: toLocalInputValue(schedule.startAt),
		pauseEnabled: schedule.pauseAt !== null,
		pauseAt: schedule.pauseAt !== null ? toLocalInputValue(schedule.pauseAt) : "",
		resumeAt: schedule.resumeAt !== null ? toLocalInputValue(schedule.resumeAt) : "",
		deadlineEnabled: schedule.deadlineAt !== null,
		deadlineAt: schedule.deadlineAt !== null ? toLocalInputValue(schedule.deadlineAt) : "",
	};
}

function parseScheduleDraft(draft: ScheduleDraft): { schedule?: SentinelEngineScheduleInput; error?: string } {
	const startAt = parseLocalInput(draft.startAt);
	if (startAt === null) return { error: t("请选择开始时间") };
	if (startAt <= Date.now()) return { error: t("开始时间必须晚于当前时间") };
	const pauseAt = draft.pauseEnabled ? parseLocalInput(draft.pauseAt) : null;
	const resumeAt = draft.pauseEnabled ? parseLocalInput(draft.resumeAt) : null;
	if (draft.pauseEnabled && (pauseAt === null || resumeAt === null)) {
		return { error: t("请同时填写暂停时间和恢复时间") };
	}
	if (pauseAt !== null && pauseAt <= startAt) return { error: t("暂停时间必须晚于开始时间") };
	if (pauseAt !== null && resumeAt !== null && resumeAt <= pauseAt) {
		return { error: t("恢复时间必须晚于暂停时间") };
	}
	const deadlineAt = draft.deadlineEnabled ? parseLocalInput(draft.deadlineAt) : null;
	if (draft.deadlineEnabled && deadlineAt === null) return { error: t("请选择最晚停止时间") };
	const lastStep = resumeAt ?? pauseAt ?? startAt;
	if (deadlineAt !== null && deadlineAt <= lastStep) {
		return { error: t("最晚停止时间必须晚于最后一次计划动作") };
	}
	return {
		schedule: {
			timezone: browserTimezone(),
			startAt,
			pauseAt,
			resumeAt,
			deadlineAt,
		},
	};
}

function nextPlanStep(
	schedule: SentinelEngineSchedule,
): { action: SentinelEngineScheduleAction; at: number } | null {
	if (schedule.phase === "finished") return null;
	const candidates: Array<{ action: SentinelEngineScheduleAction; at: number }> = [];
	if (schedule.phase === "waiting_start" && !schedule.applied.includes("start")) {
		candidates.push({ action: "start", at: schedule.startAt });
	}
	if (schedule.phase === "running") {
		if (schedule.pauseAt !== null && !schedule.applied.includes("pause")) {
			candidates.push({ action: "pause", at: schedule.pauseAt });
		}
		if (schedule.deadlineAt !== null && !schedule.applied.includes("deadline")) {
			candidates.push({ action: "deadline", at: schedule.deadlineAt });
		}
	}
	if (schedule.phase === "paused") {
		if (schedule.resumeAt !== null && !schedule.applied.includes("resume")) {
			candidates.push({ action: "resume", at: schedule.resumeAt });
		}
		if (schedule.deadlineAt !== null && !schedule.applied.includes("deadline")) {
			candidates.push({ action: "deadline", at: schedule.deadlineAt });
		}
	}
	return candidates.sort((left, right) => left.at - right.at)[0] ?? null;
}

function formatRemaining(at: number, now: number): string {
	const delta = at - now;
	if (delta <= 0) return t("即将执行");
	const minutes = Math.ceil(delta / 60_000);
	if (minutes < 60) return t("{minutes} 分钟后", { minutes });
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest > 0
		? t("{hours} 小时 {rest} 分钟后", { hours, rest })
		: t("{hours} 小时后", { hours });
}

export interface EnginePageProps {
	engines: SentinelEngine[];
	doctrines: SentinelDoctrineView[];
	/** Enabled presets the commander may dispatch with, for the whitelist controls. */
	presets: SentinelPresetView[];
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

type View = "list" | "board" | "create" | "doctrines";

export function EnginePage(props: EnginePageProps) {
	const [view, setView] = useState<View>("list");
	const [boardId, setBoardId] = useState<string | null>(null);
	const [openTaskId, setOpenTaskId] = useState<string | null>(null);
	const [report, setReport] = useState<{ markdown: string; filename: string } | null>(null);
	const [editingSchedule, setEditingSchedule] = useState(false);

	const board = useMemo(() => props.engines.find((engine) => engine.id === boardId) ?? null, [props.engines, boardId]);
	const scheduleActive = !!board?.schedule && board.schedule.phase !== "finished";
	useEffect(() => {
		if (board?.status !== "scheduled") setEditingSchedule(false);
	}, [board?.status]);

	const openBoard = (id: string) => {
		setBoardId(id);
		setView("board");
	};

	// Poll the persisted commander log while a board is open. Live events are
	// pushed over the socket too, but a missed frame (or a handler still awaiting
	// a commander turn) must not leave the conversation invisible until refresh.
	const openEventsRef = useRef(props.onOpenCommanderEvents);
	openEventsRef.current = props.onOpenCommanderEvents;
	useEffect(() => {
		if (view !== "board" || !boardId) return;
		const load = (): void => openEventsRef.current(boardId);
		load();
		const timer = window.setInterval(load, 3000);
		return () => window.clearInterval(timer);
	}, [view, boardId]);

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

	if (view === "board" && board) {
		return (
			<div className="page-card">
				<div className="ws-panel__head">
					<div className="ws-panel__title engine-subline">
						<button type="button" onClick={() => setView("list")}>
							{t("← 返回")}
						</button>
						{board.name}
						<span className={`tag ${ENGINE_STATUS_CLASS[board.status]}`}>
							{ENGINE_STATUS_LABELS[board.status]}
						</span>
						<span className="ws-panel__sub">
							{board.projectName}
							{t(" · 创建于 {time}", {
								time: new Date(board.createdAt).toLocaleString("zh-CN", { hour12: false }),
							})}
							{board.startedAt !== null
								? board.endedAt
									? t(" · 历时 {duration}", { duration: formatDuration(board.endedAt - board.startedAt) })
									: board.status === "running"
										? t(" · 已运行 {duration}", {
												duration: formatDuration(Date.now() - board.startedAt),
											})
										: ""
								: t(" · 尚未启动")}
						</span>
					</div>
					<div className="ws-panel__actions">
						<button type="button" onClick={() => send({ type: "engine_report_snapshot", id: board.id })}>
							{t("进度快照")}
						</button>
						{board.report ? (
							<button
								type="button"
								onClick={() =>
									setReport({
										markdown: board.report ?? "",
										filename: t("{name}-总报告.md", { name: board.name }),
									})
								}
							>
								{t("查看总报告")}
							</button>
						) : null}
						{board.status === "scheduled" ? (
							<button type="button" onClick={() => setEditingSchedule(true)}>
								{t("修改计划")}
							</button>
						) : null}
						{board.status === "scheduled" ? (
							<button
								type="button"
								onClick={() => {
									if (window.confirm(t("取消后计划不再执行，工程会标记为已终止。确定取消？"))) {
										send({ type: "engine_cancel_schedule", id: board.id });
									}
								}}
							>
								{t("取消计划")}
							</button>
						) : null}
						{scheduleActive && board.status !== "scheduled" ? (
							<button
								type="button"
								onClick={() => {
									if (window.confirm(t("停用后续定时计划？当前运行不会停止。"))) {
										send({ type: "engine_cancel_schedule", id: board.id });
									}
								}}
							>
								{t("停用计划")}
							</button>
						) : null}
						{board.status === "running" ? (
							<button
								type="button"
								onClick={() => {
									if (scheduleActive && !window.confirm(t("手动暂停会停用后续定时计划，确定？"))) return;
									send({ type: "engine_pause", id: board.id });
								}}
							>
								{t("暂停")}
							</button>
						) : null}
						{board.status === "paused" ? (
							<button
								type="button"
								className="primary"
								onClick={() => {
									if (scheduleActive && !window.confirm(t("手动继续会停用后续定时计划，确定？"))) return;
									send({ type: "engine_resume", id: board.id });
								}}
							>
								{t("继续")}
							</button>
						) : null}
						{board.status === "running" || board.status === "paused" ? (
							<button
								type="button"
								onClick={() => {
									if (scheduleActive && !window.confirm(t("终止会同时停用后续定时计划，确定？"))) return;
									send({ type: "engine_abort", id: board.id });
								}}
							>
								{t("终止")}
							</button>
						) : (
							<button
								type="button"
								onClick={() => {
									if (window.confirm(t("删除工程「{name}」？任务记录将一并删除。", { name: board.name }))) {
										send({ type: "engine_delete", id: board.id });
										setView("list");
									}
								}}
							>
								{t("删除")}
							</button>
						)}
					</div>
				</div>
				<div className="ws-panel__body">
					{board.schedule ? <ScheduleStrip schedule={board.schedule} /> : null}
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
							completed={board.status === "completed"}
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
				{editingSchedule && board.schedule ? (
					<ScheduleModal
						schedule={board.schedule}
						onClose={() => setEditingSchedule(false)}
						onSave={(schedule) => {
							send({ type: "engine_set_schedule", id: board.id, schedule });
							setEditingSchedule(false);
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
										{t("复制")}
									</button>
									<button type="button" className="primary" onClick={() => setReport(null)}>
										{t("关闭")}
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
					{t("工程")}
					<span className="ws-panel__sub">
						{props.hasProject
							? t("{project} · {count} 个工程", {
									project: props.engines[0]?.projectName ?? "",
									count: props.engines.length,
								})
							: t("请先选择项目")}
					</span>
				</div>
				<div className="ws-panel__actions">
					<button type="button" onClick={() => setView("doctrines")}>
						{t("指挥思路")}
					</button>
					<button type="button" className="primary" disabled={!props.hasProject} onClick={() => setView("create")}>
						{t("新建工程")}
					</button>
				</div>
			</div>
			<div className="ws-panel__body">
				{props.engines.length === 0 ? (
					<div className="ws-empty">
						{props.hasProject
							? t("还没有工程。点「新建工程」，贴入目标清单并选择指挥思路即可开始。")
							: t("工程属于项目：请先在侧栏顶部选择或创建一个项目。")}
					</div>
				) : (
					<div className="data-table engines-table">
						<div className="data-row data-head">
							<span>{t("工程")}</span>
							<span>{t("状态")}</span>
							<span>{t("进度")}</span>
							<span>{t("中枢提交")}</span>
							<span>{t("耗时")}</span>
							<span>{t("创建时间")}</span>
						</div>
						{props.engines.map((engine) => {
							const running = engine.tasks.filter((task) => task.status === "running").length;
							const queued = engine.tasks.filter((task) => task.status === "queued").length;
							const done = engine.tasks.filter((task) => task.status === "done").length;
							const failed = engine.tasks.filter((task) => ["failed", "blocked"].includes(task.status)).length;
							const parts = [
								t("{count} 完成", { count: done }),
								running > 0 ? t("{count} 运行", { count: running }) : "",
								queued > 0 ? t("{count} 排队", { count: queued }) : "",
								failed > 0 ? t("{count} 失败", { count: failed }) : "",
							].filter(Boolean);
							const startedAt = engine.startedAt ?? engine.createdAt;
							const elapsed =
								engine.startedAt === null
									? null
									: (engine.endedAt ?? (engine.status === "running" ? Date.now() : startedAt)) -
										startedAt;
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
									<span>{parts.join(" · ") || "—"}</span>
									<span>
										{t("{count} 条", {
											count: engine.tasks.reduce((sum, task) => sum + task.vulns, 0),
										})}
									</span>
									<span>{elapsed === null ? "—" : formatDuration(elapsed)}</span>
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
	const gateLockedReason = busy ? t("有任务正在运行或排队，等它们结束再改") : undefined;
	return (
		<div className="engine-stats">
			<span className="tag tag-running">{t("运行 {count}", { count: count("running") })}</span>
			<span className="tag tag-queued">{t("排队 {count}", { count: count("queued") })}</span>
			<span className="tag tag-done">{t("完成 {count}", { count: count("done") })}</span>
			<span className="tag tag-failed">{t("失败 {count}", { count: count("failed") })}</span>
			<span className="tag tag-blocked">{t("阻塞 {count}", { count: count("blocked") })}</span>
			<span>
				{t("· 中枢提交")} <span className="stat-num">{vulns}</span> {t("条")}
			</span>
			<span>
				{t("· 并发")} <span className="stat-num">{engine.limits.concurrency}</span>
			</span>
			<span>
				{t("轮数")} <span className="stat-num">{engine.limits.roundLimit}</span>
			</span>
			<span>
				{t("重试")} <span className="stat-num">{engine.limits.maxRetries}</span>
			</span>
			{engine.limits.tokenLimit ? (
				<span>
					{t("token 上限")} <span className="stat-num">{formatUsage(engine.limits.tokenLimit)}</span>
				</span>
			) : null}
			{engine.limits.timeLimitMin ? (
				<span>
					{t("时间上限")}{" "}
					<span className="stat-num">
						{engine.limits.timeLimitMin} {t("分")}
					</span>
				</span>
			) : null}
			<span className="mode-switch engine-gate-switch" title={gateLockedReason ?? t("worker 命令的守门方式")}>
				<button
					type="button"
					className={engine.gateMode === "auto" ? "on" : ""}
					disabled={busy}
					onClick={() => onSetGateMode("auto")}
				>
					{t("自动执行")}
				</button>
				<button
					type="button"
					className={engine.gateMode === "ai" ? "on" : ""}
					disabled={busy || !judgeAvailable}
					title={judgeAvailable ? undefined : t("未配置守门模型端点")}
					onClick={() => onSetGateMode("ai")}
				>
					{t("AI 裁判")}
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
				<span className="engine-presets__title">{t("预设 Agent 白名单")}</span>
				<span className={selected.length === 0 ? "engine-presets__state is-open" : "engine-presets__state"}>
					{selected.length === 0
						? t("未限制：指挥官可使用全部已启用的预设")
						: t("已限制为 {count} 个预设", { count: selected.length })}
				</span>
			</div>
			<p className="form-hint">
				{t("勾选指挥官可以使用的预设；未勾选任何一项 = 不限制（指挥官可用全部已启用的预设）。")}{" "}
				{t("运行中也能修改，只影响之后派发的任务；已停用或已删除的预设不会出现在上面，也不会再被派发。")}
			</p>
			<div className="engine-presets__list">
				{enabled.length === 0 ? (
					<span className="engine-presets__empty">
						{t("还没有启用的预设 Agent，可到 设置 → 预设 Agent 创建。")}
					</span>
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
							<span className="engine-preset-tokens">{t("粗估 {count} tokens", { count: preset.tokens })}</span>
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
				<span>{t("允许任务不指定预设（没有合适预设时，指挥官可以省略 preset，让任务用默认 Agent 执行）")}</span>
			</label>
			<p className={`form-hint${stuck ? " is-warn" : ""}`}>
				{engine.presetOptional
					? t("关掉它，指挥官就必须为每个任务指定一个预设；没有合适的时候也不能退回默认 Agent，派发会被拒绝。")
					: stuck
						? t("已要求每个任务都必须指定预设，但当前没有可用预设：指挥官无法派发任何任务，请勾选上面的预设，或重新允许使用默认 Agent。")
						: t("已要求每个任务都必须指定预设（当前可选 {count} 个）；省略 preset 的派发会被拒绝，不会产生任务。", {
								count: allowed,
							})}
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
				placeholder={t("追加目标（一行一个，可带备注）…")}
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
				{t("追加")}
			</button>
		</div>
	);
}

function TaskBoard(props: { engine: SentinelEngine; onOpenTask(taskId: string): void; onAbortTask(taskId: string): void }) {
	const tasks = props.engine.tasks;
	return (
		<div className="board-col">
			<div className="board-col__head">
				<span className="board-col__title">{t("任务看板")}</span>
				<span className="ws-panel__sub">{t("{count} 个任务 · 点行看详情", { count: tasks.length })}</span>
			</div>
			<div className="board-col__body">
				{tasks.length === 0 ? (
					<div className="ws-empty">
						{props.engine.status === "scheduled"
							? t("计划等待开始。到点后先检查运行环境，再启动指挥官并派发任务。")
							: t("还没有任务。指挥官启动后会在这里派发。")}
					</div>
				) : (
					<div className="data-table tasks-table">
						<div className="data-row data-head">
							<span>{t("状态")}</span>
							<span>{t("任务")}</span>
							<span>{t("目标")}</span>
							<span>{t("次数")}</span>
							<span>{t("用量")}</span>
							<span>{t("结论")}</span>
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
										title={
											task.presetName
												? t("预设 Agent：{name}", { name: task.presetName })
												: t("默认 Agent：未指定预设")
										}
									>
										{task.presetName ?? t("默认")}
									</span>
								</span>
								<span className="data-mono">{task.target ?? "—"}</span>
								<span>{t("第 {count} 次", { count: task.attempt })}</span>
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
											{t("中止")}
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
	completed,
	events,
	onSend,
}: {
	engineId: string;
	running: boolean;
	completed: boolean;
	events: SentinelSubagentEvent[];
	onSend: (message: unknown) => void;
}) {
	const canChat = running || completed;
	const [openThinking, setOpenThinking] = useState<Set<number>>(new Set());
	const [draft, setDraft] = useState("");
	const containerRef = useState<{ current: HTMLDivElement | null }>({ current: null })[0];
	useEffect(() => {
		if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
	}, [events.length, containerRef]);
	const sendDraft = (): void => {
		const text = draft.trim();
		if (!text || !canChat) return;
		onSend({ type: "engine_steer_commander", id: engineId, text });
		setDraft("");
	};
	return (
		<div className="board-col">
			<div className="board-col__head">
				<span className="board-col__title">{t("指挥官")}</span>
				<span className="ws-panel__sub">{t("对话 · 决策日志")}</span>
			</div>
			<div className="board-col__body" ref={containerRef}>
				<div className="commander-feed">
					{events.length === 0 ? <div className="ws-empty">{t("指挥官还没有动作。")}</div> : null}
					{events.map((event) => {
						if (event.kind === "thinking") {
							const isOpen = openThinking.has(event.seq);
							return (
								<div key={event.seq} className="commander-item">
									<div className="commander-item__meta">{t("{time} · 思考", { time: formatClock(event.at) })}</div>
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
										{isOpen
											? t("思考 · {count} 字（点起）", { count: (event.text ?? "").length })
											: t("思考 · {count} 字（点开）", { count: (event.text ?? "").length })}
									</button>
									{isOpen ? <div className="commander-thinking-open">{event.text}</div> : null}
								</div>
							);
						}
						if (event.kind === "text" && event.from === "operator") {
							return (
								<div key={event.seq} className="commander-msg commander-msg--operator">
									<div className="commander-msg__meta">{t("你 · {time}", { time: formatClock(event.at) })}</div>
									<div className="commander-msg__bubble">{event.text}</div>
								</div>
							);
						}
						if (event.kind === "text") {
							return (
								<div key={event.seq} className="commander-item">
									<div className="commander-item__meta">
										{t("{time} · 指挥官", { time: formatClock(event.at) })}
									</div>
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
					disabled={!canChat}
					placeholder={
						running
							? t("和指挥官对话…Enter 发送，Shift+Enter 换行")
							: completed
								? t("工程已完成，向指挥官追问报告细节…")
								: t("工程未运行，暂时不能对话")
					}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							sendDraft();
						}
					}}
				/>
				<button type="button" disabled={!canChat || !draft.trim()} onClick={sendDraft}>
					{t("发送")}
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
							<span>{t("目标：{target}", { target: task.target ?? "—" })}</span>
							<span>{t("预设 Agent：{name}", { name: task.presetName ?? t("默认 Agent") })}</span>
							<span>{t("第 {count} 次派发", { count: task.attempt })}</span>
							<span>{t("轮数上限 {count}", { count: task.roundLimit })}</span>
							<span>{t("工作目录 /work/tasks/{workspace}", { workspace: task.workspace })}</span>
						</div>
					</div>
					<div className="ws-panel__actions">
						{task.sessionId ? (
							<button type="button" onClick={() => props.onOpenInChat(task.id)}>
								{t("在对话中打开")}
							</button>
						) : null}
						{task.status === "running" || task.status === "queued" ? (
							<button type="button" onClick={() => props.onAbort(task.id)}>
								{t("中止任务")}
							</button>
						) : null}
						<button type="button" className="primary" onClick={props.onClose}>
							{t("关闭")}
						</button>
					</div>
				</div>
				<div className="vuln-meta-grid">
					<div>
						<span>{t("耗时")}</span>
						<span>{task.startedAt ? formatDuration((task.endedAt ?? Date.now()) - task.startedAt) : "—"}</span>
					</div>
					<div>
						<span>{t("用量")}</span>
						<span>{formatUsage(task.usage?.total)} tokens</span>
					</div>
					<div>
						<span>{t("中枢提交")}</span>
						<span>{t("{count} 条", { count: task.vulns })}</span>
					</div>
					<div>
						<span>{t("任务 ID")}</span>
						<span>{task.id}</span>
					</div>
				</div>
				<h3>{task.status === "running" ? t("当前结论") : t("结论")}</h3>
				{task.error ? <div className="engine-task-error">{task.error}</div> : null}
				<div className="engine-task-summary">{task.summary ?? t("（暂无）")}</div>
				<h3>{t("任务指令（指挥官原文）")}</h3>
				<pre className="ws-console__body">{task.objective}</pre>
				<h3>{t("执行过程 · {count} 步", { count: props.events.length })}</h3>
				<div className="engine-task-events">
					{props.events.slice(-30).map((event) => (
						<div key={event.seq} className="engine-task-event">
							<div className="engine-task-event__head">
								<span>{formatClock(event.at)}</span>
								{event.kind === "text" ? (
									<span>✎ {(event.text ?? "").slice(0, 160)}</span>
								) : event.kind === "thinking" ? (
									<span>{t("思考 · {count} 字", { count: (event.text ?? "").length })}</span>
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

function ScheduleStrip({ schedule }: { schedule: SentinelEngineSchedule }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (schedule.phase === "finished") return;
		const timer = window.setInterval(() => setNow(Date.now()), 15_000);
		return () => window.clearInterval(timer);
	}, [schedule.phase]);
	const next = nextPlanStep(schedule);
	const steps: Array<{ action: SentinelEngineScheduleAction; at: number }> = [
		{ action: "start", at: schedule.startAt },
	];
	if (schedule.pauseAt !== null) steps.push({ action: "pause", at: schedule.pauseAt });
	if (schedule.resumeAt !== null) steps.push({ action: "resume", at: schedule.resumeAt });
	if (schedule.deadlineAt !== null) steps.push({ action: "deadline", at: schedule.deadlineAt });
	const phaseClass =
		schedule.phase === "running"
			? "tag-running"
			: schedule.phase === "paused"
				? "tag-paused"
				: schedule.phase === "finished"
					? "tag-stopped"
					: "tag-scheduled";
	return (
		<div className="schedule-strip">
			<div className="schedule-strip__head">
				<span className="schedule-strip__title">{t("定时计划")}</span>
				<span className={`tag ${phaseClass}`}>{SCHEDULE_PHASE_LABELS[schedule.phase]}</span>
				<span className="schedule-strip__zone">{schedule.timezone}</span>
				{next ? (
					<span className="schedule-strip__next">
						{t("下次{action} {time}（{remaining}）", {
							action: SCHEDULE_ACTION_LABELS[next.action],
							time: formatZonedDateTime(next.at, schedule.timezone),
							remaining: formatRemaining(next.at, now),
						})}
					</span>
				) : schedule.phase === "running" ? (
					<span className="schedule-strip__next">{t("无后续计划动作，运行至工程完成")}</span>
				) : schedule.phase === "finished" ? (
					<span className="schedule-strip__next">{SCHEDULE_FINISH_LABELS[schedule.finishedReason ?? "manual"]}</span>
				) : null}
			</div>
			<div className="schedule-strip__timeline">
				{steps.map((step) => {
					const done = schedule.applied.includes(step.action);
					const current = next?.action === step.action;
					return (
						<span
							key={step.action}
							className={`schedule-step${done ? " is-done" : ""}${current ? " is-next" : ""}`}
						>
							<span className="schedule-step__mark">{done ? "✓" : current ? "→" : "·"}</span>
							<span className="schedule-step__label">{SCHEDULE_ACTION_LABELS[step.action]}</span>
							<span className="schedule-step__time">{formatZonedDateTime(step.at, schedule.timezone)}</span>
						</span>
					);
				})}
			</div>
		</div>
	);
}

function ScheduleFields({
	draft,
	onChange,
	timezone,
}: {
	draft: ScheduleDraft;
	onChange: (next: ScheduleDraft) => void;
	timezone: string;
}) {
	const set = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]): void =>
		onChange({ ...draft, [key]: value });
	const lastStep = draft.resumeAt || draft.pauseAt || draft.startAt;
	return (
		<div className="schedule-fields">
			<div className="schedule-grid">
				<div className="form-field">
					<label>{t("开始时间")}</label>
					<input
						type="datetime-local"
						value={draft.startAt}
						min={toLocalInputValue(Date.now())}
						onChange={(event) => set("startAt", event.target.value)}
					/>
				</div>
				<div className="form-field schedule-timezone">
					<label>{t("时区")}</label>
					<span>{t("{timezone}（浏览器时区）", { timezone })}</span>
				</div>
			</div>
			<label className="schedule-check">
				<input
					type="checkbox"
					checked={draft.pauseEnabled}
					onChange={(event) => set("pauseEnabled", event.target.checked)}
				/>
				<span>{t("中途暂停，并在指定时间自动恢复")}</span>
			</label>
			{draft.pauseEnabled ? (
				<div className="schedule-grid">
					<div className="form-field">
						<label>{t("暂停时间")}</label>
						<input
							type="datetime-local"
							value={draft.pauseAt}
							min={draft.startAt}
							onChange={(event) => set("pauseAt", event.target.value)}
						/>
					</div>
					<div className="form-field">
						<label>{t("恢复时间")}</label>
						<input
							type="datetime-local"
							value={draft.resumeAt}
							min={draft.pauseAt || draft.startAt}
							onChange={(event) => set("resumeAt", event.target.value)}
						/>
					</div>
				</div>
			) : null}
			<label className="schedule-check">
				<input
					type="checkbox"
					checked={draft.deadlineEnabled}
					onChange={(event) => set("deadlineEnabled", event.target.checked)}
				/>
				<span>{t("设置最晚停止时间；到点未完成则暂停，等待操作员决定")}</span>
			</label>
			{draft.deadlineEnabled ? (
				<div className="form-field">
					<label>{t("最晚停止时间")}</label>
					<input
						type="datetime-local"
						value={draft.deadlineAt}
						min={lastStep}
						onChange={(event) => set("deadlineAt", event.target.value)}
					/>
				</div>
			) : null}
			<p className="form-hint">
				{t("到点暂停会立即中断正在运行的 Agent，保留会话，恢复时自动续跑。服务重启会暂停工程并停用计划，需要操作员手动继续。")}
			</p>
		</div>
	);
}

function ScheduleModal({
	schedule,
	onClose,
	onSave,
}: {
	schedule: SentinelEngineSchedule;
	onClose: () => void;
	onSave: (schedule: SentinelEngineScheduleInput) => void;
}) {
	const [draft, setDraft] = useState(() => draftFromSchedule(schedule));
	const [error, setError] = useState<string | null>(null);
	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal modal--wide" onClick={(event) => event.stopPropagation()}>
				<div className="vuln-detail__head">
					<div className="vuln-detail__title">{t("修改定时计划")}</div>
					<div className="ws-panel__actions">
						<button type="button" onClick={onClose}>
							{t("取消")}
						</button>
						<button
							type="button"
							className="primary"
							onClick={() => {
								const parsed = parseScheduleDraft(draft);
								if (!parsed.schedule) {
									setError(parsed.error ?? t("计划无效"));
									return;
								}
								onSave(parsed.schedule);
							}}
						>
							{t("保存计划")}
						</button>
					</div>
				</div>
				<div className="modal__body">
					{error ? <p className="form-error">{error}</p> : null}
					<ScheduleFields
						draft={draft}
						onChange={(next) => {
							setDraft(next);
							setError(null);
						}}
						timezone={browserTimezone()}
					/>
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
		schedule?: SentinelEngineScheduleInput;
	}): void;
}) {
	type WizardStep = 1 | 2 | 3;
	const [step, setStep] = useState<WizardStep>(1);
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
	const [startMode, setStartMode] = useState<"now" | "scheduled">("now");
	const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => emptyScheduleDraft());
	const [formError, setFormError] = useState<string | null>(null);

	const enabledPresets = props.presets.filter((preset) => preset.enabled);
	const stepMeta = [
		{ step: 1 as const, title: t("目标"), hint: t("范围与名称") },
		{ step: 2 as const, title: t("指挥"), hint: t("思路与 Agent") },
		{ step: 3 as const, title: t("执行"), hint: t("时间与上限") },
	];
	const selectedPresetLabel =
		selectedPresets.length === 0
			? t("Agent 不限制")
			: t("{count} 个 Agent 预设", { count: selectedPresets.length });

	/** Validation is per step so "下一步" never skips a blocking field. */
	function validateStep(target: WizardStep): string | null {
		if (target === 1) {
			if (!name.trim()) return t("请填写工程名称");
			if (targets.trim() === "") return t("请至少填写一个目标");
			return null;
		}
		if (target === 2) {
			if (selected.length === 0) return t("请至少选择一个指挥思路");
			return null;
		}
		if (startMode === "scheduled") {
			const parsed = parseScheduleDraft(scheduleDraft);
			return parsed.schedule ? null : (parsed.error ?? t("定时计划无效"));
		}
		return null;
	}

	function goToStep(target: WizardStep): void {
		if (target > step) {
			for (let current = step; current < target; current += 1) {
				const error = validateStep(current as WizardStep);
				if (error) {
					setStep(current as WizardStep);
					setFormError(error);
					return;
				}
			}
		}
		setStep(target);
		setFormError(null);
	}

	function submit(): void {
		for (const current of [1, 2, 3] as const) {
			const error = validateStep(current);
			if (error) {
				setStep(current);
				setFormError(error);
				return;
			}
		}
		const parsed = startMode === "scheduled" ? parseScheduleDraft(scheduleDraft) : {};
		if (startMode === "scheduled" && !parsed.schedule) {
			setFormError(parsed.error ?? t("定时计划无效"));
			return;
		}
		setFormError(null);
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
			schedule: parsed.schedule,
		});
	}

	function next(): void {
		const error = validateStep(step);
		if (error) {
			setFormError(error);
			return;
		}
		if (step < 3) {
			setStep((step + 1) as WizardStep);
			setFormError(null);
			return;
		}
		submit();
	}

	const nextLabel =
		step === 1
			? t("下一步：指挥设置 →")
			: step === 2
				? t("下一步：执行配置 →")
				: startMode === "scheduled"
					? t("保存计划")
					: t("启动工程 →");

	return (
		<>
			<div className="engine-wizard-head">
				<div>
					<div className="engine-wizard-crumb">
						<b>{t("工程")}</b>
						<span>/</span>
						<span>{t("新建工程")}</span>
					</div>
					<div className="engine-wizard-titleline">
						<h1>{t("新建工程")}</h1>
						<span className="tag tag-running">{t("步骤 {step} / 3", { step })}</span>
					</div>
					<p className="engine-wizard-sub">{t("把目标、指挥和执行拆开，完成一步再走下一步。")}</p>
				</div>
				<div className="ws-panel__actions">
					<button type="button" onClick={props.onCancel}>
						{t("取消")}
					</button>
				</div>
			</div>

			<div className="engine-wizard-body">
				<div className="engine-wizard">
					<aside className="engine-wizard-rail">
						{stepMeta.map((item) => {
							const current = step === item.step;
							const done = step > item.step;
							return (
								<button
									key={item.step}
									type="button"
									className={`engine-wizard-step${current ? " on" : ""}${done ? " done" : ""}`}
									aria-current={current ? "step" : undefined}
									onClick={() => goToStep(item.step)}
								>
									<span className="engine-wizard-step-index">{done ? "✓" : item.step}</span>
									<span className="engine-wizard-step-copy">
										<b>{item.title}</b>
										<span>{item.hint}</span>
									</span>
								</button>
							);
						})}
						<div className="engine-wizard-rail-summary">
							<span className="engine-wizard-rail-kicker">DRAFT / 0{step}</span>
							<b>{name.trim() || t("未命名工程")}</b>
							<p>
								{t("{doctrines} 条思路", { doctrines: selected.length })}
								<br />
								{selectedPresetLabel}
							</p>
						</div>
					</aside>

					<div className="engine-wizard-panel">
						{formError ? (
							<p className="form-error" role="alert">
								{formError}
							</p>
						) : null}

						{step === 1 ? (
							<>
								<div className="engine-wizard-kicker">STEP 01 / SCOPE</div>
								<h2>{t("先定义这次评估的边界")}</h2>
								<p className="engine-wizard-lead">
									{t("目标越具体，指挥官拆出来的任务越稳。备注只给指挥官看，不会被当作命令。")}
								</p>
								<div className="form-field engine-wizard-name">
									<label htmlFor="engine-wizard-name">{t("工程名称")}</label>
									<input
										id="engine-wizard-name"
										type="text"
										value={name}
										onChange={(event) => {
											setName(event.target.value);
											setFormError(null);
										}}
										placeholder={t("如：内网一批 Web 目标")}
									/>
								</div>
								<div className="form-field engine-wizard-target-field">
									<label htmlFor="engine-wizard-targets">
										{t("目标清单")} <span className="hint">{t("一行一个：目标 + 可选备注")}</span>
									</label>
									<textarea
										id="engine-wizard-targets"
										className="engine-wizard-targets"
										value={targets}
										onChange={(event) => {
											setTargets(event.target.value);
											setFormError(null);
										}}
										placeholder={t(
											"10.0.0.1 这台是 Web 服务器\n10.0.0.2\nhttp://target.example.com 只测登录功能",
										)}
									/>
									<div className="engine-wizard-target-meta">
										<span>{t("支持 IP / 域名 / URL")}</span>
									</div>
								</div>
							</>
						) : null}

						{step === 2 ? (
							<>
								<div className="engine-wizard-kicker">STEP 02 / COMMAND</div>
								<h2>{t("谁来做，按什么思路做")}</h2>
								<p className="engine-wizard-lead">
									{t("思路会合并成指挥官的作战偏好；Agent 白名单只限制它能派谁。")}
								</p>
								<button type="button" className="engine-wizard-done" onClick={() => goToStep(1)}>
									<span className="engine-wizard-done-mark">✓</span>
									<span>
										{t("目标已就绪")}
									</span>
									<span className="engine-wizard-done-edit">{t("修改")}</span>
								</button>

								<h3 className="engine-wizard-section-title">{t("指挥思路")}</h3>
								<div className="engine-wizard-doc-list">
									{props.doctrines.length === 0 ? (
										<p className="form-hint">{t("还没有可用的指挥思路，请先到「指挥思路」页面创建。")}</p>
									) : (
										props.doctrines.map((doctrine) => {
											const checked = selected.includes(doctrine.id);
											return (
												<label key={doctrine.id} className={`engine-wizard-doc${checked ? " on" : ""}`}>
													<input
														type="checkbox"
														checked={checked}
														onChange={() => {
															setSelected((prev) =>
																prev.includes(doctrine.id)
																	? prev.filter((id) => id !== doctrine.id)
																	: [...prev, doctrine.id],
															);
															setFormError(null);
														}}
													/>
													<span className="engine-wizard-doc-mark" aria-hidden="true">
														{checked ? "✓" : ""}
													</span>
													<span className="engine-wizard-doc-copy">
														<span className="engine-wizard-doc-title">
															<b>{doctrine.name}</b>
															{doctrine.builtin ? (
																<span className="tag tag-queued">{t("内置")}</span>
															) : null}
														</span>
														<span className="engine-wizard-doc-text">
															{doctrine.text.split("\n")[0]}
														</span>
													</span>
												</label>
											);
										})
									)}
								</div>

								<div className="engine-wizard-subhead">
									<b>{t("Agent 白名单")}</b>
									<span>{t("不勾选 = 不限制，可使用全部已启用预设")}</span>
								</div>
								{enabledPresets.length === 0 ? (
									<p className="form-hint">{t("还没有启用的预设 Agent，可到「设置 → 预设 Agent」创建。")}</p>
								) : (
									<div className="engine-wizard-presets">
										{enabledPresets.map((preset) => {
											const checked = selectedPresets.includes(preset.id);
											return (
												<label
													key={preset.id}
													className={`engine-wizard-preset${checked ? " on" : ""}`}
													title={preset.description || undefined}
												>
													<input
														type="checkbox"
														checked={checked}
														onChange={() =>
															setSelectedPresets((prev) =>
																prev.includes(preset.id)
																	? prev.filter((id) => id !== preset.id)
																	: [...prev, preset.id],
															)
														}
													/>
													<span className="engine-wizard-preset-copy">
														<b>{preset.name}</b>
														<span>{preset.description || `${formatUsage(preset.tokens)} tokens`}</span>
													</span>
												</label>
											);
										})}
									</div>
								)}
								<label className="engine-preset-optional">
									<input
										type="checkbox"
										checked={presetOptional}
										onChange={(event) => setPresetOptional(event.target.checked)}
									/>
									<span>{t("允许任务不指定预设，没有合适预设时退回默认 Agent")}</span>
								</label>
							</>
						) : null}

						{step === 3 ? (
							<>
								<div className="engine-wizard-kicker">STEP 03 / LAUNCH</div>
								<h2>{t("安排时间，然后交给指挥官")}</h2>
								<p className="engine-wizard-lead">
									{t("立即启动会先检查环境；定时启动只保存计划，到点再检查并启动。")}
								</p>
								<button type="button" className="engine-wizard-done" onClick={() => goToStep(2)}>
									<span className="engine-wizard-done-mark">✓</span>
									<span>
										{t("指挥已就绪")} · <b>{selected.length}</b> {t("条思路")} · {selectedPresetLabel}
									</span>
									<span className="engine-wizard-done-edit">{t("修改")}</span>
								</button>

								<div className="engine-wizard-subhead">
									<b>{t("启动方式")}</b>
									<span>{t("时区 {timezone}", { timezone: browserTimezone() })}</span>
								</div>
								<div className="mode-switch engine-wizard-mode">
									<button
										type="button"
										className={startMode === "now" ? "on" : ""}
										onClick={() => {
											setStartMode("now");
											setFormError(null);
										}}
									>
										{t("立即启动")}
									</button>
									<button
										type="button"
										className={startMode === "scheduled" ? "on" : ""}
										onClick={() => {
											setStartMode("scheduled");
											setFormError(null);
										}}
									>
										{t("定时启动")}
									</button>
								</div>
								{startMode === "scheduled" ? (
									<div className="engine-wizard-schedule">
										<ScheduleFields
											draft={scheduleDraft}
											onChange={(nextDraft) => {
												setScheduleDraft(nextDraft);
												setFormError(null);
											}}
											timezone={browserTimezone()}
										/>
									</div>
								) : (
									<p className="engine-wizard-mode-hint">{t("保存后立即检查 Docker 环境并启动指挥官。")}</p>
								)}

								<h3 className="engine-wizard-section-title">{t("执行上限")}</h3>
								<div className="limit-grid engine-wizard-limits">
									<div className="form-field">
										<label>{t("最大并发任务")}</label>
										<input
											type="number"
											min={1}
											value={concurrency}
											onChange={(event) => setConcurrency(Number.parseInt(event.target.value, 10) || 0)}
										/>
									</div>
									<div className="form-field">
										<label>{t("单任务最大轮数")}</label>
										<input
											type="number"
											min={1}
											value={roundLimit}
											onChange={(event) => setRoundLimit(Number.parseInt(event.target.value, 10) || 0)}
										/>
									</div>
									<div className="form-field">
										<label>{t("每目标重试次数")}</label>
										<input type="number" min={0} value={maxRetries} onChange={(event) => setMaxRetries(Number.parseInt(event.target.value, 10) || 0)} />
									</div>
									<div className="form-field">
										<label>{t("总 token 上限（可选）")}</label>
										<input type="number" min={0} value={tokenLimit} onChange={(event) => setTokenLimit(event.target.value)} placeholder={t("不限制")} />
									</div>
									<div className="form-field">
										<label>{t("总时间上限 / 分钟（可选）")}</label>
										<input type="number" min={0} value={timeLimitMin} onChange={(event) => setTimeLimitMin(event.target.value)} placeholder={t("不限制")} />
									</div>
								</div>

								<h3 className="engine-wizard-section-title">{t("命令守门")}</h3>
								<div className="engine-wizard-gates">
									<label className={`engine-wizard-gate${gateMode === "auto" ? " on" : ""}`}>
										<input type="radio" checked={gateMode === "auto"} onChange={() => setGateMode("auto")} />
										<span>
											<b>{t("自动执行")}</b>
											<span>{t("worker 的命令直接执行，不做拦截（最快）。")}</span>
										</span>
									</label>
									<label className={`engine-wizard-gate${gateMode === "ai" ? " on" : ""}${!props.judgeAvailable ? " disabled" : ""}`}>
										<input
											type="radio"
											checked={gateMode === "ai"}
											disabled={!props.judgeAvailable}
											onChange={() => setGateMode("ai")}
										/>
										<span>
											<b>{t("AI 裁判")}</b>
											<span>
												{props.judgeAvailable
													? t("每条命令先由守门模型判定，拦截时把理由回给 worker。")
													: t("未配置守门模型：请先到 设置 → 模型 配置守门模型。")}
											</span>
										</span>
									</label>
								</div>

								<div className="engine-wizard-review">
									<div>
										<span>{t("指挥")}</span>
										<b>{t("{count} 条思路", { count: selected.length })}</b>
									</div>
									<div>
										<span>{t("Agent")}</span>
										<b>
											{selectedPresets.length === 0
												? t("不限制")
												: t("{count} 个预设", { count: selectedPresets.length })}
										</b>
									</div>
									<div>
										<span>{t("启动")}</span>
										<b>
											{startMode === "scheduled"
												? scheduleDraft.startAt
													? scheduleDraft.startAt.replace("T", " ")
													: t("待填写")
												: t("立即")}
										</b>
									</div>
								</div>
								<p className="form-hint engine-wizard-launch-hint">
									{t("启动后指挥官全权调度；人保留暂停、终止、追加目标与 steer。手动暂停、继续或终止会停用后续定时计划。")}
								</p>
							</>
						) : null}

						<div className="engine-wizard-footer">
							<button
								type="button"
								className="engine-wizard-back"
								disabled={step === 1}
								onClick={() => goToStep((step - 1) as WizardStep)}
							>
								{t("上一步")}
							</button>
							<button type="button" className="primary" onClick={next}>
								{nextLabel}
							</button>
							<span className="engine-wizard-progress">{step} / 3</span>
						</div>
					</div>
				</div>

				<div className="engine-wizard-tips">
					<div>
						<b>{t("不会提前启动")}</b>
						<span>{t("定时工程只保存计划，到点才检查 Docker 环境。")}</span>
					</div>
					<div>
						<b>{t("失败可以继续")}</b>
						<span>{t("环境或指挥官启动失败会停在暂停态，不会丢配置。")}</span>
					</div>
					<div>
						<b>{t("手动优先")}</b>
						<span>{t("手动暂停、继续或终止会停用后续计划，避免互相抢状态。")}</span>
					</div>
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
					{t("指挥思路")}
					<span className="ws-panel__sub">{t("命名的文本模板，创建工程时多选叠加注入指挥官")}</span>
				</div>
				<div className="ws-panel__actions">
					<button type="button" onClick={props.onClose}>
						{t("返回")}
					</button>
				</div>
			</div>
			<div className="ws-panel__body">
				{props.doctrines.map((doctrine) => (
					<div key={doctrine.id} className="doctrine-row" style={{ marginBottom: 10 }}>
						<div className="doctrine-row__head">
							<strong>{doctrine.name}</strong>
							{doctrine.builtin ? <span className="tag tag-queued">{t("内置")}</span> : null}
							{!doctrine.builtin ? (
								<button
									type="button"
									onClick={() => {
										if (window.confirm(t("删除思路「{name}」？", { name: doctrine.name }))) {
											props.onDelete(doctrine.id);
										}
									}}
								>
									{t("删除")}
								</button>
							) : null}
						</div>
						<pre>{doctrine.text}</pre>
					</div>
				))}
				<div className="doctrine-new">
					<div className="form-field">
						<label>{t("新增思路")}</label>
						<input
							type="text"
							placeholder={t("思路名称")}
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					<div className="form-field">
						<label>{t("思路内容（纯文本，注入指挥官系统指令）")}</label>
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
							{t("保存")}
						</button>
					</div>
				</div>
			</div>
		</>
	);
}
