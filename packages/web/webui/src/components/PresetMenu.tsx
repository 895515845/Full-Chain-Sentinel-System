/**
 * The preset picker.
 *
 * Two places open it: the sider's 对话 header and the composer's 预设 Agent
 * switch, so the markup and the anchoring live here rather than in either
 * caller. The sider clips its own overflow, so the menu is portaled to
 * document.body with fixed coordinates like the session hover card.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ZGPresetView } from "../types.ts";

/** Where the menu hangs: below the button, or above it when there is no room. */
export interface PresetMenuAnchor {
	left: number;
	/** Distance from the viewport top; set when the menu hangs below its button. */
	top?: number;
	/** Distance from the viewport bottom; set instead of `top` when it opens upward. */
	bottom?: number;
	/** Room left on the chosen side, so a long list scrolls instead of overflowing. */
	maxHeight: number;
}

/**
 * Anchor the menu to its button, nudged left like the sider's caret and kept
 * inside the viewport. The composer's switch sits near the bottom of the window,
 * where a fixed menu cannot be scrolled into view, so the menu flips upward when
 * the space below is too small.
 */
export function presetMenuPosition(rect: DOMRect, width = 232): PresetMenuAnchor {
	const left = Math.max(8, Math.min(rect.left - 6, window.innerWidth - width));
	const below = window.innerHeight - rect.bottom - 8;
	const above = rect.top - 8;
	if (below < 200 && above > below) {
		return { left, bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(120, Math.min(320, above)) };
	}
	return { left, top: rect.bottom + 4, maxHeight: Math.max(120, Math.min(320, below)) };
}

export function PresetMenu(props: {
	anchor: PresetMenuAnchor;
	presets: readonly ZGPresetView[];
	/**
	 * The preset the viewed session already runs under, marked in the list. Omitted
	 * by the 新建会话 picker, which has no current choice to point at.
	 */
	currentId?: string | null;
	/** Undefined means the default agent: a session with no preset at all. */
	onPick: (presetId?: string) => void;
	onClose: () => void;
}) {
	// Outside click or Escape dismisses; picking an entry closes through onPick.
	// Callers pass an inline arrow, so the listener reads it through a ref instead
	// of re-subscribing on every render.
	const onClose = useRef(props.onClose);
	useEffect(() => {
		onClose.current = props.onClose;
	});
	// The click that opened the menu is still bubbling when this mounts — React
	// flushes the update inside the click handler, before the event reaches window
	// — so a plain listener would dismiss the menu in the same gesture and a real
	// click would look like it did nothing. Ignore anything from before this mount.
	const mountedAt = useRef(performance.now());
	useEffect(() => {
		const close = (event: MouseEvent) => {
			if (event.timeStamp <= mountedAt.current) return;
			onClose.current();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose.current();
		};
		window.addEventListener("click", close);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("click", close);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, []);

	const enabled = props.presets.filter((preset) => preset.enabled);

	return createPortal(
		<div
			className="preset-menu"
			style={{
				top: props.anchor.top,
				bottom: props.anchor.bottom,
				left: props.anchor.left,
				maxHeight: props.anchor.maxHeight,
			}}
			onClick={(event) => event.stopPropagation()}
		>
			<div className="preset-menu-title">以哪个身份新建会话</div>
			<button
				type="button"
				className="preset-menu-item"
				title="不追加任何系统提示，使用默认 Agent"
				onClick={() => props.onPick()}
			>
				<span className="preset-menu-name">
					默认 Agent
					{props.currentId === null ? <span className="preset-menu-current">当前</span> : null}
				</span>
				<span className="preset-menu-desc">不追加任何身份设定</span>
			</button>
			{enabled.map((preset) => (
				<button
					key={preset.id}
					type="button"
					className="preset-menu-item"
					title={preset.description || undefined}
					onClick={() => props.onPick(preset.id)}
				>
					<span className="preset-menu-name">
						{preset.name}
						{props.currentId === preset.id ? <span className="preset-menu-current">当前</span> : null}
					</span>
					{preset.description ? <span className="preset-menu-desc">{preset.description}</span> : null}
				</button>
			))}
			{enabled.length === 0 ? (
				<div className="preset-menu-hint">
					还没有启用的预设 Agent。到「设置 → 预设 Agent」新建一个，回到这里就能选它开会话。
				</div>
			) : null}
		</div>,
		document.body,
	);
}
