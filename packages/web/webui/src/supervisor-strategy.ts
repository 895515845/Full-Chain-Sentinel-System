/** Operator-facing names and short descriptions for the supervision strategies. */

import type { SentinelSupervisorStrategy, SentinelSupervisorStrategyRef } from "./types.ts";

export interface SupervisorStrategyOption {
	id: SentinelSupervisorStrategy;
	label: string;
	hint: string;
}

export const SUPERVISOR_STRATEGY_OPTIONS: SupervisorStrategyOption[] = [
	{
		id: "steady",
		label: "稳健交付",
		hint: "先看授权边界和环境影响，建议以可复现、低影响步骤为主。",
	},
	{
		id: "validation",
		label: "漏洞验证",
		hint: "围绕已发现漏洞补 PoC、对照请求和最小影响证明，减少误报。",
	},
	{
		id: "offensive",
		label: "红队推进",
		hint: "关注攻击链下一跳、权限提升和横向，但不放宽安全规则。",
	},
	{
		id: "stealth",
		label: "低噪声",
		hint: "避免高频爆破、批量请求和明显扫描，优先被动信息与小样本验证。",
	},
	{
		id: "guarded",
		label: "不测危险接口",
		hint: "不碰会改配置/业务数据、任意用户密码重置、文件删除这类危险接口，只记录风险。",
	},
];

export const SUPERVISOR_STRATEGY_LABELS: Record<SentinelSupervisorStrategy, string> = {
	steady: "稳健交付",
	validation: "漏洞验证",
	offensive: "红队推进",
	stealth: "低噪声",
	guarded: "不测危险接口",
};

export function supervisorStrategyLabel(strategy: SentinelSupervisorStrategy): string {
	return SUPERVISOR_STRATEGY_LABELS[strategy];
}

/** Stable key for one preset/custom selection, used by multi-select UIs. */
export function supervisorStrategyKey(ref: SentinelSupervisorStrategyRef): string {
	return ref.customStrategyId ? `custom:${ref.customStrategyId}` : `preset:${ref.strategy}`;
}
