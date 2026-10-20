import type {
	SentinelModelEntryView,
	SentinelModelRoleName,
	SentinelTestResult,
} from "../types.ts";

export const FOLLOW_MAIN = "follow-main";

export const ROLE_ORDER: SentinelModelRoleName[] = ["main", "judge", "reviewer", "supervisor"];

export const ROLE_LABELS: Record<SentinelModelRoleName, string> = {
	main: "主模型",
	judge: "守门模型",
	reviewer: "漏洞评审",
	supervisor: "监督模型",
};

export const ROLE_HINTS: Record<SentinelModelRoleName, string> = {
	main: "对话页的主代理；改完下次发送时生效，不打断正在跑的会话",
	judge: "AI 审批逐条判定 bash 命令；改完立即生效",
	reviewer: "提交漏洞后自动校准等级与 CVSS；改完立即生效",
	supervisor: "观察模式每 20 次调用或异常时总结；介入模式只给建议，不阻断工具调用",
};

export const ROLE_SHORT: Record<SentinelModelRoleName, string> = {
	main: "会话默认",
	judge: "命令定级",
	reviewer: "结论复核",
	supervisor: "介入判断",
};

export const MODEL_API_OPTIONS = [
	{ id: "openai-completions", label: "OpenAI Chat Completions" },
	{ id: "openai-responses", label: "OpenAI Responses" },
	{ id: "anthropic-messages", label: "Anthropic Messages" },
	{ id: "google-generative-ai", label: "Google Generative AI" },
] as const;

export function hostOf(baseUrl: string): string {
	return baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function capabilityChips(entry: SentinelModelEntryView, limit = 3): string[] {
	const chips: string[] = [];
	if (entry.contextWindow !== null) chips.push(`${Math.round(entry.contextWindow / 1000)}k 上下文`);
	if (entry.reasoning) chips.push("思考");
	if (entry.input.includes("image")) chips.push("图片");
	if (chips.length === 0) chips.push("pi 默认能力");
	return chips.slice(0, limit);
}

export interface ModelTestState {
	tone: "ok" | "bad" | "warn" | "idle";
	label: string;
}

export function testState(
	testing: boolean,
	result: SentinelTestResult | null | undefined,
): ModelTestState {
	if (testing) return { tone: "warn", label: "测试中…" };
	if (result === undefined) return { tone: "idle", label: "未测试" };
	if (result === null) return { tone: "bad", label: "无响应" };
	return result.ok ? { tone: "ok", label: "可用" } : { tone: "bad", label: "失败" };
}

/** Hover text for a status tag: the probe's summary plus its technical detail. */
export function testDetail(result: SentinelTestResult | null | undefined): string | undefined {
	if (!result) return undefined;
	return result.detail ? `${result.message}\n${result.detail}` : result.message;
}

export function ModelStatusTag({ state, detail }: { state: ModelTestState; detail?: string }) {
	return (
		<span className={`cockpit-tag is-${state.tone}`} title={detail}>
			<i className={`cockpit-dot is-${state.tone}`} />
			{state.label}
		</span>
	);
}

export function UsageTags({ roles }: { roles: SentinelModelRoleName[] }) {
	if (roles.length === 0) return <span className="cockpit-tag is-muted">未使用</span>;
	return (
		<>
			{roles.map((role) => (
				<span className={`cockpit-tag${role === "main" ? " is-accent" : ""}`} key={role}>
					{ROLE_LABELS[role]}
				</span>
			))}
		</>
	);
}
