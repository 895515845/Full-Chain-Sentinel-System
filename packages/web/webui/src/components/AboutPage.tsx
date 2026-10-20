/**
 * The about page.
 *
 * Read-only summary of what this console is and what it is currently talking
 * to. Values come from the live snapshot, so it doubles as a diagnostics view
 * when something looks wrong.
 */

import {
	CONSOLE_VERSION,
	PROJECT_LICENSE,
	PROJECT_LICENSE_URL,
	PROJECT_NAME,
	PROJECT_REPOSITORY,
} from "../branding.ts";
import type { SentinelProjectInfo, SentinelResolvedModelView, SentinelStateSnapshot, SentinelStatsView } from "../types.ts";
import { SENTINEL_MODE_LABELS } from "../types.ts";
import { GitHubIcon, SentinelMark } from "./icons.tsx";

export function AboutPage({
	snapshot,
	main,
	stats,
	project,
	connected,
}: {
	snapshot: SentinelStateSnapshot | null;
	/** What the 主模型 role resolves to. */
	main: SentinelResolvedModelView | null;
	stats: SentinelStatsView | null;
	project: SentinelProjectInfo | null;
	connected: boolean;
}) {
	const rows: { label: string; value: string }[] = [
		{ label: "控制台", value: `${PROJECT_NAME} Web 控制台` },
		{ label: "连接状态", value: connected ? "已连接" : "已断开" },
		{ label: "主模型", value: main ? `${main.entryName}（${main.modelId}）` : "未配置" },
		{ label: "模型", value: snapshot?.model ? `${snapshot.model.provider} / ${snapshot.model.id}` : "未配置" },
		{ label: "执行模式", value: snapshot ? SENTINEL_MODE_LABELS[snapshot.mode] : "—" },
		{ label: "思考等级", value: snapshot?.thinkingLevel ?? "—" },
		{ label: "当前项目", value: project ? `${project.name}（${project.container ?? "无容器"}）` : "未选择" },
		{ label: "工作目录", value: snapshot?.cwd ?? "—" },
		{ label: "当前会话", value: snapshot?.activeSessionId ?? "—" },
		{ label: "累计 Token", value: stats ? `输入 ${stats.tokens.input} / 输出 ${stats.tokens.output}` : "—" },
		{ label: "Token 合计", value: stats ? String(stats.tokens.total) : "—" },
		{ label: "累计花费", value: stats ? `$${stats.cost.toFixed(4)}` : "—" },
	];

	return (
		<div className="page-card">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					关于
					<span className="ws-panel__sub">当前运行环境与端点</span>
				</div>
			</div>
			<div className="ws-panel__body">
				<div className="kv-table">
					{rows.map((row) => (
						<div key={row.label} className="kv-row">
							<span className="kv-label">{row.label}</span>
							<span className="kv-value">{row.value}</span>
						</div>
					))}
				</div>
				<p className="ws-panel__hint">
					所有命令都在项目容器内以 root 执行，bash 命令在审批模式下逐条确认。工具输出与文件面板内容来自容器，
					请仅在已授权的目标上使用。
				</p>
				<div className="about-brand">
					<SentinelMark size={16} className="about-brand__mark" />
					<span className="about-brand__name">{PROJECT_NAME}</span>
					<span className="about-brand__version">v{CONSOLE_VERSION}</span>
					<span className="about-brand__sep" />
					<a href={PROJECT_REPOSITORY} target="_blank" rel="noreferrer">
						<GitHubIcon size={12} />
						GitHub
					</a>
					<a href={PROJECT_LICENSE_URL} target="_blank" rel="noreferrer">
						{PROJECT_LICENSE}
					</a>
				</div>
			</div>
		</div>
	);
}
