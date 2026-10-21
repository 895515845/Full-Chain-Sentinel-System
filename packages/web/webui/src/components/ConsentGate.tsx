/**
 * The first-visit authorization promise.
 *
 * Rendered instead of the console until the operator accepts the statement. The
 * text comes from the server (`/api/consent`), so the wording shown here is the
 * same wording that was hashed and stored; the client never carries its own copy
 * that could drift from what was agreed to.
 *
 * The promise is the only way forward: the button stays disabled until the
 * checkbox is ticked, and declining leaves the console closed. Acceptance is
 * recorded server-side, so this is a gate rather than a reminder.
 */
import { type ReactNode, useEffect, useState } from "react";

import { PROJECT_LICENSE, PROJECT_LICENSE_URL, PROJECT_REPOSITORY } from "../branding.ts";
import { t } from "../i18n.ts";
import { ExternalLinkIcon, SentinelMark } from "./icons.tsx";
import { LanguageSwitch } from "./LanguageSwitch.tsx";

interface ConsentClause {
	title: string;
	body: string;
}

interface ConsentText {
	title: string;
	subtitle: string;
	intro: string;
	clauses: ConsentClause[];
	illegal: string;
	aiTitle: string;
	ai: string[];
	promise: string;
	ack: string;
	footnote: string;
}

/**
 * `**emphasis**` becomes `<strong>`. The statement is data, not markup, so this
 * splits on the marker instead of injecting HTML.
 */
function emphasized(text: string): ReactNode[] {
	return text.split("**").map((part, index) => (index % 2 === 1 ? <strong key={index}>{part}</strong> : part));
}

export function ConsentGate({ onAccepted }: { onAccepted: () => void }) {
	const [text, setText] = useState<ConsentText | null>(null);
	const [checked, setChecked] = useState(false);
	const [busy, setBusy] = useState(false);
	const [rejected, setRejected] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			try {
				const response = await fetch("/api/consent");
				const data = (await response.json().catch(() => ({}))) as { text?: ConsentText };
				if (cancelled) return;
				if (!response.ok || !data.text) {
					setError(t("无法读取承诺条款，请刷新页面重试"));
					return;
				}
				setText(data.text);
			} catch {
				if (!cancelled) setError(t("无法连接服务，请确认服务在运行"));
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, []);

	const accept = async () => {
		if (busy || !checked) return;
		setBusy(true);
		setError("");
		try {
			const response = await fetch("/api/consent/accept", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ accepted: true }),
			});
			if (!response.ok) {
				const data = (await response.json().catch(() => ({}))) as { error?: unknown };
				setError(typeof data.error === "string" ? data.error : t("记录承诺失败，请重试"));
				return;
			}
			onAccepted();
		} catch {
			setError(t("无法连接服务，请确认服务在运行"));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="consent">
			<LanguageSwitch className="consent-language" />
			<div className="consent-card">
				{rejected ? (
					<div className="consent-dead">
						<h3>{t("已拒绝，无法进入平台")}</h3>
						<p>{t("未勾选承诺时平台不提供任何功能。关闭页面即可；如果改变主意，可以重新阅读并接受。")}</p>
						<button type="button" className="consent-reject" onClick={() => setRejected(false)}>
							{t("重新阅读并接受")}
						</button>
					</div>
				) : (
					<>
						<div className="consent-head">
							<span className="consent-mark">
								<SentinelMark size={24} />
							</span>
							<div>
								<h2>{text?.title ?? t("授权与风险承诺")}</h2>
								<p>{text?.subtitle ?? t("首次使用前必须阅读并勾选承诺，否则无法进入平台")}</p>
							</div>
						</div>
						<div className="consent-body">
							{text ? (
								<>
									<p className="consent-lead">{emphasized(text.intro)}</p>
									<div className="consent-terms">
										<ol>
											{text.clauses.map((clause, index) => (
												<li key={clause.title}>
													<div className="consent-clause-title">
														<em>{String(index + 1).padStart(2, "0")}</em>
														{clause.title}
													</div>
													<p>{emphasized(clause.body)}</p>
												</li>
											))}
										</ol>
									</div>
									<div className="consent-illegal">
										<span className="consent-bang">!</span>
										<p>{emphasized(text.illegal)}</p>
									</div>
									<div className="consent-ai">
										<div className="consent-ai-head">
											<span className="consent-ai-tag">AI</span>
											{text.aiTitle}
										</div>
										<ul>
											{text.ai.map((line) => (
												<li key={line}>{emphasized(line)}</li>
											))}
										</ul>
									</div>
									<p className="consent-note">{text.footnote}</p>
									{/* Presentation, not part of the hashed promise: adding this line must not
									    invalidate an acceptance the operator already made. */}
									<p className="consent-source">
										{t("本项目以 {license} 许可开源", { license: PROJECT_LICENSE })}
										<span className="consent-source__sep">·</span>
										<a href={PROJECT_REPOSITORY} target="_blank" rel="noreferrer">
											{t("查看源码与许可证")}
											<ExternalLinkIcon size={10} />
										</a>
									</p>
								</>
							) : (
								<p className="consent-note">{error || t("正在读取承诺条款…")}</p>
							)}
							{error && text ? <div className="consent-error">{error}</div> : null}
						</div>
						<div className="consent-foot">
							<label className="consent-check">
								<input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
								<span className="consent-box">
									<svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
										<path d="M20 6 9 17l-5-5" />
									</svg>
								</span>
								<span className="consent-label">
									<b>{text?.promise ?? t("我承诺只用于授权合法的渗透测试")}</b>
									<span className="consent-ack">{text?.ack ?? ""}</span>
								</span>
							</label>
							<div className="consent-actions">
								<button
									type="button"
									className="consent-enter"
									disabled={!checked || busy || !text}
									onClick={() => void accept()}
								>
									{busy ? t("正在记录…") : t("进入平台")}
								</button>
								<button type="button" className="consent-reject" onClick={() => setRejected(true)}>
									{t("不同意，退出")}
								</button>
								<span className={checked ? "consent-hint ok" : "consent-hint"}>
									{checked ? t("已确认，可以进入平台") : t("请先勾选承诺，否则无法进入平台")}
								</span>
							</div>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
