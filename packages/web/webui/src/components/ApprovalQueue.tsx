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
	index,
	total,
	onDecide,
}: {
	request: SentinelApprovalRequest;
	index: number;
	total: number;
	onDecide: (id: string, approved: boolean, command: string, alwaysAllowPrefix: boolean) => void;
}) {
	const [command, setCommand] = useState(request.command);
	const [alwaysAllow, setAlwaysAllow] = useState(false);
	const prefix = commandPrefix(command);
	const edited = command !== request.command;

	return (
		<div className="approval-row">
			<div className="approval-row__head">
				<div>
					<strong>{t("请求 {index} / {total}", { index, total })}</strong>
					<span>{request.source ? approvalSource(request.source) : t("未知来源")}</span>
				</div>
				{edited ? <span className="approval-edited">{t("命令已修改")}</span> : null}
			</div>
			<label className="approval-command-label" htmlFor={`approval-command-${request.id}`}>
				{edited ? t("将要执行的命令（已编辑）") : t("将要执行的命令")}
			</label>
			<textarea
				id={`approval-command-${request.id}`}
				className="command-editor"
				value={command}
				onChange={(event) => setCommand(event.target.value)}
				rows={Math.min(8, Math.max(3, command.split("\n").length + 1))}
				spellCheck={false}
			/>
			<div className="approval-row-meta">
				<div className="approval-cwd">
					<span>{t("执行目录")}</span>
					<code title={request.cwd}>{request.cwd}</code>
				</div>
				<label className="behavior approval-auto-allow">
					<input
						type="checkbox"
						checked={alwaysAllow}
						onChange={(event) => setAlwaysAllow(event.target.checked)}
					/>
					<span>
						{t("本会话自动放行以此开头的命令")}
						<code>{prefix || t("空命令")}</code>
					</span>
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
		<div className="modal-backdrop approval-backdrop">
			<div className="modal approval approval-modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
				<h2 id="approval-title">
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
					{requests.map((request, index) => (
						<ApprovalRow
							key={request.id}
							request={request}
							index={index + 1}
							total={requests.length}
							onDecide={onDecide}
						/>
					))}
				</div>
				<p className="modal-hint">
					{t("复合命令（含 &&、;、| 等）不会命中前缀白名单，始终需要人工审批。")}
				</p>
			</div>
		</div>
	);
}
