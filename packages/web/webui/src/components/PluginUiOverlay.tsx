import { useEffect, useMemo, useRef } from "react";
import type { SentinelPluginView } from "../types.ts";

/** Everything the iframe may know at handshake time. Keep it non-secret. */
export interface PluginUiContext {
	plugin: { id: string; name: string; version: string; author: string };
	host: { id: string; name: string };
	/** Active project name, or null when the console has no project selected. */
	project: string | null;
	tools: Array<{ name: string; description: string }>;
	/** Config keys that already have a value; secrets only appear here as keys. */
	configKeys: string[];
}

export interface PluginUiCallResult {
	ok: boolean;
	result?: unknown;
	error?: string;
}

/**
 * The plugin's own frontend in a sandboxed iframe.
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` is the whole security
 * model: the document gets an opaque origin, so it cannot read the console's
 * cookies, DOM, or storage, cannot submit a form to the console, and cannot
 * navigate the top window. Data comes only from the postMessage bridge, and the
 * bridge is checked against a nonce generated for this open.
 */
export function PluginUiOverlay({
	plugin,
	nonce,
	context,
	onCall,
	onClose,
}: {
	plugin: SentinelPluginView;
	nonce: string;
	context: PluginUiContext;
	onCall: (method: string, params: unknown) => Promise<PluginUiCallResult>;
	onClose: () => void;
}) {
	const frame = useRef<HTMLIFrameElement | null>(null);
	const callRef = useRef(onCall);
	callRef.current = onCall;

	const ui = plugin.manifest.ui;
	const src = useMemo(() => {
		const entry = ui?.entry ?? "/ui/index.html";
		const file = entry.split("/").filter(Boolean).pop() ?? "index.html";
		return `/plugin-ui/${encodeURIComponent(plugin.hostId)}/${encodeURIComponent(plugin.manifest.id)}/${encodeURIComponent(file)}#nonce=${encodeURIComponent(nonce)}`;
	}, [plugin.hostId, plugin.manifest.id, ui?.entry, nonce]);

	useEffect(() => {
		const onMessage = (event: MessageEvent): void => {
			const target = frame.current?.contentWindow;
			if (!target || event.source !== target) return;
			const data = event.data as
				| {
						kind?: unknown;
						protocol?: unknown;
						nonce?: unknown;
						id?: unknown;
						method?: unknown;
						params?: unknown;
				  }
				| null;
			if (!data || typeof data !== "object") return;

			if (data.kind === "sentinel-ui:hello") {
				// The origin is opaque ("null") by design, so the nonce, the protocol,
				// and the source window are the identity check.
				if (data.protocol !== 1 || data.nonce !== nonce) return;
				target.postMessage({ kind: "sentinel-ui:init", protocol: 1, context }, "*");
				return;
			}

			if (data.kind === "sentinel-ui:call") {
				const id = data.id;
				const method = typeof data.method === "string" ? data.method : "";
				if (!id || !method) return;
				void callRef
					.current(method, data.params)
					.then((answer) => {
						target.postMessage({ kind: "sentinel-ui:result", id, ...answer }, "*");
					})
					.catch((error: unknown) => {
						target.postMessage(
							{
								kind: "sentinel-ui:result",
								id,
								ok: false,
								error: error instanceof Error ? error.message : String(error),
							},
							"*",
						);
					});
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [context, nonce]);

	// Escape closes the overlay; the iframe cannot take it away from the operator.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	useEffect(() => {
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = previous;
		};
	}, []);

	return (
		<div className="plugin-ui-layer" role="dialog" aria-modal="true">
			<div className="plugin-ui-head">
				<div className="plugin-ui-id">
					<div className="plugin-ui-title">
						{ui?.title || plugin.manifest.name}
						<span className="plugin-ui-version mono">v{plugin.manifest.version}</span>
					</div>
					<div className="plugin-ui-sub">
						{plugin.manifest.id} · {plugin.hostName}
						{plugin.hostLocal ? "（本机）" : ""} · 第三方插件界面，不要在这里输入控制台密码
					</div>
				</div>
				<button type="button" className="plugin-ui-close" onClick={onClose}>
					关闭
				</button>
			</div>
			<iframe
				ref={frame}
				className="plugin-ui-frame"
				title={`${plugin.manifest.name} 界面`}
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				src={src}
			/>
		</div>
	);
}
