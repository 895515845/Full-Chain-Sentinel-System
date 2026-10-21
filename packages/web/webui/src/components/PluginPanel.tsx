import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { readFileBase64 } from "./PocPage.tsx";
import { OfficialPluginsPanel } from "./OfficialPluginsPanel.tsx";
import { PluginDevDocs } from "./PluginDevDocs.tsx";
import type {
	SentinelOfficialPluginView,
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
import { t } from "../i18n.ts";

const STATE_LABELS: Record<SentinelPluginState, string> = {
	running: t("运行中"),
	starting: t("启动中"),
	stopped: t("已停止"),
	failed: t("失败"),
	missing: t("缺失"),
};

const STATE_TONES: Record<SentinelPluginState, "ok" | "warn" | "bad" | "off"> = {
	running: "ok",
	starting: "warn",
	stopped: "off",
	failed: "bad",
	missing: "bad",
};

const LOCALITY_LABELS: Record<SentinelPluginLocality, string> = {
	"local-only": t("仅本地"),
	"remote-only": t("仅远端"),
	any: t("不限"),
};

const NETWORK_LABELS: Record<SentinelPluginNetwork, string> = {
	none: t("无网络"),
	bridge: t("bridge（NAT）"),
	host: t("host（宿主网络栈）"),
};

const MAX_PLUGIN_PACKAGE_BYTES = 8 * 1024 * 1024;

/** The host editor's working copy; `original` is set while editing an existing host. */
interface HostDraft {
	original?: string;
	name: string;
	url: string;
	token: string;
}

const EMPTY_HOST_DRAFT: HostDraft = { name: "", url: "", token: "" };

type DrawerTab = "config" | "logs" | "artifacts";

function formatWhen(at: number | null): string {
	if (at === null) return t("尚未连接");
	const date = new Date(at);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pluginKeyOf(plugin: SentinelPluginView): string {
	return `${plugin.hostId}/${plugin.manifest.id}`;
}

function StateChip({ state }: { state: SentinelPluginState }): React.ReactElement {
	const tone = STATE_TONES[state];
	return (
		<span className={`chip ${tone === "off" ? "" : tone}`}>
			<span className={`dot ${tone === "off" ? "" : tone}`} />
			{STATE_LABELS[state]}
		</span>
	);
}

/**
 * The 设置 → 插件 section.
 *
 * A plugin is one Docker image on one plugin host, mounted as an MCP server for
 * the agent. The page is a dense table plus one drawer: rows are for scanning
 * state, the drawer is where a plugin is installed, configured, started, and
 * inspected. The table stays readable with a hundred plugins; the drawer keeps
 * every destructive action one deliberate click away from a row.
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
	onOpenUi,
	onSetSidebar,
	officialPlugins,
	onChooseOfficial,
	buildLog,
	onLoadBuildLog,
	onCloseManifest,
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
		allowBuild: boolean;
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
	/** Open the plugin's own frontend, when it ships one. */
	onOpenUi: (plugin: SentinelPluginView) => void;
	/** Pin or unpin a plugin's UI on the sidebar. */
	onSetSidebar: (hostId: string, pluginId: string, pinned: boolean) => void;
	/** Official packages bundled with the console. */
	officialPlugins: SentinelOfficialPluginView[];
	onChooseOfficial: (plugin: SentinelOfficialPluginView) => void;
	/** Streaming docker build output for the install currently in progress. */
	buildLog: { hostId: string; pluginId: string; log: string } | null;
	onLoadBuildLog: (hostId: string, pluginId: string) => void;
	/** Close the install drawer by dropping the uploaded manifest. */
	onCloseManifest: () => void;
}) {
	const [hostDraft, setHostDraft] = useState<HostDraft | null>(null);
	const [packageFile, setPackageFile] = useState<{ name: string; size: number } | null>(null);
	const [packageError, setPackageError] = useState<string | null>(null);
	const [activeTab, setActiveTab] = useState<"plugins" | "official" | "docs">("plugins");
	const [installHostId, setInstallHostId] = useState("");
	const [configValues, setConfigValues] = useState<Record<string, string>>({});
	const [allowBuild, setAllowBuild] = useState(false);
	const [allowHostNetwork, setAllowHostNetwork] = useState(false);
	const [allowPrivileged, setAllowPrivileged] = useState(false);
	const [installPending, setInstallPending] = useState(false);
	const installLogRef = useRef<HTMLPreElement | null>(null);
	const [editingPlugin, setEditingPlugin] = useState<string | null>(null);
	const [editValues, setEditValues] = useState<Record<string, string>>({});
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [drawerTab, setDrawerTab] = useState<DrawerTab>("config");
	const [artifactPage, setArtifactPage] = useState(0);
	const [artifactQuery, setArtifactQuery] = useState("");
	const [query, setQuery] = useState("");
	const [hostFilter, setHostFilter] = useState("all");
	const [stateFilter, setStateFilter] = useState("all");
	const fileInput = useRef<HTMLInputElement | null>(null);

	const running = view.plugins.filter((plugin) => plugin.state === "running").length;
	const failed = view.plugins.filter((plugin) => plugin.state === "failed").length;
	const localHost = view.hosts.find((host) => host.local);
	// A local host is only absent when the daemon was never started, or when it
	// answered once and then stopped; both have the same one-line fix.
	const localHostDown = !localHost || (localHost.status.at !== null && !localHost.status.ok);

	// A new manifest resets the acknowledgement boxes and the config form: the
	// declarations belong to that manifest, and a stale "host network allowed"
	// from a previous upload must never carry over.
	useEffect(() => {
		if (!pendingManifest) return;
		const next: Record<string, string> = {};
		for (const field of pendingManifest.manifest.config) {
			const value = field.default;
			next[field.key] =
				value === null ? "" : typeof value === "boolean" ? (value ? "true" : "false") : String(value);
		}
		setConfigValues(next);
		setAllowBuild(false);
		setAllowHostNetwork(false);
		setAllowPrivileged(false);
		setSelectedKey(null);
		setHostDraft(null);
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

	// Poll the host's build.log while this install is running; the host appends
	// docker build output as it arrives, so both uploads and official packages
	// show the same live log.
	useEffect(() => {
		if (!installPending || !busy || !pendingManifest || !installHostId) return;
		const pluginId = pendingManifest.manifest.id;
		const tick = () => onLoadBuildLog(installHostId, pluginId);
		tick();
		const timer = window.setInterval(tick, 1000);
		return () => window.clearInterval(timer);
	}, [busy, installHostId, installPending, onLoadBuildLog, pendingManifest]);

	useEffect(() => {
		if (!buildLog || !installLogRef.current) return;
		installLogRef.current.scrollTop = installLogRef.current.scrollHeight;
	}, [buildLog]);

	// A plugin that vanished (uninstalled here or on another console) must not
	// leave a drawer open on a row that no longer exists.
	useEffect(() => {
		if (!selectedKey) return;
		if (view.plugins.some((plugin) => pluginKeyOf(plugin) === selectedKey)) return;
		setSelectedKey(null);
		setEditingPlugin(null);
	}, [view.plugins, selectedKey]);

	const manifest = pendingManifest?.manifest ?? null;
	const selected = view.plugins.find((plugin) => pluginKeyOf(plugin) === selectedKey) ?? null;
	const drawerOpen = Boolean(pendingManifest || hostDraft || selected);

	const configComplete =
		manifest === null ||
		manifest.config.every(
			(field) => !field.required || (configValues[field.key] ?? "").trim().length > 0,
		);
	const permissionsAllowed =
		manifest === null ||
		((manifest.permissions.network !== "host" || allowHostNetwork) &&
			(!manifest.permissions.privileged || allowPrivileged));
	const installReady =
		manifest !== null && installHostId !== "" && configComplete && permissionsAllowed && allowBuild;
	const hostValid =
		hostDraft !== null &&
		hostDraft.name.trim().length > 0 &&
		hostDraft.url.trim().length > 0 &&
		(hostDraft.original !== undefined || hostDraft.token.trim().length > 0);

	const filtered = view.plugins.filter((plugin) => {
		if (hostFilter !== "all" && plugin.hostId !== hostFilter) return false;
		if (stateFilter !== "all" && plugin.state !== stateFilter) return false;
		const needle = query.trim().toLowerCase();
		if (!needle) return true;
		const haystack = [
			plugin.manifest.name,
			plugin.manifest.id,
			plugin.hostName,
			...plugin.manifest.tools.map((tool) => tool.name),
		]
			.join(" ")
			.toLowerCase();
		return haystack.includes(needle);
	});

	const closeDrawer = (): void => {
		setSelectedKey(null);
		setHostDraft(null);
		setEditingPlugin(null);
		onCloseLogs();
		onCloseArtifacts();
		if (pendingManifest) onCloseManifest();
	};

	// The drawer is modal: the page behind it must not scroll, and Escape closes it.
	useEffect(() => {
		if (!drawerOpen) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") closeDrawer();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.body.style.overflow = previous;
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [drawerOpen]);

	const openPlugin = (plugin: SentinelPluginView): void => {
		setHostDraft(null);
		setSelectedKey(pluginKeyOf(plugin));
		setEditingPlugin(null);
		setDrawerTab("config");
		setArtifactPage(0);
		setArtifactQuery("");
		onCloseLogs();
		onCloseArtifacts();
		if (pendingManifest) onCloseManifest();
	};

	const startAddHost = (): void => {
		setSelectedKey(null);
		if (pendingManifest) onCloseManifest();
		setHostDraft({ ...EMPTY_HOST_DRAFT });
	};

	const startEditHost = (host: SentinelPluginHostView): void => {
		setSelectedKey(null);
		if (pendingManifest) onCloseManifest();
		setHostDraft({ original: host.id, name: host.name, url: host.url, token: "" });
	};

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
			setPackageError(t("插件包最大 {size}MB", { size: MAX_PLUGIN_PACKAGE_BYTES / (1024 * 1024) }));
			return;
		}
		void readFileBase64(file)
			.then((data) => {
				setPackageFile({ name: file.name, size: file.size });
				onInspectPackage(file.name, data);
			})
			.catch((error: unknown) => setPackageError(error instanceof Error ? error.message : String(error)));
	};

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
			allowBuild,
			allowHostNetwork,
			allowPrivileged,
			config,
		});
	};

	const uninstall = (plugin: SentinelPluginView): void => {
		if (!window.confirm(t("卸载插件「{name}」？", { name: plugin.manifest.name }))) return;
		// A second question is the purge decision: keeping the data directory is
		// the safer default, so it is the "cancel" branch of the dialog.
		const purge = window.confirm(
			t("是否同时删除该插件的数据？\n确定 = 删除容器配置与产物；取消 = 保留数据目录。"),
		);
		onUninstall(plugin.hostId, plugin.manifest.id, purge);
		closeDrawer();
	};

	const renderConfigField = (
		field: SentinelPluginConfigField,
		value: string,
		set: (next: string) => void,
		secretHint: string,
	): React.ReactElement => {
		const hint = [field.description, field.required ? t("必填") : ""].filter(Boolean).join(" · ");

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
						<option value="">{field.required ? t("请选择") : t("（不设置）")}</option>
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
			t("不会回显已保存的值"),
		);

	const openConfig = (plugin: SentinelPluginView): void => {
		const key = pluginKeyOf(plugin);
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
		setDrawerTab("config");
	};

	const editComplete = (plugin: SentinelPluginView): boolean =>
		plugin.manifest.config.every((field) => {
			if (!field.required) return true;
			if ((editValues[field.key] ?? "").trim() !== "") return true;
			// A required secret may be blank only when a value is already stored.
			return field.type === "secret" && plugin.configured.includes(field.key);
		});

	const selectedLogs =
		selected && logs && logs.hostId === selected.hostId && logs.pluginId === selected.manifest.id ? logs : null;
	const selectedArtifacts =
		selected && artifacts && artifacts.hostId === selected.hostId && artifacts.pluginId === selected.manifest.id
			? artifacts
			: null;
	const ARTIFACT_PAGE_SIZE = 10;
	const allArtifacts = selectedArtifacts?.items ?? [];
	const filteredArtifacts = allArtifacts
		.filter((artifact) => !artifactQuery || artifact.path.toLowerCase().includes(artifactQuery.toLowerCase()))
		.slice()
		.sort((left, right) => right.path.localeCompare(left.path));
	const artifactPageCount = Math.max(1, Math.ceil(filteredArtifacts.length / ARTIFACT_PAGE_SIZE));
	const artifactPageIndex = Math.min(artifactPage, artifactPageCount - 1);
	const visibleArtifacts = filteredArtifacts.slice(
		artifactPageIndex * ARTIFACT_PAGE_SIZE,
		artifactPageIndex * ARTIFACT_PAGE_SIZE + ARTIFACT_PAGE_SIZE,
	);

	return (
		<div className="mcp-page plugin-page">
			<div className="plugin-head">
				<div className="plugin-switch" role="tablist" aria-label={t("插件视图")}>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "plugins"}
						className={activeTab === "plugins" ? "active" : undefined}
						onClick={() => setActiveTab("plugins")}
					>
						{t("已安装")}<span className="n">{view.plugins.length}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "official"}
						className={activeTab === "official" ? "active" : undefined}
						onClick={() => {
							setActiveTab("official");
							closeDrawer();
						}}
					>
						{t("官方插件")}<span className="n">{officialPlugins.length}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "docs"}
						className={activeTab === "docs" ? "active" : undefined}
						onClick={() => {
							setActiveTab("docs");
							closeDrawer();
						}}
					>
						{t("开发文档")}
					</button>
				</div>
				<div className="actions">
					<button type="button" disabled={busy} onClick={onRefresh}>
						{t("刷新")}
					</button>
					<button
						type="button"
						className="primary"
						disabled={busy}
						onClick={() => fileInput.current?.click()}
					>
						{t("＋ 上传插件包")}
					</button>
					<input
						ref={fileInput}
						type="file"
						accept=".zip"
						hidden
						onChange={choosePackage}
						aria-label={t("插件包文件")}
					/>
				</div>
			</div>

			{activeTab === "docs" ? (
				<PluginDevDocs />
			) : activeTab === "official" ? (
				<OfficialPluginsPanel
					plugins={officialPlugins}
					installed={view.plugins}
					hosts={view.hosts}
					busy={busy}
					onChoose={onChooseOfficial}
				/>
			) : (
				<>
			{notice ? <div className="mcp-notice">{notice}</div> : null}

			{permissionOn === false ? (
				<div className="mcp-notice is-warn">
					<b>{t("权限未开启")}</b>
					{t("「设置 → 权限」里的")} <code>MCP</code>{" "}
					{t("开关是关的，本页的插件都不会挂载。")}
					<button type="button" className="link" onClick={onOpenPermissions}>
						{t("去打开")}
					</button>
				</div>
			) : null}

			{packageError ? <div className="plugin-error">{packageError}</div> : null}

			{view.problems.length > 0 ? (
				<ul className="plugin-problems">
					{view.problems.map((problem) => (
						<li key={problem}>{problem}</li>
					))}
				</ul>
			) : null}

			<div className="plugin-hosts">
				{view.hosts.map((host) => (
					<div className="plugin-host-chip" key={host.id}>
						<span
							className={`dot ${
								host.status.at === null ? "" : host.status.ok ? "ok" : "bad"
							}`}
						/>
						<b>{host.name}</b>
						<span className="mono muted">{host.url.replace(/^https?:\/\//, "")}</span>
						{host.local ? <span className="chip">{t("自动发现")}</span> : null}
						<span className="plugin-host-chip__state">
							{host.status.at === null
								? t("未测试")
								: host.status.ok
									? t("已连接 · {when}", { when: formatWhen(host.status.at) })
									: host.status.error || t("连接失败")}
						</span>
						<button type="button" className="link" disabled={busy} onClick={() => onTestHost(host.id)}>
							{t("测试")}
						</button>
						{!host.local ? (
							<button type="button" className="link" disabled={busy} onClick={() => startEditHost(host)}>
								{t("编辑")}
							</button>
						) : null}
						{!host.local ? (
							<button
								type="button"
								className="link danger"
								disabled={busy}
								onClick={() => {
									if (window.confirm(t("删除插件主机「{name}」？它上面的插件将从控制台消失。", { name: host.name }))) {
										onDeleteHost(host.id);
									}
								}}
							>
								{t("删除")}
							</button>
						) : null}
					</div>
				))}
				<button type="button" className="link" disabled={busy} onClick={startAddHost}>
					{t("＋ 添加主机")}
				</button>
			</div>

			{localHostDown ? (
				<p className="plugin-host-hint">
					{t("本机还没有可用的插件主机。在终端运行")} <code>sentinel-web plugin-host --local</code>{t("，或")}
					<code>npm run plugin-host -- --local</code>
					{t("，控制台会自动发现它。")}
				</p>
			) : null}

			<div className="plugin-toolbar">
				<input
					className="plugin-search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t("搜索插件名、id、工具名")}
					spellCheck={false}
					aria-label={t("搜索插件")}
				/>
				<select value={hostFilter} onChange={(event) => setHostFilter(event.target.value)}>
					<option value="all">{t("全部主机")}</option>
					{view.hosts.map((host) => (
						<option value={host.id} key={host.id}>
							{host.name}
						</option>
					))}
				</select>
				<select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
					<option value="all">{t("全部状态")}</option>
					<option value="running">{t("运行中")}</option>
					<option value="stopped">{t("已停止")}</option>
					<option value="failed">{t("失败")}</option>
				</select>
				<div className="plugin-toolbar__spacer" />
				<span className="chip ok">{running} {t("运行")}</span>
				{failed > 0 ? <span className="chip bad">{failed} {t("失败")}</span> : null}
			</div>

			<div className="plugin-table-wrap">
				<table className="plugin-table">
					<thead>
						<tr>
							<th aria-label={t("状态")} />
							<th>{t("插件")}</th>
							<th>{t("版本")}</th>
							<th>{t("主机")}</th>
							<th>{t("网络")}</th>
							<th className="num">{t("工具")}</th>
							<th>{t("状态")}</th>
							<th>{t("安装时间")}</th>
							<th aria-label={t("操作")} />
						</tr>
					</thead>
					<tbody>
						{filtered.map((plugin) => {
							const key = pluginKeyOf(plugin);
							const tone = STATE_TONES[plugin.state];
							return (
								<tr
									key={key}
									tabIndex={0}
									className={selectedKey === key ? "is-selected" : undefined}
									onClick={() => openPlugin(plugin)}
									onKeyDown={(event) => {
										if (event.key !== "Enter" && event.key !== " ") return;
										event.preventDefault();
										openPlugin(plugin);
									}}
								>
									<td>
										<span className={`dot ${tone === "off" ? "" : tone}`} />
									</td>
									<td>
										<div className="plugin-table__name">{plugin.manifest.name}</div>
										<div className="plugin-table__id mono">{plugin.manifest.id}</div>
									</td>
									<td className="mono">v{plugin.manifest.version}</td>
									<td>
										{plugin.hostName}
										{plugin.hostLocal ? t("（本机）") : ""}
									</td>
									<td>
										<span className="chip">{plugin.manifest.permissions.network}</span>
									</td>
									<td className="num">{plugin.manifest.tools.length}</td>
									<td>
										<StateChip state={plugin.state} />
										{plugin.lastError ? (
											<span className="plugin-table__error" title={plugin.lastError}>
												{t("有错误")}
											</span>
										) : null}
									</td>
									<td className="mono muted">{formatWhen(plugin.installedAt)}</td>
									<td className="plugin-table__ops" onClick={(event) => event.stopPropagation()}>
										<button
											type="button"
											className="link"
											disabled={busy}
											onClick={() =>
												plugin.state === "running"
													? onStop(plugin.hostId, plugin.manifest.id)
													: onStart(plugin.hostId, plugin.manifest.id)
											}
										>
											{plugin.state === "running" ? t("停止") : t("启动")}
										</button>
										<button type="button" className="link" onClick={() => openPlugin(plugin)}>
											{t("详情")}
										</button>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
				{filtered.length === 0 ? (
					<div className="plugin-empty">
						{view.plugins.length === 0
							? t("还没有安装插件。点右上角「上传插件包」开始。")
							: t("没有匹配的插件，换个关键字或筛选条件。")}
					</div>
				) : null}
			</div>

		

			<p className="mcp-footnote">
				{t("工具调用不逐条拦截，只记审计；管理操作写入")} <code>plugin-audit.jsonl</code>{t("。启用开关只影响挂载，不会停止容器；卸载默认保留数据目录。")}
			</p>
				</>
			)}

			{drawerOpen ? (
				<div className="plugin-drawer-layer">
					<div className="plugin-drawer-mask" onClick={closeDrawer} />
					<aside className="plugin-drawer" role="dialog" aria-modal="true">
						{pendingManifest ? (
							<>
								<div className="plugin-drawer__head">
									<div>
										<div className="plugin-drawer__title">
											{/^(官方|Official)/.test(pendingManifest.source) ? t("安装官方插件") : t("安装插件包")}
										</div>
										<div className="plugin-drawer__sub">
											{pendingManifest.source}
											{packageFile ? ` · ${formatSize(packageFile.size)}` : ""}
										</div>
									</div>
									<button type="button" className="plugin-drawer__close" onClick={closeDrawer}>
										×
									</button>
								</div>
								<div className="plugin-drawer__body">
									<div className="drawer-plugin">
										<div className="drawer-plugin__icon">{manifest?.id.slice(0, 1).toUpperCase()}</div>
										<div>
											<div className="drawer-plugin__name">
												{manifest?.name} <span className="mono muted">v{manifest?.version}</span>
											</div>
											<div className="muted">
												{manifest?.id} · {manifest?.author}
											</div>
										</div>
									</div>

									<div className="drawer-kv">
										<div>
											<span>{t("构建")}</span>
											<code>{manifest?.build.dockerfile}</code>
										</div>
										<div>
											<span>{t("上下文")}</span>
											<code>{manifest?.build.context}</code>
										</div>
										<div>
											<span>locality</span>
											<b>{manifest ? LOCALITY_LABELS[manifest.locality] : ""}</b>
										</div>
										<div>
											<span>MCP</span>
											<code>
												{manifest?.mcp.port}
												{manifest?.mcp.path}
											</code>
										</div>
										<div>
											<span>{t("源码")}</span>
											<a href={manifest?.source} target="_blank" rel="noreferrer">
												{manifest?.source}
											</a>
										</div>
									</div>

									<div className="drawer-section">{t("权限")}</div>
									<div className="drawer-chips">
										<span className="chip info">
											network {manifest ? NETWORK_LABELS[manifest.permissions.network] : ""}
										</span>
										{manifest?.permissions.capAdd.map((cap) => (
											<span className="chip warn" key={cap}>
												{cap}
											</span>
										))}
										<span className={`chip ${manifest?.permissions.privileged ? "bad" : ""}`}>
											privileged {manifest?.permissions.privileged ? t("是") : t("否")}
										</span>
									</div>

									<label className="mcp-editor__ack">
										<input
											type="checkbox"
											checked={allowBuild}
											disabled={busy}
											onChange={(event) => setAllowBuild(event.target.checked)}
										/>
										{t("允许在插件主机上执行插件包里的 Dockerfile：构建阶段可以运行任意命令，并以宿主机 Docker 守护进程的权限访问网络。")}
									</label>
									{manifest?.permissions.network === "host" ? (
										<label className="mcp-editor__ack">
											<input
												type="checkbox"
												checked={allowHostNetwork}
												disabled={busy}
												onChange={(event) => setAllowHostNetwork(event.target.checked)}
											/>
											{t("允许 host 网络：插件容器直接使用宿主网络栈，能访问本机所有监听端口。")}
										</label>
									) : null}
									{manifest?.permissions.privileged ? (
										<label className="mcp-editor__ack">
											<input
												type="checkbox"
												checked={allowPrivileged}
												disabled={busy}
												onChange={(event) => setAllowPrivileged(event.target.checked)}
											/>
											{t("允许 privileged：容器获得全部 Linux 能力，隔离性显著降低。")}
										</label>
									) : null}

									{manifest && manifest.config.length > 0 ? (
										<>
											<div className="drawer-section">{t("配置")}</div>
											<div className="mcp-editor__grid">
												{manifest.config.map((field) => configInput(field))}
											</div>
										</>
									) : null}

									<div className="drawer-section">{t("目标 host")}</div>
									<select
										className="drawer-select"
										value={installHostId}
										disabled={busy || view.hosts.length === 0}
										onChange={(event) => setInstallHostId(event.target.value)}
									>
										{view.hosts.map((host) => (
											<option value={host.id} key={host.id}>
												{host.name}
												{host.local ? t("（本机）") : ""}
											</option>
										))}
									</select>
									{view.hosts.length === 0 ? <p className="hint">{t("先添加一个插件主机。")}</p> : null}

									{!configComplete ? <p className="hint">{t("还有必填配置没有填写。")}</p> : null}
									{!permissionsAllowed ? (
										<p className="hint">{t("需要先勾选上面声明的权限才能安装。")}</p>
									) : null}
									{installPending && busy ? (
										<p className="plugin-install__progress">
											{t("正在构建镜像并等待健康检查，可能需要几分钟。")}
										</p>
									) : null}
									{installPending || (buildLog && buildLog.pluginId === manifest?.id) ? (
										<div className="plugin-install-log">
											<div className="plugin-install-log__head">
												<span>{t("安装日志")}</span>
												<span className="muted">
													{busy ? t("实时") : t("已结束")}
												</span>
											</div>
											<pre ref={installLogRef}>
												{buildLog && buildLog.pluginId === manifest?.id && buildLog.log
													? buildLog.log
													: t("等待 Docker 构建输出…")}
											</pre>
										</div>
									) : null}
								</div>
								<div className="plugin-drawer__foot">
									<button type="button" onClick={closeDrawer}>
										{t("取消")}
									</button>
									<button
										type="button"
										className="primary"
										disabled={busy || !installReady}
										onClick={install}
									>
										{installPending && busy ? t("安装中…") : t("安装")}
									</button>
								</div>
							</>
						) : null}

						{hostDraft ? (
							<>
								<div className="plugin-drawer__head">
									<div>
										<div className="plugin-drawer__title">
											{hostDraft.original ? t("编辑插件主机") : t("添加插件主机")}
										</div>
										<div className="plugin-drawer__sub">
											{t("host 是运行插件容器的机器；本机 host 由 plugin-host --local 自动发现。")}
										</div>
									</div>
									<button type="button" className="plugin-drawer__close" onClick={() => setHostDraft(null)}>
										×
									</button>
								</div>
								<div className="plugin-drawer__body">
									<div className="mcp-editor__grid">
										<label>
											{t("名称")}
											<input
												value={hostDraft.name}
												disabled={busy}
												onChange={(event) =>
													setHostDraft((prev) => (prev ? { ...prev, name: event.target.value } : prev))
												}
												placeholder={t("本机 / vps-hk")}
											/>
										</label>
										<label>
											URL
											<input
												value={hostDraft.url}
												disabled={busy}
												onChange={(event) =>
													setHostDraft((prev) => (prev ? { ...prev, url: event.target.value } : prev))
												}
												placeholder="https://sentinel.example.com"
												spellCheck={false}
											/>
											<span className="hint">{t("非回环地址必须 HTTPS，且证书要受信任。")}</span>
										</label>
										<label>
											token
											<input
												type="password"
												value={hostDraft.token}
												disabled={busy}
												onChange={(event) =>
													setHostDraft((prev) => (prev ? { ...prev, token: event.target.value } : prev))
												}
												placeholder={hostDraft.original ? t("留空保持已保存的 token") : t("plugin-host 启动时打印的 token")}
												autoComplete="off"
											/>
										</label>
									</div>
									<p className="hint">
										{t("本机 host 只需要运行")} <code>sentinel-web plugin-host --local</code>
										{t("，不用手填地址与 token。")}
									</p>
								</div>
								<div className="plugin-drawer__foot">
									<button type="button" onClick={() => setHostDraft(null)}>
										{t("取消")}
									</button>
									<button type="button" className="primary" disabled={busy || !hostValid} onClick={submitHost}>
										{t("保存")}
									</button>
								</div>
							</>
						) : null}

						{selected ? (
							<>
								<div className="plugin-drawer__head">
									<div>
										<div className="plugin-drawer__title">
											{selected.manifest.name}{" "}
											<span className="mono muted">v{selected.manifest.version}</span>
										</div>
										<div className="plugin-drawer__sub mono">
											{selected.manifest.id} · {selected.hostName}
											{selected.hostLocal ? t("（本机）") : ""}
										</div>
									</div>
									<button type="button" className="plugin-drawer__close" onClick={closeDrawer}>
										×
									</button>
								</div>
								<div className="plugin-drawer__body">
									<div className="drawer-state">
										<StateChip state={selected.state} />
										<span className="muted">
											{selected.state === "running"
												? selected.healthy
													? t("健康")
													: t("不健康")
												: formatWhen(selected.installedAt)}
										</span>
										<label className="mcp-switch" title={selected.enabled ? t("停用该插件") : t("启用该插件")}>
											<input
												type="checkbox"
												checked={selected.enabled}
												disabled={busy}
												aria-label={t("启用 {name}", { name: selected.manifest.name })}
												onChange={(event) =>
													onSetEnabled(selected.hostId, selected.manifest.id, event.target.checked)
												}
											/>
											<span />
										</label>
										<span className="muted">{selected.enabled ? t("已挂载") : t("已停用")}</span>
									</div>

									{selected.manifest.description ? (
										<p className="drawer-desc">{selected.manifest.description}</p>
									) : null}

									<div className="drawer-kv">
										<div>
											<span>{t("构建")}</span>
											<code>
												{selected.manifest.build.dockerfile} · {selected.manifest.build.context}
											</code>
										</div>
										<div>
											<span>{t("端口")}</span>
											<code>{selected.hostPort === null ? t("未分配") : `127.0.0.1:${selected.hostPort}`}</code>
										</div>
										<div>
											<span>locality</span>
											<b>{LOCALITY_LABELS[selected.manifest.locality]}</b>
										</div>
										<div>
											<span>{t("安装时间")}</span>
											<b>{formatWhen(selected.installedAt)}</b>
										</div>
									</div>

									{selected.lastError ? (
										<div className="drawer-error">{selected.lastError}</div>
									) : null}

									<div className="drawer-section">{t("权限")}</div>
									<div className="drawer-chips">
										<span className="chip info">network {selected.manifest.permissions.network}</span>
										{selected.manifest.permissions.capAdd.map((cap) => (
											<span className="chip warn" key={cap}>
												{cap}
											</span>
										))}
										<span className={`chip ${selected.manifest.permissions.privileged ? "bad" : ""}`}>
											privileged {selected.manifest.permissions.privileged ? t("是") : t("否")}
										</span>
									</div>

									<div className="drawer-section">{t("工具")}</div>
									<div className="drawer-chips">
										{selected.manifest.tools.length > 0 ? (
											selected.manifest.tools.map((tool) => <code key={tool.name}>{tool.name}</code>)
										) : (
											<span className="muted">{t("manifest 未声明工具")}</span>
										)}
									</div>

									{selected.manifest.ui?.sidebar ? (
										<>
											<div className="drawer-section">{t("界面")}</div>
											<div className="plugin-ui-pref">
												<div className="plugin-ui-pref__text">
													<b>{t("显示在侧边栏")}</b>
													<span className="muted">{t("在主内容区打开，和对话、工程并列")}</span>
												</div>
												<label className="mcp-switch" title={selected.pinned ? t("从侧栏移除") : t("固定到侧栏")}>
													<input
														type="checkbox"
														checked={selected.pinned}
														disabled={busy}
														aria-label={t("显示在侧边栏")}
														onChange={(event) =>
															onSetSidebar(selected.hostId, selected.manifest.id, event.target.checked)
														}
													/>
													<span />
												</label>
											</div>
										</>
									) : null}

									<div className="drawer-tabs">
										<button
											type="button"
											className={drawerTab === "config" ? "active" : undefined}
											onClick={() => setDrawerTab("config")}
										>
											{t("配置")}
										</button>
										<button
											type="button"
											className={drawerTab === "logs" ? "active" : undefined}
											onClick={() => setDrawerTab("logs")}
										>
											{t("日志")}
										</button>
										<button
											type="button"
											className={drawerTab === "artifacts" ? "active" : undefined}
											onClick={() => setDrawerTab("artifacts")}
										>
											{t("产物")}
										</button>
									</div>

									{drawerTab === "config" ? (
										<div className="drawer-tab">
											{selected.manifest.config.length === 0 ? (
												<p className="muted">{t("这个插件没有配置项。")}</p>
											) : editingPlugin === pluginKeyOf(selected) ? (
												<>
													<div className="mcp-editor__grid">
														{selected.manifest.config.map((field) =>
															renderConfigField(
																field,
																editValues[field.key] ?? "",
																(next) => setEditValues((prev) => ({ ...prev, [field.key]: next })),
																selected.configured.includes(field.key)
																	? t("已保存，留空保持不变")
																	: t("尚未设置"),
															),
														)}
													</div>
													<p className="hint">
														{t("保存会重建容器使新环境变量生效；密钥留空表示保持已保存的值。")}
													</p>
													<div className="drawer-actions">
														<button type="button" disabled={busy} onClick={() => setEditingPlugin(null)}>
															{t("取消")}
														</button>
														<button
															type="button"
															className="primary"
															disabled={busy || !editComplete(selected)}
															onClick={() => {
																onSaveConfig(selected.hostId, selected.manifest.id, editValues);
																setEditingPlugin(null);
															}}
														>
															{t("保存并重启")}
														</button>
													</div>
												</>
											) : (
												<>
													{selected.manifest.config.map((field) => (
														<div className="drawer-cfg-row" key={field.key}>
															<code>{field.key}</code>
															<span className="muted">
																{selected.configured.includes(field.key)
																	? field.type === "secret"
																		? t("已设置，不回显")
																		: selected.values[field.key] || t("已设置")
																	: t("未设置")}
															</span>
														</div>
													))}
													<div className="drawer-actions">
														<button type="button" disabled={busy} onClick={() => openConfig(selected)}>
															{t("改配置")}
														</button>
													</div>
												</>
											)}
										</div>
									) : null}

									{drawerTab === "logs" ? (
										<div className="drawer-tab">
											<div className="drawer-actions">
												<button
													type="button"
													disabled={busy}
													onClick={() => onLoadLogs(selected.hostId, selected.manifest.id)}
												>
													{selectedLogs ? t("刷新日志") : t("加载日志")}
												</button>
											</div>
											<pre className="plugin-logs">{selectedLogs?.logs || t("还没有加载日志。")}</pre>
										</div>
									) : null}

									{drawerTab === "artifacts" ? (
										<div className="drawer-tab">
											<div className="drawer-artifacts__toolbar">
												<input
													type="search"
													className="plugin-search"
													value={artifactQuery}
													placeholder={t("筛选产物路径")}
													onChange={(event) => {
														setArtifactQuery(event.target.value);
														setArtifactPage(0);
													}}
												/>
												<button
													type="button"
													disabled={busy}
													onClick={() => {
														setArtifactPage(0);
														onListArtifacts(selected.hostId, selected.manifest.id);
													}}
												>
													{selectedArtifacts ? t("刷新产物") : t("加载产物")}
												</button>
											</div>
											{selectedArtifacts ? (
												allArtifacts.length === 0 ? (
													<p className="muted">{t("还没有产物。")}</p>
												) : filteredArtifacts.length === 0 ? (
													<p className="muted">{t("没有匹配「{query}」的产物。", { query: artifactQuery })}</p>
												) : (
													<>
														<div className="drawer-artifacts__pager">
															<span className="muted">
																{t("共 {count} 个", { count: filteredArtifacts.length })}
																{artifactQuery ? t("（全部 {count} 个）", { count: allArtifacts.length }) : ""}
															</span>
															<div className="drawer-pager">
																<button
																	type="button"
																	disabled={artifactPageIndex === 0}
																	onClick={() => setArtifactPage(artifactPageIndex - 1)}
																>
																	{t("上一页")}
																</button>
																<span className="muted">
																	{artifactPageIndex + 1} / {artifactPageCount}
																</span>
																<button
																	type="button"
																	disabled={artifactPageIndex >= artifactPageCount - 1}
																	onClick={() => setArtifactPage(artifactPageIndex + 1)}
																>
																	{t("下一页")}
																</button>
															</div>
														</div>
														{visibleArtifacts.map((artifact) => (
															<div className="drawer-artifact" key={artifact.path}>
																<code>{artifact.path}</code>
																<span className="muted">{formatSize(artifact.size)}</span>
																<button
																	type="button"
																	className="link"
																	disabled={busy}
																	onClick={() =>
																		onFetchArtifact(selected.hostId, selected.manifest.id, artifact.path)
																	}
																>
																	{t("拉取")}
																</button>
															</div>
														))}
														{allArtifacts.length >= 2000 ? (
															<p className="hint">{t("最多列出 2000 个产物，更早的文件请先清理。")}</p>
														) : null}
													</>
												)
											) : (
												<p className="muted">{t("点上面的按钮读取产物列表。")}</p>
											)}
											<p className="hint">{t("拉取的文件保存到当前项目的")} <code>evidence/plugin/</code>{t("下。")}</p>
										</div>
									) : null}
								</div>
								<div className="plugin-drawer__foot">
									<button
										type="button"
										disabled={busy}
										onClick={() =>
											selected.state === "running"
												? onStop(selected.hostId, selected.manifest.id)
												: onStart(selected.hostId, selected.manifest.id)
										}
									>
										{selected.state === "running" ? t("停止") : t("启动")}
									</button>
									<button
										type="button"
										disabled={busy}
										onClick={() => {
											setDrawerTab("logs");
											onLoadLogs(selected.hostId, selected.manifest.id);
										}}
									>
										{t("日志")}
									</button>
									<button
										type="button"
										disabled={busy}
										onClick={() => {
											setDrawerTab("artifacts");
											onListArtifacts(selected.hostId, selected.manifest.id);
										}}
									>
										{t("产物")}
									</button>
									{selected.manifest.ui ? (
										<button
											type="button"
											className="primary"
											disabled={busy || selected.state !== "running"}
											title={selected.state === "running" ? t("在沙箱里打开插件界面") : t("插件未运行，先启动再打开界面")}
											onClick={() => onOpenUi(selected)}
										>
											{t("打开界面")}
										</button>
									) : null}
									<button
										type="button"
										className="danger"
										disabled={busy}
										onClick={() => uninstall(selected)}
									>
										{t("卸载")}
									</button>
								</div>
							</>
						) : null}
					</aside>
				</div>
			) : null}
		</div>
	);
}
