/**
 * The first-visit authorization promise.
 *
 * The console hands an AI agent real attack capability: scanning, exploitation,
 * lateral movement, post-exploitation. Using that against a system its owner did
 * not authorize is a crime, so the operator has to read a statement and promise
 * to stay inside an authorization before the console becomes usable.
 *
 * Three properties matter here:
 *
 * - The statement is data, not markup scattered through the UI. One source, so
 *   the wording shown, the wording hashed, and the wording stored agree.
 * - Acceptance is recorded on the server, not in the browser. A localStorage flag
 *   would be a suggestion; the API and the WebSocket stay closed until the record
 *   exists (see server.ts).
 * - The record carries a hash of the statement and the account name. Editing the
 *   statement invalidates every record, so the next visit re-reads the new text
 *   instead of silently inheriting consent to older wording.
 *
 * The record is not a signature and the statement is not legal advice; it exists
 * so nobody reaches an attack surface without having read what that means.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ConsentClause {
	/** Short heading of the clause, shown in bold. */
	title: string;
	body: string;
}

export interface ConsentText {
	title: string;
	subtitle: string;
	intro: string;
	clauses: ConsentClause[];
	/** The standalone illegal-use warning, rendered as a red callout. */
	illegal: string;
	aiTitle: string;
	ai: string[];
	/** The checkbox label: the promise the operator makes. */
	promise: string;
	/** The fine print under the checkbox: what exactly is being acknowledged. */
	ack: string;
	footnote: string;
}

/**
 * Shape version of the statement. The text hash already re-prompts on any edit;
 * this is for a change the text alone would not express (for example dropping a
 * clause and renumbering the rest).
 */
export const CONSENT_VERSION = 1;

/**
 * Emphasis is marked with `**`, the way the statement is written by hand. The UI
 * turns the pairs into `<strong>`; nothing here is ever injected as HTML.
 */
export const CONSENT_TEXT: ConsentText = {
	title: "授权与风险承诺",
	subtitle: "首次使用前必须阅读并勾选承诺，否则无法进入平台",
	intro: "全链哨兵把**真实的攻击能力**交给 AI Agent：资产扫描、漏洞利用、横向移动、后渗透与凭据获取。这套能力只有在**你持有目标所有者书面授权**的前提下才可以使用。进入平台前，请读完下面的条款并作出承诺。",
	clauses: [
		{
			title: "只用于已获书面授权的渗透测试",
			body: "你必须持有目标系统所有者出具的书面授权：渗透测试合同、授权书、SOW 或公开的漏洞赏金项目规则。授权书写明的目标范围（域名、IP、网段、App 包名）、时间窗口、允许的手法与禁止事项就是你的边界；授权到期、目标变更、范围外的一跳，都需要新的授权。",
		},
		{
			title: "未授权渗透测试是违法行为",
			body: "未经授权对他人系统进行扫描、探测、入侵、干扰或数据获取，可能违反《中华人民共和国网络安全法》第二十七条，并可能构成《中华人民共和国刑法》第二百八十五条（非法侵入计算机信息系统罪）、第二百八十六条（破坏计算机信息系统罪）、第二百八十七条之二（帮助信息网络犯罪活动罪），以及《数据安全法》《个人信息保护法》下的责任。这类行为可能面临**刑事处罚**，不只是民事赔偿或行政处罚。",
		},
		{
			title: "平台不替你确认授权",
			body: "平台无法核实你手上的授权文件，也无法判断你输入的目标是否落在授权范围内。你在项目里填的每一个目标，平台都按「你已获得授权」处理。授权真实性、范围与有效期的判断责任，完全在使用者。",
		},
		{
			title: "范围外与第三方的连带影响由你负责",
			body: "自动化攻击可能触达授权范围之外的共享基础设施：CDN、云服务商、上游供应商、同一网段的其他业务。扫描与爆破产生的流量也可能被第三方安全设备记录并溯源。这些影响同样算在你头上。",
		},
		{
			title: "数据、凭据与证据的处置",
			body: "测试中获取的数据、凭据、个人信息与业务机密，必须按授权书与法律要求处理：限定用途、限定留存期、不得传播或交易。本平台会把会话、漏洞记录与抓包证据落在本机数据库，保管与销毁责任在使用者。",
		},
		{
			title: "违规使用的后果",
			body: "若你在未获授权的情况下使用本平台，平台作者不承担任何责任，并会在法律要求时配合调查、提供审计记录。你可以随时停止使用并删除本机数据。",
		},
	],
	illegal:
		"**未授权的渗透测试属于违法行为，可能构成刑事犯罪。** 扫描、探测、入侵、干扰他人系统，可能触犯《中华人民共和国网络安全法》第二十七条与《中华人民共和国刑法》第二百八十五条、第二百八十六条、第二百八十七条之二。",
	aiTitle: "AI 生成式风险提示：Agent 的攻击过程难以完全管控",
	ai: [
		"本平台由大模型驱动：模型会**自主**决定下一步做什么（打哪个端口、用哪个 POC、要不要横向）。动作由你的目标与提示词推导，但结果不完全可预测。",
		"因使用本平台对**业务系统、数据、第三方或使用者自身**造成的任何影响与损失，由使用者自行承担，平台作者不承担任何责任。建议在隔离环境或具备回滚方案的前提下操作。",
		"可能出现的后果包括：误伤生产环境或写坏数据；触发业务告警、风控封禁、账号锁定；产生真实攻击流量被第三方安全设备记录；对共享基础设施造成连带影响；短时间内消耗大量带宽或算力。",
		"平台提供命令守门、审批模式、命令编辑、目标白名单与审计日志等约束手段，但这些手段**不保证拦住所有动作**，也不能替代你对授权范围的判断。",
	],
	promise: "我承诺只用于授权合法的渗透测试",
	ack: "我已阅读并理解上述全部条款，特别是未授权渗透测试的法律后果，以及 AI Agent 自主攻击难以完全管控、影响业务时由我自行负责。",
	footnote: "接受后在本机记录承诺，之后不再重复提示。本提示不构成法律意见，具体以最新法律文本与你的授权文件为准。",
};

