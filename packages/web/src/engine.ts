/**
 * The engineering-mode orchestrator: engines, commanders, and task scheduling.
 *
 * One engine = one commander (an LLM session with scheduling tools only) plus a
 * task board executed by workers (EngineWorker). The commander never executes
 * anything itself; the engine enforces that by mounting no execution tools on
 * its session at all. Tasks run unattended inside the project container, one
 * worker session per task, bounded by per-engine concurrency plus a global cap
 * so several engines cannot crush the container together.
 *
 * Persistence: everything lives in the engine store (SQLite). A service
 * restart marks in-flight tasks paused and pauses their engines; resuming an
 * engine reopens the commander with a board recap and the paused workers with
 * their session files, so no objective is lost.
 */

import { resolve as resolvePath } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	type BashOperations,
	createAgentSession,
	createBashTool,
	createReadTool,
	DefaultResourceLoader,
	getDefaultSessionDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type CommanderPort, createCommanderTools, formatTaskBoard, retryDecision } from "./commander-tools.ts";
import { containerWorkPath, dockerBashOperations } from "./docker.ts";
import { listDoctrines, resolveDoctrines, type ZGDoctrine } from "./doctrines.ts";
import { EngineStore } from "./engine-store.ts";
import { resolveJudgeEndpoint } from "./gatekeeper.ts";
import { modelsJsonPath, readCommanderModelConfig, ZG_COMMANDER_PROVIDER_ID } from "./model-config.ts";
import { resolveLibraryRole } from "./model-library.ts";
import { sendDingTalk } from "./notify.ts";
import { readNotifyConfig } from "./notify-config.ts";
import { readPermissionsConfig } from "./permissions.ts";
import { findPreset, listEnabledPresets, listPresets, presetBriefLines } from "./presets.ts";
import { listProjects } from "./projects.ts";
import type {
	ZGEngine,
	ZGEngineCreateInput,
	ZGEngineEvent,
	ZGEngineGateMode,
	ZGGoalUsage,
	ZGPreset,
	ZGProjectInfo,
} from "./protocol.ts";
import {
	EngineWorker,
	errorText,
	parseTargetLines,
	WORKER_APPEND_PROMPT,
	type AcquireTaskSession as WorkerAcquire,
	type WorkerOutcome,
	type WorkerSession,
} from "./worker.ts";
import type { TaskSessionOptions } from "./zg-session.ts";

type LiveSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

/** Total tasks running across all engines at once; protects the shared container. */
const GLOBAL_TASK_CONCURRENCY = 8;
/** Nudges before an idle commander with an empty board gives up as failed. */
const MAX_COMMANDER_NUDGES = 3;

/**
 * Commander execution guardrails. The commander gets bash and read so it can
 * scope and decompose targets (is this a web box? which hosts look alike?),
 * but it must stay a commander:
 *
 * - a per-engine command budget: reconnaissance in service of dispatching, not
 *   a work substitute — once spent, every further command is refused and the
 *   refusal says to dispatch instead;
 * - a hard per-command timeout: quick lookups only, no hour-long scans;
 * - an output cap, so one verbose command cannot eat the context window;
 * - a destructive-command denylist, defense in depth under the budget.
 */
