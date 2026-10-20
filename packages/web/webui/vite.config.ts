import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The console version lives in the package manifest. Builds run from the
 * package root (`vite build webui`), but allow a config invoked from the
 * repository root or the webui directory as well.
 */
function consoleVersion(): string {
	for (const path of [
		resolve(process.cwd(), "package.json"),
		resolve(process.cwd(), "packages/web/package.json"),
		resolve(process.cwd(), "../package.json"),
		resolve(process.cwd(), "../../package.json"),
	]) {
		try {
			const pkg = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
			if (pkg.name === "@earendil-works/sentinel-web" && typeof pkg.version === "string") return pkg.version;
		} catch {
			// Try the next location.
		}
	}
	throw new Error("webui/vite.config.ts: cannot find packages/web/package.json version");
}

export default defineConfig({
	define: {
		__SENTINEL_VERSION__: JSON.stringify(consoleVersion()),
	},
	plugins: [react()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		proxy: {
			"/ws": {
				target: "ws://127.0.0.1:7777",
				ws: true,
			},
		},
	},
});