/**
 * The statement as plain text, in reading order. This is what gets hashed, so it
 * has to cover everything the operator is shown and agrees to.
 */
export function consentText(text: ConsentText = CONSENT_TEXT): string {
	const lines: string[] = [text.title, text.subtitle, "", text.intro, ""];
	for (const [index, clause] of text.clauses.entries()) {
		lines.push(`${index + 1}. ${clause.title}`, clause.body, "");
	}
	lines.push(text.illegal, "", text.aiTitle, ...text.ai.map((line) => `- ${line}`), "");
	lines.push(text.promise, text.ack, text.footnote);
	return lines.join("\n");
}

/** Short digest of the current statement; a stored record with a different one is stale. */
export function consentTextHash(): string {
	return createHash("sha256").update(`v${CONSENT_VERSION}\n${consentText()}`).digest("hex").slice(0, 16);
}

export interface ConsentRecord {
	version: 1;
	/** Digest of the statement that was accepted. */
	textHash: string;
	/** Account that accepted it. A different account re-reads the statement. */
	username: string;
	acceptedAt: string;
}

/** Path of the acceptance record, next to auth.json in the agent directory. */
export function consentFilePath(agentDir: string): string {
	return join(agentDir, "consent.json");
}

/** The stored acceptance, or null when missing, unreadable, or of another shape. */
export function readConsentRecord(agentDir: string): ConsentRecord | null {
	try {
		const raw = JSON.parse(readFileSync(consentFilePath(agentDir), "utf8")) as Partial<ConsentRecord>;
		if (raw.version !== 1 || typeof raw.textHash !== "string" || typeof raw.username !== "string") return null;
		return {
			version: 1,
			textHash: raw.textHash,
			username: raw.username,
			acceptedAt: typeof raw.acceptedAt === "string" ? raw.acceptedAt : "",
		};
	} catch {
		return null;
	}
}

/** Record that this account accepted this statement, at this moment. */
export function writeConsentRecord(agentDir: string, username: string, now = new Date()): ConsentRecord {
	const record: ConsentRecord = {
		version: 1,
		textHash: consentTextHash(),
		username,
		acceptedAt: now.toISOString(),
	};
	mkdirSync(dirname(consentFilePath(agentDir)), { recursive: true });
	writeFileSync(consentFilePath(agentDir), `${JSON.stringify(record, null, "\t")}\n`, { mode: 0o600 });
	return record;
}

export interface ConsentStatus {
	/** Whether the console must show the statement before it can be used. */
	required: boolean;
	/** When this account accepted the current statement, if it did. */
	acceptedAt: string | null;
	version: number;
}

/**
 * Whether the statement still has to be accepted. A record counts only when it
 * belongs to this account and matches the current wording; anything else (no
 * record, edited statement, renamed or recreated account) sends the operator
 * through the statement again.
 */
export function consentStatus(agentDir: string | undefined, username: string | null): ConsentStatus {
	const stale: ConsentStatus = { required: true, acceptedAt: null, version: CONSENT_VERSION };
	if (!agentDir || !username) return stale;
	const record = readConsentRecord(agentDir);
	if (!record || record.username !== username || record.textHash !== consentTextHash()) return stale;
	return { required: false, acceptedAt: record.acceptedAt || null, version: CONSENT_VERSION };
}

/**
 * Routes that stay reachable before the promise is made. The page itself and the
 * statement have to load, and the client learns the status from `/api/auth/session`;
 * everything else under `/api` and the WebSocket waits for the promise.
 */
export function isConsentExemptPath(pathname: string): boolean {
	return pathname === "/api/consent" || pathname === "/api/consent/accept" || pathname === "/api/auth/session";
}
