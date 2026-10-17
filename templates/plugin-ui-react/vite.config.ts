import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The console serves the build under /plugin-ui/<host>/<plugin>/, so every
// emitted URL has to be relative.
export default defineConfig({
	base: "./",
	plugins: [react()],
	build: { outDir: "dist" },
});
