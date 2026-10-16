/**
 * Agent tool permissions, persisted in permissions.json.
 *
 * Tools are mounted when a session is created, so a permission change rebuilds
 * the session. Enforcement goes through the SDK's `excludeTools` denylist,
 * which drops a tool at registration time: it is never declared to the model,
 * `tool_search` cannot activate it, a transcript cannot restore it, and a
 * codemode script cannot call it. Disabling a tool here is therefore a real
 * restriction, not a hidden button.
 *
 * A sub-agent's permissions are always a subset of the main agent's. Without
 * that rule, turning bash off for the main agent would not stop it from
 * spawning a sub-agent that has bash, which would make the switch meaningless.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Every switch the permissions screen offers. */
export type SentinelPermissionKey =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "codemode"
	| "tool_search"
	| "mcp"
	| "spawn_agent"
	| "vuln_submit"
	| "vuln_read"
	| "poc_read"
	| "asset_read";

export const PERMISSION_KEYS: readonly SentinelPermissionKey[] = [
	"read",
	"bash",
	"edit",
	"write",
	"codemode",
	"tool_search",
	"mcp",
	"spawn_agent",
	"vuln_submit",
	"vuln_read",
	"poc_read",
	"asset_read",
];

/** Keys a sub-agent can hold at all: delegation never recurses. */
export const SUBAGENT_PERMISSION_KEYS: readonly SentinelPermissionKey[] = PERMISSION_KEYS.filter(
	(key) => key !== "spawn_agent",
);

/** The switches of one agent. Missing entries mean "not allowed". */
export type SentinelPermissionSet = Record<SentinelPermissionKey, boolean>;

/**
 * The engineering-mode commander's switches. Its scheduling tools
 * (dispatch_task and friends) are its essence and always mounted; what the
 * operator controls is the fenced execution surface it gets for scoping
 * targets: bash (budgeted, timeout, denylisted by the engine) and read.
 */
export type SentinelCommanderPermissionKey = "bash" | "read";

export type SentinelCommanderPermissionSet = Record<SentinelCommanderPermissionKey, boolean>;

export const COMMANDER_PERMISSION_KEYS: readonly SentinelCommanderPermissionKey[] = ["bash", "read"];

export const COMMANDER_PERMISSION_LABELS: Record<SentinelCommanderPermissionKey, string> = {
	bash: "bash 执行命令（受限）",
	read: "read 读取文件",
};

export const COMMANDER_PERMISSION_HINTS: Record<SentinelCommanderPermissionKey, string> = {
	bash: "在项目容器内执行命令，用于拆解任务前的一次性轻量确认；受每工程 40 条预算、单条 20 秒超时、输出截断与破坏性命令拦截约束",
	read: "读取项目工作目录中的文件（只读，不能修改）",
};

export interface SentinelPermissionsConfig {
	main: SentinelPermissionSet;
	subagent: SentinelPermissionSet;
	commander: SentinelCommanderPermissionSet;
	/** Turn budget before one sub-agent run is aborted. */
	subagentMaxTurns: number;
}

/** Defaults and bounds of the sub-agent turn budget. */
export const DEFAULT_SUBAGENT_MAX_TURNS = 40;
export const MIN_SUBAGENT_MAX_TURNS = 1;
export const MAX_SUBAGENT_MAX_TURNS = 200;

/** One-click permission bundles offered above the switches. */
export interface SentinelPermissionPreset {
	id: string;
	label: string;
	hint: string;
	main: SentinelPermissionSet;
	subagent: SentinelPermissionSet;
	commander: SentinelCommanderPermissionSet;
}

export const PERMISSION_LABELS: Record<SentinelPermissionKey, string> = {
	read: "read 读取文件",
	bash: "bash 执行命令",
	edit: "edit 精确编辑",
	write: "write 写入文件",
	codemode: "codemode 脚本编排",
	tool_search: "tool_search 工具检索",
	mcp: "MCP 工具",
	spawn_agent: "spawn_agent 派生子代理",
	vuln_submit: "vuln_submit 提交漏洞",
	vuln_read: "vuln_list / vuln_get 查询漏洞",
	poc_read: "poc_search / poc_read 检索 POC 库",
	asset_read: "fofa_search / quake_search / hunter_search 资产测绘",
};

