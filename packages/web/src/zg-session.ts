/**
 * ZGAgent runtime: owns the live agent sessions, the approval gate, the
 * operator mode, and model-endpoint configuration.
 *
 * Multiple sessions run in parallel: switching the view to another session
 * never stops the previous one — it keeps executing in the background and its
 * transcript is up to date when you switch back. Every bash tool (main or
 * sub-agent, foreground or background session) passes the same approval gate.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { resolve as resolveFsPath } from "node:path";
import {
	type AgentSessionEvent,
	type BashOperations,
	createAgentSession,
	createBashTool,
	createCodemodeExtension,
	createEditTool,
	createMcpExtension,
	createReadTool,
	createToolSearchExtension,
	createWriteTool,
	DefaultResourceLoader,
	getAgentDir,
	getDefaultSessionDir,
	type ImageContent,
	ModelRuntime,
	SessionManager,
	type SessionStats,
	type SessionTreeNode,
	SettingsManager,
	type ThinkingLevel,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ApprovalGate } from "./approval.ts";
import { dockerBashOperations } from "./docker.ts";
import { deletePath, downloadFile, listFiles, makeDirectory, readFilePreview, renamePath, writeFile } from "./files.ts";
import {
	advanceGoal,
	blockGoal,
	buildGoalContract,
	completeGoal,
	createGoal,
	DEFAULT_ROUND_LIMIT,
	diffUsage,
	emptyUsage,
	extractRoundSummary,
	finishRound,
	GOAL_MESSAGE_CUSTOM_TYPE,
	GOAL_STATE_CUSTOM_TYPE,
	goalStatusLabel,
	parseCriteria,
	pauseGoal,
	readGoalState,
	recordBlocker,
	recordRoundProgress,
	recordSubmission,
	resumeGoal,
	startRound,
} from "./goal.ts";
import { createGoalTools, type GoalPort } from "./goal-tool.ts";
import { modelsJsonPath, readModelConfig, writeModelConfig, ZG_PROVIDER_ID } from "./model-config.ts";
import {
	buildGoalNotification,
	buildRunNotification,
	buildVulnNotification,
	sendDingTalk,
	shouldNotifyRun,
	testDingTalk,
} from "./notify.ts";
import { readNotifyConfig, writeNotifyConfig } from "./notify-config.ts";
import {
	effectiveSubagent,
	excludeToolsFor,
	PERMISSION_PRESETS,
	readPermissionsConfig,
	writePermissionsConfig,
	type ZGPermissionPreset,
	type ZGPermissionSet,
	type ZGPermissionsConfig,
} from "./permissions.ts";
import type {
	ZGFileEntry,
	ZGFilePreview,
	ZGForkPoint,
	ZGGoal,
	ZGGoalPauseReason,
	ZGGoalRoundOutcome,
	ZGGoalUsage,
	ZGGoalView,
	ZGMode,
	ZGModelConfig,
	ZGNotifyConfig,
	ZGNotifyStatus,
	ZGStateSnapshot,
	ZGSubagentEvent,
	ZGSubagentRun,
	ZGTestResult,
	ZGToolInfo,
	ZGVulnerability,
	ZGVulnFilters,
	ZGVulnStats,
	ZGVulnSummary,
	ZGVulnUpdate,
} from "./protocol.ts";
import {
	readSessionStatus,
	SESSION_STATUS_CUSTOM_TYPE,
	withSessionStatus,
	type ZGSessionListEntry,
	type ZGSessionStatus,
} from "./session-status.ts";
import { createSessionTitleTool } from "./session-title-tool.ts";
import { createSubagentTool } from "./subagent.ts";
import { SubagentStore, subagentDbPath } from "./subagent-store.ts";
import { SubagentRegistry } from "./subagents.ts";
import { branchTranscript, branchUserMessages, messageText, withSystemPrompt } from "./transcript.ts";
import { createVulnerabilityTools } from "./vuln-tool.ts";
import { emptyVulnStats, VulnerabilityStore, vulnerabilityDbPath } from "./vulnerabilities.ts";
import { buildVulnReport } from "./vulnerability-markdown.ts";

export interface ZGRuntimeHooks {
	/** Events of the currently viewed session only. */
	onSessionEvent(event: AgentSessionEvent): void;
	/** Fired whenever operator-visible state changes (approvals, mode, model, run lifecycle). */
	onStateChange(): void;
	/** One live sub-agent step, for the sub-agent panel. */
	onSubagentEvent(runId: string, event: ZGSubagentEvent): void;
	/** Fired after a notification send, so the settings screen can show its outcome. */
	onNotifyStatus(status: ZGNotifyStatus): void;
	/** A finding was submitted or reviewed; connected consoles refresh the hub page. */
	onVulnChange(): void;
	/** A session's name changed (operator or agent); consoles refresh the list. */
	onSessionRenamed(): void;
}

/**
 * The persistent goal of one session, plus the bookkeeping of the round in
 * flight. It lives on the managed session, not on the runtime: a goal belongs to
 * the conversation it was started in, and switching views must not touch it.
 */
interface ManagedGoal {
	goal: ZGGoal;
	/** Cumulative usage when the round started, so the round can report its delta. */
	roundUsageStart: ZGGoalUsage;
	/** Tool calls seen in the round in flight; zero for three rounds trips the fuse. */
	roundToolCalls: number;
	/** Findings submitted to the hub since the goal started. */
	submitted: number;
}

interface ManagedSession {
	key: string;
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	manager: SessionManager;
	unsubscribe: () => void;
	/**
	 * The run in flight for THIS session. It lives here, not on the runtime,
	 * because a run settles whether or not the operator is still looking at it:
	 * a long task that finishes while another conversation is on screen must
	 * still be reported.
	 */
	run?: {
		startedAt: number;
		/** Composer's per-message choice; undefined when it did not send one. */
		notify: boolean | undefined;
		instruction: string;
	};
	/** Persistent goal of this session, when one was started. */
	goal?: ManagedGoal;
	/**
	 * When this session's compaction started. The SDK blocks prompts for as long
	 * as its compaction controller lives, and a slow model can hold that for
	 * minutes, so the console tracks it to show the wait and to offer a cancel.
	 */
	compactionStartedAt?: number;
	/**
	 * True when this session belongs to an engineering-mode task. Task sessions
	 * are created by the engine through `acquireTaskSession`, run ungated, are
	 * never rebuilt by config/permission saves, and their goal is driven by the
	 * engine's worker — not by the console's goal bar.
	 */
	taskSession?: boolean;
}

/** Extra wiring a task session needs beyond a console session. */
export interface TaskSessionOptions {
	engineId: string;
	/** The engine's project, which may differ from the viewed one. */
	project: { id: string; name: string; container: string; cwd: string };
	/** Extra system-prompt text: the worker's engineering identity note. */
	appendPrompt: string;
	engineName: string;
	taskTitle: string;
	/** pi session id when resuming a paused task; null for a fresh one. */
	taskSessionId: string | null;
	/** True when the task is being resumed (reopen its session file). */
	paused: boolean;
	/** Goal tools bind to the engine worker's goal state, not the console's. */
	goalPort: GoalPort;
	/** A finding was submitted; the worker counts it towards its goal. */
	onFinding(): void;
}

export class ZGAgentRuntime {
	private cwd: string;
	private activeProjectId: string | undefined;
	private activeProjectName: string | undefined;
	private activeContainer: string | undefined;
	private readonly agentDir: string;
	private sessionDir: string;
	private readonly hooks: ZGRuntimeHooks;
	private readonly approvals: ApprovalGate;
	private readonly subagentStore: SubagentStore;
	private readonly subagents: SubagentRegistry;
	private readonly vulnerabilities: VulnerabilityStore;

