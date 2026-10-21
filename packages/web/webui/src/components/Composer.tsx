import { useEffect, useRef, useState } from "react";
import { t } from "../i18n.ts";
import { formatSize, formatTokens } from "../transcript.ts";
import type {
	SentinelApiModelSummary,
	SentinelImageAttachment,
	SentinelModelingState,
	SentinelPresetView,
	SentinelSessionPresetView,
	SentinelStatsView,
	SentinelSupervisorCustomStrategy,
	SentinelSupervisorMode,
	SentinelSupervisorStrategyRef,
	SentinelSupervisorView,
} from "../types.ts";
import { attachmentManifest, planAttachments, staleUploads, type UploadedFile, uploadFile } from "../uploads.ts";
import {
	ApiModelIcon,
	BellIcon,
	DroidIcon,
	FilesIcon,
	ImageIcon,
	SubagentIcon,
	SupervisorIcon,
	TargetIcon,
} from "./icons.tsx";
import { ModelingMenu } from "./ModelingMenu.tsx";
import { PresetMenu, type PresetMenuAnchor, presetMenuPosition } from "./PresetMenu.tsx";
import { SupervisorStartMenu, type SupervisorLaunchMode } from "./SupervisorStartMenu.tsx";
import { supervisorStrategyKey } from "../supervisor-strategy.ts";

