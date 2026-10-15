/**
 * The business-modeling page: the OpenAPI documents the agent produced.
 *
 * Modeling happens inside an ordinary conversation — the operator presses 业务建模
 * in the composer, the agent gets two extra tools for the run, and the result
 * lands here. This page is read-only by construction: the document is the
 * agent's record of what it verified, so the operator inspects it, exports it,
 * or deletes it, but editing it here would blur "the model inferred this" and
 * "someone corrected it".
 *
 * The list is project-scoped like the vulnerability hub: a model belongs to the
 * scope it was produced in. One row opens a drill-down view: the document in an
 * embedded Swagger UI (the same reader the operator uses for any other API doc),
 * plus the business entities and relations and the audit trail — the two things
 * Swagger UI has no notion of.
 */

import { useEffect, useMemo, useState } from "react";
import swaggerUiCss from "swagger-ui-dist/swagger-ui.css?url";
import swaggerUiBundle from "swagger-ui-dist/swagger-ui-bundle.js?url";
import type { SentinelApiModel, SentinelApiModelEntity, SentinelApiModelEvent, SentinelApiModelStatus, SentinelApiModelSummary } from "../types.ts";
import { SENTINEL_API_MODEL_STATUS_LABELS } from "../types.ts";

const STATUS_FILTERS: { value: SentinelApiModelStatus | ""; label: string }[] = [
	{ value: "", label: "全部" },
	{ value: "modeling", label: "建模中" },
	{ value: "done", label: "已完成" },
	{ value: "manual", label: "人工结束" },
	{ value: "failed", label: "失败" },
];

/** The three panes of a drill-down. The document is the default: it is the deliverable. */
type DetailPane = "doc" | "entities" | "timeline";

const DETAIL_PANES: { value: DetailPane; label: string }[] = [
	{ value: "doc", label: "接口文档" },
	{ value: "entities", label: "业务实体" },
	{ value: "timeline", label: "时间线" },
];

/**
 * One document as a standalone Swagger UI page.
 *
 * The spec is inlined rather than fetched: the page is served with the console's
 * own auth, and an iframe fetch would have to thread the session through. `<` is
 * escaped so a `</script>` inside a description or an example value cannot close
 * the inline script early. Try-it-out is removed, not just disabled: modeling is
 * read-and-restore, and a button that fires real requests at the target from the
 * console is the wrong default.
 */
function swaggerDocumentHtml(openapi: Record<string, unknown>): string {
	const spec = JSON.stringify(openapi).replace(/</g, "\\u003c");
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		`<link rel="stylesheet" href="${swaggerUiCss}">`,
		'</head><body><div id="swagger-ui"></div>',
		`<script src="${swaggerUiBundle}"></script>`,
		"<script>window.onload=function(){SwaggerUIBundle({",
		`spec:${spec},`,
		"dom_id:'#swagger-ui',docExpansion:'list',",
		"supportedSubmitMethods:[]});};</script></body></html>",
	].join("");
}

function formatTime(iso: string | null): string {
	if (!iso) return "—";
	return iso.slice(0, 19).replace("T", " ");
}

/** Human line for one audit entry. */
function eventLabel(event: SentinelApiModelEvent): string {
	switch (event.kind) {
		case "created":
			return "建模开始";
		case "submitted":
			return `提交（${event.pathCount ?? 0} 路径 / ${event.operationCount ?? 0} 操作）`;
		case "done":
			return "Agent 声明完成";
		case "manual":
			return "操作员结束";
		case "failed":
			return "失败";
	}
}

function StatusChip({ status }: { status: SentinelApiModelStatus }) {
	return <span className={`api-model-chip api-model-chip--${status}`}>{SENTINEL_API_MODEL_STATUS_LABELS[status]}</span>;
}

