import { useState } from "react";
import type { ZGMode, ZGStatsView } from "../types.ts";

function formatTokens(count: number): string {
	if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

export function Composer({
	streaming,
	mode,
	pendingApprovals,
	stats,
	branchOpen,
	onSetMode,
	onToggleBranch,
	onSend,
	onAbort,
}: {
	streaming: boolean;
	mode: ZGMode;
	pendingApprovals: number;
	stats: ZGStatsView | null;
	branchOpen: boolean;
	onSetMode: (mode: ZGMode) => void;
	onToggleBranch: () => void;
	onSend: (text: string, behavior?: "steer" | "followUp") => void;
	onAbort: () => void;
}) {
	const [text, setText] = useState("");
	const [behavior, setBehavior] = useState<"steer" | "followUp">("steer");

	const submit = (mode2?: "steer" | "followUp") => {
		const trimmed = text.trim();
		if (!trimmed) return;
		onSend(trimmed, streaming ? (mode2 ?? behavior) : undefined);
		setText("");
	};

	return (
		<div className="composer-zone">
			<div className="composer">
				<div className="composer-top">
					<div className="composer-controls">
						<button
							type="button"
							className={`mode-pill ${mode}`}
							onClick={() => onSetMode(mode === "review" ? "auto" : "review")}
							title="点击切换执行模式"
						>
							<span className="mode-pill-dot" />
							{mode === "review" ? "审批模式" : "自动模式"}
						</button>
						<button
							type="button"
							className={`tool-pill ${branchOpen ? "on" : ""}`}
							onClick={onToggleBranch}
							title={branchOpen ? "收起分支面板" : "展开分支面板"}
						>
							⑂ 分支
						</button>
					</div>
					<div className="composer-actions">
						{streaming ? (
							<>
								<label className="behavior">
									<input type="radio" name="behavior" checked={behavior === "steer"} onChange={() => setBehavior("steer")} />
									插话
								</label>
								<label className="behavior">
									<input
										type="radio"
										name="behavior"
										checked={behavior === "followUp"}
										onChange={() => setBehavior("followUp")}
									/>
									排队
								</label>
								<button type="button" className="ghost small" onClick={() => submit()}>
									发送
								</button>
								<button type="button" className="danger small" onClick={onAbort}>
									中止
								</button>
							</>
						) : (
							<button type="button" className="primary small" onClick={() => submit()} disabled={!text.trim()}>
								发送 ⏎
							</button>
						)}
					</div>
				</div>
				<textarea
					value={text}
					placeholder={streaming ? "Agent 正在运行… 输入内容可插话或排队" : "输入任务，Enter 发送，Shift+Enter 换行"}
					onChange={(event) => setText(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							submit();
						}
					}}
					rows={Math.min(6, Math.max(2, text.split("\n").length + 1))}
				/>
			</div>
			<div className="status-line">
				执行模式 {mode === "review" ? "审批" : "自动"}
				{pendingApprovals > 0 ? <span className="status-alert"> · 待审批 {pendingApprovals}</span> : null}
				{" · "}
				{streaming ? "运行中…" : "空闲"}
				{stats ? ` · Token 输入 ${formatTokens(stats.tokens.input)} / 输出 ${formatTokens(stats.tokens.output)}` : ""}
			</div>
		</div>
	);
}
