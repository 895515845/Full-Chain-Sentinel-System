/**
 * A language switch for the screens that render before the console socket
 * exists: login, first-run setup and the authorization promise. Inside the
 * console the sider owns the same choice through the WebSocket.
 */
import { useEffect } from "react";
import { getLanguage, storeLanguage, t } from "../i18n.ts";

export function LanguageSwitch({ className = "" }: { className?: string }) {
	// The server's choice is shared by every browser; the stored value is only a
	// cache. Reconcile before the operator signs in, while this page is the only
	// thing on screen.
	useEffect(() => {
		let cancelled = false;
		void fetch("/api/ui-language")
			.then((response) => (response.ok ? response.json() : null))
			.then((body: { language?: unknown } | null) => {
				if (cancelled || (body?.language !== "zh" && body?.language !== "en")) return;
				if (body.language === getLanguage()) return;
				storeLanguage(body.language);
				window.location.reload();
			})
			.catch(() => {
				// Offline or the endpoint is missing; the cached language still renders.
			});
		return () => {
			cancelled = true;
		};
	}, []);
	const language = getLanguage();
	const next = language === "zh" ? "en" : "zh";
	return (
		<button
			type="button"
			className={`public-language ${className}`.trim()}
			title={t("切换语言")}
			aria-label={t("切换语言")}
			onClick={() => {
				void fetch("/api/ui-language", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ language: next }),
				})
					.then((response) => {
						if (!response.ok) return;
						storeLanguage(next);
						window.location.reload();
					})
					.catch(() => {
						// The page still renders in the cached language; the next load retries.
					});
			}}
		>
			{language === "zh" ? "English" : "中文"}
		</button>
	);
}
