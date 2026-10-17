/**
 * A plugin package as uploaded from the plugin center.
 *
 * A package is a zip whose root (or a single top-level directory) holds
 * `plugin.json`. Nothing is extracted to disk: the image comes from the
 * registry, so the archive only has to carry the manifest and the README. That
 * keeps the upload path free of path traversal and temp-file cleanup, and it
 * means a failed validation leaves nothing behind.
 *
 * A bare `.json` is accepted too, because the manifest is the only file the
 * install actually needs and that is what an author usually has at hand.
 */

import { basename } from "node:path";
import { parsePluginManifest, type SentinelPluginManifest } from "./plugin-manifest.ts";
import { readZip } from "./poc-zip.ts";

/** The zip is held in memory while it is read; a manifest package is kilobytes. */
export const MAX_PLUGIN_PACKAGE_BYTES = 8 * 1024 * 1024;

/** Enough for a manifest, README, Dockerfile, and a small icon. */
export const MAX_PLUGIN_PACKAGE_FILES = 200;

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
		throw new Error(`插件包「${name}」不是合法的 base64`);
	}
	if (buffer.length === 0) throw new Error(`插件包「${name}」为空`);
	if (buffer.length > MAX_PLUGIN_PACKAGE_BYTES) {
		throw new Error(`插件包超过 ${MAX_PLUGIN_PACKAGE_BYTES / (1024 * 1024)}MB 上限`);
	}
	return buffer;
}

function parseManifestJson(text: string, name: string): SentinelPluginManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(`插件包「${name}」里的 plugin.json 不是合法 JSON`);
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

	if (lower.endsWith(".json")) {
		return {
			manifest: parseManifestJson(buffer.toString("utf-8"), displayName),
			name: displayName,
			files: [],
		};
	}
	if (!lower.endsWith(".zip")) {
		throw new Error("只支持 .zip 插件包，或直接上传 plugin.json");
	}

	const { entries } = readZip(buffer);
	const files = entries.map((entry) => entry.name).filter((entry) => !isJunk(entry));
	if (files.length > MAX_PLUGIN_PACKAGE_FILES) {
		throw new Error(`插件包里的文件超过 ${MAX_PLUGIN_PACKAGE_FILES} 个，这不像是插件包`);
	}
	const manifests = entries
		.filter((entry) => !isJunk(entry.name) && basename(entry.name) === "plugin.json")
		.sort((left, right) => depthOf(left.name) - depthOf(right.name));
	const found = manifests[0];
	if (!found) throw new Error("插件包的根目录（或一层子目录）里没有 plugin.json");
	return {
		manifest: parseManifestJson(found.data.toString("utf-8"), displayName),
		name: displayName,
		files,
	};
}
