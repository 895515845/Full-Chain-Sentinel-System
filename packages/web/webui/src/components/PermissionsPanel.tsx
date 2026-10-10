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
 */

import { useEffect, useState } from "react";
import type { ZGPermissionKey, ZGPermissionSet, ZGPermissionsConfig, ZGPermissionPreset, ZGToolInfo } from "../types.ts";
import { RefreshIcon } from "./icons.tsx";

/** Order and wording of the switches; spawn_agent is main-agent only. */
const SWITCHES: { key: ZGPermissionKey; label: string; hint: string; subagent: boolean }[] = [
	{ key: "read", label: "read", hint: "读取工作目录中的文件内容", subagent: true },
	{ key: "bash", label: "bash", hint: "在项目容器内执行命令（审批模式仍逐条确认）", subagent: true },
	{ key: "edit", label: "edit", hint: "对已有文件做精确文本替换", subagent: true },
	{ key: "write", label: "write", hint: "新建或整体覆盖文件", subagent: true },
	{ key: "codemode", label: "codemode", hint: "脚本编排，只能调用上面已允许的工具", subagent: true },
	{ key: "tool_search", label: "tool_search", hint: "检索并加载尚未声明的工具，禁用的搜不到", subagent: true },
	{ key: "mcp", label: "MCP", hint: "连接 mcp.json 中的 MCP 服务器并使用其工具", subagent: true },
	{ key: "spawn_agent", label: "spawn_agent", hint: "派生子代理并行执行；子代理永远不能再派生", subagent: false },
];

const SUBAGENT_SWITCHES = SWITCHES.filter((item) => item.subagent);

export function PermissionsPanel({
	config,
	presets,
	tools,
	busy,
	onSave,
	onRefresh,
}: {
	config: ZGPermissionsConfig;
	presets: ZGPermissionPreset[];
	tools: ZGToolInfo[];
	busy: boolean;
	onSave: (config: ZGPermissionsConfig) => void;
	onRefresh: () => void;
}) {
	const [draft, setDraft] = useState<ZGPermissionsConfig>(config);

	// Follow the server whenever it reports a different configuration, so a save
	// from another window (or a rejected save) cannot leave stale switches here.
	useEffect(() => {
		setDraft(config);
	}, [config]);

	const dirty = JSON.stringify(draft) !== JSON.stringify(config);

	const toggle = (agent: "main" | "subagent", key: ZGPermissionKey) => {
		setDraft((prev) => {
			const next: ZGPermissionsConfig = {
				main: { ...prev.main },
				subagent: { ...prev.subagent },
			};
			next[agent][key] = !prev[agent][key];
			if (agent === "main" && !next.main[key] && key !== "spawn_agent") {
				// The subset rule: a sub-agent cannot hold what the main agent lost.
				next.subagent[key] = false;
			}
			return next;
		});
	};

	const applyPreset = (preset: ZGPermissionPreset) => {
		setDraft({ main: { ...preset.main }, subagent: { ...preset.subagent } });
	};

	const disabledCount = (set: ZGPermissionSet) =>
		SWITCHES.filter((item) => item.subagent && !set[item.key]).length;

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
					<span className="perm-switch-hint">{blockedByParent ? "主 Agent 已禁用，子 Agent 无法单独开启" : item.hint}</span>
				</span>
			</label>
		);
	};

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
				<button type="button" className="ghost small" onClick={onRefresh} disabled={busy} title="重新读取已挂载工具">
					<RefreshIcon />
					刷新清单
				</button>
				<button
					type="button"
					className="primary"
					disabled={busy || !dirty}
					onClick={() => onSave({ main: { ...draft.main }, subagent: { ...draft.subagent } })}
				>
					保存并重建会话
				</button>
			</div>

			<div className="perm-columns">
				<section className="perm-column">
					<h3>主 Agent</h3>
					{SWITCHES.map((item) => switchRow("main", item))}
				</section>
				<section className="perm-column">
					<h3>子 Agent</h3>
					<p className="perm-column-note">子代理的权限永远不超过主 Agent，且永远不能再派生子代理。</p>
					{SUBAGENT_SWITCHES.map((item) => switchRow("subagent", item))}
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

			{draft.main.bash || draft.main.edit || draft.main.write ? null : (
				<p className="perm-warn">
					当前配置下 Agent 不能执行命令，也不能修改文件：适合只读侦察。如果它需要落地脚本或证据文件，请至少开启 write。
				</p>
			)}
		</div>
	);
}
