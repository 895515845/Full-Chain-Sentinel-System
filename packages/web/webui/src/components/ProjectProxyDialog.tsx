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
import { describeProfile } from "./ProxyPage.tsx";

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
	const [nodeQuery, setNodeQuery] = useState("");
	const [step, setStep] = useState(1);
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
	const selectedProxy = choice.kind === "proxy" ? list.find((entry) => entry.id === choice.id) : undefined;
	const nodes =
		selectedProxy?.mode === "subscription" && Array.isArray(selectedProxy.nodes) ? selectedProxy.nodes : [];
	const query = nodeQuery.trim().toLocaleLowerCase();
	const filteredNodes = query
		? nodes.filter((node) => (node.name + " " + node.tag + " " + node.protocol).toLocaleLowerCase().includes(query))
		: nodes;
	const sourceName =
		choice.kind === "inherit"
			? t("跟随默认")
			: choice.kind === "off"
				? t("不使用代理")
				: (selectedProxy?.name ?? t("代理档案"));
	const nodeName =
		choice.kind !== "proxy"
			? t("此网络方式不单独选择节点")
			: choice.nodeTag === undefined
				? t("跟随档案默认（{name}）", {
						name:
							selectedProxy?.nodeTag === AUTO_NODE_TAG
								? t("自动择优")
								: (nodes.find((node) => node.tag === selectedProxy?.nodeTag)?.name ??
									nodes[0]?.name ??
									t("档案默认")),
					})
				: choice.nodeTag === AUTO_NODE_TAG
					? t("自动（按延迟择优）")
					: (nodes.find((node) => node.tag === choice.nodeTag)?.name ?? choice.nodeTag);

	return (
		<ConfirmDialog
			title={t("项目代理")}
			subtitle={project.name}
			className="project-proxy-dialog"
			onCancel={onCancel}
			footer={
				<>
					{step > 1 ? (
						<button type="button" className="ghost" disabled={busy} onClick={() => setStep(step - 1)}>
							{t("上一步")}
						</button>
					) : null}
					{step < 3 ? (
						<button type="button" className="primary" onClick={() => setStep(step + 1)}>
							{t("下一步")}
						</button>
					) : (
						<button
							type="button"
							className="primary"
							disabled={busy}
							onClick={() => onConfirm(projectProxyId(choice), projectProxyNode(choice))}
						>
							{t("确认保存")}
						</button>
					)}
				</>
			}
		>
			<ol className="project-proxy-steps" aria-label={t("配置步骤")}>
				<li className={step === 1 ? "current" : step > 1 ? "done" : undefined}>
					<span>1</span>{t("选择代理方式")}
				</li>
				<li className={step === 2 ? "current" : step > 2 ? "done" : undefined}>
					<span>2</span>{t("选择节点")}
				</li>
				<li className={step === 3 ? "current" : undefined}>
					<span>3</span>{t("确认更改")}
				</li>
			</ol>
			{step === 1 ? (
				<div className="project-proxy-step-panel">
					<div className="project-proxy-step-title">
						<strong>{t("为项目选择代理来源")}</strong>
						<span>{t("选择默认设置、直连或代理档案")}</span>
					</div>
					<div className="env-network-options project-proxy-options">
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
						<div key={proxy.id} className={selected ? "project-proxy-option selected" : "project-proxy-option"}>
							<label className={selected ? "selected" : undefined}>
								<input
									type="radio"
									name="project-proxy"
									checked={selected}
									onChange={() => setChoice({ kind: "proxy", id: proxy.id, nodeTag: undefined })}
								/>
								<span className="env-network-label">{proxy.name}</span>
								<span className="env-network-detail">
									{proxy.mode === "subscription"
										? nodes.length > 0
											? t("{count} 个节点，可以只给这个项目指定一个", { count: nodes.length })
											: t("订阅未拉取")
										: describeProfile(proxy)}
								</span>
							</label>
						</div>
					);
				})}
					</div>
					{list.length === 0 ? (
						<p className="settings-hint">{t("还没有代理：到侧栏「代理」页新建一个之后，这里才能选。")}</p>
					) : null}
				</div>
			) : null}
			{step === 2 ? (
				<div className="project-proxy-step-panel">
					<div className="project-proxy-step-title">
						<strong>{t("选择出口节点")}</strong>
						<span>{t("当前代理：{name}", { name: sourceName })}</span>
					</div>
					{choice.kind === "proxy" && selectedProxy && nodes.length > 0 ? (
						<div className="project-proxy-node-picker">
							<label className="project-proxy-node-search">
								<span>{t("节点搜索")}</span>
								<input
									type="search"
									value={nodeQuery}
									placeholder={t("搜索 {count} 个节点", { count: nodes.length })}
									onChange={(event) => setNodeQuery(event.target.value)}
								/>
							</label>
							<p>{t("可以指定固定节点，也可以跟随档案默认或按延迟自动择优。")}</p>
							<div className="proxy-node-list project-proxy-node-list">
								<label className={choice.nodeTag === undefined ? "selected" : undefined}>
									<input
										type="radio"
										name={"project-proxy-node-" + selectedProxy.id}
										checked={choice.nodeTag === undefined}
										onChange={() => setChoice({ kind: "proxy", id: selectedProxy.id, nodeTag: undefined })}
								/>
								<span className="proxy-node__name">
									{t("跟随档案默认（{name}）", {
										name:
										selectedProxy.nodeTag === AUTO_NODE_TAG
											? t("自动择优")
											: (nodes.find((node) => node.tag === selectedProxy.nodeTag)?.name ??
												nodes[0]?.name ??
												t("第一个节点")),
									})}
								</span>
							</label>
							<label className={choice.nodeTag === AUTO_NODE_TAG ? "selected" : undefined}>
								<input
									type="radio"
									name={"project-proxy-node-" + selectedProxy.id}
									checked={choice.nodeTag === AUTO_NODE_TAG}
									onChange={() => setChoice({ kind: "proxy", id: selectedProxy.id, nodeTag: AUTO_NODE_TAG })}
								/>
								<span className="proxy-node__name">{t("自动（按延迟择优）")}</span>
								<span className="proxy-node__meta"><span className="proxy-node__protocol">{t("自动选择")}</span></span>
							</label>
							{filteredNodes.map((node) => (
								<label key={node.tag} className={choice.nodeTag === node.tag ? "selected" : undefined}>
									<input
										type="radio"
										name={"project-proxy-node-" + selectedProxy.id}
										checked={choice.nodeTag === node.tag}
										onChange={() => setChoice({ kind: "proxy", id: selectedProxy.id, nodeTag: node.tag })}
								/>
									<span className="proxy-node__name">{node.name}</span>
									<span className="proxy-node__meta">
										{node.latencyMs === undefined ? (
											<span className="proxy-node__protocol">{node.protocol}</span>
										) : node.latencyMs === null ? (
											<span className="proxy-latency bad">{t("超时")}</span>
										) : (
											<span className={node.latencyMs > 800 ? "proxy-latency slow" : "proxy-latency"}>
												{node.latencyMs} ms
											</span>
										)}
									</span>
								</label>
							))}
							{filteredNodes.length === 0 ? (
								<small className="project-proxy-no-nodes">{t("没有匹配的节点")}</small>
							) : null}
						</div>
						</div>
					) : (
						<p className="project-proxy-step-empty">
							{choice.kind === "proxy"
								? t("这个代理档案没有可单独选择的节点，将使用档案自身的出口设置。")
								: t("当前网络方式不单独选择节点。需要指定节点时，请返回上一步选择支持节点的代理档案。")}
						</p>
					)}
				</div>
			) : null}
			{step === 3 ? (
				<div className="project-proxy-step-panel">
					<div className="project-proxy-step-title">
						<strong>{t("确认项目代理设置")}</strong>
						<span>{t("请检查代理来源和出口节点")}</span>
					</div>
					<dl className="project-proxy-review">
						<dt>{t("项目")}</dt><dd>{project.name}</dd>
						<dt>{t("代理来源")}</dt><dd>{sourceName}</dd>
						<dt>{t("出口节点")}</dt><dd>{nodeName}</dd>
						<dt>{t("生效范围")}</dt><dd>{t("仅当前项目")}</dd>
					</dl>
					<div className="project-proxy-effect">
						<span className="project-proxy-effect__icon" aria-hidden="true">i</span>
						<p className="confirm-note">
							{t("只换节点会立刻生效，不用重建容器；换档案或改网络模式才需要重建（容器内 /work 之外的文件会丢，工作目录不受影响）。")}
						</p>
					</div>
				</div>
			) : null}
		</ConfirmDialog>
	);
}
