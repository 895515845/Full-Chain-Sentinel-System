import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatTokens, textFromContent } from "../transcript.ts";
import type { AgentMessageView, ContentBlockView } from "../types.ts";
import { ToolCard } from "./ToolCard.tsx";

/** Markdown renderer for model output; raw HTML is never rendered. */
export function MarkdownText({ text }: { text: string }) {
	return (
		<div className="markdown-body">
			<Markdown
				remarkPlugins={[remarkGfm]}
				components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
			>
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

/**
 * A goal round boundary: the opening contract renders as a distinct start
 * block; every automatic continuation renders as a centered badge divider
 * （迭代 N · 轮 N/Y · 上轮耗时） so a whole goal reads as one continuous
 * conversation instead of a sequence of "new sessions". Both expand to the
 * full contract text for auditing.
 */
function GoalMarker({ text, timestamp, elapsedMs }: { text: string; timestamp?: number; elapsedMs?: number }) {
	if (text.startsWith("【持续目标已启动】")) {
		const objective = /^目标（来自操作员）：(.+)$/m.exec(text)?.[1];
		const limit = /自动续跑上限为 (\d+) 轮/.exec(text)?.[1];
		return (
			<details className="goal-start">
				<summary>
					<span className="goal-start__title">持续目标已启动</span>
					<span className="goal-start__sub">
						{objective ? `目标：${objective}` : "见合约"}
						{limit ? ` · 轮数上限 ${limit}` : ""}
					</span>
				</summary>
				<pre className="goal-start__body">{text}</pre>
			</details>
		);
	}
	const round = /第 (\d+)\/(\d+) 轮/.exec(text);
	const iteration = round?.[1] ?? "?";
	const roundLimit = round?.[2] ?? "?";
	return (
		<details className="goal-iter-badge">
			<summary>
				<span className="chip">
					<b>迭代 {iteration}</b>
					<span className="t">
						轮 {iteration}/{roundLimit}
						{elapsedMs !== undefined ? ` · ${formatDurationShort(elapsedMs)}` : ""}
						{timestamp ? ` · ${formatTime(timestamp)}` : ""}
					</span>
				</span>
			</summary>
			<pre className="goal-iter-body">{text}</pre>
		</details>
	);
}

/** Compact mm:ss / h 小时 m 分 for badge metadata. */
function formatDurationShort(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds} 秒`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes} 分 ${totalSeconds % 60} 秒`;
	return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
}

/**
 * One settled step of an expanded run, 方案 B 单行手风琴: time · tool · argument
 * summary · duration on one line, the output hidden until the row is clicked.
 * This is the compact shape that keeps a 100-step run scannable; the streaming
 * run keeps full ToolCards instead.
 */
function StepRow({
	time,
	tool,
	argument,
	output,
	durationMs,
	isError,
	onFullscreen,
	viewerTitle,
}: {
	time?: number;
	tool: string;
	argument: string;
	output: string;
	durationMs?: number;
	isError?: boolean;
	onFullscreen?: (command: string | undefined, output: string) => void;
	/** Title for the shared viewer; defaults to the generic tool-output label. */
	viewerTitle?: string;
}) {
	const lines = output ? output.replace(/\n+$/, "").split("\n") : [];
	const preview = lines.slice(0, 3).join("\n");
	const rest = lines.length - Math.min(lines.length, 3);
	// The preview is three lines; "查看全部" has to lead somewhere even when the
	// host did not supply a viewer, otherwise the row offers a button that does
	// nothing. Thinking rows used to hit exactly that: they never forwarded
	// `onFullscreen`, so the click was swallowed.
	const [expanded, setExpanded] = useState(false);
	const showAll = () => {
		if (onFullscreen) onFullscreen(viewerTitle, output);
		else setExpanded(true);
	};
	return (
		<details className={isError ? "step-row step-err" : "step-row"}>
			<summary>
				<span className="step-time">{time ? formatTime(time) : ""}</span>
				<span className={`step-tool ${tool}`}>{tool}</span>
				<span className="step-arg">{argument || "(无参数)"}</span>
				{durationMs ? (
					<span className="step-dur">{durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`}</span>
				) : null}
			</summary>
			<div className="step-out">
				<pre>{expanded ? lines.join("\n") : preview}</pre>
				{rest > 0 && !expanded ? (
					<button
						type="button"
						className="step-more"
						title={onFullscreen ? "在查看器中打开全部内容" : "就地展开全部内容"}
						onClick={(event) => {
							event.preventDefault();
							showAll();
						}}
					>
						… 还有 {rest} 行，点击查看全部
					</button>
				) : null}
			</div>
		</details>
	);
}

/** First line of a thinking block, as the row's argument summary. */
function thinkingSummary(thinking: string): string {
	const line = thinking.split("\n").find((candidate) => candidate.trim().length > 0) ?? "(空)";
	return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

export function MessageView({
	message,
	toolCommand,
	forkEntryId,
	onFork,
	onFullscreen,
	goalElapsedMs,
	compact,
}: {
	message: AgentMessageView;
	/** Command of the tool call this result belongs to, when the transcript has it. */
	toolCommand?: string;
	forkEntryId?: string;
	onFork?: (entryId: string) => void;
	onFullscreen?: (command: string | undefined, output: string) => void;
	/** For a goal continuation marker: how long the round it closed took. */
	goalElapsedMs?: number;
	/** 方案 B：settled run 内用单行手风琴渲染工具与思考；流式运行组保持完整卡片。 */
	compact?: boolean;
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
			(block) =>
				(block as { type?: string }).type === "toolCall" && (block as { name?: string }).name === "spawn_agent",
		);
		const thinkingText = thinking.map((block) => (block as { thinking?: string }).thinking ?? "").join("\n");
		// 方案 B：只含思考、没有正文的 assistant（被中止/压缩截断的常见形态）在
		// settled run 里就是一行「思考」，不再套 AI 徽标行和折叠块。
		if (compact && thinking.length > 0 && !text) {
			return (
				<StepRow
					time={message.timestamp}
					tool="思考"
					argument={thinkingSummary(thinkingText)}
					output={thinkingText}
					onFullscreen={onFullscreen}
					viewerTitle="思考过程"
				/>
			);
		}
		return (
			<AgentEntry subagent={isSubagentToolCall} timestamp={message.timestamp}>
				{thinking.length > 0 ? (
					compact && text ? (
						<StepRow
							time={message.timestamp}
							tool="思考"
							argument={thinkingSummary(thinkingText)}
							output={thinkingText}
							onFullscreen={onFullscreen}
							viewerTitle="思考过程"
						/>
					) : (
						<details className="thinking">
							<summary>思考过程</summary>
							<pre>{thinkingText}</pre>
						</details>
					)
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
		if (compact) {
			return (
				<StepRow
					time={message.timestamp}
					tool={message.toolName}
					argument={toolCommand ?? ""}
					output={output}
					durationMs={message.durationMs}
					isError={message.isError}
					onFullscreen={onFullscreen}
				/>
			);
		}
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
		if (compact) {
			return (
				<StepRow
					time={message.timestamp}
					tool="bash"
					argument={message.command}
					output={message.output}
					isError={message.exitCode !== 0 && !message.cancelled}
					onFullscreen={onFullscreen}
				/>
			);
		}
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
		if (message.customType === "zg-goal") {
			const text = textFromContent(message.content);
			return <GoalMarker text={text} timestamp={message.timestamp} elapsedMs={goalElapsedMs} />;
		}
		// Loop-guard notices: the run was cut short because the output stuttered, or a
		// tool call repeated. They are injected into the conversation like a prompt, so
		// they fold the same way, but they are not the operator's words.
		if (message.customType === "zg-loop-guard") {
			const text = textFromContent(message.content);
			const stutter = text.startsWith("【输出重复】");
			return (
				<details className="summary loop-guard-row">
					<summary>
						<span className={stutter ? "loop-guard-stutter" : "loop-guard-repeat"}>
							{stutter ? "输出重复已中止" : "重复工具调用提醒"}
						</span>
						{message.timestamp ? <span className="summary-meta"> · {formatTime(message.timestamp)}</span> : null}
					</summary>
					<pre>{text}</pre>
				</details>
			);
		}
		// Business-modeling rows: the briefing the button injected and the line that
		// closed the run. They fold like a summary — the operator needs the boundary
		// in the transcript, not the whole briefing in the way.
		if (message.customType === "zg-modeling") {
			const text = textFromContent(message.content);
			const closing = text.startsWith("【业务建模 · 结束】");
			return (
				<details className="summary modeling-row">
					<summary>
						<span className={closing ? "modeling-row__close" : "modeling-row__open"}>
							{closing ? "业务建模已结束" : "业务建模已启动"}
						</span>
						{message.timestamp ? <span className="summary-meta"> · {formatTime(message.timestamp)}</span> : null}
					</summary>
					<pre>{text}</pre>
				</details>
			);
		}
		// Attached-records rows: the catalog that rode the first message of a
		// conversation (带建模数据), and the line stating it was removed. The catalog
		// is long, so it lives entirely inside the fold.
		if (message.customType === "zg-modeling-attach") {
			const text = textFromContent(message.content);
			const removed = text.startsWith("【业务建模 · 已移除");
			const attached = text.match(/已带入 (\d+) 份/);
			return (
				<details className="summary modeling-row">
					<summary>
						<span className={removed ? "modeling-row__close" : "modeling-row__open"}>
							{removed ? "已移除带入的建模数据" : `已带入业务建模${attached ? ` ${attached[1]} 份` : "数据"}`}
						</span>
						{message.timestamp ? <span className="summary-meta"> · {formatTime(message.timestamp)}</span> : null}
					</summary>
					<pre>{text}</pre>
				</details>
			);
		}
		return null;
	}

	return null;
}
