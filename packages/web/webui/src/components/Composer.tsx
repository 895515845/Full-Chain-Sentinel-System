import { useRef, useState } from "react";
import type { ZGImageAttachment, ZGMode, ZGStatsView, ZGThinkingLevel } from "../types.ts";

function formatTokens(count: number): string {
	if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
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

/** Read a pasted/selected image into the base64 payload pi expects. */
async function readImage(file: File): Promise<ZGImageAttachment | null> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
	const comma = dataUrl.indexOf(",");
	if (comma === -1) return null;
	return { type: "image", data: dataUrl.slice(comma + 1), mimeType: file.type || "image/png" };
}

export function Composer({
	streaming,
	mode,
	pendingApprovals,
	stats,
	branchOpen,
	thinkingLevel,
	availableThinkingLevels,
	onSetMode,
	onToggleBranch,
	onSetThinkingLevel,
	onCompact,
	onSend,
	onAbort,
}: {
	streaming: boolean;
	mode: ZGMode;
	pendingApprovals: number;
	stats: ZGStatsView | null;
	branchOpen: boolean;
	thinkingLevel: ZGThinkingLevel;
	availableThinkingLevels: ZGThinkingLevel[];
	onSetMode: (mode: ZGMode) => void;
	onToggleBranch: () => void;
	onSetThinkingLevel: (level: ZGThinkingLevel) => void;
	onCompact: () => void;
	onSend: (text: string, behavior?: "steer" | "followUp", images?: ZGImageAttachment[]) => void;
	onAbort: () => void;
}) {
	const [text, setText] = useState("");
	const [behavior, setBehavior] = useState<"steer" | "followUp">("steer");
	const [images, setImages] = useState<ZGImageAttachment[]>([]);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	const submit = (mode2?: "steer" | "followUp") => {
		const trimmed = text.trim();
		if (!trimmed && images.length === 0) return;
		onSend(trimmed, streaming ? (mode2 ?? behavior) : undefined, images.length > 0 ? images : undefined);
		setText("");
		setImages([]);
	};

	const addImages = async (files: FileList | File[]) => {
		const next: ZGImageAttachment[] = [];
		for (const file of Array.from(files)) {
			if (!file.type.startsWith("image/")) continue;
			const image = await readImage(file);
			if (image) next.push(image);
		}
		if (next.length > 0) setImages((prev) => [...prev, ...next]);
	};

	const canSend = text.trim().length > 0 || images.length > 0;
	// A model without reasoning support reports a single "off" level.
	const thinkingDisabled = availableThinkingLevels.length <= 1;

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
						<button
							type="button"
							className="tool-pill"
							onClick={onCompact}
							disabled={streaming}
							title={
								streaming
									? "Agent 正在运行，先中止再压缩"
									: "把当前上下文压缩成摘要，保留结论、丢弃过程（也可直接输入 /compact）"
							}
						>
							⤓ 压缩上下文
						</button>
						<label className="thinking-picker" title="模型的推理强度（仅对本次会话生效）">
							思考
							<select
								value={thinkingLevel}
								disabled={thinkingDisabled}
								onChange={(event) => onSetThinkingLevel(event.target.value as ZGThinkingLevel)}
							>
								{(availableThinkingLevels.length > 0 ? availableThinkingLevels : [thinkingLevel]).map(
									(level) => (
										<option key={level} value={level}>
											{THINKING_LABELS[level] ?? level}
										</option>
									),
								)}
							</select>
						</label>
						<button
							type="button"
							className="tool-pill"
							onClick={() => fileInputRef.current?.click()}
							title="附加图片（也可直接粘贴截图）"
						>
							🖼 图片
						</button>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							multiple
							hidden
							onChange={(event) => {
								if (event.target.files) void addImages(event.target.files);
								event.target.value = "";
							}}
						/>
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
								<button type="button" className="ghost small" onClick={() => submit()} disabled={!canSend}>
									发送
								</button>
								<button type="button" className="danger small" onClick={onAbort}>
									中止
								</button>
							</>
						) : (
							<button type="button" className="primary small" onClick={() => submit()} disabled={!canSend}>
								发送 ⏎
							</button>
						)}
					</div>
				</div>
				{images.length > 0 ? (
					<div className="attachment-strip">
						{images.map((image, index) => (
							<div key={index} className="attachment">
								<img src={`data:${image.mimeType};base64,${image.data}`} alt={`附件 ${index + 1}`} />
								<button
									type="button"
									className="attachment-remove"
									title="移除该图片"
									onClick={() => setImages((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}
								>
									×
								</button>
							</div>
						))}
						<span className="attachment-count">{images.length} 张图片待发送</span>
					</div>
				) : null}
				<textarea
					value={text}
					placeholder={streaming ? "Agent 正在运行… 输入内容可插话或排队" : "输入任务，Enter 发送，Shift+Enter 换行，可粘贴截图"}
					onChange={(event) => setText(event.target.value)}
					onPaste={(event) => {
						const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
						if (files.length > 0) {
							event.preventDefault();
							void addImages(files);
						}
					}}
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
				{thinkingDisabled ? "" : ` · 思考 ${THINKING_LABELS[thinkingLevel] ?? thinkingLevel}`}
				{stats ? ` · Token 输入 ${formatTokens(stats.tokens.input)} / 输出 ${formatTokens(stats.tokens.output)}` : ""}
			</div>
		</div>
	);
}
