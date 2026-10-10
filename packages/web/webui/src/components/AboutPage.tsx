/**
 * The about page.
 *
 * Read-only summary of what this console is and what it is currently talking
 * to. Values come from the live snapshot, so it doubles as a diagnostics view
 * when something looks wrong.
 */

import type { ZGModelConfig, ZGProjectInfo, ZGStateSnapshot, ZGStatsView } from "../types.ts";

export function AboutPage({
	snapshot,
	config,
	stats,
	project,
	connected,
}: {
	snapshot: ZGStateSnapshot | null;
	config: ZGModelConfig | null;
	stats: ZGStatsView | null;
	project: ZGProjectInfo | null;
	connected: boolean;
}) {
	const rows: { label: string; value: string }[] = [
		{ label: "控制台", value: "ZGAgent Web 控制台" },
		{ label: "连接状态", value: connected ? "已连接" : "已断开" },
		{ label: "模型端点", value: config?.baseUrl || "未配置" },
		{ label: "模型", value: snapshot?.model ? `${snapshot.model.provider} / ${snapshot.model.id}` : "未配置" },
		{ label: "执行模式", value: snapshot?.mode === "auto" ? "自动执行" : "审批模式" },
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
			</div>
		</div>
	);
}
