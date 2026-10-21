import { useEffect, useMemo, useRef, useState } from "react";
import { getLanguage, t } from "../i18n.ts";
import { formatSize } from "../transcript.ts";
import type { SentinelFileEntry, SentinelFilePreview } from "../types.ts";
import { DirIcon, FileIcon, ParentDirIcon } from "./icons.tsx";

/** Bytes of the container work directory the panel is currently showing. */
export interface FilePanelState {
	path: string;
	entries: SentinelFileEntry[];
	preview: SentinelFilePreview | null;
	/** True while a request for this panel is in flight. */
	busy: boolean;
}

function formatTime(seconds: number): string {
	if (!seconds) return "";
	return new Date(seconds * 1000).toLocaleString(getLanguage() === "zh" ? "zh-CN" : "en-US", { hour12: false });
}

/** Turn a base64 payload from the server into a browser download. */
export function saveDownload(path: string, base64: string, mimeType: string): void {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = path.split("/").pop() ?? "download";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

/** Read a picked file as base64 without its data-URL prefix. */
function readAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = String(reader.result ?? "");
			resolve(result.slice(result.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error ?? new Error(t("读取文件失败")));
		reader.readAsDataURL(file);
	});
}

function parentOf(path: string): string {
	if (path === "/work" || !path.startsWith("/work/")) return "/work";
	const trimmed = path.replace(/\/+$/, "");
	const index = trimmed.lastIndexOf("/");
	return index <= 0 ? "/work" : trimmed.slice(0, index);
}

