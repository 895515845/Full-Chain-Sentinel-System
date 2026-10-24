import { useEffect, useRef, useState } from "react";
import { t } from "../i18n.ts";
import { AUTO_NODE_TAG, type SentinelProjectInfo, type SentinelProxyConfigView } from "../types.ts";
import { CaretDownIcon, CaretUpIcon, CloseIcon } from "./icons.tsx";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog.tsx";

/**
 * A project's proxy as one short word, for the sidebar row.
 *
 * A pinned node is the more specific fact — the profile is implied by it — so it
 * wins over the profile name, which is what the tooltip adds.
 */
function proxyLabel(project: SentinelProjectInfo, config: SentinelProxyConfigView): string {
	if (project.proxyNodeName) return project.proxyNodeName;
	if (project.proxyName) return project.proxyName;
	if (project.proxyId === null) return t("直连");
	const defaultName = config.proxies.find((entry) => entry.id === config.defaultId)?.name;
	return defaultName ? t("默认") : t("直连");
}

export function ProjectPicker({
	projects,
	activeProject,
	streaming,
	proxyConfig,
	onSwitch,
	onAdd,
	onRemove,
	onSetProxy,
}: {
	projects: SentinelProjectInfo[];
	activeProject: SentinelProjectInfo | null;
	streaming: boolean;
	proxyConfig: SentinelProxyConfigView;
	onSwitch: (id: string) => void;
	onAdd: (name: string, proxyId?: string | null, proxyNode?: string) => Promise<string | null>;
	onRemove: (id: string, confirmName: string, scope: "container" | "data") => Promise<string | null>;
	onSetProxy: (id: string, proxyId: string | null | undefined, proxyNode?: string) => Promise<string | null>;
}) {
	const [open, setOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [newProxy, setNewProxy] = useState<string>("");
	const [newNode, setNewNode] = useState<string>("");
	const [formError, setFormError] = useState<string | null>(null);
	const [removing, setRemoving] = useState<SentinelProjectInfo | null>(null);
	/** The row whose proxy list is open, so only one is expanded at a time. */
	const [proxyFor, setProxyFor] = useState<string | null>(null);
	/** The subscription profile whose node list is open inside that row. */
	const [nodeFor, setNodeFor] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
	// A console that has been upgraded while an older server keeps pushing an
	// older payload must degrade, not blank the sidebar.
	const list = Array.isArray(projects) ? projects : [];
	const proxies = Array.isArray(proxyConfig?.proxies) ? proxyConfig.proxies : [];
	// The nodes of the profile picked in the creation form, if it has any.
	const newProxyProfile = proxies.find((entry) => entry.id === newProxy);
	const newProxyNodes =
		newProxyProfile?.mode === "subscription" && Array.isArray(newProxyProfile.nodes) ? newProxyProfile.nodes : [];

	useEffect(() => {
		const close = (event: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
				setOpen(false);
				setCreating(false);
				setRemoving(null);
				setProxyFor(null);
			}
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, []);

	const submitCreate = async () => {
		setBusy(true);
		setFormError(null);
		// An empty selection is "follow the default", which is what an absent id means.
		const error = await onAdd(
			name,
			newProxy === "" ? undefined : newProxy === "off" ? null : newProxy,
			newNode || undefined,
		);
		setBusy(false);
		if (error) {
			setFormError(error);
			return;
		}
		setCreating(false);
		setName("");
		setNewProxy("");
		setNewNode("");
	};

	const submitRemove = async (scope: "container" | "data") => {
		if (!removing) return;
		setBusy(true);
		setFormError(null);
		const error = await onRemove(removing.id, removing.name, scope);
		setBusy(false);
		if (error) {
			setFormError(error);
			return;
		}
		setRemoving(null);
		setOpen(false);
	};

	const pickProxy = async (
		project: SentinelProjectInfo,
		proxyId: string | null | undefined,
		proxyNode?: string,
	) => {
		setBusy(true);
		setFormError(null);
		const error = await onSetProxy(project.id, proxyId, proxyNode);
		setBusy(false);
		if (error) {
			setFormError(error);
			return;
		}
		setProxyFor(null);
		setNodeFor(null);
	};

	return (
		<div className="project-picker" ref={rootRef}>
			<button
				type="button"
				className="project-current"
				onClick={() => setOpen((prev) => !prev)}
				title={
					streaming
						? t("Agent 运行中：切换后它会在后台继续运行")
						: (activeProject?.cwd ?? t("未选择项目，请先新建项目"))
				}
			>
				<span className="project-badge">P</span>
				<span className="project-name">{activeProject?.name ?? t("未选择项目")}</span>
				<span className="caret open">{open ? <CaretUpIcon /> : <CaretDownIcon />}</span>
			</button>

			{open ? (
				<div className="project-menu">
					{!creating && !removing ? (
						<>
							{list.length === 0 ? <div className="project-empty">{t("还没有项目，新建一个吧")}</div> : null}
							{list.map((project) => (
								<div key={project.id} className="project-row-group">
									<div className="project-row">
										<button
											type="button"
											className={`project-option ${activeProject?.id === project.id ? "active" : ""}`}
											onClick={() => {
												onSwitch(project.id);
												setOpen(false);
											}}
											title={project.cwd}
										>
											<span className="project-badge sm">P</span>
											<span className="project-name">{project.name}</span>
										</button>
										<button
											type="button"
											className={`project-proxy ${proxyFor === project.id ? "open" : ""}`}
											title={t("设置这个项目的代理")}
											onClick={() => {
												setProxyFor((prev) => (prev === project.id ? null : project.id));
												setFormError(null);
											}}
										>
											{proxyLabel(project, proxyConfig)}
										</button>
										<button
											type="button"
											className="project-remove"
											title={t("删除项目（含其会话）")}
											onClick={() => {
												setRemoving(project);
												setProxyFor(null);
												setFormError(null);
											}}
										>
											<CloseIcon size={12} />
										</button>
									</div>
									{proxyFor === project.id ? (
										<div className="project-proxy-list">
											<button
												type="button"
												className={project.proxyId === undefined ? "on" : undefined}
												disabled={busy}
												onClick={() => void pickProxy(project, undefined)}
											>
												{t("跟随默认")}
												<span className="project-proxy-note">
													{proxies.find((entry) => entry.id === proxyConfig.defaultId)?.name ?? t("不使用")}
												</span>
											</button>
											<button
												type="button"
												className={project.proxyId === null ? "on" : undefined}
												disabled={busy}
												onClick={() => void pickProxy(project, null)}
											>
												{t("不使用代理")}
												<span className="project-proxy-note">{t("直连")}</span>
											</button>
											{proxies.map((proxy) => {
												const nodes = proxy.mode === "subscription" && Array.isArray(proxy.nodes) ? proxy.nodes : [];
												const expanded = nodeFor === proxy.id;
												return (
													<div key={proxy.id} className="project-proxy-group">
														<button
															type="button"
															className={project.proxyId === proxy.id ? "on" : undefined}
															disabled={busy}
															onClick={() => {
																// A subscription has more than one exit, so the row opens the
																// node list instead of committing to the profile's own node.
																if (nodes.length > 0) {
																	setNodeFor((prev) => (prev === proxy.id ? null : proxy.id));
																	return;
																}
																void pickProxy(project, proxy.id);
															}}
														>
															{proxy.name}
															{nodes.length > 0 ? (
																<span className="project-proxy-note">
																	{expanded ? "▾" : "▸"} {nodes.length}
																</span>
															) : null}
														</button>
														{expanded ? (
															<div className="project-proxy-nodes">
																<button
																	type="button"
																	className={
																		project.proxyId === proxy.id && !project.proxyNode ? "on" : undefined
																	}
																	disabled={busy}
																	onClick={() => void pickProxy(project, proxy.id)}
																>
																	{t("跟随档案默认")}
																	<span className="project-proxy-note">
																		{proxy.nodeTag === AUTO_NODE_TAG
																			? t("自动择优")
																			: (nodes.find((node) => node.tag === proxy.nodeTag)?.name ??
																				nodes[0]?.name)}
																	</span>
																</button>
																<button
																	type="button"
																	className={
																		project.proxyId === proxy.id && project.proxyNode === AUTO_NODE_TAG
																			? "on"
																			: undefined
																	}
																	disabled={busy}
																	onClick={() => void pickProxy(project, proxy.id, AUTO_NODE_TAG)}
																>
																	{t("自动（按延迟择优）")}
																	<span className="project-proxy-note">{t("立即生效")}</span>
																</button>
																{nodes.map((node) => (
																	<button
																		key={node.tag}
																		type="button"
																		className={
																			project.proxyId === proxy.id && project.proxyNode === node.tag
																				? "on"
																				: undefined
																		}
																		disabled={busy}
																		onClick={() => void pickProxy(project, proxy.id, node.tag)}
																	>
																		{node.name}
																		<span className="project-proxy-note">{node.protocol}</span>
																	</button>
																))}
															</div>
														) : null}
													</div>
												);
											})}
											<span className="project-proxy-hint">
												{t("只换节点会立刻生效；换档案才需要重建容器")}
											</span>
										</div>
									) : null}
								</div>
							))}
							<button
								type="button"
								className="project-option"
								onClick={() => {
									setCreating(true);
									setProxyFor(null);
									setFormError(null);
								}}
							>
								<span className="project-add">＋</span>
								<span className="project-name">{t("新建项目")}</span>
							</button>
						</>
					) : null}

					{creating ? (
						<div className="project-form">
							<div className="project-form-title">{t("新建容器项目")}</div>
							<div className="project-warn">
								{t("将创建独立 Docker 容器与工作目录（~/.sentinel/projects/），工具全部在容器内执行。")}
							</div>
							<input
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder={t("项目名称，如 靶场-01")}
								spellCheck={false}
							/>
							<label className="project-field">
								<span>{t("代理")}</span>
								<select
									value={newProxy}
									onChange={(event) => {
										setNewProxy(event.target.value);
										setNewNode("");
									}}
								>
									<option value="">
										{t("跟随默认（{name}）", {
											name: proxies.find((entry) => entry.id === proxyConfig.defaultId)?.name ?? t("不使用"),
										})}
									</option>
									<option value="off">{t("不使用代理")}</option>
									{proxies.map((proxy) => (
										<option key={proxy.id} value={proxy.id}>
											{proxy.name}
										</option>
									))}
								</select>
							</label>
							{newProxyNodes.length > 0 ? (
								<label className="project-field">
									<span>{t("节点")}</span>
									<select value={newNode} onChange={(event) => setNewNode(event.target.value)}>
										<option value="">
											{t("跟随档案默认（{name}）", {
												name:
													newProxyProfile?.nodeTag === AUTO_NODE_TAG
														? t("自动择优")
														: (newProxyNodes.find((node) => node.tag === newProxyProfile?.nodeTag)?.name ??
															newProxyNodes[0]?.name ??
															t("第一个节点")),
											})}
										</option>
										<option value={AUTO_NODE_TAG}>{t("自动（按延迟择优）")}</option>
										{newProxyNodes.map((node) => (
											<option key={node.tag} value={node.tag}>
												{node.name}
											</option>
										))}
									</select>
								</label>
							) : null}
							{formError ? <div className="project-error">{formError}</div> : null}
							<div className="project-form-actions">
								<button
									type="button"
									className="primary"
									disabled={busy || !name.trim()}
									onClick={submitCreate}
								>
									{busy ? t("创建中…") : t("创建并进入")}
								</button>
								<button type="button" onClick={() => setCreating(false)}>
									{t("取消")}
								</button>
							</div>
						</div>
					) : null}

					{removing ? (
						<ProjectDeleteDialog
							project={removing}
							busy={busy}
							onConfirm={(scope) => void submitRemove(scope)}
							onCancel={() => {
								setRemoving(null);
								setFormError(null);
							}}
						/>
					) : null}
				</div>
			) : null}
		</div>
	);
}
