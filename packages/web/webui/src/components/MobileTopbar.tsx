import type { Ref } from "react";
import { t } from "../i18n.ts";
import { MenuIcon, SentinelMark } from "./icons.tsx";

export function MobileTopbar({
	open,
	projectName,
	buttonRef,
	onToggle,
}: {
	open: boolean;
	projectName: string | null;
	buttonRef: Ref<HTMLButtonElement>;
	onToggle: () => void;
}) {
	return (
		<header className="mobile-topbar">
			<button
				type="button"
				className="mobile-nav-trigger"
				ref={buttonRef}
				aria-label={open ? t("收起侧边栏") : t("展开侧边栏")}
				aria-controls="app-navigation"
				aria-expanded={open}
				onClick={onToggle}
			>
				<MenuIcon size={20} />
			</button>
			<div className="mobile-topbar__brand">
				<SentinelMark size={20} />
				<span>{t("全链哨兵")}</span>
			</div>
			<span className="mobile-topbar__project" title={projectName ?? t("未选择项目")}>
				{projectName ?? t("未选择项目")}
			</span>
		</header>
	);
}