export const PERMISSION_HINTS: Record<SentinelPermissionKey, string> = {
	read: "读取工作目录中的文件内容",
	bash: "在项目容器内执行命令（审批模式仍会逐条确认）",
	edit: "对已有文件做精确文本替换",
	write: "新建或整体覆盖文件",
	codemode: "在沙箱脚本里批量调用上面已允许的工具，不会额外放行被禁用的工具",
	tool_search: "按需检索并加载尚未声明的工具（含 MCP 工具），被禁用的工具搜不到",
	mcp: "连接「设置 → MCP」中配置的 MCP 服务器并使用它们的工具（项目目录与配置目录里的 mcp.json 都不读）",
	spawn_agent: "把独立子任务委派给隔离子代理并行执行",
	vuln_submit: "把已验证的漏洞提交到当前项目的漏洞中枢（原始数据包、CVSS 评分一并提交）",
	vuln_read: "查询当前项目已记录的漏洞，避免重复提交并在总结中引用编号",
	poc_read: "检索操作员导入的 Nuclei POC 库（只读参考；要执行需自己写 yaml 并用 bash 跑 nuclei）",
	asset_read:
		"用操作员配置的 FOFA / 360 Quake / 奇安信 Hunter 账号做互联网资产测绘（由控制台代发请求，密钥不进容器；只有已启用并通过验证的平台才会挂载）",
};

function fullSet(): SentinelPermissionSet {
	return {
		read: true,
		bash: true,
		edit: true,
		write: true,
		codemode: true,
		tool_search: true,
		mcp: true,
		spawn_agent: true,
		vuln_submit: true,
		vuln_read: true,
		poc_read: true,
		asset_read: true,
	};
}

function emptySet(): SentinelPermissionSet {
	return {
		read: false,
		bash: false,
		edit: false,
		write: false,
		codemode: false,
		tool_search: false,
		mcp: false,
		spawn_agent: false,
		vuln_submit: false,
		vuln_read: false,
		poc_read: false,
		asset_read: false,
	};
}

/**
 * Read-only reconnaissance: read files, query MCP servers and read the hub, but
 * run nothing and write nothing — including no new findings, because submitting
 * is a write.
 */
function reconSet(): SentinelPermissionSet {
	return {
		...emptySet(),
		read: true,
		codemode: true,
		tool_search: true,
		mcp: true,
		spawn_agent: true,
		vuln_read: true,
		poc_read: true,
		asset_read: true,
	};
}

export const PERMISSION_PRESETS: readonly SentinelPermissionPreset[] = [
	{
		id: "standard",
		label: "标准",
		hint: "全部工具可用，和默认行为一致",
		main: fullSet(),
		subagent: { ...fullSet(), spawn_agent: false },
		commander: { bash: true, read: true },
	},
	{
		id: "recon",
		label: "只读侦察",
		hint: "只读文件与 MCP 查询，不能执行命令、不能改文件；子代理同样只读，指挥官只保留 read",
		main: reconSet(),
		subagent: { ...reconSet(), spawn_agent: false },
		commander: { bash: false, read: true },
	},
	{
		id: "locked",
		label: "全部禁用",
		hint: "不挂载任何工具，只保留纯对话",
		main: emptySet(),
		subagent: emptySet(),
		commander: { bash: false, read: false },
	},
];

export function defaultPermissions(): SentinelPermissionsConfig {
	return {
		main: fullSet(),
		subagent: { ...fullSet(), spawn_agent: false },
		commander: { bash: true, read: true },
		subagentMaxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
	};
}

/**
 * Coerce a stored value into a usable config: unknown keys are dropped, a
 * sub-agent never gets more than the main agent, and it never gets
 * spawn_agent.
 *
 * A switch the stored object does not mention is off, not defaulted on. The file
 * predates that switch, so the operator has never agreed to it; adding a new tool
 * must not silently widen an existing configuration. A missing or unreadable file
 * still reads as the full defaults, because that is a fresh install.
 */
