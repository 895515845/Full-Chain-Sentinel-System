import type { ContentBlockView, AgentMessageView } from "../types.ts";
import { ToolCard } from "./ToolCard.tsx";

function blockText(block: ContentBlockView): string {
	if (typeof block !== "object" || block === null) return "";
	if (block.type === "text") return (block as { text: string }).text;
	return "";
}

function formatTime(timestamp?: number): string {
	if (!timestamp) return "";
	return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}

function Entry({
	role,
	timestamp,
	children,
}: {
	role: "operator" | "agent" | "subagent";
	timestamp?: number;
	children: React.ReactNode;
}) {
	return (
		<div className={`entry ${role}`}>
			<div className="entry-head">
				<span className={`role-tag ${role}`}>{role === "operator" ? "OPERATOR" : role === "agent" ? "AGENT" : "SUB-AGENT"}</span>
				<span className="entry-time">{formatTime(timestamp)}</span>
			</div>
			{children}
		</div>
	);
}

/** Turn common provider/endpoint failures into an actionable Chinese hint. */
function hintForError(message: string): string {
	if (/502|upstream/i.test(message)) {
		return "端点网关连不上上游模型服务：检查中转渠道是否被禁用、上游服务是否存活。可用「模型设置 → 测试连接」验证。";
	}
	if (/401|403|unauthorized|api key|authentication/i.test(message)) {
		return "认证失败：检查 API Key 是否有效，或在「模型设置」中重新填写。";
	}
	if (/404|not found/i.test(message)) {
		return "路径或模型不存在：确认 Base URL 以 /v1 结尾、模型 ID 拼写正确。";
	}
	if (/429|rate limit|quota/i.test(message)) {
		return "限流或额度不足：稍后重试，或检查端点的令牌额度。";
	}
	if (/timeout|timed out|econnrefused|enotfound|fetch failed|network/i.test(message)) {
		return "网络问题：确认端点地址可达、服务已启动。可用「模型设置 → 测试连接」定位。";
	}
	if (/context|token limit|too long/i.test(message)) {
		return "上下文超限：输入 /compact 压缩会话后重试。";
	}
	return "运行失败：可重试；持续失败请用「模型设置 → 测试连接」检查端点。";
}

export function MessageView({
	message,
	forkEntryId,
	onFork,
	onFullscreen,
}: {
	message: AgentMessageView;
	forkEntryId?: string;
	onFork?: (entryId: string) => void;
	onFullscreen?: (command: string | undefined, output: string) => void;
}) {
	if (message.role === "user") {
		const text = Array.isArray(message.content)
			? message.content.map(blockText).join("")
			: String(message.content ?? "");
		return (
			<Entry role="operator" timestamp={message.timestamp}>
				<div className="entry-body">{text}</div>
				{forkEntryId && onFork ? (
					<button type="button" className="ghost small fork-button" onClick={() => onFork(forkEntryId)}>
						↩ 从此分叉
					</button>
				) : null}
			</Entry>
		);
	}

	if (message.role === "assistant") {
		const blocks = Array.isArray(message.content) ? message.content : [];
		const thinking = blocks.filter((block) => (block as { type?: string }).type === "thinking");
		const text = blocks.map(blockText).join("");
		const failed = message.stopReason === "error" || message.stopReason === "aborted";
		const isSubagentToolCall = blocks.some(
			(block) => (block as { type?: string }).type === "toolCall" && (block as { name?: string }).name === "spawn_agent",
		);
		return (
			<Entry role={isSubagentToolCall ? "subagent" : "agent"} timestamp={message.timestamp}>
				{thinking.length > 0 ? (
					<details className="thinking">
						<summary>思考过程</summary>
						<pre>{thinking.map((block) => (block as { thinking?: string }).thinking ?? "").join("\n")}</pre>
					</details>
				) : null}
				{text ? <div className={`entry-body${failed ? " failed" : ""}`}>{text}</div> : null}
				{failed && !text ? <div className="entry-body failed">（本次运行失败或被中止）</div> : null}
				{message.errorMessage ? (
					<div className="entry-body failed">
						<div className="error-title">{message.errorMessage}</div>
						<div className="error-hint">{hintForError(message.errorMessage)}</div>
					</div>
				) : null}
			</Entry>
		);
	}

	if (message.role === "toolResult") {
		const output = Array.isArray(message.content) ? message.content.map(blockText).join("") : "";
		return (
			<ToolCard
				name={message.toolName}
				status={message.isError ? "error" : "done"}
				durationMs={message.durationMs}
				output={output}
				onFullscreen={onFullscreen}
			/>
		);
	}

	if (message.role === "bashExecution") {
		return (
			<ToolCard
				name="! bash"
				status={message.exitCode === 0 ? "done" : "error"}
				command={message.command}
				output={message.output}
				onFullscreen={onFullscreen}
			/>
		);
	}

	if (message.role === "compactionSummary" || message.role === "branchSummary") {
		return (
			<details className="summary">
				<summary>会话摘要（{message.role === "compactionSummary" ? "压缩" : "分支"}）</summary>
				<pre>{message.summary ?? ""}</pre>
			</details>
		);
	}

	return null;
}
