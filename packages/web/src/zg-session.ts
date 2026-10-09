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
	createLocalBashOperations,
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
import { modelsJsonPath, readModelConfig, writeModelConfig, ZG_PROVIDER_ID } from "./model-config.ts";
import type { ZGForkPoint, ZGMode, ZGModelConfig, ZGStateSnapshot } from "./protocol.ts";
import { createSubagentTool } from "./subagent.ts";

export interface ZGRuntimeHooks {
	/** Events of the currently viewed session only. */
	onSessionEvent(event: AgentSessionEvent): void;
	/** Fired whenever operator-visible state changes (approvals, mode, model, run lifecycle). */
	onStateChange(): void;
}

interface ManagedSession {
	key: string;
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	manager: SessionManager;
	unsubscribe: () => void;
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
	private readonly startupCwd: string;

	private mode: ZGMode = "review";
	private sessions = new Map<string, ManagedSession>();
	private activeKey: string | undefined;
	private modelRuntime: ModelRuntime | undefined;

	constructor(options: {
		cwd: string;
		agentDir?: string;
		activeProject?: { id: string; name: string; container?: string; cwd?: string };
		hooks: ZGRuntimeHooks;
	}) {
		this.cwd = options.cwd;
		this.startupCwd = options.cwd;
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

	/** Create (or re-create) the viewed session. */
	async init(): Promise<void> {
		this.activeKey = await this.createSessionInto(SessionManager.create(this.cwd, this.sessionDir || undefined));
	}

	/** Activate a container project: sessions live on the host under its workDir, tools exec in the container. */
	async switchProject(project: { id: string; name: string; container?: string; cwd: string }): Promise<void> {
		await this.applyProject(project.id, project.name, project.cwd, project.container);
	}

	/** Leave the active project and fall back to the server's startup directory. */
	async clearProject(): Promise<void> {
		await this.applyProject(undefined, undefined, this.startupCwd, undefined);
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
	private async createSessionInto(manager: SessionManager): Promise<string> {
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
		const operations = this.activeContainer ? dockerBashOperations(this.activeContainer) : undefined;
		const bash = this.createGatedBash(manager.getCwd(), () => this.sessionLabel(managed), operations);

		// The CLI loads codemode, tool search, and MCP as built-in extensions; SDK
		// sessions have to add them explicitly. codemode and tool_search register
		// inactive, so the default-tools override below activates them while keeping
		// the coding tools. The MCP extension reads mcp.json from the agent directory
		// and connects its servers on session_start, which `bindExtensions` emits.
		const resourceLoader = new DefaultResourceLoader({
			cwd: manager.getCwd(),
			agentDir: this.agentDir,
			extensionFactories: [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()],
		});
		await resourceLoader.reload();

		const settingsManager = SettingsManager.create(manager.getCwd(), this.agentDir);
		// Modifier-only entries append to the configured default tools instead of
		// replacing them, so an operator's own `defaultTools` setting still applies.
		settingsManager.applyOverrides({ defaultTools: ["+codemode", "+tool_search"] });

		// `baseToolsOverride` replaces the whole base tool set, so the default coding
		// tools must be listed explicitly alongside the gated bash. Passing only bash
		// would leave the session with bash and the custom tools, and the system
		// prompt's tool section would degrade to the custom tools alone.
		const created = await createAgentSession({
			cwd: manager.getCwd(),
			agentDir: this.agentDir,
			modelRuntime: this.modelRuntime,
			model,
			sessionManager: manager,
			resourceLoader,
			settingsManager,
			baseToolsOverride: {
				read: createReadTool(manager.getCwd()),
				bash,
				edit: createEditTool(manager.getCwd()),
				write: createWriteTool(manager.getCwd()),
			},
			customTools: [
				createSubagentTool({
					cwd: manager.getCwd(),
					agentDir: this.agentDir,
					getModel: () => this.resolveModel(),
					getModelRuntime: () => this.modelRuntime,
					createGatedBash: () =>
						this.createGatedBash(
							manager.getCwd(),
							() => "子代理",
							this.activeContainer ? dockerBashOperations(this.activeContainer) : undefined,
						),
				}),
			],
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
		});
		this.sessions.set(managed.key, managed);
		return managed.key;
	}

	private sessionLabel(managed: ManagedSession): string {
		const name = managed.manager.getSessionName();
		return name ? `${name} · 主代理` : "主代理";
	}

	/** Bash tool whose every command passes the shared approval gate (unless prefix-allowed). */
	private createGatedBash(cwd: string, label: () => string, operations?: BashOperations) {
		const localOps = operations ?? createLocalBashOperations();
		const gatedOps: BashOperations = {
			exec: (command, commandCwd, options) => {
				// Prefix-allowed commands skip the queue; everything else waits for a decision.
				if (this.mode !== "review" || this.approvals.isAutoAllowed(command)) {
					return localOps.exec(command, commandCwd, options);
				}
				return this.approvals
					.request(command, commandCwd, options?.signal, label())
					.then((outcome) =>
						outcome.approved && outcome.command !== undefined
							? localOps.exec(outcome.command, commandCwd, options)
							: Promise.reject(new Error(`Command not executed: ${outcome.reason ?? "rejected"}`)),
					);
			},
		};
		return createBashTool(cwd, { operations: gatedOps });
	}

	private resolveModel() {
		const config = readModelConfig(this.agentDir);
		if (!config || !this.modelRuntime) return undefined;
		return this.modelRuntime.getModel(ZG_PROVIDER_ID, config.modelId);
	}

	/** Escape hatch for tests: host-dir sessions without a container project. */
	private get allowHostSessions(): boolean {
		return process.env.ZG_ALLOW_HOST_SESSIONS === "1";
	}

	async prompt(text: string, streamingBehavior?: "steer" | "followUp", images?: ImageContent[]): Promise<void> {
		const active = this.active;
		if (!active) throw new Error("Session not initialized");
		if (!this.activeContainer && !this.allowHostSessions) {
			throw new Error("没有可用的项目容器。请先在左上角创建或选择一个项目。");
		}
		// pi's built-in slash commands only exist in interactive mode, so the console
		// honors the one its own context-overflow hint references.
		if (text.trim() === "/compact") {
			await this.compact();
			return;
		}
		await active.session.prompt(text, {
			...(streamingBehavior ? { streamingBehavior } : {}),
			...(images && images.length > 0 ? { images } : {}),
		});
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
		};
	}

	/** Usage and cost statistics for the viewed session. */
	getStats() {
		return this.active?.session.getSessionStats();
	}

	dispose(): void {
		this.approvals.rejectAll("shutdown");
		for (const managed of this.sessions.values()) {
			managed.unsubscribe();
			managed.session.dispose();
		}
		this.sessions.clear();
		this.activeKey = undefined;
	}
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
