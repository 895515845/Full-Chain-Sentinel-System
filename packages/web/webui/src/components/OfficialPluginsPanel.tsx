import { t } from "../i18n.ts";
import type {
	SentinelOfficialPluginView,
	SentinelPluginHostView,
	SentinelPluginView,
} from "../types.ts";
import { PluginIcon } from "./icons.tsx";

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

function versionOf(plugin: SentinelPluginView): string {
	return plugin.manifest.version;
}

/**
 * The curated catalog bundled with the console. A list, not a card grid: the
 * operator scans name/version/state in one column and acts from the row, which
 * stays readable when the catalog grows past a handful of plugins.
 */
export function OfficialPluginsPanel({
	plugins,
	installed,
	hosts,
	busy,
	onChoose,
}: {
	plugins: SentinelOfficialPluginView[];
	installed: SentinelPluginView[];
	hosts: SentinelPluginHostView[];
	busy: boolean;
	onChoose: (plugin: SentinelOfficialPluginView) => void;
}) {
	if (plugins.length === 0) {
		return (
			<div className="official-plugins empty">
				<p className="muted">{t("当前版本没有内置官方插件。")}</p>
			</div>
		);
	}

	return (
		<div className="official-plugins">
			<p className="official-plugins__intro">
				{t("随控制台分发的官方插件。安装时仍会选择目标主机，并确认构建许可与网络/能力权限。")}
			</p>
			<div className="official-plugins__table-wrap">
				<table className="official-plugin-table">
					<thead>
						<tr>
							<th>{t("插件")}</th>
							<th>{t("版本")}</th>
							<th>{t("工具")}</th>
							<th>{t("状态")}</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{plugins.map((plugin) => {
							const manifest = plugin.manifest;
							const mine = installed.filter((entry) => entry.manifest.id === manifest.id);
							const current = mine[0] ? versionOf(mine[0]) : null;
							const update = current !== null && current !== manifest.version;
							const label =
								current === null
									? t("安装")
									: update
										? t("更新到 v{version}", { version: manifest.version })
										: t("安装到其他主机");
							return (
								<tr key={manifest.id}>
									<td>
										<div className="official-plugin-name">
											<span className="official-plugin-name__icon">
												<PluginIcon size={17} />
											</span>
											<div className="official-plugin-name__text">
												<div className="official-plugin-name__title">
													<b>{manifest.name}</b>
													<span className="chip info">{t("官方")}</span>
												</div>
												<p>{manifest.description}</p>
												<div className="official-plugin-name__meta">
													<span>{formatSize(plugin.sizeBytes)}</span>
													<span>network {manifest.permissions.network}</span>
													<span>{manifest.resources.memory}</span>
												</div>
											</div>
										</div>
									</td>
									<td className="mono">v{manifest.version}</td>
									<td>
										<span className="official-plugin-tools__count">{manifest.tools.length}</span>
										<div className="official-plugin-tools">
											{manifest.tools.slice(0, 3).map((tool) => (
												<code key={tool.name}>{tool.name}</code>
											))}
										</div>
									</td>
									<td>
										{current ? (
											update ? (
												<span className="official-plugin__update">
													{t("已装 v{current}，可更新", { current })}
												</span>
											) : (
												<span className="chip ok">{t("已安装")}</span>
											)
										) : (
											<span className="muted">{t("未安装")}</span>
										)}
									</td>
									<td>
										<div className="official-plugin-row__actions">
											<a href={manifest.source} target="_blank" rel="noreferrer">
												{t("源码")}
											</a>
											<button
												type="button"
												className="primary"
												disabled={busy || hosts.length === 0}
												title={hosts.length === 0 ? t("先添加一个插件主机") : undefined}
												onClick={() => onChoose(plugin)}
											>
												{label}
											</button>
										</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}
