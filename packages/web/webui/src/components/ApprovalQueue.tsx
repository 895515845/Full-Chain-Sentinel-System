import { useState } from "react";
import { t } from "../i18n.ts";
import type { SentinelApprovalRequest } from "../types.ts";

function commandPrefix(command: string): string {
	const trimmed = command.trim();
	const index = trimmed.search(/\s/);
	return index === -1 ? trimmed : trimmed.slice(0, index);
}

function ApprovalRow({
	request,
	onDecide,
}: {
	request: SentinelApprovalRequest;
	onDecide: (id: string, approved: boolean, command: string, alwaysAllowPrefix: boolean) => void;
}) {
	const [command, setCommand] = useState(request.command);
	const [alwaysAllow, setAlwaysAllow] = useState(false);
	const prefix = commandPrefix(command);
	const edited = command !== request.command;

	return (
		<div className="approval-row">
			<textarea
				className="command-editor"
				value={command}
				onChange={(event) => setCommand(event.target.value)}
				rows={Math.min(8, Math.max(2, command.split("\n").length + 1))}
				spellCheck={false}
			/>
			<div className="approval-row-meta">
				<span>
					{request.source && request.source !== "主代理" ? (
						<span className="source-badge">{approvalSource(request.source)}</span>
					) : null}
					{edited ? t("已修改（将按修改后执行）") : t("在 {cwd} 执行", { cwd: request.cwd })}
				</span>
				<label className="behavior">
					<input
						type="checkbox"
						checked={alwaysAllow}
						onChange={(event) => setAlwaysAllow(event.target.checked)}
					/>
					{t("本会话内自动放行")}
					{prefix ? t("「{prefix}」", { prefix }) : t("同类")}
					{t("开头的命令")}
				</label>
			</div>
			<div className="modal-actions">
				<button type="button" className="primary" onClick={() => onDecide(request.id, true, command, alwaysAllow)}>
					{t("批准执行")}
				</button>
				<button type="button" className="danger" onClick={() => onDecide(request.id, false, command, false)}>
					{t("拒绝")}
				</button>
			</div>
		</div>
	);
}

function approvalSource(source: string): string {
	if (source === "子代理") return t("子代理来源");
	const task = /^工程任务「(.+)」$/.exec(source);
	if (task) return t("工程任务「{name}」", { name: task[1] ?? "" });
	return source;
}

export function ApprovalQueue({
	requests,
	onDecide,
	onDecideAll,
}: {
	requests: SentinelApprovalRequest[];
	onDecide: (id: string, approved: boolean, command: string, alwaysAllowPrefix: boolean) => void;
	onDecideAll: (approved: boolean) => void;
}) {
	return (
		<div className="modal-backdrop">
			<div className="modal approval">
				<h2>
					{t("命令审批")}
					<span className="approval-count">{t("{count} 条待审", { count: requests.length })}</span>
				</h2>
				{requests.length > 1 ? (
					<div className="approval-bulk">
						<button type="button" className="primary" onClick={() => onDecideAll(true)}>
							{t("全部批准（按原命令）")}
						</button>
						<button type="button" className="danger" onClick={() => onDecideAll(false)}>
							{t("全部拒绝")}
						</button>
					</div>
				) : null}
				<div className="approval-list">
					{requests.map((request) => (
						<ApprovalRow key={request.id} request={request} onDecide={onDecide} />
					))}
				</div>
				<p className="modal-hint">
					{t("复合命令（含 &&、;、| 等）不会命中前缀白名单，始终需要人工审批。")}
				</p>
			</div>
		</div>
	);
}
