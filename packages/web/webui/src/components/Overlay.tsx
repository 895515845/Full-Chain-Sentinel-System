/**
 * A wide console overlay.
 *
 * 文件 and 子代理 are not pages of their own any more: they open from the chat
 * page toolbar and cover it, so the operator keeps one place to work from. The
 * shell is the same panel pattern the pages use, only floating.
 */

import { CloseIcon } from "./icons.tsx";

export function Overlay({
	title,
	subtitle,
	actions,
	onClose,
	className,
	children,
}: {
	title: string;
	subtitle?: React.ReactNode;
	actions?: React.ReactNode;
	onClose: () => void;
	/** Extra class on the modal box, for panels that size themselves. */
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div
				className={className ? `modal modal--wide ${className}` : "modal modal--wide"}
				onClick={(event) => event.stopPropagation()}
			>
				<div className="ws-panel__head">
					<div className="ws-panel__title">
						{title}
						{subtitle ? <span className="ws-panel__sub">{subtitle}</span> : null}
					</div>
					<div className="ws-panel__actions">
						{actions}
						<button type="button" className="ghost small" title="关闭" onClick={onClose}>
							<CloseIcon />
						</button>
					</div>
				</div>
				<div className="modal__body">{children}</div>
			</div>
		</div>
	);
}
