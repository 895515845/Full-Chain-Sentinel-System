/**
 * The Android device page (左右分栏).
 *
 * Left column owns the service: the reverse listener (bind address/port, picked
 * by the operator) and the connection tokens. Right column owns the devices and
 * the onboarding steps. The Agent toolset switch deliberately does NOT live
 * here — it sits in the conversation, where the tools are actually used, and
 * stays off (no prompt, no tools) until explicitly enabled there.
 */

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { DroidDevice, DroidToken, ZGClientMessage } from "../types.ts";

function formatTime(iso: string | null): string {
	if (!iso) return "—";
	return iso.slice(0, 19).replace("T", " ");
}

export function DroidPage({
	connected,
	devices,
	tokens,
	listen,
	listenConfig,
	lanIps,
	consoleUrl,
	send,
}: {
	/** Requests may only go out on an open socket; before that the list stays empty. */
	connected: boolean;
	devices: DroidDevice[];
	tokens: DroidToken[];
	listen: { host: string; port: number } | null;
	listenConfig: { host: string; port: number } | null;
	lanIps: string[];
	consoleUrl: string;
	send(message: ZGClientMessage): void;
}) {
	const [label, setLabel] = useState("");
	const [revealed, setRevealed] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
	const [listenHost, setListenHost] = useState("0.0.0.0");
	const [listenPort, setListenPort] = useState("9944");
	const [qrToken, setQrToken] = useState<DroidToken | null>(null);

	useEffect(() => {
		if (listenConfig) {
			setListenHost(listenConfig.host);
			setListenPort(String(listenConfig.port));
		}
	}, [listenConfig]);

	// The server only pushes `droid_state` when something changes, so a page that
	// merely opens shows whatever the last broadcast happened to carry — after a
	// browser reload that is nothing, and the token list stays empty until the
	// operator creates a token. Pull the state on mount and on every reconnect
	// (`connected` flips false → true), which is what the list is built from.
	useEffect(() => {
		if (connected) send({ type: "droid_state" });
	}, [connected, send]);

	// The address the phone should dial: the dedicated listener when bound, the
	// console origin otherwise. 0.0.0.0 is a bind address, not dialable — show the
	// machine's first LAN IPv4 and say so.
	const reverseAddress = (() => {
		if (listen) {
			const host = listen.host === "0.0.0.0" ? (lanIps[0] ?? "0.0.0.0") : listen.host;
			const note = listen.host === "0.0.0.0" && lanIps.length > 1 ? "（多网卡，如不通请手改 IP）" : "";
			return { url: `ws://${host}:${listen.port}/ws/droid`, note };
		}
		return {
			url: consoleUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws/droid",
			note: "（未启用独立监听，随控制台地址）",
		};
	})();

	const onlineCount = devices.filter((device) => device.online).length;

	return (
		<div className="page-card droid-page">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					安卓设备
					<span className="ws-panel__sub">
						{devices.length > 0
							? `${onlineCount}/${devices.length} 台在线`
							: "DroidBridge 反连通道与设备管理"}
					</span>
				</div>
				<div className="ws-panel__actions">
					<button type="button" className="ghost small" onClick={() => send({ type: "droid_state" })}>
						刷新
					</button>
				</div>
			</div>

			<div className="droid-layout">
				{/* 左栏：反连服务 + 令牌 */}
				<div className="droid-col">
					<div className="droid-card">
						<h3 className="droid-card__title">
							反连服务
							{listen ? (
								<span className="api-model-chip api-model-chip--done">监听中 {listen.host}:{listen.port}</span>
							) : (
								<span className="api-model-chip api-model-chip--manual">未启用独立监听</span>
							)}
						</h3>
						<div className="droid-field">
							<label>监听地址</label>
							<select value={listenHost} onChange={(event) => setListenHost(event.target.value)}>
								<option value="0.0.0.0">0.0.0.0（所有网卡，局域网手机可连）</option>
								<option value="127.0.0.1">127.0.0.1（仅本机）</option>
								{lanIps.map((ip) => (
									<option key={ip} value={ip}>
										{ip}（网卡）
									</option>
								))}
							</select>
						</div>
						<div className="droid-field">
							<label>端口</label>
							<input
								value={listenPort}
								onChange={(event) => setListenPort(event.target.value.replace(/\D/g, ""))}
								placeholder="9944"
							/>
						</div>
						<button
							type="button"
							className="primary droid-block-btn"
							disabled={!listenHost || !listenPort}
							onClick={() => send({ type: "droid_set_listen", host: listenHost, port: Number(listenPort) })}
						>
							应用并重绑
						</button>
						<p className="droid-hint">独立于控制台端口，应用立即生效；0.0.0.0 表示局域网内手机都可反连（仍需 token）。</p>
					</div>

					<div className="droid-card">
						<h3 className="droid-card__title">
							连接令牌
							<span className="api-model-chip api-model-chip--manual">{tokens.length} 个</span>
						</h3>
						<div className="droid-field">
							<label>新建 token</label>
							<div className="droid-inline">
								<input
									value={label}
									placeholder="名称，例如 测试机-一加"
									onChange={(event) => setLabel(event.target.value)}
								/>
								<button
									type="button"
									className="primary"
									onClick={() => {
										if (!label.trim()) return;
										send({ type: "droid_token_create", label: label.trim() });
										setLabel("");
									}}
								>
									创建
								</button>
							</div>
						</div>
						{tokens.length === 0 ? (
							<p className="droid-hint">还没有 token。创建一个，填进手机上的 DroidBridge。</p>
						) : (
							<div className="droid-token-list">
								{tokens.map((token) => (
									<div key={token.id} className="droid-token">
										<div className="droid-token__main">
											<div className="droid-token__name">{token.label}</div>
											<div className="droid-token__val">
												{revealed === token.id ? token.token : `${token.token.slice(0, 16)}…`}
											</div>
											<div className="droid-token__meta">
												{`创建 ${formatTime(token.createdAt)} · 最近使用 ${formatTime(token.lastUsedAt)}`}
											</div>
										</div>
										<div className="droid-token__ops">
											<button
												type="button"
												className="ghost small"
												onClick={() => {
													const show = revealed !== token.id;
													setRevealed((prev) => (prev === token.id ? null : token.id));
													if (show) void navigator.clipboard?.writeText(token.token).catch(() => undefined);
												}}
											>
												{revealed === token.id ? "隐藏" : "显示/复制"}
											</button>
											<button type="button" className="ghost small" onClick={() => setQrToken(token)}>
												二维码
											</button>
											<button
												type="button"
												className="ghost small danger"
												onClick={() => send({ type: "droid_token_delete", id: token.id })}
											>
												删除
											</button>
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				</div>

				{/* 右栏：设备 + 接入指引 */}
				<div className="droid-col">
					<div className="droid-card">
						<h3 className="droid-card__title">
							设备
							<span className="api-model-chip api-model-chip--manual">
								{onlineCount} 在线 / {devices.length} 台
							</span>
						</h3>
						{devices.length === 0 ? (
							<p className="droid-hint">还没有设备注册过。按右侧指引安装 DroidBridge 并反连。</p>
						) : (
							<div className="droid-device-list">
								{devices.map((device) => (
									<div key={device.id} className={`droid-device ${device.online ? "" : "offline"}`}>
										<div className="droid-device__head">
											<span className={`droid-dot ${device.online ? "" : "off"}`} />
											<span className="droid-device__name">{device.name}</span>
											<span className="droid-device__model">{device.model}</span>
										</div>
										<div className="droid-device__facts">
											<span className="droid-tag">Android {device.androidVersion} (SDK {device.sdkInt})</span>
											{device.rooted ? <span className="droid-tag root">已 root</span> : <span className="droid-tag">未 root</span>}
											<span className="droid-tag">{device.online ? "在线" : `离线 · ${formatTime(device.lastSeen)}`}</span>
											<span className="droid-tag mono-tag">id {device.id.slice(0, 8)}</span>
										</div>
										<div className="droid-device__ops">
											{renaming?.id === device.id ? (
												<>
													<input
														value={renaming.name}
														onChange={(event) => setRenaming({ id: device.id, name: event.target.value })}
													/>
													<button
														type="button"
														onClick={() => {
															send({ type: "droid_device_rename", id: device.id, name: renaming.name });
															setRenaming(null);
														}}
													>
														保存
													</button>
													<button type="button" onClick={() => setRenaming(null)}>
														取消
													</button>
												</>
											) : (
												<>
													<button type="button" className="ghost small" onClick={() => setRenaming({ id: device.id, name: device.name })}>
														重命名
													</button>
													<button
														type="button"
														className="ghost small danger"
														onClick={() => send({ type: "droid_device_remove", id: device.id })}
													>
														移除
													</button>
												</>
											)}
										</div>
									</div>
								))}
							</div>
						)}
					</div>

					<div className="droid-card">
						<h3 className="droid-card__title">接入指引</h3>
						<ol className="droid-steps">
							<li>左侧创建一个 token；点该行「二维码」用手机扫，或点「显示/复制」手填。</li>
							<li>
								手机安装 DroidBridge（<code>packages/droid-apk</code> 构建产物），填入地址与 token：
								<div className="mono">{reverseAddress.url}</div>
							</li>
							<li>点「启动反连」，Magisk 弹窗点允许。</li>
							<li>设备出现在上方即接入成功；到对话页打开「安卓」开关，Agent 即可操控设备。</li>
						</ol>
					</div>
				</div>
			</div>
			{qrToken ? <TokenQrModal token={qrToken} address={reverseAddress.url} onClose={() => setQrToken(null)} /> : null}
		</div>
	);
}

/** 每个 token 一枚二维码：内容 = 反连地址 + 该 token，DroidBridge 扫码即填入。 */
function TokenQrModal({ token, address, onClose }: { token: DroidToken; address: string; onClose(): void }) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		QRCode.toCanvas(canvas, `${address}?token=${token.token}`, { width: 220, margin: 1, errorCorrectionLevel: "M" }).catch(
			() => undefined,
		);
	}, [address, token.token]);
	return (
		<div className="droid-qr-overlay" onClick={onClose}>
			<div className="droid-qr-modal" onClick={(event) => event.stopPropagation()}>
				<h3 className="droid-qr-modal__title">{token.label} 的接入二维码</h3>
				<canvas ref={canvasRef} className="droid-qr-modal__canvas" />
				<div className="droid-qr-modal__val">{`${address}?token=${token.token}`}</div>
				<p className="droid-hint">手机 DroidBridge 点「扫码填入」对准即可；点空白处关闭。</p>
			</div>
		</div>
	);
}
