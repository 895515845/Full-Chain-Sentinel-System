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
import type { SentinelProjectInfo } from "../types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog.tsx";

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
	onCreate,
	onSwitch,
	onRecreate,
	onRemove,
	onStop,
	onStart,
}: {
	projects: SentinelProjectInfo[];
	activeProject: SentinelProjectInfo | null;
	busy: boolean;
	onCreate: (name: string) => Promise<string | null>;
	onSwitch: (id: string) => void;
	onRecreate: (id: string) => Promise<string | null>;
	onRemove: (id: string, confirmName: string, scope: "container" | "data") => Promise<string | null>;
	onStop: (id: string) => Promise<string | null>;
	onStart: (id: string) => Promise<string | null>;
}) {
	/** Same reason as the sidebar picker: an older server's payload must not blank the page. */
	const list = Array.isArray(projects) ? projects : [];
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<string | null>(null);
	const [pendingRecreate, setPendingRecreate] = useState<string | null>(null);
	const [pendingStop, setPendingStop] = useState<string | null>(null);
	const pendingStopProject = list.find((project) => project.id === pendingStop) ?? null;
	const pendingRecreateProject = list.find((project) => project.id === pendingRecreate) ?? null;
	const pendingDeleteProject = list.find((project) => project.id === pendingDelete) ?? null;

	const create = async () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		setError(null);
		const message = await onCreate(trimmed);
		if (message) setError(message);
		else setName("");
	};

	const remove = async (project: SentinelProjectInfo, scope: "container" | "data") => {
		setError(null);
		const message = await onRemove(project.id, project.name, scope);
		if (message) setError(message);
		else setPendingDelete(null);
	};

	const recreate = async (project: SentinelProjectInfo) => {
		setError(null);
		const message = await onRecreate(project.id);
		if (message) setError(message);
		else setPendingRecreate(null);
	};

	const stop = async (project: SentinelProjectInfo) => {
		setError(null);
		const message = await onStop(project.id);
		if (message) setError(message);
		else setPendingStop(null);
	};

	const start = async (project: SentinelProjectInfo) => {
		setError(null);
		const message = await onStart(project.id);
		if (message) setError(message);
	};

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
																label: t("停止容器"),
																onSelect: () => {
																	setPendingStop(project.id);
																	setPendingRecreate(null);
																	setPendingDelete(null);
																},
															},
														]
													: []),
												{
													label: t("重建容器"),
													onSelect: () => {
														setPendingRecreate(project.id);
														setPendingStop(null);
														setPendingDelete(null);
													},
												},
												{
													label: t("删除项目…"),
													danger: true,
													separatorBefore: true,
													onSelect: () => {
														setPendingDelete(project.id);
														setPendingStop(null);
														setPendingRecreate(null);
													},
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
					{t("容器的网络模式等创建期设置改完（设置 → 环境）后，用「重建容器」让已有项目生效；删除项目不可恢复。")}
				</p>
			</div>
		</div>
	);
}
