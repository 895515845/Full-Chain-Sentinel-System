/**
 * The Android device page: the reverse-connection side of the Droid plugin.
 *
 * The operator's jobs here are three: create a token and type it into the
 * DroidBridge APK together with the console's address, watch devices come
 * online, and flip the toolset switch that mounts the droid and apk tools into
 * the agent's prompt. Everything else — what the agent does with a device —
 * happens in the conversation and lands in the audit trail like any command.
 */

import { useEffect, useState } from "react";
import type { DroidDevice, DroidToken, ZGClientMessage } from "../types.ts";

function formatTime(iso: string | null): string {
	if (!iso) return "—";
	return iso.slice(0, 19).replace("T", " ");
}

export function DroidPage({
	enabled,
	devices,
	tokens,
	listen,
	listenConfig,
	lanIps,
	consoleUrl,
	send,
}: {
	enabled: boolean;
	devices: DroidDevice[];
	tokens: DroidToken[];
	/** The dedicated reverse listener, when bound. */
	listen: { host: string; port: number } | null;
	/** What the operator picked; may differ from `listen` when binding failed. */
	listenConfig: { host: string; port: number } | null;
	/** Non-internal IPv4 addresses of the server, for the listen picker. */
	lanIps: string[];
	/** The address the browser itself uses; the fallback when no dedicated listener is bound. */
	consoleUrl: string;
	send(message: ZGClientMessage): void;
}) {
	const [label, setLabel] = useState("");
	const [revealed, setRevealed] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [listenHost, setListenHost] = useState<string>("");
	const [listenPort, setListenPort] = useState<string>("");

	// Keep the picker aligned with what the operator last chose.
	useEffect(() => {
		if (listenConfig && !listenHost) {
			setListenHost(listenConfig.host);
			setListenPort(String(listenConfig.port));
		}
	}, [listenConfig, listenHost]);

	/** The address the phone should dial: the dedicated listener when bound, the console origin otherwise. */
	const reverseAddress = (() => {
		if (listen) {
			// 0.0.0.0 is a bind address, not something a phone can dial: substitute
			// the machine's first LAN IPv4 and say so.
			const host = listen.host === "0.0.0.0" ? (lanIps[0] ?? "0.0.0.0") : listen.host;
			const note = listen.host === "0.0.0.0" && lanIps.length > 1 ? "（服务器多网卡，如不通请手改 IP）" : "";
			return { url: `ws://${host}:${listen.port}/ws/droid`, note };
		}
		return {
			url: consoleUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws/droid",
			note: "（未启用独立监听，随控制台地址）",
		};
	})();

	useEffect(() => {
		if (!loaded) {
			send({ type: "droid_state" });
			setLoaded(true);
		}
	}, [loaded, send]);

	const wsUrl = consoleUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws/droid";
	const active = tokens.filter((token) => !token.revokedAt);

	return (
		<div className="page-card">
			<div className="ws-panel__head">
				<div className="ws-panel__title">
					安卓设备
					<span className="ws-panel__sub">
						{enabled
							? `工具已启用 · ${devices.filter((device) => device.online).length}/${devices.length} 台在线`
							: "工具未启用"}
					</span>
				</div>
				<div className="ws-panel__actions">
					<label className="inline-label">
						<input
							type="checkbox"
							checked={enabled}
							onChange={(event) => send({ type: "droid_set_enabled", enabled: event.target.checked })}
						/>
						启用 Agent 安卓工具（droid_* / apk_*）
					</label>
					<button type="button" className="ghost small" onClick={() => send({ type: "droid_state" })}>
						刷新
					</button>
				</div>
			</div>
			<div className="ws-panel__body">
				<p className="ws-hint">
					在 root 测试机上安装自研的 DroidBridge APK，填入下面的反连地址与
					token；手机会主动反连本控制台（服务器不开放任何面向手机的端口）。 启用工具后，Agent
					在对话里即可执行设备命令、拉取文件、截屏、读 logcat，并对 APK 做静态分析。所有设备命令走与 bash
					相同的守门/审批链，审计可溯。
				</p>

				<h3 className="api-model-section">反连信息</h3>
				<div className="droid-kv">
					<div>
						<span className="droid-kv__k">APK 反连地址</span>
						<code className="droid-kv__v">{wsUrl}</code>
					</div>
					<div>
						<span className="droid-kv__k">token</span>
						<span className="droid-kv__v">
							{revealed ? (
								<code>{tokens.find((token) => token.id === revealed)?.token ?? "—"}</code>
							) : (
								<em>先在下方创建 token，创建后可在此复制</em>
							)}
						</span>
					</div>
				</div>

				<h3 className="api-model-section">
					监听
					{listen ? (
						<span className="api-model-chip api-model-chip--done">
							已监听 {listen.host}:{listen.port}
						</span>
					) : (
						<span className="api-model-chip api-model-chip--manual">未启用独立监听</span>
					)}
				</h3>
				<div className="droid-listen">
					<select
						className="inline-input"
						value={listenHost}
						onChange={(event) => setListenHost(event.target.value)}
					>
						<option value="0.0.0.0">0.0.0.0（所有网卡，局域网手机可连）</option>
						<option value="127.0.0.1">127.0.0.1（仅本机）</option>
						{lanIps.map((ip) => (
							<option key={ip} value={ip}>
								{ip}（网卡）
							</option>
						))}
					</select>
					<input
						className="inline-input"
						style={{ maxWidth: 110 }}
						value={listenPort}
						placeholder="端口"
						onChange={(event) => setListenPort(event.target.value.replace(/\D/g, ""))}
					/>
					<button
						type="button"
						className="primary"
						disabled={!listenHost || !listenPort}
						onClick={() => send({ type: "droid_set_listen", host: listenHost, port: Number(listenPort) })}
					>
						应用并监听
					</button>
				</div>

				<h3 className="api-model-section">连接令牌（{active.length} 个有效）</h3>
				<div className="droid-token-create">
					<input
						className="inline-input"
						placeholder="token 名称，例如 测试机-一加"
						value={label}
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
						创建 token
					</button>
				</div>
				{tokens.length === 0 ? (
					<div className="ws-empty">还没有创建 token。</div>
				) : (
					<table className="api-model-table">
						<thead>
							<tr>
								<th>名称</th>
								<th>token</th>
								<th>状态</th>
								<th>创建 / 最近使用</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{tokens.map((token) => (
								<tr key={token.id}>
									<td>{token.label}</td>
									<td className="api-model-target">
										<code>{revealed === token.id ? token.token : `${token.token.slice(0, 12)}…`}</code>
									</td>
									<td>
										{token.revokedAt ? (
											<span className="api-model-chip api-model-chip--failed">已吊销</span>
										) : (
											<span className="api-model-chip api-model-chip--done">有效</span>
										)}
									</td>
									<td>
										{formatTime(token.createdAt)} / {formatTime(token.lastUsedAt)}
									</td>
									<td>
										<button
											type="button"
											className="ghost small"
											onClick={() => setRevealed((prev) => (prev === token.id ? null : token.id))}
										>
											{revealed === token.id ? "隐藏" : "显示/复制"}
										</button>
										{!token.revokedAt ? (
											<button
												type="button"
												className="ghost small danger"
												onClick={() => send({ type: "droid_token_revoke", id: token.id })}
											>
												吊销
											</button>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}

				<h3 className="api-model-section">设备（{devices.filter((device) => device.online).length} 台在线）</h3>
				{devices.length === 0 ? (
					<div className="ws-empty">还没有设备注册过。安装 DroidBridge 并填入上面的地址与 token。</div>
				) : (
					<table className="api-model-table api-model-list">
						<thead>
							<tr>
								<th>名称</th>
								<th>状态</th>
								<th>机型 / 系统</th>
								<th>root</th>
								<th>最近在线</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{devices.map((device) => (
								<tr key={device.id}>
									<td className="api-model-name">
										{renaming?.id === device.id ? (
											<span className="droid-rename">
												<input
													className="inline-input"
													value={renaming.name}
													onChange={(event) => setRenaming({ id: device.id, name: event.target.value })}
												/>
												<button
													type="button"
													className="ghost small"
													onClick={() => {
														send({ type: "droid_device_rename", id: device.id, name: renaming.name });
														setRenaming(null);
													}}
												>
													保存
												</button>
											</span>
										) : (
											device.name
										)}
									</td>
									<td>
										<span
											className={`api-model-chip ${device.online ? "api-model-chip--done" : "api-model-chip--manual"}`}
										>
											{device.online ? "在线" : "离线"}
										</span>
									</td>
									<td>
										{device.model} · Android {device.androidVersion}
									</td>
									<td>{device.rooted ? "已 root" : "未 root"}</td>
									<td>{formatTime(device.lastSeen)}</td>
									<td>
										<button
											type="button"
											className="ghost small"
											onClick={() => setRenaming({ id: device.id, name: device.name })}
										>
											重命名
										</button>
										<button
											type="button"
											className="ghost small danger"
											onClick={() => send({ type: "droid_device_remove", id: device.id })}
										>
											移除
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</div>
	);
}
