/**
 * The 代理 page: named proxies, and the sing-box image their sidecars run.
 *
 * A profile is the whole description of one node — a SOCKS5/HTTP endpoint, or a
 * subscription whose nodes are fetched — and projects point at it by id. That
 * is why editing a profile here reaches every project that uses it, and why the
 * page says how many do: deleting one is the only action on this page that
 * changes what a running engagement will do next.
 *
 * The generated sidecar configuration is not shown here. It is the console's, not
 * the operator's: the tunnel inbound, the DNS escape and the route order are
 * decisions that only have one right answer, and the page says so instead of
 * offering them as fields.
 */

import { useMemo, useState } from "react";
import { t } from "../i18n.ts";
import {
	AUTO_NODE_TAG,
	EMPTY_PROXY_INPUT,
	type SentinelProjectInfo,
	type SentinelProxy,
	type SentinelProxyConfigView,
	type SentinelProxyInput,
} from "../types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** How a profile's traffic leaves, in one line, for the table. */
function describe(proxy: SentinelProxy): string {
	if (proxy.mode === "simple") {
		const { type, server, port } = proxy.simple;
		if (!server || port <= 0) return t("未配置");
		return `${type === "http" ? "HTTP" : "SOCKS5"} ${server}:${port}`;
	}
	if (proxy.mode === "wireguard") {
		const endpoint = /^\s*endpoint\s*=\s*(.+)$/im.exec(proxy.wireguard.config)?.[1]?.trim();
		return endpoint ? `WireGuard ${endpoint}` : t("未配置");
	}
	if (proxy.mode === "subscription") {
		if (proxy.nodes.length === 0) return proxy.subscription?.url ? t("订阅未拉取") : t("未配置订阅");
		const chosen = proxy.nodes.find((node) => node.tag === proxy.nodeTag) ?? proxy.nodes[0];
		const every = proxy.subscription?.intervalHours
			? t(" · 每 {hours} 小时更新", { hours: proxy.subscription.intervalHours })
			: "";
		return t("{count} 个节点 · {name}", { count: proxy.nodes.length, name: chosen?.name ?? "" }) + every;
	}
	return t("未配置");
}

/** `2026-10-24 09:30` in the operator's locale, or a word for "never". */
function when(value: number): string {
	if (!value) return t("从未");
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? t("从未") : date.toLocaleString("zh-CN", { hour12: false });
}

function profileOf(proxy: SentinelProxy): SentinelProxyInput {
	return {
		id: proxy.id,
		name: proxy.name,
		mode: proxy.mode,
		simple: proxy.simple,
		wireguard: proxy.wireguard,
		subscriptionUrl: proxy.subscription?.url ?? "",
		subscriptionUserAgent: proxy.subscription?.userAgent ?? "",
		subscriptionIntervalHours: proxy.subscription?.intervalHours ?? 0,
		nodeTag: proxy.nodeTag,
		routePrivateDirect: proxy.routePrivateDirect,
	};
}

/**
 * The editor for one profile. It is a dialog rather than an inline form because a
 * node is described by up to six fields plus a JSON box, and half of them are
 * credentials: a row in a table is the wrong shape for that.
 */
