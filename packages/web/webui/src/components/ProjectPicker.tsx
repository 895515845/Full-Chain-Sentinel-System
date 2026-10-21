import { useEffect, useRef, useState } from "react";
import { t } from "../i18n.ts";
import type { SentinelProjectInfo } from "../types.ts";
import { CaretDownIcon, CaretUpIcon, CloseIcon } from "./icons.tsx";

export function ProjectPicker({
	projects,
	activeProject,
	streaming,
	onSwitch,
	onAdd,
	onRemove,
}: {
	projects: SentinelProjectInfo[];
	activeProject: SentinelProjectInfo | null;
	streaming: boolean;
	onSwitch: (id: string) => void;
	onAdd: (name: string) => Promise<string | null>;
	onRemove: (id: string, confirmName: string) => Promise<string | null>;
}) {
	const [open, setOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [formError, setFormError] = useState<string | null>(null);
	const [removing, setRemoving] = useState<SentinelProjectInfo | null>(null);
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
				title={
					streaming
						? t("Agent 运行中，暂不能切换项目")
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
							{projects.length === 0 ? <div className="project-empty">{t("还没有项目，新建一个吧")}</div> : null}
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
										title={t("删除项目（含其会话）")}
										onClick={() => {
											setRemoving(project);
											setFormError(null);
										}}
									>
										<CloseIcon size={12} />
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
						<div className="project-form">
							<div className="project-form-title">{t("删除项目「{name}」", { name: removing.name })}</div>
							<div className="project-warn">
								{t("将删除项目「{name}」的容器并移除注册（工作目录与会话保留），输入完整项目名确认：", {
									name: removing.name,
								})}
							</div>
							<input
								value={confirmName}
								onChange={(event) => setConfirmName(event.target.value)}
								placeholder={removing.name}
								spellCheck={false}
							/>
							{formError ? <div className="project-error">{formError}</div> : null}
							<div className="project-form-actions">
								<button
									type="button"
									className="danger"
									disabled={busy || confirmName !== removing.name}
									onClick={submitRemove}
								>
									{busy ? t("删除中…") : t("确认删除")}
								</button>
								<button type="button" onClick={() => setRemoving(null)}>
									{t("取消")}
								</button>
							</div>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
