import { build } from "esbuild";

await build({
	entryPoints: ["./render-probe.tsx"],
	bundle: true,
	platform: "node",
	format: "cjs",
	outfile: "/tmp/render-probe.bundle.cjs",
	jsx: "automatic",
	loader: { ".ts": "ts", ".tsx": "tsx" },
	logLevel: "silent",
});
