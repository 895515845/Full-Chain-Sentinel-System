import { useEffect, useState, type ChangeEvent } from "react";
import { readFileBase64 } from "./PocPage.tsx";
import type {
	SentinelPluginArtifactsView,
	SentinelPluginConfigField,
	SentinelPluginHostInput,
	SentinelPluginHostView,
	SentinelPluginLocality,
	SentinelPluginLogsView,
	SentinelPluginManifest,
	SentinelPluginManifestView,
	SentinelPluginNetwork,
	SentinelPluginState,
	SentinelPluginView,
	SentinelPluginsView,
} from "../types.ts";

const STATE_LABELS: Record<SentinelPluginState, string> = {
	running: "运行中",
	starting: "启动中",
	stopped: "已停止",
	failed: "失败",
	missing: "缺失",
};

const STATE_TONES: Record<SentinelPluginState, "ok" | "warn" | "bad" | "off"> = {
	running: "ok",
	starting: "warn",
	stopped: "off",
	failed: "bad",
	missing: "bad",
};

const LOCALITY_LABELS: Record<SentinelPluginLocality, string> = {
	"local-only": "仅本地",
	"remote-only": "仅远端",
	any: "不限",
};

const NETWORK_LABELS: Record<SentinelPluginNetwork, string> = {
	none: "无网络",
	bridge: "bridge（NAT）",
	host: "host（宿主网络栈）",
};

/** The host editor's working copy; `original` is set while editing an existing host. */
interface HostDraft {
	original?: string;
	name: string;
	url: string;
	token: string;
}

const EMPTY_HOST_DRAFT: HostDraft = { name: "", url: "", token: "" };

