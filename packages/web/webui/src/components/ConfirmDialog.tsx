/**
 * A small centered confirmation dialog.
 *
 * Confirmations used to live inside the row (or inside the sidebar dropdown)
 * they belonged to, which forced a sentence, an input and several buttons into
 * a narrow strip of a table. A dialog gives each of those room, and it is the
 * same shape everywhere: a title that names the object, a short body, and the
 * decision in the footer.
 *
 * The footer is the caller's, because the decision is not always one button:
 * deleting a project is two buttons, each naming the scope it applies.
 */

import { useEffect, type ReactNode } from "react";
import { t } from "../i18n.ts";
import { CloseIcon } from "./icons.tsx";

export function ConfirmDialog({
	title,
	subtitle,
	className,
	footer,
	onCancel,
	children,
}: {
	title: string;
	className?: string;
	/** The object being acted on, so the dialog says what it is about. */
	subtitle?: ReactNode;
	/** The decision: one button for a plain confirmation, several for a choice. */
	footer: ReactNode;
	onCancel: () => void;
	children: ReactNode;
}) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onCancel();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onCancel]);

	return (
		<div className="modal-backdrop" onClick={onCancel}>
			<div
				className={className ? "modal confirm-dialog " + className : "modal confirm-dialog"}
				role="dialog"
				aria-modal="true"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="confirm-dialog__head">
					<div className="confirm-dialog__title">
						{title}
						{subtitle ? <span className="confirm-dialog__sub">{subtitle}</span> : null}
					</div>
					<button type="button" className="ghost small" title={t("关闭")} onClick={onCancel}>
						<CloseIcon />
					</button>
				</div>
				<div className="confirm-dialog__body">{children}</div>
				<div className="confirm-dialog__foot">
					<button type="button" onClick={onCancel}>
						{t("取消")}
					</button>
					{footer}
				</div>
			</div>
		</div>
	);
}