	private mode: ZGMode = "review";
	private sessions = new Map<string, ManagedSession>();
	private activeKey: string | undefined;
	private modelRuntime: ModelRuntime | undefined;
	/** The run in flight for the viewed session, used to report it when it settles. */
	private notifyStatus: ZGNotifyStatus = { at: null, ok: true };

	constructor(options: {
		cwd: string;
		agentDir?: string;
		activeProject?: { id: string; name: string; container?: string; cwd?: string };
		hooks: ZGRuntimeHooks;
	}) {
		this.cwd = options.cwd;
		this.activeProjectId = options.activeProject?.id;
		this.activeProjectName = options.activeProject?.name;
		this.activeContainer = options.activeProject?.container;
		if (options.activeProject) {
			this.cwd = options.activeProject.cwd ?? this.cwd;
		}
		this.agentDir = options.agentDir ?? getAgentDir();
		this.hooks = options.hooks;
		this.approvals = new ApprovalGate(() => this.hooks.onStateChange());
		this.sessionDir = getDefaultSessionDir(this.cwd, this.agentDir);
		this.subagentStore = new SubagentStore(subagentDbPath(this.agentDir));
		this.vulnerabilities = new VulnerabilityStore(vulnerabilityDbPath(this.agentDir));
		this.subagents = new SubagentRegistry(this.subagentStore, {
			onEvent: (runId, event) => this.hooks.onSubagentEvent(runId, event),
			onRunChange: () => this.hooks.onStateChange(),
		});
	}

	private get active(): ManagedSession | undefined {
		return this.activeKey ? this.sessions.get(this.activeKey) : undefined;
	}

	get currentSessionId(): string | null {
		return this.active?.manager.getSessionId() ?? null;
	}

	/** The active session's file path, for messages that mean "the current session". */
	get currentSessionPath(): string | null {
		const file = this.active?.manager.getSessionFile();
		return file ? resolveFsPath(file) : null;
	}

	get currentMode(): ZGMode {
		return this.mode;
	}

	get isStreaming(): boolean {
		return this.active?.session.isStreaming ?? false;
	}

	/**
	 * Create the viewed session for the active project. Without a project no
	 * session exists at all: the console is not a host-shell runner, so there is
	 * no default directory to fall back to.
	 */
	async init(): Promise<void> {
		if (!this.activeProjectId) return;
		this.activeKey = await this.createSessionInto(SessionManager.create(this.cwd, this.sessionDir || undefined));
	}

	/** Activate a container project: sessions live on the host under its workDir, tools exec in the container. */
	async switchProject(project: { id: string; name: string; container?: string; cwd: string }): Promise<void> {
		await this.applyProject(project.id, project.name, project.cwd, project.container);
	}

	private async applyProject(
		id: string | undefined,
		name: string | undefined,
		cwd: string,
		container: string | undefined,
	): Promise<void> {
		this.cwd = cwd;
		this.activeProjectId = id;
		this.activeProjectName = name;
		this.activeContainer = container;
		this.sessionDir = getDefaultSessionDir(this.cwd, this.agentDir);
		this.activeKey = await this.createSessionInto(SessionManager.create(this.cwd, this.sessionDir || undefined));
		this.hooks.onStateChange();
	}

