import { useMemo, useState } from "react";
import { t } from "../i18n.ts";
import type { SessionTreeNodeView, SentinelForkPoint } from "../types.ts";
import { BranchIcon, CaretDownIcon, CaretRightIcon, CloseIcon } from "./icons.tsx";

interface PathEntry {
	id: string;
	label: string;
}

interface BranchOption {
	entryId: string;
	label: string;
	summary: string;
	messageCount: number;
	active: boolean;
}

interface ForkPoint {
	id: string;
	summary: string;
	timestamp: string;
	branches: BranchOption[];
}

/** Human summary of a tree entry. */
function entrySummary(node: SessionTreeNodeView): string {
	const message = node.entry.message;
	if (node.label) return node.label;
	if (message && Array.isArray(message.content)) {
		const text = (message.content as Array<{ type?: string; text?: string }>)
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (text) return text.slice(0, 40);
	}
	switch (node.entry.type) {
		case "compaction":
			return t("≡ 压缩点");
		case "branch_summary":
			return t("↩ 分支摘要");
		default:
			return node.entry.type;
	}
}

function countMessages(node: SessionTreeNodeView): number {
	const own = node.entry.type === "message" ? 1 : 0;
	return own + node.children.reduce((sum, child) => sum + countMessages(child), 0);
}

/** Root-to-leaf path as flat summaries; empty when no leaf is known. */
function findPath(tree: SessionTreeNodeView[], leafId: string | null): PathEntry[] {
	if (!leafId) return [];
	const path: PathEntry[] = [];
	const walk = (nodes: SessionTreeNodeView[]): boolean => {
		for (const node of nodes) {
			path.push({ id: node.entry.id, label: entrySummary(node) });
			if (node.entry.id === leafId) return true;
			if (walk(node.children)) return true;
			path.pop();
		}
		return false;
	};
	return walk(tree) ? path : [];
}

/** All branch points (nodes with 2+ children) with their branch options. */
function collectForks(tree: SessionTreeNodeView[], activeIds: Set<string>): ForkPoint[] {
	const forks: ForkPoint[] = [];
	const walk = (node: SessionTreeNodeView): void => {
		if (node.children.length > 1) {
			forks.push({
				id: node.entry.id,
				summary: entrySummary(node),
				timestamp: node.entry.timestamp,
				branches: node.children.map((child) => ({
					entryId: child.entry.id,
					label: child.label ?? "",
					summary: entrySummary(child),
					messageCount: countMessages(child),
					active: activeIds.has(child.entry.id),
				})),
			});
		}
		node.children.forEach(walk);
	};
	tree.forEach(walk);
	return forks;
}

export function BranchModal({
	tree,
	leafId,
	forkPoints,
	onNavigate,
	onRenameBranch,
	onClose,
}: {
	tree: SessionTreeNodeView[];
	leafId: string | null;
	forkPoints: SentinelForkPoint[];
	onNavigate: (entryId: string) => void;
	onRenameBranch: (entryId: string, label: string) => void;
	onClose: () => void;
}) {
	const [expandedFork, setExpandedFork] = useState<string | null>(null);
	const [editingBranch, setEditingBranch] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");

	const path = useMemo(() => findPath(tree, leafId), [tree, leafId]);
	const activeIds = useMemo(() => new Set(path.map((item) => item.id)), [path]);
	const forks = useMemo(() => collectForks(tree, activeIds), [tree, activeIds]);

	const jump = (entryId: string) => {
		if (entryId === leafId) return;
		onNavigate(entryId);
		onClose();
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal branch-modal" onClick={(event) => event.stopPropagation()}>
				<h2>
					{t("会话分支")}
					<button type="button" className="ghost small" style={{ float: "right" }} onClick={onClose}>
						<CloseIcon />
					</button>
				</h2>
				<p className="modal-hint">{t("点击分支立即跳转，原分支完整保留，可随时切回。")}</p>

				<div className="breadcrumb">
					{path.length === 0 ? (
						<span className="breadcrumb-empty">{t("暂无消息")}</span>
					) : (
						path.map((item, index) => (
							<span key={item.id} className="breadcrumb-crumb-wrap">
								{index > 0 ? <span className="breadcrumb-sep">›</span> : null}
								<button
									type="button"
									className={`breadcrumb-crumb ${index === path.length - 1 ? "now" : ""}`}
									onClick={() => jump(item.id)}
									disabled={index === path.length - 1}
									title={item.label}
								>
									{item.label.slice(0, 14) || "…"}
								</button>
							</span>
						))
					)}
				</div>

				<div className="branch-scroll">
					<div className="branch-section-title">{t("分叉点 · {count}", { count: forks.length })}</div>
					{forks.length === 0 ? (
						<div className="branch-empty">{t("还没有分叉。在历史消息上点「↩ 从此分叉」即可开新分支。")}</div>
					) : null}
					{forks.map((fork) => {
						const open = expandedFork === fork.id;
						return (
							<div key={fork.id} className="fork-block">
								<button
									type="button"
									className="fork-head"
									onClick={() => setExpandedFork(open ? null : fork.id)}
									title={fork.summary}
								>
									<span className={`caret ${open ? "open" : ""}`}>
										{open ? <CaretDownIcon /> : <CaretRightIcon />}
									</span>
									<span className="fork-summary">
										<BranchIcon size={12} /> {fork.summary.slice(0, 30)}
									</span>
									<span className="fork-count">{t("{count} 条分支", { count: fork.branches.length })}</span>
								</button>
								{open ? (
									<div className="fork-branches">
										{fork.branches.map((branch) => (
											<div key={branch.entryId} className={`branch-row ${branch.active ? "active" : ""}`}>
												<button
													type="button"
													className="branch-option"
													onClick={() => jump(branch.entryId)}
													disabled={branch.active}
													title={branch.summary}
												>
													<span className="branch-dot" />
													<span className="branch-name">
														{branch.label || branch.summary.slice(0, 26)}
													</span>
													<span className="branch-meta">{t("{count} 条", { count: branch.messageCount })}</span>
													{branch.active ? <span className="branch-now">{t("当前")}</span> : null}
												</button>
												{editingBranch === branch.entryId ? (
													<input
														className="branch-rename"
														value={editValue}
														onChange={(event) => setEditValue(event.target.value)}
														onKeyDown={(event) => {
															if (event.key === "Enter") {
																if (editValue.trim()) onRenameBranch(branch.entryId, editValue.trim());
																setEditingBranch(null);
															}
															if (event.key === "Escape") setEditingBranch(null);
														}}
														onBlur={() => setEditingBranch(null)}
														placeholder={t("分支名称")}
														spellCheck={false}
													/>
												) : (
													<button
														type="button"
														className="ghost small"
														title={t("命名分支")}
														onClick={() => {
															setEditingBranch(branch.entryId);
															setEditValue(branch.label);
														}}
													>
														✎
													</button>
												)}
											</div>
										))}
									</div>
								) : null}
							</div>
						);
					})}

					{forkPoints.length > 0 ? (
						<>
							<div className="branch-section-title" style={{ marginTop: 14 }}>
								{t("从历史消息分叉")}
							</div>
							{forkPoints
								.slice()
								.reverse()
								.slice(0, 8)
								.map((point) => (
									<button
										key={point.entryId}
										type="button"
										className="fork-item"
										onClick={() => jump(point.entryId)}
										title={point.text}
									>
										↩ {point.text.slice(0, 40) || t("(空)")}
									</button>
								))}
						</>
					) : null}
				</div>
			</div>
		</div>
	);
}
