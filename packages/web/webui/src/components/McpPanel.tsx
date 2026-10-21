import { useEffect, useRef, useState } from "react";
import type {
	SentinelMcpConfigView,
	SentinelMcpExposure,
	SentinelMcpServerInput,
	SentinelMcpServerView,
	SentinelMcpTestResult,
	SentinelMcpTransport,
} from "../types.ts";
import { getLanguage, t } from "../i18n.ts";

/** Exposure labels and what each one does to the model's tool list. */
const EXPOSURE_OPTIONS: { value: SentinelMcpExposure; label: string; hint: string }[] = [
	{
		value: "codemode",
		label: t("脚本调用（codemode）"),
		hint: t("默认。工具不进模型的工具列表，由 codemode 脚本用 searchTools() 找到后调用。"),
	},
	{
		value: "deferred",
		label: t("按需加载（tool_search）"),
		hint: t("模型先用 tool_search 加载，再直接调用，不需要 codemode。"),
	},
	{ value: "direct", label: t("直接声明"), hint: t("像内置工具一样直接出现在模型的工具列表里，最省事也最占上下文。") },
	{ value: "hidden", label: t("隐藏"), hint: t("连接但不给任何调用入口。") },
];

/**
 * Shown while the SSE transport is selected. The two url transports look alike
 * from here, so the difference worth naming is which one the server speaks.
 */
const SSE_HINT = t(
	"旧版 HTTP+SSE（MCP 2024-11-05）：哨兵先建立 SSE 长连接，由服务器在首个 endpoint 事件里给出消息地址，回复也从这条连接回来。若服务器提供 streamable HTTP（通常是把 /sse 换成 /mcp），优先用 HTTP。",
);

/**
 * Which of the three states a server is in. Single source for both the row's
 * badge and the sentence explaining whether the agent can reach it, so the two
 * can never disagree.
 */
export type McpServerState = "mounted" | "disabled" | "unacknowledged";

const STATE_LABELS: Record<McpServerState, string> = {
	mounted: t("已挂载"),
	disabled: t("未启用"),
	unacknowledged: t("未确认"),
};

const STATE_TONES: Record<McpServerState, string> = {
	mounted: "ok",
	disabled: "off",
	unacknowledged: "bad",
};

/** Transport names, shared with the permissions page so the two cannot drift apart. */
export const TRANSPORT_LABELS: Record<SentinelMcpTransport, string> = {
	stdio: "stdio",
	http: "HTTP",
	sse: "SSE",
};

export function mcpServerState(server: SentinelMcpServerView): McpServerState {
	if (!server.enabled) return "disabled";
	if (server.transport === "stdio" && !server.hostExecAcknowledged) return "unacknowledged";
	return "mounted";
}

/** Why a server contributes nothing, phrased for the operator. */
export function mountReason(server: SentinelMcpServerView): string {
	switch (mcpServerState(server)) {
		case "mounted":
			return t("会话启动时会连接它，工具注册为 mcp__{name}__<工具名>", { name: server.name.replace(/-/g, "_") });
		case "disabled":
			return t("已停用：不连接、不注册工具，Agent 看不到它");
		default:
			return t("未勾选宿主机执行确认：不连接、不注册工具");
	}
}

