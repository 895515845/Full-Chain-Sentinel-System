import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatTokens, textFromContent } from "../transcript.ts";
import type { ContentBlockView, AgentMessageView } from "../types.ts";
import { ToolCard } from "./ToolCard.tsx";

/** Markdown renderer for model output; raw HTML is never rendered. */
export function MarkdownText({ text }: { text: string }) {
	return (
		<div className="markdown-body">
			<Markdown remarkPlugins={[remarkGfm]} components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}>
				{text}
			</Markdown>
		</div>
	);
}

function blockText(block: ContentBlockView): string {
	if (typeof block !== "object" || block === null) return "";
	if (block.type === "text") return (block as { text: string }).text;
	return "";
}

/** Image attachments stored on a user message, rendered from their base64 payload. */
function messageImages(content: unknown): { data: string; mimeType: string }[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(block): block is { type: "image"; data: string; mimeType: string } =>
			typeof block === "object" &&
			block !== null &&
			(block as { type?: string }).type === "image" &&
			typeof (block as { data?: unknown }).data === "string",
	);
}

function formatTime(timestamp?: number): string {
	if (!timestamp) return "";
	return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * One operator entry: a prompt line with a marker, the way a console echoes
 * input. No avatar, no bubble, no role tag.
 */
function OperatorEntry({ timestamp, children }: { timestamp?: number; children: React.ReactNode }) {
	return (
		<div className="log-op">
			<span className="log-op-mark">&gt;</span>
			<div className="log-op-body">
				{children}
				{timestamp ? <span className="log-time">{formatTime(timestamp)}</span> : null}
			</div>
		</div>
	);
}

/** One agent entry: plain prose in the flow, with a quiet timestamp gutter. */
export function AgentEntry({
	subagent,
	timestamp,
	children,
}: {
	subagent?: boolean;
	timestamp?: number;
	children: React.ReactNode;
}) {
	return (
		<div className={`log-agent ${subagent ? "subagent" : ""}`}>
			<span className="log-gutter">{subagent ? "SA" : "AI"}</span>
			<div className="log-body">
				{children}
				{timestamp ? <span className="log-time">{formatTime(timestamp)}</span> : null}
			</div>
		</div>
	);
}

/** Turn common provider/endpoint failures into an actionable Chinese hint. */
function hintForError(message: string): string {
	if (/502|upstream/i.test(message)) {
		return "端点网关连不上上游模型服务：检查中转渠道是否被禁用、上游服务是否存活。可用「设置 → 模型 → 测试连接」验证。";
	}
	if (/401|403|unauthorized|api key|authentication/i.test(message)) {
		return "认证失败：检查 API Key 是否有效，或在「设置 → 模型」中重新填写。";
	}
	if (/404|not found/i.test(message)) {
		return "路径或模型不存在：确认 Base URL 以 /v1 结尾、模型 ID 拼写正确。";
	}
	if (/429|rate limit|quota/i.test(message)) {
		return "限流或额度不足：稍后重试，或检查端点的令牌额度。";
	}
	if (/timeout|timed out|econnrefused|enotfound|fetch failed|network/i.test(message)) {
		return "网络问题：确认端点地址可达、服务已启动。可用「设置 → 模型 → 测试连接」定位。";
	}
	if (/context|token limit|too long/i.test(message)) {
		return "上下文超限：先压缩会话（输入 /compact 或点击「压缩上下文」）后重试。";
	}
	return "运行失败：可重试；持续失败请用「设置 → 模型 → 测试连接」检查端点。";
}

export function MessageView({
	message,
	toolCommand,
	forkEntryId,
	onFork,
	onFullscreen,
}: {
	message: AgentMessageView;
	/** Command of the tool call this result belongs to, when the transcript has it. */
	toolCommand?: string;
	forkEntryId?: string;
	onFork?: (entryId: string) => void;
	onFullscreen?: (command: string | undefined, output: string) => void;
}) {
	if (message.role === "user") {
		const text = Array.isArray(message.content)
			? message.content.map(blockText).join("")
			: String(message.content ?? "");
		const images = messageImages(message.content);
		return (
			<OperatorEntry timestamp={message.timestamp}>
				{images.length > 0 ? (
					<div className="message-images">
						{images.map((image, index) => (
							<img
								key={index}
								src={`data:${image.mimeType};base64,${image.data}`}
								alt={`附件 ${index + 1}`}
								loading="lazy"
							/>
						))}
					</div>
				) : null}
				{text ? <div className="log-op-text">{text}</div> : null}
				{forkEntryId && onFork ? (
					<button type="button" className="ghost small fork-button" onClick={() => onFork(forkEntryId)}>
						从此分叉
					</button>
				) : null}
			</OperatorEntry>
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
			<AgentEntry subagent={isSubagentToolCall} timestamp={message.timestamp}>
				{thinking.length > 0 ? (
					<details className="thinking">
						<summary>思考过程</summary>
						<pre>{thinking.map((block) => (block as { thinking?: string }).thinking ?? "").join("\n")}</pre>
					</details>
				) : null}
				{text ? (
					<div className={failed ? "failed" : ""}>
						<MarkdownText text={text} />
					</div>
				) : null}
				{failed && !text ? <div className="failed">（本次运行失败或被中止）</div> : null}
				{message.errorMessage ? (
					<div className="failed">
						<div className="error-title">{message.errorMessage}</div>
						<div className="error-hint">{hintForError(message.errorMessage)}</div>
					</div>
				) : null}
			</AgentEntry>
		);
	}

	if (message.role === "toolResult") {
		const output = Array.isArray(message.content) ? message.content.map(blockText).join("") : "";
		return (
			<ToolCard
				name={message.toolName}
				status={message.isError ? "error" : "done"}
				durationMs={message.durationMs}
				command={toolCommand}
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
		// The row says what was summarized: the summary itself is the model's
		// context, and the transcript above the marker is what it replaced.
		const before = message.role === "compactionSummary" && message.tokensBefore ? message.tokensBefore : 0;
		return (
			<details className="summary">
				<summary>
					会话摘要（{message.role === "compactionSummary" ? "压缩" : "分支"}）
					{before > 0 ? <span className="summary-meta"> · 压缩前 {formatTokens(before)} tokens</span> : null}
				</summary>
				<pre>{message.summary ?? ""}</pre>
			</details>
		);
	}

	if (message.role === "custom") {
		// Goal rows are goal mode's own voice in the transcript: the contract the
		// goal started under, and the one injected for each automatic continuation.
		// They fold like a summary, because they are a boundary line between rounds
		// rather than part of what the agent said.
		if (message.customType !== "zg-goal") return null;
		const text = textFromContent(message.content);
		const label = text.startsWith("【持续目标已启动】") ? "持续目标已启动" : "目标续跑";
		return (
			<details className="summary goal-row">
				<summary>
					{label}
					{message.timestamp ? <span className="summary-meta"> · {formatTime(message.timestamp)}</span> : null}
				</summary>
				<pre>{text}</pre>
			</details>
		);
	}

	return null;
}
