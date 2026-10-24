import type { ComponentType, ReactNode } from "react";
import { t } from "../i18n.ts";
import type { SentinelPageId } from "../types.ts";
import {
	AssetIcon,
	EnvironmentIcon,
	LockIcon,
	McpIcon,
	ModelIcon,
	NotifyIcon,
	PluginIcon,
	PocIcon,
	ShieldIcon,
	SubagentIcon,
	SupervisorIcon,
} from "./icons.tsx";

export type SettingsPageId = Extract<SentinelPageId, `settings.${string}`>;

const PAGES: Record<SettingsPageId, { title: string; description: string; icon: ComponentType<{ size?: number }> }> = {
	"settings.model": { title: "模型", description: "管理模型库、角色分配与命令审批。", icon: ModelIcon },
	"settings.supervisor": { title: "监督", description: "配置监督模型、执行策略与介入规则。", icon: SupervisorIcon },
	"settings.notify": { title: "通知", description: "连接团队通知渠道，选择需要推送的事件。", icon: NotifyIcon },
	"settings.permissions": { title: "权限", description: "管理各类 Agent 的工具权限与插件访问范围。", icon: ShieldIcon },
	"settings.presets": { title: "预设 Agent", description: "维护可复用的身份、背景与任务指令。", icon: SubagentIcon },
	"settings.pocs": { title: "POC 订阅", description: "管理模板订阅源、同步计划与更新记录。", icon: PocIcon },
	"settings.assets": { title: "资产测绘", description: "连接资产平台，管理密钥、可用状态与查询额度。", icon: AssetIcon },
	"settings.websearch": { title: "Web 搜索", description: "管理 Tavily 号池、连接状态与搜索额度。", icon: AssetIcon },
	"settings.mcp": { title: "MCP", description: "连接外部工具服务器，管理传输配置与工具挂载。", icon: McpIcon },
	"settings.plugins": { title: "插件", description: "管理插件、运行主机与扩展能力。", icon: PluginIcon },
	"settings.security": { title: "安全", description: "管理管理员账户的登录凭据。", icon: LockIcon },
	"settings.environment": { title: "环境", description: "检查运行环境，配置镜像源、容器网络与代理。", icon: EnvironmentIcon },
};

/** All settings pages share a header, reading width, and a single scroll surface. */
export function SettingsPage({ page, status, children }: { page: SettingsPageId; status?: ReactNode; children: ReactNode }) {
	const { title, description, icon: Icon } = PAGES[page];
	return (
		<section className="page-card settings-page" data-settings-page={page} aria-labelledby="settings-page-title">
			<header className="settings-page__header">
				<div className="settings-page__header-inner">
					<div className="settings-page__heading">
						<span className="settings-page__icon" aria-hidden="true">
							<Icon size={16} />
						</span>
						<div>
							<div className="settings-page__breadcrumb">{t("设置")}</div>
							<h1 id="settings-page-title">{t(title)}</h1>
							<p>{t(description)}</p>
						</div>
					</div>
					{status ? <div className="settings-page__status">{status}</div> : null}
				</div>
			</header>
			<div className="settings-page__body">
				<div className="settings-page__content">{children}</div>
			</div>
		</section>
	);
}
