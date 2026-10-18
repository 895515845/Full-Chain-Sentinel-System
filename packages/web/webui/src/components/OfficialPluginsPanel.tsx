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
 * The curated catalog bundled with the console. Cards are descriptive rather
 * than a second installed table: the operator is choosing what to add, and the
 * install drawer still shows the full manifest, permissions and build consent.
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
				<p className="muted">当前版本没有内置官方插件。</p>
			</div>
		);
	}

	return (
		<div className="official-plugins">
			<p className="official-plugins__intro">
				随控制台分发的官方插件。安装时仍会选择目标主机，并确认构建许可与网络/能力权限。
			</p>
			<div className="official-plugins__grid">
				{plugins.map((plugin) => {
					const manifest = plugin.manifest;
					const mine = installed.filter((entry) => entry.manifest.id === manifest.id);
					const current = mine[0] ? versionOf(mine[0]) : null;
					const update = current !== null && current !== manifest.version;
					const label = current === null ? "安装" : update ? `更新到 v${manifest.version}` : "安装到其他主机";
					return (
						<article className="official-plugin" key={manifest.id}>
							<div className="official-plugin__head">
								<span className="official-plugin__icon">
									<PluginIcon size={18} />
								</span>
								<div className="official-plugin__title">
									<b>{manifest.name}</b>
									<span className="mono">v{manifest.version}</span>
								</div>
								<span className="chip info">官方</span>
							</div>
							<p className="official-plugin__desc">{manifest.description}</p>
							<div className="official-plugin__meta">
								<span>{manifest.tools.length} 个工具</span>
								<span>network {manifest.permissions.network}</span>
								<span>{manifest.resources.memory}</span>
								<span>{formatSize(plugin.sizeBytes)}</span>
								{current ? (
									<span className={update ? "official-plugin__update" : "chip ok"}>
										{update ? `已安装 v${current}，可更新` : "已安装"}
									</span>
								) : null}
							</div>
							<div className="official-plugin__tools">
								{manifest.tools.slice(0, 4).map((tool) => (
									<code key={tool.name}>{tool.name}</code>
								))}
							</div>
							<div className="official-plugin__actions">
								<a href={manifest.source} target="_blank" rel="noreferrer">
									源码
								</a>
								<button
									type="button"
									className="primary"
									disabled={busy || hosts.length === 0}
									title={hosts.length === 0 ? "先添加一个插件主机" : undefined}
									onClick={() => onChoose(plugin)}
								>
									{label}
								</button>
							</div>
						</article>
					);
				})}
			</div>
		</div>
	);
}
