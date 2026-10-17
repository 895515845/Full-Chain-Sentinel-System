/**
 * Plugin packages, as the host receives them.
 *
 * A package is a zip with a `plugin.json` and the Dockerfile + build context
 * next to it (or one directory deep). The host extracts it under its own data
 * directory and builds the image from there — nothing is executed before the
 * operator approved the build.
 *
 * Extraction is the one place where an uploaded archive touches the file
 * system, so every entry is checked: no absolute paths, no `..`, a cap on the
 * number of entries and the extracted size.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parsePluginManifest, type SentinelPluginManifest } from "../plugin-manifest.ts";
import { readZip } from "../poc-zip.ts";

/** The console caps uploads at 8 MB; the host allows some base64 overhead. */
export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 1000;
const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024;

export interface ExtractedPackage {
	/** Directory that contains plugin.json. Build paths are relative to this. */
	root: string;
	manifest: SentinelPluginManifest;
}

/** Hash of the uploaded zip, kept so the UI can tell packages apart. */
export function packageHash(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function depthOf(path: string): number {
	return path.split("/").filter(Boolean).length;
}

/** Extract, validate paths, and read the manifest that the build will use. */
export function extractPluginPackage(buffer: Buffer, targetDir: string): ExtractedPackage {
	if (buffer.length === 0) throw new Error("插件包为空");
	if (buffer.length > MAX_PACKAGE_BYTES) {
		throw new Error(`插件包超过 ${MAX_PACKAGE_BYTES / (1024 * 1024)}MB 上限`);
	}
	const { entries } = readZip(buffer);
	if (entries.length > MAX_PACKAGE_ENTRIES) {
		throw new Error(`插件包里的文件超过 ${MAX_PACKAGE_ENTRIES} 个`);
	}
	rmSync(targetDir, { recursive: true, force: true });
	mkdirSync(targetDir, { recursive: true });
	const base = resolve(targetDir);
	let total = 0;
	const files: string[] = [];
	for (const entry of entries) {
		const name = entry.name.replace(/\\/g, "/");
		if (!name || name.endsWith("/")) continue;
		if (name.startsWith("/") || name.split("/").includes("..")) {
			throw new Error(`插件包里的路径非法：${entry.name}`);
		}
		const target = resolve(base, name);
		if (target !== base && !target.startsWith(`${base}${sep}`)) {
			throw new Error(`插件包里的路径越界：${entry.name}`);
		}
		total += entry.data.length;
		if (total > MAX_EXTRACTED_BYTES) {
			throw new Error(`解压后超过 ${MAX_EXTRACTED_BYTES / (1024 * 1024)}MB 上限`);
		}
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, entry.data);
		files.push(name);
	}

	const manifests = files
		.filter((name) => name === "plugin.json" || name.endsWith("/plugin.json"))
		.sort((left, right) => depthOf(left) - depthOf(right));
	if (manifests.length === 0) throw new Error("插件包的根目录（或一层子目录）里没有 plugin.json");
	const manifestName = manifests[0];
	const root = manifestName === "plugin.json" ? base : resolve(base, dirname(manifestName));
	let parsed: ReturnType<typeof parsePluginManifest>;
	try {
		parsed = parsePluginManifest(JSON.parse(readFileSync(join(base, manifestName), "utf-8")));
	} catch {
		throw new Error(`${manifestName} 不是合法 JSON`);
	}
	if (!parsed.ok) throw new Error(parsed.errors.join("；"));
	const manifest = parsed.manifest;

	const dockerfile = resolve(root, manifest.build.dockerfile);
	if (!dockerfile.startsWith(`${root}${sep}`) || !existsSync(dockerfile)) {
		throw new Error(`插件包里没有 ${manifest.build.dockerfile}`);
	}
	const contextDir = resolve(root, manifest.build.context);
	if (contextDir !== root && !contextDir.startsWith(`${root}${sep}`)) {
		throw new Error("build.context 越出了插件目录");
	}
	if (!existsSync(contextDir)) throw new Error(`构建上下文 ${manifest.build.context} 不存在`);
	return { root, manifest };
}
