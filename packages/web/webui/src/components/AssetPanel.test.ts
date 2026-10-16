/**
 * The asset settings page's pure helpers.
 *
 * The page itself needs a browser; what is worth pinning here is the state a row
 * reports, the sentence that tells the operator whether a platform's tool is
 * mounted, and the payload a save sends — in particular that an untouched box
 * keeps the stored key instead of erasing it.
 */

import { expect, test } from "vitest";
import type { SentinelAssetPlatformView } from "../types.ts";
import { mountReason, platformSaveInput, platformState } from "./AssetPanel.tsx";

function view(overrides: Partial<SentinelAssetPlatformView> = {}): SentinelAssetPlatformView {
	return {
		id: "fofa",
		label: "FOFA",
		enabled: false,
		hasKey: false,
		verified: false,
		status: { at: null, ok: true },
		...overrides,
	};
}

test("platformState reports the four states the row's rail and badge share", () => {
	expect(platformState(view())).toBe("disabled");
	expect(platformState(view({ enabled: true }))).toBe("unkeyed");
	expect(platformState(view({ enabled: true, hasKey: true }))).toBe("unverified");
	expect(platformState(view({ enabled: true, hasKey: true, verified: true }))).toBe("mounted");
	// Switching a verified platform off is "disabled", not "mounted": the switch wins.
	expect(platformState(view({ enabled: false, hasKey: true, verified: true }))).toBe("disabled");
});

test("the badge and the sentence can never disagree, because both read platformState", () => {
	for (const platform of [
		view(),
		view({ enabled: true }),
		view({ enabled: true, hasKey: true }),
		view({ enabled: true, hasKey: true, verified: true }),
	]) {
		const mounted = platformState(platform) === "mounted";
		expect(mountReason(platform).includes("已挂载")).toBe(mounted);
		expect(mountReason(platform).includes("不挂载")).toBe(!mounted);
	}
});

test("mountReason names the tool only when all three conditions hold", () => {
	expect(mountReason(view({ enabled: true, hasKey: true, verified: true }))).toBe("已挂载 fofa_search 给 Agent");
	expect(mountReason(view({ enabled: true, hasKey: true, verified: true, id: "hunter" }))).toBe(
		"已挂载 hunter_search 给 Agent",
	);
});

test("mountReason says which condition is missing, in the order the operator fixes them", () => {
	expect(mountReason(view())).toBe("未启用，工具不挂载");
	expect(mountReason(view({ enabled: true }))).toBe("未配置密钥，工具不挂载");
	expect(mountReason(view({ enabled: true, hasKey: true }))).toBe("密钥未通过验证，工具不挂载");
	// A switch left on with a failing probe is the case this wording exists for.
	expect(mountReason(view({ enabled: true, hasKey: true, verified: false, status: { at: 1, ok: false, error: "令牌过期" } }))).toBe(
		"密钥未通过验证，工具不挂载",
	);
});

test("an untouched key box keeps the stored key", () => {
	expect(platformSaveInput("fofa", true, undefined)).toEqual({ id: "fofa", enabled: true, key: null });
	expect(platformSaveInput("fofa", true, "")).toEqual({ id: "fofa", enabled: true, key: null });
	// Whitespace is not a key: it would otherwise look configured and fail at the probe.
	expect(platformSaveInput("fofa", true, "   ")).toEqual({ id: "fofa", enabled: true, key: null });
});

test("a typed key replaces the stored one, trimmed", () => {
	expect(platformSaveInput("quake", false, "  abc  ")).toEqual({ id: "quake", enabled: false, key: "abc" });
});
