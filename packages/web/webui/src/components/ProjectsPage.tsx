/**
 * The projects page.
 *
 * A project owns a work directory and the container that runs its tools, so
 * this is the console's root resource: creating, switching and deleting them
 * happens here, and every other page acts on the active one.
 */

import { useState } from "react";
import type { ZGProjectInfo } from "../types.ts";
import { DeleteIcon } from "./icons.tsx";

function formatWhen(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

export function ProjectsPage({
	projects,
	activeProject,
	busy,
	onCreate,
	onSwitch,
	onRemove,
	sessionCount,
}: {
	projects: ZGProjectInfo[];
	activeProject: ZGProjectInfo | null;
	busy: boolean;
	onCreate: (name: string) => Promise<string | null>;
	onSwitch: (id: string) => void;
	onRemove: (id: string, confirmName: string) => Promise<string | null>;
	/** Sessions per project id, when the console knows them. */
	sessionCount: Record<string, number>;
}) {
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<string | null>(null);
	const [confirmName, setConfirmName] = useState("");

	const create = async () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		setError(null);
		const message = await onCreate(trimmed);
		if (message) setError(message);
		else setName("");
	};

	const remove = async (project: ZGProjectInfo) => {
		setError(null);
		const message = await onRemove(project.id, confirmName);
		if (message) setError(message);
		else {
			setPendingDelete(null);
			setConfirmName("");
		}
	};

	return (
		<div className="page-card">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					项目
					<span className="ws-panel__sub">
						{projects.length} 个 · 每个项目一个独立工作目录与容器
					</span>
				</div>
				<div className="ws-panel__actions">
					<input
						className="inline-input"
						value={name}
						placeholder="新项目名称"
						spellCheck={false}
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void create();
						}}
					/>
					<button type="button" className="primary" onClick={() => void create()} disabled={busy || !name.trim()}>
						新建项目
					</button>
				</div>
			</div>
			{error ? <div className="page-error">{error}</div> : null}
			<div className="ws-panel__body">
				{projects.length === 0 ? (
					<div className="ws-empty">
						<span>还没有项目</span>
						<span>新建一个项目后，容器与工作目录才会就绪</span>
					</div>
				) : (
					<div className="data-table">
						<div className="data-row data-head">
							<span>名称</span>
							<span>容器</span>
							<span>会话</span>
							<span className="data-actions-col">操作</span>
						</div>
						{projects.map((project) => {
							const active = project.id === activeProject?.id;
							return (
								<div key={project.id} className={`data-row ${active ? "active" : ""}`}>
									<span className="data-name">
										{project.name}
										{active ? <span className="tag tag-primary">当前</span> : null}
									</span>
									<span className="data-mono">{project.container ?? "—"}</span>
									<span>{sessionCount[project.id] ?? "—"}</span>
									<span className="data-actions">
										<button
											type="button"
											disabled={active || busy}
											onClick={() => onSwitch(project.id)}
											title={active ? "已是当前项目" : "切换到该项目"}
										>
											切换
										</button>
										<button
											type="button"
											className="danger"
											disabled={busy}
											onClick={() => {
												setPendingDelete(project.id);
												setConfirmName("");
											}}
										>
											<DeleteIcon />
											删除
										</button>
									</span>
									{pendingDelete === project.id ? (
										<div className="data-confirm">
											<span>删除项目会连带清理它的会话与容器，输入项目名确认：</span>
											<input
												value={confirmName}
												placeholder={project.name}
												spellCheck={false}
												onChange={(event) => setConfirmName(event.target.value)}
												onKeyDown={(event) => {
													if (event.key === "Enter") void remove(project);
													if (event.key === "Escape") setPendingDelete(null);
												}}
											/>
											<button
												type="button"
												className="danger"
												disabled={confirmName !== project.name}
												onClick={() => void remove(project)}
											>
												确认删除
											</button>
											<button type="button" onClick={() => setPendingDelete(null)}>
												取消
											</button>
										</div>
									) : null}
								</div>
							);
						})}
					</div>
				)}
				<p className="ws-panel__hint">
					项目工作目录挂载到容器的 <code>/work</code>，bash 与「文件」页看到的都是它。
					删除项目不可恢复。
				</p>
			</div>
		</div>
	);
}
