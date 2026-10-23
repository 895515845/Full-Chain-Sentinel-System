/**
 * Where the in-container packet-replay service (replayd, MITM_Fuzz_Render/) comes from.
 *
 * The binary is a Linux executable that runs inside the project container, so the
 * console never executes it directly: it only has to find the bytes that match the
 * container's architecture and push them in. Three sources, in order:
 *
 *   1. `SENTINEL_REPLAYD_DIR` — an operator override, also how tests and a custom
 *      deployment point at their own build.
 *   2. The repository checkout, `MITM_Fuzz_Render/dist/replayd_linux_<arch>`, built
 *      with `make dist` in that directory. This is the development path.
 *   3. `replayd/` next to the console executable — how a compiled single-file
 *      release travels with the binaries it needs.
 *
 * Nothing is embedded in the console binary on purpose: the artifacts are ~21 MB
 * each and are already gitignored build output, so embedding them would put
 * duplicated bytes into version control.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoRoot } from "./docker.ts";

/** Container architectures replayd is shipped for. */
export type ReplaydArch = "amd64" | "arm64";

/** Where a resolved binary was found, for diagnostics in the console. */
export type ReplaydBinarySource = "env" | "checkout" | "release";

export interface ReplaydBinary {
	path: string;
	bytes: Buffer;
	sha256: string;
	source: ReplaydBinarySource;
	arch: ReplaydArch;
}

/** `uname -m` output -> the architecture suffix used by the build artifacts. */
export function replaydArchFromUname(machine: string): ReplaydArch | undefined {
	const value = machine.trim().toLowerCase();
	if (value === "x86_64" || value === "amd64") return "amd64";
	if (value === "aarch64" || value === "arm64") return "arm64";
	return undefined;
}

export function replaydArtifactName(arch: ReplaydArch): string {
	return `replayd_linux_${arch}`;
}

/** Every place a binary of that architecture may live, most specific first. */
export function replaydBinarySearchPaths(
	arch: ReplaydArch,
	options: { execPath?: string; root?: string; envDir?: string } = {},
): Array<{ path: string; source: ReplaydBinarySource }> {
	const name = replaydArtifactName(arch);
	const envDir = options.envDir ?? process.env.SENTINEL_REPLAYD_DIR;
	const execPath = options.execPath ?? process.execPath;
	const root = options.root ?? repoRoot();
	const candidates: Array<{ path: string; source: ReplaydBinarySource }> = [];
	if (envDir && envDir.trim() !== "") {
		candidates.push({ path: join(envDir, name), source: "env" });
	}
	candidates.push({ path: join(root, "MITM_Fuzz_Render", "dist", name), source: "checkout" });
	// A compiled console carries its files in memory, so the release layout is a
	// directory next to the executable rather than anything importable.
	candidates.push({ path: join(dirname(execPath), "replayd", name), source: "release" });
	return candidates;
}

/**
 * The binary for one architecture, or undefined when none of the known locations
 * has it. The caller reports the hint instead of starting a container without a
 * service it promised.
 */
export function readReplaydBinary(
	arch: ReplaydArch,
	options: { execPath?: string; root?: string; envDir?: string } = {},
): ReplaydBinary | undefined {
	for (const candidate of replaydBinarySearchPaths(arch, options)) {
		if (!existsSync(candidate.path)) continue;
		let bytes: Buffer;
		try {
			if (!statSync(candidate.path).isFile()) continue;
			bytes = readFileSync(candidate.path);
		} catch {
			continue;
		}
		if (bytes.length === 0) continue;
		return {
			path: candidate.path,
			bytes,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			source: candidate.source,
			arch,
		};
	}
	return undefined;
}

/** Operator-facing text: what is missing and how to produce it. */
export function replaydBinaryHint(arch: ReplaydArch): string {
	return `未找到 ${replaydArtifactName(arch)}：请在 MITM_Fuzz_Render 目录执行 make dist（或用 SENTINEL_REPLAYD_DIR 指定二进制所在目录）`;
}
