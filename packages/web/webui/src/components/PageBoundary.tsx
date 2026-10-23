/**
 * A boundary around the page area.
 *
 * A render error used to take the whole console down to a blank screen, which
 * says nothing about what broke. This keeps the shell (sidebar, connection
 * banner) alive and shows the error message with a way back, so a bad field in
 * one page's data costs that page and not the session.
 *
 * Only render errors are caught here: an error thrown in an event handler or a
 * promise still reaches the console, which is where it is useful.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n.ts";

export function PageErrorCard({
	message,
	onRetry,
	onHome,
}: {
	message: string;
	onRetry: () => void;
	onHome?: () => void;
}) {
	return (
		<div className="page-card page-error-card">
			<div className="ws-panel__head">
				<div className="ws-panel__title">{t("这个页面出错了")}</div>
			</div>
			<div className="ws-panel__body">
				<p className="confirm-note">
					{t("页面渲染时抛出了下面的错误。切到别的页面或点「重试」可以继续用；错误详情也会打印在浏览器控制台。")}
				</p>
				<pre className="page-error-card__detail">{message}</pre>
				<div className="page-error-card__actions">
					<button type="button" className="primary" onClick={onRetry}>
						{t("重试")}
					</button>
					{onHome ? (
						<button type="button" onClick={onHome}>
							{t("回到工作台")}
						</button>
					) : null}
				</div>
			</div>
		</div>
	);
}

export class PageBoundary extends Component<
	{ children: ReactNode; onHome?: () => void },
	{ message: string | null }
> {
	state: { message: string | null } = { message: null };

	/** React asks for the next state, so the fallback renders on the same pass. */
	static getDerivedStateFromError(error: unknown): { message: string } {
		return { message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
	}

	componentDidCatch(error: unknown, info: ErrorInfo): void {
		// Keep the stack for whoever opens the console; the card only shows the
		// message, because a stack is unreadable at that size.
		console.error("[page-error]", error, info.componentStack);
	}

	render(): ReactNode {
		if (this.state.message !== null) {
			return (
				<PageErrorCard
					message={this.state.message}
					onRetry={() => this.setState({ message: null })}
					onHome={
						this.props.onHome
							? () => {
									this.setState({ message: null });
									this.props.onHome?.();
								}
							: undefined
					}
				/>
			);
		}
		return this.props.children;
	}
}