const COMMANDER_BASH_BUDGET = 40;
const COMMANDER_BASH_TIMEOUT_MS = 20_000;
const COMMANDER_BASH_OUTPUT_CAP = 16 * 1024;
const COMMANDER_BASH_DENYLIST: RegExp[] = [
	/\brm\b/,
	/\bdd\b/,
	/\bmkfs/,
	/\bshutdown\b/,
	/\breboot\b/,
	/\bhalt\b/,
	/\bpoweroff\b/,
	/\bchmod\b/,
	/\bchown\b/,
	/:\(\)\s*\{/,
];

export interface EngineHooks {
	/** An engine's stored state changed; consoles refresh the board. */
	onChange(engine: ZGEngine): void;
	/** One commander decision-log step, live. */
	onCommanderEvent(engineId: string, event: ZGEngineEvent): void;
	/** One worker process step, live. */
	onTaskEvent(taskId: string, event: ZGEngineEvent): void;
}

/**
 * What the engine asks the host runtime for when a task needs its session
 * (ZGAgentRuntime.acquireTaskSession). The runtime creates the session in the
 * project's normal session directory, so the task conversation is a
 * first-class citizen of the 对话 list.
 */
export type RuntimeAcquireTaskSession = (
	options: TaskSessionOptions,
) => Promise<{ session: WorkerSession; manager: SessionManager }>;

interface EngineLive {
	engine: ZGEngine;
	commander?: LiveSession;
	commanderUnsubscribe: () => void;
	workers: Map<string, EngineWorker>;
	commanderSeq: number;
	taskSeq: Map<string, number>;
	/** Operator/summ texts waiting for the commander to be free. */
	pendingCommanderPrompts: string[];
	commanderPromptInFlight: boolean;
	nudges: number;
	reportSettled: boolean;
	/** How many bash commands this commander has spent of its budget. */
	bash: { used: number };
}

export class EngineManager {
	private readonly agentDir: string;
	private readonly store: EngineStore;
	private readonly hooks: EngineHooks;
	private readonly acquireTaskSession: RuntimeAcquireTaskSession;
	private readonly live = new Map<string, EngineLive>();
	private modelRuntime: ModelRuntime | undefined;
	private modelRuntimePromise: Promise<ModelRuntime> | undefined;
	/**
	 * Set by `dispose()`. A session broadcast that was already in flight resumes
	 * after the store is closed, and reading it then throws out of a promise
	 * nobody is left to catch. Those late reads answer empty instead.
	 */
	private disposed = false;

	constructor(agentDir: string, hooks: EngineHooks, acquireTaskSession: RuntimeAcquireTaskSession) {
		this.agentDir = agentDir;
		this.store = new EngineStore(`${agentDir}/engines.db`);
		this.hooks = hooks;
		this.acquireTaskSession = acquireTaskSession;
		// A previous process left running tasks behind: nothing of them is live any
		// more, so they come back paused and their engines wait for a resume.
		this.store.interruptRunning();
		for (const engine of this.store.listEngines()) {
			if (engine.status === "running") {
				this.store.setEngineStatus(engine.id, "paused", "服务重启，任务已暂停；点「继续」恢复", null);
				this.live.set(engine.id, this.emptyLive(this.store.getEngine(engine.id) ?? engine));
			} else {
				this.live.set(engine.id, this.emptyLive(engine));
			}
		}
	}

	listEngines(projectId?: string): ZGEngine[] {
		if (this.disposed) return [];
		return this.store.listEngines(projectId).map((engine) => this.withLiveCounters(engine));
	}

	getEngine(id: string): ZGEngine | undefined {
		if (this.disposed) return undefined;
		const engine = this.store.getEngine(id);
		return engine ? this.withLiveCounters(engine) : undefined;
	}

	commanderEvents(engineId: string): ZGEngineEvent[] {
		return this.store.listEvents(engineId);
	}

	taskEvents(taskId: string): ZGEngineEvent[] {
		return this.store.listEvents(taskId);
	}

	/**
	 * sessionId → engine/task for every task that owns a session, so the
	 * session list can badge engineering conversations. Live tasks of any
	 * engine are included, finished ones too (their conversations persist).
	 */
	taskSessionIndex(): Map<string, { engineId: string; engineName: string; taskStatus: string }> {
		const index = new Map<string, { engineId: string; engineName: string; taskStatus: string }>();
		if (this.disposed) return index;
		for (const engine of this.store.listEngines()) {
			for (const task of engine.tasks) {
				if (task.sessionId) {
					index.set(task.sessionId, {
						engineId: engine.id,
						engineName: engine.name,
						taskStatus: task.status,
					});
				}
			}
		}
		return index;
	}

	/** Doctrine list for the create form. */
	doctrines(): ZGDoctrine[] {
		return listDoctrines(this.agentDir);
	}

	/**
	 * Presets the commander of this engine may actually dispatch with: its
	 * whitelist when it has one, every enabled preset otherwise. Disabled presets
	 * are never offered, because a dispatch naming one is refused — the list and
	 * the refusal have to agree or the commander would keep retrying a lost cause.
	 */
	private commanderPresets(engine: ZGEngine): ZGPreset[] {
		return allowedPresets(this.agentDir, engine);
	}

	/**
	 * Create an engine and start its commander. The project must have a usable
	 * container; the caller (server) checks the environment before this.
	 */
	async createEngine(project: ZGProjectInfo, input: ZGEngineCreateInput): Promise<ZGEngine> {
		const name = input.name.trim();
		if (!name) throw new Error("工程名称不能为空");
		const targets = parseTargetLines(input.targets);
		if (targets.length === 0) throw new Error("目标列表不能为空（一行一个目标，可带备注）");
		const limits = normalizeLimits(input.limits);
		const doctrines = resolveDoctrines(this.agentDir, input.doctrines);
		if (doctrines.length === 0) throw new Error("请至少选择一个指挥思路");
		// An engine that judges its commands needs somewhere to send them; refusing
		// here beats creating an engine whose gate silently fails open on every task.
		const gateMode: ZGEngineGateMode = input.gateMode === "ai" ? "ai" : "auto";
		if (gateMode === "ai" && !this.judgeAvailable()) {
			throw new Error(
				"未配置守门模型：请在 设置 → 模型 给「守门模型」选一条模型（或让它跟随主模型）后再选「AI 裁判」",
			);
		}
		const stored = this.store.createEngine({
			projectId: project.id,
			projectName: project.name,
			name,
			targets,
			doctrines: doctrines.map((doctrine) => doctrine.id),
			presetIds: this.normalizePresetIds(input.presetIds),
			presetOptional: input.presetOptional,
			limits,
			gateMode,
		});
		const entry = this.emptyLive(stored);
		this.live.set(stored.id, entry);
		await this.startCommander(entry, "initial");
		this.hooks.onChange(this.getEngine(stored.id) ?? stored);
		return this.getEngine(stored.id) ?? stored;
	}

	/** Operator pause: stop dispatching, abort running tasks, keep everything for resume. */
	async pauseEngine(id: string): Promise<void> {
		const entry = this.live.get(id);
		if (!entry) throw new Error("工程不存在");
		if (entry.engine.status !== "running") throw new Error("只有运行中的工程才能暂停");
		await this.stopWorkers(entry, "paused", "工程已暂停");
		this.store.setEngineStatus(id, "paused", "操作员暂停", null);
		entry.engine = this.store.getEngine(id) ?? entry.engine;
		this.hooks.onChange(entry.engine);
	}

	/** Resume a paused engine: reopen the commander with a board recap, revive paused tasks. */
	async resumeEngine(id: string): Promise<void> {
		const entry = this.live.get(id);
		if (!entry) throw new Error("工程不存在");
		if (entry.engine.status !== "paused") throw new Error("只有已暂停的工程才能继续");
		this.store.setEngineStatus(id, "running", null, null);
		entry.engine = this.store.getEngine(id) ?? entry.engine;
		entry.nudges = 0;
		await this.startCommander(entry, "resume");
		this.tick();
		this.hooks.onChange(this.getEngine(id) ?? entry.engine);
	}

	/** Stop for good: abort everything; the report stays whatever it was. */
	async abortEngine(id: string): Promise<void> {
		const entry = this.live.get(id);
		if (!entry) throw new Error("工程不存在");
		await this.stopWorkers(entry, "aborted", "工程已终止");
		this.store.setEngineStatus(id, "stopped", "操作员终止", Date.now());
		entry.engine = this.store.getEngine(id) ?? entry.engine;
		this.hooks.onChange(entry.engine);
	}

	async deleteEngine(id: string): Promise<void> {
		const entry = this.live.get(id);
		if (!entry) throw new Error("工程不存在");
		if (entry.engine.status === "running" || entry.engine.status === "paused") {
			if (entry.engine.status === "running") await this.stopWorkers(entry, "aborted", "工程已删除");
		}
		entry.commanderUnsubscribe();
		entry.commander?.dispose();
		this.live.delete(id);
		this.store.deleteEngine(id);
	}

	/**
	 * Change how this engine's workers are gated.
	 *
	 * Refused while a task is running or queued: each task session captures its
	 * gate when it is created, so saving mid-flight would leave the board showing
	 * one mode while half the workers used another.
	 */
	setGateMode(id: string, gateMode: ZGEngineGateMode): void {
		const entry = this.live.get(id);
		if (!entry) throw new Error("工程不存在");
		if (entry.engine.gateMode === gateMode) return;
		const busy = entry.engine.tasks.some((task) => task.status === "running" || task.status === "queued");
		if (busy) throw new Error("有任务正在运行或排队，请先暂停工程并等任务结束再修改");
		if (gateMode === "ai" && !this.judgeAvailable()) {
			throw new Error(
				"未配置守门模型：请在 设置 → 模型 给「守门模型」选一条模型（或让它跟随主模型）后再选「AI 裁判」",
			);
		}
		this.store.setEngineGateMode(id, gateMode);
		entry.engine = this.store.getEngine(id) ?? entry.engine;
		this.hooks.onChange(entry.engine);
	}

	/** Whether a judge endpoint resolves at all, so `ai` is a choice that can work. */
	judgeAvailable(): boolean {
		return resolveJudgeEndpoint(this.agentDir).config !== null;
	}

	/**
	 * Keep only ids that name an existing preset, dropping duplicates. A whitelist
	 * entry that no longer resolves would silently restrict nothing while looking
	 * like a restriction, and the operator cannot see the stale id in the picker
	 * they chose it from.
	 */
	private normalizePresetIds(ids: readonly string[] | undefined): string[] {
		return normalizePresetIds(this.agentDir, ids);
	}

	/**
	 * Replace this engine's preset whitelist. An empty list clears the restriction.
	 *
	 * Unlike the gate mode this is allowed mid-run: a task captures its preset when
	 * it is created and its session file carries the choice, so narrowing the list
	 * affects the next dispatch and leaves running tasks exactly as they were.
	 */
	setPresets(id: string, presetIds: string[]): void {
		const entry = this.live.get(id);
		if (!entry) throw new Error("工程不存在");
		this.store.setEnginePresets(id, this.normalizePresetIds(presetIds));
		entry.engine = this.store.getEngine(id) ?? entry.engine;
		this.hooks.onChange(entry.engine);
	}

	/**
	 * Whether this engine's tasks may run without a preset. Like the whitelist this
	 * is allowed mid-run: it applies to the next dispatch, and a task already
	 * created keeps the preset it captured.
	 */
	setPresetOptional(id: string, optional: boolean): void {
		const entry = this.live.get(id);
		if (!entry) throw new Error("工程不存在");
		this.store.setEnginePresetOptional(id, optional);
		entry.engine = this.store.getEngine(id) ?? entry.engine;
		this.hooks.onChange(entry.engine);
	}

	/** Add targets mid-run; the commander learns about them through its next prompt. */
	addTargets(id: string, targetsText: string): void {
		const entry = this.live.get(id);
		if (!entry) throw new Error("工程不存在");
		const targets = parseTargetLines(targetsText);
		if (targets.length === 0) throw new Error("追加的目标列表为空");
		this.store.addTargets(id, targets);
		entry.engine = this.store.getEngine(id) ?? entry.engine;
		void this.promptCommander(
			entry,
			`操作员追加了 ${targets.length} 个目标，请把它们纳入编排：\n${targets
				.map((target) => `- ${target.target}${target.note ? `（${target.note}）` : ""}`)
				.join("\n")}`,
		);
		this.hooks.onChange(entry.engine);
	}

	/** Operator steer: deliver an instruction to the commander mid-run. */
	async steerCommander(id: string, text: string): Promise<void> {
		const entry = this.live.get(id);
		if (!entry) throw new Error("工程不存在");
		if (entry.engine.status !== "running") throw new Error("只有运行中的工程才能给指挥官追加指令");
		const trimmed = text.trim();
		if (!trimmed) throw new Error("追加指令不能为空");
		await this.promptCommander(entry, `操作员指令：${trimmed}`);
	}

	/**
	 * Abort one task (operator or commander). Never throws: an unknown id is
	 * model input — the caller gets a result it can show instead, and an
	 * exception here would take the whole console down.
	 */
	async abortTask(taskId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
		const task = this.store.getTask(taskId);
		if (!task) return { ok: false, error: `任务 ${taskId} 不存在（可能已完成、已删除或 id 有误）` };
		const entry = this.live.get(task.engineId);
		if (!entry) return { ok: false, error: "任务所属工程不存在" };
		if (task.status === "queued") {
			this.store.updateTask(taskId, { status: "aborted", endedAt: Date.now(), error: reason });
			entry.engine = this.store.getEngine(entry.engine.id) ?? entry.engine;
			this.hooks.onChange(entry.engine);
			return { ok: true };
		}
		const worker = entry.workers.get(taskId);
		if (!worker) return { ok: false, error: `任务 ${taskId} 不在运行中（当前状态：${task.status}）` };
		await worker.abort(`中止：${reason}`);
		return { ok: true };
	}

	/** Deterministic progress snapshot the operator can pull at any time. */
	reportSnapshot(id: string): { filename: string; markdown: string } {
		const engine = this.store.getEngine(id);
		if (!engine) throw new Error("工程不存在");
		return buildSnapshotReport(engine);
	}

	/**
	 * The session-file path of one task, so the console can switch the chat
	 * view to it. Fails when the task or its session does not exist.
	 */
	taskSessionPath(taskId: string): string {
		const task = this.store.getTask(taskId);
		if (!task || !task.sessionId) throw new Error("该任务没有会话（可能尚未启动或已被删除）");
		const engine = this.store.getEngine(task.engineId);
		if (!engine) throw new Error("任务所属工程不存在");
		const project = this.projectOf(engine);
		const sessionDir = getDefaultSessionDir(project.cwd, this.agentDir);
		// Task rows keep the session id, but a session file is named
		// `<timestamp>_<sessionId>.jsonl`: the id alone is not a path, so resolve it
		// exactly the way the session list does.
		const file = SessionManager.findById(project.cwd, task.sessionId, sessionDir);
		if (!file) throw new Error("该任务的会话文件不存在（可能已被删除）");
		return resolvePath(file);
	}

	/** Project deletion cascades: abort and delete its engines with their tasks. */
	async purgeProject(projectId: string): Promise<number> {
		let removed = 0;
		for (const engine of this.store.listEngines(projectId)) {
			await this.deleteEngine(engine.id);
			removed += 1;
		}
		return removed;
	}

	dispose(): void {
		for (const entry of this.live.values()) {
			for (const worker of entry.workers.values()) worker.dispose();
			entry.commanderUnsubscribe();
			entry.commander?.dispose();
		}
		this.live.clear();
		this.disposed = true;
		this.store.close();
	}

	// --- commander ---------------------------------------------------------

	private commanderPort(entry: EngineLive): CommanderPort {
		return {
			presetOptional: entry.engine.presetOptional,
			dispatch: (input) => {
				if (entry.engine.status !== "running") return { error: "工程已暂停或结束，不能派发任务" };
				// The preset is validated here rather than left to the session. A task
				// dispatched with an unusable preset would otherwise run as the default
				// agent while the board showed the name the commander asked for, and the
				// commander would never learn its choice was ignored. Refusing with the
				// available list lets the next round correct itself, which is how an
				// unknown task id is already handled.
				const choice = resolveDispatchPreset(this.agentDir, entry.engine, input.presetId);
				if (choice.error) return { error: choice.error };
				const preset = choice.preset;
				const target = input.target;
				const priorForTarget = target ? entry.engine.tasks.filter((task) => task.target === target) : [];
				const retry = retryDecision(priorForTarget, entry.engine.limits.maxRetries, target ?? "");
				if (target && !retry.allowed) return { error: retry.error };
				const roundLimit = input.roundLimit ?? entry.engine.limits.roundLimit;
				const task = this.store.createTask({
					engineId: entry.engine.id,
					title: input.title,
					objective: input.objective,
					target,
					workspace: workspaceSlug(input.title, retry.attempt),
					roundLimit,
					attempt: retry.attempt,
					criteria: input.criteria,
					presetId: preset?.id ?? null,
					// Copied in, not resolved on read: the board must still say what a
					// finished task ran as after the preset is renamed or deleted.
					presetName: preset?.name ?? null,
				});
				entry.engine = this.store.getEngine(entry.engine.id) ?? entry.engine;
				this.hooks.onChange(entry.engine);
				// The scheduler may start it right away.
				this.tick();
				const position = entry.engine.tasks.filter((item) => item.status === "queued").length;
				return { task, position };
			},
			abortTask: async (taskId, reason) => {
				try {
					return await this.abortTask(taskId, `指挥官中止：${reason}`);
				} catch (error) {
					return { ok: false, error: errorText(error) };
				}
			},
			steerTask: async (taskId, instruction) => {
				const worker = entry.workers.get(taskId);
				if (!worker || !worker.isRunning) return { ok: false, error: "任务不在运行中，无法注入指令" };
				try {
					const delivered = await worker.steer(instruction);
					return delivered ? { ok: true } : { ok: false, error: "指令未能注入（任务刚好结束）" };
				} catch (error) {
					return { ok: false, error: errorText(error) };
				}
			},
			board: () => this.store.getEngine(entry.engine.id)?.tasks ?? entry.engine.tasks,
			finish: (report) => {
				const board = this.store.getEngine(entry.engine.id)?.tasks ?? [];
				const outstanding = board.filter((task) => task.status === "queued" || task.status === "running");
				if (outstanding.length > 0) {
					return {
						ok: false,
						error: `还有 ${outstanding.length} 个任务未结束（排队或运行中），先等它们结束或用 abort_task 中止`,
					};
				}
				this.store.setEngineReport(entry.engine.id, report);
				this.store.setEngineStatus(entry.engine.id, "completed", null, Date.now());
				entry.engine = this.store.getEngine(entry.engine.id) ?? entry.engine;
				entry.reportSettled = true;
				this.hooks.onChange(entry.engine);
				this.notifyEngineDone(entry.engine);
				return { ok: true };
			},
		};
	}

	/**
	 * Bash for the commander: the project container with the guardrails from
	 * the module header. Runs from /work (the commander is not scoped to one
	 * task workspace) and every refusal is phrased to push it back to dispatch.
	 */
	private commanderBash(entry: EngineLive): BashOperations {
		const inner = dockerBashOperations(this.commanderContainerOf(entry));
		const state = entry.bash;
		return {
			exec: (command, _cwd, options) => {
				if (COMMANDER_BASH_DENYLIST.some((pattern) => pattern.test(command))) {
					return Promise.reject(
						new Error("指挥官不能执行破坏性或修改类命令；这类操作属于任务，请用 dispatch_task 派发。"),
					);
				}
				state.used += 1;
				if (state.used > COMMANDER_BASH_BUDGET) {
					return Promise.reject(
						new Error(
							`指挥官命令预算已用完（${COMMANDER_BASH_BUDGET} 条）。侦察预算是为了拆解任务，不是为了代替执行——请直接派发任务。`,
						),
					);
				}
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), COMMANDER_BASH_TIMEOUT_MS);
				let received = 0;
				let capped = false;
				options?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
				return inner
					.exec(command, containerWorkPath("/work", "/work"), {
						...options,
						signal: controller.signal,
						onData: (chunk: Buffer) => {
							if (received < COMMANDER_BASH_OUTPUT_CAP) {
								received += chunk.byteLength;
								options?.onData(chunk);
							} else if (!capped) {
								capped = true;
								options?.onData(Buffer.from("\n…（指挥官命令输出已截断）"));
							}
						},
					})
					.finally(() => clearTimeout(timer));
			},
		};
	}

	/** Build (or rebuild) the commander session and give it its opening brief. */
	private async startCommander(entry: EngineLive, kind: "initial" | "resume"): Promise<void> {
		if (entry.commander) {
			entry.commanderUnsubscribe();
			entry.commander.dispose();
			entry.commander = undefined;
		}
		const project = this.projectOf(entry.engine);
		const model = await this.resolveCommanderModel();
		if (!model) throw new Error("指挥官模型未配置：请先在「设置 → 模型」配置端点，或在工程页配置指挥官专用端点");
		const commanderPermissions = readPermissionsConfig(this.agentDir).commander;
		const brief = buildCommanderBrief(
			entry.engine,
			this.doctrines(),
			this.commanderPresets(entry.engine),
			kind,
			commanderPermissions,
		);
		const resourceLoader = new DefaultResourceLoader({
			cwd: project.cwd,
			agentDir: this.agentDir,
			// The commander gets no extensions: it must not reach the container.
			appendSystemPrompt: [brief],
		});
		await resourceLoader.reload();
		const created = await createAgentSession({
			cwd: project.cwd,
			agentDir: this.agentDir,
			modelRuntime: await this.ensureModelRuntime(),
			model,
			sessionManager: SessionManager.inMemory(project.cwd),
			resourceLoader,
			settingsManager: SettingsManager.create(project.cwd, this.agentDir),
			// The fenced bash and the project-scoped read exist only so the
			// commander can scope targets before decomposing them, and only when
			// the operator's permission switches allow it. No edit, no write:
			// changing anything is work, and work is dispatched.
			baseToolsOverride: {
				...(commanderPermissions.bash
					? { bash: createBashTool(project.cwd, { operations: this.commanderBash(entry) }) }
					: {}),
				...(commanderPermissions.read ? { read: createReadTool(project.cwd) } : {}),
			},
			customTools: createCommanderTools(this.commanderPort(entry)),
		});
		entry.commander = created.session;
		entry.commanderUnsubscribe = created.session.subscribe((event) => this.onCommanderEvent(entry, event));
		await created.session.bindExtensions({});
		this.pushCommanderEvent(entry, {
			kind: "status",
			status: "running",
			note: kind === "initial" ? "指挥官启动" : "指挥官恢复",
		});
		await this.promptCommander(
			entry,
			kind === "initial"
				? `工程「${entry.engine.name}」已启动。目标清单与指挥思路见你的系统指令。请开始编排：先用 list_tasks 确认看板为空，然后按思路派发第一批任务。`
				: `工程已恢复运行。当前看板：\n${formatTaskBoard(this.store.getEngine(entry.engine.id)?.tasks ?? [])}\n\n请决定下一步：继续派发、处理未完成任务，或（若全部结束）用 engine_done 收尾。`,
		);
	}

	/**
	 * Deliver one message to the commander. Prompts are serialized: a message
	 * that arrives while the commander is thinking is queued and flushed when it
	 * settles, so summaries never interleave inside one turn.
	 */
	private async promptCommander(entry: EngineLive, text: string): Promise<void> {
		entry.pendingCommanderPrompts.push(text);
		if (entry.commanderPromptInFlight) return;
		entry.commanderPromptInFlight = true;
		try {
			while (entry.pendingCommanderPrompts.length > 0) {
				const next = entry.pendingCommanderPrompts.join("\n\n");
				entry.pendingCommanderPrompts = [];
				if (!entry.commander || entry.reportSettled) break;
				await entry.commander.prompt(next, {});
			}
		} catch (error) {
			this.pushCommanderEvent(entry, {
				kind: "status",
				status: "error",
				note: `指挥官运行失败：${errorText(error)}`,
			});
		} finally {
			entry.commanderPromptInFlight = false;
		}
		this.afterCommanderSettled(entry);
	}

	private onCommanderEvent(entry: EngineLive, event: AgentSessionEvent): void {
		if (event.type === "message_end") {
			if ((event.message as { role?: string }).role !== "assistant") return;
			for (const block of messageBlocks(event.message)) {
				if (block.type === "text" && block.text?.trim())
					this.pushCommanderEvent(entry, { kind: "text", text: block.text });
				else if (block.type === "thinking" && block.thinking?.trim())
					this.pushCommanderEvent(entry, { kind: "thinking", text: block.thinking });
			}
		} else if (event.type === "tool_execution_start") {
			this.pushCommanderEvent(entry, {
				kind: "tool_start",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				args: event.args,
			});
		} else if (event.type === "tool_execution_end") {
			this.pushCommanderEvent(entry, {
				kind: "tool_end",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				isError: event.isError,
				output: toolResultText(event.result),
			});
		}
	}

	/**
	 * After the commander's turn: if work is outstanding, wait for task events;
	 * if the board is empty and the engine is not finished, nudge it to either
	 * dispatch or close, up to a bound.
	 */
	private afterCommanderSettled(entry: EngineLive): void {
		if (entry.reportSettled || entry.pendingCommanderPrompts.length > 0) return;
		if (entry.engine.status !== "running") return;
		const board = this.store.getEngine(entry.engine.id)?.tasks ?? [];
		const outstanding = board.filter((task) => task.status === "queued" || task.status === "running");
		if (outstanding.length > 0) return;
		if (entry.nudges >= MAX_COMMANDER_NUDGES) {
			this.store.setEngineStatus(entry.engine.id, "paused", "指挥官多次空转，工程已暂停等待操作员", null);
			entry.engine = this.store.getEngine(entry.engine.id) ?? entry.engine;
			this.hooks.onChange(entry.engine);
			return;
		}
		entry.nudges += 1;
		void this.promptCommander(
			entry,
			`当前没有排队或运行中的任务。请用 engine_done 提交总报告结束工程；若还有目标没有处理，用 dispatch_task 继续派发。不要只是回复文字——没有工具调用，工程不会前进。`,
		);
	}

	// --- workers & scheduling ----------------------------------------------

	private tick(): void {
		for (const entry of this.live.values()) {
			if (entry.engine.status !== "running") continue;
			const board = this.store.getEngine(entry.engine.id)?.tasks ?? entry.engine.tasks;
			const running = board.filter((task) => task.status === "running").length;
			let slots = Math.min(entry.engine.limits.concurrency - running, this.globalSlots());
			for (const task of board) {
				if (slots <= 0) break;
				if (task.status !== "queued") continue;
				void this.startTask(entry, task.id).catch((error: unknown) => {
					console.error(`[zg-engine] 任务 ${task.id} 启动失败：`, error);
				});
				slots -= 1;
			}
		}
	}

	private globalSlots(): number {
		let running = 0;
		for (const entry of this.live.values()) {
			running += [...entry.workers.values()].filter((worker) => worker.isRunning).length;
		}
		return GLOBAL_TASK_CONCURRENCY - running;
	}

	private async startTask(entry: EngineLive, taskId: string): Promise<void> {
		const task = this.store.getTask(taskId);
		if (!task || task.status !== "queued") return;
		const project = this.projectOf(entry.engine);
		const acquire: WorkerAcquire = (input) =>
			this.acquireTaskSession({
				taskTitle: task.title,
				appendPrompt: WORKER_APPEND_PROMPT,
				// The task's own preset, fixed at dispatch. A task resumed after a
				// restart reopens its session file, which already carries the choice.
				presetId: task.presetId,
				project: { id: project.id, name: project.name, container: project.container ?? "", cwd: project.cwd },
				// Read from the engine per task, so a mode changed while the engine was
				// paused applies to the tasks started after it resumes.
				gateMode: entry.engine.gateMode,
				...input,
			});
		const worker = new EngineWorker(
			task,
			acquire,
			{
				onStarted: (sessionId) => {
					// Recorded as soon as the session exists, so a crash or restart
					// mid-run can still find and resume the conversation file.
					this.store.updateTask(taskId, { sessionId });
				},
				onEvent: (event) => {
					const seq = (entry.taskSeq.get(taskId) ?? 0) + 1;
					entry.taskSeq.set(taskId, seq);
					const withSeq = { ...event, seq } as ZGEngineEvent;
					this.store.appendEvent(taskId, withSeq);
					this.hooks.onTaskEvent(taskId, withSeq);
				},
				onProgress: () => {
					const workerRef = entry.workers.get(taskId);
					if (!workerRef) return;
					this.store.updateTask(taskId, {
						usage: workerRef.currentUsage(),
					});
					entry.engine = this.store.getEngine(entry.engine.id) ?? entry.engine;
					this.hooks.onChange(entry.engine);
				},
				onSettled: (outcome) => {
					entry.workers.delete(taskId);
					workerRefDispose(worker);
					this.store.updateTask(taskId, {
						status: outcome.status,
						endedAt: Date.now(),
						summary: outcome.summary,
						usage: outcome.usage,
						error: outcome.status === "failed" || outcome.status === "aborted" ? outcome.summary : null,
					});
					entry.engine = this.store.getEngine(entry.engine.id) ?? entry.engine;
					this.hooks.onChange(entry.engine);
					this.onTaskTerminal(entry, taskId, outcome);
				},
			},
			{
				tokenLimit: entry.engine.limits.tokenLimit,
				timeLimitMin: entry.engine.limits.timeLimitMin,
			},
		);
		entry.workers.set(taskId, worker);
		this.store.updateTask(taskId, { status: "running", startedAt: Date.now() });
		entry.engine = this.store.getEngine(entry.engine.id) ?? entry.engine;
		this.hooks.onChange(entry.engine);
		try {
			await worker.start();
			// The session exists now; record its id for the resume path.
			this.store.updateTask(taskId, { sessionId: worker.sessionId });
		} catch (error) {
			entry.workers.delete(taskId);
			worker.dispose();
			this.store.updateTask(taskId, {
				status: "failed",
				endedAt: Date.now(),
				error: `任务启动失败：${errorText(error)}`,
				summary: `任务启动失败：${errorText(error)}`,
			});
			entry.engine = this.store.getEngine(entry.engine.id) ?? entry.engine;
			this.hooks.onChange(entry.engine);
			this.onTaskTerminal(entry, taskId, {
				status: "failed",
				summary: `任务启动失败：${errorText(error)}`,
				usage: emptyUsage(),
			});
		}
	}

	/** A task reached a terminal state: tell the commander and fill the freed slot. */
	private onTaskTerminal(entry: EngineLive, taskId: string, outcome: WorkerOutcome): void {
		if (entry.engine.status !== "running") return;
		const task = this.store.getTask(taskId);
		const label =
			outcome.status === "done"
				? "已完成"
				: outcome.status === "failed"
					? "失败"
					: outcome.status === "blocked"
						? "已阻塞"
						: "已中止";
		void this.promptCommander(
			entry,
			`任务 ${taskId}「${task?.title ?? "?"}」结束（${label}）。\n结论：${outcome.summary}\n请根据结果决定下一步（继续派发、换思路重试、注入情报或收尾）。`,
		);
		this.tick();
	}

	private async stopWorkers(entry: EngineLive, status: "paused" | "aborted", note: string): Promise<void> {
		for (const [taskId, worker] of [...entry.workers]) {
			await worker.abort(note);
			entry.workers.delete(taskId);
			worker.dispose();
			this.store.updateTask(taskId, { status, endedAt: Date.now(), error: note, summary: note });
		}
		entry.engine = this.store.getEngine(entry.engine.id) ?? entry.engine;
	}

	// --- helpers -----------------------------------------------------------

	private emptyLive(engine: ZGEngine): EngineLive {
		return {
			engine,
			commanderUnsubscribe: () => {},
			workers: new Map(),
			commanderSeq: this.store.listEvents(engine.id).length,
			taskSeq: new Map(),
			pendingCommanderPrompts: [],
			commanderPromptInFlight: false,
			nudges: 0,
			reportSettled: engine.status === "completed",
			bash: { used: 0 },
		};
	}

	private pushCommanderEvent(entry: EngineLive, step: Omit<ZGEngineEvent, "seq" | "at">): void {
		entry.commanderSeq += 1;
		const event = { ...step, seq: entry.commanderSeq, at: Date.now() };
		this.store.appendEvent(entry.engine.id, event);
		this.hooks.onCommanderEvent(entry.engine.id, event);
	}

	private withLiveCounters(engine: ZGEngine): ZGEngine {
		// The store already holds everything the board shows; live counters would
		// duplicate it. Kept as the single shaping point for future live fields.
		return engine;
	}

	private commanderContainerOf(entry: EngineLive): string {
		return this.projectOf(entry.engine).container ?? "";
	}

	private projectOf(engine: ZGEngine): ZGProjectInfo {
		const project = listProjects(this.agentDir).projects.find((item) => item.id === engine.projectId);
		if (!project) throw new Error(`工程所属项目「${engine.projectName}」已不存在，无法继续执行`);
		return { id: project.id, name: project.name, cwd: project.workDir, container: project.container };
	}

	/** The shared runtime, created on first use; concurrent callers await one creation. */
	private async ensureModelRuntime(): Promise<ModelRuntime> {
		if (this.modelRuntime) return this.modelRuntime;
		if (!this.modelRuntimePromise) {
			this.modelRuntimePromise = ModelRuntime.create({
				authPath: `${this.agentDir}/auth.json`,
				modelsPath: modelsJsonPath(this.agentDir),
			});
		}
		this.modelRuntime = await this.modelRuntimePromise;
		return this.modelRuntime;
	}

	private async resolveCommanderModel(): Promise<Model<any> | undefined> {
		// The commander keeps its own slot (configured in the engine page); when it
		// is unset the engine runs on whatever 主模型 points at.
		const own = readCommanderModelConfig(this.agentDir);
		const main = resolveLibraryRole(this.agentDir, "main");
		const config = own ?? main?.config;
		if (!config) return undefined;
		const runtime = await this.ensureModelRuntime();
		return runtime.getModel(own ? ZG_COMMANDER_PROVIDER_ID : (main?.entryId ?? ""), config.modelId);
	}

	private notifyEngineDone(engine: ZGEngine): void {
		const config = readNotifyConfig(this.agentDir);
		if (!config.enabled || !config.webhook.trim()) return;
		const done = engine.tasks.filter((task) => task.status === "done").length;
		const failed = engine.tasks.filter((task) => ["failed", "blocked", "aborted"].includes(task.status)).length;
		const markdown = [
			`### 工程已完成：${engine.name}`,
			`- 项目：${engine.projectName}`,
			`- 任务：完成 ${done}，未成 ${failed}`,
			`- 耗时：${Math.round(((engine.endedAt ?? Date.now()) - engine.createdAt) / 60000)} 分钟`,
			"",
			engine.report?.slice(0, config.summaryLimit || 2000) ?? "",
		].join("\n");
		void sendDingTalk(config, `工程已完成：${engine.name}`, markdown);
	}
}

