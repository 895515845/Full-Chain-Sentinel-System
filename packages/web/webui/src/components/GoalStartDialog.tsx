/**
 * The dialog that starts a persistent goal.
 *
 * Everything the driver needs to bound the run is asked for here, because none of
 * it can be changed later without starting over: the objective, the acceptance
 * criteria the completion has to answer one by one, and the round budget. The
 * budget defaults to three continuations, which is the operator's stated
 * preference: three automatic rounds, then stop and ask.
 */

import { useState } from "react";
import { t } from "../i18n.ts";
import { CloseIcon } from "./icons.tsx";

export const DEFAULT_GOAL_ROUNDS = 3;
const MAX_GOAL_ROUNDS = 99;

/** Acceptance criteria: one per line, numbering and duplicates dropped. */
function parseCriteria(text: string): string[] {
	const seen = new Set<string>();
	const criteria: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.replace(/^[-*\d.、)\s]+/, "").trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		criteria.push(trimmed);
	}
	return criteria.slice(0, 20);
}

export function GoalStartDialog({
	onClose,
	onStart,
}: {
	onClose: () => void;
	/** Hands the goal to the server; the dialog closes immediately, errors arrive as a toast. */
	onStart: (objective: string, criteria: string[], roundLimit: number) => void;
}) {
	const [objective, setObjective] = useState("");
	const [criteria, setCriteria] = useState("");
	const [rounds, setRounds] = useState(String(DEFAULT_GOAL_ROUNDS));

	const parsed = Number(rounds);
	const limit = Number.isFinite(parsed)
		? Math.min(MAX_GOAL_ROUNDS, Math.max(1, Math.round(parsed)))
		: DEFAULT_GOAL_ROUNDS;
	const canSubmit = objective.trim().length > 0;

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal goal-dialog" onClick={(event) => event.stopPropagation()}>
				<h2>
					{t("持续目标")}
					<button type="button" className="ghost small" style={{ float: "right" }} onClick={onClose}>
						<CloseIcon />
					</button>
				</h2>
				<p className="modal-hint">
					{t("一轮结束后自动继续，直到模型调用 goal_complete 证明达成目标，或达到轮数上限。只在自动模式下可用：")}{" "}
					{t("运行期间所有命令无人拦截直接执行。")}
				</p>

				<label className="goal-field">
					<span>{t("目标（必填）")}</span>
					<textarea
						value={objective}
						rows={4}
						placeholder={t("例如：对 10.10.10.5 完成全端口侦察，确认服务与版本，并把确认的问题提交到漏洞中枢")}
						onChange={(event) => setObjective(event.target.value)}
					/>
				</label>

				<label className="goal-field">
					<span>{t("验收标准（选填，一行一条；填了就必须在完成时逐条给出证据）")}</span>
					<textarea
						value={criteria}
						rows={3}
						placeholder={t("例如：\n开放端口已全部确认服务与版本\n发现的问题已提交漏洞中枢")}
						onChange={(event) => setCriteria(event.target.value)}
					/>
				</label>

				<label className="goal-field goal-field--inline">
					<span>{t("自动续跑轮数上限")}</span>
					<input
						type="number"
						min={1}
						max={MAX_GOAL_ROUNDS}
						value={rounds}
						onChange={(event) => setRounds(event.target.value)}
					/>
					<span className="goal-field__hint">
						{t("初始运行不计入；到上限后暂停，可在目标条上点「继续 +3 轮」。")}
					</span>
				</label>

				<div className="modal-actions">
					<button type="button" onClick={onClose}>
						{t("取消")}
					</button>
					<button
						type="button"
						className="primary"
						disabled={!canSubmit}
						onClick={() => {
							onStart(objective.trim(), parseCriteria(criteria), limit);
							onClose();
						}}
					>
						{t("提交并启动")}
					</button>
				</div>
			</div>
		</div>
	);
}
