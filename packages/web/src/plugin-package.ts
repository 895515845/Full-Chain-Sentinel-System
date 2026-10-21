/**
 * A plugin package as uploaded from the plugin center.
 *
 * A package is a zip whose root (or a single top-level directory) holds
 * `plugin.json` and the Dockerfile + build context declared by `build`. The
 * console reads it for the install preview and forwards the same bytes to the
 * plugin host, which extracts and builds it. Nothing is extracted here.
 */

import { basename } from "node:path";
import { t } from "./i18n.ts";
import { parsePluginManifest, type SentinelPluginManifest } from "./plugin-manifest.ts";
import { readZip } from "./poc-zip.ts";

/** The zip is held in memory while it is read; a manifest package is kilobytes. */
export const MAX_PLUGIN_PACKAGE_BYTES = 8 * 1024 * 1024;

/** Enough for a manifest, source tree, UI, and a small icon. */
export const MAX_PLUGIN_PACKAGE_FILES = 400;

export interface PluginPackageContents {
	manifest: SentinelPluginManifest;
	/** File name as the operator picked it, shown on the install form. */
	name: string;
	/** Other files in the archive, for the "what did I just upload" line. */
	files: string[];
}

function decodePackage(name: string, base64: string): Buffer {
	const cleaned = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
	let buffer: Buffer;
	try {
		buffer = Buffer.from(cleaned, "base64");
	} catch {
		throw new Error(t("插件包「{name}」不是合法的 base64", { name }));
	}
	if (buffer.length === 0) throw new Error(t("插件包「{name}」为空", { name }));
	if (buffer.length > MAX_PLUGIN_PACKAGE_BYTES) {
		throw new Error(t("插件包超过 {size}MB 上限", { size: MAX_PLUGIN_PACKAGE_BYTES / (1024 * 1024) }));
	}
	return buffer;
}

function parseManifestJson(text: string, name: string): SentinelPluginManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(t("插件包「{name}」里的 plugin.json 不是合法 JSON", { name }));
	}
	const parsed = parsePluginManifest(raw);
	if (!parsed.ok) throw new Error(parsed.errors.join("；"));
	return parsed.manifest;
}

/** Depth of an entry path, used to prefer the shallowest `plugin.json`. */
function depthOf(path: string): number {
	return path.split("/").filter(Boolean).length;
}

function isJunk(path: string): boolean {
	const lower = path.toLowerCase();
	return (
		lower.startsWith("__macosx/") ||
		lower.endsWith("/.ds_store") ||
		lower === ".ds_store" ||
		lower.endsWith("/thumbs.db")
	);
}

/**
 * Read one uploaded package. Throws an operator-readable message for every
 * rejection: wrong extension, too large, no manifest, invalid manifest.
 */
export function readPluginPackage(name: string, base64: string): PluginPackageContents {
	const displayName = basename(name).trim() || "plugin.zip";
	const buffer = decodePackage(displayName, base64);
	const lower = displayName.toLowerCase();

	if (!lower.endsWith(".zip")) {
		throw new Error(t("只支持 .zip：插件包必须包含 Dockerfile 和构建上下文"));
	}

	const { entries } = readZip(buffer);
	const files = entries.map((entry) => entry.name).filter((entry) => !isJunk(entry));
	if (files.length > MAX_PLUGIN_PACKAGE_FILES) {
		throw new Error(t("插件包里的文件超过 {count} 个，这不像是插件包", { count: MAX_PLUGIN_PACKAGE_FILES }));
	}
	const manifests = entries
		.filter((entry) => !isJunk(entry.name) && basename(entry.name) === "plugin.json")
		.sort((left, right) => depthOf(left.name) - depthOf(right.name));
	const found = manifests[0];
	if (!found) throw new Error(t("插件包的根目录（或一层子目录）里没有 plugin.json"));
	const manifest = parseManifestJson(found.data.toString("utf-8"), displayName);
	const root = found.name.includes("/") ? found.name.slice(0, found.name.lastIndexOf("/") + 1) : "";
	const dockerfile = `${root}${manifest.build.dockerfile}`;
	if (!files.includes(dockerfile)) {
		throw new Error(t("插件包里没有 Dockerfile：{file}", { file: dockerfile }));
	}
	const context = `${root}${manifest.build.context === "." ? "" : `${manifest.build.context}/`}`;
	if (context && !files.some((entry) => entry.startsWith(context))) {
		throw new Error(t("插件包里没有构建上下文目录：{path}", { path: manifest.build.context }));
	}
	return {
		manifest,
		name: displayName,
		files,
	};
}
