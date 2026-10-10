/**
 * ZGAgent runtime: owns the live agent sessions, the approval gate, the
 * operator mode, and model-endpoint configuration.
 *
 * Multiple sessions run in parallel: switching the view to another session
 * never stops the previous one — it keeps executing in the background and its
 * transcript is up to date when you switch back. Every bash tool (main or
 * sub-agent, foreground or background session) passes the same approval gate.
 */

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
	type SessionInfo,
	SessionManager,
	type SessionTreeNode,
	SettingsManager,
	type ThinkingLevel,
} from "@earendil-works/pi-coding-agent";
import { ApprovalGate } from "./approval.ts";
import { dockerBashOperations } from "./docker.ts";
import { deletePath, downloadFile, listFiles, makeDirectory, readFilePreview, renamePath, writeFile } from "./files.ts";
import { modelsJsonPath, readModelConfig, writeModelConfig, ZG_PROVIDER_ID } from "./model-config.ts";
import { buildRunNotification, sendDingTalk, shouldNotifyRun, testDingTalk } from "./notify.ts";
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
	ZGMode,
	ZGModelConfig,
	ZGNotifyConfig,
	ZGNotifyStatus,
	ZGStateSnapshot,
	ZGSubagentEvent,
	ZGSubagentRun,
	ZGTestResult,
	ZGToolInfo,
} from "./protocol.ts";
import { createSubagentTool } from "./subagent.ts";
import { SubagentStore, subagentDbPath } from "./subagent-store.ts";
import { SubagentRegistry } from "./subagents.ts";

export interface ZGRuntimeHooks {
	/** Events of the currently viewed session only. */
	onSessionEvent(event: AgentSessionEvent): void;
	/** Fired whenever operator-visible state changes (approvals, mode, model, run lifecycle). */
	onStateChange(): void;
	/** One live sub-agent step, for the sub-agent panel. */
	onSubagentEvent(runId: string, event: ZGSubagentEvent): void;
	/** Fired after a notification send, so the settings screen can show its outcome. */
	onNotifyStatus(status: ZGNotifyStatus): void;
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

