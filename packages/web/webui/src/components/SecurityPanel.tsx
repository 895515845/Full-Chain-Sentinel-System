/**
 * 设置 → 安全: the console's administrator account.
 *
 * The password change goes straight over REST (it is about the HTTP session,
 * not about the agent conversation) and logs every other session out. Logout
 * lives in the sider footer; the server refuses tokens issued before it.
 */
import { type FormEvent, useState } from "react";
import { t } from "../i18n.ts";

export function SecurityPanel({ username }: { username: string | null }) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (busy) return;
		setSaved(false);
		if (next !== confirm) {
			setError(t("两次输入的新密码不一致"));
			return;
		}
		setBusy(true);
		setError("");
		try {
			const response = await fetch("/api/auth/change-password", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ current, next }),
			});
			const data = (await response.json().catch(() => ({}))) as { error?: unknown };
			if (!response.ok) {
				setError(typeof data.error === "string" ? data.error : t("修改失败"));
				return;
			}
			setCurrent("");
			setNext("");
			setConfirm("");
			setSaved(true);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="security-layout">
			<section className="settings settings-section-card">
				<h3 className="settings-section">{t("修改密码")}</h3>
				<p className="settings-hint">{t("至少 8 个字符。修改后其他已登录的会话（包括别的浏览器）会全部退出。")}</p>
				<form className="security-form" onSubmit={submit}>
					<label>
						{t("当前密码")}
						<input
							type="password"
							value={current}
							autoComplete="current-password"
							onChange={(event) => setCurrent(event.target.value)}
						/>
					</label>
					<label>
						{t("新密码")}
						<input
							type="password"
							value={next}
							autoComplete="new-password"
							onChange={(event) => setNext(event.target.value)}
						/>
					</label>
					<label>
						{t("确认新密码")}
						<input
							type="password"
							value={confirm}
							autoComplete="new-password"
							onChange={(event) => setConfirm(event.target.value)}
						/>
					</label>
					{error ? <p className="page-error">{error}</p> : null}
					{saved ? <p className="settings-hint ok-text">{t("密码已修改。")}</p> : null}
					<div className="security-form__actions">
						<button type="submit" className="primary" disabled={busy || !current || !next}>
							{busy ? t("保存中…") : t("修改密码")}
						</button>
					</div>
				</form>
			</section>
			<aside className="security-account">
				<span>{t("当前登录")}</span>
				<strong>{username ?? t("未知")}</strong>
				<p className="settings-hint">
					{t("当前登录：{user}。退出登录在侧栏底部；修改后其他已登录的会话（包括别的浏览器）会全部退出。", { user: username ?? t("未知") })}
				</p>
			</aside>
		</div>
	);
}
