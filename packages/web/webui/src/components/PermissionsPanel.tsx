/**
 * The permissions page.
 *
 * Two columns of switches, one per agent, plus a read-only inventory of what the
 * live session actually mounted. The inventory matters: the switches are
 * enforced by dropping tools at registration, so the only way to be sure they
 * did what they say is to look at the result.
 *
 * A sub-agent can never hold a tool the main agent does not have, so a switch
 * the main agent turned off is shown disabled here rather than silently
 * ignored.
 *
 * The MCP switch opens into one switch per configured server, because "MCP on"
 * is too coarse to be useful: an operator who wants the local filesystem server
 * but not the one holding production credentials has no way to say so with a
 * single switch.
 */

import { Fragment, useEffect, useState } from "react";
import type {
	SentinelCommanderPermissionKey,
	SentinelMcpServerView,
	SentinelPermissionKey,
	SentinelPermissionPreset,
	SentinelPermissionSet,
	SentinelPermissionsConfig,
	SentinelToolInfo,
} from "../types.ts";
import { mcpServerState, mountReason, TRANSPORT_LABELS } from "./McpPanel.tsx";
import { RefreshIcon } from "./icons.tsx";

/** Order and wording of the switches; spawn_agent is main-agent only. */
const SWITCHES: { key: SentinelPermissionKey; label: string; hint: string; subagent: boolean }[] = [
	{ key: "read", label: "read", hint: "读取工作目录中的文件内容", subagent: true },
	{ key: "bash", label: "bash", hint: "在项目容器内执行命令（审批模式仍逐条确认）", subagent: true },
	{ key: "edit", label: "edit", hint: "对已有文件做精确文本替换", subagent: true },
	{ key: "write", label: "write", hint: "新建或整体覆盖文件", subagent: true },
	{ key: "codemode", label: "codemode", hint: "脚本编排，只能调用上面已允许的工具", subagent: true },
	{ key: "tool_search", label: "tool_search", hint: "检索并加载尚未声明的工具，禁用的搜不到", subagent: true },
	{
		key: "mcp",
		label: "MCP",
		hint: "连接「设置 → MCP」中配置的服务器并使用它们的工具（项目目录与配置目录里的 mcp.json 都不读）",
		subagent: true,
	},
	{ key: "spawn_agent", label: "spawn_agent", hint: "派生子代理并行执行；子代理永远不能再派生", subagent: false },
	{
		key: "poc_read",
		label: "poc_search / poc_read",
		hint: "检索 POC 库（只读参考：模板不进容器，要执行需自己写 yaml 后用 bash 跑 nuclei）",
		subagent: true,
	},
	{
		key: "web_search",
		label: "web_search / web_extract",
		hint: "用 Tavily 号池做公网 Web 搜索与页面抓取（设置 → Web 搜索 管理 Key，按剩余额度自动轮换）",
		subagent: true,
	},
];

const SUBAGENT_SWITCHES = SWITCHES.filter((item) => item.subagent);

/** The engineering-mode commander's switches: its scheduling tools are always mounted. */
const COMMANDER_SWITCHES: { key: SentinelCommanderPermissionKey; label: string; hint: string }[] = [
	{
		key: "bash",
		label: "bash（受限）",
		hint: "项目容器内执行命令，仅用于拆解任务前的一次性轻量确认；受每工程 40 条预算、单条 20 秒超时、输出截断与破坏性命令拦截约束",
	},
	{ key: "read", label: "read", hint: "读取项目工作目录中的文件（只读，不能修改）" },
];

