/**
 * Package identity for the compiled single-file binary.
 *
 * The coding-agent derives its app name, config directory and version from the
 * `package.json` next to its code (`piConfig.name` = `sentinel`, `piConfig.configDir`
 * = `.sentinel`). A compiled executable has no package directory, so without this
 * the console would fall back to pi's defaults: it would read `PI_CODING_AGENT_DIR`
 * and store state in `~/.pi/agent` instead of `~/.sentinel/agent`.
 *
 * This module unpacks the embedded package files into a temp directory and points
 * `PI_PACKAGE_DIR` at it. It must be imported before anything that imports the
 * coding-agent, because that identity is read once at module load.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { EMBEDDED_CODING_AGENT_FILES } from "./embedded-assets.generated.ts";

/** Stable path so repeated runs rewrite the same files instead of leaking dirs. */
const PACKAGE_DIR = join(tmpdir(), "sentinel-web-package");

export function unpackPackageFiles(): string {
	for (const [name, encoded] of Object.entries(EMBEDDED_CODING_AGENT_FILES)) {
		const target = join(PACKAGE_DIR, name);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, gunzipSync(Buffer.from(encoded, "base64")));
	}
	return PACKAGE_DIR;
}

// An operator-set PI_PACKAGE_DIR wins: it is an explicit override, not a fallback.
if (!process.env.PI_PACKAGE_DIR) {
	process.env.PI_PACKAGE_DIR = unpackPackageFiles();
}