	/**
	 * Create a session and register it. Returns its key. Existing sessions are
	 * never touched: switching views must not interrupt background runs.
	 */
	/**
	 * Resource loader and settings shared by the main session and its sub-agents,
	 * so both load the same extensions and activate the same tools.
	 *
	 * The CLI loads codemode, tool search, and MCP as built-in extensions; SDK
	 * sessions have to add them explicitly. codemode and tool_search register
	 * inactive, so the default-tools override activates them while keeping the
	 * coding tools. The MCP extension reads mcp.json from the agent directory and
	 * connects its servers on session_start, which `bindExtensions` emits.
	 */
	private async createSessionContext(
		cwd: string,
		permissions: ZGPermissionSet,
		appendSystemPrompt?: string[],
	): Promise<{ resourceLoader: DefaultResourceLoader; settingsManager: SettingsManager }> {
		// A disabled extension is not even loaded: without MCP there are no
		// servers to connect, and codemode/tool_search never register. The
		// excludeTools denylist still covers them, so nothing can re-enable them.
		const extensionFactories = [];
		if (permissions.codemode) extensionFactories.push(createCodemodeExtension());
		if (permissions.tool_search) extensionFactories.push(createToolSearchExtension());
		if (permissions.mcp) extensionFactories.push(createMcpExtension());
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: this.agentDir,
			extensionFactories,
			...(appendSystemPrompt ? { appendSystemPrompt } : {}),
		});
		await resourceLoader.reload();
		const settingsManager = SettingsManager.create(cwd, this.agentDir);
		// Modifier-only entries append to the configured default tools instead of
		// replacing them, so an operator's own `defaultTools` setting still applies.
		const modifiers: string[] = [];
		if (permissions.codemode) modifiers.push("+codemode");
		if (permissions.tool_search) modifiers.push("+tool_search");
		settingsManager.applyOverrides(modifiers.length > 0 ? { defaultTools: modifiers } : {});
		return { resourceLoader, settingsManager };
	}

	private async createSessionInto(manager: SessionManager, task?: TaskSessionOptions): Promise<string> {
		// Every tool call runs in a project container; there is no host backend.
		// A task session runs in the engine's project (which may not be the one
		// on screen) and its bash is ungated: engineering mode never stops at an
		// approval queue nobody is watching.
		const container = task ? task.project.container : this.requireContainer();
		if (!this.modelRuntime) {
			this.modelRuntime = await ModelRuntime.create({
				authPath: `${this.agentDir}/auth.json`,
				modelsPath: modelsJsonPath(this.agentDir),
			});
		}

		const model = this.resolveModel();
		const managed: ManagedSession = {
			key: "",
			session: undefined as unknown as ManagedSession["session"],
			manager,
			unsubscribe: () => {},
		};
		const bash = task
			? createBashTool(manager.getCwd(), {
					operations: dockerBashOperations(container, { hostWorkDir: manager.getCwd() }),
				})
			: this.createGatedBash(
					manager.getCwd(),
					() => this.sessionLabel(managed),
					dockerBashOperations(container, { hostWorkDir: manager.getCwd() }),
				);

		const permissions = readPermissionsConfig(this.agentDir).main;
		const subagentPermissions = effectiveSubagent(readPermissionsConfig(this.agentDir));
		const { resourceLoader, settingsManager } = await this.createSessionContext(
			manager.getCwd(),
			permissions,
			task ? [task.appendPrompt] : undefined,
		);

		// `baseToolsOverride` replaces the whole base tool set, so the default coding
		// tools must be listed explicitly alongside the gated bash. Passing only bash
		// would leave the session with bash and the custom tools, and the system
		// prompt's tool section would degrade to the custom tools alone. Disabled
		// tools are left out here and named in `excludeTools`, which keeps
		// tool_search, the transcript and codemode from bringing them back.
		const baseToolsOverride = {
			...(permissions.read ? { read: createReadTool(manager.getCwd()) } : {}),
			...(permissions.bash ? { bash } : {}),
			...(permissions.edit ? { edit: createEditTool(manager.getCwd()) } : {}),
			...(permissions.write ? { write: createWriteTool(manager.getCwd()) } : {}),
		};
		// The hub tools are mounted here as well, so a session that may not delegate
		// can still report what it found.
		const sessionProject = task
			? { id: task.project.id, name: task.project.name }
			: this.activeProjectId
				? { id: this.activeProjectId, name: this.activeProjectName ?? "未命名项目" }
				: undefined;
		const customTools: ToolDefinition[] = [
			// The agent names the conversation once the task is clear; task
			// sessions keep their engine prefix so the sidebar badge holds.
			createSessionTitleTool({
				rename: (fullTitle) => {
					manager.appendSessionInfo(fullTitle);
					this.hooks.onSessionRenamed();
				},
				...(task ? { enginePrefix: () => task.engineName } : {}),
			}),
			// The goal tools are always mounted; they refuse to do anything while no
			// goal is running, which keeps the mount set stable across a goal. Task
			// sessions bind to the engine worker's goal state instead.
			...createGoalTools(task ? task.goalPort : this.createGoalPort(managed)),
			...this.createVulnTools({
				project: sessionProject,
				permissions,
				getSessionId: () => manager.getSessionId(),
				getSource: () => (task ? `工程任务「${task.taskTitle}」` : "主代理"),
				// A finding counts towards the goal's hub statement whether the main
				// agent or one of its sub-agents submitted it.
				onSubmit: task ? task.onFinding : () => this.noteGoalFinding(managed),
			}),
			...(permissions.spawn_agent
				? [
						createSubagentTool({
							cwd: manager.getCwd(),
							agentDir: this.agentDir,
							getModel: () => this.resolveModel(),
							getModelRuntime: () => this.modelRuntime,
							registry: this.subagents,
							getParentSessionId: () => manager.getSessionId(),
							getProjectId: () => this.activeProjectId,
							permissions: subagentPermissions,
							createGatedBash: () =>
								task
									? createBashTool(manager.getCwd(), {
											operations: dockerBashOperations(container, { hostWorkDir: manager.getCwd() }),
										})
									: this.createGatedBash(
											manager.getCwd(),
											() => "子代理",
											dockerBashOperations(container, { hostWorkDir: manager.getCwd() }),
										),
							createSessionContext: (appendSystemPrompt) =>
								this.createSessionContext(manager.getCwd(), subagentPermissions, appendSystemPrompt),
							// A sub-agent reports under the parent session and project.
							createVulnTools: (getSource) =>
								this.createVulnTools({
									project: sessionProject,
									permissions: subagentPermissions,
									getSessionId: () => manager.getSessionId(),
									getSource,
									onSubmit: () => this.noteGoalFinding(managed),
								}),
						}),
					]
				: []),
		];
		const created = await createAgentSession({
			cwd: manager.getCwd(),
			agentDir: this.agentDir,
			modelRuntime: this.modelRuntime,
			model,
			sessionManager: manager,
			resourceLoader,
			settingsManager,
			baseToolsOverride,
			customTools,
			excludeTools: excludeToolsFor(permissions),
		});
		managed.session = created.session;
		managed.taskSession = task !== undefined;
		// Emits session_start, which connects MCP servers and lets extensions
		// contribute skills and prompt templates.
		await created.session.bindExtensions({});
		managed.key = manager.getSessionId();
		if (task) {
			// The session list shows task sessions like any other conversation;
			// the name says which engine and task it belongs to.
			manager.appendSessionInfo(`${task.engineName} · ${task.taskTitle}`);
			// The task's goal is the worker's state, not the console's: no restore
			// here (the worker resumes it itself), and the goal bar never claims it.
		} else {
			// The goal is restored from the session file, so a reopened conversation
			// keeps the objective it was working on.
			managed.goal = this.restoreGoal(managed);
		}
		managed.unsubscribe = created.session.subscribe((event) => {
			// Only the viewed session streams events; background sessions run silently.
			if (managed.key === this.activeKey) this.hooks.onSessionEvent(event);
			if (event.type === "tool_execution_start" && managed.goal) managed.goal.roundToolCalls += 1;
			if (event.type === "agent_settled") {
				// The round is closed before the snapshot goes out: a console that saw
				// the settled state first would show a round that never finished.
				this.reportRunSettled(managed, event.aborted);
				this.afterRoundSettled(managed, event.aborted);
				this.hooks.onStateChange();
				return;
			}
			if (event.type === "agent_end") this.hooks.onStateChange();
			if (event.type === "compaction_start") {
				managed.compactionStartedAt = Date.now();
				this.hooks.onStateChange();
			}
			if (event.type === "compaction_end") {
				managed.compactionStartedAt = undefined;
				this.hooks.onStateChange();
			}
		});
		this.sessions.set(managed.key, managed);
		return managed.key;
	}

	/**
	 * Create (or reattach to) the console-visible session of one engineering
	 * task. The session lives in the project's normal session directory, so it
	 * shows up in the 对话 list with its 「工程 · 任务」 name and can be opened in
	 * the full conversation view while it runs — there is exactly one live
	 * instance, owned by this runtime, whether the engine or the operator is
	 * the one looking at it.
	 */
	async acquireTaskSession(
		options: TaskSessionOptions,
	): Promise<{ session: ManagedSession["session"]; manager: SessionManager; unsubscribe: () => void }> {
		const sessionDir = getDefaultSessionDir(options.project.cwd, this.agentDir);
		// A paused task reopens its own session file, so its goal and transcript
		// come back exactly as they were; a fresh task starts a new one.
		const manager =
			options.taskSessionId && options.paused
				? SessionManager.open(
						resolveFsPath(`${sessionDir}/${options.taskSessionId}.jsonl`),
						sessionDir || undefined,
						options.project.cwd,
					)
				: SessionManager.create(options.project.cwd, sessionDir || undefined);
		const key = await this.createSessionInto(manager, options);
		const managed = this.sessions.get(key);
		if (!managed) throw new Error("任务会话创建失败");
		return {
			session: managed.session,
			manager: managed.manager,
			unsubscribe: managed.unsubscribe,
		};
	}

	private sessionLabel(managed: ManagedSession): string {
		const name = managed.manager.getSessionName();
		return name ? `${name} · 主代理` : "主代理";
	}

	/** Bash tool whose every command passes the shared approval gate (unless prefix-allowed). */
	private createGatedBash(cwd: string, label: () => string, operations: BashOperations) {
		const gatedOps: BashOperations = {
			exec: (command, commandCwd, options) => {
				// Prefix-allowed commands skip the queue; everything else waits for a decision.
				if (this.mode !== "review" || this.approvals.isAutoAllowed(command)) {
					return operations.exec(command, commandCwd, options);
				}
				return this.approvals
					.request(command, commandCwd, options?.signal, label())
					.then((outcome) =>
						outcome.approved && outcome.command !== undefined
							? operations.exec(outcome.command, commandCwd, options)
							: Promise.reject(new Error(`Command not executed: ${outcome.reason ?? "rejected"}`)),
					);
			},
		};
		return createBashTool(cwd, { operations: gatedOps });
	}

	private requireContainer(): string {
		if (!this.activeContainer) throw new Error("没有可用的项目容器，请先创建或选择一个项目");
		return this.activeContainer;
	}

	/**
	 * The hub tools one session may mount. A disabled switch is left out here and
	 * named in `excludeTools` as well, so neither tool_search nor a restored
	 * transcript can bring the tool back.
	 *
	 * The project is captured when the session is created, not read from the live
	 * field: switching projects keeps the previous sessions running in the
	 * background, and a finding submitted by one of those must stay with the
	 * project it was found in.
	 */
	private createVulnTools(options: {
		project: { id: string; name: string } | undefined;
		permissions: ZGPermissionSet;
		getSessionId: () => string | undefined;
		getSource: () => string;
		/** A record was created, so a running goal can count it as its own finding. */
		onSubmit: () => void;
	}): ToolDefinition[] {
		if (!options.permissions.vuln_submit && !options.permissions.vuln_read) return [];
		const tools = createVulnerabilityTools({
			store: this.vulnerabilities,
			getProject: () => options.project,
			getSessionId: options.getSessionId,
			getSource: options.getSource,
			onHighSeverity: (vuln) => this.notifyHighSeverity(vuln),
			onChange: () => this.hooks.onVulnChange(),
			onSubmit: () => options.onSubmit(),
		});
		return tools.filter((tool) =>
			tool.name === "vuln_submit" ? options.permissions.vuln_submit : options.permissions.vuln_read,
		);
	}

	/**
	 * Push a critical/high finding the moment it is submitted. The run-end report
	 * still arrives later; this exists because a serious finding should not wait
	 * for a run that may take another hour.
	 */
	private notifyHighSeverity(vuln: ZGVulnerability): void {
		const config = readNotifyConfig(this.agentDir);
		if (!config.enabled || !config.webhook.trim()) return;
		const report = buildVulnNotification(vuln, this.activeProjectName ?? vuln.projectName, config.summaryLimit);
		void sendDingTalk(config, report.title, report.markdown).then((result) => {
			this.notifyStatus = { ...result, subject: report.title };
			this.hooks.onNotifyStatus(this.notifyStatus);
		});
	}

	/**
	 * Read the goal back from the session file. A goal that was active when the
	 * session was (re)built has no run behind it any more — the console restarted,
	 * or the session was recreated after a config change — so it comes back paused
	 * instead of pretending to be running.
	 */
	private restoreGoal(managed: ManagedSession): ManagedGoal | undefined {
		const goal = readGoalState(managed.manager.getBranch());
		if (!goal) return undefined;
		const managedGoal: ManagedGoal = {
			goal,
			roundUsageStart: usageOf(managed.session.getSessionStats()),
			roundToolCalls: 0,
			submitted: goal.submitted,
		};
		if (goal.status === "active") {
			managedGoal.goal = pauseGoal(
				goal,
				"interrupted",
				"控制台重启或会话重建，目标已暂停；点「继续」恢复自动续跑",
				Date.now(),
			);
			this.persistGoal(managed, managedGoal.goal);
			this.notifyGoal(managed, managedGoal);
		}
		return managedGoal;
	}

	/** The goal state is a session entry, so it travels with the conversation. */
	private persistGoal(managed: ManagedSession, goal: ZGGoal | null): void {
		managed.manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, goal);
	}

	/**
	 * What the goal tools may do to the goal of this session. The tools validate
	 * their own arguments; every accepted change lands here, so persistence, the
	 * notification, and the console refresh happen in exactly one place.
	 */
	private createGoalPort(managed: ManagedSession): GoalPort {
		return {
			current: () => managed.goal?.goal,
			submitted: () => managed.goal?.submitted ?? 0,
			progress: (progress) => {
				const managedGoal = managed.goal;
				if (!managedGoal) return;
				managedGoal.goal = recordRoundProgress(managedGoal.goal, progress, Date.now());
				this.persistGoal(managed, managedGoal.goal);
				this.hooks.onStateChange();
			},
			complete: (completion) => {
				const managedGoal = managed.goal;
				if (!managedGoal) return;
				managedGoal.goal = completeGoal(managedGoal.goal, completion);
				this.persistGoal(managed, managedGoal.goal);
				this.notifyGoal(managed, managedGoal);
				this.hooks.onStateChange();
			},
			blocked: (reason, evidence) => {
				const managedGoal = managed.goal;
				if (!managedGoal) return { streak: 0, accepted: false };
				const at = Date.now();
				const result = recordBlocker(managedGoal.goal, reason, at);
				managedGoal.goal = result.accepted
					? blockGoal(result.goal, reason, evidence, result.streak, at)
					: result.goal;
				this.persistGoal(managed, managedGoal.goal);
				if (result.accepted) this.notifyGoal(managed, managedGoal);
				this.hooks.onStateChange();
				return { streak: result.streak, accepted: result.accepted };
			},
		};
	}

	/**
	 * One finding reached the hub while this goal was running. Sub-agents count
	 * too: their work is the goal's work, and a completion claim that ignored a
	 * finding they submitted would be rejected as a mismatch.
	 */
	private noteGoalFinding(managed: ManagedSession): void {
		const managedGoal = managed.goal;
		if (!managedGoal || managedGoal.goal.status !== "active") return;
		managedGoal.submitted += 1;
		managedGoal.goal = recordSubmission(managedGoal.goal, Date.now());
		this.persistGoal(managed, managedGoal.goal);
		this.hooks.onStateChange();
	}

	/**
	 * Move the goal on after a settled round. Called once per settle, and the
	 * continuation is injected with `triggerTurn`, which the SDK defers until the
	 * settle emission is over: a round can never fork into two continuations.
	 *
	 * A round ends when the agent stops calling tools, so everything here is about
	 * what the next round is allowed to be: nothing when the goal already ended,
	 * a pause when a fuse trips, otherwise one continuation carrying the progress.
	 */
	private afterRoundSettled(managed: ManagedSession, aborted: boolean): void {
		const managedGoal = managed.goal;
		if (!managedGoal) return;
		const at = Date.now();
		const usage = diffUsage(usageOf(managed.session.getSessionStats()), managedGoal.roundUsageStart);
		const round = managedGoal.goal.rounds[managedGoal.goal.rounds.length - 1];
		// A round that called goal_progress already wrote its own summary; the prose
		// fallback is for rounds that never did.
		const summary =
			round?.summaryFromTool === true ? undefined : extractRoundSummary(lastAssistantText(managed.session.messages));
		const status = managedGoal.goal.status;
		const outcome: ZGGoalRoundOutcome = aborted
			? "aborted"
			: status === "completed"
				? "completed"
				: status === "blocked"
					? "blocked"
					: status === "paused"
						? "paused"
						: lastAssistantStopReason(managed.session.messages) === "error"
							? "error"
							: "continued";
		let goal = finishRound(managedGoal.goal, {
			at,
			toolCalls: managedGoal.roundToolCalls,
			usage,
			...(summary ? { summary } : {}),
			outcome,
		});
		// An abort is an intervention: the goal waits for the operator rather than
		// counting a half-finished round as progress.
		if (aborted && goal.status === "active") {
			goal = pauseGoal(goal, "manual", "运行被中止，目标已暂停", at);
		}
		managedGoal.goal = goal;
		managedGoal.roundToolCalls = 0;
		if (goal.status !== "active") {
			this.persistGoal(managed, goal);
			this.notifyGoal(managed, managedGoal);
			return;
		}
		const decision = advanceGoal(goal, at);
		managedGoal.goal = decision.goal;
		this.persistGoal(managed, decision.goal);
		if (decision.action === "stop") {
			this.notifyGoal(managed, managedGoal);
			return;
		}
		const next = startRound(decision.goal, "continue", at);
		managedGoal.goal = next;
		managedGoal.roundUsageStart = usageOf(managed.session.getSessionStats());
		this.persistGoal(managed, next);
		this.startContinuation(managed, buildGoalContract(next, "continue"));
	}

	/**
	 * Report a goal that stopped. Goal-driven runs deliberately send no per-run
	 * report, so this is the only notification the operator gets about a goal that
	 * finished, ran out of rounds, or gave up; it is not gated on the composer's
	 * per-run switch, only on the notification channel being enabled.
	 */
	private notifyGoal(managed: ManagedSession, managedGoal: ManagedGoal): void {
		const goal = managedGoal.goal;
		if (goal.status === "active") return;
		const config = readNotifyConfig(this.agentDir);
		if (!config.enabled || !config.webhook.trim()) return;
		const lastRound = goal.rounds[goal.rounds.length - 1];
		const report = buildGoalNotification(
			{
				label: goalStatusLabel(goal),
				projectName: this.activeProjectName ?? "",
				sessionTitle: managed.manager.getSessionName() ?? firstUserText(managed.session.messages) ?? goal.objective,
				sessionStatus: readSessionStatus(managed.manager.getBranch()),
				objective: goal.objective,
				rounds: { used: goal.roundsUsed, limit: goal.roundLimit },
				durationMs: (goal.endedAt ?? Date.now()) - goal.startedAt,
				summary: goal.completion?.summary ?? goal.blocked?.reason ?? goal.pauseNote ?? lastRound?.summary ?? "",
				...(goal.completion
					? {
							evidence: goal.completion.evidence,
							criteria: goal.completion.criteria,
							findings: { submitted: goal.completion.submitted, note: goal.completion.findingsNote },
						}
					: {}),
				...(goal.blocked ? { evidence: goal.blocked.evidence } : {}),
			},
			config.summaryLimit,
		);
		void sendDingTalk(config, report.title, report.markdown).then((result) => {
			this.notifyStatus = { ...result, subject: report.title };
			this.hooks.onNotifyStatus(this.notifyStatus);
		});
	}

	/**
	 * Pause one session's goal. Takes the session rather than assuming the viewed
	 * one: a goal that runs in the background settles there too, and a continuation
	 * that cannot start has to be recorded against its own session.
	 */
	private pauseGoalOf(managed: ManagedSession, reason: ZGGoalPauseReason, note?: string): void {
		const managedGoal = managed.goal;
		if (!managedGoal || managedGoal.goal.status !== "active") return;
		managedGoal.goal = pauseGoal(managedGoal.goal, reason, note, Date.now());
		this.persistGoal(managed, managedGoal.goal);
		this.notifyGoal(managed, managedGoal);
		this.hooks.onStateChange();
	}

	/**
	 * Pause the viewed session's goal. Only the viewed one: a pause is an operator
	 * action on the conversation on screen, and a goal running in the background
	 * keeps working (its notifications still arrive).
	 */
	private pauseActiveGoal(reason: ZGGoalPauseReason, note?: string): void {
		if (this.active) this.pauseGoalOf(this.active, reason, note);
	}

	/**
	 * Start a round by injecting its contract. `triggerTurn` defers the run until
	 * the settle emission is over, so a round can never fork into two runs; when
	 * the run cannot start at all, the goal pauses with the reason instead of
	 * sitting there as if it were still working.
	 */
	private startContinuation(managed: ManagedSession, contract: string): void {
		void managed.session
			.sendCustomMessage(
				{ customType: GOAL_MESSAGE_CUSTOM_TYPE, content: contract, display: true },
				{ triggerTurn: true },
			)
			.catch((error: unknown) => {
				this.pauseGoalOf(
					managed,
					"manual",
					`续跑启动失败：${error instanceof Error ? error.message : String(error)}`,
				);
			});
	}

	/** The goal as the console shows it: the stored record plus live counters. */
	private goalView(managed: ManagedSession | undefined): ZGGoalView | null {
		if (!managed?.goal) return null;
		const goal = managed.goal.goal;
		// Sub-agent usage is shown for context. It does not consume rounds: the
		// budget counts continuations, and there is no token budget to charge.
		const runs = this.subagents
			.list(managed.manager.getSessionId())
			.filter((run) => Date.parse(run.startedAt) >= goal.startedAt);
		return {
			...goal,
			usage: diffUsage(usageOf(managed.session.getSessionStats()), goal.baseline),
			subagent: { runs: runs.length, turns: runs.reduce((sum, run) => sum + run.turns, 0) },
			running: managed.session.isStreaming,
		};
	}

	/**
	 * Start a persistent goal. Auto mode is a precondition rather than something
	 * this code flips: an unattended loop that stops at every command is useless,
	 * and one that silently changes the operator's safety mode is worse.
	 */
	async startGoal(objective: string, criteria: string[], roundLimit: number): Promise<void> {
		if (!this.activeProjectId) throw new Error("请先创建或选择一个项目");
		const active = this.active;
		if (!active) throw new Error("会话尚未就绪，请重新选择项目");
		if (this.mode !== "auto") {
			throw new Error("持续目标只在自动模式下可用：请先切到自动模式（目标运行期间命令无人拦截直接执行）");
		}
		if (active.session.isStreaming) throw new Error("Agent 正在运行，请先中止或等本轮结束再启动目标");
		const text = objective.trim();
		if (!text) throw new Error("目标不能为空");
		const existing = active.goal;
		if (existing && existing.goal.status !== "completed") {
			throw new Error("当前会话已有未结束的目标，请先在目标条上继续或清除它");
		}
		const at = Date.now();
		const baseline = usageOf(active.session.getSessionStats());
		const goal = createGoal({
			id: `goal-${randomUUID()}`,
			objective: text,
			criteria: parseCriteria(criteria.join("\n")),
			roundLimit,
			baseline,
			at,
		});
		const managedGoal: ManagedGoal = {
			goal: startRound(goal, "initial", at),
			roundUsageStart: baseline,
			roundToolCalls: 0,
			submitted: 0,
		};
		active.goal = managedGoal;
		this.persistGoal(active, managedGoal.goal);
		// The contract is a visible row of its own rather than part of the operator's
		// message: the objective stays exactly what they typed, and the transcript
		// shows what goal mode added around it.
		await active.session.sendCustomMessage(
			{
				customType: GOAL_MESSAGE_CUSTOM_TYPE,
				content: buildGoalContract(managedGoal.goal, "initial"),
				display: true,
			},
			{ triggerTurn: false },
		);
		// Goal-driven runs skip the per-run report: goal notifications cover the
		// states that matter, and one report per round would be noise.
		active.run = { startedAt: at, notify: false, instruction: text };
		try {
			await active.session.prompt(text, {});
		} catch (error) {
			// The run never started, so the goal cannot be left looking active.
			this.pauseGoalOf(active, "manual", `启动失败：${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
		this.hooks.onStateChange();
	}

	/** Operator pause: stop the run in flight and keep the goal for later. */
	async pauseGoal(): Promise<void> {
		this.pauseActiveGoal("manual", "操作员在目标条上暂停");
		await this.active?.session.abort();
	}

	/**
	 * Resume a paused or blocked goal and start the next round right away. The
	 * extra rounds are added to the budget, so resuming after the limit is the
	 * same action as resuming after a manual pause.
	 */
	resumeGoal(extraRounds?: number): void {
		const active = this.active;
		const managedGoal = active?.goal;
		if (!active || !managedGoal) throw new Error("当前会话没有持续目标");
		if (managedGoal.goal.status === "completed") throw new Error("目标已完成，请清除后新建目标");
		if (this.mode !== "auto") throw new Error("持续目标只在自动模式下可用：请先切到自动模式");
		if (active.session.isStreaming) throw new Error("Agent 正在运行，请先中止再继续目标");
		if (managedGoal.goal.status === "active") return;
		const at = Date.now();
		const resumed = resumeGoal(managedGoal.goal, extraRounds ?? DEFAULT_ROUND_LIMIT, at);
		const next = startRound(resumed, "continue", at);
		managedGoal.goal = next;
		managedGoal.roundUsageStart = usageOf(active.session.getSessionStats());
		managedGoal.roundToolCalls = 0;
		this.persistGoal(active, next);
		this.startContinuation(active, buildGoalContract(next, "continue"));
		this.hooks.onStateChange();
	}

	/** Forget the goal. A run in flight belongs to it, so it is stopped first. */
	async clearGoal(): Promise<void> {
		const active = this.active;
		if (!active?.goal) return;
		if (active.session.isStreaming) await active.session.abort();
		active.goal = undefined;
		this.persistGoal(active, null);
		this.hooks.onStateChange();
	}

	/**
	 * Forget a project and drop its sessions. Used when the project is deleted:
	 * its container is gone, so nothing of it can run any more. The runtime ends
	 * up with no project, which the console renders as the project-required state.
	 */ async detachProject(workDir?: string): Promise<void> {
		for (const [key, managed] of [...this.sessions]) {
			if (workDir !== undefined && managed.manager.getCwd() !== workDir) continue;
			managed.unsubscribe();
			managed.session.dispose();
			this.sessions.delete(key);
			if (this.activeKey === key) this.activeKey = undefined;
		}
		if (workDir === undefined || this.cwd === workDir) {
			this.activeProjectId = undefined;
			this.activeProjectName = undefined;
			this.activeContainer = undefined;
		}
		this.hooks.onStateChange();
	}

	private resolveModel() {
		const config = readModelConfig(this.agentDir);
		if (!config || !this.modelRuntime) return undefined;
		return this.modelRuntime.getModel(ZG_PROVIDER_ID, config.modelId);
	}

	async prompt(
		text: string,
		streamingBehavior?: "steer" | "followUp",
		images?: ImageContent[],
		notify?: boolean,
	): Promise<void> {
		if (!this.activeProjectId) throw new Error("请先创建或选择一个项目");
		const active = this.active;
		if (!active) throw new Error("会话尚未就绪，请重新选择项目");
		// pi's built-in slash commands only exist in interactive mode, so the console
		// honors the one its own context-overflow hint references.
		if (text.trim() === "/compact") {
			await this.compact();
			return;
		}
		// pi refuses this in English; the operator is looking at a console that has
		// no other hint about why the prompt went nowhere.
		if (active.session.isCompacting) {
			throw new Error("正在压缩上下文，暂时不能发送；可等待压缩完成，或点「中止压缩」放弃这次压缩");
		}
		// A steer joins the run already in flight: keep its start time, let the
		// operator's latest choice decide whether the run is reported.
		active.run = {
			startedAt: active.run?.startedAt ?? Date.now(),
			notify,
			instruction: active.run?.instruction ?? text,
		};
		await active.session.prompt(text, {
			...(streamingBehavior ? { streamingBehavior } : {}),
			...(images && images.length > 0 ? { images } : {}),
		});
	}

	/**
	 * Report a settled run to the notification channel. Every session reports its
	 * own run: gating this on the viewed session silently dropped the notification
	 * of any long task that finished while the operator was elsewhere. The send is
	 * fire-and-forget, because a failing webhook must never affect the run.
	 */
	private reportRunSettled(managed: ManagedSession, aborted: boolean): void {
		const run = managed.run;
		managed.run = undefined;
		if (!run) return;
		const config = readNotifyConfig(this.agentDir);
		if (!shouldNotifyRun(run.notify, config.enabled)) return;
		if (!config.webhook.trim()) return;

		const last = [...managed.session.messages]
			.reverse()
			.find((message) => (message as { role?: string }).role === "assistant") as
			| { stopReason?: string; errorMessage?: string; content?: unknown }
			| undefined;
		const status =
			aborted || last?.stopReason === "aborted" ? "aborted" : last?.stopReason === "error" ? "failed" : "done";
		const stats = managed.session.getSessionStats();
		const report = buildRunNotification(
			{
				status,
				projectName: this.activeProjectName ?? "",
				sessionTitle:
					managed.manager.getSessionName() ?? firstUserText(managed.session.messages) ?? run.instruction,
				sessionStatus: readSessionStatus(managed.manager.getBranch()),
				durationMs: Date.now() - run.startedAt,
				summary: messageText(last),
				...(status === "failed" && last?.errorMessage ? { error: last.errorMessage } : {}),
				tokens: stats?.tokens
					? { input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total }
					: undefined,
				...(typeof stats?.cost === "number" ? { cost: stats.cost } : {}),
			},
			config.summaryLimit,
		);
		void sendDingTalk(config, report.title, report.markdown).then((result) => {
			this.notifyStatus = { ...result, subject: report.title };
			this.hooks.onNotifyStatus(this.notifyStatus);
		});
	}

	/** Notification configuration, for the settings screen. */
	getNotifyConfig(): ZGNotifyConfig {
		return readNotifyConfig(this.agentDir);
	}

	getNotifyStatus(): ZGNotifyStatus {
		return this.notifyStatus;
	}

	saveNotifyConfig(config: ZGNotifyConfig): void {
		writeNotifyConfig(this.agentDir, config);
	}

	async testNotify(config: ZGNotifyConfig): Promise<ZGTestResult> {
		return await testDingTalk(config);
	}

	/** Manually compact the viewed session's context into a summary. */
	async compact(): Promise<void> {
		const active = this.active;
		if (!active) throw new Error("Session not initialized");
		if (active.session.isStreaming) throw new Error("Agent 正在运行，请先中止再压缩上下文");
		try {
			await active.session.compact();
		} catch (error) {
			// pi reports these two cases in English; the console is Chinese-first.
			// Anything else is rethrown unchanged.
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("too small")) throw new Error("当前会话内容太少，无需压缩");
			if (message.includes("Already compacted")) throw new Error("该会话已经压缩过，无需重复压缩");
			// The operator cancelled it: pi reports that as a cancelled or aborted
			// summarization, and it is not a failure worth a toast.
			if (/cancel|abort/i.test(message)) return;
			throw error;
		}
		this.hooks.onStateChange();
	}

	/**
	 * Cancel a compaction that is still running. The SDK has no timeout on the
	 * summarization request, so a stalled model endpoint leaves the session
	 * refusing every prompt with no way out but a restart; this is that way out.
	 * Nothing is lost: the transcript is only rewritten once a summary arrives.
	 */
	abortCompaction(): void {
		const active = this.active;
		if (!active) return;
		active.session.abortCompaction();
		this.hooks.onStateChange();
	}

	/** Set the viewed session's reasoning effort. Persists for this session only. */
	setThinkingLevel(level: ThinkingLevel): void {
		const active = this.active;
		if (!active) throw new Error("Session not initialized");
		if (!active.session.getAvailableThinkingLevels().includes(level)) {
			throw new Error(`当前模型不支持思考等级「${level}」`);
		}
		active.session.setThinkingLevel(level);
		this.hooks.onStateChange();
	}

	async abort(): Promise<void> {
		// Aborting a goal's run pauses the goal: the run is the goal's work, and an
		// abort is an intervention, not a reason to throw the objective away.
		this.pauseActiveGoal("manual", "运行被中止，目标已暂停");
		await this.active?.session.abort();
	}

	setMode(mode: ZGMode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		if (mode === "auto") this.approvals.rejectAll("switched to auto mode");
		// A goal only runs unattended in auto mode. Leaving it active in review mode
		// would park it on an approval queue nobody is watching, so it pauses and
		// says why.
		if (mode === "review") this.pauseActiveGoal("manual", "已切回审批模式，目标自动暂停");
		this.hooks.onStateChange();
	}

	decide(id: string, approved: boolean, editedCommand?: string, alwaysAllowPrefix = false): boolean {
		return this.approvals.decide(id, approved, editedCommand, alwaysAllowPrefix);
	}

	decideAll(approved: boolean): number {
		return this.approvals.decideAll(approved);
	}

	allowPrefix(prefix: string): void {
		this.approvals.allowPrefix(prefix);
	}

	removeAllowedPrefix(prefix: string): void {
		this.approvals.removeAllowedPrefix(prefix);
	}

	async newSession(): Promise<void> {
		const manager = SessionManager.create(this.cwd, this.sessionDir || undefined);
		this.activeKey = await this.createSessionInto(manager);
		this.hooks.onStateChange();
	}

	/**
	 * Switch the viewed session. Never interrupts a running one: sessions keep
	 * executing in the background and are up to date when you switch back.
	 */
	async switchSession(path: string): Promise<void> {
		const normalized = resolveFsPath(path);
		for (const managed of this.sessions.values()) {
			const file = managed.manager.getSessionFile();
			if (file && resolveFsPath(file) === normalized) {
				this.activeKey = managed.key;
				this.hooks.onStateChange();
				return;
			}
		}
		const manager = SessionManager.open(normalized, this.sessionDir || undefined, this.cwd);
		this.activeKey = await this.createSessionInto(manager);
		this.hooks.onStateChange();
	}

	async listSessions(): Promise<ZGSessionListEntry[]> {
		const sessions = await SessionManager.list(this.cwd, this.sessionDir || undefined);
		return sessions.map(withSessionStatus);
	}

	/** Rename any session in the managed session directory by appending a session_info entry. */
	async renameSession(path: string, name: string): Promise<void> {
		const normalized = this.guardSessionPath(path);
		const manager = SessionManager.open(normalized, this.sessionDir || undefined, this.cwd);
		manager.appendSessionInfo(name);
	}

	/**
	 * Set the operator status of any session in the managed session directory. The
	 * status is an entry, so the conversation itself is untouched; `null` clears it.
	 */
	async setSessionStatus(path: string, status: ZGSessionStatus | null): Promise<void> {
		const normalized = this.guardSessionPath(path);
		const data = status ? { status, at: Date.now() } : null;
		// A loaded session owns the live branch, and the toolbar reads the status
		// from that branch. A second handle on the same file would write the entry
		// without the running session seeing it, so write through the owner.
		for (const managed of this.sessions.values()) {
			const file = managed.manager.getSessionFile();
			if (file && resolveFsPath(file) === normalized) {
				managed.manager.appendCustomEntry(SESSION_STATUS_CUSTOM_TYPE, data);
				this.hooks.onStateChange();
				return;
			}
		}
		const manager = SessionManager.open(normalized, this.sessionDir || undefined, this.cwd);
		manager.appendCustomEntry(SESSION_STATUS_CUSTOM_TYPE, data);
	}

	/** Delete a session file. Running sessions and foreign paths are rejected. */
	async deleteSession(path: string): Promise<void> {
		const normalized = this.guardSessionPath(path);
		for (const managed of this.sessions.values()) {
			const file = managed.manager.getSessionFile();
			if (file && resolveFsPath(file) === normalized) {
				if (managed.session.isStreaming) {
					throw new Error("该会话正在运行，请先中止再删除");
				}
				managed.unsubscribe();
				managed.session.dispose();
				this.sessions.delete(managed.key);
				if (this.activeKey === managed.key) this.activeKey = undefined;
				break;
			}
		}
		if (!existsSync(normalized)) {
			throw new Error("会话文件不存在（可能已被删除）");
		}
		unlinkSync(normalized);
	}

	/** Only files inside the managed session directory may be renamed or deleted. */
	private guardSessionPath(path: string): string {
		const normalized = resolveFsPath(path);
		const dir = resolveFsPath(this.sessionDir);
		if (!normalized.startsWith(`${dir}/`) || !normalized.endsWith(".jsonl")) {
			throw new Error("路径不在受管的会话目录内，已拒绝该操作");
		}
		return normalized;
	}

	getTree(): { tree: SessionTreeNode[]; leafId: string | null; forkPoints: ZGForkPoint[] } {
		const active = this.active;
		return {
			tree: active?.manager.getTree() ?? [],
			leafId: active?.manager.getLeafId() ?? null,
			// The client pairs these with the transcript's user messages by index,
			// so they have to come from the same branch the transcript does.
			forkPoints: active ? branchUserMessages(active.manager.getBranch()) : [],
		};
	}

	async navigate(entryId: string, summarize?: boolean): Promise<void> {
		const active = this.active;
		if (!active) throw new Error("Session not initialized");
		// Web semantics: navigating to a user message keeps it and branches from
		// it, instead of pi's default rewind-and-re-edit behavior.
		await active.session.navigateTree(
			entryId,
			summarize ? { summarize: true, forkFromUser: true } : { forkFromUser: true },
		);
		this.hooks.onStateChange();
	}

	/** Name a branch point (pi label entry) for readable branch lists. */
	renameBranch(entryId: string, label: string): void {
		const active = this.active;
		if (!active) throw new Error("Session not initialized");
		if (!label.trim()) throw new Error("分支名称不能为空");
		active.manager.appendLabelChange(entryId, label.trim());
	}

	getConfig(): ZGModelConfig | null {
		return readModelConfig(this.agentDir);
	}

	/** Apply a new endpoint: rebuild the model runtime and every live session. */
	async saveConfig(config: ZGModelConfig): Promise<void> {
		writeModelConfig(this.agentDir, config);
		// Task sessions keep their tools and their engine driver: disposing them
		// would kill running engineering tasks. They stay on the old endpoint;
		// every task started afterwards uses the new one.
		const existing = [...this.sessions.values()].filter((managed) => !managed.taskSession);
		for (const managed of existing) managed.unsubscribe();
		for (const managed of existing) managed.session.dispose();
		for (const managed of existing) this.sessions.delete(managed.key);
		this.modelRuntime = undefined;
		// Recreate each session on the new runtime, restoring the previous view last.
		const order = [...existing];
		const viewed = order.findIndex((managed) => managed.key === this.activeKey);
		if (viewed !== -1) order.push(...order.splice(viewed, 1));
		for (const managed of order) {
			await this.createSessionInto(managed.manager);
		}
		this.hooks.onStateChange();
	}

	/** Tool permissions plus the inventory of what the live session mounted. */
	getPermissions(): {
		config: ZGPermissionsConfig;
		effectiveSubagent: ZGPermissionSet;
		presets: readonly ZGPermissionPreset[];
		tools: ZGToolInfo[];
	} {
		const config = readPermissionsConfig(this.agentDir);
		return {
			config,
			effectiveSubagent: effectiveSubagent(config),
			presets: PERMISSION_PRESETS,
			tools: this.listMountedTools(),
		};
	}

	/**
	 * What the viewed session actually has mounted. The permissions screen shows
	 * this so a switch can be checked against reality instead of trusted.
	 */
	private listMountedTools(): ZGToolInfo[] {
		const session = this.active?.session;
		if (!session) return [];
		const active = new Set(session.getActiveToolNames());
		return session
			.getAllTools()
			.map((tool) => ({
				name: tool.name,
				source: tool.sourceInfo?.source ?? "unknown",
				active: active.has(tool.name),
			}))
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	/**
	 * Apply new permissions and rebuild every live session, because tools are
	 * mounted when a session is created. A running session is refused rather than
	 * disposed: the operator aborts it first, so no work is lost silently.
	 */
	async savePermissions(config: ZGPermissionsConfig): Promise<void> {
		const running = [...this.sessions.values()].filter((managed) => managed.session.isStreaming);
		if (running.length > 0) throw new Error("有会话正在运行，请先中止再修改权限");
		writePermissionsConfig(this.agentDir, config);
		// Task sessions are skipped for the same reason as in saveConfig: the
		// engine owns their lifecycle, and new tasks pick up the new switches.
		const existing = [...this.sessions.values()].filter((managed) => !managed.taskSession);
		const activeKey = this.activeKey;
		for (const managed of existing) managed.unsubscribe();
		for (const managed of existing) managed.session.dispose();
		for (const managed of existing) this.sessions.delete(managed.key);
		// Recreate every session, restoring the previously viewed one last.
		const order = [...existing];
		const viewed = order.findIndex((managed) => managed.key === activeKey);
		if (viewed !== -1) order.push(...order.splice(viewed, 1));
		for (const managed of order) {
			await this.createSessionInto(managed.manager);
		}
		this.hooks.onStateChange();
	}

	snapshot(): ZGStateSnapshot {
		const config = readModelConfig(this.agentDir);
		const active = this.active;
		const model = active?.session.model;
		return {
			mode: this.mode,
			streaming: this.isStreaming,
			cwd: this.cwd,
			project: this.activeProjectId
				? {
						id: this.activeProjectId,
						name: this.activeProjectName ?? "",
						cwd: this.cwd,
						container: this.activeContainer ?? null,
					}
				: null,
			model: model ? { provider: model.provider, id: model.id } : null,
			modelConfigured: config !== null && model !== undefined,
			thinkingLevel: active?.session.thinkingLevel ?? "off",
			availableThinkingLevels: active?.session.getAvailableThinkingLevels() ?? [],
			activeSessionId: this.currentSessionId,
			// The transcript, not `session.messages`: the latter is the model context,
			// from which a compaction removes everything its summary replaced. The
			// live system prompt comes from the context, because it is not an entry.
			messages: active
				? safeClone(withSystemPrompt(branchTranscript(active.manager.getBranch()), active.session.messages))
				: [],
			pendingApprovals: this.approvals.listPending(),
			allowedPrefixes: this.approvals.getAllowedPrefixes(),
			runningSessions: [...this.sessions.values()]
				.filter((managed) => managed.session.isStreaming)
				.map((managed) => managed.key),
			subagents: this.listSubagents(),
			goal: this.goalView(active),
			// The active session's operator status, read from the branch: a status set
			// in the list must show up here without a second file read.
			sessionStatus: active ? readSessionStatus(active.manager.getBranch()) : null,
			compacting: active?.session.isCompacting ?? false,
			compactionStartedAt: active?.compactionStartedAt ?? null,
		};
	}

	/** Usage and cost statistics for the viewed session. */
	getStats() {
		return this.active?.session.getSessionStats();
	}

	/**
	 * Directory listing of /work. The host side of the mount is read directly;
	 * the container is only consulted for a directory the host user cannot read.
	 */
	async listFiles(path: string): Promise<{ path: string; entries: ZGFileEntry[] }> {
		return await listFiles(this.cwd, path, { container: this.requireContainer() });
	}

	async readFile(path: string): Promise<ZGFilePreview> {
		return await readFilePreview(this.requireContainer(), path);
	}

	async writeFile(path: string, text: string): Promise<{ path: string; size: number }> {
		return await writeFile(this.requireContainer(), path, Buffer.from(text, "utf-8"));
	}

	async uploadFile(path: string, base64: string): Promise<{ path: string; size: number }> {
		return await writeFile(this.requireContainer(), path, Buffer.from(base64, "base64"));
	}

	async downloadFile(path: string): Promise<{ path: string; size: number; data: string }> {
		return await downloadFile(this.requireContainer(), path);
	}

	async deletePath(path: string): Promise<void> {
		await deletePath(this.requireContainer(), path);
	}

	async renamePath(from: string, to: string): Promise<{ from: string; to: string }> {
		return await renamePath(this.requireContainer(), from, to);
	}

	async makeDirectory(path: string): Promise<{ path: string }> {
		return await makeDirectory(this.requireContainer(), path);
	}

	/** Sub-agent runs of the viewed session, newest first, without process steps. */
	listSubagents(): ZGSubagentRun[] {
		const sessionId = this.currentSessionId;
		if (!sessionId) return [];
		return this.subagents.list(sessionId);
	}

	getSubagent(id: string): ZGSubagentRun | undefined {
		return this.subagents.get(id);
	}

	async abortSubagent(id: string): Promise<boolean> {
		return await this.subagents.abort(id);
	}

	async steerSubagent(id: string, text: string): Promise<boolean> {
		return await this.subagents.steer(id, text);
	}

	/**
	 * Findings of the active project plus their counts. The hub is project-scoped:
	 * with no project there is nothing to show, not another project's records.
	 */
	listVulns(filters: ZGVulnFilters = {}): { items: ZGVulnSummary[]; stats: ZGVulnStats } {
		const projectId = this.activeProjectId;
		if (!projectId) return { items: [], stats: emptyVulnStats() };
		return { items: this.vulnerabilities.list(projectId, filters), stats: this.vulnerabilities.stats(projectId) };
	}

	/** One finding, by id or by its human-readable label, inside the active project. */
	getVuln(id: string): ZGVulnerability | undefined {
		return this.activeProjectId ? this.vulnerabilities.find(this.activeProjectId, id) : undefined;
	}

	/** Operator review: status, severity, CVSS, or a note. The agent cannot do this. */
	updateVuln(id: string, patch: ZGVulnUpdate): ZGVulnerability | undefined {
		const vuln = this.getVuln(id);
		if (!vuln) return undefined;
		const updated = this.vulnerabilities.update(vuln.id, patch);
		if (updated) this.hooks.onVulnChange();
		return updated;
	}

	deleteVuln(id: string): boolean {
		const vuln = this.getVuln(id);
		if (!vuln) return false;
		const deleted = this.vulnerabilities.delete(vuln.id);
		if (deleted) this.hooks.onVulnChange();
		return deleted;
	}

	/** Markdown report of the active project's findings. */
	exportVulns(filters: ZGVulnFilters = {}): { filename: string; markdown: string } {
		const projectId = this.activeProjectId;
		const summaries = projectId ? this.vulnerabilities.list(projectId, filters) : [];
		const vulns = summaries
			.map((summary) => this.vulnerabilities.get(summary.id))
			.filter((vuln): vuln is ZGVulnerability => vuln !== undefined);
		return buildVulnReport({
			projectId: projectId ?? "",
			projectName: this.activeProjectName ?? "未命名项目",
			vulns,
		});
	}

	/** How many findings a project holds, so its deletion can state what it takes with it. */
	countProjectVulns(projectId: string): number {
		return this.vulnerabilities.countByProject(projectId);
	}

	/** Deleting a project deletes its findings: they cannot outlive their target scope. */
	purgeProjectVulns(projectId: string): number {
		const deleted = this.vulnerabilities.deleteByProject(projectId);
		if (deleted > 0) this.hooks.onVulnChange();
		return deleted;
	}

	dispose(): void {
		this.approvals.rejectAll("shutdown");
		for (const managed of this.sessions.values()) {
			managed.unsubscribe();
			managed.session.dispose();
		}
		this.sessions.clear();
		this.activeKey = undefined;
		this.subagentStore.close();
		this.vulnerabilities.close();
	}
}

/** First operator instruction, used as the notification subject when unnamed. */
function firstUserText(messages: readonly unknown[]): string | undefined {
	for (const message of messages) {
		if ((message as { role?: string }).role !== "user") continue;
		const text = messageText(message as { content?: unknown }).trim();
		if (text) return text.slice(0, 80);
	}
	return undefined;
}

/** Token and cost counters of a session, in the shape a goal stores them. */
function usageOf(stats: SessionStats | undefined): ZGGoalUsage {
	if (!stats) return emptyUsage();
	return {
		input: stats.tokens.input,
		output: stats.tokens.output,
		total: stats.tokens.total,
		cost: typeof stats.cost === "number" ? stats.cost : null,
	};
}

/** Closing prose of the last assistant message, for the round summary fallback. */
function lastAssistantText(messages: readonly unknown[]): string | undefined {
	const last = [...messages].reverse().find((message) => (message as { role?: string }).role === "assistant");
	return last ? messageText(last as { content?: unknown }) : undefined;
}

function lastAssistantStopReason(messages: readonly unknown[]): string | undefined {
	const last = [...messages].reverse().find((message) => (message as { role?: string }).role === "assistant");
	return (last as { stopReason?: string } | undefined)?.stopReason;
}

/** JSON-clone the message list, dropping it entirely when it is not serializable. */
function safeClone(value: unknown): unknown[] {
	try {
		const cloned = JSON.parse(JSON.stringify(value ?? null)) as unknown;
		return Array.isArray(cloned) ? cloned : [];
	} catch {
		return [];
	}
}