export function normalizePermissions(raw: unknown): SentinelPermissionsConfig {
	const defaults = defaultPermissions();
	const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const readSet = (value: unknown, fallback: SentinelPermissionSet): SentinelPermissionSet => {
		if (typeof value !== "object" || value === null) return { ...fallback };
		const source = value as Record<string, unknown>;
		const set = emptySet();
		for (const key of PERMISSION_KEYS) {
			set[key] = source[key] === true;
		}
		return set;
	};
	const main = readSet(record.main, defaults.main);
	const subagent = readSet(record.subagent, defaults.subagent);
	// The commander section follows the same rule as every other switch: a file
	// that predates it never agreed to it, so an absent section reads as off.
	const commander: SentinelCommanderPermissionSet = { bash: false, read: false };
	if (typeof record.commander === "object" && record.commander !== null) {
		const source = record.commander as Record<string, unknown>;
		for (const key of COMMANDER_PERMISSION_KEYS) {
			commander[key] = source[key] === true;
		}
	}
	return {
		main,
		subagent: effectiveSubagent({ main, subagent }),
		commander,
		subagentMaxTurns: coerceTurns(record.subagentMaxTurns),
	};
}

/** Clamp the stored turn budget into its usable range; a bad value reads as the default. */
function coerceTurns(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SUBAGENT_MAX_TURNS;
	const rounded = Math.round(value);
	if (rounded < MIN_SUBAGENT_MAX_TURNS) return MIN_SUBAGENT_MAX_TURNS;
	if (rounded > MAX_SUBAGENT_MAX_TURNS) return MAX_SUBAGENT_MAX_TURNS;
	return rounded;
}

/** What a sub-agent actually receives: the main agent's set, minus spawn_agent. */
export function effectiveSubagent(config: Pick<SentinelPermissionsConfig, "main" | "subagent">): SentinelPermissionSet {
	const set = emptySet();
	for (const key of SUBAGENT_PERMISSION_KEYS) {
		set[key] = config.main[key] && config.subagent[key];
	}
	return set;
}

/** MCP resource tools reach every server, so they follow the MCP switch. */
const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/**
 * The denylist handed to the SDK. Patterns are supported, so one entry covers
 * every tool of every MCP server.
 */
export function excludeToolsFor(set: SentinelPermissionSet): string[] {
	const excluded: string[] = [];
	for (const key of ["read", "bash", "edit", "write", "codemode", "tool_search", "spawn_agent"] as const) {
		if (!set[key]) excluded.push(key);
	}
	// The hub's switches are not 1:1 with tool names: reading covers two tools.
	if (!set.vuln_submit) excluded.push("vuln_submit");
	if (!set.vuln_read) excluded.push("vuln_list", "vuln_get");
	if (!set.poc_read) excluded.push("poc_search", "poc_read");
	if (!set.asset_read) excluded.push("fofa_search", "quake_search", "hunter_search");
	if (!set.mcp) excluded.push("mcp__*", ...MCP_RESOURCE_TOOLS);
	return excluded;
}

/** Names the console can report without knowing the full tool registry. */
export function describePermissions(set: SentinelPermissionSet): string {
	const off = PERMISSION_KEYS.filter((key) => !set[key]).map((key) => key);
	return off.length === 0 ? "全部启用" : `已禁用：${off.join("、")}`;
}

export function permissionsJsonPath(agentDir: string): string {
	return join(agentDir, "permissions.json");
}

export function readPermissionsConfig(agentDir: string): SentinelPermissionsConfig {
	const path = permissionsJsonPath(agentDir);
	if (!existsSync(path)) return defaultPermissions();
	try {
		return normalizePermissions(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		// A corrupt file must not lock the console out of its own tools.
		return defaultPermissions();
	}
}

export function writePermissionsConfig(agentDir: string, config: SentinelPermissionsConfig): void {
	const normalized = normalizePermissions(config);
	writeFileSync(permissionsJsonPath(agentDir), `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
}
