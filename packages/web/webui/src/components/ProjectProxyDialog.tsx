/**
 * One project's proxy choice.
 *
 * The choice is a pointer, not a configuration: a project either follows the
 * default on the 代理 page, turns the proxy off for itself, or names one of the
 * profiles. A profile backed by a subscription has many nodes, so the project can
 * also name the node it wants — that pin belongs to the project, not to the
 * profile, because the same subscription is often shared by projects that should
 * leave through different exits.
 *
 * Saving only records the choice. The container keeps the network it was created
 * with until it is rebuilt, which the dialog says outright rather than leaving the
 * operator to wonder why nothing changed.
 */

import { useState } from "react";
import { t } from "../i18n.ts";
import { AUTO_NODE_TAG, type SentinelProjectInfo, type SentinelProxyConfigView } from "../types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** A project's stored choice, as the dialog's three states. */
export type ProjectProxyChoice =
	| { kind: "inherit" }
	| { kind: "off" }
	| { kind: "proxy"; id: string; nodeTag?: string };

export function projectProxyChoice(project: SentinelProjectInfo): ProjectProxyChoice {
	if (project.proxyId === undefined) return { kind: "inherit" };
	if (project.proxyId === null) return { kind: "off" };
	return { kind: "proxy", id: project.proxyId, nodeTag: project.proxyNode };
}

/** The `proxyId` a choice stores: absent for inherit, null for off. */
export function projectProxyId(choice: ProjectProxyChoice): string | null | undefined {
	if (choice.kind === "inherit") return undefined;
	if (choice.kind === "off") return null;
	return choice.id;
}

/** The `proxyNode` a choice stores: absent follows the profile's own node. */
export function projectProxyNode(choice: ProjectProxyChoice): string | undefined {
	return choice.kind === "proxy" ? choice.nodeTag : undefined;
}

export function ProjectProxyDialog({
	project,
	config,
	busy,
	onConfirm,
	onCancel,
}: {
	project: SentinelProjectInfo;
	config: SentinelProxyConfigView;
	busy: boolean;
	onConfirm: (proxyId: string | null | undefined, proxyNode?: string) => void;
	onCancel: () => void;
}) {
	const [choice, setChoice] = useState<ProjectProxyChoice>(() => {
		const initial = projectProxyChoice(project);
		// A project that named a profile which has since been deleted follows the
		// default again, so the dialog shows what will actually happen.
		if (initial.kind === "proxy" && !config.proxies.some((entry) => entry.id === initial.id)) {
			return { kind: "inherit" };
		}
		return initial;
	});
	const list = Array.isArray(config?.proxies) ? config.proxies : [];
	const defaultName = list.find((entry) => entry.id === config?.defaultId)?.name;

	return (
		<ConfirmDialog
			title={t("项目代理")}
			subtitle={project.name}
			onCancel={onCancel}
			footer={
				<button
					type="button"
					className="primary"
					disabled={busy}
					onClick={() => onConfirm(projectProxyId(choice), projectProxyNode(choice))}
				>
					{t("保存")}
				</button>
			}
		>
			<div className="env-network-options">
				<label className={choice.kind === "inherit" ? "selected" : undefined}>
					<input
						type="radio"
						name="project-proxy"
						checked={choice.kind === "inherit"}
						onChange={() => setChoice({ kind: "inherit" })}
					/>
					<span className="env-network-label">{t("跟随默认")}</span>
					<span className="env-network-detail">
						{defaultName
							? t("当前默认：{name}；默认改了，这个项目也跟着改。", { name: defaultName })
							: t("当前默认是不使用代理；默认改了，这个项目也跟着改。")}
					</span>
				</label>
				<label className={choice.kind === "off" ? "selected" : undefined}>
					<input
						type="radio"
						name="project-proxy"
						checked={choice.kind === "off"}
						onChange={() => setChoice({ kind: "off" })}
					/>
					<span className="env-network-label">{t("不使用代理")}</span>
					<span className="env-network-detail">
						{t("这个项目的容器直接用宿主机或桥接网络，方便打内网、接反弹 shell。")}
					</span>
				</label>
				{list.map((proxy) => {
					const selected = choice.kind === "proxy" && choice.id === proxy.id;
					const nodes = proxy.mode === "subscription" && Array.isArray(proxy.nodes) ? proxy.nodes : [];
					return (
						<div key={proxy.id} className="project-proxy-option">
							<label className={selected ? "selected" : undefined}>
								<input
									type="radio"
									name="project-proxy"
									checked={selected}
									onChange={() => setChoice({ kind: "proxy", id: proxy.id, nodeTag: undefined })}
								/>
								<span className="env-network-label">{proxy.name}</span>
								<span className="env-network-detail">
									{proxy.mode === "simple"
										? t("{type} {server}:{port}", {
												type: proxy.simple.type === "http" ? "HTTP" : "SOCKS5",
												server: proxy.simple.server || t("未配置"),
												port: String(proxy.simple.port || ""),
											})
										: proxy.mode === "subscription"
											? nodes.length > 0
												? t("{count} 个节点，可以只给这个项目指定一个", { count: nodes.length })
												: t("订阅未拉取")
											: t("自定义 sing-box 出站")}
								</span>
							</label>
							{selected && nodes.length > 0 ? (
								<label className="project-proxy-node">
									<span>{t("节点")}</span>
									<select
										value={choice.kind === "proxy" ? (choice.nodeTag ?? "") : ""}
										onChange={(event) =>
											setChoice({
												kind: "proxy",
												id: proxy.id,
												nodeTag: event.target.value || undefined,
											})
										}
									>
										<option value="">
											{t("跟随档案默认（{name}）", {
												name:
													proxy.nodeTag === AUTO_NODE_TAG
														? t("自动择优")
														: (nodes.find((node) => node.tag === proxy.nodeTag)?.name ??
															nodes[0]?.name ??
															t("第一个节点")),
											})}
										</option>
										<option value={AUTO_NODE_TAG}>{t("自动（按延迟择优）")}</option>
										{nodes.map((node) => (
											<option key={node.tag} value={node.tag}>
												{node.name}
											</option>
										))}
									</select>
								</label>
							) : null}
						</div>
					);
				})}
			</div>

			{list.length === 0 ? (
				<p className="settings-hint">{t("还没有代理：到侧栏「代理」页新建一个之后，这里才能选。")}</p>
			) : null}

			<p className="confirm-note">
				{t("只换节点会立刻生效，不用重建容器；换档案或改网络模式才需要重建（容器内 /work 之外的文件会丢，工作目录不受影响）。")}
			</p>
		</ConfirmDialog>
	);
}
