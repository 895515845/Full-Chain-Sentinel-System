import { useState } from "react";
import type { SentinelProjectInfo } from "../types.ts";

/**
 * Blocking onboarding shown while no project is selected. The console runs every
 * tool inside a project container, so there is deliberately no default directory
 * to chat from.
 */
export function ProjectGate({
	projects,
	busy,
	onCreate,
	onSwitch,
	onOpenSettings,
}: {
	projects: SentinelProjectInfo[];
	busy: boolean;
	onCreate: (name: string) => Promise<string | null>;
	onSwitch: (id: string) => void;
	onOpenSettings: () => void;
}) {
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	const submit = async () => {
		setSubmitting(true);
		setError(null);
		const message = await onCreate(name);
		setSubmitting(false);
		if (message) {
			setError(message);
			return;
		}
		setName("");
	};

	return (
		<div className="project-gate">
			<div className="project-gate-card">
				<h2>先创建一个项目</h2>
				<p className="project-gate-lead">
					全链哨兵 的每条命令都在项目专属的 Docker
					容器里执行，文件写入该项目的工作目录。没有项目就没有可执行的环境，因此不提供默认目录。
				</p>
				<div className="project-gate-form">
					<input
						autoFocus
						value={name}
						placeholder="项目名称，如 靶场-01"
						spellCheck={false}
						disabled={submitting || busy}
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && name.trim()) void submit();
						}}
					/>
					<button
						type="button"
						className="primary"
						disabled={submitting || busy || !name.trim()}
						onClick={() => void submit()}
					>
						{submitting || busy ? "创建中…" : "创建并进入"}
					</button>
				</div>
				{error ? <div className="project-gate-error">{error}</div> : null}
				<div className="project-gate-note">
					需要先构建工具镜像（<code>docker build -t sentinel:latest docker/</code>），否则创建会失败。
				</div>

				{projects.length > 0 ? (
					<div className="project-gate-list">
						<div className="project-gate-list-title">或进入已有项目</div>
						{projects.map((project) => (
							<button
								key={project.id}
								type="button"
								className="project-gate-item"
								title={project.cwd}
								disabled={busy}
								onClick={() => onSwitch(project.id)}
							>
								<span className="project-badge sm">P</span>
								<span className="project-name">{project.name}</span>
								<span className="file-meta">{project.cwd}</span>
							</button>
						))}
					</div>
				) : null}

				<button type="button" className="ghost small" onClick={onOpenSettings}>
					先去配置模型端点
				</button>
			</div>
		</div>
	);
}
