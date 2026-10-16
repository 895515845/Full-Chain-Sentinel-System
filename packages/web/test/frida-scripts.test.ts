import { expect, test } from "vitest";
import {
	builtinScript,
	builtinScriptNames,
	parseScriptSpec,
	resolveBuiltinScript,
	scriptBanner,
} from "../src/frida-scripts.ts";

test("parseScriptSpec splits name and parameters", () => {
	expect(parseScriptSpec("crypto_log")).toEqual({ name: "crypto_log", params: {} });
	expect(parseScriptSpec("okhttp_log?url=/api&x=1")).toEqual({
		name: "okhttp_log",
		params: { url: "/api", x: "1" },
	});
	// A custom path with no query round-trips unchanged.
	expect(parseScriptSpec("/work/custom.js")).toEqual({ name: "/work/custom.js", params: {} });
	// A bare "?" without "key=value" pairs reads as a name with no parameters.
	expect(parseScriptSpec("a.js?x")).toEqual({ name: "a.js", params: {} });
});

test("resolveBuiltinScript injects prelude and banner for builtins", () => {
	const resolved = resolveBuiltinScript("crypto_log?alg=AES");
	if (!("name" in resolved)) throw new Error(`expected builtin, got ${JSON.stringify(resolved)}`);
	expect(resolved.name).toBe("crypto_log");
	expect(resolved.source).toContain("SENTINEL_PARAMS");
	expect(resolved.source).toContain(scriptBanner("crypto_log"));
	// The parameter must reach the script body through the sp() helper.
	expect(resolved.source).toContain('{"alg":"AES"}');
});

test("resolveBuiltinScript passes unknown names through as paths", () => {
	const resolved = resolveBuiltinScript("/work/custom.js");
	expect(resolved).toEqual({ path: "/work/custom.js" });
	const unknown = resolveBuiltinScript("no_such_script?url=x");
	if (!("error" in unknown)) throw new Error("expected error for unknown builtin");
	expect(unknown.error).toContain("no_such_script");
});

test("crypto_log no longer uses the nonexistent Cipher.getOpmode", () => {
	// javax.crypto.Cipher has no public opmode getter; the script must remember
	// the mode from init instead.
	const script = builtinScript("crypto_log");
	expect(script?.source).not.toContain("getOpmode");
	expect(script?.source).toContain("_sentinelMode");
	expect(script?.source).toContain("Mac");
});

test("root_detection_bypass hooks the String[] exec overload", () => {
	const script = builtinScript("root_detection_bypass");
	expect(script?.source).toContain("[Ljava.lang.String;");
	expect(script?.source).toContain("kernelsu");
});

test("ssl_pinning_bypass covers the OkHttp 4.x renamed check", () => {
	const script = builtinScript("ssl_pinning_bypass");
	expect(script?.source).toContain("check$okhttp");
	expect(script?.source).toContain("NetworkSecurityTrustManager");
});

test("every builtin declares a summary and mentions its failure mode", () => {
	const names = builtinScriptNames();
	expect(names.length).toBeGreaterThanOrEqual(8);
	for (const name of names) {
		const script = builtinScript(name);
		expect(script?.summary.length ?? 0).toBeGreaterThan(20);
	}
	expect(names).toContain("native_ssl_bypass");
	expect(names).toContain("flutter_bypass");
	expect(names).toContain("anti_frida_bypass");
	expect(names).toContain("dex_dump");
});
