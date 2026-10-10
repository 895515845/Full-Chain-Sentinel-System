import { useRef, useState } from "react";
import type { ZGImageAttachment, ZGStatsView } from "../types.ts";
import { BellIcon, ImageIcon } from "./icons.tsx";

function formatTokens(count: number): string {
	if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

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

/**
 * The prompt box.
 *
 * Execution policy (mode, thinking level, compaction, branch) lives in the
 * chat page's toolbar; the composer only carries what belongs to one message:
 * its text, its attachments, and whether the run reports to the notification
 * channel.
 */
export function Composer({
	streaming,
	stats,
	hasProject,
	blockedReason,
	notifyRun,
	onToggleNotifyRun,
	onSend,
	onAbort,
}: {
	streaming: boolean;
	stats: ZGStatsView | null;
	hasProject: boolean;
	/** Set when the console cannot run anything: the input is locked until it clears. */
	blockedReason: string | null;
	/** Whether the run started from here reports to the notification channel. */
	notifyRun: boolean;
	onToggleNotifyRun: () => void;
	onSend: (text: string, behavior?: "steer" | "followUp", images?: ZGImageAttachment[]) => void;
	onAbort: () => void;
}) {
	const [text, setText] = useState("");
	const [behavior, setBehavior] = useState<"steer" | "followUp">("steer");
	const [images, setImages] = useState<ZGImageAttachment[]>([]);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	const submit = (override?: "steer" | "followUp") => {
		const trimmed = text.trim();
		if (blocked || (!trimmed && images.length === 0)) return;
		onSend(trimmed, streaming ? (override ?? behavior) : undefined, images.length > 0 ? images : undefined);
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

	const blocked = blockedReason !== null;
	const canSend = !blocked && (text.trim().length > 0 || images.length > 0);

	return (
		<div className="composer-zone">
			<div className="composer">
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
					placeholder={
						blocked
							? blockedReason
							: hasProject
								? streaming
									? "Agent 正在运行… 输入内容可插话或排队"
									: "输入目标与任务，Enter 发送，Shift+Enter 换行，可直接粘贴截图"
								: "请先在「项目」页创建或选择一个项目"
					}
					disabled={!hasProject || blocked}
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
					rows={Math.min(8, Math.max(3, text.split("\n").length + 1))}
				/>
				<div className="composer-actions">
					<button
						type="button"
						className="composer-tool"
						onClick={() => fileInputRef.current?.click()}
						disabled={!hasProject || blocked}
						title="附加图片（也可直接粘贴截图）"
					>
						<ImageIcon />
						图片
					</button>
					<button
						type="button"
						className={`composer-tool ${notifyRun ? "on" : ""}`}
						onClick={onToggleNotifyRun}
						title={notifyRun ? "本次运行完成后发送钉钉通知（点击关闭）" : "本次运行完成后不通知（点击开启）"}
					>
						<BellIcon />
						通知
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
					<span className="composer-spacer" />
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
							<button type="button" className="primary" onClick={() => submit()} disabled={!canSend}>
								发送
							</button>
							<button type="button" className="danger" onClick={onAbort}>
								中止
							</button>
						</>
					) : (
						<button
							type="button"
							className="primary"
							onClick={() => submit()}
							disabled={!canSend || !hasProject || blocked}
						>
							发送 ⏎
						</button>
					)}
				</div>
			</div>
			<div className="status-line">
				{blocked ? <span className="status-alert">已锁定</span> : streaming ? <span className="status-alert">运行中…</span> : "空闲"}
				{stats ? (
					<>
						{" · Token 输入 "}
						{formatTokens(stats.tokens.input)}
						{" / 输出 "}
						{formatTokens(stats.tokens.output)}
						{stats.cost > 0 ? ` · 花费 $${stats.cost.toFixed(4)}` : ""}
					</>
				) : null}
			</div>
		</div>
	);
}