function EntityCard({ entity }: { entity: SentinelApiModelEntity }) {
	return (
		<div className="api-model-entity">
			<div className="api-model-entity__head">
				<strong>{entity.name}</strong>
				{entity.description ? <span className="api-model-entity__desc">{entity.description}</span> : null}
			</div>
			{entity.fields && entity.fields.length > 0 ? (
				<table className="api-model-fields">
					<thead>
						<tr>
							<th>字段</th>
							<th>类型</th>
							<th>说明</th>
						</tr>
					</thead>
					<tbody>
						{entity.fields.map((field) => (
							<tr key={field.name}>
								<td>{field.name}</td>
								<td>{field.type ?? "—"}</td>
								<td>{field.description ?? ""}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : null}
			{entity.relations && entity.relations.length > 0 ? (
				<div className="api-model-relations">
					{entity.relations.map((relation) => (
						<span key={`${relation.target}-${relation.kind ?? ""}`} className="api-model-relation">
							{relation.kind ? `${relation.kind} ` : ""}
							{relation.target}
							{relation.description ? `（${relation.description}）` : ""}
						</span>
					))}
				</div>
			) : null}
		</div>
	);
}

export function ApiModelPage({
	items,
	detail,
	events,
	projectName,
	hasProject,
	onRefresh,
	onOpen,
	onClose,
	onDelete,
	onEnd,
	onExport,
	onOpenSession,
}: {
	items: SentinelApiModelSummary[];
	/** The run whose drill-down is open; null shows the list. */
	detail: SentinelApiModel | null;
	events: SentinelApiModelEvent[];
	projectName: string | null;
	hasProject: boolean;
	onRefresh(): void;
	onOpen(id: string): void;
	onClose(): void;
	onDelete(id: string): void;
	/** Close a run that is still 建模中 (its session may be long gone). */
	onEnd(id: string): void;
	onExport(id: string, format: "json" | "yaml"): void;
	onOpenSession(path: string): void;
}) {
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState<SentinelApiModelStatus | "">("");
	const [pane, setPane] = useState<DetailPane>("doc");

	// Opening another record lands on its document, not on the pane the previous
	// record happened to be on.
	useEffect(() => setPane("doc"), [detail?.id]);

	const visible = useMemo(() => {
		const needle = search.trim().toLowerCase();
		return items.filter((item) => {
			if (status && item.status !== status) return false;
			if (!needle) return true;
			return item.title.toLowerCase().includes(needle) || item.target.toLowerCase().includes(needle);
		});
	}, [items, search, status]);

	if (!hasProject) {
		return (
			<div className="page-card">
				<div className="ws-panel__head">
					<div className="ws-panel__title">业务建模</div>
				</div>
				<div className="ws-panel__body">
					<div className="ws-empty">请先在侧栏顶部创建或选择一个项目：业务建模的成果按项目归档。</div>
				</div>
			</div>
		);
	}

	if (detail) {
		// The drill-down does not scroll as a page: the pane the operator is on owns
		// the scroll, so the document reads like any full-height API doc.
		return (
			<div className="page-card api-model-detail">
				<div className="ws-panel__head">
					<div className="ws-panel__title">
						业务建模
						<span className="ws-panel__sub">{detail.title}</span>
					</div>
					<div className="ws-panel__actions">
						<button type="button" className="ghost small" onClick={onClose}>
							返回列表
						</button>
						<button type="button" className="ghost small" onClick={() => onExport(detail.id, "json")}>
							导出 JSON
						</button>
						<button type="button" className="ghost small" onClick={() => onExport(detail.id, "yaml")}>
							导出 YAML
						</button>
						{detail.status === "modeling" ? (
							<button type="button" className="ghost small" onClick={() => onEnd(detail.id)}>
								标记已结束
							</button>
						) : null}
						<button
							type="button"
							className="ghost small danger"
							onClick={() => {
								onDelete(detail.id);
								onClose();
							}}
						>
							删除
						</button>
					</div>
				</div>
				<div className="api-model-meta">
					<StatusChip status={detail.status} />
					<span>
						目标 <b>{detail.target || "未记录目标"}</b>
					</span>
					<span>
						路径 <b>{detail.pathCount}</b>
					</span>
					<span>
						操作 <b>{detail.operationCount}</b>
					</span>
					<span>
						实体 <b>{detail.entities.length}</b>
					</span>
					<span>
						提交 <b>{detail.submissions}</b> 次
					</span>
					<span>开始 {formatTime(detail.createdAt)}</span>
					<span>更新 {formatTime(detail.updatedAt)}</span>
					{detail.sessionPath ? (
						<button
							type="button"
							className="link-button"
							onClick={() => onOpenSession(detail.sessionPath as string)}
						>
							打开发起它的会话
						</button>
					) : null}
					{detail.error ? <span className="api-model-error">{detail.error}</span> : null}
				</div>
				<div className="api-model-tabs">
					{DETAIL_PANES.map((entry) => {
						const count =
							entry.value === "entities"
								? detail.entities.length
								: entry.value === "timeline"
									? events.length
									: undefined;
						return (
							<button
								key={entry.value}
								type="button"
								className={pane === entry.value ? "on" : ""}
								onClick={() => setPane(entry.value)}
							>
								{entry.label}
								{count !== undefined ? <span className="n">{count}</span> : null}
							</button>
						);
					})}
				</div>
				<div className="api-model-stage">
					<div className={`api-model-pane ${pane === "doc" ? "on" : ""}`}>
						{detail.pathCount === 0 ? (
							<div className="ws-empty">文档里还没有接口：Agent 提交后这里就是 Swagger UI。</div>
						) : (
							<iframe
								className="api-model-doc"
								title={`Swagger UI · ${detail.title}`}
								sandbox="allow-scripts"
								srcDoc={swaggerDocumentHtml(detail.openapi)}
							/>
						)}
					</div>
					<div className={`api-model-pane ${pane === "entities" ? "on" : ""}`}>
						<div className="api-model-pane__pad">
							{detail.entities.length === 0 ? (
								<div className="ws-empty">这次建模没有整理业务实体。</div>
							) : (
								<div className="api-model-entities">
									{detail.entities.map((entity) => (
										<EntityCard key={entity.name} entity={entity} />
									))}
								</div>
							)}
						</div>
					</div>
					<div className={`api-model-pane ${pane === "timeline" ? "on" : ""}`}>
						<div className="api-model-pane__pad">
							<div className="api-model-timeline">
								{events.map((event, index) => (
									<div key={`${event.at}-${index}`} className="api-model-event">
										<span className="api-model-event__time">{formatTime(event.at)}</span>
										<span className="api-model-event__kind">{eventLabel(event)}</span>
										<span className="api-model-event__note">{event.note ?? ""}</span>
									</div>
								))}
							</div>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="page-card">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					业务建模
					<span className="ws-panel__sub">
						{projectName ? `${projectName} · 共 ${items.length} 份` : `共 ${items.length} 份`}
					</span>
				</div>
				<div className="ws-panel__actions">
					<input
						className="inline-input"
						placeholder="搜索名称或目标"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
					<select
						className="inline-input"
						value={status}
						onChange={(event) => setStatus(event.target.value as SentinelApiModelStatus | "")}
					>
						{STATUS_FILTERS.map((entry) => (
							<option key={entry.value} value={entry.value}>
								{entry.label}
							</option>
						))}
					</select>
					<button type="button" className="ghost small" onClick={onRefresh}>
						刷新
					</button>
				</div>
			</div>
			<div className="ws-panel__body">
				<p className="ws-hint">
					在对话页输入框上方点「业务建模」即可开始：Agent
					会在当前会话里临时拿到两个建模工具，把还原出来的接口与业务实体提交到这里。平时它看不到这两个工具。
				</p>
				{visible.length === 0 ? (
					<div className="ws-empty">
						{items.length === 0
							? "还没有业务建模记录。"
							: `没有符合当前筛选的记录（共 ${items.length} 份${search.trim() ? "，当前有关键字" : ""}）。`}
					</div>
				) : (
					<table className="api-model-table api-model-list">
						<thead>
							<tr>
								<th>名称</th>
								<th>状态</th>
								<th>目标</th>
								<th>接口</th>
								<th>实体</th>
								<th>时间</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{visible.map((item) => (
								<tr key={item.id}>
									<td className="api-model-name">{item.title}</td>
									<td>
										<StatusChip status={item.status} />
									</td>
									<td className="api-model-target">{item.target || "—"}</td>
									<td>
										{item.pathCount} 路径 / {item.operationCount} 操作
									</td>
									<td>{item.entityCount}</td>
									<td>{formatTime(item.createdAt)}</td>
									<td>
										<button type="button" className="ghost small" onClick={() => onOpen(item.id)}>
											查看
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}
