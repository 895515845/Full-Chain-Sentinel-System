import { useCallback, useEffect, useRef, useState } from "react";

// Keep this breakpoint in sync with styles/workspace.css.
const COMPACT_NAVIGATION = "(max-width: 760px)";

export const DEFAULT_APP_KEYBINDINGS: Readonly<{ navigationDismiss: string | null }> = {
	navigationDismiss: "Escape",
};

/** Mobile disclosure state never changes the saved desktop sidebar preference. */
export function useNavigation(keybindings = DEFAULT_APP_KEYBINDINGS) {
	const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_NAVIGATION).matches);
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLElement>(null);
	const mobileOpen = compact && open;

	const close = useCallback(() => {
		setOpen(false);
		if (mobileOpen) triggerRef.current?.focus();
	}, [mobileOpen]);

	useEffect(() => {
		const media = window.matchMedia(COMPACT_NAVIGATION);
		let focusFrame: number | undefined;
		const sync = () => {
			const navigationHadFocus =
				panelRef.current?.contains(document.activeElement) || document.activeElement === triggerRef.current;
			setCompact(media.matches);
			setOpen(false);
			if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
			// Neither the drawer nor a mobile-only trigger may keep focus when hidden.
			if (navigationHadFocus) {
				focusFrame = window.requestAnimationFrame(() => {
					const target = media.matches
						? triggerRef.current
						: panelRef.current?.querySelector<HTMLButtonElement>(".sider-collapse");
					target?.focus();
				});
			}
		};
		media.addEventListener("change", sync);
		return () => {
			if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
			media.removeEventListener("change", sync);
		};
	}, []);

	useEffect(() => {
		if (!mobileOpen) return;
		// Wait for the CSS visibility change before moving focus into the drawer.
		const frame = window.requestAnimationFrame(() => {
			panelRef.current?.querySelector<HTMLButtonElement>(".sider-mobile-close")?.focus();
		});
		const dismiss = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing || event.key !== keybindings.navigationDismiss) return;
			// Let an independently portaled dialog handle its own dismissal.
			if (
				!(event.target instanceof Node) ||
				(!panelRef.current?.contains(event.target) && event.target !== triggerRef.current)
			) {
				return;
			}
			event.preventDefault();
			close();
		};
		window.addEventListener("keydown", dismiss);
		return () => {
			window.cancelAnimationFrame(frame);
			window.removeEventListener("keydown", dismiss);
		};
	}, [mobileOpen, close, keybindings.navigationDismiss]);

	return { compact, mobileOpen, triggerRef, panelRef, close, setOpen };
}
