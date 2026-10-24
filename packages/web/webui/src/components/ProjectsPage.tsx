/**
 * The projects page.
 *
 * A project owns a work directory and the container that runs its tools, so
 * this is the console's root resource: creating, switching, stopping and
 * deleting them happens here, and every other page acts on the active one.
 *
 * Container and data are separate decisions: a container can be stopped or
 * thrown away while the project, its files and its records stay, and only the
 * data deletion takes those with it.
 */

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n.ts";
import type { SentinelProjectInfo, SentinelProxyConfigView } from "../types.ts";
import { ProjectRowDialogs, type ProjectRowAction, projectRowActionLabel } from "./ProjectRowDialogs.tsx";

function formatWhen(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function stateLabel(project: SentinelProjectInfo): string {
	if (project.state === "running") return t("运行中");
	if (project.state === "stopped") return project.manualStop ? t("已停止（手动）") : t("已停止");
	return t("无容器");
}

function stateDot(project: SentinelProjectInfo): string {
	if (project.state === "running") return "project-state--run";
	if (project.state === "stopped") return project.manualStop ? "project-state--stopped" : "project-state--exited";
	return "project-state--none";
}

/**
 * A container name shortened for the table: the full name repeats a prefix that
 * every project shares, so only the distinguishing head and tail are shown and
 * the full name goes in the tooltip.
 */
function shortContainer(name: string): string {
	return name.length > 18 ? `${name.slice(0, 13)}…${name.slice(-3)}` : name;
}

/** One row's overflow menu: the actions that do not deserve a button in the row. */
function RowMenu({
	items,
}: {
	items: { label: string; danger?: boolean; separatorBefore?: boolean; onSelect: () => void }[];
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLSpanElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<span className="cell-menu" ref={ref}>
			<button type="button" className="ghost" title={t("更多操作")} onClick={() => setOpen((prev) => !prev)}>
				⋯
			</button>
			{open ? (
				<span className="cell-menu__list">
					{items.map((item) => (
						<span key={item.label}>
							{item.separatorBefore ? <span className="cell-menu__sep" /> : null}
							<button
								type="button"
								className={item.danger ? "cell-menu__danger" : undefined}
								onClick={() => {
									setOpen(false);
									item.onSelect();
								}}
							>
								{item.label}
							</button>
						</span>
					))}
				</span>
			) : null}
		</span>
	);
}

function stateHint(project: SentinelProjectInfo): string {
	if (project.state === "running") return t("容器正在运行：停止后需要用「启动容器」重新启动");
	if (project.state === "stopped") {
		return project.manualStop
			? t("容器已被手动停止：进入该项目前需要点「启动容器」")
			: t("容器已停止：点「启动容器」即可重新启动，容器里的安装内容都还在");
	}
	return t("容器不存在：点「启动容器」会按当前设置重新创建");
}

export function ProjectsPage({
	projects,
	activeProject,
	busy,
	proxyConfig,
	onCreate,
	onSwitch,
	onRecreate,
	onRemove,
	onStop,
	onStart,
	onSaveProxy,
}: {
	projects: SentinelProjectInfo[];
	activeProject: SentinelProjectInfo | null;
	busy: boolean;
	/** Proxy profiles and the default, for the row dialog. */
	proxyConfig: SentinelProxyConfigView;
	onCreate: (name: string) => Promise<string | null>;
	onSwitch: (id: string) => void;
	onRecreate: (id: string) => Promise<string | null>;
	onRemove: (id: string, confirmName: string, scope: "container" | "data") => Promise<string | null>;
	onStop: (id: string) => Promise<string | null>;
	onStart: (id: string) => Promise<string | null>;
	onSaveProxy: (id: string, proxyId: string | null | undefined, proxyNode?: string) => Promise<string | null>;
}) {
	/** Same reason as the sidebar picker: an older server's payload must not blank the page. */
	const list = Array.isArray(projects) ? projects : [];
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	/**
	 * Which row action is waiting for confirmation. One value, not four: the menu
	 * can only ever have one dialog open, and four parallel states is how the
	 * dialogs went missing while the menu still set them.
	 */
	const [pending, setPending] = useState<{ action: ProjectRowAction; id: string } | null>(null);
	const pendingProject = pending ? (list.find((project) => project.id === pending.id) ?? null) : null;
	const openDialog = (action: ProjectRowAction, id: string) => setPending({ action, id });
	/**
	 * Whether a row action is in flight. Deliberately not the streaming flag: a
	 * conversation being open is a reason the server refuses a stop, and it says so
	 * — a button that is disabled for an unstated reason reads as broken.
	 */
	const [actionBusy, setActionBusy] = useState(false);

	/**
	 * Run one row action and close its dialog.
	 *
	 * A refusal closes the dialog and puts the reason in the page banner: the
	 * banner is behind the modal, so leaving the dialog open would hide the one
	 * thing the operator needs to see.
	 */
	const runAction = async (run: () => Promise<string | null>): Promise<void> => {
		setActionBusy(true);
		setError(null);
		const message = await run();
		setActionBusy(false);
		setPending(null);
		if (message) setError(message);
	};

	const create = async () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		setError(null);
		const message = await onCreate(trimmed);
		if (message) setError(message);
		else setName("");
	};

	const remove = (project: SentinelProjectInfo, scope: "container" | "data") =>
		runAction(() => onRemove(project.id, project.name, scope));

	const recreate = (project: SentinelProjectInfo) => runAction(() => onRecreate(project.id));

	const stop = (project: SentinelProjectInfo) => runAction(() => onStop(project.id));

	const start = async (project: SentinelProjectInfo) => {
		setError(null);
		const message = await onStart(project.id);
		if (message) setError(message);
	};

	const saveProxy = (project: SentinelProjectInfo, proxyId: string | null | undefined, proxyNode?: string) =>
		runAction(() => onSaveProxy(project.id, proxyId, proxyNode));

	return (
		<div className="page-card">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					{t("项目")}
					<span className="ws-panel__sub">
						{t("{count} 个 · {running} 个运行中", {
							count: list.length,
							running: list.filter((project) => project.state === "running").length,
						})}
					</span>
				</div>
				<div className="ws-panel__actions">
					<input
						className="inline-input"
						value={name}
						placeholder={t("新项目名称")}
						spellCheck={false}
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void create();
						}}
					/>
					<button type="button" className="primary" onClick={() => void create()} disabled={busy || !name.trim()}>
						{t("新建项目")}
					</button>
				</div>
			</div>
			{error ? <div className="page-error">{error}</div> : null}
			<div className="ws-panel__body">
				{list.length === 0 ? (
					<div className="ws-empty">
						<span>{t("还没有项目")}</span>
						<span>{t("新建一个项目后，容器与工作目录才会就绪")}</span>
					</div>
				) : (
					<div className="data-table project-table">
						<div className="data-row data-head">
							<span>{t("项目")}</span>
							<span className="project-num">{t("会话")}</span>
							<span className="project-num">{t("漏洞")}</span>
							<span className="data-actions-col">{t("操作")}</span>
						</div>
						{list.map((project) => {
							const active = project.id === activeProject?.id;
							const running = project.state === "running";
							return (
								<div key={project.id} className={`data-row${active ? " active" : ""}`}>
									<span className="project-cell">
										<span className="project-cell__name">
											{project.name}
											{active ? <span className="tag tag-primary">{t("当前")}</span> : null}
											{project.proxyName ? (
												<span
													className="tag"
													title={
														// The profile and the node are two facts; a pinned node is the one
														// that decides where the traffic actually leaves.
														project.proxyNodeName
															? t("容器挂在自己的 sing-box 上，出网走代理「{name}」的节点「{node}」", {
																	name: project.proxyName,
																	node: project.proxyNodeName,
																})
															: t("容器挂在自己的 sing-box 上，出网走代理「{name}」", { name: project.proxyName })
													}
												>
													{project.proxyNodeName ?? project.proxyName}
												</span>
											) : null}
										</span>
										<span className="project-cell__sub" title={project.container ?? undefined}>
											<span className={`project-state ${stateDot(project)}`} title={stateHint(project)}>
												<span className="project-state__dot" />
												{stateLabel(project)}
											</span>
											{project.container ? <code>{shortContainer(project.container)}</code> : null}
										</span>
									</span>
									<span className="data-mono project-num">{project.sessionCount ?? 0}</span>
									<span className="data-mono project-num">{project.vulnCount ?? 0}</span>
									<span className="data-actions">
										{active ? (
											<span className="project-current-note">{t("当前项目")}</span>
										) : running ? (
											<button type="button" onClick={() => onSwitch(project.id)} title={t("切换到该项目")}>
												{t("进入")}
											</button>
										) : (
											<button
												type="button"
												className="primary"
												disabled={busy}
												onClick={() => void start(project)}
												title={stateHint(project)}
											>
												{t("启动容器")}
											</button>
										)}
										<RowMenu
											items={[
												...(running
													? [
															{
																label: projectRowActionLabel("stop"),
																onSelect: () => openDialog("stop", project.id),
															},
														]
													: []),
												{
													label: projectRowActionLabel("proxy"),
													onSelect: () => openDialog("proxy", project.id),
												},
												{
													label: projectRowActionLabel("recreate"),
													onSelect: () => openDialog("recreate", project.id),
												},
												{
													label: projectRowActionLabel("delete"),
													danger: true,
													separatorBefore: true,
													onSelect: () => openDialog("delete", project.id),
												},
											]}
										/>
									</span>
								</div>
							);
						})}
					</div>
				)}
				<p className="ws-panel__hint">
					{t("项目工作目录挂载到容器的")} <code>/work</code>
					{t("，bash 与「文件」页看到的都是它。")}
				</p>
				<p className="ws-panel__hint">
					{t("容器的网络模式、代理等创建期设置改完（设置 → 环境 / 「代理设置…」）后，用「重建容器」让已有项目生效；删除项目不可恢复。")}
				</p>
			</div>

			<ProjectRowDialogs
				action={pending?.action ?? null}
				project={pendingProject}
				config={proxyConfig}
				busy={actionBusy}
				onStop={(project) => void stop(project)}
				onRecreate={(project) => void recreate(project)}
				onRemove={(project, scope) => void remove(project, scope)}
				onSaveProxy={(project, proxyId, proxyNode) => void saveProxy(project, proxyId, proxyNode)}
				onCancel={() => setPending(null)}
			/>
		</div>
	);
}
