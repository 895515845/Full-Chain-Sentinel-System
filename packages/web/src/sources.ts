/**
 * Build sources for the toolbox image.
 *
 * The base image and the package mirrors are baked in at build time, so a change
 * takes effect after the image is rebuilt. The pip/npm/go settings are also read
 * by installs made inside the running container, so a container created from the
 * rebuilt image uses the same mirrors.
 *
 * Stored in `<agentDir>/sources.json`. An empty field means "use the official
 * source", which keeps the file readable and the defaults visible in the UI.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SentinelSources } from "./protocol.ts";

/** Official base image, used when the field is empty. */
export const DEFAULT_BASE_IMAGE = "kalilinux/kali-rolling:latest";

/** One-click Chinese mirrors; every value is reachable and apt-safe (http). */
export const CHINA_SOURCES: SentinelSources = {
	baseImage: "docker.m.daocloud.io/kalilinux/kali-rolling:latest",
	aptMirror: "http://mirrors.tuna.tsinghua.edu.cn/kali",
	pipIndex: "https://pypi.tuna.tsinghua.edu.cn/simple",
	npmRegistry: "https://registry.npmmirror.com",
	goProxy: "https://goproxy.cn,direct",
};

export const EMPTY_SOURCES: SentinelSources = {
	baseImage: "",
	aptMirror: "",
	pipIndex: "",
	npmRegistry: "",
	goProxy: "",
};

export function sourcesPath(agentDir: string): string {
	return join(agentDir, "sources.json");
}

/**
 * Normalize an image reference. A bare registry host (the common way people think
 * about "switching the Docker source") is expanded to the official repository on
 * that registry, so both `docker.m.daocloud.io` and a full image reference work.
 */
function normalizeImage(value: string): string {
	const trimmed = value
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\/+$/, "");
	if (!trimmed) return "";
	if (trimmed.includes("/")) return trimmed;
	return `${trimmed}/${DEFAULT_BASE_IMAGE}`;
}

/**
 * Normalize a mirror URL. A value without a scheme gets one, because typing
 * `mirrors.tuna.tsinghua.edu.cn/kali` is the obvious thing to do. apt keeps http
 * (the official Kali sources are http and the base image has no ca-certificates
 * until the build installs them); the others use https.
 */
function normalizeUrl(value: string, fallbackScheme: "http" | "https"): string {
	const trimmed = value.trim().replace(/\/+$/, "");
	if (!trimmed) return "";
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
	return `${fallbackScheme}://${trimmed}`;
}

/** Normalize a go proxy list: scheme per element, `direct`/`off` keywords kept. */
function normalizeGoProxy(value: string): string {
	const parts = value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			if (part === "direct" || part === "off") return part;
			return normalizeUrl(part, "https");
		});
	return parts.join(",");
}

/** A JSON file can hold anything; a non-string is treated as "not configured". */
function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function normalizeSources(input: Partial<SentinelSources>): SentinelSources {
	return {
		baseImage: normalizeImage(asString(input.baseImage)),
		aptMirror: normalizeUrl(asString(input.aptMirror), "http"),
		pipIndex: normalizeUrl(asString(input.pipIndex), "https"),
		npmRegistry: normalizeUrl(asString(input.npmRegistry), "https"),
		goProxy: normalizeGoProxy(asString(input.goProxy)),
	};
}

/** Values the build actually uses: empty fields fall back to the official source. */
export function effectiveSources(sources: SentinelSources): SentinelSources {
	const normalized = normalizeSources(sources);
	return { ...normalized, baseImage: normalized.baseImage || DEFAULT_BASE_IMAGE };
}

/** `docker build --build-arg` pairs; the base image is always passed. */
export function buildArgs(sources: SentinelSources): string[] {
	const effective = effectiveSources(sources);
	const args = ["--build-arg", `BASE_IMAGE=${effective.baseImage}`];
	const mirrors: Array<[string, string]> = [
		["APT_MIRROR", effective.aptMirror],
		["PIP_INDEX", effective.pipIndex],
		["NPM_REGISTRY", effective.npmRegistry],
		["GO_PROXY", effective.goProxy],
	];
	for (const [name, value] of mirrors) {
		if (value) args.push("--build-arg", `${name}=${value}`);
	}
	return args;
}

/** Read the stored sources; a missing or malformed file means "all official". */
export function readSources(agentDir: string): SentinelSources {
	try {
		const parsed = JSON.parse(readFileSync(sourcesPath(agentDir), "utf-8")) as Partial<SentinelSources>;
		if (!parsed || typeof parsed !== "object") return { ...EMPTY_SOURCES };
		return normalizeSources(parsed);
	} catch {
		return { ...EMPTY_SOURCES };
	}
}

export function writeSources(agentDir: string, sources: SentinelSources): void {
	const file = sourcesPath(agentDir);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(normalizeSources(sources), null, "\t")}\n`);
}
