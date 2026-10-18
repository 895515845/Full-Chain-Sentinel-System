/**
 * The curated official plugin catalog.
 *
 * Packages are generated into the console at build time (no registry, no remote
 * index), so an offline console can still install them. The operator still goes
 * through the normal install confirmation: build consent, network mode and
 * capabilities are shown by the same drawer as an uploaded package.
 */

import { OFFICIAL_PLUGINS } from "./official-plugins.generated.ts";
import { parsePluginManifest, type SentinelPluginManifest } from "./plugin-manifest.ts";

export interface OfficialPluginView {
	manifest: SentinelPluginManifest;
	sizeBytes: number;
}

interface OfficialPluginPackage extends OfficialPluginView {
	packageBase64: string;
}

const packages: OfficialPluginPackage[] = OFFICIAL_PLUGINS.map((entry) => {
	const parsed = parsePluginManifest(entry.manifest);
	if (!parsed.ok)
		throw new Error(`官方插件 ${String(entry.manifest.id)} 的 manifest 无效：${parsed.errors.join("；")}`);
	return { manifest: parsed.manifest, packageBase64: entry.packageBase64, sizeBytes: entry.sizeBytes };
});

/** Newest catalog order is stable; the UI sorts cards by name. */
export function listOfficialPlugins(): OfficialPluginView[] {
	return packages.map((entry) => ({ manifest: entry.manifest, sizeBytes: entry.sizeBytes }));
}

export function getOfficialPlugin(id: string): OfficialPluginPackage | undefined {
	return packages.find((entry) => entry.manifest.id === id);
}