export function PermissionsPanel({
	config,
	presets,
	tools,
	mcpServers,
	mcpBusy,
	busy,
	onSave,
	onRefresh,
	onToggleMcpServer,
}: {
	config: SentinelPermissionsConfig;
	presets: SentinelPermissionPreset[];
	tools: SentinelToolInfo[];
	/**
	 * The custom MCP servers, so the MCP switch can be narrowed to individual ones.
	 * Null until the MCP view arrives, which is a different state from "none configured".
	 */
	mcpServers: SentinelMcpServerView[] | null;
	/** A per-server switch is in flight; it rebuilds sessions like a save does. */
	mcpBusy: boolean;
	busy: boolean;
	onSave: (config: SentinelPermissionsConfig) => void;
	onRefresh: () => void;
	onToggleMcpServer: (name: string, enabled: boolean) => void;
}) {
	const [draft, setDraft] = useState<SentinelPermissionsConfig>(config);

	// Follow the server whenever it reports a different configuration, so a save
	// from another window (or a rejected save) cannot leave stale switches here.
	useEffect(() => {
		setDraft(config);
	}, [config]);

	const dirty = JSON.stringify(draft) !== JSON.stringify(config);

	const toggle = (agent: "main" | "subagent", key: SentinelPermissionKey) => {
		setDraft((prev) => {
			const next: SentinelPermissionsConfig = {
				main: { ...prev.main },
				subagent: { ...prev.subagent },
				commander: { ...prev.commander },
				subagentMaxTurns: prev.subagentMaxTurns,
			};
			next[agent][key] = !prev[agent][key];
			if (agent === "main" && !next.main[key] && key !== "spawn_agent") {
				// The subset rule: a sub-agent cannot hold what the main agent lost.
				next.subagent[key] = false;
			}
			return next;
		});
	};

	const toggleCommander = (key: SentinelCommanderPermissionKey) => {
		setDraft((prev) => ({
			main: prev.main,
			subagent: prev.subagent,
			commander: { ...prev.commander, [key]: !prev.commander[key] },
			subagentMaxTurns: prev.subagentMaxTurns,
		}));
	};

	const applyPreset = (preset: SentinelPermissionPreset) => {
		setDraft((prev) => ({
			main: { ...preset.main },
			subagent: { ...preset.subagent },
			commander: { ...preset.commander },
			subagentMaxTurns: prev.subagentMaxTurns,
		}));
	};

	const setMaxTurns = (value: number) => {
		setDraft((prev) => ({ ...prev, subagentMaxTurns: value }));
	};

	const disabledCount = (set: SentinelPermissionSet) => SWITCHES.filter((item) => item.subagent && !set[item.key]).length;

	const switchRow = (agent: "main" | "subagent", item: (typeof SWITCHES)[number]) => {
		const on = draft[agent][item.key];
		const blockedByParent = agent === "subagent" && !draft.main[item.key];
		return (
			<label key={item.key} className={`perm-switch ${on ? "on" : ""} ${blockedByParent ? "blocked" : ""}`}>
				<input
					type="checkbox"
					checked={on}
					disabled={busy || blockedByParent}
					onChange={() => toggle(agent, item.key)}
				/>
				<span className="perm-switch-body">
					<span className="perm-switch-name">{item.label}</span>
					<span className="perm-switch-hint">
						{blockedByParent ? "主 Agent 已禁用，子 Agent 无法单独开启" : item.hint}
					</span>
				</span>
			</label>
		);
	};

	/**
	 * The MCP switch, narrowed to individual servers.
	 *
	 * These rows are not a second switch: they read and write the same `enabled` field
	 * the MCP page's 启用 does, so the two pages cannot disagree. They stay operable with
	 * the master switch off, which is how a server is staged before MCP is allowed at all.
	 */
	const mcpServerRows = (
		<div className="perm-mcp">
			{mcpServers === null ? (
				<p className="perm-mcp-note">正在读取 MCP 配置…</p>
			) : mcpServers.length === 0 ? (
				<p className="perm-mcp-note">还没有配置服务器（设置 → MCP）。</p>
			) : (
				<>
					<p className="perm-mcp-note">
						逐个服务器控制。这里的开关就是「设置 → MCP」的启用，对所有 Agent 生效。
					</p>
					{mcpServers.map((server) => {
						const state = mcpServerState(server);
						return (
							<label key={server.name} className={`perm-mcp-row ${server.enabled ? "on" : ""}`}>
								<input
									type="checkbox"
									checked={server.enabled}
									disabled={busy || mcpBusy}
									onChange={() => onToggleMcpServer(server.name, !server.enabled)}
								/>
								<span className="perm-mcp-body">
									<span className="perm-mcp-name">
										{server.name}
										<span className="perm-mcp-transport">{TRANSPORT_LABELS[server.transport]}</span>
									</span>
									<span className="perm-mcp-hint" title={server.target}>
										{draft.main.mcp
											? state === "mounted"
												? server.target
												: mountReason(server)
											: "主开关已关闭：全部不挂载"}
									</span>
								</span>
							</label>
						);
					})}
				</>
			)}
		</div>
	);

	return (
		<div className="perm">
			<p className="settings-hint">
				工具在会话创建时挂载，被禁用的工具会从注册表里移除：模型看不到、tool_search 搜不到、codemode 也调不到。
				保存后会立即重建当前会话（历史保留）；有会话正在运行时会拒绝保存，请先中止。
			</p>

			<div className="perm-presets">
				<span className="perm-presets-label">预设</span>
				{presets.map((preset) => (
					<button
						key={preset.id}
						type="button"
						className="ghost small"
						title={preset.hint}
						disabled={busy}
						onClick={() => applyPreset(preset)}
					>
						{preset.label}
					</button>
				))}
				<span className="perm-presets-hint">
					{dirty ? "有未保存的修改" : `主 Agent 已禁用 ${disabledCount(draft.main)} 项`}
				</span>
				<span className="composer-spacer" />
				<button
					type="button"
					className="ghost small"
					onClick={onRefresh}
					disabled={busy}
					title="重新读取已挂载工具"
				>
					<RefreshIcon />
					刷新清单
				</button>
				<button
					type="button"
					className="primary"
					disabled={busy || !dirty}
					onClick={() =>
						onSave({
							main: { ...draft.main },
							subagent: { ...draft.subagent },
							commander: { ...draft.commander },
							subagentMaxTurns: draft.subagentMaxTurns,
						})
					}
				>
					保存并重建会话
				</button>
			</div>

			<div className="perm-columns">
				<section className="perm-column">
					<h3>主 Agent</h3>
					{SWITCHES.map((item) => (
						<Fragment key={item.key}>
							{switchRow("main", item)}
							{item.key === "mcp" ? mcpServerRows : null}
						</Fragment>
					))}
				</section>
				<section className="perm-column">
					<h3>子 Agent</h3>
					<p className="perm-column-note">子代理的权限永远不超过主 Agent，且永远不能再派生子代理。</p>
					{SUBAGENT_SWITCHES.map((item) => switchRow("subagent", item))}
					<label className="perm-switch">
						<span className="perm-switch-body">
							<span className="perm-switch-name">轮次上限</span>
							<span className="perm-switch-hint">单个子代理最多执行的轮数，达到后中止并汇报已有结果</span>
						</span>
						<input
							type="number"
							className="perm-number"
							min={1}
							max={200}
							value={draft.subagentMaxTurns}
							disabled={busy}
							onChange={(event) => {
								const value = Math.round(Number(event.target.value));
								if (Number.isFinite(value)) setMaxTurns(value);
							}}
						/>
					</label>
				</section>
				<section className="perm-column perm-column--tools">
					<h3>当前已挂载工具 ({tools.length})</h3>
					{tools.length === 0 ? (
						<p className="perm-column-note">当前没有会话（先选择项目），或所有工具都被禁用。</p>
					) : (
						<ul className="perm-tools">
							{tools.map((tool) => (
								<li key={tool.name} className={tool.active ? "" : "dim"}>
									<code>{tool.name}</code>
									<span>{tool.source}</span>
									{tool.active ? null : <span className="perm-tool-note">按需加载</span>}
								</li>
							))}
						</ul>
					)}
				</section>
			</div>

			<section className="perm-commander">
				<h3>指挥官（工程模式）</h3>
				<p className="perm-column-note">
					指挥官的调度工具（dispatch_task
					等）始终挂载；这里控制的是它拆解任务用的受限执行面。修改在指挥官会话下次创建时生效（新建或恢复工程），运行中的工程不受影响。
				</p>
				<div className="perm-commander-switches">
					{COMMANDER_SWITCHES.map((item) => (
						<label key={item.key} className={`perm-switch ${draft.commander[item.key] ? "on" : ""}`}>
							<input
								type="checkbox"
								checked={draft.commander[item.key]}
								disabled={busy}
								onChange={() => toggleCommander(item.key)}
							/>
							<span className="perm-switch-body">
								<span className="perm-switch-name">{item.label}</span>
								<span className="perm-switch-hint">{item.hint}</span>
							</span>
						</label>
					))}
					{draft.commander.bash ? null : (
						<p className="perm-column-note">
							bash 已关闭：指挥官将完全基于目标清单与任务结果摘要编排，不能再自行确认目标类型。
						</p>
					)}
				</div>
			</section>

			{draft.main.bash || draft.main.edit || draft.main.write ? null : (
				<p className="perm-warn">
					当前配置下 Agent 不能执行命令，也不能修改文件：适合只读侦察。如果它需要落地脚本或证据文件，请至少开启
					write。
				</p>
			)}
		</div>
	);
}
