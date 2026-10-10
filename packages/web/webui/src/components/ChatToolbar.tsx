/**
 * The chat page's toolbar.
 *
 * Everything that governs how the session runs lives here rather than in the
 * prompt box: the execution mode, the reasoning level, branch navigation,
 * context compaction, and the approved-command prefixes. The container file
 * browser and the sub-agent monitor open from here too, as overlays, so the
 * chat page is the single entry point for working on a target.
 */

import type { ZGMode, ZGThinkingLevel } from "../types.ts";
import { BranchIcon, CloseIcon, CompactIcon, FilesIcon, SubagentIcon } from "./icons.tsx";

const THINKING_LABELS: Record<ZGThinkingLevel, string> = {
	off: "关闭",
	minimal: "最低",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "极高",
	max: "最大",
};

export function ChatToolbar({
	mode,
	streaming,
	pendingApprovals,
	subagentRunning,
	thinkingLevel,
	availableThinkingLevels,
	branchOpen,
	filesOpen,
	subagentsOpen,
	allowedPrefixes,
	onToggleFiles,
	onToggleSubagents,
	onSetMode,
	onSetThinkingLevel,
	onToggleBranch,
	onCompact,
	onAllowPrefix,
	onRemoveAllowedPrefix,
}: {
	mode: ZGMode;
	streaming: boolean;
	pendingApprovals: number;
	subagentRunning: number;
	thinkingLevel: ZGThinkingLevel;
	availableThinkingLevels: ZGThinkingLevel[];
	branchOpen: boolean;
	filesOpen: boolean;
	subagentsOpen: boolean;
	allowedPrefixes: string[];
	onToggleFiles: () => void;
	onToggleSubagents: () => void;
	onSetMode: (mode: ZGMode) => void;
	onSetThinkingLevel: (level: ZGThinkingLevel) => void;
	onToggleBranch: () => void;
	onCompact: () => void;
	onAllowPrefix: (prefix: string) => void;
	onRemoveAllowedPrefix: (prefix: string) => void;
}) {
	// A model without reasoning support reports a single "off" level.
	const thinkingDisabled = availableThinkingLevels.length <= 1;

	return (
		<div className="chat-toolbar">
			<div className="mode-switch" title="审批模式会在每条命令执行前询问；自动模式直接执行">
				<button
					type="button"
					className={mode === "review" ? "on" : ""}
					onClick={() => onSetMode("review")}
				>
					审批模式
				</button>
				<button type="button" className={mode === "auto" ? "on" : ""} onClick={() => onSetMode("auto")}>
					自动执行
				</button>
			</div>
			<label className="thinking-picker" title="模型的推理强度（仅对本次会话生效）">
				思考
				<select
					value={thinkingLevel}
					disabled={thinkingDisabled}
					onChange={(event) => onSetThinkingLevel(event.target.value as ZGThinkingLevel)}
				>
					{(availableThinkingLevels.length > 0 ? availableThinkingLevels : [thinkingLevel]).map((level) => (
						<option key={level} value={level}>
							{THINKING_LABELS[level] ?? level}
						</option>
					))}
				</select>
			</label>
			<span className="ws-toolbar__sep" />
			<button
				type="button"
				className={`toolbar-btn ${branchOpen ? "on" : ""}`}
				onClick={onToggleBranch}
				title={branchOpen ? "收起分支视图" : "查看会话分支树，可从任意历史消息处分叉"}
			>
				<BranchIcon />
				分支
			</button>
			<button
				type="button"
				className="toolbar-btn"
				onClick={onCompact}
				disabled={streaming}
				title={
					streaming
						? "Agent 正在运行，先中止再压缩"
						: "把当前上下文压缩成摘要，保留结论、丢弃过程（也可直接输入 /compact）"
				}
			>
				<CompactIcon />
				压缩上下文
			</button>
			<span className="ws-toolbar__sep" />
			<button
				type="button"
				className={`toolbar-btn ${filesOpen ? "on" : ""}`}
				onClick={onToggleFiles}
				title="浏览容器工作目录 /work（可编辑、上传、下载）"
			>
				<FilesIcon />
				文件
			</button>
			<button
				type="button"
				className={`toolbar-btn ${subagentsOpen ? "on" : ""}`}
				onClick={onToggleSubagents}
				title="查看当前会话的子代理运行，可中止或追加指令"
			>
				<SubagentIcon />
				子代理
				{subagentRunning > 0 ? <span className="toolbar-count">{subagentRunning}</span> : null}
			</button>
			{pendingApprovals > 0 ? <span className="toolbar-alert">待审批 {pendingApprovals}</span> : null}
			{mode === "review" && allowedPrefixes.length > 0 ? (
				<div className="prefix-inline">
					<span className="prefix-inline-label">白名单</span>
					{allowedPrefixes.map((prefix) => (
						<span key={prefix} className="prefix-chip">
							{prefix}
							<button type="button" className="chip-remove" onClick={() => onRemoveAllowedPrefix(prefix)}>
								<CloseIcon size={11} />
							</button>
						</span>
					))}
					<button
						type="button"
						className="ghost small"
						title="把上一条命令的前缀加入白名单"
						onClick={() => {
							const next = window.prompt("要自动放行的命令前缀（复合命令永不自动放行）：");
							if (next?.trim()) onAllowPrefix(next.trim());
						}}
					>
						＋ 添加
					</button>
				</div>
			) : null}
		</div>
	);
}