function formatWhen(at: number | null): string {
	if (at === null) return "尚未连接";
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MAX_PLUGIN_PACKAGE_BYTES = 8 * 1024 * 1024;

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The 设置 → 插件 section.
 *
 * A plugin is one Docker image on one plugin host, mounted as an MCP server for
 * the agent. This page owns the host list, the lifecycle of installed plugins,
 * and the install form: it reads `plugin.json` from a local directory first, so
 * the declared permissions and configuration are visible before anything runs.
 */
export function PluginPanel({
	view,
	busy,
	permissionOn,
	logs,
	artifacts,
	pendingManifest,
	notice,
	onOpenPermissions,
	onRefresh,
	onSaveHost,
	onDeleteHost,
	onTestHost,
	onInspectPackage,
	onInstall,
	onUninstall,
	onStart,
	onStop,
	onSetEnabled,
	onSaveConfig,
	onLoadLogs,
	onCloseLogs,
	onListArtifacts,
	onCloseArtifacts,
	onFetchArtifact,
}: {
	view: SentinelPluginsView;
	busy: boolean;
	/** The 权限 → MCP master switch; null while the console has not read it. */
	permissionOn: boolean | null;
	logs: SentinelPluginLogsView | null;
	artifacts: SentinelPluginArtifactsView | null;
	pendingManifest: SentinelPluginManifestView | null;
	/** One-line success message, e.g. where an artifact was saved. */
	notice: string | null;
	onOpenPermissions: () => void;
	onRefresh: () => void;
	onSaveHost: (host: SentinelPluginHostInput) => void;
	onDeleteHost: (id: string) => void;
	onTestHost: (id: string) => void;
	onInspectPackage: (name: string, data: string) => void;
	onInstall: (input: {
		hostId: string;
		manifest: SentinelPluginManifest;
		allowHostNetwork: boolean;
		allowPrivileged: boolean;
		config: Record<string, string>;
	}) => void;
	onUninstall: (hostId: string, pluginId: string, purge: boolean) => void;
	onStart: (hostId: string, pluginId: string) => void;
	onStop: (hostId: string, pluginId: string) => void;
	onSetEnabled: (hostId: string, pluginId: string, enabled: boolean) => void;
	onSaveConfig: (hostId: string, pluginId: string, values: Record<string, string>) => void;
	onLoadLogs: (hostId: string, pluginId: string) => void;
	onCloseLogs: () => void;
	onListArtifacts: (hostId: string, pluginId: string) => void;
	onCloseArtifacts: () => void;
	onFetchArtifact: (hostId: string, pluginId: string, path: string) => void;
}) {
	const [hostDraft, setHostDraft] = useState<HostDraft | null>(null);
	const [packageFile, setPackageFile] = useState<{ name: string; size: number } | null>(null);
	const [packageError, setPackageError] = useState<string | null>(null);
	const [installHostId, setInstallHostId] = useState("");
	const [configValues, setConfigValues] = useState<Record<string, string>>({});
	const [allowHostNetwork, setAllowHostNetwork] = useState(false);
	const [allowPrivileged, setAllowPrivileged] = useState(false);
	const [installPending, setInstallPending] = useState(false);
	const [editingPlugin, setEditingPlugin] = useState<string | null>(null);
	const [editValues, setEditValues] = useState<Record<string, string>>({});

	const running = view.plugins.filter((plugin) => plugin.state === "running").length;
	const localHost = view.hosts.find((host) => host.local);
	// A local host is only absent when the daemon was never started, or when it
	// answered once and then stopped; both have the same one-line fix.
	const localHostDown = !localHost || (localHost.status.at !== null && !localHost.status.ok);

	// A new manifest resets the acknowledgement boxes and the config form: the
	// declarations belong to that manifest, and a stale "host network allowed"
	// from a previous directory must never carry over.
	useEffect(() => {
		if (!pendingManifest) return;
		const next: Record<string, string> = {};
		for (const field of pendingManifest.manifest.config) {
			const value = field.default;
			next[field.key] =
				value === null ? "" : typeof value === "boolean" ? (value ? "true" : "false") : String(value);
		}
		setConfigValues(next);
		setAllowHostNetwork(false);
		setAllowPrivileged(false);
	}, [pendingManifest]);

	// Keep the install target pointing at a host that still exists.
	useEffect(() => {
		if (installHostId && view.hosts.some((host) => host.id === installHostId)) return;
		setInstallHostId(view.hosts[0]?.id ?? "");
	}, [view.hosts, installHostId]);

	// The pull can take minutes; the note stays up until the page reports back
	// (or the parent's timeout releases busy).
	useEffect(() => {
		if (!busy) setInstallPending(false);
	}, [busy]);

	const hostValid =
		hostDraft !== null &&
		hostDraft.name.trim().length > 0 &&
		hostDraft.url.trim().length > 0 &&
		(hostDraft.original !== undefined || hostDraft.token.trim().length > 0);

	const submitHost = (): void => {
		if (!hostDraft || !hostValid) return;
		onSaveHost({
			...(hostDraft.original === undefined ? {} : { id: hostDraft.original }),
			name: hostDraft.name.trim(),
			url: hostDraft.url.trim(),
			token: hostDraft.token,
		});
		setHostDraft(null);
	};

	const choosePackage = (event: ChangeEvent<HTMLInputElement>): void => {
		const file = event.target.files?.[0];
		// Let the same file be picked again after a failed read.
		event.target.value = "";
		if (!file) return;
		setPackageError(null);
		if (file.size > MAX_PLUGIN_PACKAGE_BYTES) {
			setPackageError(`插件包最大 ${MAX_PLUGIN_PACKAGE_BYTES / (1024 * 1024)}MB`);
			return;
		}
		void readFileBase64(file)
			.then((data) => {
				setPackageFile({ name: file.name, size: file.size });
				onInspectPackage(file.name, data);
			})
			.catch((error: unknown) => setPackageError(error instanceof Error ? error.message : String(error)));
	};

	const uninstall = (plugin: SentinelPluginView): void => {
		if (!window.confirm(`卸载插件「${plugin.manifest.name}」？`)) return;
		// A second question is the purge decision: keeping the data directory is
		// the safer default, so it is the "cancel" branch of the dialog.
		const purge = window.confirm(
			"是否同时删除该插件的数据？\n确定 = 删除容器配置与产物；取消 = 保留数据目录。",
		);
		onUninstall(plugin.hostId, plugin.manifest.id, purge);
	};

	const renderConfigField = (
		field: SentinelPluginConfigField,
		value: string,
		set: (next: string) => void,
		secretHint: string,
	) => {
		const hint = [field.description, field.required ? "必填" : ""].filter(Boolean).join(" · ");

		if (field.type === "boolean") {
			return (
				<label className="plugin-config-boolean" key={field.key}>
					<input
						type="checkbox"
						checked={value === "true"}
						disabled={busy}
						onChange={(event) => set(event.target.checked ? "true" : "false")}
					/>
					<span>
						{field.label}
						{hint ? <span className="hint">{hint}</span> : null}
					</span>
				</label>
			);
		}

		if (field.type === "enum") {
			return (
				<label key={field.key}>
					{field.label}
					<select value={value} disabled={busy} onChange={(event) => set(event.target.value)}>
						<option value="">{field.required ? "请选择" : "（不设置）"}</option>
						{field.options.map((option) => (
							<option value={option} key={option}>
								{option}
							</option>
						))}
					</select>
					{hint ? <span className="hint">{hint}</span> : null}
				</label>
			);
		}

		return (
			<label key={field.key}>
				{field.label}
				<input
					type={field.type === "secret" ? "password" : field.type === "number" ? "number" : "text"}
					value={value}
					disabled={busy}
					step={field.type === "number" ? "any" : undefined}
					placeholder={field.type === "secret" ? secretHint : ""}
					spellCheck={false}
					autoComplete="off"
					onChange={(event) => set(event.target.value)}
				/>
				{hint ? <span className="hint">{hint}</span> : null}
			</label>
		);
	};

	const configInput = (field: SentinelPluginConfigField) =>
		renderConfigField(
			field,
			configValues[field.key] ?? "",
			(next) => setConfigValues((prev) => ({ ...prev, [field.key]: next })),
			"不会回显已保存的值",
		);

	const editKeyOf = (plugin: SentinelPluginView): string => `${plugin.hostId}/${plugin.manifest.id}`;

	const openConfig = (plugin: SentinelPluginView): void => {
		const key = editKeyOf(plugin);
		if (editingPlugin === key) {
			setEditingPlugin(null);
			return;
		}
		const next: Record<string, string> = {};
		for (const field of plugin.manifest.config) {
			if (field.type === "secret") next[field.key] = "";
			else next[field.key] = plugin.values[field.key] ?? "";
		}
		setEditValues(next);
		setEditingPlugin(key);
	};

	const editComplete = (plugin: SentinelPluginView): boolean =>
		plugin.manifest.config.every((field) => {
			if (!field.required) return true;
			if ((editValues[field.key] ?? "").trim() !== "") return true;
			// A required secret may be blank only when a value is already stored.
			return field.type === "secret" && plugin.configured.includes(field.key);
		});

	const manifest = pendingManifest?.manifest ?? null;
	const configComplete =
		manifest === null ||
		manifest.config.every((field) => !field.required || (configValues[field.key] ?? "").trim().length > 0);
	const permissionsAllowed =
		manifest === null ||
		((manifest.permissions.network !== "host" || allowHostNetwork) &&
			(!manifest.permissions.privileged || allowPrivileged));
	const installReady = manifest !== null && installHostId !== "" && configComplete && permissionsAllowed;

	const install = (): void => {
		if (!manifest || !installReady) return;
		const config: Record<string, string> = {};
		for (const field of manifest.config) {
			const value = configValues[field.key];
			if (value !== undefined && value !== "") config[field.key] = value;
		}
		setInstallPending(true);
		onInstall({
			hostId: installHostId,
			manifest,
			allowHostNetwork,
			allowPrivileged,
			config,
		});
	};

	const hostStatusTone = (host: SentinelPluginHostView): "ok" | "bad" | "off" =>
		host.status.at === null ? "off" : host.status.ok ? "ok" : "bad";

	return (
		<div className="mcp-page plugin-page">
			<div className="mcp-notice">
				<b>插件在 Docker 中运行</b>
				每个插件是一个独立容器，通过 MCP 把工具挂给 Agent。挂载受「权限 → MCP」总开关约束：总开关关闭时，已安装的插件也不会出现在工具列表里。
			</div>

			{notice ? <div className="mcp-notice">{notice}</div> : null}

			{permissionOn === false ? (
				<div className="mcp-notice is-warn">
					<b>权限未开启</b>
					「设置 → 权限」里的 <code>MCP</code> 开关是关的，本页的插件都不会挂载。
					<button type="button" className="link" onClick={onOpenPermissions}>
						去打开
					</button>
				</div>
			) : null}

			{view.problems.length > 0 ? (
				<div className="mcp-notice is-warn">
					<b>主机未响应</b>
					下列主机本次没有返回状态，页面其余部分仍可用：
					<ul className="plugin-problems">
						{view.problems.map((problem) => (
							<li key={problem}>{problem}</li>
						))}
					</ul>
				</div>
			) : null}

			{localHostDown ? (
				<div className="mcp-notice">
					<b>本地 host 未运行</b>
					需要在本机执行插件时，在终端运行 <code>sentinel-web plugin-host --local</code>，控制台会自动发现它。
				</div>
			) : null}

			<div className="mcp-toolbar">
				<div className="mcp-toolbar__stats">
					主机 <b>{view.hosts.length}</b> 个 · 插件 <b>{view.plugins.length}</b> 个 · 运行中 <b>{running}</b> 个
				</div>
				<div className="mcp-toolbar__spacer" />
				<button type="button" disabled={busy} onClick={onRefresh}>
					刷新
				</button>
				<button type="button" className="primary" disabled={busy} onClick={() => setHostDraft({ ...EMPTY_HOST_DRAFT })}>
					+ 添加主机
				</button>
			</div>

			{hostDraft ? (
				<div className="mcp-editor">
					<h3 className="settings-section">
						{hostDraft.original === undefined ? "添加插件主机" : `编辑主机 ${hostDraft.original}`}
					</h3>
					<div className="mcp-editor__grid">
						<label>
							名称
							<input
								value={hostDraft.name}
								onChange={(event) => setHostDraft({ ...hostDraft, name: event.target.value })}
								placeholder="本机 / 扫描 VPS"
								spellCheck={false}
							/>
						</label>
						<label>
							URL
							<input
								value={hostDraft.url}
								onChange={(event) => setHostDraft({ ...hostDraft, url: event.target.value })}
								placeholder="http://127.0.0.1:7800"
								spellCheck={false}
							/>
							<span className="hint">非回环地址必须用 HTTPS，token 不会走明文。</span>
						</label>
					</div>
					<label className="mcp-editor__wide">
						token
						<input
							type="password"
							value={hostDraft.token}
							onChange={(event) => setHostDraft({ ...hostDraft, token: event.target.value })}
							placeholder={hostDraft.original === undefined ? "plugin-host 启动时打印的 token" : "留空表示沿用已保存的 token"}
							spellCheck={false}
							autoComplete="off"
						/>
						<span className="hint">
							{hostDraft.original === undefined
								? "token 在 plugin-host 启动时打印。"
								: "留空表示沿用已保存的 token；填写则替换。"}
						</span>
					</label>
					<div className="mcp-editor__actions">
						<button type="button" className="primary" disabled={busy || !hostValid} onClick={submitHost}>
							保存
						</button>
						<button type="button" onClick={() => setHostDraft(null)}>
							取消
						</button>
					</div>
				</div>
			) : null}

			<div className="plugin-section">
				<div className="plugin-section__head">
					<h3 className="settings-section">插件主机</h3>
					<div className="mcp-toolbar__spacer" />
					<span className="hint">host 是运行插件容器的机器；本机 host 由 plugin-host --local 提供。</span>
				</div>

				{view.hosts.length === 0 ? (
					<p className="settings-hint">
						还没有插件主机。先启动一个 host，再用上面的「添加主机」填入地址和 token；本机可以用{" "}
						<code>sentinel-web plugin-host --local</code> 自动被发现。
					</p>
				) : (
					<div className="mcp-table plugin-hosts">
						<div className="mcp-row plugin-host-row mcp-row--head">
							<div>主机</div>
							<div>地址</div>
							<div>状态</div>
							<div>最近连接</div>
							<div className="mcp-ops">操作</div>
						</div>
						{view.hosts.map((host) => {
							const tone = hostStatusTone(host);
							const error =
								host.status.error ??
								(host.status.docker && !host.status.docker.ok ? host.status.docker.error : undefined);
							return (
								<div className={`mcp-group${tone === "off" ? "" : ` is-${tone}`}`} key={host.id}>
									<div className="mcp-row plugin-host-row">
										<div className="mcp-name__text">
											<div className="mcp-name__title">
												{host.name}
												{host.local ? <span className="plugin-tag">本机</span> : null}
											</div>
											<div className="mcp-name__target">{host.id}</div>
										</div>
										<div className="mcp-cell plugin-host-url">{host.url}</div>
										<div className="mcp-state">
											<span className={`plugin-dot is-${tone}`} />
											<span>
												{host.status.at === null ? "尚未连接" : host.status.ok ? "正常" : "失败"}
												{host.status.version ? ` · v${host.status.version}` : ""}
												{host.status.mode ? ` · ${host.status.mode}` : ""}
											</span>
										</div>
										<div className="mcp-cell mcp-cell--nowrap" title={error ?? ""}>
											{formatWhen(host.status.at)}
										</div>
										<div className="mcp-ops">
											<button
												type="button"
												disabled={busy}
												onClick={() => {
													onTestHost(host.id);
												}}
											>
												测试连接
											</button>
											{host.local ? (
												<span className="plugin-tag">本机自动发现</span>
											) : (
												<>
													<button
														type="button"
														disabled={busy}
														onClick={() =>
															setHostDraft({
																original: host.id,
																name: host.name,
																url: host.url,
																token: "",
															})
														}
													>
														编辑
													</button>
													<button
														type="button"
														className="quiet"
														disabled={busy}
														onClick={() => {
															if (window.confirm(`删除插件主机「${host.name}」？它上面的插件将从控制台消失。`)) {
																onDeleteHost(host.id);
															}
														}}
													>
														删除
													</button>
												</>
											)}
										</div>
									</div>
									{error ? <div className="plugin-host-error">{error}</div> : null}
								</div>
							);
						})}
					</div>
				)}
			</div>

			<div className="plugin-section">
				<div className="plugin-section__head">
					<h3 className="settings-section">已安装插件</h3>
					<div className="mcp-toolbar__spacer" />
					<span className="hint">启用只影响 Agent 是否挂载它的工具；停止会关掉容器。</span>
				</div>

				{view.plugins.length === 0 ? (
					<p className="settings-hint">还没有安装插件。在下方读取一个插件目录，确认权限后安装。</p>
				) : (
					view.plugins.map((plugin) => {
						const id = plugin.manifest.id;
						const tone = STATE_TONES[plugin.state];
						const perms = plugin.manifest.permissions;
						const toolNames = plugin.manifest.tools.map((tool) => tool.name);
						const logsOpen = logs !== null && logs.hostId === plugin.hostId && logs.pluginId === id;
						const artifactsOpen =
							artifacts !== null && artifacts.hostId === plugin.hostId && artifacts.pluginId === id;
						const active = plugin.state === "running" || plugin.state === "starting";
						return (
							<div className={`plugin-card is-${tone}`} key={`${plugin.hostId}/${id}`}>
								<div className="plugin-card__head">
									<div className="plugin-card__id">
										<div className="plugin-card__title">
											{plugin.manifest.name}
											<span className="plugin-version">v{plugin.manifest.version}</span>
										</div>
										<div className="plugin-card__sub">
											{id} · {plugin.hostName}
											{plugin.hostLocal ? "（本机）" : ""}
											{plugin.hostPort === null ? "" : ` · 端口 ${plugin.hostPort}`}
											{` · 安装于 ${formatWhen(plugin.installedAt)}`}
										</div>
										{plugin.manifest.description ? (
											<div className="plugin-card__desc">{plugin.manifest.description}</div>
										) : null}
									</div>
									<div className="plugin-card__state">
										<span className={`mcp-pill is-${tone}`}>{STATE_LABELS[plugin.state]}</span>
										{plugin.state === "running" ? (
											<span className={`plugin-health is-${plugin.healthy ? "ok" : "bad"}`}>
												{plugin.healthy ? "健康" : "不健康"}
											</span>
										) : null}
										<label className="mcp-switch" title={plugin.enabled ? "停用该插件" : "启用该插件"}>
											<input
												type="checkbox"
												checked={plugin.enabled}
												disabled={busy}
												aria-label={`启用 ${plugin.manifest.name}`}
												onChange={(event) => onSetEnabled(plugin.hostId, id, event.target.checked)}
											/>
											<span />
										</label>
									</div>
								</div>

								<div className="plugin-card__row">
									<span className="plugin-label">权限</span>
									<span className="plugin-mono">
										network: {NETWORK_LABELS[perms.network]} · privileged: {perms.privileged ? "是" : "否"} · capAdd:{" "}
										{perms.capAdd.length > 0 ? perms.capAdd.join(", ") : "无"}
									</span>
								</div>
								<div className="plugin-card__row">
									<span className="plugin-label">locality</span>
									<span>{LOCALITY_LABELS[plugin.manifest.locality]}</span>
								</div>
								<div className="plugin-card__row">
									<span className="plugin-label">工具</span>
									<span className="plugin-tools">
										{toolNames.length > 0
											? toolNames.map((name) => (
													<code key={name}>{name}</code>
												))
											: "manifest 未声明工具"}
									</span>
								</div>
								<div className="plugin-card__row">
									<span className="plugin-label">配置</span>
									<span>
										{plugin.configured.length > 0
											? `已配置 ${plugin.configured.length} 项：${plugin.configured.join(", ")}`
											: "未配置"}
									</span>
								</div>

								{plugin.lastError ? <div className="plugin-error">最后错误：{plugin.lastError}</div> : null}

								<div className="mcp-ops plugin-card__ops">
									{active ? (
										<button type="button" disabled={busy} onClick={() => onStop(plugin.hostId, id)}>
											停止
										</button>
									) : (
										<button type="button" disabled={busy} onClick={() => onStart(plugin.hostId, id)}>
											启动
										</button>
									)}
									<button type="button" disabled={busy} onClick={() => onLoadLogs(plugin.hostId, id)}>
										日志
									</button>
									<button type="button" disabled={busy} onClick={() => onListArtifacts(plugin.hostId, id)}>
										产物
									</button>
									{plugin.manifest.config.length > 0 ? (
										<button type="button" disabled={busy} onClick={() => openConfig(plugin)}>
											配置
										</button>
									) : null}
									<button type="button" className="quiet" disabled={busy} onClick={() => uninstall(plugin)}>
										卸载
									</button>
								</div>

								{logsOpen && logs ? (
									<div className="plugin-block">
										<div className="plugin-block__head">
											<span>日志 · {plugin.manifest.name}</span>
											<div className="plugin-block__ops">
												<button
													type="button"
													disabled={busy}
													onClick={() => onLoadLogs(plugin.hostId, id)}
												>
													刷新
												</button>
												<button type="button" onClick={onCloseLogs}>
													关闭
												</button>
											</div>
										</div>
										<pre className="plugin-logs">{logs.logs || "（没有日志）"}</pre>
									</div>
								) : null}

								{editingPlugin === editKeyOf(plugin) ? (
									<div className="plugin-block">
										<div className="plugin-block__head">
											<span>配置 · {plugin.manifest.name}</span>
											<div className="plugin-block__ops">
												<button
													type="button"
													disabled={busy || !editComplete(plugin)}
													onClick={() => {
														onSaveConfig(plugin.hostId, plugin.manifest.id, editValues);
														setEditingPlugin(null);
													}}
												>
													保存并重启
												</button>
												<button type="button" onClick={() => setEditingPlugin(null)}>
													取消
												</button>
											</div>
										</div>
										<div className="mcp-editor__grid">
											{plugin.manifest.config.map((field) =>
												renderConfigField(
													field,
													editValues[field.key] ?? "",
													(next) => setEditValues((prev) => ({ ...prev, [field.key]: next })),
													plugin.configured.includes(field.key) ? "已保存，留空保持不变" : "尚未设置",
												),
											)}
										</div>
										<p className="hint">
											保存会重建容器使新环境变量生效；密钥留空表示保持已保存的值。
										</p>
									</div>
								) : null}

								{artifactsOpen && artifacts ? (
									<div className="plugin-block">
										<div className="plugin-block__head">
											<span>产物 · {plugin.manifest.name}</span>
											<div className="plugin-block__ops">
												<button
													type="button"
													disabled={busy}
													onClick={() => onListArtifacts(plugin.hostId, id)}
												>
													刷新
												</button>
												<button type="button" onClick={onCloseArtifacts}>
													关闭
												</button>
											</div>
										</div>
										{artifacts.items.length === 0 ? (
											<p className="plugin-artifacts__empty">还没有产物</p>
										) : (
											artifacts.items.map((artifact) => (
												<div className="plugin-artifact" key={artifact.path}>
													<code>{artifact.path}</code>
													<span className="plugin-artifact__size">{formatSize(artifact.size)}</span>
													<button
														type="button"
														disabled={busy}
														onClick={() => onFetchArtifact(plugin.hostId, id, artifact.path)}
													>
														拉取到证据目录
													</button>
												</div>
											))
										)}
										<p className="hint">
											拉取的文件会保存到当前项目的 <code>evidence/plugin/</code> 下。
										</p>
									</div>
								) : null}
							</div>
						);
					})
				)}
			</div>

			<div className="plugin-section">
				<div className="plugin-section__head">
					<h3 className="settings-section">上传插件包安装</h3>
					<div className="mcp-toolbar__spacer" />
					<span className="hint">支持 .zip（根目录或一层子目录里有 plugin.json）或直接上传 plugin.json，最大 8MB。</span>
				</div>

				<div className="plugin-dir-row">
					<input
						type="file"
						accept=".zip,.json"
						disabled={busy}
						onChange={choosePackage}
						aria-label="插件包文件"
					/>
					<span className="hint">
						{packageFile
							? `${packageFile.name} · ${formatSize(packageFile.size)}`
							: "包不会被解压到磁盘，只读取 plugin.json；镜像仍按 digest 从仓库拉取。"}
					</span>
				</div>
				{packageError ? <div className="plugin-error">{packageError}</div> : null}

				{manifest && pendingManifest ? (
					<div className="mcp-editor plugin-install">
						<h3 className="settings-section">待安装：{manifest.name}</h3>
						<div className="plugin-manifest__sub">来源</div>
						<div className="plugin-mono">{pendingManifest.source}</div>

						<div className="plugin-manifest__grid">
							<div>
								<span>id</span>
								<code>{manifest.id}</code>
							</div>
							<div>
								<span>版本</span>
								{manifest.version}
							</div>
							<div>
								<span>镜像</span>
								<code className="plugin-manifest__image">{manifest.image}</code>
							</div>
							<div>
								<span>来源</span>
								<a href={manifest.source} target="_blank" rel="noreferrer">
									{manifest.source}
								</a>
							</div>
							<div>
								<span>许可证</span>
								{manifest.license}
							</div>
							<div>
								<span>作者</span>
								{manifest.author}
							</div>
							<div>
								<span>locality</span>
								{LOCALITY_LABELS[manifest.locality]}
							</div>
							<div>
								<span>MCP</span>
								{manifest.mcp.transport} · :{manifest.mcp.port}
								{manifest.mcp.path}
							</div>
							<div>
								<span>资源</span>
								{manifest.resources.cpus} CPU · {manifest.resources.memory} · pids {manifest.resources.pidsLimit}
							</div>
							<div>
								<span>产物目录</span>
								<code>{manifest.artifacts.path}</code>
							</div>
							<div>
								<span>工具</span>
								{manifest.tools.length > 0
									? manifest.tools.map((tool) => tool.name).join(", ")
									: "未声明"}
							</div>
						</div>

						{manifest.description ? <p className="plugin-manifest__desc">{manifest.description}</p> : null}

						<div className="plugin-manifest__sub">声明的权限</div>
						<div className="plugin-perms">
							<span>
								network: <code>{manifest.permissions.network}</code>
							</span>
							<span>
								privileged: <code>{manifest.permissions.privileged ? "true" : "false"}</code>
							</span>
							<span>
								capAdd:{" "}
								<code>
									{manifest.permissions.capAdd.length > 0 ? manifest.permissions.capAdd.join(", ") : "无"}
								</code>
							</span>
						</div>

						{manifest.permissions.network === "host" ? (
							<label className="mcp-editor__ack">
								<input
									type="checkbox"
									checked={allowHostNetwork}
									disabled={busy}
									onChange={(event) => setAllowHostNetwork(event.target.checked)}
								/>
								允许 host 网络：插件容器直接使用宿主网络栈，能访问本机所有监听端口。
							</label>
						) : null}
						{manifest.permissions.privileged ? (
							<label className="mcp-editor__ack">
								<input
									type="checkbox"
									checked={allowPrivileged}
									disabled={busy}
									onChange={(event) => setAllowPrivileged(event.target.checked)}
								/>
								允许 privileged：容器获得全部 Linux 能力，隔离性显著降低。
							</label>
						) : null}

						{manifest.config.length > 0 ? (
							<>
								<div className="plugin-manifest__sub">配置</div>
								<div className="mcp-editor__grid">
									{manifest.config.map((field) => configInput(field))}
								</div>
							</>
						) : null}

						<div className="mcp-editor__grid plugin-install__target">
							<label>
								目标 host
								<select
									value={installHostId}
									disabled={busy || view.hosts.length === 0}
									onChange={(event) => setInstallHostId(event.target.value)}
								>
									{view.hosts.map((host) => (
										<option value={host.id} key={host.id}>
											{host.name}
											{host.local ? "（本机）" : ""}
										</option>
									))}
								</select>
								{view.hosts.length === 0 ? <span className="hint">先添加一个插件主机。</span> : null}
							</label>
						</div>

						<div className="mcp-editor__actions">
							<button type="button" className="primary" disabled={busy || !installReady} onClick={install}>
								{installPending && busy ? "安装中…" : "安装"}
							</button>
						</div>
						{installPending && busy ? (
							<p className="plugin-install__progress">正在拉取镜像并等待健康检查，可能需要几分钟。</p>
						) : null}
						{!configComplete ? <p className="hint">还有必填配置没有填写。</p> : null}
						{!permissionsAllowed ? <p className="hint">需要先勾选上面声明的权限才能安装。</p> : null}
					</div>
				) : (
					<p className="hint">读取成功后在这里显示 manifest、声明的权限和配置表单。</p>
				)}
			</div>

			<details className="plugin-docs">
				<summary>插件开发文档</summary>
				<div className="plugin-docs__body">
					<p>
						一个插件 = 一个 Docker 镜像 + 一个 <code>plugin.json</code>。镜像里跑一个 MCP server，插件主机负责拉镜像、起容器、健康检查，控制台把它的工具挂给 Agent。
					</p>

					<h4>1. 包结构</h4>
					<pre>{`my-plugin/
├── plugin.json
├── Dockerfile
└── README.md

zip -r my-plugin.zip my-plugin/`}</pre>
					<p>
						上传 zip 时，控制台在根目录或一层子目录里找 <code>plugin.json</code>；也可以直接上传一个 <code>plugin.json</code>。包不会解压到磁盘。
					</p>

					<h4>2. plugin.json 必填字段</h4>
					<pre>{`{
  "schema": 1,
  "id": "com.example.recon",
  "name": "侦察工具集",
  "version": "0.1.0",
  "description": "做什么，一句话",
  "author": "github:someone",
  "source": "https://github.com/someone/sentinel-plugin-recon",
  "license": "MIT",
  "image": "ghcr.io/someone/recon@sha256:<64 位十六进制>",
  "mcp": {
    "transport": "http",
    "port": 7801,
    "path": "/mcp",
    "requestTimeoutMs": 300000
  }
}`}</pre>
					<p>
						<code>image</code> 必须带 digest，<code>latest</code> 会被拒绝；<code>source</code> 必须是公开仓库。可选字段：
						<code>config</code>、<code>permissions</code>、<code>locality</code>、<code>resources</code>、<code>healthcheck</code>、<code>artifacts</code>、
						<code>tools</code>（仅安装前预览）。
					</p>

					<h4>3. MCP 接口要求</h4>
					<ul>
						<li>只支持流式 HTTP（streamable HTTP）：POST 到 <code>mcp.path</code>，返回普通 JSON 即可。stdio 与 SSE 需要插件作者自行转换。</li>
						<li>实现 <code>initialize</code>、<code>tools/list</code>、<code>tools/call</code>。</li>
						<li>工具名只用字母、数字、下划线和短横线；每个工具都要有 description 与 inputSchema。</li>
						<li><code>healthcheck.path</code> 返回 2xx 才算启动成功。</li>
						<li>
							<code>mcp.requestTimeoutMs</code> 是单次工具调用的超时（毫秒，默认 300000）；长任务按需调大，最大 30 分钟。
						</li>
					</ul>

					<h4>4. 构建与发布</h4>
					<pre>{`docker build -t ghcr.io/<账号>/sentinel-plugin-recon:0.1.0 .
docker push ghcr.io/<账号>/sentinel-plugin-recon:0.1.0
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/<账号>/sentinel-plugin-recon:0.1.0`}</pre>
					<p>把最后一条命令的输出原样粘进 <code>image</code>。</p>

					<h4>5. 配置与密钥</h4>
					<p>
						<code>config</code> 里的字段以 <code>PLUGIN_&lt;KEY&gt;</code> 环境变量注入容器。类型为 <code>secret</code> 的值只存宿主机的
						<code>config.json</code>（0600），不回显、不进审计。安装后可在插件页改配置，保存会重建容器。
					</p>

					<h4>6. 产物</h4>
					<p>
						大输出写 <code>/artifacts/&lt;run-id&gt;/</code>，工具返回值只放摘要，并在 <code>_meta.artifacts</code> 里声明相对路径。操作员可以在插件页把产物拉进当前项目的
						<code>evidence/plugin/</code>。单文件上限由 manifest 的 <code>artifacts.maxFileBytes</code> 决定。
					</p>

					<h4>7. 权限与 locality</h4>
					<ul>
						<li>
							<code>network: bridge</code> 默认，能出网，不能被外部直接访问；<code>host</code> 共享宿主网络栈，安装时单独确认。
						</li>
						<li>
							<code>capAdd</code> 只允许 <code>NET_RAW</code>、<code>NET_ADMIN</code>、<code>NET_BIND_SERVICE</code>、<code>SYS_PTRACE</code>。
						</li>
						<li>
							<code>privileged</code> 等于宿主 root，强烈不建议。
						</li>
						<li>
							<code>locality</code>：<code>local-only</code> 需要本地网络视角，<code>remote-only</code> 需要公网出口，<code>any</code> 两端都行；装错位置会在安装时被拒绝。
						</li>
					</ul>

					<h4>8. 示例与完整文档</h4>
					<p>
						最小实现见 <code>examples/plugins/hello-world</code>，CLI 包装见 <code>examples/plugins/recon</code>。字段细节、调试方式与检查清单见
						<code>docs/plugin-authoring.md</code>，架构说明见 <code>docs/plugin-center.md</code>。
					</p>

					<h4>9. 发布前检查</h4>
					<ul>
						<li>plugin.json 能通过安装时的校验（错误会一次列全）</li>
						<li>image 是刚推送那一版的 digest</li>
						<li>healthcheck 在 20 秒内可用</li>
						<li>密钥走 config，没有硬编码</li>
						<li>大输出写 /artifacts，返回值只有摘要</li>
					</ul>
				</div>
			</details>

			<p className="mcp-footnote">
				插件容器由插件主机管理，控制台只负责下发安装与生命周期操作；启用状态保存在控制台，token 与配置保存在主机上，不回显。卸载默认保留数据目录，是否同时删除数据由二次确认决定。
			</p>
		</div>
	);
}
