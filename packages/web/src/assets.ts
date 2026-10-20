/**
 * Asset access for both ways this package runs: a checkout, where the frontend
 * lives on disk in `webui/dist`, and a compiled single-file binary, where the same
 * files are embedded in the executable (see scripts/generate-embedded-assets.mjs).
 *
 * Disk wins when the file is there, so editing the frontend and reloading the page
 * keeps working without rebuilding a binary.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { EMBEDDED_DOCKERFILE, EMBEDDED_VERSION, EMBEDDED_WEBUI } from "./embedded-assets.generated.ts";

/** Console version, embedded at build time so a binary needs no package.json. */
export const WEB_CONSOLE_VERSION = EMBEDDED_VERSION;

/** Bun compiled binaries serve modules from an in-memory filesystem. */
export function isCompiledBinary(): boolean {
	return import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");
}

let webuiCache: Map<string, Buffer> | undefined;

function embeddedWebui(): Map<string, Buffer> {
	if (webuiCache) return webuiCache;
	const files = new Map<string, Buffer>();
	for (const [name, encoded] of Object.entries(EMBEDDED_WEBUI)) {
		files.set(name, gunzipSync(Buffer.from(encoded, "base64")));
	}
	webuiCache = files;
	return files;
}

/**
 * One frontend file by its path relative to `webui/dist`, or undefined when
 * neither disk nor the embedded copy has it. Callers pass paths already stripped
 * of leading `..` segments.
 */
export function readWebuiFile(relativePath: string, distDir: string): Buffer | undefined {
	const onDisk = join(distDir, relativePath);
	if (existsSync(onDisk)) return readFileSync(onDisk);
	// The generator keys the embedded map with forward slashes. Windows
	// `path.normalize()` turns "assets/app.js" into "assets\\app.js", which would
	// miss that map and make the server answer a script request with index.html.
	return embeddedWebui().get(relativePath.replaceAll("\\", "/"));
}

/**
 * The embedded toolbox Dockerfile, or undefined when the generated module is empty.
 * A checkout builds from `docker/` instead; a binary writes this text into a temp
 * directory, because `docker build` needs a real directory on disk.
 */
export function embeddedDockerfile(): string | undefined {
	if (!EMBEDDED_DOCKERFILE) return undefined;
	return gunzipSync(Buffer.from(EMBEDDED_DOCKERFILE, "base64")).toString("utf-8");
}