/** One line per argument. */
export function parseArgsText(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

export function formatArgsText(args: string[]): string {
	return args.join("\n");
}

/**
 * One `KEY=VALUE` per line. A line without `=` is dropped rather than stored as
 * a key with an empty value: `${VAR}` references in other values resolve to the
 * empty string, which reads as "not configured" instead of failing loudly.
 */
export function parseEnvText(text: string): Record<string, string> {
	const entries: [string, string][] = [];
	for (const line of text.split("\n")) {
		const at = line.indexOf("=");
		if (at <= 0) continue;
		const key = line.slice(0, at).trim();
		if (!key) continue;
		entries.push([key, line.slice(at + 1).trim()]);
	}
	return Object.fromEntries(entries);
}

export function formatEnvText(env: Record<string, string>): string {
	return Object.entries(env)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

/** One `Name: Value` per line, the shape an HTTP header has. */
export function parseHeadersText(text: string): Record<string, string> {
	const entries: [string, string][] = [];
	for (const line of text.split("\n")) {
		const at = line.indexOf(":");
		if (at <= 0) continue;
		const name = line.slice(0, at).trim();
		if (!name) continue;
		entries.push([name, line.slice(at + 1).trim()]);
	}
	return Object.fromEntries(entries);
}

export function formatHeadersText(headers: Record<string, string>): string {
	return Object.entries(headers)
		.map(([name, value]) => `${name}: ${value}`)
		.join("\n");
}

/** The editor's working copy: multi-value fields are held as text while typing. */
export interface McpDraft {
	/** Set when editing an existing server. */
	original?: string;
	name: string;
	enabled: boolean;
	transport: SentinelMcpTransport;
	command: string;
	argsText: string;
	envText: string;
	cwd: string;
	url: string;
	headersText: string;
	description: string;
	exposure: SentinelMcpExposure;
	timeoutText: string;
	hostExecAcknowledged: boolean;
}

export const EMPTY_MCP_DRAFT: McpDraft = {
	name: "",
	enabled: true,
	transport: "stdio",
	command: "",
	argsText: "",
	envText: "",
	cwd: "",
	url: "",
	headersText: "",
	description: "",
	exposure: "codemode",
	timeoutText: "",
	hostExecAcknowledged: false,
};

export function draftOf(server: SentinelMcpServerView): McpDraft {
	return {
		original: server.name,
		name: server.name,
		enabled: server.enabled,
		transport: server.transport,
		command: server.command,
		argsText: formatArgsText(server.args),
		envText: formatEnvText(server.env),
		cwd: server.cwd,
		url: server.url,
		headersText: formatHeadersText(server.headers),
		description: server.description,
		exposure: server.exposure,
		timeoutText: server.timeout === null ? "" : String(server.timeout),
		hostExecAcknowledged: server.hostExecAcknowledged,
	};
}

/** The save payload for a draft. */
export function draftToInput(draft: McpDraft): SentinelMcpServerInput {
	const timeout = Number(draft.timeoutText.trim());
	return {
		name: draft.name.trim(),
		enabled: draft.enabled,
		transport: draft.transport,
		command: draft.command.trim(),
		args: parseArgsText(draft.argsText),
		env: parseEnvText(draft.envText),
		cwd: draft.cwd.trim(),
		url: draft.url.trim(),
		headers: parseHeadersText(draft.headersText),
		description: draft.description.trim(),
		exposure: draft.exposure,
		timeout: draft.timeoutText.trim() && Number.isFinite(timeout) && timeout > 0 ? Math.round(timeout) : null,
		hostExecAcknowledged: draft.hostExecAcknowledged,
	};
}

/** Compact timestamp for the table cell; the full value rides along in the title. */
function formatWhen(at: number | null): string {
	if (at === null) return t("尚未测试");
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The 设置 → MCP section.
 *
 * This page is the only writer of the custom server list: a session connects
 * exactly what is stored here, so a server that is not on this page does not
 * exist for the agent. One row per server answers "which servers does the agent
 * actually have", and the editor holds the transport details.
 *
 * stdio servers run their command on the console host — not in the project's
 * Kali container and not through the bash approval gate — so an stdio entry
 * needs an explicit acknowledgment before it can be saved, and the page says so
 * in the notice rather than only in the checkbox label.
 */
export function McpPanel({
	config,
	busy,
	onSave,
	onDelete,
	onTest,
	onOpenPermissions,
}: {
	config: SentinelMcpConfigView;
	busy: boolean;
	onSave: (server: SentinelMcpServerInput) => void;
	onDelete: (name: string) => void;
	onTest: (name: string, draft?: SentinelMcpServerInput) => Promise<SentinelMcpTestResult | null>;
	onOpenPermissions: () => void;
}) {
	const [draft, setDraft] = useState<McpDraft | null>(null);
	const [testing, setTesting] = useState<string | null>(null);
	const [results, setResults] = useState<Record<string, SentinelMcpTestResult | null>>({});
	/** The row whose 工具 list is expanded, keyed by name. */
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const editorRef = useRef<HTMLDivElement | null>(null);

	// The editor sits below a list that can be long, so opening it from a row's
	// 编辑 button has to bring it into view or the click looks like nothing happened.
	const editing = draft !== null;
	useEffect(() => {
		if (editing) editorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [editing]);

	const runTest = async (key: string, name: string, candidate?: SentinelMcpServerInput): Promise<void> => {
		setTesting(key);
		setResults((prev) => ({ ...prev, [key]: null }));
		try {
			const result = await onTest(name, candidate);
			setResults((prev) => ({ ...prev, [key]: result }));
		} finally {
			setTesting(null);
		}
	};

	const submit = (): void => {
		if (!draft) return;
		onSave(draftToInput(draft));
		setDraft(null);
	};

	const draftKey = draft ? `draft:${draft.original ?? "new"}` : "";
	const draftValid =
		draft !== null &&
		draft.name.trim().length > 0 &&
		(draft.transport === "stdio"
			? draft.command.trim().length > 0 && draft.hostExecAcknowledged
			: draft.url.trim().length > 0);

	return (
		<div className="mcp-page">
			<div className="mcp-notice">
				<b>{t("stdio 服务器在宿主机上执行")}</b>
				{t("stdio 类型的 MCP 服务器由控制台进程直接 spawn（不在项目容器内，也不经过 bash 审批与守门模型），等于把宿主机命令执行权交给该服务器。只添加你信任的来源；需要容器内执行的工具请让 Agent 用 bash 在容器里跑。")}
			</div>

			{config.permissionOn ? null : (
				<div className="mcp-notice is-warn">
					<b>{t("权限未开启")}</b>
					{t("「设置 → 权限」里的")} <code>MCP</code>{" "}
					{t("开关是关的，下面的服务器一个都不会挂载。")}
					<button type="button" className="link" onClick={onOpenPermissions}>
						{t("去打开")}
					</button>
				</div>
			)}

			<div className="mcp-toolbar">
				<div className="mcp-toolbar__stats">
					{t("已挂载")} <b>{config.mounted}</b> / {config.servers.length} {t("个服务器")}
					<span className="hint"> · {t("只有「已启用 +（stdio 已确认）」的服务器会连接")}</span>
				</div>
				<div className="mcp-toolbar__spacer" />
				<button type="button" className="primary" disabled={busy} onClick={() => setDraft({ ...EMPTY_MCP_DRAFT })}>
					+ {t("添加服务器")}
				</button>
			</div>

			{config.servers.length === 0 ? (
				<p className="settings-hint">
					{t("还没有自定义 MCP 服务器。添加一个之后，它的工具会以")}{" "}
					<code>mcp__&lt;{t("服务器")}&gt;__&lt;{t("工具")}&gt;</code>{" "}
					{t("的名字挂给 Agent（默认在 codemode 脚本里调用）。")}
				</p>
			) : (
				<div className="mcp-table">
					<div className="mcp-row mcp-row--head">
						<div>{t("服务器")}</div>
						<div>{t("传输")}</div>
						<div>{t("状态")}</div>
						<div>{t("最近测试")}</div>
						<div className="mcp-ops">{t("操作")}</div>
					</div>
					{config.servers.map((server) => {
						const state = mcpServerState(server);
						const tone = STATE_TONES[state];
						const result = results[server.name];
						const isOpen = open[server.name] === true;
						return (
							<div className={`mcp-group is-${tone}`} key={server.name}>
								<div className="mcp-row">
									<div className="mcp-name">
										<button
											type="button"
											className={`mcp-toggle${isOpen ? " open" : ""}`}
											aria-expanded={isOpen}
											aria-label={t("展开 {name} 的详情", { name: server.name })}
											onClick={() => setOpen((prev) => ({ ...prev, [server.name]: !isOpen }))}
										/>
										<div className="mcp-name__text">
											<div className="mcp-name__title">{server.name}</div>
											<div className="mcp-name__target" title={server.target}>
												{server.target || t("（未填写）")}
											</div>
										</div>
									</div>

									<div className="mcp-cell">{TRANSPORT_LABELS[server.transport]}</div>

									<div className="mcp-state">
										<span className={`mcp-pill is-${tone}`}>{STATE_LABELS[state]}</span>
										<label className="mcp-switch" title={t("启用 {name}", { name: server.name })}>
											<input
												type="checkbox"
												checked={server.enabled}
												disabled={busy}
												aria-label={t("启用 {name}", { name: server.name })}
												onChange={(event) => onSave({ ...draftToInput(draftOf(server)), enabled: event.target.checked })}
											/>
											<span />
										</label>
									</div>

									<div className="mcp-cell mcp-cell--nowrap" title={server.status.error ?? ""}>
										{formatWhen(server.status.at)}
										{server.status.at === null
											? ""
											: server.status.ok
												? t(" · 成功{tools}", {
													tools:
														server.status.tools === undefined
															? ""
															: t(" · {count} 工具", { count: server.status.tools }),
												})
												: t(" · 失败")}
									</div>

									<div className="mcp-ops">
										<button
											type="button"
											disabled={testing === server.name}
											onClick={() => void runTest(server.name, server.name)}
										>
											{testing === server.name ? t("测试中…") : t("测试")}
										</button>
										<button type="button" disabled={busy} onClick={() => setDraft(draftOf(server))}>
											{t("编辑")}
										</button>
										<button
											type="button"
											className="quiet"
											disabled={busy}
											onClick={() => {
												if (window.confirm(t("删除 MCP 服务器「{name}」？", { name: server.name }))) onDelete(server.name);
											}}
										>
											{t("删除")}
										</button>
									</div>
								</div>

								<div className="mcp-detail" hidden={!isOpen}>
									<div>
										{result ? (
											<div className={`mcp-result is-${result.ok ? "ok" : "bad"}`}>
												{result.message}
												{result.instructions ? <p className="mcp-result__note">{result.instructions}</p> : null}
												{result.tools.length > 0 ? (
													<pre>{result.tools.join("\n")}</pre>
												) : result.detail ? (
													<pre>{result.detail}</pre>
												) : null}
											</div>
										) : null}
										{server.status.error ? (
											<>
												<div className="mcp-detail__title">{t("上次失败原因")}</div>
												<div className="mcp-error">{server.status.error}</div>
											</>
										) : null}
										<div className="mcp-detail__title">{t("挂载状态")}</div>
										<div className="mcp-note">
											{t("{reason}。", { reason: mountReason(server) })}{" "}
											{state === "mounted"
												? t("工具的可见范围由下面的「暴露方式」决定。")
												: t("条件不满足的服务器不连接，Agent 看不到它的工具。")}
										</div>
									</div>
									<div>
										<div className="mcp-detail__title">{t("暴露方式")}</div>
										<div className="mcp-note">
											{EXPOSURE_OPTIONS.find((option) => option.value === server.exposure)?.hint ?? ""}
										</div>
										{server.description ? (
											<>
												<div className="mcp-detail__title">{t("给模型的描述")}</div>
												<div className="mcp-note">{server.description}</div>
											</>
										) : null}
										<div className="mcp-detail__title">{t("存放位置")}</div>
										<div className="mcp-note">
											{config.path}
											{t("（0600）。请求头与环境变量保存在这里，由控制台读取，不写入项目容器。")}
										</div>
									</div>
								</div>
							</div>
						);
					})}
				</div>
			)}

			{draft ? (
				<div className="mcp-editor" ref={editorRef}>
					<h3 className="settings-section">{draft.original ? t("编辑 {name}", { name: draft.original }) : t("添加 MCP 服务器")}</h3>

					<div className="mcp-editor__grid">
						<label>
							{t("名称")}
							<input
								value={draft.name}
								onChange={(event) => setDraft({ ...draft, name: event.target.value })}
								placeholder="filesystem"
								spellCheck={false}
							/>
							<span className="hint">{t("只能字母、数字、下划线和短横线；工具名会带上它")}</span>
						</label>

						<label>
							{t("传输方式")}
							<select
								value={draft.transport}
								onChange={(event) => setDraft({ ...draft, transport: event.target.value as SentinelMcpTransport })}
							>
								<option value="stdio">{t("stdio（宿主机执行命令）")}</option>
								<option value="http">{t("HTTP（远程 streamable HTTP）")}</option>
								<option value="sse">{t("SSE（旧版 HTTP+SSE 长连接）")}</option>
							</select>
							{draft.transport === "sse" ? <span className="hint">{SSE_HINT}</span> : null}
						</label>
					</div>

					{draft.transport === "stdio" ? (
						<>
							<div className="mcp-editor__grid">
								<label>
									{t("命令")}
									<input
										value={draft.command}
										onChange={(event) => setDraft({ ...draft, command: event.target.value })}
										placeholder="npx / uvx / node"
										spellCheck={false}
									/>
								</label>
								<label>
									{t("工作目录")}
									<input
										value={draft.cwd}
										onChange={(event) => setDraft({ ...draft, cwd: event.target.value })}
										placeholder={t("留空 = 当前项目工作目录")}
										spellCheck={false}
									/>
								</label>
							</div>
							<label className="mcp-editor__wide">
								{t("参数")}
								<textarea
									value={draft.argsText}
									onChange={(event) => setDraft({ ...draft, argsText: event.target.value })}
									placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/work"}
									rows={3}
									spellCheck={false}
								/>
								<span className="hint">{t("每行一个参数，顺序即参数顺序")}</span>
							</label>
							<label className="mcp-editor__wide">
								{t("环境变量")}
								<textarea
									value={draft.envText}
									onChange={(event) => setDraft({ ...draft, envText: event.target.value })}
									placeholder={"API_KEY=${TOOLS_KEY}\nLOG_LEVEL=info"}
									rows={3}
									spellCheck={false}
								/>
								<span className="hint">{t("每行一个 KEY=VALUE；值支持")} ${"${VAR}"} {t("引用宿主环境变量")}</span>
							</label>
							<label className="mcp-editor__ack">
								<input
									type="checkbox"
									checked={draft.hostExecAcknowledged}
									onChange={(event) => setDraft({ ...draft, hostExecAcknowledged: event.target.checked })}
								/>
								{t("我确认该命令会在控制台宿主机上直接执行（不在容器内、不经过 bash 审批）")}
							</label>
						</>
					) : (
						<>
							<label className="mcp-editor__wide">
								URL
								<input
									value={draft.url}
									onChange={(event) => setDraft({ ...draft, url: event.target.value })}
									placeholder={draft.transport === "sse" ? "https://example.com/sse" : "https://example.com/mcp"}
									spellCheck={false}
								/>
							</label>
							<label className="mcp-editor__wide">
								{t("请求头")}
								<textarea
									value={draft.headersText}
									onChange={(event) => setDraft({ ...draft, headersText: event.target.value })}
									placeholder={"Authorization: Bearer ${DOCS_TOKEN}"}
									rows={3}
									spellCheck={false}
								/>
								<span className="hint">
									{t("每行一个 Name: Value；值支持")} ${"${VAR}"}{" "}
									{t("引用宿主环境变量。本页不做 OAuth，需要 OAuth 的服务器请在终端执行 {command}。", {
										command: `sentinel mcp login <${getLanguage() === "zh" ? "名称" : "name"}>`,
									})}
								</span>
							</label>
						</>
					)}

					<div className="mcp-editor__grid">
						<label>
							{t("暴露方式")}
							<select
								value={draft.exposure}
								onChange={(event) => setDraft({ ...draft, exposure: event.target.value as SentinelMcpExposure })}
							>
								{EXPOSURE_OPTIONS.map((option) => (
									<option value={option.value} key={option.value}>
										{option.label}
									</option>
								))}
							</select>
							<span className="hint">{EXPOSURE_OPTIONS.find((o) => o.value === draft.exposure)?.hint}</span>
						</label>
						<label>
							{t("单次请求超时（秒）")}
							<input
								value={draft.timeoutText}
								inputMode="numeric"
								onChange={(event) => setDraft({ ...draft, timeoutText: event.target.value.replace(/[^\d]/g, "") })}
								placeholder="60"
								spellCheck={false}
							/>
							<span className="hint">{t("留空用扩展默认值 60 秒")}</span>
						</label>
					</div>

					<label className="mcp-editor__wide">
						{t("描述（给模型看，一行）")}
						<input
							value={draft.description}
							onChange={(event) => setDraft({ ...draft, description: event.target.value })}
							placeholder={t("文件系统读写服务器")}
							spellCheck={false}
						/>
						<span className="hint">{t("会出现在系统提示的 MCP 服务器清单里，帮助模型判断该不该用")}</span>
					</label>

					<label className="mcp-editor__ack">
						<input
							type="checkbox"
							checked={draft.enabled}
							onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
						/>
						{t("保存后启用（不启用则只保存配置，不连接）")}
					</label>

					<div className="mcp-editor__actions">
						<button type="button" className="primary" disabled={busy || !draftValid} onClick={submit}>
							{t("保存")}
						</button>
						<button
							type="button"
							disabled={testing === draftKey}
							onClick={() => void runTest(draftKey, draft.name.trim(), draftToInput(draft))}
						>
							{testing === draftKey ? t("测试中…") : t("测试连接")}
						</button>
						<button type="button" onClick={() => setDraft(null)}>
							{t("取消")}
						</button>
					</div>
					{results[draftKey] ? (
						<div className={`mcp-result is-${results[draftKey]?.ok ? "ok" : "bad"}`}>
							{results[draftKey]?.message}
							{results[draftKey]?.detail ? <pre>{results[draftKey]?.detail}</pre> : null}
						</div>
					) : null}
					<p className="mcp-footnote">
						{t("「测试连接」只做一次连接并读取工具列表，不会保存，也不影响正在运行的会话；stdio 服务器在测试时同样会在宿主机上启动进程。")}
					</p>
				</div>
			) : null}

			<p className="mcp-footnote">
				{t("保存与删除会重建活动会话（先中止正在运行的会话），新增的工具要等会话重建后才会出现。连接由会话内的 MCP 扩展在启动时完成，本页不显示实时连接状态。")}
			</p>
		</div>
	);
}