function baseName(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function FilePanel({
	state,
	onOpen,
	onPreview,
	onSave,
	onUpload,
	onDelete,
	onRename,
	onMkdir,
	onDownload,
}: {
	state: FilePanelState;
	onOpen: (path: string) => void;
	onPreview: (path: string) => void;
	onSave: (path: string, text: string) => void;
	onUpload: (path: string, data: string) => void;
	onDelete: (path: string) => void;
	onRename: (from: string, to: string) => void;
	onMkdir: (path: string) => void;
	onDownload: (path: string) => void;
}) {
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [newDir, setNewDir] = useState<string | null>(null);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const uploadRef = useRef<HTMLInputElement | null>(null);

	// Leaving the directory (or reloading it) abandons an in-progress edit buffer.
	useEffect(() => {
		setEditing(null);
		setDraft("");
		setRenaming(null);
		setNewDir(null);
	}, [state.path]);

	const preview = state.preview;
	const previewIsText = preview?.kind === "text";
	const isEditing = previewIsText && editing === preview.path;
	const dirty = isEditing && draft !== (preview.text ?? "");

	const crumbs = useMemo(() => {
		const parts = state.path.split("/").filter(Boolean);
		const trail: { label: string; path: string }[] = [{ label: "work", path: "/work" }];
		let acc = "";
		for (const part of parts) {
			acc += `/${part}`;
			if (acc !== "/work") trail.push({ label: part, path: acc });
		}
		return trail;
	}, [state.path]);

	const startUpload = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		setUploadError(null);
		try {
			for (const file of Array.from(files)) {
				const data = await readAsBase64(file);
				onUpload(`${state.path}/${file.name}`, data);
			}
		} catch (error) {
			setUploadError(error instanceof Error ? error.message : String(error));
		} finally {
			if (uploadRef.current) uploadRef.current.value = "";
		}
	};

	return (
		<div className="file-panel">
			<div className="panel-toolbar">
				<button type="button" onClick={() => onOpen(parentOf(state.path))} disabled={state.path === "/work"}>
					<ParentDirIcon />
					{t("上级")}
				</button>
				<button type="button" onClick={() => onOpen(state.path)} disabled={state.busy}>
					{t("刷新")}
				</button>
				<button type="button" onClick={() => uploadRef.current?.click()}>
					{t("上传")}
				</button>
				<button type="button" onClick={() => setNewDir("")}>
					{t("新建目录")}
				</button>
				<input
					ref={uploadRef}
					type="file"
					multiple
					hidden
					onChange={(event) => void startUpload(event.target.files)}
				/>
			</div>

			<div className="file-crumbs">
				{crumbs.map((crumb, index) => (
					<span key={crumb.path}>
						{index > 0 ? <span className="crumb-sep">/</span> : null}
						<button type="button" className="crumb" onClick={() => onOpen(crumb.path)}>
							{crumb.label}
						</button>
					</span>
				))}
			</div>

			{uploadError ? <div className="file-error">{uploadError}</div> : null}

			{newDir !== null ? (
				<div className="file-inline-form">
					<input
						autoFocus
						value={newDir}
						placeholder={t("目录名")}
						onChange={(event) => setNewDir(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") setNewDir(null);
							if (event.key === "Enter" && newDir.trim()) {
								onMkdir(`${state.path}/${newDir.trim()}`);
								setNewDir(null);
							}
						}}
					/>
					<button
						type="button"
						className="primary"
						disabled={!newDir.trim()}
						onClick={() => {
							onMkdir(`${state.path}/${newDir.trim()}`);
							setNewDir(null);
						}}
					>
						{t("创建")}
					</button>
					<button type="button" onClick={() => setNewDir(null)}>
						{t("取消")}
					</button>
				</div>
			) : null}

			<div className="file-list">
				{state.entries.length === 0 ? <div className="file-empty">{t("空目录")}</div> : null}
				{state.entries.map((entry) => (
					<div key={entry.path} className={`file-row ${preview?.path === entry.path ? "active" : ""}`}>
						{renaming === entry.path ? (
							<>
								<input
									autoFocus
									className="file-rename"
									value={renameValue}
									onChange={(event) => setRenameValue(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Escape") setRenaming(null);
										if (event.key === "Enter" && renameValue.trim()) {
											onRename(entry.path, `${state.path}/${renameValue.trim()}`);
											setRenaming(null);
										}
									}}
								/>
								<button
									type="button"
									className="primary"
									disabled={!renameValue.trim()}
									onClick={() => {
										onRename(entry.path, `${state.path}/${renameValue.trim()}`);
										setRenaming(null);
									}}
								>
									{t("确定")}
								</button>
								<button type="button" onClick={() => setRenaming(null)}>
									{t("取消")}
								</button>
							</>
						) : (
							<>
								<button
									type="button"
									className="file-open"
									title={entry.path}
									onClick={() => (entry.type === "dir" ? onOpen(entry.path) : onPreview(entry.path))}
								>
									<span className="file-icon">{entry.type === "dir" ? <DirIcon /> : <FileIcon />}</span>
									<span className="file-name">{entry.name}</span>
									<span className="file-meta">
										{entry.type === "dir" ? t("目录") : formatSize(entry.size)} · {formatTime(entry.mtime)}
									</span>
								</button>
								<button
									type="button"
									className="file-action"
									title={t("重命名")}
									onClick={() => {
										setRenaming(entry.path);
										setRenameValue(entry.name);
									}}
								>
									{t("改名")}
								</button>
								<button
									type="button"
									className="file-action danger"
									title={t("删除（目录会连同内容一起删除）")}
									onClick={() => {
										if (
											window.confirm(
												t("确定删除 {name}？{suffix}", { name: entry.name, suffix: entry.type === "dir" ? t("目录内的文件会一并删除。") : "" }),
											)
										) {
											onDelete(entry.path);
										}
									}}
								>
									{t("删除")}
								</button>
							</>
						)}
					</div>
				))}
			</div>

			{preview ? (
				<div className="file-preview">
					<div className="file-preview-head">
						<span className="file-preview-name" title={preview.path}>
							{baseName(preview.path)}
						</span>
						<span className="file-meta">
							{preview.kind === "binary" ? t("二进制") : preview.kind === "image" ? t("图片") : t("文本")} ·{" "}
							{formatSize(preview.size)}
							{preview.truncated ? t(" · 已截断") : ""}
						</span>
						<button type="button" onClick={() => onDownload(preview.path)}>
							{t("下载")}
						</button>
						{previewIsText && !isEditing ? (
							<button
								type="button"
								onClick={() => {
									setEditing(preview.path);
									setDraft(preview.text ?? "");
								}}
							>
								{t("编辑")}
							</button>
						) : null}
						{isEditing ? (
							<>
								<button
									type="button"
									className="primary"
									disabled={!dirty}
									onClick={() => {
										onSave(preview.path, draft);
										setEditing(null);
									}}
								>
									{t("保存")}
								</button>
								<button
									type="button"
									onClick={() => {
										setEditing(null);
										setDraft("");
									}}
								>
									{t("取消")}
								</button>
							</>
						) : null}
					</div>
					{isEditing ? (
						<textarea
							className="file-editor"
							value={draft}
							spellCheck={false}
							onChange={(event) => setDraft(event.target.value)}
						/>
					) : preview.kind === "image" && preview.data ? (
						<img
							className="file-image"
							src={`data:${preview.mimeType};base64,${preview.data}`}
							alt={preview.path}
						/>
					) : preview.kind === "text" ? (
						<pre className="file-text">{preview.text}</pre>
					) : (
						<div className="file-empty">{t("二进制文件不提供预览，可下载后查看。")}</div>
					)}
				</div>
			) : (
				<div className="file-empty">{t("选择一个文件查看内容")}</div>
			)}
		</div>
	);
}