	private async createSessionInto(manager: SessionManager): Promise<string> {
		// Every tool call runs in the project container; there is no host backend.
		const container = this.requireContainer();
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
		const bash = this.createGatedBash(
			manager.getCwd(),
			() => this.sessionLabel(managed),
			dockerBashOperations(container),
		);

		const permissions = readPermissionsConfig(this.agentDir).main;
		const subagentPermissions = effectiveSubagent(readPermissionsConfig(this.agentDir));
		const { resourceLoader, settingsManager } = await this.createSessionContext(manager.getCwd(), permissions);

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
		const customTools = permissions.spawn_agent
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
							this.createGatedBash(manager.getCwd(), () => "子代理", dockerBashOperations(container)),
						createSessionContext: (appendSystemPrompt) =>
							this.createSessionContext(manager.getCwd(), subagentPermissions, appendSystemPrompt),
					}),
				]
			: [];
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
		// Emits session_start, which connects MCP servers and lets extensions
		// contribute skills and prompt templates.
		await created.session.bindExtensions({});
		managed.key = manager.getSessionId();
		managed.unsubscribe = created.session.subscribe((event) => {
			// Only the viewed session streams events; background sessions run silently.
			if (managed.key === this.activeKey) this.hooks.onSessionEvent(event);
			if (event.type === "agent_settled" || event.type === "agent_end") this.hooks.onStateChange();
			if (event.type === "agent_settled") this.reportRunSettled(managed, event.aborted);
		});
		this.sessions.set(managed.key, managed);
		return managed.key;
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
	 * Forget a project and drop its sessions. Used when the project is deleted:
	 * its container is gone, so nothing of it can run any more. The runtime ends
	 * up with no project, which the console renders as the project-required state.
	 */
	async detachProject(workDir?: string): Promise<void> {
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
		const report = buildRunNotification({
			status,
			projectName: this.activeProjectName ?? "",
			sessionTitle: managed.manager.getSessionName() ?? firstUserText(managed.session.messages) ?? run.instruction,
			durationMs: Date.now() - run.startedAt,
			summary: messageText(last),
			...(status === "failed" && last?.errorMessage ? { error: last.errorMessage } : {}),
			tokens: stats?.tokens
				? { input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total }
				: undefined,
			...(typeof stats?.cost === "number" ? { cost: stats.cost } : {}),
		});
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
			throw error;
		}
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
		await this.active?.session.abort();
	}

	setMode(mode: ZGMode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		if (mode === "auto") this.approvals.rejectAll("switched to auto mode");
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

	async listSessions(): Promise<SessionInfo[]> {
		return SessionManager.list(this.cwd, this.sessionDir || undefined);
	}

	/** Rename any session in the managed session directory by appending a session_info entry. */
	async renameSession(path: string, name: string): Promise<void> {
		const normalized = this.guardSessionPath(path);
		const manager = SessionManager.open(normalized, this.sessionDir || undefined, this.cwd);
		manager.appendSessionInfo(name);
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
		return {
			tree: this.active?.manager.getTree() ?? [],
			leafId: this.active?.manager.getLeafId() ?? null,
			forkPoints: (this.active?.session.getUserMessagesForForking() ?? []).map(({ entryId, text }) => ({
				entryId,
				text,
			})),
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
		const existing = [...this.sessions.values()];
		this.sessions.clear();
		for (const managed of existing) managed.unsubscribe();
		for (const managed of existing) managed.session.dispose();
		this.activeKey = undefined;
		this.modelRuntime = undefined;
		// Recreate each session on the new runtime, restoring the previous view last.
		const order = [...existing];
		const viewed = order.findIndex((managed) => managed.key === this.activeKey);
		if (viewed !== -1) order.push(...order.splice(viewed, 1));
		for (const managed of order) {
			this.activeKey = await this.createSessionInto(managed.manager);
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
		const existing = [...this.sessions.values()];
		const activeKey = this.activeKey;
		this.sessions.clear();
		for (const managed of existing) managed.unsubscribe();
		for (const managed of existing) managed.session.dispose();
		this.activeKey = undefined;
		// Recreate every session, restoring the previously viewed one last.
		const order = [...existing];
		const viewed = order.findIndex((managed) => managed.key === activeKey);
		if (viewed !== -1) order.push(...order.splice(viewed, 1));
		for (const managed of order) {
			this.activeKey = await this.createSessionInto(managed.manager);
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
			messages: active ? safeClone(active.session.messages) : [],
			pendingApprovals: this.approvals.listPending(),
			allowedPrefixes: this.approvals.getAllowedPrefixes(),
			runningSessions: [...this.sessions.values()]
				.filter((managed) => managed.session.isStreaming)
				.map((managed) => managed.key),
			subagents: this.listSubagents(),
		};
	}

	/** Usage and cost statistics for the viewed session. */
	getStats() {
		return this.active?.session.getSessionStats();
	}

	/** Directory listing in the project container's /work. */
	async listFiles(path: string): Promise<{ path: string; entries: ZGFileEntry[] }> {
		return await listFiles(this.requireContainer(), path);
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

	dispose(): void {
		this.approvals.rejectAll("shutdown");
		for (const managed of this.sessions.values()) {
			managed.unsubscribe();
			managed.session.dispose();
		}
		this.sessions.clear();
		this.activeKey = undefined;
		this.subagentStore.close();
	}
}

/** Concatenated text blocks of a message, ignoring thinking and tool calls. */
function messageText(message: { content?: unknown } | undefined): string {
	const content = message?.content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
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

/** JSON-clone the message list, dropping it entirely when it is not serializable. */
function safeClone(value: unknown): unknown[] {
	try {
		const cloned = JSON.parse(JSON.stringify(value ?? null)) as unknown;
		return Array.isArray(cloned) ? cloned : [];
	} catch {
		return [];
	}
}
