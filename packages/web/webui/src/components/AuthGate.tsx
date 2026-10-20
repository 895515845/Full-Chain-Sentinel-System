/**
 * The login screen.
 *
 * Shown instead of the console until the operator authenticates: on a fresh
 * install it is the account-creation form (setup), afterwards the login form.
 * The layout follows the reference: a dark brand panel on the left, the form on
 * the right. The left panel carries the animated skyline backdrop (see
 * LoginBackdrop) with the brand mark over it.
 */
import { type FormEvent, useState } from "react";

import {
	CONSOLE_VERSION,
	PROJECT_LICENSE,
	PROJECT_LICENSE_URL,
	PROJECT_NAME,
	PROJECT_REPOSITORY,
} from "../branding.ts";
import { GitHubIcon, SentinelMark } from "./icons.tsx";
import { LoginBackdrop } from "./LoginBackdrop.tsx";

export function AuthGate({ mode, onDone }: { mode: "setup" | "login"; onDone: () => void }) {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [remember, setRemember] = useState(true);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (busy) return;
		if (mode === "setup" && password !== confirm) {
			setError("两次输入的密码不一致");
			return;
		}
		setBusy(true);
		setError("");
		try {
			const response = await fetch(`/api/auth/${mode}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: username.trim(), password, remember }),
			});
			const data = (await response.json().catch(() => ({}))) as { error?: unknown };
			if (!response.ok) {
				setError(typeof data.error === "string" ? data.error : "操作失败，请重试");
				return;
			}
			onDone();
		} catch {
			setError("无法连接服务，请确认服务在运行");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="auth">
			<div className="auth-visual">
				<LoginBackdrop />
				<div className="auth-brand">
					<span className="auth-brand-badge">
						<SentinelMark size={26} />
					</span>
					<span className="auth-brand-name">全链哨兵</span>
				</div>
				<div className="auth-tagline">授权渗透测试工作台</div>
			</div>
			<div className="auth-panel">
				<form className="auth-form" onSubmit={submit}>
					<h1>{mode === "setup" ? "创建管理员账号" : "登录到工作台"}</h1>
					<p className="auth-hint">
						{mode === "setup" ? "首次使用：设置管理员用户名与密码，之后用它登录。" : "输入你的凭据以继续。"}
					</p>
					<label className="auth-field">
						用户名
						<input
							value={username}
							autoComplete="username"
							autoFocus
							spellCheck={false}
							onChange={(event) => setUsername(event.target.value)}
						/>
					</label>
					<label className="auth-field">
						密码
						<input
							type="password"
							value={password}
							autoComplete={mode === "setup" ? "new-password" : "current-password"}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</label>
					{mode === "setup" ? (
						<label className="auth-field">
							确认密码
							<input
								type="password"
								value={confirm}
								autoComplete="new-password"
								onChange={(event) => setConfirm(event.target.value)}
							/>
						</label>
					) : null}
					{mode === "login" ? (
						<label className="auth-remember">
							<input
								type="checkbox"
								checked={remember}
								onChange={(event) => setRemember(event.target.checked)}
							/>
							记住登录 30 天
						</label>
					) : null}
					{error ? <div className="auth-error">{error}</div> : null}
					<button type="submit" className="auth-submit" disabled={busy || !username.trim() || !password}>
						{busy ? "请稍候…" : mode === "setup" ? "创建并登录" : "登录"}
					</button>
					<div className="auth-foot">
						<span>
							{PROJECT_NAME} · v{CONSOLE_VERSION}
						</span>
						<span className="auth-foot__links">
							<a href={PROJECT_REPOSITORY} target="_blank" rel="noreferrer">
								<GitHubIcon size={11} />
								GitHub
							</a>
							<a href={PROJECT_LICENSE_URL} target="_blank" rel="noreferrer">
								{PROJECT_LICENSE}
							</a>
						</span>
						<span className="auth-foot__note">密码只以哈希存在本机</span>
					</div>
				</form>
			</div>
		</div>
	);
}