// --- module helpers ---------------------------------------------------------

function workerRefDispose(worker: EngineWorker): void {
	// Disposal happens after the store caught up so the last events survive.
	setTimeout(() => worker.dispose(), 1000);
}

function normalizeLimits(limits: ZGEngineCreateInput["limits"]): ZGEngineCreateInput["limits"] {
	const concurrency = Math.min(20, Math.max(1, Math.round(limits.concurrency) || 1));
	const roundLimit = Math.min(99, Math.max(1, Math.round(limits.roundLimit) || 3));
	const maxRetries = Math.min(10, Math.max(0, Math.round(limits.maxRetries)));
	const tokenLimit =
		limits.tokenLimit !== null && Number.isFinite(limits.tokenLimit) && (limits.tokenLimit ?? 0) > 0
			? Math.round(limits.tokenLimit as number)
			: null;
	const timeLimitMin =
		limits.timeLimitMin !== null && Number.isFinite(limits.timeLimitMin) && (limits.timeLimitMin ?? 0) > 0
			? Math.round(limits.timeLimitMin as number)
			: null;
	return { concurrency, roundLimit, tokenLimit, timeLimitMin, maxRetries };
}

function workspaceSlug(title: string, attempt: number): string {
	const slug =
		title
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 30) || "task";
	return `${slug}-a${attempt}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Presets an engine's commander may dispatch with: the whitelist when it has one,
 * every enabled preset otherwise. An empty whitelist means "no restriction", not
 * "none available" — that is how every engine created before presets existed
 * behaves, and reading it as an empty choice would silently disable the feature
 * for them.
 */
export function allowedPresets(agentDir: string, engine: Pick<ZGEngine, "presetIds">): ZGPreset[] {
	const enabled = listEnabledPresets(agentDir);
	if (engine.presetIds.length === 0) return enabled;
	const allowed = new Set(engine.presetIds);
	return enabled.filter((preset) => allowed.has(preset.id));
}

/**
 * The choices spelled out, for a refusal the commander can act on next round. With
 * nothing available the hint has to say what to do instead, and that depends on
 * whether the engine still accepts a task with no preset at all.
 */
export function presetChoiceHint(agentDir: string, engine: Pick<ZGEngine, "presetIds" | "presetOptional">): string {
	const presets = allowedPresets(agentDir, engine);
	if (presets.length === 0) {
		return engine.presetOptional
			? "本工程未启用任何预设 Agent，请省略 preset 参数，使用默认 Agent。"
			: "本工程要求每个任务都指定预设 Agent，但当前没有可用预设：请让操作员启用或授权预设，不要派发无预设的任务。";
	}
	return `可用预设：${presets.map((preset) => `${preset.id}（${preset.name}）`).join("、")}`;
}

/**
 * Keep only ids that name an existing preset, dropping duplicates. A whitelist
 * entry that no longer resolves would silently restrict nothing while looking
 * like a restriction, and the operator cannot see the stale id in the picker
 * they chose it from.
 *
 * A preset that merely exists but is disabled is kept on purpose. Dropping it
 * would empty the whitelist, and an empty whitelist means "no restriction" — the
 * opposite of what the operator asked for. Kept as it is, the whitelist still
 * narrows the choice to nothing while the preset is off, and re-enabling it
 * restores the same restriction. Whether a preset may run is decided per
 * dispatch, in `resolveDispatchPreset`.
 */
export function normalizePresetIds(agentDir: string, ids: readonly string[] | undefined): string[] {
	if (!ids || ids.length === 0) return [];
	const known = new Set(listPresets(agentDir).map((preset) => preset.id));
	return [...new Set(ids)].filter((id) => known.has(id));
}

/**
 * Resolve the preset a dispatch asked for. A refusal is returned, never thrown:
 * the id is model input, and a hallucinated or stale one is normal traffic — the
 * same rule `abortTask` follows. The refusal names what is available so the next
 * round corrects itself, and it is returned before any task row is created, so a
 * refused dispatch leaves no trace on the board.
 */
export function resolveDispatchPreset(
	agentDir: string,
	engine: Pick<ZGEngine, "presetIds" | "presetOptional">,
	presetId: string | null,
): { preset: ZGPreset | null; error?: string } {
	if (!presetId) {
		// Omitting the preset is the commander's way of saying "no identity fits".
		// An engine that requires one turns that into a refusal the commander can
		// correct on the next round, before any task row exists.
		if (!engine.presetOptional) {
			return {
				preset: null,
				error: `本工程要求每个任务都指定预设 Agent，本次派发没有指定。${presetChoiceHint(agentDir, engine)}`,
			};
		}
		return { preset: null };
	}
	const preset = findPreset(agentDir, presetId);
	if (!preset) return { preset: null, error: `预设「${presetId}」不存在。${presetChoiceHint(agentDir, engine)}` };
	if (!preset.enabled) {
		return { preset: null, error: `预设「${preset.name}」已停用。${presetChoiceHint(agentDir, engine)}` };
	}
	if (engine.presetIds.length > 0 && !engine.presetIds.includes(preset.id)) {
		return {
			preset: null,
			error: `预设「${preset.name}」不在本工程的预设白名单内。${presetChoiceHint(agentDir, engine)}`,
		};
	}
	return { preset };
}

/**
 * The commander's system prompt: role, targets, doctrines, presets, and the rules.
 * Exported for tests: what the commander is told about presets is the whole point
 * of the switch, and the wording differs per engine.
 */
export function buildCommanderBrief(
	engine: ZGEngine,
	doctrines: ZGDoctrine[],
	presets: readonly ZGPreset[],
	kind: "initial" | "resume",
	permissions: { bash: boolean; read: boolean },
): string {
	const doctrineText = doctrines
		.filter((doctrine) => engine.doctrines.includes(doctrine.id))
		.map((doctrine) => `【${doctrine.name}】\n${doctrine.text}`)
		.join("\n\n");
	const targetText = engine.targets
		.map((target, index) => `${index + 1}. ${target.target}${target.note ? `（备注：${target.note}）` : ""}`)
		.join("\n");
	// The list is capped and each description shortened (presetBriefLines), because
	// it enters the commander's context on every round: a large preset library must
	// not push the board and the target list out of it.
	const presetText =
		presetBriefLines(presets).join("\n") ||
		(engine.presetOptional
			? "（本工程没有可用预设，所有任务都使用默认 Agent，省略 preset 参数）"
			: "（本工程没有可用预设，但本工程要求每个任务都必须指定预设：不要派发无预设的任务，先让操作员启用或授权预设）");
	return [
		"你是 ZGAgent 工程模式的主指挥官。你只负责分配与调度，绝不亲自执行任何侦察、命令或利用——你没有任何执行工具，也不要尝试扮演执行者。",
		"",
		`工程：${engine.name}（项目：${engine.projectName}）${kind === "resume" ? "（本次为恢复运行）" : ""}`,
		"",
		"目标清单（一行一个，备注来自操作员）：",
		targetText,
		"",
		"指挥思路（操作员选定，必须遵循）：",
		doctrineText,
		"",
		`可用预设 Agent（派发任务时用 dispatch_task 的 preset 参数指定，让该任务以对应身份执行；清单之外或已停用的 id 会被拒绝${
			engine.presetOptional ? "" : "；本工程要求每个任务都必须指定，省略会被拒绝"
		}）：`,
		presetText,
		"",
		"工程参数：",
		`- 并发上限：${engine.limits.concurrency} 个任务同时运行`,
		`- 单任务自动续跑轮数上限：${engine.limits.roundLimit} 轮`,
		`- 单任务 token 上限：${engine.limits.tokenLimit ?? "无"}`,
		`- 单任务时间上限：${engine.limits.timeLimitMin ? `${engine.limits.timeLimitMin} 分钟` : "无"}`,
		`- 同一目标重试上限：${engine.limits.maxRetries} 次（首次派发不计入重试）`,
		"",
		"工作方式：",
		"- 用 dispatch_task 派发任务。每个任务的目标必须自包含：执行 Agent 看不到你的对话，也不能提问。写清目标、范围、方法提示、产出要求与验收标准。",
		engine.presetOptional
			? "- 派发前先看「可用预设 Agent」：任务与某个预设的描述、标签吻合，就用 preset 指定它执行；没有合适的就省略 preset，用默认 Agent。不要为了用预设而硬套，也不要每次都用同一个。"
			: "- 派发前先看「可用预设 Agent」：本工程要求每个任务都必须指定一个预设，省略 preset 会被拒绝；没有完全吻合的就选描述与标签最接近的那个，不要乱选，也不要每次都用同一个。",
		"- 任务结束后你会收到结果摘要；结合 list_tasks 掌握全局，再决定下一步。",
		"- 可以把已验证的情报（凭据、指纹、有效打法）通过 steer_task 注入运行中的任务；只传已验证的事实，不传猜测。",
		"- 失败的任务换思路重派（dispatch_task 带 target 会累计尝试次数）；无价值的任务用 abort_task 中止，不要浪费轮次。",
		"- 全部目标处理完后，用 engine_done 提交 markdown 总报告：逐目标结论、发现汇总（漏洞中枢编号）、失败清单与原因、建议操作员复核的事项。",
		"- 侦察能下放就下放：你的价值在编排与决策，不在等待。",
		...(permissions.bash
			? [
					"",
					"bash 与 read 的使用纪律（这是红线）：",
					"- 你有 bash 和 read，只用于「拆解任务前的一次性轻量确认」：判断目标类型（Web/主机/服务）、确认目标可达、区分同类目标，以便决定怎么派、派几个、给什么指令。",
					"- 任何需要多步骤、深入、或产出结果的工作都必须派发任务，不许自己做：端口全扫、漏洞验证、利用、批量枚举、写文件、长时间跑命令——这些一经发现即视为越权。",
					`- 硬性限制：命令预算 ${COMMANDER_BASH_BUDGET} 条、单条 ${COMMANDER_BASH_TIMEOUT_MS / 1000} 秒超时、输出截断、破坏性命令直接拒绝。预算用完后的正确动作是派发任务，不是换方式继续执行。`,
				]
			: [
					"",
					"注意：你没有 bash 与 read 工具（操作员已在权限页关闭）。完全基于目标清单、备注与任务结果摘要进行编排；信息不足时把「先做侦察」作为任务派发下去。",
				]),
	].join("\n");
}

function buildSnapshotReport(engine: ZGEngine): { filename: string; markdown: string } {
	const statusLabels: Record<string, string> = {
		queued: "排队中",
		running: "运行中",
		done: "已完成",
		failed: "失败",
		blocked: "已阻塞",
		aborted: "已中止",
		paused: "已暂停",
	};
	const lines = [
		`# 工程进度快照：${engine.name}`,
		"",
		`- 项目：${engine.projectName}`,
		`- 状态：${engine.status === "running" ? "运行中" : engine.status === "paused" ? "已暂停" : engine.status === "completed" ? "已完成" : "已终止"}`,
		`- 目标数：${engine.targets.length}`,
		`- 任务数：${engine.tasks.length}`,
		"",
		"## 任务看板",
		"",
		"| 状态 | 任务 | 目标 | 次数 | 结论 |",
		"| --- | --- | --- | --- | --- |",
	];
	for (const task of engine.tasks) {
		const summary = (task.summary ?? task.error ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 120);
		lines.push(
			`| ${statusLabels[task.status] ?? task.status} | ${task.title} | ${task.target ?? "—"} | ${task.attempt} | ${summary} |`,
		);
	}
	const at = new Date();
	const filename = `${engine.name}-${at.toISOString().replace(/[:.]/g, "-")}.md`;
	return { filename, markdown: lines.join("\n") };
}

interface MessageBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

function messageBlocks(message: unknown): MessageBlock[] {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? (content as MessageBlock[]) : [];
}

function toolResultText(result: unknown): string {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return "";
	return (content as MessageBlock[])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function emptyUsage(): ZGGoalUsage {
	return { input: 0, output: 0, total: 0, cost: null };
}
