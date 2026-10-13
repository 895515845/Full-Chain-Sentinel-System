/**
 * The chat page's toolbar.
 *
 * Everything that governs how the session runs lives here rather than in the
 * prompt box: the execution mode, the reasoning level, branch navigation,
 * context compaction, and the approved-command prefixes. The container file
 * browser and the sub-agent monitor open from here too, as overlays, so the
 * chat page is the single entry point for working on a target.
 */

import { useEffect, useState } from "react";

import type { ZGMode, ZGSessionPresetView, ZGSessionStatus, ZGThinkingLevel } from "../types.ts";
import { ZG_MODES, ZG_MODE_LABELS } from "../types.ts";
import { BranchIcon, CloseIcon, CompactIcon, FilesIcon, SubagentIcon } from "./icons.tsx";
import { SessionStatusControl } from "./SessionStatusControl.tsx";

/** Elapsed time of a compaction, so a slow model is visible as a wait, not a hang. */
function compactionElapsed(startedAt: number | null, now: number): string {
	if (startedAt === null) return "";
	const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
	return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
}

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
	sessionOverride,
	globalMode,
	streaming,
	pendingApprovals,
	subagentRunning,
	thinkingLevel,
	availableThinkingLevels,
	branchOpen,
	filesOpen,
	subagentsOpen,
	allowedPrefixes,
	sessionStatus,
	preset,
	onSetSessionStatus,
	onToggleFiles,
	onToggleSubagents,
	onSetMode,
	onSetThinkingLevel,
	onToggleBranch,
	onCompact,
	onAbortCompaction,
	compacting,
	compactionStartedAt,
	onAllowPrefix,
	onRemoveAllowedPrefix,
}: {
	mode: ZGMode;
	/** The active session's own choice; null means it follows the global default. */
	sessionOverride: ZGMode | null;
	globalMode: ZGMode;
	streaming: boolean;
	pendingApprovals: number;
	subagentRunning: number;
	thinkingLevel: ZGThinkingLevel;
	availableThinkingLevels: ZGThinkingLevel[];
	branchOpen: boolean;
	filesOpen: boolean;
	subagentsOpen: boolean;
	allowedPrefixes: string[];
	/** The active session's operator status, shown as a chip at the right end. */
	sessionStatus: ZGSessionStatus | null;
	/** The preset agent the active session was created with; null means the default agent. */
	preset: ZGSessionPresetView | null;
	onSetSessionStatus: (status: ZGSessionStatus | null) => void;
	onToggleFiles: () => void;
	onToggleSubagents: () => void;
	onSetMode: (mode: ZGMode | null) => void;
	onSetThinkingLevel: (level: ZGThinkingLevel) => void;
	onToggleBranch: () => void;
	onCompact: () => void;
	onAbortCompaction: () => void;
	/** Compaction is running, so a prompt would be refused until it ends. */
	compacting: boolean;
	compactionStartedAt: number | null;
	onAllowPrefix: (prefix: string) => void;
	onRemoveAllowedPrefix: (prefix: string) => void;
}) {
	// The elapsed time has to move on its own: a compaction that stalls for
	// minutes sends no snapshots, and a frozen "压缩中 3 秒" reads as a hang.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!compacting) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [compacting]);

	// A model without reasoning support reports a single "off" level.
	const thinkingDisabled = availableThinkingLevels.length <= 1;

	return (
		<div className="chat-toolbar">
			<div
				className="mode-switch"
				title={
					"审批模式：每条命令执行前等人放行；" +
					"AI 审批：每条命令先交给守门模型判定，拦截时把理由回给 Agent；" +
					"自动执行：不做任何拦截。切换只影响本会话"
				}
			>
				{ZG_MODES.map((item) => (
					<button
						key={item}
						type="button"
						className={mode === item ? "on" : ""}
						onClick={() => onSetMode(item)}
					>
						{ZG_MODE_LABELS[item]}
					</button>
				))}
			</div>
			{sessionOverride === null ? (
				<span
					className="mode-scope"
					title={`本会话跟随全局默认（${ZG_MODE_LABELS[globalMode]}）。点任一模式可为本会话单独设定`}
				>
					跟随全局
				</span>
			) : (
				<button
					type="button"
					className="ghost small"
					onClick={() => onSetMode(null)}
					title={`清除本会话的单独设定，重新跟随全局默认（${ZG_MODE_LABELS[globalMode]}）`}
				>
					跟随全局
				</button>
			)}
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
			{preset ? (
				<span
					className={`toolbar-preset ${preset.missing ? "toolbar-preset--missing" : ""}`}
					title={
						preset.missing
							? `预设「${preset.name}」已被删除或正文缺失，本会话现按默认 Agent 运行；可在输入框上方的「预设 Agent」里换一个，或换回默认 Agent`
							: `预设 Agent：${preset.name}（在输入框上方的「预设 Agent」里可随时更换，只影响之后的回合）`
					}
				>
					预设：{preset.name}
					{preset.missing ? " · 已失效，按默认 Agent 运行" : ""}
				</span>
			) : null}
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
			{compacting ? (
				<>
					<span className="toolbar-busy" title="压缩期间不能发送新消息">
						<CompactIcon />
						压缩中 {compactionElapsed(compactionStartedAt, now)}
					</span>
					<button
						type="button"
						className="toolbar-btn danger"
						onClick={onAbortCompaction}
						title="放弃这次压缩，立刻恢复发送（会话内容不会丢失，压缩只有拿到摘要才会改写上下文）"
					>
						<CloseIcon />
						中止压缩
					</button>
				</>
			) : (
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
			)}
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
			<span className="toolbar-status">
				<SessionStatusControl variant="toolbar" status={sessionStatus} onPick={onSetSessionStatus} />
			</span>
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
