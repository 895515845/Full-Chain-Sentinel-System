import { describe, expect, test } from "vitest";
import { readWebuiFile } from "../src/assets.ts";
import { EMBEDDED_WEBUI } from "../src/embedded-assets.generated.ts";

describe("embedded webui assets", () => {
	// Windows `path.normalize()` hands the server `assets\app.js`; the embedded
	// map is keyed `assets/app.js`. Without the normalization in readWebuiFile a
	// script request falls back to index.html and the page stays blank.
	test("finds a forward-slash embedded key through a Windows path", () => {
		const key = Object.keys(EMBEDDED_WEBUI).find((name) => name.startsWith("assets/") && name.endsWith(".js"));
		expect(key).toBeDefined();

		const expected = readWebuiFile(key as string, "/definitely-missing-webui");
		const actual = readWebuiFile((key as string).replaceAll("/", "\\"), "/definitely-missing-webui");

		expect(expected).toBeDefined();
		expect(actual?.equals(expected as Buffer)).toBe(true);
	});
});
