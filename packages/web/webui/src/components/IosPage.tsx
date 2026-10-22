/**
 * The iOS device page.
 *
 * Same shape as the Android page: the left column owns the reverse listener
 * (bind address/port, applied at runtime) and the token list, the right column
 * owns the devices and the deployment steps. A device with no listener bound
 * dials the console origin; binding 0.0.0.0 gives the phone a LAN address even
 * when the console itself stays on loopback. The toolset switch stays in the
 * conversation, not here.
 */

import { useEffect, useState } from "react";
import { t } from "../i18n.ts";
import type { IosDevice, IosToken, SentinelClientMessage } from "../types.ts";

function formatTime(iso: string | null): string {
	if (!iso) return "—";
	return iso.slice(0, 19).replace("T", " ");
}

export function IosPage({
	connected,
	devices,
	tokens,
	listen,
	listenConfig,
	lanIps,
	certPin,
	consoleUrl,
	send,
}: {
	connected: boolean;
	devices: IosDevice[];
	tokens: IosToken[];
	listen: { host: string; port: number } | null;
	listenConfig: { host: string; port: number } | null;
	lanIps: string[];
	/** SHA-256 of the console leaf certificate, offered for wss pinning. */
	certPin: string | null;
	consoleUrl: string;
	send(message: SentinelClientMessage): void;
}) {
	const [label, setLabel] = useState("");
	const [revealed, setRevealed] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
	const [listenHost, setListenHost] = useState("0.0.0.0");
	const [listenPort, setListenPort] = useState("9945");
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (listenConfig) {
			setListenHost(listenConfig.host);
			setListenPort(String(listenConfig.port));
		}
	}, [listenConfig]);

	useEffect(() => {
		if (connected) send({ type: "ios_state" });
	}, [connected, send]);

	// The address the phone should dial: the dedicated listener when bound, the
	// console origin otherwise. 0.0.0.0 is a bind address, not dialable — show the
	// machine's first LAN IPv4 and say so.
	const reverseAddress = (() => {
		if (listen) {
			const host = listen.host === "0.0.0.0" ? (lanIps[0] ?? "0.0.0.0") : listen.host;
			const note = listen.host === "0.0.0.0" && lanIps.length > 1 ? t("（多网卡，如不通请手改 IP）") : "";
			return { url: `wss://${host}:${listen.port}/ws/ios`, note };
		}
		return {
			url: `${consoleUrl.replace(/^https:/, "wss:").replace(/^http:/, "wss:").replace(/\/$/, "")}/ws/ios`,
			note: t("（未启用独立监听，随控制台地址）"),
		};
	})();
	const reverseUrl = reverseAddress.url;
	const onlineCount = devices.filter((device) => device.online && !device.stale).length;
	const staleCount = devices.filter((device) => device.stale).length;

	return (
		<div className="page-card droid-page">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					{t("iOS 设备")}
					<span className="ws-panel__sub">
						{devices.length > 0
							? t("{online}/{total} 台在线", { online: onlineCount, total: devices.length })
							: t("SentinelBridge 反连通道与设备管理")}
					</span>
				</div>
				<div className="ws-panel__actions">
					<button type="button" className="ghost small" onClick={() => send({ type: "ios_state" })}>
						{t("刷新")}
					</button>
				</div>
			</div>

			<div className="ws-panel__body">
				<div className="droid-layout">
					{/* 左栏：反连地址 + 令牌 */}
					<div className="droid-col">
						<div className="droid-card">
							<h3 className="droid-card__title">
								{t("反连服务")}
								{listen ? (
									<span className="api-model-chip api-model-chip--done">
										{t("监听中 {host}:{port}", { host: listen.host, port: listen.port })}
									</span>
								) : (
									<span className="api-model-chip api-model-chip--manual">{t("未启用独立监听")}</span>
								)}
							</h3>
							<div className="droid-field">
								<label>{t("监听地址")}</label>
								<select value={listenHost} onChange={(event) => setListenHost(event.target.value)}>
									<option value="0.0.0.0">0.0.0.0{t("（所有网卡，局域网手机可连）")}</option>
									<option value="127.0.0.1">127.0.0.1{t("（仅本机）")}</option>
									{lanIps.map((ip) => (
										<option key={ip} value={ip}>
											{ip}
											{t("（网卡）")}
										</option>
									))}
								</select>
							</div>
							<div className="droid-field">
								<label>{t("端口")}</label>
								<input
									value={listenPort}
									onChange={(event) => setListenPort(event.target.value.replace(/\D/g, ""))}
									placeholder="9945"
								/>
							</div>
							<button
								type="button"
								className="primary droid-block-btn"
								disabled={!listenHost || !listenPort}
								onClick={() => send({ type: "ios_set_listen", host: listenHost, port: Number(listenPort) })}
							>
								{t("应用并重绑")}
							</button>
							<p className="droid-hint">
								{t("独立于控制台端口，应用立即生效；0.0.0.0 表示局域网内手机都可反连（仍需 token）。")}
							</p>
							<div className="mono droid-url">{reverseUrl}</div>
							<p className="droid-hint">
								{t("iOS 端主动连控制台，不需要在手机上开放端口；局域网内填这台机器的地址，跨网段用域名或内网穿透。")}
								{reverseAddress.note ? ` ${reverseAddress.note}` : ""}
							</p>
							<p className="droid-hint">
								{t("iOS 强制 wss；独立监听也使用控制台 TLS。把下面的 wss 地址和证书指纹填进设备 setup 页。")}
							</p>
							{certPin ? (
								<div className="droid-field">
									<label>{t("控制台证书 SHA-256（wss 自签时填进设备）")}</label>
									<div className="mono droid-url">{certPin}</div>
									<button
										type="button"
										className="ghost small"
										onClick={() => void navigator.clipboard?.writeText(certPin).catch(() => undefined)}
									>
										{t("复制")}
									</button>
								</div>
							) : null}
						</div>

						<div className="droid-card">
							<h3 className="droid-card__title">
								{t("连接令牌")}
								<span className="api-model-chip api-model-chip--manual">{t("{count} 个", { count: tokens.length })}</span>
							</h3>
							<div className="droid-field">
								<label>{t("新建 token")}</label>
								<div className="droid-inline">
									<input
										value={label}
										placeholder={t("名称，例如 测试机-iPhone 12")}
										onChange={(event) => setLabel(event.target.value)}
									/>
									<button
										type="button"
										className="primary"
										onClick={() => {
											if (!label.trim()) return;
											send({ type: "ios_token_create", label: label.trim() });
											setLabel("");
										}}
									>
										{t("创建")}
									</button>
								</div>
							</div>
							{tokens.length === 0 ? (
								<p className="droid-hint">{t("还没有 token。创建一个，然后复制到 iPhone setup 页。")}</p>
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
													{t("创建 {created} · 最近使用 {used}", {
														created: formatTime(token.createdAt),
														used: formatTime(token.lastUsedAt),
													})}
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
													{revealed === token.id ? t("隐藏") : t("显示/复制")}
												</button>
												<button
													type="button"
													className="ghost small danger"
													onClick={() => send({ type: "ios_token_delete", id: token.id })}
												>
													{t("删除")}
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
								{t("设备")}
								<span className="api-model-chip api-model-chip--manual">
									{t("{online} 在线 / {total} 台", { online: onlineCount, total: devices.length })}
								</span>
							</h3>
							{staleCount > 0 ? (
								<p className="droid-hint">
									{t("{count} 台设备 socket 还在但已停止响应：进程可能被 iOS 挂起，请在设备上重开 SentinelBridge。", {
										count: staleCount,
									})}
								</p>
							) : null}
							{devices.length === 0 ? (
								<p className="droid-hint">{t("还没有设备注册过。按下方指引安装 SentinelBridge 并反连。")}</p>
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
												<span className="droid-tag">
													iOS {device.osVersion}
													{device.build ? ` (${device.build})` : ""}
												</span>
												<span className="droid-tag">{device.arch}</span>
												<span className="droid-tag">
													{device.jailbreakName || t("未知越狱")} {device.jailbreakVersion} · {device.jailbreakForm}
												</span>
												{device.hasRoot ? (
													<span className="droid-tag root">{t("daemon 有 root")}</span>
												) : (
													<span className="droid-tag">{t("仅 App 权限")}</span>
												)}
												<span className="droid-tag">
													{device.stale
														? t("无响应 {seconds}s", { seconds: Math.round((device.idleMs ?? 0) / 1000) })
														: device.online
															? t("在线")
															: t("离线 · {time}", { time: formatTime(device.lastSeen) })}
												</span>
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
																send({ type: "ios_device_rename", id: device.id, name: renaming.name });
																setRenaming(null);
															}}
														>
															{t("保存")}
														</button>
														<button type="button" onClick={() => setRenaming(null)}>
															{t("取消")}
														</button>
													</>
												) : (
													<>
														<button type="button" className="ghost small" onClick={() => setRenaming({ id: device.id, name: device.name })}>
															{t("重命名")}
														</button>
														<button
															type="button"
															className="ghost small danger"
															onClick={() => send({ type: "ios_device_remove", id: device.id })}
														>
															{t("移除")}
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
							<h3 className="droid-card__title">{t("Sileo 安装")}</h3>
							<p className="droid-hint">
								{t("在 Sileo 添加源，安装 SentinelBridge；rootless/rootful 由设备架构自动选择。")}
							</p>
							<div className="mono droid-url">https://zgsfsec.github.io/sentinel-ios-repo/</div>
							<div className="droid-inline">
								<button
									type="button"
									className="ghost small"
									onClick={() =>
										void navigator.clipboard
											?.writeText("https://zgsfsec.github.io/sentinel-ios-repo/")
											.catch(() => undefined)
									}
								>
									{t("复制源地址")}
								</button>
							</div>
							<p className="droid-hint">
								{t("装完在 iPhone Safari 打开 http://127.0.0.1:9945/setup，填入控制台 wss 地址和左侧 token。")}
							</p>
							<p className="droid-hint">
								{t("没有 Sileo 源时用 SSH 回退：")}
							</p>
							<pre className="mono droid-url" style={{ whiteSpace: "pre-wrap" }}>{`packages/web/ios/scripts/install-ios.sh root@<设备IP> \\
  --url '${reverseUrl}' \\
  --token '${tokens[0]?.token ?? "<token>"}' \\\n  --pin '${certPin ?? "<fingerprint>"}'`}</pre>
							<button
								type="button"
								className="ghost small"
								onClick={() => {
									const command = `packages/web/ios/scripts/install-ios.sh root@<设备IP> --url '${reverseUrl}' --token '${tokens[0]?.token ?? "<token>"}' --pin '${certPin ?? "<fingerprint>"}'`;
									void navigator.clipboard?.writeText(command).then(
										() => {
											setCopied(true);
											window.setTimeout(() => setCopied(false), 1500);
										},
										() => undefined,
									);
								}}
							>
								{copied ? t("已复制") : t("复制命令")}
							</button>
						</div>

						<div className="droid-card">
							<h3 className="droid-card__title">{t("接入指引")}</h3>
							<ol className="droid-steps">
								<li>{t("设备需已越狱；Sileo 安装 deb，或用 install-ios.sh 通过 SSH 安装。")}</li>
								<li>{t("左侧创建 token，点显示/复制拿到 ios_... 值。")}</li>
								<li>
									{t("iPhone Safari 打开 http://127.0.0.1:9945/setup，填控制台 wss 地址和 token；点“检测证书”，确认指纹一致后配对。")}
								</li>
								<li>{t("设备出现在上方后，到对话页为当前对话打开「iOS」开关，Agent 才能使用 ios_* 工具。")}</li>
							</ol>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