/** Read a pasted/selected image into the base64 payload pi expects. */
async function readImage(file: File): Promise<SentinelImageAttachment | null> {
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

/** The idle hint when no preset agent brings its own. */
const DEFAULT_HINT = t("输入目标与任务，Enter 发送，Shift+Enter 换行，可粘贴截图或拖入文件");

function initialSupervisorStrategies(defaults: SentinelSupervisorStrategyRef[]): SentinelSupervisorStrategyRef[] {
	return defaults.length > 0 ? defaults.map((entry) => ({ ...entry })) : [{ strategy: "steady", customStrategyId: null }];
}

/**
 * The grey line in the input box. A preset agent may bring its own, which is how
 * an operator says what this agent expects to be asked; a preset whose body went
 * missing runs the default agent, so it falls back to the default text as well.
 */
export function composerHint(preset: SentinelSessionPresetView | null): string {
	const custom = preset && !preset.missing ? preset.placeholder.trim() : "";
	return custom || DEFAULT_HINT;
}

/** Tokens per second, with enough precision to be useful at low speeds. */
export function formatThroughput(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "—";
	if (value >= 100) return value.toFixed(0);
	if (value >= 10) return value.toFixed(1);
	return value.toFixed(2);
}

/**
 * One attachment in the composer: uploading, stored, or refused. The file itself
 * is already in the project's work dir by the time it is stored — the message
 * carries only its path.
 */
interface PendingAttachment {
	/** Client-side key: the same file may be attached twice. */
	id: string;
	name: string;
	size: number;
	/** 0..1 while the body is on the wire. */
	ratio: number;
	error: string | null;
	uploaded: UploadedFile | null;
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
	throughput,
	hasProject,
	projectId,
	blockedReason,
	notifyRun,
	goalDisabledReason,
	modeling,
	modelingAttached,
	droidEnabled,
	onToggleDroid,
	apiModels,
	freshConversation,
	presets,
	preset,
	supervisor,
	supervisorEnabled,
	supervisorWindowOpen,
	supervisorDefaultStrategies,
	supervisorCustomStrategies,
	onArmSupervisor,
	onShowSupervisorWindow,
	onToggleNotifyRun,
	onOpenGoal,
	onStartModeling,
	onEndModeling,
	onDetachModeling,
	onSetPreset,
	onSend,
	onAbort,
}: {
	streaming: boolean;
	stats: SentinelStatsView | null;
	/** Average output speed of the latest run; null before any assistant usage is seen. */
	throughput: { tokPerSec: number; outputTokens: number; durationMs: number } | null;
	hasProject: boolean;
	/** The active project's id; null while none is selected. Uploads land in its work dir. */
	projectId: string | null;
	/** Set when the console cannot run anything: the input is locked until it clears. */
	blockedReason: string | null;
	/** Whether the run started from here reports to the notification channel. */
	notifyRun: boolean;
	/** Why a persistent goal cannot start right now; null means it can. */
	goalDisabledReason: string | null;
	/**
	 * The business-modeling run in force for this session; null means none. While
	 * it is set the button ends the run instead of starting one, because a session
	 * can only model one thing at a time.
	 */
	modeling: SentinelModelingState | null;
	/**
	 * The Droid plugin's toolset switch. Off is maximally clean: no device tools
	 * in the prompt, nothing in context.
	 */
	droidEnabled: boolean;
	onToggleDroid: (next: boolean) => void;
	/**
	 * The modeling records already attached to this conversation (带建模数据).
	 * While set, `api_model_read` is mounted and the picker shows them instead of
	 * the checklist, with a removal action.
	 */
	modelingAttached: ReadonlyArray<{ id: string; title: string }>;
	/**
	 * The modeling records of the active project, newest first. The picker offers
	 * these on a fresh conversation only.
	 */
	apiModels: readonly SentinelApiModelSummary[];
	/** True while the conversation has no messages yet: only then can records ride the first prompt. */
	freshConversation: boolean;
	/** The library, for the 预设 Agent picker; disabled entries are not offered. */
	presets: readonly SentinelPresetView[];
	/** The preset the viewed session runs under; null means the default agent. */
	preset: SentinelSessionPresetView | null;
	/** Supervision of this conversation; null until the operator arms it. */
	supervisor: SentinelSupervisorView | null;
	/** Global feature switch from 设置 → 模型. */
	supervisorEnabled: boolean;
	/** Whether the floating window is currently visible. */
	supervisorWindowOpen: boolean;
	/** Defaults chosen in 设置 → 模型; the operator can override them per conversation. */
	supervisorDefaultStrategies: SentinelSupervisorStrategyRef[];
	supervisorCustomStrategies: SentinelSupervisorCustomStrategy[];
	onArmSupervisor: (
		mode: SentinelSupervisorMode,
		delivery: "auto" | "confirm",
		strategies: SentinelSupervisorStrategyRef[],
		note: string,
	) => void;
	onShowSupervisorWindow: () => void;
	onToggleNotifyRun: () => void;
	onOpenGoal: () => void;
	onStartModeling: () => void;
	onEndModeling: () => void;
	onDetachModeling: () => void;
	/** Re-brief the viewed session; null drops back to the default agent. */
	onSetPreset: (presetId: string | null) => void;
	onSend: (
		text: string,
		behavior?: "steer" | "followUp",
		images?: SentinelImageAttachment[],
		attachModelIds?: string[],
	) => void;
	onAbort: () => void;
}) {
	const [text, setText] = useState("");
	const [behavior, setBehavior] = useState<"steer" | "followUp">("steer");
	const [images, setImages] = useState<SentinelImageAttachment[]>([]);
	/** The 预设 Agent picker, anchored under its button. */
	const [presetMenu, setPresetMenu] = useState<PresetMenuAnchor | null>(null);
	/** The 带建模数据 picker and what it has checked, applied to the next send. */
	const [modelingMenu, setModelingMenu] = useState<PresetMenuAnchor | null>(null);
	const [supervisorMenu, setSupervisorMenu] = useState<PresetMenuAnchor | null>(null);
	const [supervisorStrategies, setSupervisorStrategies] = useState<SentinelSupervisorStrategyRef[]>(() =>
		initialSupervisorStrategies(supervisorDefaultStrategies),
	);
	const supervisorDefaultStrategyKey = supervisorDefaultStrategies.map(supervisorStrategyKey).join("|");
	const [supervisorStrategyTouched, setSupervisorStrategyTouched] = useState(false);
	const [supervisorNote, setSupervisorNote] = useState("");
	const [supervisorLaunchMode, setSupervisorLaunchMode] = useState<SupervisorLaunchMode>("observe");
	useEffect(() => {
		if (supervisorStrategyTouched) return;
		setSupervisorStrategies(initialSupervisorStrategies(supervisorDefaultStrategies));
	}, [supervisorDefaultStrategyKey, supervisorStrategyTouched]);
	const [attachSelection, setAttachSelection] = useState<string[]>([]);
	/** Files already uploaded to the project (or being uploaded, or refused). */
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const [dragging, setDragging] = useState(false);
	/** Why the last send was refused; cleared as soon as the composer changes. */
	const [sendNotice, setSendNotice] = useState<string | null>(null);
	/** The 图片 picker and the 附件 picker: images are inlined, files are uploaded. */
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	const submit = (override?: "steer" | "followUp") => {
		const trimmed = text.trim();
		const ready = attachments.flatMap((item) => (item.uploaded ? [item.uploaded] : []));
		const uploading = attachments.some((item) => !item.uploaded && !item.error);
		if (blocked || uploading) return;
		if (!trimmed && images.length === 0 && ready.length === 0) return;
		// An upload is written into whichever project was active when it finished,
		// and only that project's directory is mounted into the container: a path
		// from another project is a reference the agent cannot follow, so the
		// message is refused instead of sent with a dead path in it.
		const stale = staleUploads(ready, projectId);
		if (stale.length > 0) {
			setSendNotice(
				t("这些文件属于另一个项目，请移除后重新上传：{names}", {
					names: stale.map((file) => file.name).join("、"),
				}),
			);
			return;
		}
		// One-shot: the checked records ride this message only, then the picker's
		// checklist resets. Nothing checked means the message carries nothing extra.
		const attachModelIds = attachSelection.length > 0 ? attachSelection : undefined;
		const manifest = attachmentManifest(ready);
		onSend(
			manifest ? `${manifest}\n\n${trimmed}` : trimmed,
			streaming ? (override ?? behavior) : undefined,
			images.length > 0 ? images : undefined,
			attachModelIds,
		);
		setText("");
		setImages([]);
		setAttachSelection([]);
		setAttachments([]);
		setSendNotice(null);
	};

	const addImages = async (files: FileList | File[]) => {
		const next: SentinelImageAttachment[] = [];
		for (const file of Array.from(files)) {
			if (!file.type.startsWith("image/")) continue;
			const image = await readImage(file);
			if (image) next.push(image);
		}
		if (next.length > 0) setImages((prev) => [...prev, ...next]);
	};

	/**
	 * Take files from a drop, a paste or the image picker. Images keep riding the
	 * vision path; every other file is uploaded right away, so the chip can show
	 * real progress and sending only has to write the paths into the message.
	 */
	const addFiles = (files: FileList | File[]) => {
		const plans = planAttachments(Array.from(files), projectId);
		const images = plans.flatMap((plan) => (plan.kind === "image" ? [plan.file] : []));
		if (images.length > 0) void addImages(images);
		for (const plan of plans) {
			if (plan.kind === "image") continue;
			const entry: PendingAttachment = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				name: plan.file.name,
				size: plan.file.size,
				ratio: 0,
				error: plan.kind === "refused" ? plan.reason : null,
				uploaded: null,
			};
			setAttachments((prev) => [...prev, entry]);
			if (plan.kind === "refused") continue;
			setSendNotice(null);
			void uploadFile(plan.file, plan.projectId, (ratio) => {
				setAttachments((prev) => prev.map((item) => (item.id === entry.id ? { ...item, ratio } : item)));
			})
				.then((uploaded) => {
					setAttachments((prev) =>
						prev.map((item) => (item.id === entry.id ? { ...item, uploaded, ratio: 1 } : item)),
					);
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : t("上传失败");
					setAttachments((prev) => prev.map((item) => (item.id === entry.id ? { ...item, error: message } : item)));
				});
		}
	};

	const blocked = blockedReason !== null;
	const uploading = attachments.some((item) => !item.uploaded && !item.error);
	const readyCount = attachments.filter((item) => item.uploaded !== null).length;
	const canSend = !blocked && !uploading && (text.trim().length > 0 || images.length > 0 || readyCount > 0);

	return (
		<div className="composer-zone">
			{/* Files can be dropped anywhere on the box; the class is the only feedback
			    that the drop will be taken. */}
			<div
				className={`composer${dragging ? " composer-dragging" : ""}`}
				onDragOver={(event) => {
					if (!event.dataTransfer.types.includes("Files")) return;
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
				}}
				onDrop={(event) => {
					event.preventDefault();
					setDragging(false);
					if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
				}}
			>
				{/* Goal mode and the preset agent both sit above the input because they
				    change what the input means: one makes it an objective the agent
				    keeps working on, the other re-briefs who is reading it. */}
				<div className="composer-goal-row">
					{supervisorEnabled ? (
						<>
							<button
								type="button"
								className={`composer-tool supervisor-trigger ${supervisor ? "on" : ""}`}
								onClick={(event) => {
									if (supervisor) {
										onShowSupervisorWindow();
										return;
									}
									if (!freshConversation) return;
									setSupervisorMenu(presetMenuPosition(event.currentTarget.getBoundingClientRect(), 452, 470));
								}}
								disabled={!hasProject || blocked || (!freshConversation && !supervisor)}
								title={
									supervisor
										? supervisor.status === "stopped"
											? t("监督已停止；点击查看本次监督记录")
											: t("打开监督悬浮窗；收起窗口不会停止监督")
										: !freshConversation
											? t("监督只能在开始对话前开启")
											: t("开启监督：观察，或介入并选择自动发送 / 确认后发送")
								}
							>
								<SupervisorIcon />
								{supervisor
									? supervisor.status === "stopped"
										? t("监督已停止")
										: t("监督中")
									: t("监督")}
							</button>
							{supervisor && !supervisorWindowOpen ? (
								<button
									type="button"
									className="composer-tool supervisor-show"
									onClick={onShowSupervisorWindow}
									title={t("重新显示监督悬浮窗；监督仍在继续")}
								>
									{t("显示悬浮窗")}
								</button>
							) : null}
							{supervisorMenu ? (
								<SupervisorStartMenu
									anchor={supervisorMenu}
									mode={supervisorLaunchMode}
									strategies={supervisorStrategies}
									customStrategies={supervisorCustomStrategies}
									note={supervisorNote}
									onModeChange={setSupervisorLaunchMode}
									onToggleStrategy={(ref) => {
										setSupervisorStrategyTouched(true);
										setSupervisorStrategies((current) => {
											const key = supervisorStrategyKey(ref);
											const exists = current.some((entry) => supervisorStrategyKey(entry) === key);
											if (exists) {
												return current.length > 1
													? current.filter((entry) => supervisorStrategyKey(entry) !== key)
													: current;
											}
											return [...current, ref];
										});
									}}
									onNoteChange={setSupervisorNote}
									onClose={() => setSupervisorMenu(null)}
									onStart={() => {
										const mode = supervisorLaunchMode === "observe" ? "observe" : "intervene";
										const delivery = supervisorLaunchMode === "auto" ? "auto" : "confirm";
										if (supervisorStrategies.length === 0) return;
										onArmSupervisor(mode, delivery, supervisorStrategies, supervisorNote.trim());
										setSupervisorMenu(null);
										setSupervisorNote("");
										setSupervisorStrategyTouched(false);
									}}
								/>
							) : null}
						</>
					) : null}
					<button
						type="button"
						className={`composer-tool preset-trigger ${preset ? "on" : ""}`}
						onClick={(event) => {
							setPresetMenu(presetMenuPosition(event.currentTarget.getBoundingClientRect()));
						}}
						disabled={!hasProject || blocked || streaming}
						title={
							streaming
								? t("会话正在运行，先中止再换预设")
								: preset
									? t("当前预设：{name}{status}；点击更换，只影响之后的回合", {
											name: preset.name,
											status: preset.missing ? t("（已失效，正按默认 Agent 运行）") : "",
										})
									: t("给这个会话挂一个预设 Agent：换掉身份与背景，不影响可用工具和权限")
						}
					>
						<SubagentIcon />
						{t("预设 Agent")}
						{preset ? <span className="preset-trigger__name">{preset.name}</span> : null}
					</button>
					<button
						type="button"
						className="composer-tool goal-trigger"
						onClick={onOpenGoal}
						disabled={goalDisabledReason !== null}
						title={goalDisabledReason ?? t("启动持续目标：一轮结束后自动继续，直到达成目标或达到轮数上限")}
					>
						<TargetIcon />
						{t("持续目标")}
					</button>
					{/* Business modeling: one entry, two actions. 开始建模 runs the two-tool
					    cycle here (or ends the run in force); 关联建模数据 rides existing
					    records into a fresh conversation. Unchecked attach means nothing is
					    inserted — no message, no tool. */}
					<button
						type="button"
						className={`composer-tool modeling-trigger ${modeling || modelingAttached.length > 0 ? "on" : ""}`}
						onClick={(event) =>
							setModelingMenu(presetMenuPosition(event.currentTarget.getBoundingClientRect(), 300))
						}
						disabled={!hasProject || blocked}
						title={
							!hasProject
								? t("请先创建或选择一个项目")
								: blocked
									? (blockedReason ?? t("环境未就绪"))
									: modeling
										? t("正在业务建模：{title}；已提交 {paths} 路径 / {operations} 操作 / {entities} 实体", {
												title: modeling.title,
												paths: modeling.pathCount,
												operations: modeling.operationCount,
												entities: modeling.entityCount,
											})
										: t("业务建模：开始一次建模，或把已有建模数据关联给这条对话")
						}
					>
						<ApiModelIcon />
						{t("业务建模")}
						{modeling ? (
							<span className="modeling-trigger__count">{modeling.pathCount}</span>
						) : modelingAttached.length > 0 ? (
							<span className="modeling-trigger__count">{modelingAttached.length}</span>
						) : null}
					</button>
					{/* Android tools: an explicit opt-in for THIS conversation. Off is
					    the clean state — no device tools in the prompt, nothing in context. */}
					<button
						type="button"
						className={`composer-tool modeling-trigger ${droidEnabled ? "on" : ""}`}
						disabled={!hasProject}
						onClick={() => onToggleDroid(!droidEnabled)}
						title={
							!hasProject
								? t("请先创建或选择一个项目")
								: droidEnabled
									? t("当前对话已挂载安卓工具（droid_* / apk_*）。点击摘除；其他对话不受影响")
									: t("为当前对话挂载安卓工具（droid_* / apk_*）：需要先在「安卓设备」页配置反连与 token，并有一台设备在线")
						}
					>
						<DroidIcon />
						{t("安卓")}
						{droidEnabled ? <span className="modeling-trigger__count on">✓</span> : null}
					</button>
					{goalDisabledReason ? <span className="composer-goal-hint">{goalDisabledReason}</span> : null}
				</div>
				{presetMenu ? (
					<PresetMenu
						anchor={presetMenu}
						presets={presets}
						currentId={preset?.id ?? null}
						onPick={(presetId) => {
							setPresetMenu(null);
							onSetPreset(presetId ?? null);
						}}
						onClose={() => setPresetMenu(null)}
					/>
				) : null}
				{modelingMenu ? (
					<ModelingMenu
						anchor={modelingMenu}
						modeling={modeling}
						attached={modelingAttached}
						records={apiModels}
						selected={attachSelection}
						canAttach={freshConversation && apiModels.length > 0}
						canToggleRun={!streaming}
						onStart={onStartModeling}
						onEnd={onEndModeling}
						onToggle={(id) =>
							setAttachSelection((prev) =>
								prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
							)
						}
						onDetach={() => {
							setModelingMenu(null);
							onDetachModeling();
						}}
						onClose={() => setModelingMenu(null)}
					/>
				) : null}
				{images.length > 0 ? (
					<div className="attachment-strip">
						{images.map((image, index) => (
							<div key={index} className="attachment">
								<img
									src={`data:${image.mimeType};base64,${image.data}`}
									alt={t("附件 {index}", { index: index + 1 })}
								/>
								<button
									type="button"
									className="attachment-remove"
									title={t("移除该图片")}
									onClick={() => setImages((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}
								>
									×
								</button>
							</div>
						))}
						<span className="attachment-count">
							{t("{count} 张图片待发送", { count: images.length })}
						</span>
					</div>
				) : null}
				{attachments.length > 0 ? (
					<div className="attachment-strip">
						{attachments.map((item) => (
							<div
								key={item.id}
								className={`attachment-file ${item.error ? "bad" : ""}`}
								title={item.uploaded?.path ?? item.name}
							>
								<span className="attachment-file__name">{item.name}</span>
								<span className="attachment-file__meta">
									{item.error ??
										(item.uploaded
											? formatSize(item.uploaded.size)
											: t("上传中 {percent}%", { percent: Math.round(item.ratio * 100) }))}
								</span>
								<span className="attachment-file__bar">
									<span style={{ width: `${Math.round((item.uploaded ? 1 : item.ratio) * 100)}%` }} />
								</span>
								<button
									type="button"
									className="attachment-remove"
									title={
										item.uploaded
											? t("从待发送列表移除（文件仍在 uploads/ 里）")
											: t("移除")
									}
									onClick={() => setAttachments((prev) => prev.filter((entry) => entry.id !== item.id))}
								>
									×
								</button>
							</div>
						))}
						<span className="attachment-count">
							{uploading ? t("上传中…") : t("{count} 个文件待发送", { count: readyCount })}
						</span>
					</div>
				) : null}
				{sendNotice ? <div className="attachment-notice">{sendNotice}</div> : null}
				<textarea
					value={text}
					placeholder={
						blocked
							? blockedReason
							: hasProject
								? streaming
									? t("Agent 正在运行… 输入内容可插话或排队")
									: composerHint(preset)
								: t("请先在「项目」页创建或选择一个项目")
					}
					disabled={!hasProject || blocked}
					onChange={(event) => {
						setText(event.target.value);
						setSendNotice(null);
					}}
					onPaste={(event) => {
						// A pasted file (from the file manager) arrives in `files`, a pasted
						// screenshot as an image; both are taken here, plain text is left to
						// the textarea.
						const files = Array.from(event.clipboardData.files);
						if (files.length === 0) return;
						event.preventDefault();
						addFiles(files);
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
						onClick={() => imageInputRef.current?.click()}
						disabled={!hasProject || blocked}
						title={t("附加图片（也可直接粘贴截图）")}
					>
						<ImageIcon />
						{t("图片")}
					</button>
					<button
						type="button"
						className="composer-tool"
						onClick={() => fileInputRef.current?.click()}
						disabled={!hasProject || blocked}
						title={t("附加文件（任意类型；上传到项目工作目录，随消息把路径交给 Agent；也可直接拖入或粘贴）")}
					>
						<FilesIcon />
						{t("附件")}
					</button>
					<button
						type="button"
						className={`composer-tool ${notifyRun ? "on" : ""}`}
						onClick={onToggleNotifyRun}
						title={
							notifyRun
								? t("本次运行完成后发送通知（点击关闭）")
								: t("本次运行完成后不通知（点击开启）")
						}
					>
						<BellIcon />
						{t("通知")}
					</button>
					<input
						ref={imageInputRef}
						type="file"
						accept="image/*"
						multiple
						hidden
						onChange={(event) => {
							if (event.target.files) addFiles(event.target.files);
							event.target.value = "";
						}}
					/>
					{/* Any type: the plan decides whether a picked file is inlined (image)
					    or uploaded (everything else). */}
					<input
						ref={fileInputRef}
						type="file"
						multiple
						hidden
						onChange={(event) => {
							if (event.target.files) addFiles(event.target.files);
							event.target.value = "";
						}}
					/>
					<span className="composer-spacer" />
					{streaming ? (
						<>
							<label className="behavior">
								<input
									type="radio"
									name="behavior"
									checked={behavior === "steer"}
									onChange={() => setBehavior("steer")}
								/>
								{t("插话")}
							</label>
							<label className="behavior">
								<input
									type="radio"
									name="behavior"
									checked={behavior === "followUp"}
									onChange={() => setBehavior("followUp")}
								/>
								{t("排队")}
							</label>
							<button type="button" className="primary" onClick={() => submit()} disabled={!canSend}>
								{t("发送")}
							</button>
							<button type="button" className="danger" onClick={onAbort}>
								{t("中止")}
							</button>
						</>
					) : (
						<button
							type="button"
							className="primary"
							onClick={() => submit()}
							disabled={!canSend || !hasProject || blocked}
						>
							{t("发送 ⏎")}
						</button>
					)}
				</div>
			</div>
			<div className="status-line status-line--centered">
				<span title={t("按本轮每个 assistant 消息的 output tokens 与该消息耗时计算，不含工具执行时间")}>
					{blocked ? t("已锁定") : streaming ? t("运行中…") : t("空闲")}
					{stats
						? `${t(" · Token 输入 {input} / 输出 {output}", {
								input: formatTokens(stats.tokens.input),
								output: formatTokens(stats.tokens.output),
							})}${stats.cost > 0 ? t(" · 花费 {cost}", { cost: `$${stats.cost.toFixed(4)}` }) : ""}`
						: ""}
					{" · "}
					{throughput
						? `${t("本轮均速 {rate} tok/s", { rate: formatThroughput(throughput.tokPerSec) })}${
								streaming
									? t("（生成中）")
									: ` · ${formatTokens(throughput.outputTokens)} tokens / ${(throughput.durationMs / 1000).toFixed(1)}s`
							}`
						: streaming
							? t("本轮生成中…")
							: t("本轮 tok/s —")}
				</span>
			</div>
		</div>
	);
}
