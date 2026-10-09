import { useEffect, useRef, useState } from "react";
import type { ZGProjectInfo } from "../types.ts";

export function ProjectPicker({
	projects,
	activeProject,
	streaming,
	onSwitch,
	onAdd,
	onRemove,
}: {
	projects: ZGProjectInfo[];
	activeProject: ZGProjectInfo | null;
	streaming: boolean;
	onSwitch: (id: string) => void;
	onAdd: (name: string) => Promise<string | null>;
	onRemove: (id: string, confirmName: string) => Promise<string | null>;
}) {
	const [open, setOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [formError, setFormError] = useState<string | null>(null);
	const [removing, setRemoving] = useState<ZGProjectInfo | null>(null);
	const [confirmName, setConfirmName] = useState("");
	const [busy, setBusy] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const close = (event: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
				setOpen(false);
				setCreating(false);
				setRemoving(null);
			}
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, []);

	const submitCreate = async () => {
		setBusy(true);
		setFormError(null);
		const error = await onAdd(name);
		setBusy(false);
		if (error) {
			setFormError(error);
			return;
		}
		setCreating(false);
		setName("");
	};

	const submitRemove = async () => {
		if (!removing) return;
		setBusy(true);
		setFormError(null);
		const error = await onRemove(removing.id, confirmName);
		setBusy(false);
		if (error) {
			setFormError(error);
			return;
		}
		setRemoving(null);
		setConfirmName("");
		setOpen(false);
	};

	return (
		<div className="project-picker" ref={rootRef}>
			<button
				type="button"
				className="project-current"
				onClick={() => setOpen((prev) => !prev)}
				disabled={streaming}
				title={streaming ? "Agent 运行中，暂不能切换项目" : (activeProject?.cwd ?? "未选择项目，请先新建项目")}
			>
				<span className="project-badge">P</span>
				<span className="project-name">{activeProject?.name ?? "未选择项目"}</span>
				<span className="caret open">{open ? "⌃" : "⌄"}</span>
			</button>

			{open ? (
				<div className="project-menu">
					{!creating && !removing ? (
						<>
							{projects.length === 0 ? <div className="project-empty">还没有项目，新建一个吧</div> : null}
							{projects.map((project) => (
								<div key={project.id} className="project-row">
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
										className="project-remove"
										title="删除项目（含其会话）"
										onClick={() => {
											setRemoving(project);
											setFormError(null);
										}}
									>
										×
									</button>
								</div>
							))}
							<button
								type="button"
								className="project-option"
								onClick={() => {
									setCreating(true);
									setFormError(null);
								}}
							>
								<span className="project-add">＋</span>
								<span className="project-name">新建项目</span>
							</button>
						</>
					) : null}

					{creating ? (
						<div className="project-form">
							<div className="project-form-title">新建容器项目</div>
						<div className="project-warn">将创建独立 Docker 容器与工作目录（~/.zgagent/projects/），工具全部在容器内执行。</div>
							<input
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="项目名称，如 靶场-01"
								spellCheck={false}
							/>
							{formError ? <div className="project-error">{formError}</div> : null}
							<div className="project-form-actions">
								<button type="button" className="primary" disabled={busy || !name.trim()} onClick={submitCreate}>
									{busy ? "创建中…" : "创建并进入"}
								</button>
								<button type="button" onClick={() => setCreating(false)}>
									取消
								</button>
							</div>
						</div>
					) : null}

					{removing ? (
						<div className="project-form">
							<div className="project-form-title">删除项目「{removing.name}」</div>
							<div className="project-warn">
								将删除项目「{removing.name}」的容器并移除注册（工作目录与会话保留），输入完整项目名确认：
							</div>
							<input
								value={confirmName}
								onChange={(event) => setConfirmName(event.target.value)}
								placeholder={removing.name}
								spellCheck={false}
							/>
							{formError ? <div className="project-error">{formError}</div> : null}
							<div className="project-form-actions">
								<button type="button" className="danger" disabled={busy || confirmName !== removing.name} onClick={submitRemove}>
									{busy ? "删除中…" : "确认删除"}
								</button>
								<button type="button" onClick={() => setRemoving(null)}>
									取消
								</button>
							</div>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
