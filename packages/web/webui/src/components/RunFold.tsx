import { t } from "../i18n.ts";
import { CaretDownIcon, CaretRightIcon } from "./icons.tsx";

/**
 * The single row that stands for one finished run's process. A recon run is
 * dozens of tool calls and several rounds of thinking; once it has settled, the
 * operator wants the answer, not the transcript of how it got there. Expanding
 * this row puts the whole process back, in order.
 */
export function RunFold({ digest, open, onToggle }: { digest: string; open: boolean; onToggle: () => void }) {
	return (
		<div
			className={`run-fold ${open ? "open" : ""}`}
			role="button"
			tabIndex={0}
			onClick={onToggle}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") onToggle();
			}}
		>
			<span className="run-fold-caret">{open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}</span>
			<span className="run-fold-label">{open ? t("收起过程") : t("过程")}</span>
			{digest ? <span className="run-fold-digest">{digest}</span> : null}
		</div>
	);
}