function ProxyEditor({
	initial,
	busy,
	error,
	onSave,
	onCancel,
}: {
	initial: SentinelProxyInput;
	busy: boolean;
	error: string | null;
	onSave: (input: SentinelProxyInput) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState<SentinelProxyInput>(initial);
	const patch = (next: Partial<SentinelProxyInput>) => setDraft((prev) => ({ ...prev, ...next }));
	const patchWireGuard = (changes: Partial<SentinelProxyInput["wireguard"]>) => {
		setDraft((prev) => (prev ? { ...prev, wireguard: { ...prev.wireguard, ...changes } } : prev));
	};

	const patchSimple = (next: Partial<SentinelProxyInput["simple"]>) =>
		setDraft((prev) => ({ ...prev, simple: { ...prev.simple, ...next } }));
	const named = draft.name.trim().length > 0;

	return (
		<ConfirmDialog
			title={initial.id ? t("编辑代理") : t("新建代理")}
			subtitle={draft.name.trim() || t("未命名")}
			onCancel={onCancel}
			footer={
				<button type="button" className="primary" disabled={busy || !named} onClick={() => onSave(draft)}>
					{busy ? t("保存中…") : t("保存")}
				</button>
			}
		>
			<div className="proxy-editor">
				<label className="proxy-field">
					<span>{t("名称")}</span>
					<input
						value={draft.name}
						placeholder={t("如 香港节点 / 本机 Clash")}
						spellCheck={false}
						/* biome-ignore lint/a11y/noAutofocus: the dialog exists to name and fill this node */
						autoFocus
						onChange={(event) => patch({ name: event.target.value })}
					/>
				</label>

				<div className="env-network-options">
					<label className={draft.mode === "simple" ? "selected" : undefined}>
						<input
							type="radio"
							name="proxy-kind"
							checked={draft.mode === "simple"}
							onChange={() => patch({ mode: "simple" })}
						/>
						<span className="env-network-label">{t("SOCKS5 / HTTP 代理")}</span>
						<span className="env-network-detail">
							{t("填一个地址端口，容器里所有出网流量都从它走。适合本机 Clash 或 VPS 上的 socks5/http 代理。")}
						</span>
					</label>
					<label className={draft.mode === "subscription" ? "selected" : undefined}>
						<input
							type="radio"
							name="proxy-kind"
							checked={draft.mode === "subscription"}
							onChange={() => patch({ mode: "subscription" })}
						/>
						<span className="env-network-label">{t("订阅链接")}</span>
						<span className="env-network-detail">
							{t("贴机场或自建面板的订阅地址，保存时拉取一次，解析出多个节点后在这里选一个。支持 base64 分享链接、Clash 与 sing-box 配置。")}
						</span>
					</label>
					<label className={draft.mode === "wireguard" ? "selected" : undefined}>
						<input
							type="radio"
							name="proxy-kind"
							checked={draft.mode === "wireguard"}
							onChange={() => patch({ mode: "wireguard" })}
						/>
						<span className="env-network-label">WireGuard</span>
						<span className="env-network-detail">
							{t("一条隧道而不是一个代理：容器里的一切（含 ping、UDP、原始套接字）都走它，但只有这一个出口，没有节点可切。")}
						</span>
					</label>
				</div>

				{draft.mode === "simple" ? (
					<div className="env-proxy-fields">
						<label>
							<span>{t("类型")}</span>
							<select
								value={draft.simple.type}
								onChange={(event) => patchSimple({ type: event.target.value === "http" ? "http" : "socks5" })}
							>
								<option value="socks5">SOCKS5</option>
								<option value="http">HTTP</option>
							</select>
						</label>
						<label>
							<span>{t("地址")}</span>
							<input
								type="text"
								value={draft.simple.server}
								placeholder="127.0.0.1"
								onChange={(event) => patchSimple({ server: event.target.value })}
							/>
						</label>
						<label>
							<span>{t("端口")}</span>
							<input
								type="number"
								value={draft.simple.port || ""}
								placeholder="7890"
								onChange={(event) => patchSimple({ port: Number.parseInt(event.target.value, 10) || 0 })}
							/>
						</label>
						<label>
							<span>{t("用户名")}</span>
							<input
								type="text"
								value={draft.simple.username}
								onChange={(event) => patchSimple({ username: event.target.value })}
							/>
						</label>
						<label>
							<span>{t("密码")}</span>
							<input
								type="password"
								value={draft.simple.password}
								onChange={(event) => patchSimple({ password: event.target.value })}
							/>
						</label>
						{draft.simple.type === "http" ? (
							<label className="env-proxy-check">
								<input
									type="checkbox"
									checked={draft.simple.tls}
									onChange={(event) => patchSimple({ tls: event.target.checked })}
								/>
								<span>{t("HTTPS 上游（tls）")}</span>
							</label>
						) : null}
					</div>
				) : draft.mode === "wireguard" ? (
					<div className="env-proxy-fields">
						<label className="env-proxy-wide">
							<span>{t("WireGuard 配置（直接粘贴 wg0.conf）")}</span>
							<textarea
								className="env-proxy-json"
								rows={12}
								value={draft.wireguard.config}
								placeholder={WIREGUARD_PLACEHOLDER}
								spellCheck={false}
								onChange={(event) => patchWireGuard({ config: event.target.value })}
							/>
						</label>
						<label className="env-proxy-wide">
							<span>{t("DNS（配置里没有 DNS = 时填这里）")}</span>
							<input
								value={draft.wireguard.dns}
								placeholder="10.66.0.1"
								spellCheck={false}
								onChange={(event) => patchWireGuard({ dns: event.target.value })}
							/>
						</label>
						<label className="env-proxy-check env-proxy-wide">
							<input
								type="checkbox"
								checked={draft.wireguard.killSwitch}
								onChange={(event) => patchWireGuard({ killSwitch: event.target.checked })}
							/>
							<span>{t("断线即断网（kill-switch）：隧道起来后删掉直连的默认路由，隧道掉了不会漏回宿主机网络")}</span>
						</label>
					</div>
				) : (
					<div className="env-proxy-fields">
						<label className="env-proxy-wide">
							<span>{t("订阅地址")}</span>
							<input
								type="text"
								value={draft.subscriptionUrl}
								placeholder="https://example.com/api/v1/client/subscribe?token=..."
								spellCheck={false}
								onChange={(event) => patch({ subscriptionUrl: event.target.value })}
							/>
						</label>
						<label className="env-proxy-wide">
							<span>{t("User-Agent")}</span>
							<input
								type="text"
								value={draft.subscriptionUserAgent}
								placeholder="sing-box/1.13.15"
								spellCheck={false}
								onChange={(event) => patch({ subscriptionUserAgent: event.target.value })}
							/>
						</label>
						<label className="env-proxy-wide">
							<span>{t("定时更新")}</span>
							<select
								value={String(draft.subscriptionIntervalHours)}
								onChange={(event) => patch({ subscriptionIntervalHours: Number(event.target.value) })}
							>
								{INTERVAL_OPTIONS.map((option) => (
									<option key={option.hours} value={String(option.hours)}>
										{option.label}
									</option>
								))}
							</select>
						</label>
					</div>
				)}

				{draft.mode === "wireguard" ? null : (
					<label className="env-proxy-check">
						<input
							type="checkbox"
							checked={draft.routePrivateDirect}
							onChange={(event) => patch({ routePrivateDirect: event.target.checked })}
						/>
						<span>{t("内网与回环地址直连，其余走代理")}</span>
					</label>
				)}

				<p className="settings-hint">
					{draft.mode === "subscription"
						? t("保存时拉取一次订阅（换地址才会重拉），拉完用 sing-box 校验选中的节点；之后用行内的「节点」换节点、「刷新」重拉。")
						: draft.mode === "wireguard"
							? t("WireGuard 档案的容器跑 wg-quick 而不是 sing-box：隧道是真实网卡加默认路由，所以 ping、UDP、原始套接字都走隧道；只有这一个出口，没有节点可切。要走哪些网段由配置里的 AllowedIPs 决定（写 0.0.0.0/0 就是全部），没有内网直连这个开关。DNS 必填——Docker 自己的解析在隧道外。")
							: t("保存时会用 sing-box 校验一次（镜像已在本地时），不通过的配置会带着报错退回，不会等到重建容器才发现。")}
				</p>
				{error ? <div className="page-error">{error}</div> : null}
			</div>
		</ConfirmDialog>
	);
}

/** What a provider hands out, so the box shows the shape it expects. */
const WIREGUARD_PLACEHOLDER = `[Interface]
PrivateKey = ...
Address = 10.66.0.2/32
DNS = 10.66.0.1

[Peer]
PublicKey = ...
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25`;

/** Refresh intervals the operator can pick. 0 is "only when I press refresh". */
const INTERVAL_OPTIONS: ReadonlyArray<{ hours: number; label: string }> = [
	{ hours: 0, label: t("不自动更新") },
	{ hours: 1, label: t("每 1 小时") },
	{ hours: 6, label: t("每 6 小时") },
	{ hours: 12, label: t("每 12 小时") },
	{ hours: 24, label: t("每 24 小时") },
	{ hours: 72, label: t("每 3 天") },
];



/**
 * The nodes of one subscription, and which of them the profile routes through.
 *
 * A provider hands out tens or hundreds of them, and the operator picks one; the
 * list is the whole interaction, so it scrolls rather than paginating. Nodes the
 * parser could not use are listed underneath with the reason, because "why is my
 * node missing" is the question this dialog would otherwise leave unanswered.
 */
export function ProxyNodeDialog({
	proxy,
	busy,
	refreshing,
	testing,
	testUrl,
	onPick,
	onRefresh,
	onTest,
	onClose,
}: {
	proxy: SentinelProxy;
	busy: boolean;
	refreshing: boolean;
	testing: boolean;
	testUrl: string;
	onPick: (nodeTag: string) => void;
	onRefresh: () => void;
	/** Measure every node against this URL. */
	onTest: (url: string) => void;
	onClose: () => void;
}) {
	const nodes = Array.isArray(proxy.nodes) ? proxy.nodes : [];
	const [url, setUrl] = useState(testUrl);
	/** Set by a test, so the fastest node is at the top; the provider's order is kept until then. */
	const [byLatency, setByLatency] = useState(false);
	const tested = nodes.some((node) => node.testedAt !== undefined);
	const ordered = byLatency
		? [...nodes].sort((left, right) => {
				// A node that timed out sorts last, after every measured one.
				const a = left.latencyMs ?? Number.MAX_SAFE_INTEGER;
				const b = right.latencyMs ?? Number.MAX_SAFE_INTEGER;
				return a - b;
			})
		: nodes;

	return (
		<ConfirmDialog
			title={t("节点")}
			subtitle={proxy.name}
			onCancel={onClose}
			footer={
				<>
					<button type="button" className="ghost" disabled={refreshing} onClick={onRefresh}>
						{refreshing ? t("拉取中…") : t("刷新订阅")}
					</button>
					<button
						type="button"
						className="primary"
						disabled={testing || nodes.length === 0}
						onClick={() => {
							setByLatency(true);
							onTest(url.trim());
						}}
					>
						{testing ? t("测速中…") : t("批量测速")}
					</button>
				</>
			}
		>
			<p className="settings-hint">
				{proxy.subscription?.updatedAt
					? t("上次拉取：{when}", { when: when(proxy.subscription.updatedAt) })
					: t("还没有成功拉取过")}
				{proxy.subscription?.error ? ` · ${proxy.subscription.error}` : ""}
			</p>
			<p className="settings-hint">
				{t("换节点或刷新后，用到这个代理的项目要重建容器才会走新的节点。")}
			</p>
			<label className="proxy-test-url">
				<span>{t("测速地址")}</span>
				<input
					value={url}
					spellCheck={false}
					placeholder="https://www.gstatic.com/generate_204"
					onChange={(event) => setUrl(event.target.value)}
				/>
			</label>
			<p className="settings-hint">
				{t("测速是从每个节点真实访问这个地址（返回 204 的地址最准），不是只连端口；结果会显示在节点右侧。")}
			</p>
			{nodes.length === 0 ? (
				<div className="ws-empty">
					<span>{t("这个订阅还没有节点")}</span>
					<span>{t("点「刷新订阅」拉取一次")}</span>
				</div>
			) : (
				<div className="proxy-node-list">
					<label className={proxy.nodeTag === AUTO_NODE_TAG ? "selected" : undefined}>
						<input
							type="radio"
							name="proxy-node"
							checked={proxy.nodeTag === AUTO_NODE_TAG}
							disabled={busy}
							onChange={() => onPick(AUTO_NODE_TAG)}
						/>
						<span className="proxy-node__name">{t("自动（按延迟择优）")}</span>
						<span className="proxy-node__meta">
							<span className="proxy-node__protocol">{t("sing-box 每 3 分钟测一次")}</span>
						</span>
					</label>
					{ordered.map((node) => (
						<label key={node.tag} className={node.tag === proxy.nodeTag ? "selected" : undefined}>
							<input
								type="radio"
								name="proxy-node"
								checked={node.tag === proxy.nodeTag}
								disabled={busy}
								onChange={() => onPick(node.tag)}
							/>
							<span className="proxy-node__name">{node.name}</span>
							<span className="proxy-node__meta">
								{node.latencyMs === undefined ? (
									<span className="proxy-node__protocol">{node.protocol}</span>
								) : node.latencyMs === null ? (
									<span className="proxy-latency bad">{t("超时")}</span>
								) : (
									<span className={`proxy-latency${node.latencyMs > 800 ? " slow" : ""}`}>
										{node.latencyMs} ms
									</span>
								)}
							</span>
						</label>
					))}
				</div>
			)}
			{tested && !byLatency ? (
				<button type="button" className="ghost small" onClick={() => setByLatency(true)}>
					{t("按延迟排序")}
				</button>
			) : null}
			{proxy.skipped.length > 0 ? (
				<>
					<p className="settings-hint">{t("以下节点没能解析，已跳过：")}</p>
					<ul className="proxy-skipped">
						{proxy.skipped.slice(0, 12).map((entry, index) => (
							<li key={`${entry.name}-${index}`}>
								<code>{entry.name || t("未命名")}</code> {entry.reason}
							</li>
						))}
					</ul>
				</>
			) : null}
		</ConfirmDialog>
	);
}

export function ProxyPage({
	config,
	projects,
	busy,
	onSave,
	onDelete,
	onRefreshSubscription,
	onSetNode,
	onTestNodes,
	refreshingId,
	testingId,
}: {
	config: SentinelProxyConfigView;
	/** Only used to count how many projects a profile reaches. */
	projects: SentinelProjectInfo[];
	busy: boolean;
	onSave: (input: SentinelProxyInput) => Promise<string | null>;
	onDelete: (id: string) => Promise<string | null>;
	onRefreshSubscription: (id: string) => Promise<string | null>;
	onSetNode: (id: string, nodeTag: string) => Promise<string | null>;
	onTestNodes: (id: string, url: string) => Promise<string | null>;
	/** The profile whose subscription is being re-read right now. */
	refreshingId: string | null;
	/** The profile whose nodes are being measured right now. */
	testingId: string | null;
}) {
	const [editing, setEditing] = useState<SentinelProxyInput | null>(null);
	const [deleting, setDeleting] = useState<SentinelProxy | null>(null);
	const [picking, setPicking] = useState<string | null>(null);
	const [testing, setTesting] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const list = Array.isArray(config?.proxies) ? config.proxies : [];
	const uses = useMemo(() => {
		const counts = new Map<string, number>();
		const fallback = list.find((entry) => entry.id === config?.defaultId)?.id;
		for (const project of Array.isArray(projects) ? projects : []) {
			// A project with no choice of its own counts against whichever profile is
			// the default, because deleting that one would move it.
			const id = project.proxyId === undefined ? fallback : (project.proxyId ?? undefined);
			if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
		}
		return counts;
	}, [list, projects, config?.defaultId]);

	const save = async (input: SentinelProxyInput) => {
		setError(null);
		const message = await onSave(input);
		if (message) {
			setError(message);
			return;
		}
		setEditing(null);
	};

	const refresh = async (proxy: SentinelProxy) => {
		setError(null);
		const message = await onRefreshSubscription(proxy.id);
		if (message) setError(message);
	};

	const testNodes = async (proxy: SentinelProxy, url: string) => {
		setError(null);
		setTesting(proxy.id);
		const message = await onTestNodes(proxy.id, url);
		setTesting(null);
		if (message) setError(message);
	};

	const pickNode = async (proxy: SentinelProxy, nodeTag: string) => {
		setError(null);
		const message = await onSetNode(proxy.id, nodeTag);
		if (message) setError(message);
		else setPicking(null);
	};

	const remove = async (proxy: SentinelProxy) => {
		setError(null);
		const message = await onDelete(proxy.id);
		if (message) {
			setError(message);
			return;
		}
		setDeleting(null);
	};

	return (
		<div className="page-card">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					{t("代理")}
					<span className="ws-panel__sub">{t("{count} 个", { count: list.length })}</span>
				</div>
				<div className="ws-panel__actions">
					<button
						type="button"
						className="primary"
						disabled={busy}
						onClick={() => {
							setError(null);
							setEditing({ ...EMPTY_PROXY_INPUT });
						}}
					>
						{t("新建代理")}
					</button>
				</div>
			</div>

			<div className="ws-panel__body">
				{error ? <div className="page-error">{error}</div> : null}

				{list.length === 0 ? (
					<div className="ws-empty">
						<span>{t("还没有代理")}</span>
						<span>{t("新建一个之后，项目才能把出网流量交给它")}</span>
					</div>
				) : (
					<div className="data-table proxy-table">
						<div className="data-row data-head">
							<span>{t("名称")}</span>
							<span>{t("出口")}</span>
							<span className="proxy-num">{t("项目")}</span>
							<span>{t("内网直连")}</span>
							<span className="data-actions-col">{t("操作")}</span>
						</div>
						{list.map((proxy) => (
							<div key={proxy.id} className="data-row">
								<span className="proxy-cell">
									<span className="proxy-cell__name">
										{proxy.name}
										{proxy.id === config?.defaultId ? <span className="tag tag-primary">{t("默认")}</span> : null}
									</span>
									<span className="proxy-cell__sub">{describe(proxy)}</span>
								</span>
								<span className="proxy-kind">
									{proxy.mode === "subscription"
										? t("订阅")
										: proxy.mode === "wireguard"
											? "WireGuard"
											: t("普通代理")}
								</span>
								<span className="data-mono proxy-num">{uses.get(proxy.id) ?? 0}</span>
								<span className="proxy-flag">
									{proxy.mode === "wireguard" ? "—" : proxy.routePrivateDirect ? t("是") : t("否")}
								</span>
								<span className="data-actions">
									{proxy.mode === "subscription" ? (
										<button
											type="button"
											disabled={busy}
											title={t("选一个节点，或刷新订阅")}
											onClick={() => {
												setError(null);
												setPicking(proxy.id);
											}}
										>
											{t("节点")}
										</button>
									) : null}
									<button
										type="button"
										onClick={() => {
											setError(null);
											setEditing(profileOf(proxy));
										}}
									>
										{t("编辑")}
									</button>
									<button
										type="button"
										className="danger"
										onClick={() => {
											setError(null);
											setDeleting(proxy);
										}}
									>
										{t("删除")}
									</button>
								</span>
							</div>
						))}
					</div>
				)}

				<p className="ws-panel__hint">
					{t("项目只记住代理的名字；在这里改一次，用到它的项目下次重建容器就会生效。")}
				</p>
			</div>

			{editing ? (
				<ProxyEditor
					initial={editing}
					busy={busy}
					error={error}
					onSave={(input) => void save(input)}
					onCancel={() => {
						setEditing(null);
						setError(null);
					}}
				/>
			) : null}

			{picking ? (
				(() => {
					const proxy = list.find((entry) => entry.id === picking);
					if (!proxy) return null;
					return (
						<ProxyNodeDialog
							proxy={proxy}
							busy={busy}
							refreshing={refreshingId === proxy.id}
							testing={testing === proxy.id}
							testUrl={config?.testUrl ?? ""}
							onPick={(nodeTag) => void pickNode(proxy, nodeTag)}
							onRefresh={() => void refresh(proxy)}
							onTest={(url) => void testNodes(proxy, url)}
							onClose={() => setPicking(null)}
						/>
					);
				})()
			) : null}

			{deleting ? (
				<ConfirmDialog
					title={t("删除代理")}
					subtitle={deleting.name}
					onCancel={() => setDeleting(null)}
					footer={
						<button type="button" className="danger" disabled={busy} onClick={() => void remove(deleting)}>
							{t("确认删除")}
						</button>
					}
				>
					<p className="confirm-note">
						{t("删除后，用到它的项目会回到「跟随默认」；已经在跑的容器不受影响，下次重建时才换网络。")}
						{uses.get(deleting.id)
							? ` ${t("当前有 {count} 个项目用它。", { count: uses.get(deleting.id) ?? 0 })}`
							: ""}
					</p>
				</ConfirmDialog>
			) : null}
		</div>
	);
}
